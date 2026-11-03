-- Booking-page fixes.
-- check_booking: past times today are refused ('past'), and a service that
-- was taken off the menu still lets an existing booking reschedule.
-- available_slots: day-level rules run once per day instead of once per time,
-- and each time says why waiting/drop-off is closed (wait_why, dropoff_why).
-- available_slot_days stops at the first open time of each day.

create or replace function arts.check_booking(
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
  blocked int;
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
    where sv.id is null or (not sv.active
      -- A service already on the booking being changed stays allowed after
      -- it's taken off the menu, so that customer can still reschedule.
      and not exists (select 1 from arts.booking_services bs where bs.booking_id = any(p_exclude) and bs.service_id = sid))
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
  -- A time earlier today has already gone (only reachable with floor_days = 0).
  if p_date = today and p_start is not null and p_start <= (p_now at time zone s.timezone)::time then
    v := v || 'past'::text;
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
    -- Blocked time comes off the day's capacity.
    -- Overlapping blocks (say a weekly block plus a one-off on top) count once.
    select coalesce(sum(upper(r) - lower(r)), 0) into blocked
      from unnest((
        select range_agg(int4range(greatest(bl.st, hrs.open_min), least(bl.en, hrs.close_min)))
        from arts.day_blocks(p_date) bl
        where least(bl.en, hrs.close_min) > greatest(bl.st, hrs.open_min)
      )) r;
    cap := s.total_lanes * greatest(0, hrs.close_min - hrs.open_min - blocked);
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
      -- Drop-off rule 3: a chosen drop-off time sits on the grid inside the
      -- drop-off window and opening hours. No time (staff-entered) is allowed.
      if p_start is not null then
        start_min := extract(epoch from p_start)::int / 60;
        if p_start < s.dropoff_window_start or p_start > s.dropoff_window_end
           or start_min < hrs.open_min or start_min >= hrs.close_min then
          v := v || 'outside_hours'::text;
        end if;
        if (start_min - hrs.open_min) % s.slot_step_minutes <> 0 then
          v := v || 'off_grid'::text;
        end if;
        -- No drop-offs during blocked time.
        if exists (select 1 from arts.day_blocks(p_date) bl where start_min >= bl.st and start_min < bl.en) then
          v := v || 'blocked'::text;
        end if;
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
        -- A waiter's whole job stays clear of blocked time.
        if exists (select 1 from arts.day_blocks(p_date) bl where start_min < bl.en and start_min + job > bl.st) then
          v := v || 'blocked'::text;
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

drop function arts.available_slots(uuid[], date, uuid[], timestamptz);
drop function arts.available_slot_days(uuid[], uuid[], timestamptz);

-- The rule that matters most to a customer, for the "why not" line.
create function arts.slot_reason(v text[]) returns text
language sql immutable set search_path = '' as $$
  select coalesce((select x from unnest(array['past', 'not_wait_eligible', 'blocked', 'outside_hours', 'waiter_lanes',
    'dropoff_share', 'day_capacity']) with ordinality o(x, n) where x = any(v) order by n limit 1),
    (select x from unnest(v) x where x like 'daily_cap:%' limit 1), v[1])
$$;

create function arts.available_slots(
  p_service_ids uuid[],
  p_date date,
  p_exclude uuid[] default '{}',
  p_now timestamptz default now(),
  p_first_only boolean default false
) returns table (start_time time, wait boolean, dropoff boolean, wait_why text, dropoff_why text)
language plpgsql stable set search_path = '' as $$
declare
  hrs record;
  step int;
  m int;
  t time;
  wv text[];
  dv text[];
  wday text[];
  dday text[];
begin
  select * into hrs from arts.day_hours(p_date);
  if hrs.open_min is null then
    return;
  end if;
  select slot_step_minutes into step from arts.shop_settings where id = 1;
  -- Day-level rules once (with no start time, check_booking checks only the
  -- day). A kind that fails them is closed all day: no time needs checking.
  wday := array(select x from unnest(arts.check_booking(p_date, 'wait', null, p_service_ids, p_exclude, p_now)) x where x <> 'start_required');
  dday := arts.check_booking(p_date, 'dropoff', null, p_service_ids, p_exclude, p_now);
  if cardinality(wday) > 0 and cardinality(dday) > 0 then
    return;
  end if;
  m := hrs.open_min;
  while m < hrs.close_min loop
    t := make_time(m / 60, m % 60, 0);
    wv := case when cardinality(wday) > 0 then wday else arts.check_booking(p_date, 'wait', t, p_service_ids, p_exclude, p_now) end;
    dv := case when cardinality(dday) > 0 then dday else arts.check_booking(p_date, 'dropoff', t, p_service_ids, p_exclude, p_now) end;
    if cardinality(wv) = 0 or cardinality(dv) = 0 then
      start_time := t; wait := cardinality(wv) = 0; dropoff := cardinality(dv) = 0;
      wait_why := arts.slot_reason(wv); dropoff_why := arts.slot_reason(dv);
      return next;
      if p_first_only then return; end if;
    end if;
    m := m + step;
  end loop;
end $$;

create function arts.available_slot_days(
  p_service_ids uuid[],
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
    if exists (select 1 from arts.available_slots(p_service_ids, d, p_exclude, p_now, true)) then
      return next d;
    end if;
  end loop;
end $$;

revoke execute on function arts.slot_reason(text[]) from public, anon, authenticated;
revoke execute on function arts.available_slots(uuid[], date, uuid[], timestamptz, boolean) from public, anon, authenticated;
revoke execute on function arts.available_slot_days(uuid[], uuid[], timestamptz) from public, anon, authenticated;
grant execute on function arts.slot_reason(text[]) to service_role;
grant execute on function arts.available_slots(uuid[], date, uuid[], timestamptz, boolean) to service_role;
grant execute on function arts.available_slot_days(uuid[], uuid[], timestamptz) to service_role;
