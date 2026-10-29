import { timingSafeEqual } from 'node:crypto';
import { endpoint, query, HttpError } from '../../server/http.js';
import { env } from '../../server/env.js';
import type { ShopSettings } from '../../server/db.js';
import { runJob, tick } from '../../server/jobs.js';
import { daily } from '../../server/reminders.js';
import { runBackup } from '../../server/backup.js';
import { localParts } from '../../shared/time.js';

// Daily run; on Sundays (shop time) it also takes the weekly encrypted backup.
async function dailyJob(s: ShopSettings) {
  const summary = await daily(s);
  if (localParts(new Date(), s.timezone).isoDow === 7) Object.assign(summary, await runBackup());
  return summary;
}

const JOBS = { tick, daily: dailyJob, backup: () => runBackup() } as const;

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
