-- Staging support: a captured-email outbox. The capture provider writes here
-- instead of delivering, and the staging-only Outbox tab reads it. Harmless in
-- production (stays empty unless EMAIL_PROVIDER=capture).
create table arts.email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text,
  to_email text not null,
  from_email text not null,
  subject text not null,
  html text not null,
  text text not null,
  attachments text[] not null default '{}',
  sim_date date, -- set when the Simulator's fast-forward produced the email
  created_at timestamptz not null default now()
);
create index email_outbox_created_idx on arts.email_outbox (created_at desc);

alter table arts.email_outbox enable row level security;
alter table arts.email_outbox force row level security;
revoke all on arts.email_outbox from public, anon, authenticated;
grant select on arts.email_outbox to authenticated;
grant all on arts.email_outbox to service_role;
create policy admin_read on arts.email_outbox for select to authenticated using (arts.is_admin());
create policy service_all on arts.email_outbox for all to service_role using (true) with check (true);

alter table arts.email_log drop constraint email_log_status_check;
alter table arts.email_log add constraint email_log_status_check check (status in ('sent', 'failed', 'stubbed', 'captured'));
