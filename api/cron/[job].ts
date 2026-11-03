import { timingSafeEqual } from 'node:crypto';
import { endpoint, query, HttpError } from '../../server/http.js';
import { env } from '../../server/env.js';
import type { ShopSettings } from '../../server/db.js';
import { runJob, tick } from '../../server/jobs.js';
import { continueDaily, daily, JOB_BUDGET_MS } from '../../server/reminders.js';
import { runBackup } from '../../server/backup.js';
import { localParts } from '../../shared/time.js';

// Each run stops sending before Vercel's 10-second limit; whatever is left is
// picked up by the next hourly tick (see continueDaily).
const dailyJob = (s: ShopSettings) => daily(s, new Date(), Date.now() + JOB_BUDGET_MS);

// Hourly: chase unanswered requests, finish an unfinished daily run, and at
// 3am on Sundays (shop time) take the weekly encrypted backup in its own run.
async function tickJob(s: ShopSettings) {
  const deadline = Date.now() + JOB_BUDGET_MS;
  const now = new Date();
  const local = localParts(now, s.timezone);
  if (local.isoDow === 7 && local.minutes >= 180 && local.minutes < 240) return { ...(await runBackup()), backup: true };
  return { ...(await tick(s, now)), ...(await continueDaily(s, now, deadline)) };
}

const JOBS = { tick: tickJob, daily: dailyJob, backup: () => runBackup() } as const;

// Vercel Cron (and pg_cron for the hourly tick) send `Authorization: Bearer $CRON_SECRET`.
export default endpoint(['GET', 'POST'], async (req) => {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${env.cronSecret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, { error: 'unauthorized' });
  const name = query(req, 'job') as keyof typeof JOBS;
  if (!(name in JOBS)) throw new HttpError(404, { error: 'unknown_job' });
  const r = await runJob(name, (s) => JOBS[name](s));
  return { status: r.ok ? 200 : 500, body: r };
});
