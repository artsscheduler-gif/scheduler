import { timingSafeEqual } from 'node:crypto';
import { endpoint, query, HttpError } from '../../server/http.js';
import { env } from '../../server/env.js';
import { runJob, tick } from '../../server/jobs.js';
import { daily } from '../../server/reminders.js';

const JOBS = { tick, daily } as const;

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
export default endpoint(['GET', 'POST'], async (req) => {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${env.cronSecret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, { error: 'unauthorized' });
  const name = query(req, 'job') as keyof typeof JOBS;
  if (!(name in JOBS)) throw new HttpError(404, { error: 'unknown_job' });
  const r = await runJob(name, (s) => JOBS[name](s));
  return { status: r.ok ? 200 : 500, body: r };
});
