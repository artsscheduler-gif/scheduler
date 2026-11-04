---
name: audit
description: Re-run the full code and launch-readiness audit of the Art's Servicenter app and update the admin Launch checklist. Use when Jake says /audit, "rerun the audit", or asks to refresh the checklist.
---

# Rerun the audit

Goal: a fresh, verified list of gaps, merged into the owner-only **Checklist** tab
(`arts.audit_items`) without touching Jake's ticks or notes.

## 1. Load the current checklist

```
npx tsx scripts/audit-sync.ts dump > audit/current.json
```

Default target is staging (`.env.staging.local`). Add `--env .env.local` for the local database.
`audit/` is gitignored: the repo is public, and findings must never be committed.

## 2. Run four read-only reviewers in parallel

Spawn four `general-purpose` agents in one message. Each brief must say: READ-ONLY (no edits,
no deploys, no external calls, don't open `.env*` other than `.env.example` or any `.rtf`, don't
run the test suite), report a ranked list with file:line, a one-sentence defect, a concrete
failure scenario, and VERIFIED or SUSPECTED, under ~900 words, no style nits.

1. **Public booking + scheduling engine**: `src/public/*`, `server/{public,bookings,validate,tokens}.ts`,
   `shared/*`, and the LATEST definitions of `check_booking`, `available_slots`, `available_slot_days`,
   `create_booking`, `decide_booking`, `move_booking` across `supabase/migrations/*`.
   Edge cases: timezone/DST, cutoffs, closures vs time blocks, drop-off times, manage-link flows.
2. **Admin console + auth**: `src/admin/*`, `server/{admin,simulator,http}.ts`, RLS in migrations.
   Owner-vs-staff powers, server-side session/MFA enforcement, destructive actions without
   confirmation, swallowed errors, iPad use at the shop, missing day-to-day features.
3. **Jobs, messaging, import, backups**: `server/{reminders,jobs,backup,ics,import,postcard,retry}.ts`,
   `server/email/*`, `server/mail/*`, `api/cron/*`, `api/health.ts`, `scripts/*`. Vercel Hobby 10s limit,
   idempotency, unsubscribe/bounces, dry-run cutover, Epicor import robustness, backup/restore, alerting.
4. **Security + ops + docs**: `vercel.json`, `index.html`, `api/*`, `server/{env,http,turnstile}.ts`,
   migrations (grants, RLS on every table), `scripts/prelaunch-check.ts`, README/DECISIONS/SETUP_*.
   Public-repo exposure, rate limits, staging features reachable in production, production setup
   still missing, out-of-date docs.

Include in each brief the item titles from `audit/current.json` for its area, and ask the reviewer
to say for each one whether it is **still present** or **fixed** (with the code that shows it).

## 3. Verify before listing

Read the code yourself for every `now` / `before-launch` finding and for every item a reviewer
calls fixed. Drop anything you can't confirm. Launch-setup items Jake owns (accounts, keys, DNS,
plans) stay listed until the evidence shows them done (for example DNS records, Vercel env names,
the hosted Supabase plan). Never mark something fixed on a reviewer's word alone.

## 4. Write the run file

`audit/run-YYYY-MM-DD.json`:

```json
{ "summary": "one line", "findings": [ { "key": "", "section": "", "sort": 0, "title": "", "detail": "", "priority": "now|before-launch|soon|later", "owner": "jake|claude|both" } ], "fixed": ["key"] }
```

- Reuse the existing `key` (and its section/sort) for any finding that matches a current item,
  even if the wording changes. New problems get a new kebab-case key and a sort inside their section.
- `findings` = everything still present (including Jake's open launch tasks). `fixed` = keys you
  verified are gone. Anything in neither list is recorded as "not found this time".
- Titles are plain English for Jake; put file:line and the scenario in `detail`.

## 5. Load it and report

```
npx tsx scripts/audit-sync.ts apply audit/run-YYYY-MM-DD.json
```

Then tell Jake: how many findings, what's new, what's verified fixed, and the top three to do
next, with a link to https://arts.jvtestspace.com/admin/settings/checklist.

## Keeping the checklist current between audits

Whenever you fix a checklist item (tests pass, deployed to staging), tick it right away:

```
npx tsx scripts/audit-sync.ts done <key> [<key>...] --note "Fixed in <commit>, deployed to staging."
```

Jake reads the Checklist tab to see progress, so an unticked fix looks like no progress.
Items Jake owns (accounts, keys, DNS, decisions) are his to tick.
