-- Emailed 6-digit codes for returning customers ("Find my cars" when booking).
-- Only a hash of the code is stored; codes expire after 10 minutes and allow
-- 5 tries. Server-only: no admin or public access.
create table arts.login_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index login_codes_email_idx on arts.login_codes (email, created_at desc);

alter table arts.login_codes enable row level security;
alter table arts.login_codes force row level security;
revoke all on arts.login_codes from public, anon, authenticated;
grant all on arts.login_codes to service_role;
create policy service_all on arts.login_codes for all to service_role using (true) with check (true);
