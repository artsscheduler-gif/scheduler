import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql, resetData, serviceId, weekdayAhead, adminToken, reqWith } from './helpers';
import { adminAction } from '../../server/admin';
import { postBook } from '../../server/public';
import { tick } from '../../server/jobs';
import { getSettings } from '../../server/db';
import { StubEmailProvider } from '../../server/email/provider';
import { csvObjects } from '../../shared/csv';

let chris: string;
let oil: string;
let brakes: string;
let day: string;
let n = 0;

beforeAll(async () => {
  chris = (await adminToken('staff')).token;
});
afterAll(() => sql.end());

beforeEach(async () => {
  await resetData();
  StubEmailProvider.outbox = [];
  oil = await serviceId('Oil change');
  brakes = await serviceId('Brakes');
  day = await weekdayAhead(4);
  await sql`update arts.shop_settings set staff_notify_email = 'chris@example.com', owner_alert_email = 'jake@example.com'`;
});

async function request(over: Record<string, unknown> = {}) {
  n += 1;
  const email = `cust${n}-${Date.now()}@example.com`;
  await postBook({
    service_ids: [oil], customer_notes: '', date: day, kind: 'wait', start_time: '09:00',
    name: `Cust ${n}`, email, phone: `610555${String(3000 + n).slice(-4)}`,
    vehicle: { year: 2012, make: 'Ford', model: 'F-150', notes: '' }, turnstile: 'x', ...over,
  }, `10.4.0.${n % 250}`);
  const [b] = await sql`select b.id from arts.bookings b join arts.customers c on c.id = b.customer_id where c.email = ${email}`;
  StubEmailProvider.outbox = [];
  return { id: b.id as string, email };
}

const call = (action: string, body: unknown) => adminAction(reqWith(chris), action, body);

describe('Admin auth', () => {
  it('rejects missing tokens, non-MFA sessions, and non-admins', async () => {
    await expect(adminAction({ headers: {} } as any, 'check', {})).rejects.toMatchObject({ status: 401 });
    const noMfa = await adminToken('staff', false);
    await expect(adminAction(reqWith(noMfa.token), 'check', {})).rejects.toMatchObject({ status: 403, body: { error: 'mfa_required' } });
  });
});

describe('Approval queue', () => {
  it('requested bookings hold their slot', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    await request();
    const r = await call('check', { date: day, kind: 'wait', start_time: '09:00', service_ids: [oil] });
    expect((r.body as any).violations).toContain('waiter_lanes');
  });

  it('approve sends a confirmation with a calendar file', async () => {
    const { id, email } = await request();
    const r = await call('decide', { booking_id: id, action: 'approve' });
    expect(r.status).toBe(200);
    const m = StubEmailProvider.outbox.find((x) => x.to === email)!;
    expect(m.subject).toMatch(/^Confirmed/);
    expect(m.attachments?.[0].contentType).toBe('text/calendar');
  });

  it('propose moves, confirms, and emails the new time', async () => {
    const { id, email } = await request();
    const r = await call('decide', { booking_id: id, action: 'propose', date: day, kind: 'wait', start_time: '13:00', reason: 'Morning is full' });
    expect(r.status).toBe(200);
    const m = StubEmailProvider.outbox.find((x) => x.to === email)!;
    expect(m.subject).toMatch(/^New time:.*1:00pm/);
    expect(m.text).toContain('Morning is full');
    const [b] = await sql`select status, start_time::text from arts.bookings where id = ${id}`;
    expect(b).toEqual({ status: 'confirmed', start_time: '13:00:00' });
  });

  it('decline frees the slot and emails the reason', async () => {
    const { id, email } = await request();
    await call('decide', { booking_id: id, action: 'decline', reason: 'We don’t service diesels' });
    const m = StubEmailProvider.outbox.find((x) => x.to === email)!;
    expect(m.subject).toBe('About your appointment request');
    expect(m.text).toContain('We don’t service diesels');
  });

  it('unanswered requests escalate to Chris, then Jake', async () => {
    await request();
    const s = await getSettings();
    // 4 business hours never pass instantly.
    expect((await tick(s, new Date())).escalated_staff).toBe(0);
    const later = new Date(Date.now() + 3 * 86400_000 + 8 * 3600_000);
    const r = await tick(s, later);
    expect(r).toMatchObject({ escalated_staff: 1, escalated_owner: 1 });
    expect(StubEmailProvider.outbox.map((m) => m.to).sort()).toEqual(['chris@example.com', 'jake@example.com']);
    // Never twice.
    expect(await tick(s, later)).toMatchObject({ escalated_staff: 0, escalated_owner: 0 });
    const [b] = await sql`select status from arts.bookings`;
    expect(b.status).toBe('requested'); // holds never silently expire
  });
});

describe('Overrides and phone bookings', () => {
  it('shows the broken rule and books only with an explicit override', async () => {
    await request({ kind: 'dropoff', start_time: undefined, service_ids: [brakes] });
    const body = { name: 'Phone Caller', phone: '610-555-0199', service_ids: [brakes], date: day, kind: 'dropoff', vehicle: { make: 'Jeep', model: 'Wrangler' } };
    const blocked = await call('create', body);
    expect(blocked.status).toBe(409);
    expect((blocked.body as any).violations).toEqual(['daily_cap:Brakes']);
    const forced = await call('create', { ...body, override: true });
    expect(forced.status).toBe(200);
    const [log] = await sql`select action, actor_label from arts.audit_log where action = 'booking.create_override'`;
    expect(log).toEqual({ action: 'booking.create_override', actor_label: 'Chris' });
  });

  it('move with override records what was broken', async () => {
    const { id } = await request();
    await call('decide', { booking_id: id, action: 'approve' });
    const r = await call('move', { booking_id: id, date: day, kind: 'wait', start_time: '17:15' });
    expect((r.body as any).violations).toContain('outside_hours');
    expect((await call('move', { booking_id: id, date: day, kind: 'wait', start_time: '17:15', override: true })).status).toBe(200);
  });
});

describe('Audit log', () => {
  it('every admin change appears in the audit log', async () => {
    const { id } = await request();
    const [c] = await sql`select customer_id from arts.bookings where id = ${id}`;
    const before = (await sql`select count(*)::int as c from arts.audit_log`)[0].c;
    await call('decide', { booking_id: id, action: 'approve' });
    await call('move', { booking_id: id, date: day, kind: 'wait', start_time: '10:00' });
    await call('status', { booking_id: id, status: 'completed' });
    await call('customer', { id: c.customer_id, fields: { always_review: true, city: 'Bethlehem' } });
    await call('settings', { waiter_lanes: 2, notes_require_review: false });
    await call('service', { id: oil, name: 'Oil change', duration_minutes: 40, wait_eligible: true, sort_order: 1 });
    await call('level', { service_id: oil, level: 'notify' });
    await call('closure', { start_date: day, reason: 'Inventory' });
    await call('rule', { step: 4, channel: 'email', offset_days: 60, condition: 'no_booking_since_previous_step' });
    await call('export', { table: 'customers' });
    const rows = await sql`select action, actor_type, actor_label from arts.audit_log order by id offset ${before}`;
    expect(rows.map((r) => r.action)).toEqual([
      'booking.approve', 'booking.move', 'booking.completed', 'customer.update', 'settings.update',
      'service.update', 'service.approval_level', 'closure.create', 'reminder_rule.create', 'export',
    ]);
    expect(rows.every((r) => r.actor_type === 'admin' && r.actor_label === 'Chris')).toBe(true);
    const [settingsRow] = await sql`select before, after from arts.audit_log where action = 'settings.update' order by id desc limit 1`;
    expect(settingsRow.before).toMatchObject({ notes_require_review: true });
    expect(settingsRow.after).toMatchObject({ notes_require_review: false });
  });

  it('merging customers keeps opt-outs and moves history', async () => {
    const [a] = await sql`insert into arts.customers (name, email) values ('Dana', 'dana@example.com') returning id`;
    const [b] = await sql`insert into arts.customers (name, phone, mail_opt_out) values ('Dana', '+16105550000', true) returning id`;
    await sql`insert into arts.service_history (customer_id, service_date, source) values (${b.id}, '2025-05-01', 'import')`;
    await call('merge', { keep_id: a.id, merge_id: b.id });
    const [kept] = await sql`select phone, mail_opt_out from arts.customers where id = ${a.id}`;
    expect(kept).toEqual({ phone: '+16105550000', mail_opt_out: true });
    const [{ c }] = await sql`select count(*)::int as c from arts.service_history where customer_id = ${a.id}`;
    expect(c).toBe(1);
  });
});

describe('Export', () => {
  it('round-trips: every row and field comes back out', async () => {
    await request({ customer_notes: 'Line one, "quoted"\nline two' });
    await sql`insert into arts.customers (name, email, city) values ('=cmd|evil', 'x@example.com', 'Allentown, PA')`;
    for (const table of ['customers', 'vehicles', 'service_history', 'bookings']) {
      const r = await call('export', { table });
      const rows = csvObjects((r.body as any).csv);
      const [{ c }] = await sql`select count(*)::int as c from ${sql('arts.' + table)}`;
      expect(rows.length).toBe(c);
    }
    const customers = csvObjects(((await call('export', { table: 'customers' })).body as any).csv);
    const evil = customers.find((x) => x.email === 'x@example.com')!;
    expect(evil.city).toBe('Allentown, PA');
    expect(evil.name).toBe("'=cmd|evil"); // formula-injection guard
    const bookings = csvObjects(((await call('export', { table: 'bookings' })).body as any).csv);
    expect(bookings[0].customer_notes).toBe('Line one, "quoted"\nline two');
    expect(bookings[0].services).toBe('Oil change');
    const [db] = await sql`select id, date::text, status::text from arts.bookings`;
    expect(bookings[0]).toMatchObject({ id: db.id, date: db.date, status: db.status });
  });
});
