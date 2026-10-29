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
