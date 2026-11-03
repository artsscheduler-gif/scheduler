-- The authenticator code is required for developers only. Owners and staff
-- (the shop) sign in with email and password. Revisit in the security audit.
create or replace function arts.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select case coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
    when 'developer' then coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    when 'owner' then true
    when 'staff' then true
    else false
  end
$$;
