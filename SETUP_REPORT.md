# Staging setup report

**Run 1: 2026-11-02. Result: not deployed.** `.env.staging.local` didn't exist, so every account value was blank. Everything that doesn't need an account is done and committed. Once the file is filled in, re-run the runbook; it picks up at Phase 1.

| | |
|---|---|
| STAGING_URL | none yet (no deploy) |
| Admin URL | none yet (will be `STAGING_URL/admin`) |
| Test suite | **105 passed** / 105 (runbook expected 93: +10 Outbox/Simulator tests on 2026-11-02, +2 this run) |
| Commits | `e0a5a1d` Phase 0, `26d8001` Phase 6, this report. Nothing pushed. |

## Checks

| Phase | Check | Result |
|---|---|---|
| 0 | `.claude/settings.json` written | **FAIL**: blocked by the Claude Code safety check (manual item 1) |
| 0 | Git remote is `artsscheduler-gif/scheduler` | **FIXED**: was missing; added as `origin`. Repo is empty and **public** (manual item 3) |
| 0 | Working tree clean | PASS |
| 0 | `.env*` gitignored except `.env.example` | PASS |
| 0 | Secret scan of full history | PASS: gitleaks (Docker), 7 commits, no leaks |
| 0 | Test suite | PASS: 103 at preflight, 105 after this run |
| 0 | `.env.staging.local` values | **BLOCKED**: file missing; template created, all blank |
| 1 | Supabase link, migrations, RLS proof, auth settings, seed, admin invites | **SKIPPED**: no Supabase values |
| 2 | Vercel link, env vars, staging flags, deploy | **SKIPPED**: no Vercel values |
| 2.4 | Outbox and Simulator need a logged-in admin | PASS (code + tests): 401 with no session, 403 without TOTP, 404 unless `APP_ENV=staging`; outbox table unreadable by anon |
| 2.5 | Daily cron configured; endpoint rejects missing secret | PASS (locally): `vercel.json` cron 13:00 UTC; 401 without or with a wrong secret |
| 3 | Domain attached, resolves, valid cert | **SKIPPED**: no deploy |
| 4 | Turnstile widget loads at STAGING_URL | **SKIPPED** on staging. Locally: widget renders and issues a token (test key) |
| 5 | Lob test postcard | **SKIPPED**: no key; stub provider will be used |
| 6 | Smoke test against STAGING_URL | **SKIPPED** on staging. Script written; local staging run below |
| 7 | This report | done |

### Smoke test, local staging dev servers (`npm run smoke:staging -- --env .env.local --url http://localhost:5173`)

```
PASS  1. Homepage and booking page load
SKIP  2. Security headers: not https (headers come from vercel.json on Vercel only)
PASS  3. Availability returns dates/times only
SKIP  4. Booking without a valid Turnstile token is rejected: test secret accepts every token by design
PASS  4b. Turnstile widget loads on the booking form
PASS  5. /admin shows sign-in when not authenticated (admin API 401, outbox anon read 401)
PASS  6. Cron endpoint rejects requests without the secret
PASS  7. Health endpoint: database and providers reachable
PASS  8a. Test admin signs in with TOTP; simulator enabled
PASS  8b. Load fake customers
PASS  8c. Book one appointment; it lands as requested in the approval queue
PASS  8d. Approve it; confirmation email appears in the Outbox
PASS  8e. Cancel through the manage link; capacity is released
PASS  8f. Fast-forward: due reminders reach the Outbox
PASS  9. Anon key cannot read or write any table or call any function (16 tables, 19 functions)
PASS  Cleanup: simulated data and the test admin removed
14 passed, 0 failed, 2 skipped.
```

## Decisions

Full detail in `SETUP_LOG.md`. In short:

1. Added the GitHub remote but didn't push.
2. Ran gitleaks in Docker instead of installing it.
3. With a real Turnstile key, the smoke test places its booking through the Simulator, because no script can pass a real Turnstile challenge.
4. `sim-bookings` gained an optional fixed slot so the smoke test can prove a cancel releases capacity.
5. The smoke test's admin is temporary and deleted at the end.
6. Planned for the next run:
   - Admin invites made with `generateLink`, so Supabase sends no real email.
   - Auth settings applied through the Management API.
   - Seed applied with `db push --include-seed`.
   - Hourly pg_cron tick scheduled once the URL is known.

## Manual items for Jake

1. **Add the Claude Code permissions file yourself** (the agent isn't allowed to write its own permissions). Create `.claude/settings.json` in the repo with:
   ```json
   { "permissions": { "allow": ["Edit(./**)", "Write(./**)", "Bash(npm:*)", "Bash(npx:*)", "Bash(git:*)", "Bash(vercel:*)", "Bash(supabase:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(dig:*)"] } }
   ```
2. **Fill in `.env.staging.local`** (already created, gitignored; each line says where the value lives), then re-run the runbook. Minimum to get past Phase 2:
   - all six Supabase lines
   - `VERCEL_TOKEN`, `VERCEL_SCOPE` (team slug from `vercel.com/<slug>`), `VERCEL_PROJECT`
   - both Turnstile keys
   - `OWNER_ADMIN_EMAIL`
3. **Decide GitHub visibility before pushing.** `artsscheduler-gif/scheduler` is **public**. The code has no secrets (gitleaks clean), but DECISIONS.md and the README describe the shop's operations and security setup. To make it private: github.com/artsscheduler-gif/scheduler → Settings → General → Danger Zone → Change visibility. Then push with `git push -u origin main` (the runbook doesn't push).
4. **Supabase project plan:** a free project pauses after a week without activity, and the 12-hour session time-box (Authentication → Sessions) needs a paid plan. If the next run can't set the time-box, it stays a manual item; the admin UI enforces 12 hours on its own either way.
5. **Staging domain (optional):**
   - Vercel → artsscheduler team → the project → Settings → Domains → Add `arts.jvtestspace.com`.
   - Then at GoDaddy (jvtestspace.com → DNS), add the CNAME `arts` → the target Vercel shows (normally `cname.vercel-dns.com`).
   - Add the `_vercel` TXT verification record too if Vercel asks for one; it will, because jvtestspace.com is already on your personal Vercel account.
   - Then set `STAGING_DOMAIN=arts.jvtestspace.com`. Without it, staging runs on the `*.vercel.app` URL.
6. **Turnstile hostnames:** Cloudflare → Turnstile → your widget → Settings → Hostname Management. Add every host staging will use: `arts.jvtestspace.com` and the project's `<project>.vercel.app` (shown after the first deploy).
7. **Lob (optional):** Lob dashboard → Settings → API Keys → Test Environment → copy the `test_…` key into `LOB_API_KEY`. Never paste a `live_…` key.
8. **Vercel plan:** if the artsscheduler team is on Hobby, it's fine for staging but not for the production business site (Hobby is non-commercial).
