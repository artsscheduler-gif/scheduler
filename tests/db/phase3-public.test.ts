import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql, service, resetData, serviceId, weekdayAhead } from './helpers';
import { postBook, getManage, postCancel, postReschedule, postChangeServices, getAvailability, postUnsubscribe } from '../../server/public';
import { StubEmailProvider } from '../../server/email/provider';
import { signToken } from '../../server/tokens';
import { endpoint } from '../../server/http';
import { rpc } from '../../server/db';

afterAll(() => sql.end());

let oil: string, rotation: string, brakes: string;
let day: string;
let n = 0;

function body(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    service_ids: [oil], customer_notes: '', date: day, kind: 'wait', start_time: '09:00',
    name: `Pat Tester${n}`, email: `pat${n}-${Date.now()}@example.com`, phone: `(610) 555-${String(2000 + n).slice(-4)}`,
    vehicle: { year: 2018, make: 'Subaru', model: 'Outback', notes: '' },
    turnstile: 'test-token',
    ...over,
  };
}

async function tokenFor(email: string): Promise<string> {
  const msg = StubEmailProvider.outbox.find((m) => m.to === email && /manage\?t=/.test(m.html));
  const m = msg!.html.match(/manage\?t=([A-Za-z0-9_.-]+)/);
  return m![1];
}

async function approve(bookingId: string) {
  return rpc('decide_booking', { p_booking: bookingId, p_action: 'approve', p_actor: { type: 'admin', label: 'Chris' } });
}

async function checkSlot(date: string, start: string, services = [oil]) {
  return rpc<string[]>('check_booking', { p_date: date, p_kind: 'wait', p_start: start, p_service_ids: services });
}

beforeEach(async () => {
  await resetData();
  StubEmailProvider.outbox = [];
  oil = await serviceId('Oil change');
  rotation = await serviceId('Tire rotation');
  brakes = await serviceId('Brakes');
  day = await weekdayAhead(4);
  await service.from('shop_settings').update({ staff_notify_email: 'chris@example.com' }).eq('id', 1);
});

describe('Public booking', () => {
  it('books, holds the slot, emails customer and Chris', async () => {
    const b = body();
    const r = await postBook(b, '10.0.0.1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'requested', date: day });
    const subjects = StubEmailProvider.outbox.map((m) => `${m.to}: ${m.subject}`);
    expect(subjects).toContain(`${b.email}: We got your request`);
    expect(subjects.some((s) => s.startsWith('chris@example.com: Approval needed'))).toBe(true);
    const [row] = await sql`select c.phone from arts.bookings b join arts.customers c on c.id = b.customer_id`;
    expect(row.phone).toMatch(/^\+1610555\d{4}$/);
  });

  it('auto-confirmed bookings get a calendar file and a manage link', async () => {
    await sql`update arts.services set approval_level = 'notify'`;
    await sql`update arts.shop_settings set notes_require_review = false, new_customers_require_review = false`;
    const b = body();
    const r = await postBook(b, '10.0.0.2');
    expect(r.body).toMatchObject({ status: 'confirmed' });
    const mail = StubEmailProvider.outbox.find((m) => m.to === b.email)!;
    expect(mail.subject).toMatch(/^Confirmed/);
    expect(mail.attachments?.[0].filename).toBe('appointment.ics');
    expect(Buffer.from(mail.attachments![0].content, 'base64').toString()).toContain('BEGIN:VEVENT');
    expect(StubEmailProvider.outbox.some((m) => m.to === 'chris@example.com' && /\/admin\?undo=/.test(m.html))).toBe(true);
  });

  it('response is identical whether or not the email matches an existing customer', async () => {
    await sql`update arts.services set approval_level = 'notify'`;
    await sql`update arts.shop_settings set notes_require_review = false`;
    const [c] = await sql`insert into arts.customers (name, email, source) values ('Known', 'known@example.com', 'import') returning id`;
    await sql`insert into arts.service_history (customer_id, service_date, source) values (${c.id}, '2025-03-01', 'import')`;
    const known = await postBook(body({ email: 'known@example.com', start_time: '09:00' }), '10.0.0.3');
    const fresh = await postBook(body({ start_time: '09:00' }), '10.0.0.4');
    expect(known.body).toEqual(fresh.body);
    // ...even though the known customer really was auto-confirmed (their email says so).
    const [k] = await sql`select b.status from arts.bookings b join arts.customers c on c.id = b.customer_id where c.email = 'known@example.com'`;
    expect(k.status).toBe('confirmed');
  });

  it('availability returns times only — no names or counts', async () => {
    await postBook(body(), '10.0.0.5');
    const r = await getAvailability(new URLSearchParams({ services: oil, date: day }), '10.0.0.5');
    expect(Object.keys(r.body as object)).toEqual(['times']);
    const days = await getAvailability(new URLSearchParams({ services: oil }), '10.0.0.5');
    expect(Object.keys(days.body as object)).toEqual(['days']);
    expect(JSON.stringify(r.body)).not.toMatch(/Pat|@/);
    expect(Object.keys((r.body as any).times[0])).toEqual(['time', 'wait', 'dropoff']);
  });

  it('customers must give a drop-off time', async () => {
    await expect(postBook(body({ kind: 'dropoff', start_time: null }), '10.0.0.7')).rejects.toThrow(/must be a time/);
    const r = await postBook(body({ kind: 'dropoff', start_time: '10:00', email: 'drop@example.com', phone: '610-555-0188' }), '10.0.0.7');
    expect(r.status).toBe(200);
    const [b] = await sql`select b.kind, b.start_time from arts.bookings b join arts.customers c on c.id = b.customer_id where c.email = 'drop@example.com'`;
    expect(b).toMatchObject({ kind: 'dropoff', start_time: '10:00:00' });
  });

  it('rejects malformed input and unexpected fields', async () => {
    await expect(postBook({ ...body(), admin: true }, '10.0.0.6')).rejects.toThrow(/unexpected field/);
    await expect(postBook(body({ email: 'not-an-email' }), '10.0.0.6')).rejects.toThrow(/valid email/);
    await expect(postBook(body({ customer_notes: 'x'.repeat(501) }), '10.0.0.6')).rejects.toThrow(/500 characters/);
    await expect(postBook(body({ phone: '12' }), '10.0.0.6')).rejects.toThrow(/phone/);
  });

  it('a taken slot returns slot_unavailable', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    await postBook(body(), '10.0.0.7');
    const r = await postBook(body(), '10.0.0.8');
    expect(r).toMatchObject({ status: 409, body: { error: 'slot_unavailable' } });
  });

  it('rate limits per IP', async () => {
    await sql`update arts.shop_settings set rate_limit_ip_per_hour = 2, waiter_lanes = 2`;
    await postBook(body({ start_time: '08:00' }), '10.9.9.9');
    await postBook(body({ start_time: '10:00' }), '10.9.9.9');
    await expect(postBook(body({ start_time: '12:00' }), '10.9.9.9')).rejects.toMatchObject({ status: 429 });
  });

  it('server errors become a generic 503 the client turns into the phone fallback', async () => {
    const h = endpoint(['POST'], async () => {
      throw new Error('database exploded');
    });
    let status = 0;
    let out = '';
    const res: any = { setHeader() {}, end(s: string) { out = s; }, set statusCode(v: number) { status = v; } };
    await h({ method: 'POST', body: {}, headers: {}, url: '/api/book' } as any, res);
    expect(status).toBe(503);
    expect(JSON.parse(out)).toEqual({ error: 'unavailable' });
  });
});

describe('Manage link', () => {
  it('rejects tampered and expired tokens', async () => {
    const b = body();
    await postBook(b, '10.1.0.1');
    const t = await tokenFor(b.email);
    expect((await getManage(t)).status).toBe(200);
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), r: crypto.randomUUID() })).toString('base64url');
    await expect(getManage(`${forged}.${sig}`)).rejects.toMatchObject({ status: 401 });
    await expect(getManage(`${payload}.${sig.slice(0, -2)}AA`)).rejects.toMatchObject({ status: 401 });
    const expired = signToken({ p: 'manage', r: JSON.parse(Buffer.from(payload, 'base64url').toString()).r, exp: Math.floor(Date.now() / 1000) - 1 });
    await expect(getManage(expired)).rejects.toMatchObject({ status: 401 });
    await expect(getManage(signToken({ p: 'unsub', c: crypto.randomUUID() }))).rejects.toMatchObject({ status: 401 });
  });

  it('cancel frees capacity immediately and notifies both sides', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    const b = body();
    await postBook(b, '10.1.0.2');
    expect(await checkSlot(day, '09:00')).toContain('waiter_lanes');
    const t = await tokenFor(b.email);
    expect((await postCancel({ t })).body).toMatchObject({ ok: true });
    expect(await checkSlot(day, '09:00')).toEqual([]);
    expect(StubEmailProvider.outbox.some((m) => m.to === b.email && m.subject === 'Your appointment is cancelled')).toBe(true);
    expect(StubEmailProvider.outbox.some((m) => m.to === 'chris@example.com' && m.subject.startsWith('Cancelled'))).toBe(true);
    const [a] = await sql`select actor_type from arts.audit_log where action = 'booking.cancelled'`;
    expect(a.actor_type).toBe('customer');
  });

  it('reschedule returns to Chris, holds both slots, and decline keeps the original', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    const b = body();
    await postBook(b, '10.1.0.3');
    const [orig] = await sql`select id from arts.bookings`;
    await approve(orig.id);
    const t = await tokenFor(b.email);

    const r = await postReschedule({ t, date: day, kind: 'wait', start_time: '13:00' });
    expect(r.body).toMatchObject({ ok: true, state: 'requested' });
    // Both slots held.
    expect(await checkSlot(day, '09:00')).toContain('waiter_lanes');
    expect(await checkSlot(day, '13:00')).toContain('waiter_lanes');
    // Chris sees before and after.
    const staff = StubEmailProvider.outbox.find((m) => m.subject.startsWith('Change request'))!;
    expect(staff.text).toMatch(/Before: .*9:00am/);
    expect(staff.text).toMatch(/After: .*1:00pm/);

    const [change] = await sql`select id from arts.bookings where status = 'requested'`;
    await rpc('decide_booking', { p_booking: change.id, p_action: 'decline', p_actor: { type: 'admin' }, p_reason: 'Full' });
    const rows = await sql`select start_time::text, status from arts.bookings order by created_at`;
    expect(rows).toEqual([{ start_time: '09:00:00', status: 'confirmed' }, { start_time: '13:00:00', status: 'declined' }]);
    expect(await checkSlot(day, '13:00')).toEqual([]);
  });

  it('approve of a reschedule moves it and releases the old slot', async () => {
    await sql`update arts.shop_settings set waiter_lanes = 1`;
    const b = body();
    await postBook(b, '10.1.0.4');
    const [orig] = await sql`select id from arts.bookings`;
    await approve(orig.id);
    const t = await tokenFor(b.email);
    await postReschedule({ t, date: day, kind: 'wait', start_time: '13:00' });
    const [change] = await sql`select id from arts.bookings where status = 'requested'`;
    await approve(change.id);
    expect(await checkSlot(day, '09:00')).toEqual([]);
    expect(await checkSlot(day, '13:00')).toContain('waiter_lanes');
    const view = (await getManage(t)).body as any;
    expect(view.current.start_time).toBe('13:00');
  });

  it('change services: before/after for Chris; a non-fitting change asks for a new slot', async () => {
    const b = body();
    await postBook(b, '10.1.0.5');
    const [orig] = await sql`select id from arts.bookings`;
    await approve(orig.id);
    const t = await tokenFor(b.email);
    // Brakes are not wait-eligible: the held wait slot no longer fits.
    expect(await postChangeServices({ t, service_ids: [brakes], customer_notes: '' })).toMatchObject({ status: 409, body: { error: 'needs_new_slot' } });
    // Picks a drop-off in the same flow.
    const r = await postChangeServices({ t, service_ids: [brakes], customer_notes: 'Grinding noise', date: day, kind: 'dropoff', start_time: '10:00' });
    expect(r.body).toMatchObject({ ok: true });
    const rows = await sql`select kind::text, status::text, change_kind from arts.bookings order by created_at`;
    expect(rows).toEqual([
      { kind: 'wait', status: 'confirmed', change_kind: null },
      { kind: 'dropoff', status: 'requested', change_kind: 'services' },
    ]);
    // A second change replaces the pending one.
    await postChangeServices({ t, service_ids: [oil, rotation], customer_notes: '' });
    const after = await sql`select status::text from arts.bookings order by created_at`;
    expect(after.map((x) => x.status)).toEqual(['confirmed', 'replaced', 'requested']);
  });

  it('change decisions do not move the ladder counter', async () => {
    const b = body();
    await postBook(b, '10.1.0.6');
    const [orig] = await sql`select id from arts.bookings`;
    await approve(orig.id);
    const [{ approvals_in_a_row: before }] = await sql`select approvals_in_a_row from arts.services where id = ${oil}`;
    const t = await tokenFor(b.email);
    await postReschedule({ t, date: day, kind: 'wait', start_time: '14:00' });
    const [change] = await sql`select id from arts.bookings where status = 'requested'`;
    await rpc('decide_booking', { p_booking: change.id, p_action: 'decline', p_actor: { type: 'admin' } });
    const [{ approvals_in_a_row: after }] = await sql`select approvals_in_a_row from arts.services where id = ${oil}`;
    expect(after).toBe(before);
  });

  it('changes are refused inside the cutoff window', async () => {
    const b = body();
    await postBook(b, '10.1.0.7');
    const t = await tokenFor(b.email);
    await sql`update arts.shop_settings set change_cutoff_hours = 2000`;
    expect(((await getManage(t)).body as any).can_change).toBe(false);
    await expect(postCancel({ t })).rejects.toMatchObject({ status: 403 });
    await expect(postReschedule({ t, date: day, kind: 'wait', start_time: '14:00' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('Manage-link abuse and cutoffs', () => {
  it('a new time inside the cutoff is refused', async () => {
    // Booking ~25 days out; changes close 20 days (480h) ahead. Moving to ~3 days out is too soon.
    const far = await weekdayAhead(25);
    const b = body({ date: far });
    await postBook(b, '10.1.1.1');
    const t = await tokenFor(b.email);
    await sql`update arts.shop_settings set change_cutoff_hours = 480`;
    const r = await postReschedule({ t, date: day, kind: 'wait', start_time: '09:00' });
    expect(r).toMatchObject({ status: 409, body: { error: 'too_soon' } });
    expect((await postReschedule({ t, date: far, kind: 'wait', start_time: '14:00' })).status).toBe(200);
  });

  it('caps change requests per appointment per day', async () => {
    const b = body();
    await postBook(b, '10.1.1.2');
    const t = await tokenFor(b.email);
    for (let i = 0; i < 5; i++) await postReschedule({ t, date: day, kind: 'wait', start_time: i % 2 ? '14:00' : '13:00' });
    await expect(postReschedule({ t, date: day, kind: 'wait', start_time: '14:30' })).rejects.toMatchObject({ status: 429 });
  });

  it('a failed spam check does not use up the customer\'s daily limit', async () => {
    const s = await sql`select rate_limit_contact_per_day as n from arts.shop_settings`;
    const b = body();
    const prev = process.env.TURNSTILE_SECRET_KEY;
    process.env.TURNSTILE_SECRET_KEY = '2x0000000000000000000000000000000AA'; // Cloudflare's always-fail test secret
    try {
      for (let i = 0; i < s[0].n + 1; i++) await postBook(b, `10.1.2.${i}`).catch(() => {});
    } finally {
      process.env.TURNSTILE_SECRET_KEY = prev;
    }
    const [{ count }] = await sql`select count(*)::int from arts.rate_limits where key like ${'book:email:%'}`;
    expect(count).toBe(0);
  });
});

describe('Unsubscribe', () => {
  it('opts the customer out with a signed link and logs it', async () => {
    const [c] = await sql`insert into arts.customers (name, email) values ('U', 'u@example.com') returning id`;
    await postUnsubscribe({ t: signToken({ p: 'unsub', c: c.id }) });
    const [row] = await sql`select email_opt_out from arts.customers where id = ${c.id}`;
    expect(row.email_opt_out).toBe(true);
    await expect(postUnsubscribe({ t: 'bogus.token' })).rejects.toMatchObject({ status: 401 });
  });
});
