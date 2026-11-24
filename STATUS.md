# Status
Last updated: 2026-11-24

## Live
- Staging: https://arts.jvtestspace.com (HTTP 200). Also https://arts-staging.vercel.app (HTTP 200).
- Vercel project `arts-staging` is on a separate Vercel account. This Mac's CLI cannot read it.
- Supabase staging project ref `fdblmusczradtqpagowh` (separate Supabase account). Everything is in the `arts` schema.
- Works on staging: booking, approvals, manage links, reminders to the Outbox, admin, Simulator, Test lab. Smoke test 15 passed, 0 failed, 1 skipped (SETUP_REPORT.md).
- Production `book.artsservicecenter.com` is not live. The domain is not registered yet.
- Last commit 2026-11-20: `9c3105c` re-import lands on the same customer.

## Done this session
- Backfilled this STATUS.md from the code, README, git log and specs (no code changes).

## Open
- The source of truth is the owner-only Checklist tab in the admin (table `arts.audit_items`, synced by `scripts/audit-sync.ts`). Read it with `npx tsx scripts/audit-sync.ts dump`.
- As of today: 28 items, 2 done, 26 open (14 Jake, 7 both, 5 Claude).
- Claude items: health check is open and calls Resend/Lob on every hit; tighten CSP; add "Forgot password?"; backup gaps; point the hourly pg_cron job at the production URL.
- Security items wait until the build is functionally complete (DECISIONS.md #73).
- README "Launch checklist" lists the code-side launch steps.
- Untracked files `.DS_Store` and `11157logo.png` are in the repo root (left alone).

## Decisions pending (Jake)
- Spec Open Items block the production launch. The spec file is not in this repo.
- Paid Supabase plan, and Vercel Pro or Art's own Vercel account (Hobby is non-commercial).
- Register artsservicecenter.com; verify it in Resend; real Turnstile keys; PostGrid live key.
- Rotate keys pasted into chat; new TOKEN_SECRET and BACKUP_ENCRYPTION_KEY.
- Invite Chris; confirm the NAPA TRACS export format; sign the agreement with Art.
- Plan the MechanicNet disconnect and a monthly TRACS export routine.
