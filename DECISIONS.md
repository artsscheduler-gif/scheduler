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
23. **Manage tokens sign the appointment root, not a single row.** Change requests create new rows, and the link keeps working throughout. The token expires at the appointment start (drop-offs: the start of the drop-off window) at the time the email was sent.
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
