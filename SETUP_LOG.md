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

---

# Run 2: 2026-11-02 (evening)

`.env.staging.local` now has the six Supabase values and `OWNER_ADMIN_EMAIL`. Vercel, Turnstile and Lob are still blank.

## Fixes to the env file

| Line | Was | Now | Why |
|---|---|---|---|
| `STAFF_ADMIN_EMAIL` | `Chris` (a name, not an email) | blank | An invite needs an address. Chris's account is skipped until his email is filled in. |
| `STAGING_DOMAIN` | instruction text | blank | The domain isn't attached yet, so staging will use the `*.vercel.app` URL. |

A file named `arts_tokens and passwords.rtf` sits in the repo folder and isn't covered by `.gitignore`. I didn't open it. I added `*.rtf` to `.git/info/exclude` (local only, never pushed) so it can't be committed by accident.

## Phase 1: Supabase (project `fdblmu…`, ca-central-1, org `ivkdzz…`)

| Step | Result |
|---|---|
| Link | PASS: `supabase link` using the project's own `SUPABASE_ACCESS_TOKEN` (`sbp_fc…`). Jake's personal CLI login untouched. |
| Migrations | PASS: all 4 applied to an empty database (`20261029000001` → `20261102000001`). |
| Seed | PASS: `supabase/seed.sql` applied with `db push --include-seed`. |
| RLS forced on every table | PASS: all 16 `arts` tables show `relrowsecurity` and `relforcerowsecurity` true (checked through the Management API SQL endpoint). |
| Anon key probe | PASS: the publishable key (`sb_pub…`) can't read or write any of 16 tables or call any of 19 functions. 0 failures. |
| Sign-ups off | PASS: `disable_signup` true. |
| TOTP | PASS: enroll and verify both on. |
| 12h session time-box | **BLOCKED**: API answered "User sessions can only be configured on Pro Plans and up." Manual item. The admin UI enforces 12 hours on its own. |
| Expose `arts` schema | PASS: PostgREST `db_schema` now `public,graphql_public,arts`. |
| Site URL / redirect list | **DEFERRED** to after Phase 2: still `http://localhost:3000`; set it to `STAGING_URL` once there's a deploy. |
| Owner admin | PASS: `artssc…` created with `app_metadata.role = owner`, email pre-confirmed, **no email sent**. No password yet; the sign-in link is generated after Phase 2, because it has to point at the staging URL. |
| Staff admin | **SKIPPED**: no email address for Chris. |

## Phases 2–6: blocked

| Phase | Blocked on |
|---|---|
| 2 Vercel | `VERCEL_TOKEN`, `VERCEL_SCOPE`, `VERCEL_PROJECT` |
| 3 Domain | Phase 2 deploy (and `STAGING_DOMAIN`) |
| 4 Turnstile | both Turnstile keys plus a deploy |
| 5 Lob | `LOB_API_KEY` (blank → stub provider) |
| 6 Smoke test on staging | `STAGING_URL` (needs Phase 2) |

## Decisions (run 2)

8. **Owner created with `createUser`, not an invite.** An invite link expires and would point at `localhost` until there's a staging URL. Creating the account now and generating a link later sends no email and avoids a dead link.
9. **New-style Supabase keys** (`sb_publishable_…`, `sb_secret_…`) are used as-is. supabase-js accepts them. User sessions are still JWTs, so the server's `aal2` check is unchanged. `check-bundle-secrets` already flags `sb_secret_`.
10. **Secrets pasted into the chat.** Jake pasted the env file contents, including the access token, secret key and DB password, into the Claude conversation. Recommended rotating all three after staging is up (manual item).

## Phase 2: Vercel (team `arts-service-center`, project `arts-staging`)

`VERCEL_TOKEN` (`vcp_4L…`), `VERCEL_SCOPE` and `VERCEL_PROJECT` were pasted into the chat rather than saved, so I wrote them into `.env.staging.local`.

| Step | Result |
|---|---|
| Token and team | PASS: token sees exactly one team, `arts-service-center`, which had no projects. |
| Link | PASS: `vercel link` created and linked `arts-staging` (`.vercel/` is gitignored). The CLI also appended a `VERCEL_OIDC_TOKEN` line to `.env.local` and `.env*` to `.gitignore`; both reverted (the ignore rule already existed). |
| Generated secrets | PASS: `TOKEN_SECRET`, `CRON_SECRET`, `BACKUP_ENCRYPTION_KEY` (32 random bytes each) written to `.env.staging.local`. |
| Env vars (Production) | PASS, 15 set: `SUPABASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, the three secrets, both Turnstile keys, `VITE_SHOP_PHONE` (seed placeholder), `APP_URL`, `APP_ENV=staging`, `VITE_APP_ENV=staging`, `EMAIL_PROVIDER=capture`, `MAIL_PROVIDER=stub`. Secrets are stored as Vercel "Secret" type. |
| Deploy | PASS: production deploy READY, aliased to **https://arts-staging.vercel.app**. Redeployed once after `APP_URL` was known. The build log shows `TS2688: Cannot find type definition file for 'node' / 'vite/client'` from Vercel's function type check; non-fatal, functions work (logged, not fixed). |
| Supabase site URL / redirects | PASS: `site_url` = `https://arts-staging.vercel.app/admin`, allow list `https://arts-staging.vercel.app/**`. |
| Outbox and Simulator need an admin | PASS on staging: admin API 401 and outbox anon read 401 (smoke check 5). |
| Daily cron | PASS: `vercel.json` cron registered; endpoint returns 401 without the secret (smoke check 6). |
| Hourly tick (pg_cron) | PASS: `pg_cron` + `pg_net` enabled; job `arts-tick` at `5 * * * *` posts to `/api/cron/tick`. Triggered once by hand: HTTP 200, `{"ok":true,...}`. |
| Owner sign-in link | PASS: `generateLink({type:'recovery'})` to `/admin`; **no email sent**. Saved outside the repo in the Claude scratchpad (`owner-signin-link.txt`); single use, expires about an hour after creation. |

## Phase 3: Domain

`STAGING_DOMAIN` blank, so `STAGING_URL=https://arts-staging.vercel.app`. No domain or DNS operations were run.

## Phase 4: Turnstile

No keys yet. Used Cloudflare's published always-pass **test** keys (`1x0000…`). The widget renders and issues a token on staging (smoke 4b). Check 4 (reject a bad token) is SKIP until the real keys go in.

## Phase 5: Lob

`LOB_API_KEY` blank, so `MAIL_PROVIDER=stub`. Postcard batches are created but nothing is sent to Lob. No test postcard PDF.

## Phase 6: Smoke test on staging

`npm run smoke:staging -- --env .env.staging.local --url https://arts-staging.vercel.app`: **15 passed, 0 failed, 1 skipped** (check 4, test Turnstile secret). Afterwards:

- `auth.users` holds only the owner (the temporary smoke admin was deleted).
- 0 simulated customers remain.
- 60 captured emails stay in the Outbox for review. 55 went to `@sim.invalid` addresses and 5 to the configured staff/owner alert addresses: `chris@example.com` (seed placeholder) and `jakevig@gmail.com` (the `owner_alert_email` default). All were captured; the capture provider sends nothing.

## Decisions (run 2, continued)

11. **Turnstile test keys** let Phases 4 and 6 run without the real widget. They accept every token, so they must be replaced before anyone outside tests staging.
12. **Two deploys.** The `*.vercel.app` URL isn't known until the first deploy, and `APP_URL` goes into every email link, so I deployed, set `APP_URL`, and deployed again.
13. **Owner link via `recovery`, not `invite`.** The account already existed (decision 8), and the admin page's set-password screen accepts both link types.
14. **The sign-in link is kept outside the repo** in the session scratchpad, not in a gitignored repo file, so it can't end up in a commit or a push.

## After the run: owner sign-in

- Jake set his password from the one-time link, but every authenticator code was rejected.
- Cause: each admin page load deleted the pending TOTP factor and enrolled a new one, so a QR scanned before a reload stopped matching. The QR was also shown smaller than its native size with no quiet zone.
- Fixed in `553dc04`:
  - the pending enrollment is kept in sessionStorage for the tab;
  - the QR is shown at its native size with a white margin;
  - an `otpauth://` link is added for same-phone setup;
  - Supabase's error text is shown.
  - A new e2e assertion checks that a reload keeps the same secret.
- After the fix, codes still failed. Checking the server's stored secret against a code from Jake's screenshot showed the code matched no time within ±24h. His app was reading an entry left over from an earlier attempt. He deleted the old entries, re-added it, and the owner's factor is now verified (02:01 UTC).
- The setup key appeared in a screenshot in the chat. Offered to reset the factor.
