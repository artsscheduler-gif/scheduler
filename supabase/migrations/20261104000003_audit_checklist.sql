-- Launch checklist: findings from code audits plus launch tasks. The owner
-- ticks items off in the admin; scripts/audit-sync.ts loads each new audit
-- run (the /audit Claude Code command), matching items by a stable key.

create table arts.audit_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  summary text not null default '',
  found int not null default 0,
  added int not null default 0,
  fixed int not null default 0
);

create table arts.audit_items (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  section text not null,
  sort int not null default 0,
  title text not null,
  detail text not null default '',
  priority text not null default 'soon' check (priority in ('now', 'before-launch', 'soon', 'later')),
  owner text not null default 'claude' check (owner in ('jake', 'claude', 'both')),
  done boolean not null default false,
  done_at timestamptz,
  done_by text,
  note text not null default '',
  -- What the latest audit said: present (still there), fixed (verified gone),
  -- not_found (not reported this time; check it), new (first seen this run).
  audit_status text not null default 'new' check (audit_status in ('new', 'present', 'fixed', 'not_found')),
  first_seen_run uuid references arts.audit_runs (id) on delete set null,
  last_seen_run uuid references arts.audit_runs (id) on delete set null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['audit_runs', 'audit_items'] loop
    execute format('alter table arts.%I enable row level security', t);
    execute format('alter table arts.%I force row level security', t);
    execute format('revoke all on arts.%I from public, anon, authenticated', t);
    execute format('grant select on arts.%I to authenticated', t);
    execute format('grant all on arts.%I to service_role', t);
    -- Owner only: staff never see the checklist.
    execute format($p$create policy owner_read on arts.%I for select to authenticated
      using (arts.is_admin() and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'owner')$p$, t);
    execute format('create policy service_all on arts.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;
