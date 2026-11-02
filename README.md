# Art's Service Center: Booking & Reminders

One web app that replaces Epicor Service CRM and the scheduler the shop never bought. It handles:

- **Online booking** at `book.artsservicecenter.com`: four steps, no account, phone-first.
- **Approval workflow** for Chris. Every appointment type starts at "approve each one". The system suggests when a type has earned auto-confirm, and Chris clicks.
- **Reminders**: service-due emails and postcards, plus appointment reminders.
- **Admin** at `/admin`: day view, phone bookings, customers, settings, postcards, activity, and export.

NAPA TRACS stays the repair-order system. This app is the calendar of record for appointments.

See `DECISIONS.md` for every judgment call made during the build.

---

## Contents

1. [How it fits together](#how-it-fits-together)
2. [Local development](#local-development)
3. [Tests](#tests)
4. [Staging (Outbox and Simulator)](#staging-outbox-and-simulator)
5. [Deploy (first time)](#deploy-first-time)
6. [Add or remove an admin user](#add-or-remove-an-admin-user)
7. [Rotate keys](#rotate-keys)
8. [Backups and restore](#backups-and-restore)
9. [Epicor import and cutover](#epicor-import-and-cutover)
10. [Routine tasks (Chris)](#routine-tasks-chris)
11. [When something breaks](#when-something-breaks)
12. [Launch checklist](#launch-checklist)

---

## How it fits together

| Layer | What | Where |
|---|---|---|
| Frontend | React + Vite + TypeScript | `src/public` (booking, manage link, unsubscribe), `src/admin` |
| Server | Vercel functions, the only code holding the service key | `api/` (thin routes) → `server/` (logic) |
| Database | Supabase Postgres, everything in the `arts` schema | `supabase/migrations` |
| Scheduling rules | Postgres functions (`arts.check_booking`, `arts.create_booking` with an advisory lock) | `20261029000002_scheduling.sql` |
| Email | `EmailProvider` interface: Resend, or a stub that sends nothing | `server/email` |
| Postcards | `MailProvider` interface: Lob, or a stub | `server/mail`, `server/postcard.ts` |
| Jobs | `/api/cron/daily` (Vercel Cron), `/api/cron/tick` hourly (Supabase pg_cron) | `server/reminders.ts`, `server/jobs.ts` |

**Endpoints**

- Public: `availability`, `book`, `cancel`, `reschedule`, `change-services`. The last three need a signed manage token.
- Token-gated: `manage` (a read-only view) and `unsubscribe`.
- Admin: `admin/[action]` requires a Supabase session with role owner/staff **and** MFA.
- Ops: `cron/[job]` (requires the cron secret) and `health`.

**Security model in one paragraph.** The `anon` key can't touch any table or function: there are no grants, and RLS is forced on every table. Admins read through RLS policies that require `app_metadata.role ∈ {owner, staff}` and `aal2` (TOTP verified). Every write goes through the server, which writes the audit log. Customer free text is stored and displayed as plain text only. The CI build fails if any server secret appears in the client bundle.

---

## Local development

Requires Docker, Node 20+, and the Supabase CLI.

```bash
npm install
supabase start                    # local Postgres/Auth/Storage on ports 554xx
node scripts/write-local-env.mjs  # writes .env.local with local keys + provider test keys
npm run dev:api                   # serves /api/* on :3000 (stand-in for `vercel dev`)
npm run dev                       # Vite on :5173, proxies /api to :3000
```

- Booking: http://localhost:5173
- Admin: http://localhost:5173/admin. Create a local admin with `npm run admin:add -- --email you@example.com --role owner`, then open the invite in Mailpit at http://127.0.0.1:55424.
- Studio: http://127.0.0.1:55423

Email and postcards use the **stub** providers locally: nothing is delivered, and sends are logged to the console and to `arts.email_log`. Turnstile uses Cloudflare's always-pass test keys.

`supabase db reset` rebuilds the database from the migrations plus `supabase/seed.sql`. The seed contains **placeholder** appointment types and a fake shop phone.

---

## Tests

```bash
npm test                 # everything (needs `supabase start`; e2e needs dev servers, otherwise skipped)
npm run test:unit        # pure logic: import, secret scanner
npm run test:db          # rules, booking lock, public flows, admin, reminders, backups (local DB)
npx vitest run tests/e2e # Playwright: full booking at 375px, admin with real TOTP
```

| Phase | Tests |
|---|---|
| 1 Foundation | `tests/db/phase1-lockdown.test.ts`: anon can't read, write or call anything; RLS forced; sign-up off; MFA required |
| 2 Scheduling | `tests/db/phase2-scheduling.test.ts`: every wait/drop-off rule, every auto-confirm condition, 20 parallel requests |
| 3 Public booking | `tests/db/phase3-public.test.ts`, `tests/e2e/phase3-booking.test.ts` |
| 4 Admin | `tests/db/phase4-admin.test.ts`, `tests/e2e/phase4-admin.test.ts` |
| 5 Reminders | `tests/db/phase5-reminders.test.ts` |
| 6 Ops | `tests/unit/import.test.ts`, `tests/db/phase6-*.test.ts`, `tests/unit/secret-scan.test.ts` |
| Staging | `tests/db/staging.test.ts`, `tests/e2e/staging.test.ts` (runs only against a staging build) |

CI (`.github/workflows/ci.yml`) runs typecheck, audit, unit and DB tests, and the build on every push and PR. Dependabot opens weekly update PRs, which must pass CI.

---

## Staging (Outbox and Simulator)

A staging copy (planned: `arts.jvtestspace.com`) runs the same code with three switches:

| Variable | Value | Effect |
|---|---|---|
| `APP_ENV` | `staging` | Server accepts the Outbox and Simulator admin actions. Without it they return 404. |
| `EMAIL_PROVIDER` | `capture` | Every email is saved to `arts.email_outbox` instead of being sent. |
| `VITE_APP_ENV` | `staging` | Build shows a red TEST SITE bar, adds `noindex`, and adds the **Outbox** and **Simulator** admin tabs. |

Use Turnstile test keys and `MAIL_PROVIDER=stub` (or a Lob `test_` key, which renders postcards in Lob's dashboard without mailing). **Never set any of these three in production.** `npm run prelaunch` fails if they are.

Run it locally:

```bash
npm run staging:api    # instead of dev:api
npm run staging:web    # instead of dev
```

**Outbox** lists every captured email, newest first, with a filter. Click one to see it as the recipient would (HTML or plain text). Emails made by a fast-forward are labeled with the simulated date.

**Simulator**:

1. **Add customers.** Fake customers with vehicles and past service, as if imported from Epicor. Their due dates fall between 60 days ago and about 75 days ahead. All of them use `@sim.invalid` email addresses (a domain that can never receive mail) and fictional `555-01xx` phone numbers.
2. **Add requests.** Booking requests placed through the same database function and emails as the public form (Turnstile and rate limits skipped). Approve or decline them in Approvals.
3. **Fast-forward.** Runs the daily job and the escalation check for each day, as if that day had arrived. Dry-run stays on in Settings; the "Send reminders anyway" box overrides it for the simulation only. The first simulated day sends a burst: as in a real first run after the import, overdue customers get only their latest reminder step and the earlier steps are logged as skipped.
4. **Reset simulated data** deletes every `@sim.invalid` customer and everything attached to them. Other customers are untouched. **Clear outbox** empties the Outbox.

Reminders already sent are recorded, so fast-forwarding the same days twice doesn't send twice. To start over, reset and clear.

---

## Deploy (first time)

### 1. Supabase

Pick a project (an open item: a dedicated paid project is recommended; the fallback is the `arts` schema in the Acuity project). **It must be on a plan that doesn't pause on inactivity** and that has daily backups.

```bash
supabase link --project-ref <ref>
supabase db push                     # applies supabase/migrations (does NOT run seed.sql)
```

In the dashboard:

- **Auth → Providers → Email**: keep enabled. **Auth → Settings**: turn off "Allow new users to sign up".
- **Auth → MFA**: enable TOTP (App Authenticator).
- **Auth → Sessions**: time-box sessions to 12 hours (Pro plan). The admin UI also enforces this.
- **Auth → URL configuration**: Site URL `https://book.artsservicecenter.com`; redirect URL `https://book.artsservicecenter.com/admin`.
- **Auth → SMTP**: point at Resend so invite and reset emails come from the shop domain.
- **API → Exposed schemas**: add `arts`. It's safe: anon has no grants.
- **Advisors → Security**: should be clean (`npm run prelaunch` also checks).

**Hourly tick** (escalations). Vercel Hobby cron runs only daily, so the tick runs from the database. In the SQL editor, enable the `pg_cron` and `pg_net` extensions, then run:

```sql
select cron.schedule('arts-tick', '5 * * * *', $$
  select net.http_post(
    url := 'https://book.artsservicecenter.com/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  )
$$);
```

### 2. Vercel

Create a project from this repo (framework: Vite). Set the environment variables listed in `.env.example` for Production:

| Variable | Value |
|---|---|
| `SUPABASE_URL`, `VITE_SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (**server only**) |
| `VITE_SUPABASE_ANON_KEY` | anon/publishable key |
| `APP_URL` | `https://book.artsservicecenter.com` |
| `TOKEN_SECRET`, `CRON_SECRET` | `openssl rand -hex 32` each |
| `BACKUP_ENCRYPTION_KEY` | `openssl rand -hex 32`. **Store a copy in the password manager**, because backups can't be read without it. |
| `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY` | from Cloudflare Turnstile (widget for `book.artsservicecenter.com`) |
| `EMAIL_PROVIDER`, `RESEND_API_KEY` | `resend`, key |
| `MAIL_PROVIDER`, `LOB_API_KEY` | `lob`, `test_…` until launch, then `live_…` |
| `VITE_SHOP_PHONE` | shop phone (fallback when the DB is unreachable) |

`vercel.json` sets the security headers (CSP, HSTS, frame denial), the SPA rewrite, and the daily cron (13:00 UTC). The CSP allows `https://*.supabase.co`; if the database is on a custom domain, add it to `connect-src`.

> **Plan note:** Vercel Hobby is for non-commercial use, and this is a business site run as a commercial engagement. Deploy it on a Pro team, or under Art's own account, before launch.

### 3. DNS (Jake controls DNS)

| Record | Name | Value |
|---|---|---|
| CNAME | `book` | `cname.vercel-dns.com` (add the domain in Vercel first) |
| TXT (SPF) | `@` or the Resend sending subdomain | as shown by Resend; merge with any existing `v=spf1` record, since there can only be one |
| TXT (DKIM) | `resend._domainkey` | as shown by Resend |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<jake>`. Move to `p=quarantine` after two clean weeks. |

### 4. Monitoring

Point a free uptime monitor (Better Stack or UptimeRobot) at `https://book.artsservicecenter.com/api/health` every 5 minutes. Set it to alert Jake's email **after 2 consecutive failures**. The app itself emails Jake when the daily job fails or when sends fail above the threshold in Settings.

### 5. Verify

```bash
vercel env pull .env.production.local
npm run prelaunch -- --env .env.production.local
```

Then send one real booking to a Gmail address you control. In Gmail use "Show original" and confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.

### Later deploys

Push to `main`. Vercel builds; the build fails if a secret leaks into the bundle. For migrations, run `supabase db push` **before** pushing code that depends on them.

---

## Add or remove an admin user

**Add** (invite-only):

```bash
# with production env vars loaded (vercel env pull .env.production.local, then copy to .env.local temporarily or export them)
npm run admin:add -- --email chris@artsservicecenter.com --role staff --name Chris
npm run admin:add -- --email jake@... --role owner --name Jake
```

The person gets an email, sets a password, and on first sign-in must scan a QR code with an authenticator app. There's no way to use admin without it.

**Remove**: Supabase dashboard → Authentication → Users → the user → Delete. Their past actions stay in the audit log.

**Lost phone / reset MFA**: dashboard → Authentication → Users → the user → remove the MFA factor. They'll enroll a new one at next sign-in.

---

## Rotate keys

Rotate any key immediately if it might have leaked. Every key lives only in Vercel environment variables, plus the local `.env.local` for development. After changing a Vercel variable, **redeploy**.

| Key | How | Side effects |
|---|---|---|
| Supabase service role / anon | Dashboard → Settings → API keys: create new keys, update Vercel, redeploy, then revoke the old ones | none |
| `TOKEN_SECRET` | new random value | every outstanding manage and unsubscribe link stops working. Customers can still call. Avoid unless needed. |
| `CRON_SECRET` | new random value; **also** re-run the `cron.schedule` SQL above with the new value | none |
| `RESEND_API_KEY` | Resend → API keys: create new, update Vercel, delete old | none |
| `LOB_API_KEY` | Lob dashboard → API keys: roll | none |
| Turnstile | Cloudflare → Turnstile → rotate secret | none |
| `BACKUP_ENCRYPTION_KEY` | new random value | **old backups still need the old key.** Keep old keys in the password manager, labeled with dates. |

---

## Backups and restore

- **Daily**: Supabase's own backups on the hosting plan (dashboard → Database → Backups).
- **Weekly**: every Sunday the daily job writes an AES-256-GCM encrypted, gzipped export of every `arts` table to the private Storage bucket `backups`, and keeps 12 weeks. Never emailed.

**Restore**:

```bash
npm run backup:restore -- --list                       # what's in the bucket
npm run backup:restore -- --name arts-2026-11-01.bak   # decrypt to backups/*.json; inspect, nothing changes
npm run backup:restore -- --name arts-2026-11-01.bak --apply --yes   # REPLACE all arts data in DATABASE_URL
```

`--apply` runs in one transaction. Point `DATABASE_URL` at the target database (Supabase → Connect → direct connection string). Practice on a staging project or locally first. For a point-in-time restore, use the Supabase dashboard instead.

---

## Epicor import and cutover

1. Get the Epicor export (customers, vehicles, service history) as CSV. Put it in `import/private/` (gitignored).
2. Edit `import/epicor-mapping.json` so each of our fields lists the Epicor column header. Map Epicor service codes to our appointment types, either in the `services` block or in Settings → Appointment types → "Epicor codes".
3. **Dry run** (changes nothing):
   ```bash
   npm run import:epicor -- --file import/private/epicor.csv
   ```
   It writes `import/private/reports/<time>/report.md` (counts, rejected rows with reasons, likely duplicates, unmapped service types, warnings), plus `customers.csv` and `rejected.csv`. Review them with the shop.
4. **Commit**: `npm run import:epicor -- --file import/private/epicor.csv --commit`. Opt-outs carry over. Re-running skips customers whose Epicor ID already exists.
5. Merge flagged duplicates in Admin → Customers.
6. **Cutover**: Settings → "Service reminders in dry-run mode" is **on** by default. For the agreed 2–4 weeks the new system takes bookings while Epicor keeps sending reminders. The daily job only logs what it *would* send (Activity → Reminders), so customers never get both. Then turn dry-run off and turn Epicor off. Check Epicor's notice terms before choosing the date.

---

## Routine tasks (Chris)

Everything here is in Admin, with no code and no Jake.

| Task | Where |
|---|---|
| Approve, propose a new time, or decline requests | **Day** (top of page) |
| Undo an auto-confirmed booking (within the undo window) | Day → "auto-confirmed bookings you can still undo", or the Undo button in the email |
| Move a booking | Day → drag it, or click → Move |
| Mark completed, no-show, or cancelled | Day → click the booking. **Completed drives the next reminder.** |
| Take a phone booking | **Phone booking** |
| Close the shop for a holiday | Settings → Closures |
| Change hours, lanes, drop-off window/share | Settings |
| Add or edit appointment types (duration, caps, lead days, reminder interval) | Settings → Appointment types |
| Move a type up or down the approval ladder | **Approvals** |
| Approve the weekly postcard batch | **Postcards** |
| Flag a customer to always review (e.g. after no-shows) | Customers → the customer |
| Opt a customer out | Customers → the customer (or they use the email link) |
| Download the data | **Export** |
| See who changed what | **Activity** |

---

## When something breaks

Jake is emailed when the daily job fails, when send failures pass the threshold, or (via the uptime monitor) when health fails twice.

| Symptom | Check |
|---|---|
| Customers see "Call us at … to book" | `/api/health`, Vercel function logs, Supabase status |
| Job failure email | Admin → Activity → Scheduled jobs shows the error. Re-run with `curl -H "Authorization: Bearer $CRON_SECRET" https://book.artsservicecenter.com/api/cron/daily` (safe to re-run: every send is idempotent) |
| Requests not escalating | `select * from cron.job_run_details order by start_time desc limit 5;` in the SQL editor |
| Emails not arriving | Admin → Activity → Emails; Resend dashboard; DNS records |
| Postcard batch shows "undeliverable" | The address failed Lob verification and the customer is flagged. Fix the address in Customers and clear the flag. |

---

## Launch checklist

Launch is blocked on the Open Items in the spec. In code terms:

- [ ] Real appointment types, durations, caps, intervals, hours, lanes, and drop-off window/share entered in Settings
- [ ] Shop phone and address in Settings (the address must look like `123 Main St, Town, PA 18000` for postcards) and in `VITE_SHOP_PHONE`
- [ ] Brand: logo URL and brand color in Settings; postcard template reviewed in Admin → Postcards
- [ ] Chris invited (`admin:add`), and MFA enrolled for Chris and Jake
- [ ] Supabase project chosen, migrations pushed, auth settings above, pg_cron tick scheduled
- [ ] Vercel on a plan that allows commercial use; env vars set; domain live
- [ ] Resend domain verified; Lob live key; Turnstile real keys
- [ ] `npm run prelaunch -- --env .env.production.local` all PASS; one real send shows DMARC pass
- [ ] Epicor import committed and duplicates merged; dry-run reminders reviewed during cutover
- [ ] Uptime monitor alerting Jake after 2 failures
- [ ] One-page agreement with Art signed (data ownership, support scope, costs, exit plan)
