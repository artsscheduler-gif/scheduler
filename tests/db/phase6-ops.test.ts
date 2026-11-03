import { describe, it, expect, afterAll } from 'vitest';
import { sql } from './helpers';
import cron from '../../api/cron/[job]';
import health from '../../api/health';

afterAll(() => sql.end());

function run(handler: any, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 0;
    const res: any = { setHeader() {}, set statusCode(v: number) { status = v; }, end(s: string) { resolve({ status, body: JSON.parse(s) }); } };
    handler({ headers: {}, method: 'GET', ...req }, res);
  });
}

describe('Operations endpoints', () => {
  it('cron routes require the cron secret', async () => {
    expect((await run(cron, { url: '/api/cron/tick', query: { job: 'tick' } })).status).toBe(401);
    expect((await run(cron, { url: '/api/cron/tick', query: { job: 'tick' }, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await run(cron, { url: '/api/cron/tick', query: { job: 'tick' }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(ok.status).toBe(200);
    const [row] = await sql`select job, status from arts.job_runs order by started_at desc limit 1`;
    expect(row).toEqual({ job: 'tick', status: 'ok' });
  });

  it('health reports reachability only', async () => {
    const r = await run(health, { url: '/api/health' });
    expect(r).toEqual({ status: 200, body: { ok: true, database: true, email: true, mail: true, jobs: true } });
  });

  it('health fails when a scheduled job has stopped running', async () => {
    await sql`delete from arts.job_runs`;
    await sql`insert into arts.job_runs (job, status, started_at) values ('tick', 'ok', now() - interval '5 hours')`;
    const r = await run(health, { url: '/api/health' });
    expect(r).toMatchObject({ status: 503, body: { ok: false, jobs: false } });
    await sql`insert into arts.job_runs (job, status) values ('tick', 'ok')`;
    expect((await run(health, { url: '/api/health' })).status).toBe(200);
  });
});
