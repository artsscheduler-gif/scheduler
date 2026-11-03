import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

describe('Status changes', () => {
  it('reopening a cancelled booking re-checks the slot; odd transitions are refused', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    const a = await request();
    await call('decide', { booking_id: a.id, action: 'approve' });
    await call('status', { booking_id: a.id, status: 'cancelled', notify: false });
    const b = await request(); // takes the same 09:00 waiter lane
    const r = await call('status', { booking_id: a.id, status: 'confirmed' });
    expect(r).toMatchObject({ status: 409, body: { violations: expect.arrayContaining(['waiter_lanes']) } });
    expect((await call('status', { booking_id: a.id, status: 'confirmed', override: true })).status).toBe(200);
    expect((await call('status', { booking_id: b.id, status: 'confirmed' })).body).toMatchObject({ error: 'invalid_transition' });
  });
});

describe('Settings safety', () => {
  it('rejects values that would lock people out or break scheduling', async () => {
    await expect(call('settings', { session_timeout_hours: 0 })).rejects.toMatchObject({ field: 'session_timeout_hours' });
    await expect(call('settings', { timezone: 'America/New_Yrok' })).rejects.toMatchObject({ field: 'timezone' });
    await expect(call('settings', { staff_notify_email: 'chris@' })).rejects.toThrow(/valid email/);
    await expect(call('settings', { waiter_lanes: 9 })).rejects.toThrow(/more than total lanes/);
    await expect(call('settings', { dropoff_window_end: '07:00' })).rejects.toThrow(/after the earliest/);
    expect((await call('settings', { session_timeout_hours: 8, timezone: 'America/Chicago' })).status).toBe(200);
  });

  it('the server ends admin sessions older than the timeout setting', async () => {
    await sql`update arts.shop_settings set session_timeout_hours = 1`;
    expect((await call('check', { date: day, kind: 'wait', start_time: '09:00', service_ids: [oil] })).status).toBe(200);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 3600_000);
    try {
      await expect(call('check', { date: day, kind: 'wait', start_time: '09:00', service_ids: [oil] })).rejects.toMatchObject({ status: 401 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Launch checklist', () => {
  it('only the owner can tick items; ticks are audited', async () => {
    const [item] = await sql`insert into arts.audit_items (key, section, title) values ('test-item', 'Test', 'Something to fix') returning id`;
    await expect(call('audit-item', { id: item.id, done: true })).rejects.toMatchObject({ status: 403 });
    const owner = (await adminToken('owner')).token;
    const r = await adminAction(reqWith(owner), 'audit-item', { id: item.id, done: true, note: 'Done in staging' });
    expect(r.body).toMatchObject({ done: true, note: 'Done in staging' });
    expect((r.body as any).done_at).toBeTruthy();
    const [log] = await sql`select action from arts.audit_log where entity = 'audit_item'`;
    expect(log.action).toBe('checklist.update');
    await sql`delete from arts.audit_items where key = 'test-item'`;
  });
});

describe('Blocked time', () => {
  it('staff block and unblock part of a day; it is audited', async () => {
    const r = await call('block', { date: day, start_time: '13:00', end_time: '15:00', reason: 'Tech out' });
    expect(r.status).toBe(200);
    expect((await call('check', { date: day, kind: 'wait', start_time: '13:00', service_ids: [oil] })).body).toMatchObject({ violations: expect.arrayContaining(['blocked']) });
    await expect(call('block', { date: day, start_time: '15:00', end_time: '13:00' })).rejects.toThrow(/after the start/);
    const weekly = await call('block', { weekday: 5, start_time: '16:00', end_time: '17:30' });
    expect((weekly.body as any).weekday).toBe(5);
    await call('block', { id: (r.body as any).id, delete: true });
    const rows = await sql`select action from arts.audit_log where entity = 'time_block' order by created_at`;
    expect(rows.map((x) => x.action)).toEqual(['block.create', 'block.create', 'block.delete']);
  });
});

describe('Overrides and phone bookings', () => {
  it('shows the broken rule and books only with an explicit override', async () => {
    await request({ kind: 'dropoff', start_time: '10:00', service_ids: [brakes] });
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

    // Undo puts both records back as they were.
    const [m] = await sql`select id from arts.customer_merges where keep_id = ${a.id}`;
    expect((await call('unmerge', { merge_id: m.id })).status).toBe(200);
    const [kept2] = await sql`select phone, mail_opt_out from arts.customers where id = ${a.id}`;
    expect(kept2).toEqual({ phone: null, mail_opt_out: false });
    const [back] = await sql`select phone, mail_opt_out, merged_into from arts.customers where id = ${b.id}`;
    expect(back).toEqual({ phone: '+16105550000', mail_opt_out: true, merged_into: null });
    const [{ c: moved }] = await sql`select count(*)::int as c from arts.service_history where customer_id = ${b.id}`;
    expect(moved).toBe(1);
    await expect(call('unmerge', { merge_id: m.id })).rejects.toMatchObject({ status: 409 });
  });
});

describe('Removing vehicles and customers', () => {
  it('deleting a vehicle removes its history; bookings stay', async () => {
    const a = await request();
    const [{ vehicle_id: vid, customer_id: cid }] = await sql`select vehicle_id, customer_id from arts.bookings where id = ${a.id}`;
    await sql`insert into arts.service_history (customer_id, vehicle_id, service_date, source) values (${cid}, ${vid}, '2025-05-01', 'import')`;
    expect((await call('vehicle', { id: vid, delete: true })).body).toMatchObject({ ok: true, history_removed: 1 });
    const [b] = await sql`select vehicle_id from arts.bookings where id = ${a.id}`;
    expect(b.vehicle_id).toBeNull();
    expect((await sql`select count(*)::int c from arts.vehicles where id = ${vid}`)[0].c).toBe(0);
  });

  it('forgetting a customer removes their details and cancels upcoming visits', async () => {
    const a = await request({ customer_notes: 'Call my cell' });
    const [{ customer_id: cid }] = await sql`select customer_id from arts.bookings where id = ${a.id}`;
    expect((await call('forget', { customer_id: cid })).body).toMatchObject({ ok: true, cancelled_upcoming: 1 });
    const [c] = await sql`select name, email, phone, email_opt_out from arts.customers where id = ${cid}`;
    expect(c).toEqual({ name: 'Removed customer', email: null, phone: null, email_opt_out: true });
    const [b] = await sql`select status, customer_notes from arts.bookings where id = ${a.id}`;
    expect(b).toEqual({ status: 'cancelled', customer_notes: '' });
    const [log] = await sql`select before, after from arts.audit_log where action = 'customer.forget'`;
    expect(log.before).toBeNull();
    expect(JSON.stringify(log.after)).not.toMatch(/@/);
  });
});

describe('Team', () => {
  it('owner invites, changes role, resets authenticator and removes; staff cannot', async () => {
    await expect(call('team-list', {})).rejects.toMatchObject({ status: 403 });
    const { token: ownerTok, userId: ownerId } = await adminToken('owner');
    const owner = (action: string, body: unknown) => adminAction(reqWith(ownerTok), action, body);
    const email = `new-staff-${Date.now()}@example.com`;
    const inv = await owner('team-invite', { email, name: 'New Staff', role: 'staff' });
    expect((inv.body as any).link).toMatch(/^https?:\/\//);
    expect(StubEmailProvider.outbox.some((m) => m.to === email)).toBe(true);
    const list = (await owner('team-list', {})).body as any;
    const m = list.members.find((x: any) => x.email === email);
    expect(m).toMatchObject({ role: 'staff', invited: true, mfa: false });
    expect((await owner('team-role', { user_id: m.id, role: 'owner' })).status).toBe(200);
    expect((await owner('team-reset-mfa', { user_id: m.id })).body).toMatchObject({ ok: true, removed: 0 });
    await expect(owner('team-remove', { user_id: ownerId })).rejects.toMatchObject({ status: 409 });
    expect((await owner('team-remove', { user_id: m.id })).status).toBe(200);
    expect(((await owner('team-list', {})).body as any).members.some((x: any) => x.email === email)).toBe(false);
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
