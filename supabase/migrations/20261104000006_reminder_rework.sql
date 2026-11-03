-- Reminder rework.
-- 1. The due list filters by due date in SQL and has a stable order, so the
--    job can page through it (PostgREST returns at most 1,000 rows a call).
-- 2. reminder_sends rows are claimed (status 'queued', claimed_at) before an
--    email goes out, so overlapping runs can't both send the same step.

drop function arts.due_list();

create function arts.due_list(p_from date, p_to date) returns table (
  customer_id uuid, vehicle_id uuid, service_id uuid, last_date date, due_date date
)
language sql stable set search_path = '' as $$
  select * from (
    select h.customer_id, h.vehicle_id, h.service_id, max(h.service_date) as last_date,
           (max(h.service_date) + make_interval(months => s.reminder_interval_months))::date as due_date
    from arts.service_history h
    join arts.services s on s.id = h.service_id
    join arts.customers c on c.id = h.customer_id
    where s.reminder_interval_months is not null and s.active and c.merged_into is null
    group by h.customer_id, h.vehicle_id, h.service_id, s.reminder_interval_months
  ) d
  where d.due_date between p_from and p_to
  order by d.customer_id, d.vehicle_id nulls first, d.service_id
$$;

revoke execute on function arts.due_list(date, date) from public, anon, authenticated;
grant execute on function arts.due_list(date, date) to service_role;

alter table arts.reminder_sends add column claimed_at timestamptz;
