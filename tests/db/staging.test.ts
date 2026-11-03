import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql, resetData, serviceId, weekdayAhead, adminToken, reqWith } from './helpers';
import { adminAction } from '../../server/admin';
import { postBook } from '../../server/public';
import { CaptureEmailProvider, setEmailProvider } from '../../server/email/provider';

let jake: string;
const act = (action: string, body: unknown = {}) => adminAction(reqWith(jake), action, body);

beforeAll(async () => {
  jake = (await adminToken('developer')).token;
});
afterAll(() => sql.end());

beforeEach(async () => {
  await resetData();
  process.env.APP_ENV = 'staging';
  setEmailProvider(new CaptureEmailProvider());
  await sql`update arts.shop_settings set staff_notify_email = 'chris@example.com', owner_alert_email = 'jake@example.com'`;
});
afterEach(() => {
  delete process.env.APP_ENV;
  setEmailProvider(null);
});

describe('staging gate', () => {
  it('refuses every simulator action outside staging', async () => {
    delete process.env.APP_ENV;
    for (const a of ['sim-status', 'sim-customers', 'sim-bookings', 'sim-day', 'sim-tick', 'sim-reset', 'outbox-clear']) {
      await expect(act(a, {})).rejects.toMatchObject({ status: 404 });
    }
  });

  it('rejects requests with no session', async () => {
    await expect(adminAction({ headers: {}, method: 'POST' } as any, 'sim-status', {})).rejects.toMatchObject({ status: 401 });
  });

  it('still requires an MFA-verified admin', async () => {
    const nomfa = (await adminToken('developer', false)).token;
    await expect(adminAction(reqWith(nomfa), 'sim-status', {})).rejects.toMatchObject({ status: 403 });
  });
});

describe('capture provider', () => {
  it('stores rendered emails in the outbox and logs them as captured', async () => {
    const day = await weekdayAhead(4);
    await postBook({
      service_ids: [await serviceId('Oil change')], customer_notes: '', date: day, kind: 'wait', start_time: '09:00',
      name: 'Real Person', email: 'real@example.com', phone: '6105553001',
      vehicle: { year: 2012, make: 'Ford', model: 'F-150', notes: '' }, turnstile: 'x',
    }, '10.9.0.1');
    const out = await sql`select kind, to_email, subject, html, text, attachments from arts.email_outbox order by created_at`;
    expect(out.map((r) => r.to_email).sort()).toEqual(['chris@example.com', 'real@example.com']);
    expect(out.every((r) => r.kind && r.html.includes('<') && r.text.length > 0)).toBe(true);
    const log = await sql`select status, provider_id from arts.email_log`;
    expect(log.every((r) => r.status === 'captured')).toBe(true);
    const [{ n }] = await sql`select count(*)::int n from arts.email_log l join arts.email_outbox o on o.id::text = l.provider_id`;
    expect(n).toBe(2);
  });
  it('delivers a [TEST] copy only to allowlisted addresses', async () => {
    const sent: { to: string; from: string; subject: string }[] = [];
    const via = { name: 'fake', ping: async () => true, send: async (m: any) => { sent.push(m); return { id: 're_1', costCents: 0 }; } };
    setEmailProvider(new CaptureEmailProvider({ to: ['chris@example.com'], from: 'Test <onboarding@resend.dev>', via }));
    const day = await weekdayAhead(4);
    await postBook({
      service_ids: [await serviceId('Oil change')], customer_notes: '', date: day, kind: 'wait', start_time: '09:00',
      name: 'Real Person', email: 'real@example.com', phone: '6105553002',
      vehicle: { year: 2012, make: 'Ford', model: 'F-150', notes: '' }, turnstile: 'x',
    }, '10.9.0.2');
    expect(sent.map((m) => m.to)).toEqual(['chris@example.com']);
    expect(sent[0]).toMatchObject({ from: 'Test <onboarding@resend.dev>', subject: expect.stringMatching(/^\[TEST\] /) });
    const rows = await sql`select to_email, delivered from arts.email_outbox order by to_email`;
    expect(rows).toEqual([{ to_email: 'chris@example.com', delivered: 'sent:re_1' }, { to_email: 'real@example.com', delivered: null }]);
  });
});

describe('simulator', () => {
  it('loads fake customers with history under @sim.invalid', async () => {
    const r = await act('sim-customers', { count: 40 });
    expect(r.body).toMatchObject({ customers: 40 });
    const [{ c, bad }] = await sql`select count(*)::int c, count(*) filter (where email not like '%@sim.invalid')::int bad from arts.customers`;
    expect(c).toBe(40);
    expect(bad).toBe(0);
    const [{ h }] = await sql`select count(*)::int h from arts.service_history`;
    expect(h).toBe((r.body as any).history);
    const st = await act('sim-status');
    expect(st.body).toMatchObject({ customers: 40, outbox: 0 });
  });

  it('fast-forward sends service reminders tagged with the simulated date, once', async () => {
    await act('sim-customers', { count: 60 });
    const start = (await act('sim-status')).body as any;
    expect(start.dry_run).toBe(true);
    const dates: string[] = [];
    let emails = 0;
    for (let i = 0; i < 21; i++) {
      const [{ d }] = await sql`select (arts.today() + ${i}::int)::text d`;
      dates.push(d);
      const r = await act('sim-day', { date: d, live: true });
      emails += (r.body as any).emails;
    }
    expect(emails).toBeGreaterThan(0);
    const rows = await sql`select kind, sim_date::text, to_email from arts.email_outbox where kind like 'service_due%'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => dates.includes(r.sim_date))).toBe(true);
    // Opted-out customers never get one.
    const [{ n }] = await sql`select count(*)::int n from arts.email_outbox o join arts.customers c on lower(c.email) = o.to_email where c.email_opt_out`;
    expect(n).toBe(0);
    // Dry-run stays on in settings; the override applies to the simulation only.
    const [{ dry }] = await sql`select reminders_dry_run dry from arts.shop_settings`;
    expect(dry).toBe(true);
    // Re-running a day sends nothing new.
    const again = await act('sim-day', { date: dates[0], live: true });
    expect((again.body as any).emails).toBe(0);
  });

  it('without the override, dry-run logs reminders but emails nothing', async () => {
    await act('sim-customers', { count: 40 });
    const [{ d }] = await sql`select arts.today()::text d`;
    const r = await act('sim-day', { date: d, live: false });
    expect((r.body as any).emailed).toBe(0);
    const [{ n }] = await sql`select count(*)::int n from arts.email_outbox where kind like 'service_due%'`;
    expect(n).toBe(0);
  });

  it('booking requests go through the real booking path and send the usual emails', async () => {
    await act('sim-customers', { count: 10 });
    const r = await act('sim-bookings', { count: 4 });
    const made = (r.body as any).made;
    expect(made.length).toBeGreaterThan(0);
    const [{ b }] = await sql`select count(*)::int b from arts.bookings where source = 'sim'`;
    expect(b).toBe(made.length);
    const [{ staff }] = await sql`select count(*)::int staff from arts.email_outbox where to_email = 'chris@example.com'`;
    expect(staff).toBeGreaterThan(0);
  });

  it('books a pinned slot and returns the booking ids', async () => {
    const oil = await serviceId('Oil change');
    const day = await weekdayAhead(4);
    const r = await act('sim-bookings', { count: 2, slot: { service_id: oil, date: day, kind: 'wait', start_time: '09:00' } });
    const made = (r.body as any).made;
    expect(made).toHaveLength(2);
    const rows = await sql`select id, date::text, start_time::text, status from arts.bookings where id in ${sql(made.map((m: any) => m.booking_id))}`;
    expect(rows.every((b) => b.date === day && b.start_time.startsWith('09:00') && b.status === 'requested')).toBe(true);
  });

  it('reset removes only simulated customers', async () => {
    await act('sim-customers', { count: 20 });
    await act('sim-bookings', { count: 3 });
    const day = await weekdayAhead(4);
    await postBook({
      service_ids: [await serviceId('Oil change')], customer_notes: '', date: day, kind: 'wait', start_time: '10:00',
      name: 'Real Person', email: 'real@example.com', phone: '6105553002',
      vehicle: { year: 2012, make: 'Ford', model: 'F-150', notes: '' }, turnstile: 'x',
    }, '10.9.0.2');
    const r = await act('sim-reset');
    expect((r.body as any).customers).toBeGreaterThanOrEqual(20);
    const rows = await sql`select email from arts.customers`;
    expect(rows.map((x) => x.email)).toEqual(['real@example.com']);
    const [{ bk }] = await sql`select count(*)::int bk from arts.bookings`;
    expect(bk).toBe(1);
  });

  it('clears the outbox', async () => {
    await act('sim-customers', { count: 5 });
    await act('sim-bookings', { count: 1 });
    await act('outbox-clear');
    const [{ n }] = await sql`select count(*)::int n from arts.email_outbox`;
    expect(n).toBe(0);
  });
});
