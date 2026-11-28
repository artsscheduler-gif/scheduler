# Status
Last updated: 2026-11-27

## Live
- Staging: https://arts.jvtestspace.com (HTTP 200). Also https://arts-staging.vercel.app (HTTP 200).
- Vercel project `arts-staging` is on a separate Vercel account. This Mac's CLI cannot read it.
- Supabase staging project ref `fdblmusczradtqpagowh` (separate Supabase account). Everything is in the `arts` schema.
- Works on staging: booking, approvals, manage links, reminders to the Outbox, admin, Simulator, Test lab. Smoke test 15 passed, 0 failed, 1 skipped (SETUP_REPORT.md).
- Production `book.artsservicecenter.com` is not live. The domain is not registered yet.
- Last commit 2026-11-20: `9c3105c` re-import lands on the same customer.

## Done this session
- Demo with Chris on 2026-11-27 went well. Physical mailers matter most to the shop: a Christmas card and scheduled service reminders.
- Loaded the real NAPA TRACS customer export into staging (file kept in gitignored `import/private/`). New default mapping `import/tracs-customers-mapping.json`. Counts and findings are in MAILING.md (local only, repo is public).
- The import now keeps household members who share an email or phone as separate people.
- Real logo from the shop's vector PDF: `public/logo.png` (web), `public/logo-print.png` (postcards), source in `brand/`. Deployed 2026-11-27.
- Draft Christmas and scheduled-service postcards: `brand/mockups/sheet.png`.
- "Something else" now requires a description (booking page, change-services page, and server). It still goes to Chris for approval like every booking, which matches today's request-and-approve flow on the current site. Per-service toggle in Settings. Deployed and verified on staging 2026-11-27.
- Staging migrations 000023 (import address tiebreak, never applied before) and 20261127000001 applied with `supabase db push`.
- Made-up cars on staging: 2,250 cars for the TRACS customers, notes "TEST DATA: made-up car". The imported last visits are linked to a car with a made-up mileage, about 1 in 6 low-mileage on purpose. Remove with `APP_ENV=staging npx tsx scripts/dummy-cars.ts --remove`.
- Local only: `phase4-admin` checklist-tick and `phase6-backup` restore tests fail on this Mac with or without today's changes (leftover row, local storage). CI is green.

## Open
- The source of truth is the owner-only Checklist tab in the admin (table `arts.audit_items`, synced by `scripts/audit-sync.ts`). Read it with `npx tsx scripts/audit-sync.ts dump`.
- As of today: 28 items, 2 done, 26 open (14 Jake, 7 both, 5 Claude).
- Claude items: health check is open and calls Resend/Lob on every hit; tighten CSP; add "Forgot password?"; backup gaps; point the hourly pg_cron job at the production URL.
- Security items wait until the build is functionally complete (DECISIONS.md #73).
- README "Launch checklist" lists the code-side launch steps.
- Untracked in the repo root: `.DS_Store`, `11157logo.png`, `good logo.pdf` (copied to `brand/`), DEMO.md, MAILING.md. MAILING.md stays out of git on purpose.
- Mailing: the app only mails reminder postcards. A Christmas card needs a "one-off mailing" in the Postcards tab. See MAILING.md.
- The TRACS customer export has no vehicles, service types, or mileage. Imported visits have no service type, so no reminders fire from them yet.
- Low-mileage customers get inaccurate time-based reminders (Chris, 2026-11-27). Parked. Needs mileage data.
- The Simulator's "Reset test site" wipes every customer, TRACS ones too. Re-run the import with staging env afterward.
- Staging now holds real customer contact details. The shared test login should get a stronger password or be removed.

## Decisions pending (Jake)
- Mailing (MAILING.md): Christmas this year or next; who gets it; scheduled-service card from last visit only, or wait for vehicle and service data; who pays PostGrid.
- Ask Chris: can TRACS export vehicles and repair orders with mileage, or a "next service due" date?
- Set Chris's password (artssvc@gmail.com, owner). Checked 2026-11-27: the 11-25 invite was never accepted and he has never signed in. Jake chose to assign a password instead of resending the invite. The command is in the 2026-11-27 session notes and in the README section below.
- Demo sign-in: have a working owner login on the presenting laptop before Friday.
- Spec Open Items block the production launch. The spec file is not in this repo.
- Paid Supabase plan, and Vercel Pro or Art's own Vercel account (Hobby is non-commercial).
- Register artsservicecenter.com; verify it in Resend; real Turnstile keys; PostGrid live key.
- Rotate keys pasted into chat; new TOKEN_SECRET and BACKUP_ENCRYPTION_KEY.
- Invite Chris; confirm the NAPA TRACS export format; sign the agreement with Art.
- Plan the MechanicNet disconnect and a monthly TRACS export routine.
