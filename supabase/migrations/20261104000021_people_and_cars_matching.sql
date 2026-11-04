-- Matching people and cars, from the test lab's findings:
-- 1. A visit booked online and then typed into TRACS is kept once (the
--    import skips it; a merge drops the imported copy, and undo restores it).
-- 2. Cars match across spellings: Chevy = Chevrolet, VW = Volkswagen, F-150 =
--    F150. Merging two records folds the same car into one.
-- 3. Household members sharing a phone or email stay separate people: a
--    phone or email match also needs the first names to agree (nicknames
--    count: Bob = Robert).
-- 4. The match list needs the same last name, compatible first names, and
--    at least one more thing in common (phone, email, street, car).

create function arts.norm_text(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(translate(lower(coalesce(t, '')), 'áàâäãåéèêëíìîïóòôöõøúùûüñçýÿ', 'aaaaaaeeeeiiiiooooooouuuuncyy'), '[^a-z0-9]', '', 'g')
$$;

create function arts.norm_make(m text) returns text
language sql immutable set search_path = '' as $$
  select case x
    when 'chevy' then 'chevrolet' when 'chev' then 'chevrolet'
    when 'vw' then 'volkswagen' when 'volks' then 'volkswagen'
    when 'mercedes' then 'mercedesbenz' when 'benz' then 'mercedesbenz' when 'mb' then 'mercedesbenz'
    when 'caddy' then 'cadillac' when 'olds' then 'oldsmobile' when 'alfa' then 'alfaromeo'
    when 'gmc' then 'gmc' when 'landrover' then 'landrover' when 'rangerover' then 'landrover'
    when 'mini' then 'mini' when 'minicooper' then 'mini'
    else x end
  from (select arts.norm_text(m) as x) t
$$;

-- Same car: same year, same model (ignoring punctuation and case), and the
-- same make once aliases are applied (a missing make doesn't count against it).
create function arts.same_car(y1 int, mk1 text, md1 text, y2 int, mk2 text, md2 text) returns boolean
language sql immutable set search_path = '' as $$
  select y1 is not distinct from y2
     and arts.norm_text(md1) = arts.norm_text(md2)
     and (arts.norm_make(mk1) = arts.norm_make(mk2) or arts.norm_make(mk1) = '' or arts.norm_make(mk2) = '')
$$;

create function arts.first_name(n text) returns text
language sql immutable set search_path = '' as $$
  select arts.norm_text(split_part(trim(regexp_replace(coalesce(n, ''), '^.*,\s*', '')), ' ', 1))
$$;

create function arts.last_name(n text) returns text
language sql immutable set search_path = '' as $$
  select arts.norm_text(regexp_replace(trim(coalesce(n, '')), '^.*\s', ''))
$$;

-- First names that could be the same person: equal, one missing, one
-- starting with the other (Dan / Daniel), or a common nickname.
create function arts.first_names_match(a text, b text) returns boolean
language sql immutable set search_path = '' as $$
  with n as (select arts.first_name(a) as x, arts.first_name(b) as y)
  select x = y or x = '' or y = ''
      or (length(x) >= 3 and length(y) >= 3 and (x like y || '%' or y like x || '%'))
      or exists (
        select 1 from (values
          ('bob', 'robert'), ('bobby', 'robert'), ('rob', 'robert'), ('robbie', 'robert'),
          ('bill', 'william'), ('billy', 'william'), ('will', 'william'), ('willie', 'william'), ('liam', 'william'),
          ('jim', 'james'), ('jimmy', 'james'), ('jamie', 'james'),
          ('mike', 'michael'), ('mikey', 'michael'), ('mick', 'michael'),
          ('tom', 'thomas'), ('tommy', 'thomas'),
          ('joe', 'joseph'), ('joey', 'joseph'),
          ('jack', 'john'), ('johnny', 'john'),
          ('dick', 'richard'), ('rick', 'richard'), ('ricky', 'richard'), ('rich', 'richard'),
          ('ted', 'edward'), ('ed', 'edward'), ('eddie', 'edward'), ('ned', 'edward'),
          ('chuck', 'charles'), ('charlie', 'charles'),
          ('hank', 'henry'), ('harry', 'henry'),
          ('larry', 'lawrence'), ('jerry', 'gerald'), ('gerry', 'gerald'),
          ('tony', 'anthony'), ('steve', 'steven'), ('steve', 'stephen'),
          ('dave', 'david'), ('danny', 'daniel'), ('sam', 'samuel'), ('ben', 'benjamin'),
          ('pat', 'patricia'), ('patty', 'patricia'), ('trish', 'patricia'),
          ('sue', 'susan'), ('susie', 'susan'),
          ('liz', 'elizabeth'), ('beth', 'elizabeth'), ('betty', 'elizabeth'), ('lisa', 'elizabeth'),
          ('kathy', 'katherine'), ('kate', 'katherine'), ('katie', 'katherine'), ('cathy', 'catherine'),
          ('peggy', 'margaret'), ('maggie', 'margaret'), ('meg', 'margaret'),
          ('jenny', 'jennifer'), ('jen', 'jennifer'), ('barb', 'barbara'), ('debbie', 'deborah'), ('deb', 'deborah'),
          ('chris', 'christopher'), ('chris', 'christine'), ('chris', 'christina')
        ) nick(s, f)
        where (x = s and y = f) or (y = s and x = f)
      )
  from n
$$;

revoke execute on function arts.norm_text(text), arts.norm_make(text), arts.same_car(int, text, text, int, text, text),
  arts.first_name(text), arts.last_name(text), arts.first_names_match(text, text) from public, anon, authenticated;
grant execute on function arts.norm_text(text), arts.norm_make(text), arts.same_car(int, text, text, int, text, text),
  arts.first_name(text), arts.last_name(text), arts.first_names_match(text, text) to service_role;

-- ---- Online booking and import: who is who, which car is which ----------------

CREATE OR REPLACE FUNCTION arts.create_booking(p jsonb, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  s arts.shop_settings;
  v_date date := (p ->> 'date')::date;
  v_kind arts.booking_kind := (p ->> 'kind')::arts.booking_kind;
  v_start time := nullif(p ->> 'start_time', '')::time;
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
        -- A shared household phone or email isn't the same person.
        and arts.first_names_match(c.name, p -> 'customer' ->> 'name')
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
        and arts.same_car(year, make, model, nullif(p -> 'vehicle' ->> 'year', '')::int, p -> 'vehicle' ->> 'make', p -> 'vehicle' ->> 'model')
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
end $function$;

CREATE OR REPLACE FUNCTION arts.import_customer(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  cid uuid;
  matched text;
  v jsonb;
  h jsonb;
  vid uuid;
  vmap jsonb := '{}'::jsonb;
  nveh int := 0;
  nhist int := 0;
  last_name text := lower(regexp_replace(trim(p ->> 'name'), '^.*\s', ''));
begin
  if p ->> 'epicor_id' is not null then
    select id into cid from arts.customers where epicor_id = p ->> 'epicor_id' and merged_into is null order by created_at limit 1;
    if cid is not null then matched := 'epicor_id'; end if;
  end if;
  if cid is null and p ->> 'email' is not null then
    select id into cid from arts.customers where lower(email) = lower(p ->> 'email') and merged_into is null and arts.first_names_match(name, p ->> 'name') order by created_at limit 1;
    if cid is not null then matched := 'email'; end if;
  end if;
  if cid is null and p ->> 'phone' is not null then
    select id into cid from arts.customers
      where phone = p ->> 'phone' and merged_into is null and lower(regexp_replace(trim(name), '^.*\s', '')) = last_name
        and arts.first_names_match(name, p ->> 'name')
      order by created_at limit 1;
    if cid is not null then matched := 'phone'; end if;
  end if;
  -- No id, email or phone that matches: the same name at the same street and
  -- ZIP. Without this, a customer on file by address only was added again by
  -- every monthly feed.
  if cid is null and p ->> 'address_line1' is not null then
    select id into cid from arts.customers
      where merged_into is null and lower(trim(name)) = lower(trim(p ->> 'name'))
        and upper(address_line1) = upper(p ->> 'address_line1') and postal_code is not distinct from p ->> 'postal_code'
      order by created_at limit 1;
    if cid is not null then matched := 'address'; end if;
  end if;

  if cid is null then
    insert into arts.customers (name, email, phone, address_line1, address_line2, city, state, postal_code,
      email_opt_out, mail_opt_out, source, epicor_id)
    values (p ->> 'name', p ->> 'email', p ->> 'phone', p ->> 'address_line1', p ->> 'address_line2', p ->> 'city', p ->> 'state',
      p ->> 'postal_code', coalesce((p ->> 'email_opt_out')::boolean, false), coalesce((p ->> 'mail_opt_out')::boolean, false),
      'import', p ->> 'epicor_id')
    returning id into cid;
  else
    update arts.customers c set
      email = coalesce(c.email, p ->> 'email'),
      phone = coalesce(c.phone, p ->> 'phone'),
      epicor_id = coalesce(c.epicor_id, p ->> 'epicor_id'),
      -- The address moves as a block, and only into a customer with none.
      address_line1 = case when c.address_line1 is null then p ->> 'address_line1' else c.address_line1 end,
      address_line2 = case when c.address_line1 is null then p ->> 'address_line2' else c.address_line2 end,
      city = case when c.address_line1 is null then p ->> 'city' else c.city end,
      state = case when c.address_line1 is null then p ->> 'state' else c.state end,
      postal_code = case when c.address_line1 is null then p ->> 'postal_code' else c.postal_code end,
      email_opt_out = c.email_opt_out or coalesce((p ->> 'email_opt_out')::boolean, false),
      mail_opt_out = c.mail_opt_out or coalesce((p ->> 'mail_opt_out')::boolean, false)
    where c.id = cid;
  end if;

  for v in select * from jsonb_array_elements(coalesce(p -> 'vehicles', '[]'::jsonb)) loop
    select id into vid from arts.vehicles
      where customer_id = cid and arts.same_car(year, make, model, (v ->> 'year')::int, v ->> 'make', v ->> 'model')
      order by created_at limit 1;
    if vid is null then
      insert into arts.vehicles (customer_id, year, make, model) values (cid, (v ->> 'year')::int, v ->> 'make', v ->> 'model') returning id into vid;
      nveh := nveh + 1;
    end if;
    vmap := vmap || jsonb_build_object(v ->> 'key', vid);
  end loop;

  for h in select * from jsonb_array_elements(coalesce(p -> 'history', '[]'::jsonb)) loop
    vid := nullif(vmap ->> (h ->> 'vehicle_key'), '')::uuid;
    if not exists (
      select 1 from arts.service_history s
      where s.customer_id = cid and s.vehicle_id is not distinct from vid and s.service_date = (h ->> 'service_date')::date
        and coalesce(s.raw_service, '') = coalesce(h ->> 'raw_service', '')
    ) and not exists (
      -- Already here from the online booking for that visit.
      select 1 from arts.service_history s
      where s.customer_id = cid and s.service_date = (h ->> 'service_date')::date
        and s.service_id = nullif(h ->> 'service_id', '')::uuid
        and (s.vehicle_id is not distinct from vid or s.vehicle_id is null or vid is null)
    ) then
      insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, mileage, raw_service, source)
      values (cid, vid, nullif(h ->> 'service_id', '')::uuid, (h ->> 'service_date')::date, (h ->> 'mileage')::int, h ->> 'raw_service', 'import');
      nhist := nhist + 1;
    end if;
  end loop;

  return jsonb_build_object('customer_id', cid, 'matched', matched, 'vehicles', nveh, 'history', nhist);
end $function$;

-- ---- Match list ---------------------------------------------------------------

create or replace function arts.customer_match_candidates() returns table (app_id uuid, tracs_id uuid, reasons text[])
language sql stable set search_path = '' as $$
  with app as (
    select * from arts.customers
    where epicor_id is null and merged_into is null and name <> 'Removed customer'
  ), tracs as (
    select * from arts.customers where epicor_id is not null and merged_into is null
  ), pairs as (
    select a.id as app_id, t.id as tracs_id, array_remove(array[
      case when a.phone is not null and a.phone = t.phone then 'same phone' end,
      case when a.email is not null and lower(a.email) = lower(t.email) then 'same email' end,
      case when a.address_line1 is not null and arts.norm_text(a.address_line1) = arts.norm_text(t.address_line1) then 'same street' end,
      case when exists (
        select 1 from arts.vehicles va join arts.vehicles vt
          on vt.customer_id = t.id and arts.same_car(va.year, va.make, va.model, vt.year, vt.make, vt.model)
        where va.customer_id = a.id and va.model is not null
      ) then 'same car' end
    ], null) as reasons,
    arts.first_name(a.name) = arts.first_name(t.name) as same_first
    from app a
    join tracs t on arts.last_name(a.name) = arts.last_name(t.name) and arts.first_names_match(a.name, t.name)
  )
  -- The name alone isn't enough: two Donna Garcias are often two people.
  select p.app_id, p.tracs_id, case when p.same_first then p.reasons || 'same name'::text else p.reasons || 'similar first name'::text end
  from pairs p
  where cardinality(p.reasons) > 0
    and not exists (select 1 from arts.customer_match_dismissals d where d.app_id = p.app_id and d.tracs_id = p.tracs_id)
  order by cardinality(p.reasons) desc
$$;

-- ---- Merge and undo -------------------------------------------------------------

create or replace function arts.merge_customers(p_keep uuid, p_merge uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  k arts.customers;
  m arts.customers;
  patch jsonb;
  moved jsonb;
  mid uuid;
  mv arts.vehicles;
  kv uuid;
  folds jsonb := '[]'::jsonb;
  dropped_history jsonb;
  dropped_reminders jsonb;
begin
  if p_keep = p_merge then return jsonb_build_object('ok', false, 'error', 'same_customer'); end if;
  select * into k from arts.customers where id = p_keep for update;
  select * into m from arts.customers where id = p_merge for update;
  if k.id is null or m.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.merged_into is not null or m.merged_into is not null then return jsonb_build_object('ok', false, 'error', 'already_merged'); end if;

  -- The same car on both records (typed differently online and in TRACS)
  -- becomes one: the merged record's copy folds into the kept one.
  for mv in select * from arts.vehicles where customer_id = p_merge order by created_at loop
    select v.id into kv from arts.vehicles v
      where v.customer_id = p_keep and arts.same_car(v.year, v.make, v.model, mv.year, mv.make, mv.model)
      order by v.created_at limit 1;
    if kv is not null then
      folds := folds || jsonb_build_array(jsonb_build_object('vehicle', to_jsonb(mv), 'into', kv,
        'bookings', coalesce((select jsonb_agg(id) from arts.bookings where vehicle_id = mv.id), '[]'),
        'service_history', coalesce((select jsonb_agg(id) from arts.service_history where vehicle_id = mv.id), '[]'),
        'reminder_sends', coalesce((select jsonb_agg(id) from arts.reminder_sends where vehicle_id = mv.id), '[]')));
    end if;
  end loop;

  -- Reminders already on the kept record for the same car, service and due
  -- date: the merged record's copies go (one reminder history per car).
  dropped_reminders := coalesce((
    select jsonb_agg(to_jsonb(r)) from arts.reminder_sends r
    where r.customer_id = p_merge and exists (
      select 1 from arts.reminder_sends x where x.customer_id = p_keep and x.step = r.step and x.due_date = r.due_date
        and x.service_id is not distinct from r.service_id
        and coalesce(x.vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(
          (select (f ->> 'into')::uuid from jsonb_array_elements(folds) f where (f -> 'vehicle' ->> 'id')::uuid = r.vehicle_id), r.vehicle_id,
          '00000000-0000-0000-0000-000000000000'::uuid))), '[]');
  delete from arts.reminder_sends where id in (select (x ->> 'id')::uuid from jsonb_array_elements(dropped_reminders) x);

  for mv in select * from jsonb_populate_recordset(null::arts.vehicles, (select coalesce(jsonb_agg(f -> 'vehicle'), '[]') from jsonb_array_elements(folds) f)) loop
    kv := (select (f ->> 'into')::uuid from jsonb_array_elements(folds) f where (f -> 'vehicle' ->> 'id')::uuid = mv.id);
    update arts.bookings set vehicle_id = kv where vehicle_id = mv.id;
    update arts.service_history set vehicle_id = kv where vehicle_id = mv.id;
    update arts.reminder_sends set vehicle_id = kv where vehicle_id = mv.id;
    delete from arts.vehicles where id = mv.id;
  end loop;

  -- A visit on both records (booked online, then typed into TRACS) is kept
  -- once: the online booking's copy stays, the imported copy goes.
  dropped_history := coalesce((
    select jsonb_agg(to_jsonb(h)) from arts.service_history h
    where h.customer_id = p_keep and h.booking_id is null and h.service_id is not null and exists (
      select 1 from arts.service_history b where b.customer_id = p_merge and b.booking_id is not null
        and b.service_id = h.service_id and b.service_date = h.service_date
        and (b.vehicle_id is not distinct from h.vehicle_id or b.vehicle_id is null or h.vehicle_id is null))), '[]');
  delete from arts.service_history where id in (select (x ->> 'id')::uuid from jsonb_array_elements(dropped_history) x);

  moved := jsonb_build_object(
    'vehicles', coalesce((select jsonb_agg(id) from arts.vehicles where customer_id = p_merge), '[]'),
    'bookings', coalesce((select jsonb_agg(id) from arts.bookings where customer_id = p_merge), '[]'),
    'service_history', coalesce((select jsonb_agg(id) from arts.service_history where customer_id = p_merge), '[]'),
    'reminder_sends', coalesce((select jsonb_agg(id) from arts.reminder_sends where customer_id = p_merge), '[]'),
    'email_log', coalesce((select jsonb_agg(id) from arts.email_log where customer_id = p_merge), '[]'),
    'folds', folds, 'dropped_history', dropped_history, 'dropped_reminders', dropped_reminders);
  update arts.vehicles set customer_id = p_keep where customer_id = p_merge;
  update arts.bookings set customer_id = p_keep where customer_id = p_merge;
  update arts.service_history set customer_id = p_keep where customer_id = p_merge;
  update arts.reminder_sends set customer_id = p_keep where customer_id = p_merge;
  update arts.email_log set customer_id = p_keep where customer_id = p_merge;

  -- Blanks are filled from the merged record; opt-outs and flags carry over,
  -- so nobody who opted out on either record is contacted.
  patch := jsonb_strip_nulls(jsonb_build_object(
    'email', case when k.email is null then m.email end,
    'phone', case when k.phone is null then m.phone end,
    'address_line1', case when k.address_line1 is null then m.address_line1 end,
    'address_line2', case when k.address_line1 is null then m.address_line2 end,
    'city', case when k.address_line1 is null then m.city end,
    'state', case when k.address_line1 is null then m.state end,
    'postal_code', case when k.address_line1 is null then m.postal_code end,
    'epicor_id', case when k.epicor_id is null then m.epicor_id end,
    'email_opt_out', case when m.email_opt_out and not k.email_opt_out then true end,
    'mail_opt_out', case when m.mail_opt_out and not k.mail_opt_out then true end,
    'email_bounced', case when m.email_bounced and not k.email_bounced then true end,
    'always_review', case when m.always_review and not k.always_review then true end));
  update arts.customers set merged_into = p_keep, email = null, phone = null where id = p_merge;
  update arts.customers c set
    email = coalesce(patch ->> 'email', c.email),
    phone = coalesce(patch ->> 'phone', c.phone),
    address_line1 = coalesce(patch ->> 'address_line1', c.address_line1),
    address_line2 = coalesce(patch ->> 'address_line2', c.address_line2),
    city = coalesce(patch ->> 'city', c.city),
    state = coalesce(patch ->> 'state', c.state),
    postal_code = coalesce(patch ->> 'postal_code', c.postal_code),
    epicor_id = coalesce(patch ->> 'epicor_id', c.epicor_id),
    email_opt_out = c.email_opt_out or coalesce((patch ->> 'email_opt_out')::boolean, false),
    mail_opt_out = c.mail_opt_out or coalesce((patch ->> 'mail_opt_out')::boolean, false),
    email_bounced = c.email_bounced or coalesce((patch ->> 'email_bounced')::boolean, false),
    always_review = c.always_review or coalesce((patch ->> 'always_review')::boolean, false)
  where c.id = p_keep;

  insert into arts.customer_merges (keep_id, merged_id, keep_before, merged_before, patch, moved)
  values (p_keep, p_merge, to_jsonb(k), to_jsonb(m), patch, moved) returning id into mid;
  perform arts.audit(p_actor, 'customer.merge', 'customer', p_keep::text, jsonb_build_object('keep', to_jsonb(k), 'merged', to_jsonb(m)),
    jsonb_build_object('merge_id', mid, 'patch', patch, 'moved', moved));
  return jsonb_build_object('ok', true, 'merge_id', mid);
end $$;

-- Puts both customers back: folded cars, dropped duplicates and moved rows
-- return, the merged record gets its email/phone back, and fields the merge
-- filled in are cleared again unless someone has changed them since.
create or replace function arts.unmerge_customers(p_merge_id uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r arts.customer_merges;
  t text;
  f text;
  fold jsonb;
begin
  select * into r from arts.customer_merges where id = p_merge_id for update;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if r.undone_at is not null then return jsonb_build_object('ok', false, 'error', 'already_undone'); end if;

  foreach t in array array['vehicles', 'bookings', 'service_history', 'reminder_sends', 'email_log'] loop
    execute format('update arts.%I set customer_id = $1 where id in (select (jsonb_array_elements_text($2))::uuid)', t)
      using r.merged_id, r.moved -> t;
  end loop;

  for fold in select * from jsonb_array_elements(coalesce(r.moved -> 'folds', '[]')) loop
    insert into arts.vehicles select * from jsonb_populate_record(null::arts.vehicles, fold -> 'vehicle');
    foreach t in array array['bookings', 'service_history', 'reminder_sends'] loop
      execute format('update arts.%I set vehicle_id = $1 where id in (select (jsonb_array_elements_text($2))::uuid)', t)
        using (fold -> 'vehicle' ->> 'id')::uuid, fold -> t;
    end loop;
  end loop;
  insert into arts.service_history select * from jsonb_populate_recordset(null::arts.service_history, coalesce(r.moved -> 'dropped_history', '[]'));
  insert into arts.reminder_sends select * from jsonb_populate_recordset(null::arts.reminder_sends, coalesce(r.moved -> 'dropped_reminders', '[]'));

  for f in select jsonb_object_keys(r.patch) loop
    execute format('update arts.customers set %I = ($1 ->> %L)::%s where id = $2 and %I::text is not distinct from ($3 ->> %L)',
      f, f, case when f in ('email_opt_out', 'mail_opt_out', 'email_bounced', 'always_review') then 'boolean' else 'text' end, f, f)
      using r.keep_before, r.keep_id, r.patch;
  end loop;

  update arts.customers set merged_into = null, email = r.merged_before ->> 'email', phone = r.merged_before ->> 'phone'
    where id = r.merged_id;
  update arts.customer_merges set undone_at = now() where id = r.id;
  perform arts.audit(p_actor, 'customer.unmerge', 'customer', r.keep_id::text, null, jsonb_build_object('merge_id', r.id, 'restored', r.merged_id));
  return jsonb_build_object('ok', true, 'restored', r.merged_id);
end $$;
