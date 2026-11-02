# Staging setup log

Run 1: 2026-11-02, on Jake's Mac. Secrets are never written here (first 6 characters at most).

## Phase 0: Preflight

| Step | Result |
|---|---|
| Write `.claude/settings.json` | **Blocked; later done by Jake** (copied in by hand 2026-11-02, verified, committed). The Claude Code auto-mode safety check refuses to let the agent write its own permission rules ("Self-Modification"). Same as the original build. Ran without it. Manual item. |
| Git remote | **Missing; added.** No remote was configured. `artsscheduler-gif/scheduler` exists on GitHub and is **empty and PUBLIC**. Added it as `origin` (local config only). **Nothing pushed**, because the runbook doesn't ask for a push. |
| Working tree | Clean at start (HEAD `0802d34`). |
| `.env*` ignored | Pass. `.env`, `.env.local`, `.env.staging.local`, `.env.production.local` are ignored by `.env.*`; only `.env.example` is tracked. |
| History secret scan | Pass. gitleaks v8.21.2 isn't installed and has no npm package, so it ran in Docker (`zricethezav/gitleaks:v8.21.2 detect --redact`): 7 commits scanned, no leaks found. |
| Test suite | **103 passed** (13 files), not 93: the 10 extra are the Outbox/Simulator tests added 2026-11-02. E2E ran against local staging dev servers. Now 105 after this run's 2 new tests. |
| `.env.staging.local` | **Did not exist.** All values blank. Created it as a fill-in template (gitignored, verified with `git check-ignore`). |

## Variable mapping (runbook purpose → name the code reads)

| Runbook purpose | Variable |
|---|---|
| Supabase access token | `SUPABASE_ACCESS_TOKEN` (CLI and Management API; also read by `npm run prelaunch`) |
| Supabase project ref | `SUPABASE_PROJECT_REF` |
| Supabase project URL | `SUPABASE_URL`; also set as `VITE_SUPABASE_URL` in Vercel |
| Supabase anon key | `VITE_SUPABASE_ANON_KEY` |
| Supabase service role key | `SUPABASE_SERVICE_ROLE_KEY` (server only) |
| Supabase database password | `SUPABASE_DB_PASSWORD` (used by `supabase link`/`db push`) |
| Vercel token | `VERCEL_TOKEN` (passed as `--token`, so Jake's personal `vercel login` is untouched) |
| Vercel team | `VERCEL_SCOPE` (added: the CLI needs the team slug as `--scope`) |
| Vercel project name | `VERCEL_PROJECT` |
| Turnstile site / secret | `VITE_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` |
| Lob test key | `LOB_API_KEY`; `MAIL_PROVIDER=lob` if it starts with `test_`, otherwise `stub` |
| Owner / staff admin email | `OWNER_ADMIN_EMAIL` / `STAFF_ADMIN_EMAIL` |
| Staging domain | `STAGING_DOMAIN`; `APP_URL` and `STAGING_URL` are derived from it, or from the `*.vercel.app` URL |
| Generated | `TOKEN_SECRET`, `CRON_SECRET`, `BACKUP_ENCRYPTION_KEY` (each `openssl rand -hex 32`) |
| Fixed staging flags | `APP_ENV=staging`, `VITE_APP_ENV=staging`, `EMAIL_PROVIDER=capture`, `VITE_SHOP_PHONE` = seed placeholder |

## Phases 1–5: blocked

Every value is blank, so nothing hosted was touched. Skipped:

| Phase | Blocked on |
|---|---|
| 1 Supabase (link, migrate, RLS proof, auth settings, seed, admins) | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, both keys, `SUPABASE_DB_PASSWORD` |
| 2 Vercel (link, env vars, flags, cron, deploy) | `VERCEL_TOKEN`, `VERCEL_SCOPE`, `VERCEL_PROJECT`, plus Phase 1 |
| 3 Domain | Phase 2 deploy |
| 4 Turnstile | Turnstile keys and a deployed URL |
| 5 Lob | `LOB_API_KEY` (blank → stub provider) and Phase 2 |

The parts that don't need accounts were done now so the next run is short:

- **Phase 2.4 (Outbox and Simulator need an admin):** verified in code and tests.
  - Every `/api/admin/*` action runs `requireAdmin` (valid session, owner/staff role, TOTP) before the staging gate.
  - Tests now cover no session (401), no MFA (403), and not-staging (404).
  - `arts.email_outbox` has forced RLS: admins read, anon gets nothing.
  - No code fix was needed.
- **Phase 2.5 (cron):** `vercel.json` schedules `/api/cron/daily` at 13:00 UTC. The endpoint compares `Authorization: Bearer $CRON_SECRET` in constant time; a missing or wrong secret returns 401 (checked locally).
- **Phase 6:** `scripts/smoke-staging.ts` (`npm run smoke:staging`) is written and passes against local staging dev servers (14 pass, 2 skipped because they need https).

## Decisions

1. **Remote added, not pushed.** The runbook says to confirm the remote, not to push. Pushing to a public repo is Jake's call.
2. **Secret scan ran gitleaks in Docker**, the "equivalent" the runbook allows; nothing installed globally.
3. **Smoke test booking path:**
   - With a real Turnstile secret, no script can produce a valid token, so check 8c places the request with the Simulator's `sim-bookings`, which uses the same `create_booking` function and emails, just without Turnstile.
   - With Cloudflare's test secret (`1x…`), it books through the public `/api/book`.
   - Check 4 (reject without a token) is SKIP under the test secret, because that secret accepts every token by design.
4. **`sim-bookings` takes an optional `slot`** (service, date, kind, time) and returns booking IDs. The smoke test needs both to fill a time slot, cancel one booking, and see the time reopen. Covered by a new test.
5. **Smoke test cleanup:**
   - It creates its admin as `smoke-<timestamp>@sim.invalid` with a random password. The password is never printed.
   - It deletes that admin at the end and resets simulated data.
   - Captured emails stay in the Outbox for review.
6. **Turnstile widget check** looks for the loaded API and a rendered widget box, because the widget's iframe lives in a closed shadow root. Hostname errors (Cloudflare error 110200) show up in the console and fail the check with a manual item.
7. **Planned for the next run, so no real email is sent:**
   - **Admin invites:** use `auth.admin.generateLink({ type: 'invite' })`, which returns the link without sending anything. The links go to a gitignored file for Jake. `npm run admin:add` uses Supabase's mailer, which would send a real email.
   - **Auth settings:** set through the Management API (`PATCH /v1/projects/{ref}/config/auth`): sign-ups off, TOTP on, 12h session time-box, site URL and redirect set to the staging URL. Also add `arts` to the exposed schemas (`PATCH /v1/projects/{ref}/postgrest`). The session time-box needs a paid Supabase plan; if the API refuses it, it becomes a manual item, and the admin UI still enforces 12 hours.
   - **Seed:** `supabase db push --include-seed` applies migrations plus `supabase/seed.sql` (placeholder services and placeholder shop phone/address).
   - **Hourly escalation tick:** pg_cron needs `STAGING_URL` and `CRON_SECRET`, so it's scheduled after Phase 3.
