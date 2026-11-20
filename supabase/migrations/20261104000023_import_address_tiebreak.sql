-- Import: when more than one customer has the same name and address, match the
-- one that already has the record's car or service history. Found by the test
-- lab (seed 867011912): the second import of the same rows added a vehicle.
-- The rest of arts.import_customer is unchanged from 20261104000021.

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
    select c.id into cid from arts.customers c
      where c.merged_into is null and lower(trim(c.name)) = lower(trim(p ->> 'name'))
        and upper(c.address_line1) = upper(p ->> 'address_line1') and c.postal_code is not distinct from p ->> 'postal_code'
      -- Several customers can share a name and an address (another row may
      -- have given one of them that address). Prefer the one that already has
      -- this record's car or service history, so a re-import lands on the
      -- customer the first import used instead of adding the car again.
      order by (
        exists (select 1 from arts.vehicles x, jsonb_array_elements(coalesce(p -> 'vehicles', '[]'::jsonb)) pv
                where x.customer_id = c.id
                  and arts.same_car(x.year, x.make, x.model, (pv ->> 'year')::int, pv ->> 'make', pv ->> 'model'))
        or exists (select 1 from arts.service_history s, jsonb_array_elements(coalesce(p -> 'history', '[]'::jsonb)) ph
                   where s.customer_id = c.id and s.service_date = (ph ->> 'service_date')::date)
      ) desc, c.created_at
      limit 1;
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
