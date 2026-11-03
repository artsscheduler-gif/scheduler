# Decisions log

Choices made during the build where the spec was ambiguous or a dependency was
missing. Each one is the simplest option that satisfies the spec. Revisit any
of them freely.

## Phase 1: Foundation

1. **Permissions file not written.** The spec asked for `.claude/settings.json` with pre-approved permissions. The session's safety classifier blocked Claude from writing its own permission rules. The build ran under auto mode instead. Jake can add the file by hand if wanted.
2. **Everything lives in an `arts` Postgres schema.** The same migrations work in a dedicated project or inside the Acuity project (the fallback in Open Items). No `public` tables are created.
3. **No hosted Supabase project was created.** Whether to use a dedicated paid project or the Acuity project is an open item, and it costs money. The whole build runs against the local Supabase stack (Docker). Deployment steps are in README.md.
4. **Admins read through RLS and write only through the server.** Authenticated users get `SELECT` on `arts` tables, gated by a policy that requires `app_metadata.role` in (owner, staff) **and** `aal = aal2` (TOTP verified). Every write goes through `/api/admin`, so the audit log cannot be skipped.
5. **Admin role lives in `app_metadata.role`.** Users can't edit app_metadata themselves, so the role can't be self-assigned. `scripts/add-admin.ts` sets it.
6. **Session timeout is enforced twice.** `[auth.sessions] timebox = "12h"` is set in config.toml. On hosted Supabase that is a Pro-plan feature. The admin UI also signs out 12h after MFA verification, using the `session_timeout_hours` setting.
7. **`[auth.email] enable_signup` stays true.** Setting it false disables email+password login entirely. Sign-ups are blocked by `[auth] enable_signup = false` instead, and a test proves it.
8. **Booking status gained `replaced`.** Customer change requests are new booking rows that share a `root_id` with the original. That lets both slots be held with no special capacity code. On approval the old version becomes `replaced`.
9. **Extra settings beyond the spec's list:** timezone (America/New_York, assumed), approval toggles, ladder thresholds, cutoff, rate limits, alert emails, brand color, postcard HTML, `reminders_dry_run` (cutover switch, on by default), `reminder_max_overdue_days` (365). These cover every [bracketed] value and keep shop knobs out of code.
10. **Placeholder appointment types** are in `supabase/seed.sql` (local only): Oil change, State inspection, Tire rotation, Brakes (cap 1/day), Check engine light, Something else. They are not in the migrations, so production starts with none until the shop's real list is entered in admin.
11. **npm `legacy-peer-deps=true`** (`.npmrc`). npm 11 crashes resolving Vite 8's optional peers otherwise.
12. **Local Supabase ports are 554xx** so they don't collide with other local projects.

## Phase 2: Scheduling engine

13. **The scheduling rules live in Postgres** (`arts.check_booking`). Availability and booking both call it, so the calendar the customer sees can't disagree with the rule check that runs under the lock. The tests run against the real local database, not mocks.
14. **The maximum waiter overlap is checked at the new start time and at every existing wait start inside the job span.** That's sufficient because overlap only rises at a start.
15. **A wait job must finish by closing time.** The spec doesn't say whether a waiter can start at 5:15 for a 55-minute job. Waiting customers can't be left overnight, so it isn't allowed.
16. **"Propose a different time" moves and confirms.** The request moves to the new slot, is confirmed, and the customer is emailed the new time with the manage link to change or cancel. A separate accept-the-proposal round trip would add a state for little gain. It counts as a change, so it resets the type's ladder counter, like decline and undo.
17. **Undo returns an auto-confirmed booking to `requested`.** It goes back into the approval queue, the customer gets a "the shop is double-checking this one" email, and the type's counter resets.
18. **"Returning customer"** means the customer has any service_history (including Epicor imports) or a completed booking.
19. **Future-booking cap [3] counts distinct appointments** (root_id), so a pending change doesn't count twice. Admin bookings are exempt.

## Phase 3: Public booking

20. **Two token-gated endpoints beyond the five.** `GET /api/manage` (a read-only view for the holder of a valid manage link) and `POST /api/unsubscribe` (required by law for marketing email). Both reject anything without a valid HMAC token. `/api/health` and the cron and admin routes are not public-facing (secret or MFA-JWT gated).
21. **The public booking response never reveals whether the customer already exists.** The page shows what a brand-new customer would see. Example: while "new customers require review" is on, a returning customer who was auto-confirmed sees "Request received", and their confirmation email arrives seconds later. A refusal that only applies to existing customers (the future-booking cap) looks exactly like an outage, which is the phone fallback.
22. **Step 4 "optional notes" are vehicle notes** (color, plate) and are stored on `vehicles.notes`. That makes them the "plate notes" admin can search. Only the step 1 free-text box counts as customer notes for the review rule.
23. **Manage tokens sign the appointment root, not a single row.** Change requests create new rows, and the link keeps working throughout. The token expires at the appointment start (a drop-off without a time: the earliest drop-off time) at the time the email was sent.
24. **Turnstile test keys.** Cloudflare's always-pass test keys are used locally and short-circuit server-side. The pre-launch check fails if a test secret is still configured.
25. **`VITE_SHOP_PHONE` build-time fallback.** If the database is down, the page can't load the phone number from settings. The fallback screen uses this build-time value instead. It's the one place the phone exists outside the settings table, by necessity.
26. **`?src=` tracking parameter** (e.g. `?src=postcard` from the QR code) is stored on `bookings.source` so postcard response can be measured.
27. **Local dev uses `scripts/dev-api.ts`** to serve `/api/*` on port 3000 instead of `vercel dev`, so no Vercel project link is needed during the build.
28. **End-to-end tests use Playwright** at a 375px viewport against the running dev servers. They skip when the servers aren't up.

## Phase 4: Admin console

29. **One admin endpoint, `/api/admin/[action]`.** It validates the Supabase JWT server-side, then requires role owner/staff **and** `aal2`. One dynamic route keeps the deployment well under Vercel Hobby's 12-function limit (10 functions total).
30. **Admin drag-to-move** works on the day timeline. Drag a waiter across or between lanes to change the time. Drag one onto the drop-off list to make it a drop-off, or drag a drop-off onto a lane to make it a waiter. A broken rule opens the override confirm. Lanes are a display packing (greedy by start time). The data model has no lane column, matching the spec's "shop sequences them on the floor."
31. **Admin moves email the customer** the new time (with a manage link) by default.
32. **Escalation timing uses shop hours.** "4 business hours" counts only open hours, skipping closures. "1 business day" is the same wall-clock time on the next open day. Escalations run from an hourly `tick` job.
33. **Hourly tick on Vercel Hobby.** Hobby cron runs at most once a day. `vercel.json` schedules only the daily job. The hourly `tick` is triggered by Supabase `pg_cron` + `pg_net` calling `/api/cron/tick` with the cron secret (setup SQL in README). If the project moves to Vercel Pro, the tick can move into `vercel.json`.
34. **Customer merge** moves bookings, vehicles, history, reminder sends, and the email log to the kept record. Opt-outs and flags are OR'd so nobody who opted out on either record gets contacted. The merged record is kept (pointing at the survivor), with its email and phone cleared so it never matches again.
35. **CSV export guards against formula injection.** Cells starting with `= + - @` get a leading `'`. Export is audited.
36. **A new closure does not cancel existing bookings on that date.** The admin is told to check the day view. Silently cancelling customers is worse than a visible conflict.
37. **Admin pages are wired, not mocked.** Approvals (ladder plus auto-confirm rate by week and type), Activity (audit log, reminder sends, emails, job runs), Customers (search by name/phone/email/plate, edit, flags, merge, history), Settings (every shop knob), Export.

## Phase 5: Reminders

38. **Due cycle** means the latest completed date per customer + vehicle + service, plus that service's interval. Each rule step fires at most once per cycle, enforced by a unique index.
39. **Catch-up rule.** If several steps are already past (e.g. on the first run after the Epicor import), only the latest one fires and the earlier ones are logged as `skipped`. Items more than `reminder_max_overdue_days` (365) overdue are ignored, so years-old history doesn't trigger a wave of mail.
40. **"Stop when the customer books"** means any requested, confirmed, or completed booking created after the service date that made them due. Each step's condition (no booking since due / since the previous step) is also checked.
41. **Opt-outs are per channel.** Opting out of email still allows postcards, and vice versa. Bounced email and undeliverable addresses block their channel. A postcard batched before an opt-out is still skipped at send time.
42. **Dry-run rows count as done.** During the cutover, steps logged as `dry_run` are not re-sent after the switch, because Epicor already covered that cycle. Turning dry-run off only affects future steps.
43. **Failed sends retry the next day.** A `failed` step is not "done". Email uses 3 tries with backoff inside a run.
44. **Appointment reminder [48h] runs on the daily job.** It covers confirmed bookings 1 to ceil(48/24) = 2 days out, once each. Moving a booking clears the flag, so the new time is reminded.
45. **Weekly postcard batches.** The daily job adds postcards to the current week's draft batch. Approving a batch verifies each address with the provider first; an undeliverable address flags the customer and skips them. Auto-approve (off by default) sends draft batches from earlier weeks.
46. **Postcard cost** is the `postcard_cost_cents` estimate. Lob's API doesn't return a per-piece price.
47. **Default postcard templates** use type only: shop name, the configurable brand color, QR, phone. No logo or invented branding. Lob's HTML spec: 6.25×4.25in with bleed; the right half of the back is left clear for the address block.
48. **Email provider: Resend. Print provider: Lob.** These are defaults behind the `EmailProvider` and `MailProvider` interfaces. Both run as stubs until keys exist (Open Items: compare current pricing and minimums before launch).

## Phase 6: Import and launch

49. **The Epicor export format is unknown.** The importer reads one CSV where each row is a service record. It maps columns through `import/epicor-mapping.json` (several candidate headers per field) and groups rows by Epicor customer ID, then email, then phone. If Epicor exports separate files, join them first or extend the mapping.
50. **Normalization.** Phones become E.164 (US). Emails are lowercased and trimmed; invalid ones are dropped with a warning. Addresses get USPS-style uppercase and abbreviations, two-letter states, and 5 or 9 digit ZIPs (a 4-digit ZIP regains its leading zero). Names are title-cased.
51. **Rejected:** rows with no name, or with no email, no phone, and no complete address. **Kept with a warning:** bad dates (that history row is dropped) and unmapped service types (history kept, no reminders).
52. **Commit is idempotent per Epicor ID**, so a re-run skips customers already imported. Reports go to `import/private/` (gitignored, since it contains customer data).
53. **Weekly backup** runs inside the daily job on Sundays (shop time). It goes to a private Supabase Storage bucket, AES-256-GCM encrypted, keeping 12 weeks. Restore is a script with a decrypt-only mode and an explicit `--apply --yes`.
54. **Health endpoint** reports only true/false reachability for the DB, email provider, and print provider. An external uptime monitor does the "two failures in a row" alerting. Nothing in the app polls itself.
55. **Pre-launch check** (`npm run prelaunch`) covers: required env vars, secret strength, no test keys, the anon lockdown against the target project, sign-up disabled, the Supabase security advisor (hosted API with `SUPABASE_ACCESS_TOKEN`, or local `supabase db lint`), npm audit, the client-bundle secret scan, live security headers, health, and SPF/DKIM/DMARC records. DMARC pass on a real send is a manual step, because this build never sends real email.
56. **Not done because it needs accounts or money:** creating the hosted Supabase project, the Vercel project, the DNS records, Resend/Lob/Turnstile accounts, and the uptime monitor. All are documented step by step in README → Deploy.
57. **Vercel Hobby is non-commercial.** This is a business site run as a commercial engagement. README flags deploying on Pro or under Art's account.
58. **The "frontend-design" skill wasn't available in this environment.** The UI follows its intent without it: system font stack (no external font requests, which also keeps the CSP tight), a neutral placeholder palette with a single configurable brand color, large tap targets, one decision per screen, visible focus rings, and AA-contrast text.

## Staging (added 2026-11-02)

59. **Staging uses the same code, switched by env vars**, not a separate branch or app: `APP_ENV=staging` (server), `VITE_APP_ENV=staging` (client), `EMAIL_PROVIDER=capture`. Both halves must be set: the client flag only shows the tabs; the server refuses the actions without its own flag. The pre-launch check fails if any of the three is set.
60. **Captured email goes to a database table** (`arts.email_outbox`) rather than the in-memory stub, because serverless functions don't share memory. RLS is the same as every other table (admins read, anon nothing). The table ships to production but stays empty there.
61. **Simulated customers are marked by their email domain** (`@sim.invalid`, a reserved TLD that can never deliver) instead of a new column. Reset deletes only those customers and their rows. Phones are fictional `555-01xx` numbers so they can't collide with real customers in booking matching.
62. **Fast-forward runs one simulated day per request** to stay inside Vercel Hobby's 10s function limit. It runs the daily job at noon and the escalation check at 4:30pm shop time; a real deployment runs the escalation check hourly, so simulated escalations can land a few hours later than they would for real.
63. **"Send reminders anyway" overrides dry-run for the simulation only**; the Settings value is never changed. Without it, a fast-forward logs dry-run rows and sends nothing, exactly like production during cutover.
64. **Simulated booking requests skip Turnstile and rate limits** but otherwise use the same database function and emails as the public form.
65. **Not built yet:** the dummy shop homepage for the staging site, and an `EMAIL_REDIRECT_TO` option for delivering every staging email to one real inbox. Both wait on the account decisions.


## After staging went live (2026-11-03/04)

66. **Customers pick a day and time first, then wait or drop off.** Drop-offs carry a chosen time on the slot grid between the earliest and latest drop-off settings (default 7:30–3:00); staff can still enter a drop-off with no time. `available_slots` returns each time with whether each kind is open and, when not, a coarse reason (full, blocked, past closing, not for this work, outside drop-off hours): rule codes only, never names or counts.
67. **Blocked time** (`arts.time_blocks`, one date or a weekly weekday) keeps online bookings out of that span (a waiter's whole job; a drop-off's start) and its minutes, merged when blocks overlap, come off the day's capacity.
68. **Reminder sends are claimed before they go out** (`reminder_sends.status = 'queued'`, `claimed_at`), and every provider call has an idempotency key, so overlapping or retried runs can't double-send. Jobs stop at a 7-second budget (Vercel Hobby's 10s limit) and the hourly tick finishes unfinished daily work during shop hours. Lists page past PostgREST's 1,000-row cap.
69. **Dry-run and "no email on file" skips don't count as done**, so they fire for real once that changes; a step skipped because a later one superseded it does count.
70. **Bounces and spam complaints** arrive by a Svix-signed Resend webhook (`/api/webhooks/resend`) and set `email_bounced` / `email_opt_out`. One-click unsubscribe (RFC 8058) posts to `/api/unsubscribe?t=`.
71. **Epicor import is re-runnable**: `arts.import_customer` writes one customer per transaction, matching by Epicor id, then email, then phone when the last names agree (a household sharing a number and surname is treated as one customer).
72. **Customer merge is one transaction and undoable** (`arts.customer_merges` records what moved). "Forget this customer" anonymizes rather than deletes, so past bookings and capacity history stay correct; its audit entry holds only the id.
73. **Owner-only screens**: Team (invite, role, reset authenticator, remove; the last owner can't be removed) and the launch Checklist (`arts.audit_items`, loaded by `scripts/audit-sync.ts`, rerun with the `/audit` Claude Code command). Security hardening is deliberately deferred to a later audit pass, after the build is functionally complete.
