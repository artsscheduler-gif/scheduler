// Reminder rework: paging, claim-before-send, time budget, dry-run carry-over,
// escalation retries, one-click unsubscribe, bounce webhook, stale runs.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { sql, resetData, serviceId } from './helpers';
import { daily, planServiceReminders, runServiceReminders, today, continueDaily } from '../../server/reminders';
import { runJob, tick } from '../../server/jobs';
import { getSettings } from '../../server/db';
import { StubEmailProvider, setEmailProvider } from '../../server/email/provider';
import { handleResendWebhook, verifySvix } from '../../server/email/webhook';
import { oneClickUnsubscribeUrl } from '../../server/tokens';
import unsubscribe from '../../api/unsubscribe';

afterAll(() => sql.end());

let oil: string;

async function dueCustomer(label: string, dueInDays: number, extra: Record<string, unknown> = {}) {
  const [c] = await sql`insert into arts.customers ${sql({ name: `${label} Person`, email: `${label.toLowerCase()}@example.com`, source: 'import', ...extra })} returning id`;
  await sql`insert into arts.service_history (customer_id, service_id, service_date, source)
    values (${c.id}, ${oil}, (arts.today() + ${dueInDays}::int - make_interval(months => 6))::date, 'import')`;
  return c.id as string;
}

async function live() {
  await sql`update arts.shop_settings set reminders_dry_run = false`;
  return getSettings();
}

beforeEach(async () => {
  await resetData();
  StubEmailProvider.outbox = [];
  StubEmailProvider.failNext = 0;
  oil = await serviceId('Oil change');
  await sql`update arts.shop_settings set shop_address = '123 Example St, Easton, PA 18042', staff_notify_email = 'chris@example.com', owner_alert_email = 'jake@example.com'`;
});

describe('Due list paging', () => {
  it('plans past the 1,000-row API limit', async () => {
    // 1,050 customers due in 10 days: step 1 (14 days before due) fires for all.
    await sql`insert into arts.customers (name, email, source)
      select 'Bulk ' || g, 'bulk' || g || '@example.com', 'import' from generate_series(1, 1050) g`;
    await sql`insert into arts.service_history (customer_id, service_id, service_date, source)
      select id, ${oil}, (arts.today() + 10 - make_interval(months => 6))::date, 'import' from arts.customers where name like 'Bulk %'`;
    const s = await getSettings();
    const plan = await planServiceReminders(s, today(s));
    expect(plan.filter((p) => p.action === 'send')).toHaveLength(1050);
  }, 60000);
});

describe('Sending', () => {
  it('two overlapping runs send each reminder once', async () => {
    for (const n of ['Ann', 'Ben', 'Cal', 'Dee']) await dueCustomer(n, 10);
    const s = await live();
    const on = today(s);
    await Promise.all([runServiceReminders(s, on), runServiceReminders(s, on)]);
    expect(StubEmailProvider.outbox.map((m) => m.to).sort()).toEqual(['ann@example.com', 'ben@example.com', 'cal@example.com', 'dee@example.com']);
    const rows = await sql`select status from arts.reminder_sends`;
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
  });

  it('each email carries an idempotency key and a one-click unsubscribe URL', async () => {
    await dueCustomer('Ann', 10);
    const s = await live();
    await runServiceReminders(s, today(s));
    const [m] = StubEmailProvider.outbox;
    expect(m.idempotencyKey).toMatch(/^reminder:[0-9a-f-]+:1$/);
    expect(m.headers?.['List-Unsubscribe']).toMatch(/\/api\/unsubscribe\?t=/);
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('stops at the deadline and the hourly job finishes the rest', async () => {
    for (const n of ['Ann', 'Ben', 'Cal']) await dueCustomer(n, 10);
    const s = await live();
    const r = await daily(s, new Date(), Date.now() - 1);
    expect(r.more).toBe(true);
    expect(StubEmailProvider.outbox).toHaveLength(0);
    await sql`insert into arts.job_runs (job, status, summary) values ('daily', 'ok', ${sql.json({ more: true })})`;
    // During shop hours, the tick carries on.
    const noon = new Date(`${today(s)}T12:00:00-05:00`);
    const c = await continueDaily(s, noon);
    expect(c.continued_more).toBe(false);
    expect(StubEmailProvider.outbox).toHaveLength(3);
    const [run] = await sql`select summary from arts.job_runs where job = 'daily'`;
    expect(run.summary.more).toBe(false);
  });

  it('steps recorded during the dry run still go out once it is turned off', async () => {
    await dueCustomer('Ann', 10);
    let s = await getSettings();
    expect(s.reminders_dry_run).toBe(true);
    await daily(s);
    expect(StubEmailProvider.outbox).toHaveLength(0);
    s = await live();
    await daily(s);
    expect(StubEmailProvider.outbox.map((m) => m.to)).toEqual(['ann@example.com']);
  });

  it('a step skipped for "no email" fires once the customer has one', async () => {
    const id = await dueCustomer('Ann', 10, { email: null });
    const s = await live();
    await daily(s);
    expect(StubEmailProvider.outbox).toHaveLength(0);
    await sql`update arts.customers set email = 'ann@example.com' where id = ${id}`;
    await daily(s);
    expect(StubEmailProvider.outbox.map((m) => m.to)).toEqual(['ann@example.com']);
  });

  it('a stale claim (run cut off mid-send) is retried with the same key', async () => {
    await dueCustomer('Ann', 10);
    const s = await live();
    await runServiceReminders(s, today(s));
    const first = StubEmailProvider.outbox[0].idempotencyKey;
    await sql`update arts.reminder_sends set status = 'queued', claimed_at = now() - interval '1 hour'`;
    StubEmailProvider.outbox = [];
    await runServiceReminders(s, today(s));
    expect(StubEmailProvider.outbox[0].idempotencyKey).toBe(first);
  });
});

describe('Batch sending', () => {
  it('sends reminders to the provider in groups, and a failed group is retried later', async () => {
    await sql`insert into arts.customers (name, email, source)
      select 'Group ' || g, 'group' || g || '@example.com', 'import' from generate_series(1, 120) g`;
    await sql`insert into arts.service_history (customer_id, service_id, service_date, source)
      select id, ${oil}, (arts.today() + 10 - make_interval(months => 6))::date, 'import' from arts.customers`;
    const calls: number[] = [];
    let failFirst = true;
    const batching = new StubEmailProvider() as StubEmailProvider & { sendBatch: (m: any[]) => Promise<any[]> };
    batching.sendBatch = async (msgs) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('provider down');
      }
      calls.push(msgs.length);
      expect(new Set(msgs.map((m) => m.idempotencyKey)).size).toBe(msgs.length);
      return msgs.map((_, i) => ({ id: `b${calls.length}-${i}`, costCents: 0 }));
    };
    setEmailProvider(batching);
    try {
      const s = await live();
      // The first call fails; the automatic retry goes through.
      const r = await runServiceReminders(s, today(s));
      expect(r.emailed).toBe(120);
      expect(calls).toEqual([50, 50, 20]);
      batching.sendBatch = async () => { throw new Error('provider down'); };
      await sql`update arts.reminder_sends set status = 'failed', provider_id = null`;
      const again = await runServiceReminders(s, today(s));
      expect(again.failed).toBe(120);
      const [{ n }] = await sql`select count(*)::int as n from arts.reminder_sends where status = 'failed'`;
      expect(n).toBe(120);
    } finally {
      setEmailProvider(null);
    }
  }, 60000);
});

describe('Escalations', () => {
  it('a failed escalation email is retried on the next run', async () => {
    const id = await dueCustomer('Ann', 100);
    const [b] = await sql`insert into arts.bookings (root_id, customer_id, date, kind, total_minutes, status, created_by_type, start_time, created_at)
      values (gen_random_uuid(), ${id}, arts.today() + 5, 'wait', 55, 'requested', 'public', '09:00', now() - interval '30 days') returning id`;
    const s = await getSettings();
    StubEmailProvider.failNext = 100;
    await tick(s);
    let [row] = await sql`select escalated_staff_at, escalated_owner_at from arts.bookings where id = ${b.id}`;
    expect(row).toEqual({ escalated_staff_at: null, escalated_owner_at: null });
    StubEmailProvider.failNext = 0;
    await tick(s);
    [row] = await sql`select escalated_staff_at, escalated_owner_at from arts.bookings where id = ${b.id}`;
    expect(row.escalated_staff_at).not.toBeNull();
    expect(row.escalated_owner_at).not.toBeNull();
  });
});

describe('Unsubscribe and bounces', () => {
  it('the one-click POST to the header URL opts the customer out', async () => {
    const id = await dueCustomer('Ann', 10);
    const url = new URL(oneClickUnsubscribeUrl(id));
    const req = Object.assign(new PassThrough(), { method: 'POST', url: url.pathname + url.search, headers: { 'content-type': 'application/x-www-form-urlencoded' }, query: Object.fromEntries(url.searchParams) });
    req.end('List-Unsubscribe=One-Click');
    const res = { statusCode: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, end() {} };
    await unsubscribe(req as any, res as any);
    expect(res.statusCode).toBe(200);
    expect((await sql`select email_opt_out from arts.customers where id = ${id}`)[0].email_opt_out).toBe(true);
  });

  it('verifies the Resend signature, then records bounces and complaints', async () => {
    const ann = await dueCustomer('Ann', 10);
    const ben = await dueCustomer('Ben', 10);
    const secret = `whsec_${Buffer.from('test-webhook-secret-123456').toString('base64')}`;
    const sign = (body: string, id = 'msg_1') => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
      return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
    };
    const bounce = JSON.stringify({ type: 'email.bounced', data: { to: ['ANN@example.com'], bounce: { type: 'Permanent', message: 'No such user' } } });
    expect(verifySvix(secret, sign(bounce), bounce)).toBe(true);
    await expect(handleResendWebhook(secret, { ...sign(bounce), 'svix-signature': 'v1,AAAA' }, bounce)).rejects.toMatchObject({ status: 401 });
    expect((await handleResendWebhook(secret, sign(bounce), bounce)).body).toMatchObject({ updated: 1 });
    const complaint = JSON.stringify({ type: 'email.complained', data: { to: ['ben@example.com'] } });
    await handleResendWebhook(secret, sign(complaint, 'msg_2'), complaint);
    const transient = JSON.stringify({ type: 'email.bounced', data: { to: ['ben@example.com'], bounce: { type: 'Transient' } } });
    await handleResendWebhook(secret, sign(transient, 'msg_3'), transient);
    const rows = await sql`select id, email_bounced, email_opt_out from arts.customers where id in ${sql([ann, ben])}`;
    expect(rows.find((r) => r.id === ann)).toMatchObject({ email_bounced: true, email_opt_out: false });
    expect(rows.find((r) => r.id === ben)).toMatchObject({ email_bounced: false, email_opt_out: true });
  });
});

describe('Job monitoring', () => {
  it('flags a run that never finished and alerts the owner', async () => {
    await sql`insert into arts.job_runs (job, started_at) values ('daily', now() - interval '1 hour')`;
    await runJob('tick', async () => ({}));
    const [stale] = await sql`select status, error from arts.job_runs where job = 'daily'`;
    expect(stale.status).toBe('failed');
    expect(StubEmailProvider.outbox.some((m) => m.to === 'jake@example.com' && /didn’t finish/.test(m.subject))).toBe(true);
  });
});
