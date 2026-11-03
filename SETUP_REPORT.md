# Staging setup report

**Run 2: 2026-11-02 (evening). Result: staging is live; smoke test 15 passed, 0 failed, 1 skipped.** It runs on Cloudflare's Turnstile test keys and the Lob stub until the real keys are in. Run 1 (earlier the same day) had no values at all; its details are in `SETUP_LOG.md`.

| | |
|---|---|
| STAGING_URL | **https://arts-staging.vercel.app** |
| Admin URL | https://arts-staging.vercel.app/admin (owner: `artssc…`; Chris not yet invited) |
| Test suite | **105 passed** / 105 (runbook expected 93: +10 Outbox/Simulator tests on 2026-11-02, +2 this run) |
| Commits | Run 1: `e0a5a1d`, `26d8001`, `d3d0fa1`, `1c2ea0c`. Run 2: `a9be704` Phase 1, `1cbbae8` report, Phases 2–6 log, this report. Nothing pushed. |

## Checks

| Phase | Check | Result |
|---|---|---|
| 0 | `.claude/settings.json` written | **DONE by Jake** (2026-11-02): the safety check blocked the agent, so Jake copied it in; verified valid, 10 rules |
| 0 | Git remote is `artsscheduler-gif/scheduler` | **FIXED**: was missing; added as `origin`. Repo is empty and **public** (manual item 3) |
| 0 | Working tree clean | PASS |
| 0 | `.env*` gitignored except `.env.example` | PASS |
| 0 | Secret scan of full history | PASS: gitleaks (Docker), 7 commits, no leaks |
| 0 | Test suite | PASS: 103 at preflight, 105 after this run |
| 0 | `.env.staging.local` values | Supabase + owner email set. `STAFF_ADMIN_EMAIL` (`Chris`, not an email) and `STAGING_DOMAIN` (instruction text) blanked. Vercel, Turnstile, Lob blank |
| 1 | Link, 4 migrations, seed | PASS |
| 1 | RLS forced on all 16 tables; anon key blocked from 16 tables / 19 functions | PASS |
| 1 | Sign-ups off, TOTP on, `arts` exposed to the API | PASS |
| 1 | 12h session time-box | **BLOCKED**: needs Supabase Pro (manual item 4) |
| 1 | Site URL / redirects | PASS: set to the staging URL after Phase 2 |
| 1 | Owner admin | PASS: created with owner role, no email sent; one-time sign-in link generated after deploy |
| 1 | Staff admin | **SKIPPED**: no email for Chris |
| 2 | Project `arts-staging` created and linked; 15 production env vars; staging flags on | PASS |
| 2 | Production deploy | PASS: READY at `arts-staging.vercel.app`. Non-fatal TS2688 type warnings in the build log |
| 2 | Hourly tick from pg_cron | PASS: scheduled; one manual run returned 200 |
| 2.4 | Outbox and Simulator need a logged-in admin | PASS on staging: admin API 401, outbox anon read 401 (plus the 403/404 tests locally) |
| 2.5 | Daily cron configured; endpoint rejects missing secret | PASS on staging: 401 / 401 |
| 3 | Domain attached | SKIPPED (not attached yet): using `arts-staging.vercel.app` |
| 4 | Turnstile widget loads at STAGING_URL | PASS with Cloudflare **test** keys. Real keys still needed |
| 5 | Lob test postcard | SKIPPED: no key; stub provider in use |
| 6 | Smoke test against STAGING_URL | **PASS: 15 passed, 0 failed, 1 skipped** (below) |
| 7 | This report | done |

### Smoke test, live staging (`npm run smoke:staging -- --url https://arts-staging.vercel.app`)

```
PASS  1. Homepage and booking page load  6 services listed
PASS  2. Security headers (CSP, HSTS, frame denial on /admin)
PASS  3. Availability returns dates/times only  43 open days
SKIP  4. Booking without a valid Turnstile token is rejected  Cloudflare test secret (1x…) accepts every token by design
PASS  4b. Turnstile widget loads on the booking form  widget rendered, token issued (test key)
PASS  5. /admin shows sign-in when not authenticated  sign-in form shown; admin API 401; outbox anon read HTTP 401
PASS  6. Cron endpoint rejects requests without the secret  HTTP 401 / 401
PASS  7. Health endpoint: database and providers reachable
PASS  8a. Test admin signs in with TOTP; simulator enabled  today 2026-11-02, dry-run true
PASS  8b. Load fake customers  40 customers, 101 service records
PASS  8c. Book one appointment; it lands as requested in the approval queue  2026-11-04 07:30 via public /api/book
PASS  8d. Approve it; confirmation email appears in the Outbox
PASS  8e. Cancel through the manage link; capacity is released  07:30 on 2026-11-04 filled, then reopened
PASS  8f. Fast-forward: due reminders reach the Outbox  51 reminder emails over 14 days; 23 postcards batched (stub provider)
PASS  9. Anon key cannot read or write any table or call any function  16 tables, 19 functions denied
PASS  Cleanup: simulated data and the test admin removed  captured emails left in the Outbox for review
15 passed, 0 failed, 1 skipped.
```

### Smoke test, local staging dev servers (run 1, `npm run smoke:staging -- --env .env.local --url http://localhost:5173`)

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

1. ~~**Add the Claude Code permissions file yourself.**~~ **Done 2026-11-02.** `.claude/settings.json` is committed with the 10 rules the runbook asked for.
2. ~~**Sign in as owner.**~~ **Done 2026-11-02.** Password set and authenticator verified. Setup first failed because a page reload replaced the pending authenticator secret; fixed in `553dc04`.
3. **Still to fill in `.env.staging.local`:**
   - Real Turnstile keys: Cloudflare → Turnstile → Add widget, hostname `arts-staging.vercel.app` (plus `arts.jvtestspace.com` later). They replace the `1x0000…` test keys.
   - `STAFF_ADMIN_EMAIL`: Chris's email address, not his name.
   Then say "check" and Claude updates Vercel, redeploys, invites Chris and re-runs the smoke test.
4. **Decide GitHub visibility before pushing.** `artsscheduler-gif/scheduler` is **public**. The code has no secrets (gitleaks clean), but DECISIONS.md and the README describe the shop's operations and security setup. To make it private: github.com/artsscheduler-gif/scheduler → Settings → General → Danger Zone → Change visibility. Then push with `git push -u origin main` (the runbook doesn't push).
5. **Supabase project plan:** a free project pauses after a week without activity, and the 12-hour session time-box (Authentication → Sessions) needs a paid plan. If the next run can't set the time-box, it stays a manual item; the admin UI enforces 12 hours on its own either way.
6. **Staging domain (optional):**
   - Vercel → artsscheduler team → the project → Settings → Domains → Add `arts.jvtestspace.com`.
   - Then at GoDaddy (jvtestspace.com → DNS), add the CNAME `arts` → the target Vercel shows (normally `cname.vercel-dns.com`).
   - Add the `_vercel` TXT verification record too if Vercel asks for one; it will, because jvtestspace.com is already on your personal Vercel account.
   - Then set `STAGING_DOMAIN=arts.jvtestspace.com`. Without it, staging runs on the `*.vercel.app` URL.
7. **Turnstile hostnames:** Cloudflare → Turnstile → your widget → Settings → Hostname Management. Add every host staging will use: `arts.jvtestspace.com` and the project's `<project>.vercel.app` (shown after the first deploy).
8. **Lob (optional):** Lob dashboard → Settings → API Keys → Test Environment → copy the `test_…` key into `LOB_API_KEY`. Never paste a `live_…` key.
9. **Vercel plan:** if the artsscheduler team is on Hobby, it's fine for staging but not for the production business site (Hobby is non-commercial).
10. **Move `arts_tokens and passwords.rtf` out of the repo folder** (into a password manager is best). It's ignored locally so it can't be committed, but it shouldn't live next to code that gets pushed.
11. **Rotate the secrets that were pasted into the chat** once staging works:
    - Supabase access token: Account → Access Tokens, delete `sbp_fc…` and make a new one.
    - Secret key: Project Settings → API Keys, roll `sb_sec…`.
    - Database password: Project Settings → Database → Reset.
    - Vercel token: Account Settings → Tokens, delete `vcp_4L…` and create a new one.
    Then update `.env.staging.local` (and Vercel's `SUPABASE_SERVICE_ROLE_KEY`, then redeploy).
