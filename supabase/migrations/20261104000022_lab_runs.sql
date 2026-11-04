-- Results of the automated test lab (npm run lab), shown on Settings → Test
-- runs. The lab runs on GitHub (nightly, or "Run now" from the admin) against
-- a throwaway database, then saves its result here. Developer only.

create table arts.lab_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'nightly' check (source in ('nightly', 'manual', 'replay', 'local')),
  status text not null default 'queued' check (status in ('queued', 'passed', 'failed', 'error')),
  requested_by text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  seed bigint,
  days int,
  commit text,
  run_url text,
  duration_s int,
  -- Rules broken: [{rule, detail, day}]. Empty when the run passed.
  broken jsonb not null default '[]',
  -- Things worth a look: {kind: [examples]}.
  findings jsonb not null default '{}',
  -- What happened in the simulated weeks: {label: count}.
  stats jsonb not null default '{}',
  -- Each randomized check: [{name, status, message}].
  checks jsonb not null default '[]',
  error text
);
create index lab_runs_requested_idx on arts.lab_runs (requested_at desc);

alter table arts.lab_runs enable row level security;
alter table arts.lab_runs force row level security;
revoke all on arts.lab_runs from public, anon, authenticated;
grant select on arts.lab_runs to authenticated;
grant all on arts.lab_runs to service_role;
create policy developer_read on arts.lab_runs for select to authenticated
  using (arts.is_admin() and auth.jwt() -> 'app_metadata' ->> 'role' = 'developer');
create policy service_all on arts.lab_runs for all to service_role using (true) with check (true);
