import { endpoint } from '../server/http.js';
import { db } from '../server/db.js';
import { emailProvider } from '../server/email/provider.js';
import { mailProvider } from '../server/mail/provider.js';

async function check(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await Promise.race([fn(), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
  } catch {
    return false;
  }
}

// Scheduled jobs are running: the hourly tick finished within 2 hours and the
// daily job within 26. A job that has never run (a fresh install) counts as fine.
const FRESH_HOURS: Record<string, number> = { tick: 2, daily: 26 };

async function jobsFresh(): Promise<boolean> {
  for (const [job, hours] of Object.entries(FRESH_HOURS)) {
    const { data: any } = await db().from('job_runs').select('id').eq('job', job).limit(1);
    if (!any?.length) continue;
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const { data: ok } = await db().from('job_runs').select('id').eq('job', job).eq('status', 'ok').gte('started_at', since).limit(1);
    if (!ok?.length) return false;
  }
  return true;
}

// Watched by the uptime monitor. Reports reachability only: no data.
export default endpoint(['GET', 'HEAD'], async () => {
  const [database, email, mail, jobs] = await Promise.all([
    check(async () => !(await db().from('shop_settings').select('id').eq('id', 1).single()).error),
    check(() => emailProvider().ping()),
    check(() => mailProvider().ping()),
    check(jobsFresh),
  ]);
  const ok = database && email && mail && jobs;
  return { status: ok ? 200 : 503, body: { ok, database, email, mail, jobs } };
});
