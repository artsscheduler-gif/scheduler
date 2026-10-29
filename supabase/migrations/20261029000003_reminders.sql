-- Service-due list: latest completed date per customer/vehicle/service plus
-- that service's reminder interval.
create function arts.due_list() returns table (
  customer_id uuid, vehicle_id uuid, service_id uuid, last_date date, due_date date
)
language sql stable set search_path = '' as $$
  select h.customer_id, h.vehicle_id, h.service_id, max(h.service_date) as last_date,
         (max(h.service_date) + make_interval(months => s.reminder_interval_months))::date as due_date
  from arts.service_history h
  join arts.services s on s.id = h.service_id
  join arts.customers c on c.id = h.customer_id
  where s.reminder_interval_months is not null and s.active and c.merged_into is null
  group by h.customer_id, h.vehicle_id, h.service_id, s.reminder_interval_months
$$;

revoke execute on function arts.due_list() from public, anon, authenticated;
grant execute on function arts.due_list() to service_role;
