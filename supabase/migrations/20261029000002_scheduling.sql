-- Scheduling engine. The database is the single source of truth for
-- availability so the public calendar and the booking lock can never disagree.

-- Statuses that occupy capacity. Requested bookings are holds.
create function arts.holding(s arts.booking_status) returns boolean
language sql immutable set search_path = '' as $$
  select s in ('requested', 'confirmed', 'completed')
$$;

create function arts.today(p_now timestamptz default now()) returns date
language sql stable set search_path = '' as $$
  select (p_now at time zone (select timezone from arts.shop_settings where id = 1))::date
$$;

-- Open and close (minutes after midnight) for a date, or nulls when closed.
create function arts.day_hours(p_date date, out open_min int, out close_min int)
language plpgsql stable set search_path = '' as $$
declare
  h jsonb;
begin
  select hours -> (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from p_date)::int]
    into h from arts.shop_settings where id = 1;
  if h is null or jsonb_typeof(h) <> 'object' then
    return;
  end if;
  if exists (select 1 from arts.closures c where p_date between c.start_date and c.end_date) then
    return;
  end if;
  open_min := extract(epoch from (h ->> 'open')::time)::int / 60;
  close_min := extract(epoch from (h ->> 'close')::time)::int / 60;
end $$;

create function arts.job_minutes(p_service_ids uuid[]) returns int
language sql stable set search_path = '' as $$
  select coalesce(sum(s.duration_minutes), 0)::int + (select buffer_minutes from arts.shop_settings where id = 1)
  from arts.services s where s.id = any(p_service_ids)
$$;

-- Returns the list of broken rules for a proposed booking. Empty = allowed.
-- p_exclude: bookings to ignore (the versions a change request would replace).
create function arts.check_booking(
  p_date date,
  p_kind arts.booking_kind,
  p_start time,
  p_service_ids uuid[],
  p_exclude uuid[] default '{}',
  p_now timestamptz default now()
) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  s arts.shop_settings;
  v text[] := '{}'::text[];
  today date;
  hrs record;
  job int;
  cap int;
  booked int;
  drop_booked int;
  start_min int;
  max_overlap int;
  svc record;
  cnt int;
begin
  select * into s from arts.shop_settings where id = 1;
  today := arts.today(p_now);
  p_exclude := coalesce(p_exclude, '{}');

  if p_service_ids is null or cardinality(p_service_ids) = 0 then
    return array['no_services'];
  end if;
  if exists (
    select 1 from unnest(p_service_ids) sid
    left join arts.services sv on sv.id = sid
    where sv.id is null or not sv.active
  ) then
    v := v || 'service_inactive'::text;
  end if;

  job := arts.job_minutes(p_service_ids);
  select * into hrs from arts.day_hours(p_date);

  -- Rule 5: date window, lead days, closures.
  if hrs.open_min is null then
    v := v || 'closed'::text;
  end if;
  if p_date < today + s.floor_days then
    v := v || 'before_floor_date'::text;
  end if;
  if exists (
    select 1 from arts.services sv
    where sv.id = any(p_service_ids) and sv.lead_days is not null and p_date < today + sv.lead_days
  ) then
    v := v || 'lead_days'::text;
  end if;
  if p_date > today + s.max_days_ahead then
    v := v || 'beyond_max_days'::text;
  end if;

  if hrs.open_min is not null then
    cap := s.total_lanes * (hrs.close_min - hrs.open_min);
    select coalesce(sum(b.total_minutes), 0), coalesce(sum(b.total_minutes) filter (where b.kind = 'dropoff'), 0)
      into booked, drop_booked
      from arts.bookings b
      where b.date = p_date and arts.holding(b.status) and not (b.id = any(p_exclude));

    -- Wait rule 3 / drop-off rule 2: day capacity.
    if booked + job > cap then
      v := v || 'day_capacity'::text;
    end if;

    if p_kind = 'dropoff' then
      -- Drop-off rule 1: drop-off share of the day.
      if drop_booked + job > floor(cap * s.dropoff_share_pct / 100.0) then
        v := v || 'dropoff_share'::text;
      end if;
    else
      -- Wait rule 1: every service wait-eligible.
      if exists (select 1 from arts.services sv where sv.id = any(p_service_ids) and not sv.wait_eligible) then
        v := v || 'not_wait_eligible'::text;
      end if;
      if p_start is null then
        v := v || 'start_required'::text;
      else
        start_min := extract(epoch from p_start)::int / 60;
        if start_min < hrs.open_min or start_min + job > hrs.close_min then
          v := v || 'outside_hours'::text;
        end if;
        if (start_min - hrs.open_min) % s.slot_step_minutes <> 0 then
          v := v || 'off_grid'::text;
        end if;
        -- Wait rule 2: concurrent waiters over the whole job span. The
        -- maximum overlap occurs at the new start or at some existing start
        -- inside the span.
        with w as (
          select extract(epoch from b.start_time)::int / 60 as st,
                 extract(epoch from b.start_time)::int / 60 + b.total_minutes as en
          from arts.bookings b
          where b.date = p_date and b.kind = 'wait' and arts.holding(b.status)
            and not (b.id = any(p_exclude))
        ), pts as (
          select start_min as pt
          union
          select w.st from w where w.st > start_min and w.st < start_min + job
        )
        select coalesce(max((select count(*) from w where w.st <= pts.pt and w.en > pts.pt)), 0)
          into max_overlap from pts;
        if max_overlap + 1 > s.waiter_lanes then
          v := v || 'waiter_lanes'::text;
        end if;
      end if;
    end if;
  end if;

  -- Rule 4: per-service daily caps.
  for svc in
    select sv.id, sv.name, sv.daily_cap from arts.services sv
    where sv.id = any(p_service_ids) and sv.daily_cap is not null
  loop
    select count(distinct b.id) into cnt
      from arts.bookings b join arts.booking_services bs on bs.booking_id = b.id
      where b.date = p_date and bs.service_id = svc.id and arts.holding(b.status)
        and not (b.id = any(p_exclude));
    if cnt + 1 > svc.daily_cap then
      v := v || ('daily_cap:' || svc.name);
    end if;
  end loop;

  return v;
end $$;

create function arts.available_times(
  p_service_ids uuid[],
  p_date date,
  p_exclude uuid[] default '{}',
  p_now timestamptz default now()
) returns setof time
language plpgsql stable set search_path = '' as $$
declare
  hrs record;
  step int;
  job int;
  m int;
begin
  select * into hrs from arts.day_hours(p_date);
  if hrs.open_min is null then
    return;
  end if;
  select slot_step_minutes into step from arts.shop_settings where id = 1;
  job := arts.job_minutes(p_service_ids);
  m := hrs.open_min;
  while m + job <= hrs.close_min loop
    if cardinality(arts.check_booking(p_date, 'wait', make_time(m / 60, m % 60, 0), p_service_ids, p_exclude, p_now)) = 0 then
      return next make_time(m / 60, m % 60, 0);
    end if;
    m := m + step;
  end loop;
end $$;

create function arts.available_days(
  p_service_ids uuid[],
  p_kind arts.booking_kind,
  p_exclude uuid[] default '{}',
  p_now timestamptz default now()
) returns setof date
language plpgsql stable set search_path = '' as $$
declare
  s arts.shop_settings;
  d date;
  today date;
begin
  select * into s from arts.shop_settings where id = 1;
  today := arts.today(p_now);
  for d in select generate_series(today + s.floor_days, today + s.max_days_ahead, interval '1 day')::date loop
    if p_kind = 'dropoff' then
      if cardinality(arts.check_booking(d, 'dropoff', null, p_service_ids, p_exclude, p_now)) = 0 then
        return next d;
      end if;
    elsif exists (select 1 from arts.available_times(p_service_ids, d, p_exclude, p_now)) then
      return next d;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function arts.audit(
  p_actor jsonb, p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb
) returns void
language sql set search_path = '' as $$
  insert into arts.audit_log (actor_type, actor_id, actor_label, action, entity, entity_id, before, after)
  values (
    coalesce(p_actor ->> 'type', 'system'),
    nullif(p_actor ->> 'id', '')::uuid,
    coalesce(p_actor ->> 'label', ''),
    p_action, p_entity, p_entity_id, p_before, p_after
  )
$$;

create function arts.booking_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(b) || jsonb_build_object(
    'service_ids', coalesce((select jsonb_agg(bs.service_id order by bs.service_id) from arts.booking_services bs where bs.booking_id = b.id), '[]')
  )
  from arts.bookings b where b.id = p_id
$$;

create function arts.customer_is_returning(p_customer uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from arts.service_history h where h.customer_id = p_customer)
      or exists (select 1 from arts.bookings b where b.customer_id = p_customer and b.status = 'completed')
$$;

create function arts.lock_date(p_date date) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('arts.booking:' || p_date::text, 0))
$$;

-- Fixed-window rate limiter. Returns true when the request is allowed.
create function arts.rate_hit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql set search_path = '' as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c int;
begin
  insert into arts.rate_limits (key, window_start, count) values (p_key, w, 1)
  on conflict (key, window_start) do update set count = arts.rate_limits.count + 1
  returning count into c;
  delete from arts.rate_limits where window_start < now() - interval '2 days';
  return c <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- create_booking: the only way a booking row is born. Takes a per-date
-- advisory lock, re-checks every rule, decides auto-confirm, inserts.
-- ---------------------------------------------------------------------------
create function arts.create_booking(p jsonb, p_now timestamptz default now()) returns jsonb
language plpgsql set search_path = '' as $$
declare
  s arts.shop_settings;
  v_date date := (p ->> 'date')::date;
  v_kind arts.booking_kind := (p ->> 'kind')::arts.booking_kind;
  v_start time := case when p ->> 'kind' = 'wait' then (p ->> 'start_time')::time end;
  v_services uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'service_ids', '[]'))::uuid);
  v_notes text := coalesce(p ->> 'customer_notes', '');
  v_by text := coalesce(p ->> 'created_by_type', 'public');
  v_override boolean := coalesce((p ->> 'override')::boolean, false) and v_by = 'admin';
  v_actor jsonb := coalesce(p -> 'actor', jsonb_build_object('type', 'system'));
  v_root_in uuid := nullif(p ->> 'root_id', '')::uuid;
  v_change text := nullif(p ->> 'change_kind', '');
  v_exclude uuid[] := '{}'::uuid[];
  v_confirmed uuid;
  v_violations text[];
  v_customer arts.customers;
  v_vehicle uuid := nullif(p ->> 'vehicle_id', '')::uuid;
  v_email text := nullif(lower(trim(p -> 'customer' ->> 'email')), '');
  v_phone text := nullif(trim(p -> 'customer' ->> 'phone'), '');
  v_returning boolean;
  v_status arts.booking_status;
  v_auto boolean := false;
  v_level arts.approval_level;
  v_id uuid := gen_random_uuid();
  v_future int;
begin
  select * into s from arts.shop_settings where id = 1;
  if v_date is null or v_kind is null then
    return jsonb_build_object('ok', false, 'violations', array['invalid_request']);
  end if;
  if length(v_notes) > s.notes_max_length then
    return jsonb_build_object('ok', false, 'violations', array['notes_too_long']);
  end if;

  perform arts.lock_date(v_date);

  -- A change request replaces the confirmed version and any pending versions.
  if v_root_in is not null then
    perform 1 from arts.bookings where root_id = v_root_in for update;
    select id into v_confirmed from arts.bookings where root_id = v_root_in and status = 'confirmed' limit 1;
    v_exclude := array(select id from arts.bookings where root_id = v_root_in and status in ('confirmed', 'requested'));
    if cardinality(v_exclude) = 0 then
      return jsonb_build_object('ok', false, 'violations', array['booking_not_active']);
    end if;
  end if;

  v_violations := arts.check_booking(v_date, v_kind, v_start, v_services, v_exclude, p_now);

  -- Customer: matched silently on email or phone, created otherwise.
  if nullif(p ->> 'customer_id', '') is not null then
    select * into v_customer from arts.customers where id = (p ->> 'customer_id')::uuid;
  elsif v_root_in is not null then
    select c.* into v_customer from arts.customers c join arts.bookings b on b.customer_id = c.id
      where b.root_id = v_root_in limit 1;
  else
    select * into v_customer from arts.customers c
      where c.merged_into is null
        and ((v_email is not null and lower(c.email) = v_email) or (v_phone is not null and c.phone = v_phone))
      order by (v_email is not null and lower(c.email) = v_email) desc, c.created_at
      limit 1;
  end if;

  if v_by = 'public' and v_customer.id is not null then
    select count(distinct b.root_id) into v_future from arts.bookings b
      where b.customer_id = v_customer.id and b.status in ('requested', 'confirmed') and b.date >= arts.today(p_now);
    if v_future >= s.max_future_bookings then
      v_violations := v_violations || 'customer_limit'::text;
    end if;
  end if;

  if cardinality(v_violations) > 0 and not v_override then
    return jsonb_build_object('ok', false, 'violations', v_violations);
  end if;

  if v_customer.id is null then
    insert into arts.customers (name, email, phone, source)
    values (trim(p -> 'customer' ->> 'name'), v_email, v_phone, case when v_by = 'admin' then 'admin' else 'booking' end)
    returning * into v_customer;
    v_returning := false;
  else
    v_returning := arts.customer_is_returning(v_customer.id);
    update arts.customers set
      email = coalesce(email, v_email),
      phone = coalesce(phone, v_phone)
    where id = v_customer.id;
  end if;

  if v_vehicle is null and p ? 'vehicle' then
    select id into v_vehicle from arts.vehicles
      where customer_id = v_customer.id
        and year is not distinct from nullif(p -> 'vehicle' ->> 'year', '')::int
        and lower(coalesce(make, '')) = lower(trim(coalesce(p -> 'vehicle' ->> 'make', '')))
        and lower(coalesce(model, '')) = lower(trim(coalesce(p -> 'vehicle' ->> 'model', '')))
      limit 1;
    if v_vehicle is null then
      insert into arts.vehicles (customer_id, year, make, model, notes)
      values (v_customer.id, nullif(p -> 'vehicle' ->> 'year', '')::int,
              trim(p -> 'vehicle' ->> 'make'), trim(p -> 'vehicle' ->> 'model'),
              coalesce(p -> 'vehicle' ->> 'notes', ''))
      returning id into v_vehicle;
    end if;
  elsif v_vehicle is null and v_root_in is not null then
    select vehicle_id into v_vehicle from arts.bookings where root_id = v_root_in order by created_at desc limit 1;
  end if;

  -- Status
  if v_by = 'admin' then
    v_status := 'confirmed';
  elsif v_root_in is not null then
    v_status := 'requested';
  else
    v_auto := cardinality(v_violations) = 0
      and not exists (select 1 from arts.services sv where sv.id = any(v_services) and sv.approval_level = 'approve')
      and (v_notes = '' or not s.notes_require_review)
      and not v_customer.always_review
      and (v_returning or not s.new_customers_require_review);
    v_status := case when v_auto then 'confirmed'::arts.booking_status else 'requested'::arts.booking_status end;
    if v_auto then
      v_level := case when exists (select 1 from arts.services sv where sv.id = any(v_services) and sv.approval_level = 'notify')
                      then 'notify'::arts.approval_level else 'digest'::arts.approval_level end;
    else
      v_level := 'approve';
    end if;
  end if;

  -- Superseded pending versions drop out. The confirmed one keeps its hold.
  if v_root_in is not null then
    update arts.bookings set status = 'replaced', updated_at = p_now
      where root_id = v_root_in and status = 'requested';
  end if;

  insert into arts.bookings (
    id, root_id, replaces_booking_id, change_kind, customer_id, vehicle_id, date, kind, start_time,
    total_minutes, status, customer_notes, auto_confirmed, approval_level, decided_by, decided_at,
    created_by_type, created_by, undo_until, created_at, updated_at, source
  ) values (
    v_id, coalesce(v_root_in, v_id), v_confirmed, v_change, v_customer.id, v_vehicle, v_date, v_kind, v_start,
    arts.job_minutes(v_services), v_status, v_notes, v_auto, v_level,
    case when v_by = 'admin' then nullif(p ->> 'created_by', '')::uuid end,
    case when v_status = 'confirmed' then p_now end,
    v_by, nullif(p ->> 'created_by', '')::uuid,
    case when v_level = 'notify' then p_now + make_interval(hours => s.undo_window_hours) end,
    p_now, p_now, nullif(p ->> 'source', '')
  );
  insert into arts.booking_services (booking_id, service_id) select v_id, unnest(v_services);

  perform arts.audit(
    v_actor,
    case when v_root_in is not null then 'booking.change_requested' when v_override and cardinality(v_violations) > 0 then 'booking.create_override' else 'booking.create' end,
    'booking', v_id::text,
    case when v_confirmed is not null then arts.booking_json(v_confirmed) end,
    arts.booking_json(v_id) || jsonb_build_object('violations_overridden', v_violations)
  );

  return jsonb_build_object(
    'ok', true, 'booking_id', v_id, 'root_id', coalesce(v_root_in, v_id), 'status', v_status,
    'auto_confirmed', v_auto, 'approval_level', v_level, 'customer_id', v_customer.id,
    'violations_overridden', v_violations
  );
end $$;

-- ---------------------------------------------------------------------------
-- Decisions on requested bookings (approve / decline / propose / undo).
-- ---------------------------------------------------------------------------
create function arts.decide_booking(
  p_booking uuid, p_action text, p_actor jsonb, p_reason text default null,
  p_new jsonb default null, p_now timestamptz default now()
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  b arts.bookings;
  before jsonb;
  is_change boolean;
  v_violations text[] := '{}'::text[];
  v_services uuid[];
  v_kind arts.booking_kind;
  v_start time;
  v_date date;
begin
  select * into b from arts.bookings where id = p_booking for update;
  if b.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  before := arts.booking_json(b.id);
  is_change := b.change_kind is not null;
  v_services := array(select service_id from arts.booking_services where booking_id = b.id);

  if p_action = 'undo' then
    if b.status <> 'confirmed' or not b.auto_confirmed or b.undo_until is null or b.undo_until < p_now then
      return jsonb_build_object('ok', false, 'error', 'undo_window_closed');
    end if;
    update arts.bookings set status = 'requested', decided_at = null, decided_by = null, undo_until = null,
      staff_notified_at = p_now, updated_at = p_now where id = b.id;
    update arts.services set approvals_in_a_row = 0, last_undo_at = p_now where id = any(v_services);
  elsif b.status <> 'requested' then
    return jsonb_build_object('ok', false, 'error', 'not_requested');
  elsif p_action = 'approve' then
    if b.replaces_booking_id is not null then
      update arts.bookings set status = 'replaced', updated_at = p_now where id = b.replaces_booking_id and status = 'confirmed';
    end if;
    update arts.bookings set status = 'confirmed', decided_by = nullif(p_actor ->> 'id', '')::uuid,
      decided_at = p_now, updated_at = p_now where id = b.id;
    if not is_change then
      update arts.services set approvals_in_a_row = approvals_in_a_row + 1 where id = any(v_services);
    end if;
  elsif p_action = 'decline' then
    update arts.bookings set status = 'declined', decline_reason = p_reason,
      decided_by = nullif(p_actor ->> 'id', '')::uuid, decided_at = p_now, updated_at = p_now where id = b.id;
    if not is_change then
      update arts.services set approvals_in_a_row = 0 where id = any(v_services);
    end if;
  elsif p_action = 'propose' then
    v_date := (p_new ->> 'date')::date;
    v_kind := coalesce((p_new ->> 'kind')::arts.booking_kind, b.kind);
    v_start := case when v_kind = 'wait' then (p_new ->> 'start_time')::time end;
    perform arts.lock_date(v_date);
    v_violations := arts.check_booking(v_date, v_kind, v_start, v_services,
      array_remove(array[b.id, b.replaces_booking_id], null), p_now);
    if cardinality(v_violations) > 0 and not coalesce((p_new ->> 'override')::boolean, false) then
      return jsonb_build_object('ok', false, 'violations', v_violations);
    end if;
    if b.replaces_booking_id is not null then
      update arts.bookings set status = 'replaced', updated_at = p_now where id = b.replaces_booking_id and status = 'confirmed';
    end if;
    update arts.bookings set date = v_date, kind = v_kind, start_time = v_start, status = 'confirmed',
      decided_by = nullif(p_actor ->> 'id', '')::uuid, decided_at = p_now, updated_at = p_now, decline_reason = p_reason
      where id = b.id;
    if not is_change then
      update arts.services set approvals_in_a_row = 0 where id = any(v_services);
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;

  perform arts.audit(p_actor, 'booking.' || p_action, 'booking', b.id::text, before,
    arts.booking_json(b.id) || jsonb_build_object('reason', p_reason, 'violations_overridden', v_violations));
  return jsonb_build_object('ok', true, 'booking_id', b.id, 'is_change', is_change, 'replaced', b.replaces_booking_id);
end $$;

-- Admin move: any date/time, rules checked, override with confirmation.
create function arts.move_booking(
  p_booking uuid, p_date date, p_kind arts.booking_kind, p_start time, p_override boolean,
  p_actor jsonb, p_now timestamptz default now()
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  b arts.bookings;
  before jsonb;
  v_violations text[];
  v_services uuid[];
begin
  perform arts.lock_date(p_date);
  select * into b from arts.bookings where id = p_booking for update;
  if b.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  before := arts.booking_json(b.id);
  v_services := array(select service_id from arts.booking_services where booking_id = b.id);
  v_violations := arts.check_booking(p_date, p_kind, case when p_kind = 'wait' then p_start end, v_services,
    array_remove(array[b.id, b.replaces_booking_id], null), p_now);
  if cardinality(v_violations) > 0 and not p_override then
    return jsonb_build_object('ok', false, 'violations', v_violations);
  end if;
  update arts.bookings set date = p_date, kind = p_kind, start_time = case when p_kind = 'wait' then p_start end,
    updated_at = p_now, reminder_sent_at = null where id = b.id;
  perform arts.audit(p_actor, case when cardinality(v_violations) > 0 then 'booking.move_override' else 'booking.move' end,
    'booking', b.id::text, before, arts.booking_json(b.id) || jsonb_build_object('violations_overridden', v_violations));
  return jsonb_build_object('ok', true, 'booking_id', b.id, 'violations_overridden', v_violations);
end $$;

-- Status changes that only release capacity (or record outcome).
create function arts.set_booking_status(
  p_booking uuid, p_status arts.booking_status, p_actor jsonb, p_now timestamptz default now()
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  b arts.bookings;
  before jsonb;
begin
  if p_status not in ('completed', 'cancelled', 'no_show', 'confirmed') then
    return jsonb_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into b from arts.bookings where id = p_booking for update;
  if b.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  before := arts.booking_json(b.id);
  update arts.bookings set status = p_status, updated_at = p_now,
    completed_at = case when p_status = 'completed' then p_now else completed_at end
    where id = b.id;
  -- Completed work drives the next service-due reminder.
  if p_status = 'completed' and b.status <> 'completed' then
    insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, source, booking_id)
    select b.customer_id, b.vehicle_id, bs.service_id, b.date, 'booking', b.id
    from arts.booking_services bs where bs.booking_id = b.id;
  elsif b.status = 'completed' and p_status <> 'completed' then
    delete from arts.service_history where booking_id = b.id;
  end if;
  perform arts.audit(p_actor, 'booking.' || p_status::text, 'booking', b.id::text, before, arts.booking_json(b.id));
  return jsonb_build_object('ok', true, 'booking_id', b.id, 'previous', b.status);
end $$;

-- Customer cancel: every live version of the appointment is cancelled.
create function arts.cancel_root(p_root uuid, p_actor jsonb, p_now timestamptz default now()) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in select id from arts.bookings where root_id = p_root and status in ('requested', 'confirmed') for update loop
    perform arts.audit(p_actor, 'booking.cancelled', 'booking', r.id::text, arts.booking_json(r.id), null);
    update arts.bookings set status = 'cancelled', updated_at = p_now where id = r.id;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', n > 0, 'cancelled', n);
end $$;

revoke execute on all functions in schema arts from public, anon, authenticated;
grant execute on all functions in schema arts to service_role;
grant execute on function arts.is_admin() to authenticated;
