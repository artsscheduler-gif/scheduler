-- Art's Service Center: booking & reminders schema.
-- Everything lives in the `arts` schema so the same migrations work in a
-- dedicated Supabase project or as a schema inside a shared project.

create schema if not exists arts;

create type arts.booking_kind as enum ('wait', 'dropoff');
create type arts.booking_status as enum ('requested', 'confirmed', 'declined', 'completed', 'cancelled', 'no_show', 'replaced');
create type arts.approval_level as enum ('approve', 'notify', 'digest');
create type arts.reminder_channel as enum ('email', 'postcard');
create type arts.reminder_condition as enum ('no_booking_since_due', 'no_booking_since_previous_step');

-- ---------------------------------------------------------------------------
-- Settings (single row). Every [bracketed] value from the spec lives here.
-- ---------------------------------------------------------------------------
create table arts.shop_settings (
  id int primary key default 1 check (id = 1),
  shop_name text not null default 'Art''s Service Center',
  shop_phone text not null default '[shop phone]',
  shop_address text not null default '[shop address]',
  timezone text not null default 'America/New_York',
  booking_url text not null default 'https://book.artsservicecenter.com',
  -- Hours by ISO weekday key. null = closed.
  hours jsonb not null default '{"mon":{"open":"07:30","close":"17:30"},"tue":{"open":"07:30","close":"17:30"},"wed":{"open":"07:30","close":"17:30"},"thu":{"open":"07:30","close":"17:30"},"fri":{"open":"07:30","close":"17:30"},"sat":null,"sun":null}',
  total_lanes int not null default 3 check (total_lanes > 0),
  waiter_lanes int not null default 2 check (waiter_lanes >= 0),
  slot_step_minutes int not null default 15 check (slot_step_minutes between 5 and 120),
  buffer_minutes int not null default 10 check (buffer_minutes >= 0),
  dropoff_window_start time not null default '07:30',
  dropoff_window_end time not null default '09:00',
  dropoff_share_pct int not null default 60 check (dropoff_share_pct between 0 and 100),
  floor_days int not null default 2 check (floor_days >= 0),
  max_days_ahead int not null default 60 check (max_days_ahead > 0),
  -- Approval workflow
  notes_require_review boolean not null default true,
  new_customers_require_review boolean not null default true,
  notes_max_length int not null default 500,
  request_turnaround_business_hours int not null default 4,
  escalate_staff_business_hours int not null default 4,
  escalate_owner_business_days int not null default 1,
  ladder_step2_approvals int not null default 20,
  ladder_step3_weeks int not null default 4,
  undo_window_hours int not null default 2,
  -- Customer changes & abuse
  change_cutoff_hours int not null default 24,
  max_future_bookings int not null default 3,
  rate_limit_ip_per_hour int not null default 20,
  rate_limit_contact_per_day int not null default 5,
  -- Reminders
  appointment_reminder_hours int not null default 48,
  reminders_dry_run boolean not null default true,
  reminder_max_overdue_days int not null default 365,
  postcard_auto_approve boolean not null default false,
  postcard_size text not null default '4x6' check (postcard_size in ('4x6', '6x9')),
  postcard_cost_cents int not null default 80,
  postcard_front_html text not null default '',
  postcard_back_html text not null default '',
  -- Notifications
  from_email text not null default 'service@artsservicecenter.com',
  from_name text not null default 'Art''s Service Center',
  staff_notify_email text not null default '[chris email]',
  owner_alert_email text not null default 'jakevig@gmail.com',
  alert_send_failure_pct int not null default 5,
  -- Admin
  session_timeout_hours int not null default 12,
  -- Brand (placeholders until confirmed with the shop)
  brand_color text not null default '#2b3a4a',
  logo_url text not null default '',
  updated_at timestamptz not null default now()
);
insert into arts.shop_settings (id) values (1);

create table arts.closures (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table arts.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  duration_minutes int not null check (duration_minutes > 0),
  wait_eligible boolean not null default false,
  daily_cap int check (daily_cap is null or daily_cap >= 0),
  lead_days int check (lead_days is null or lead_days >= 0),
  reminder_interval_months int check (reminder_interval_months is null or reminder_interval_months > 0),
  approval_level arts.approval_level not null default 'approve',
  approvals_in_a_row int not null default 0,
  level_since timestamptz not null default now(),
  last_undo_at timestamptz,
  epicor_codes text[] not null default '{}',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table arts.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  email_opt_out boolean not null default false,
  mail_opt_out boolean not null default false,
  email_bounced boolean not null default false,
  address_undeliverable boolean not null default false,
  always_review boolean not null default false,
  source text not null default 'booking' check (source in ('import', 'booking', 'admin')),
  epicor_id text,
  merged_into uuid references arts.customers(id),
  created_at timestamptz not null default now()
);
create index customers_email_idx on arts.customers (lower(email));
create index customers_phone_idx on arts.customers (phone);

create table arts.vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references arts.customers(id),
  year int,
  make text,
  model text,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index vehicles_customer_idx on arts.vehicles (customer_id);

create table arts.bookings (
  id uuid primary key default gen_random_uuid(),
  -- All versions of one appointment share a root. Customer change requests
  -- are new rows that replace the confirmed version once approved.
  root_id uuid not null,
  replaces_booking_id uuid references arts.bookings(id),
  change_kind text check (change_kind in ('services', 'reschedule')),
  customer_id uuid not null references arts.customers(id),
  vehicle_id uuid references arts.vehicles(id),
  date date not null,
  kind arts.booking_kind not null,
  start_time time,
  total_minutes int not null check (total_minutes > 0),
  status arts.booking_status not null,
  customer_notes text not null default '',
  auto_confirmed boolean not null default false,
  approval_level arts.approval_level,
  decided_by uuid,
  decided_at timestamptz,
  decline_reason text,
  created_by_type text not null check (created_by_type in ('public', 'admin', 'customer')),
  created_by uuid,
  undo_until timestamptz,
  staff_notified_at timestamptz,
  escalated_staff_at timestamptz,
  escalated_owner_at timestamptz,
  confirmation_sent_at timestamptz,
  reminder_sent_at timestamptz,
  digest_sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'dropoff' or start_time is not null)
);
create index bookings_date_idx on arts.bookings (date) where status in ('requested', 'confirmed', 'completed');
create index bookings_root_idx on arts.bookings (root_id);
create index bookings_customer_idx on arts.bookings (customer_id);
create index bookings_status_idx on arts.bookings (status);

create table arts.booking_services (
  booking_id uuid not null references arts.bookings(id) on delete cascade,
  service_id uuid not null references arts.services(id),
  primary key (booking_id, service_id)
);
create index booking_services_service_idx on arts.booking_services (service_id);

create table arts.service_history (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references arts.customers(id),
  vehicle_id uuid references arts.vehicles(id),
  service_id uuid references arts.services(id),
  service_date date not null,
  mileage int,
  raw_service text,
  source text not null check (source in ('import', 'booking', 'admin')),
  booking_id uuid references arts.bookings(id),
  created_at timestamptz not null default now()
);
create index service_history_customer_idx on arts.service_history (customer_id);

create table arts.reminder_rules (
  id uuid primary key default gen_random_uuid(),
  step int not null unique check (step > 0),
  channel arts.reminder_channel not null,
  offset_days int not null,
  condition arts.reminder_condition not null,
  active boolean not null default true
);
insert into arts.reminder_rules (step, channel, offset_days, condition) values
  (1, 'email', -14, 'no_booking_since_due'),
  (2, 'postcard', 0, 'no_booking_since_previous_step'),
  (3, 'email', 30, 'no_booking_since_previous_step');

create table arts.mail_batches (
  id uuid primary key default gen_random_uuid(),
  week_of date not null,
  count int not null default 0,
  est_cost_cents int not null default 0,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent')),
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table arts.reminder_sends (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references arts.customers(id),
  vehicle_id uuid references arts.vehicles(id),
  service_id uuid references arts.services(id),
  due_date date not null,
  rule_id uuid references arts.reminder_rules(id),
  step int not null,
  channel arts.reminder_channel not null,
  status text not null check (status in ('queued', 'batched', 'sent', 'failed', 'dry_run', 'skipped', 'undeliverable')),
  provider_id text,
  cost_cents int,
  error text,
  attempts int not null default 0,
  batch_id uuid references arts.mail_batches(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index reminder_sends_once on arts.reminder_sends
  (customer_id, coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid), due_date, step);

-- Transactional email log (confirmations, notices, appointment reminders).
create table arts.email_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  to_email text not null,
  booking_id uuid references arts.bookings(id),
  customer_id uuid references arts.customers(id),
  status text not null check (status in ('sent', 'failed', 'stubbed')),
  provider_id text,
  cost_cents int,
  error text,
  created_at timestamptz not null default now()
);

create table arts.audit_log (
  id bigint generated always as identity primary key,
  actor_type text not null check (actor_type in ('admin', 'customer', 'system')),
  actor_id uuid,
  actor_label text not null default '',
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on arts.audit_log (created_at desc);

create table arts.job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  summary jsonb not null default '{}',
  error text
);

create table arts.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Lock everything down. anon gets nothing. Admins (authenticated, role
-- owner/staff, MFA verified) can read; all writes go through server code.
-- ---------------------------------------------------------------------------
create function arts.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('owner', 'staff')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'arts' loop
    execute format('alter table arts.%I enable row level security', t);
    execute format('alter table arts.%I force row level security', t);
    execute format('revoke all on arts.%I from public, anon, authenticated', t);
    execute format('grant select on arts.%I to authenticated', t);
    execute format('grant all on arts.%I to service_role', t);
    execute format('create policy admin_read on arts.%I for select to authenticated using (arts.is_admin())', t);
  end loop;
end $$;

-- Service role bypasses RLS by role attribute, but FORCE applies to owners;
-- give service_role an explicit allow-all policy so server code keeps working.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'arts' loop
    execute format('create policy service_all on arts.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

revoke all on schema arts from public, anon;
grant usage on schema arts to authenticated, service_role;
grant usage, select on all sequences in schema arts to service_role;
revoke execute on all functions in schema arts from public, anon;
grant execute on function arts.is_admin() to authenticated;

alter default privileges in schema arts revoke all on tables from public, anon, authenticated;
alter default privileges in schema arts revoke execute on functions from public, anon, authenticated;
alter default privileges in schema arts grant execute on functions to service_role;
