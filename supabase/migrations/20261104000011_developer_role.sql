-- Three admin roles: developer (maintains the system), owner (runs the
-- business), staff (day-to-day). All three can read admin data; the launch
-- checklist is for the developer only.

create or replace function arts.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('developer', 'owner', 'staff')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

drop policy owner_read on arts.audit_items;
drop policy owner_read on arts.audit_runs;
create policy developer_read on arts.audit_items for select to authenticated
  using (arts.is_admin() and auth.jwt() -> 'app_metadata' ->> 'role' = 'developer');
create policy developer_read on arts.audit_runs for select to authenticated
  using (arts.is_admin() and auth.jwt() -> 'app_metadata' ->> 'role' = 'developer');
