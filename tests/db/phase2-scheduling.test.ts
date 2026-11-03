import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql, service, resetData, serviceId, weekdayAhead } from './helpers';

afterAll(() => sql.end());

type Svc = 'Oil change' | 'State inspection' | 'Tire rotation' | 'Brakes' | 'Check engine light' | 'Something else';
let ids: Record<Svc, string>;
let day: string;

async function check(date: string, kind: 'wait' | 'dropoff', start: string | null, services: Svc[]) {
  const { data, error } = await service.rpc('check_booking', {
    p_date: date, p_kind: kind, p_start: start, p_service_ids: services.map((s) => ids[s]),
  });
  if (error) throw error;
  return data as string[];
}

let n = 0;
function payload(over: Record<string, unknown> & { services?: Svc[] } = {}) {
  n += 1;
  const { services = ['Oil change'], ...rest } = over;
  return {
    date: day, kind: 'wait', start_time: '09:00', service_ids: services.map((s) => ids[s]),
    customer: { name: `Customer ${n}`, email: `c${n}-${Date.now()}@example.com`, phone: `+1610555${String(1000 + n).slice(-4)}` },
    vehicle: { year: 2015, make: 'Honda', model: 'Civic' },
    customer_notes: '', created_by_type: 'public',
    ...rest,
  };
}

async function book(p: Record<string, unknown>) {
  const { data, error } = await service.rpc('create_booking', { p });
  if (error) throw error;
  return data as { ok: boolean; status?: string; violations?: string[]; booking_id?: string; auto_confirmed?: boolean };
}

async function settings(values: Record<string, unknown>) {
  const { error } = await service.from('shop_settings').update(values).eq('id', 1);
  if (error) throw error;
}

beforeEach(async () => {
  await resetData();
  ids = {
    'Oil change': await serviceId('Oil change'),
    'State inspection': await serviceId('State inspection'),
    'Tire rotation': await serviceId('Tire rotation'),
    Brakes: await serviceId('Brakes'),
    'Check engine light': await serviceId('Check engine light'),
    'Something else': await serviceId('Something else'),
  };
  day = await weekdayAhead(3);
});

describe('Wait booking rules', () => {
  it('allows a valid wait booking', async () => {
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toEqual([]);
  });

  it('rule 1: every service must be wait-eligible', async () => {
    expect(await check(day, 'wait', '09:00', ['Oil change', 'Brakes'])).toContain('not_wait_eligible');
  });

  it('rule 2: concurrent waiters stay at or below waiter lanes', async () => {
    expect((await book(payload({ start_time: '09:00' }))).ok).toBe(true);
    expect((await book(payload({ start_time: '09:00' }))).ok).toBe(true);
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('waiter_lanes');
    // Oil change = 45 + 10 buffer = 55 min, so 09:45 still overlaps both; 10:00 is clear.
    expect(await check(day, 'wait', '09:45', ['Oil change'])).toContain('waiter_lanes');
    expect(await check(day, 'wait', '10:00', ['Oil change'])).toEqual([]);
  });

  it('rule 2: catches waiters that start inside the new job span', async () => {
    await book(payload({ start_time: '10:00' }));
    await book(payload({ start_time: '10:30' }));
    // 09:30 + 70 min (inspection 60 + 10) runs to 10:40, overlapping both.
    expect(await check(day, 'wait', '09:30', ['State inspection'])).toContain('waiter_lanes');
    // 08:30 ends 09:40: clear.
    expect(await check(day, 'wait', '08:30', ['State inspection'])).toEqual([]);
  });

  it('rule 2: waiter lanes are a setting', async () => {
    await settings({ waiter_lanes: 1 });
    await book(payload({ start_time: '09:00' }));
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('waiter_lanes');
  });

  it('rule 3: total booked minutes stay within day capacity', async () => {
    // One lane, 7:30–17:30 = 600 minutes. Fill 550 with a drop-off.
    await settings({ total_lanes: 1, dropoff_share_pct: 100 });
    await sql`update arts.services set duration_minutes = 540 where name = 'Something else'`;
    expect((await book(payload({ kind: 'dropoff', start_time: null, services: ['Something else'] }))).ok).toBe(true);
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('day_capacity');
    expect(await check(day, 'wait', '09:00', ['Tire rotation'])).toEqual([]); // 40 fits in remaining 50
    await sql`update arts.services set duration_minutes = 60 where name = 'Something else'`;
  });

  it('rule 4: daily caps hold', async () => {
    await sql`update arts.services set daily_cap = 1 where name = 'Tire rotation'`;
    await book(payload({ start_time: '09:00', services: ['Tire rotation'] }));
    expect(await check(day, 'wait', '13:00', ['Tire rotation'])).toContain('daily_cap:Tire rotation');
    await sql`update arts.services set daily_cap = null where name = 'Tire rotation'`;
  });

  it('rule 5: floor date, lead days, max days ahead, closures, closed weekdays', async () => {
    const [{ today, sat }] = await sql`select arts.today()::text as today,
      (select d::date::text from generate_series(arts.today() + 3, arts.today() + 10, interval '1 day') d where extract(isodow from d) = 6 limit 1) as sat`;
    expect(await check(today, 'wait', '09:00', ['Oil change'])).toContain('before_floor_date');

    await sql`update arts.services set lead_days = 10 where name = 'Oil change'`;
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('lead_days');
    await sql`update arts.services set lead_days = null where name = 'Oil change'`;

    const [{ far }] = await sql`select (arts.today() + 61)::text as far`;
    expect(await check(far, 'wait', '09:00', ['Oil change'])).toContain('beyond_max_days');

    await sql`insert into arts.closures (start_date, end_date, reason) values (${day}, ${day}, 'Holiday')`;
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('closed');
    expect(await check(sat, 'dropoff', null, ['Oil change'])).toContain('closed');
  });

  it('wait start must be inside open hours and on the slot grid', async () => {
    expect(await check(day, 'wait', '07:00', ['Oil change'])).toContain('outside_hours');
    expect(await check(day, 'wait', '17:00', ['Oil change'])).toContain('outside_hours');
    expect(await check(day, 'wait', '09:05', ['Oil change'])).toContain('off_grid');
  });
});

describe('Drop-off booking rules', () => {
  it('rule 1: drop-off minutes stay within the drop-off share', async () => {
    // 3 lanes x 600 = 1800; 60% = 1080. Brakes = 190 min; cap lifted for this test.
    await sql`update arts.services set daily_cap = null where name = 'Brakes'`;
    for (let i = 0; i < 5; i++) {
      expect((await book(payload({ kind: 'dropoff', start_time: null, services: ['Brakes'] }))).ok).toBe(true);
    }
    // 950 used; another 190 would be 1140 > 1080.
    expect(await check(day, 'dropoff', null, ['Brakes'])).toContain('dropoff_share');
    expect(await check(day, 'dropoff', null, ['Tire rotation'])).toEqual([]); // 40 → 990
    await sql`update arts.services set daily_cap = 1 where name = 'Brakes'`;
  });

  it('rule 2: total booked minutes stay within day capacity', async () => {
    await settings({ total_lanes: 1, dropoff_share_pct: 100, waiter_lanes: 1 });
    for (const t of ['07:30', '08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:30']) {
      await book(payload({ start_time: t, services: ['Oil change'] })); // 55 each, 550 total
    }
    expect(await check(day, 'dropoff', null, ['Oil change'])).toContain('day_capacity');
  });

  it('rule 3: daily caps and date rules apply to drop-offs', async () => {
    await book(payload({ kind: 'dropoff', start_time: null, services: ['Brakes'] }));
    expect(await check(day, 'dropoff', null, ['Brakes'])).toContain('daily_cap:Brakes');
    const [{ today }] = await sql`select arts.today()::text as today`;
    expect(await check(today, 'dropoff', null, ['Oil change'])).toContain('before_floor_date');
  });

  it('wait bookings do not use the drop-off share, drop-offs do not use waiter lanes', async () => {
    await settings({ waiter_lanes: 1 });
    await book(payload({ start_time: '09:00' }));
    expect(await check(day, 'dropoff', null, ['Oil change'])).toEqual([]);
  });
});

describe('Availability', () => {
  it('lists only open start times and only bookable days', async () => {
    const { data: times } = await service.rpc('available_times', { p_service_ids: [ids['Oil change']], p_date: day });
    expect(times[0]).toBe('07:30:00');
    expect(times).toContain('16:30:00'); // 16:30 + 55 = 17:25
    expect(times).not.toContain('16:45:00');
    const { data: days } = await service.rpc('available_days', { p_service_ids: [ids.Brakes], p_kind: 'dropoff' });
    for (const d of days as string[]) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(dow);
    }
    const { data: none } = await service.rpc('available_days', { p_service_ids: [ids.Brakes], p_kind: 'wait' });
    expect(none).toEqual([]);
  });

  it('drop-off times sit on the grid inside the drop-off window', async () => {
    // Seed window: 07:30–15:00.
    expect(await check(day, 'dropoff', '10:00', ['Brakes'])).toEqual([]);
    expect(await check(day, 'dropoff', '15:30', ['Brakes'])).toContain('outside_hours');
    expect(await check(day, 'dropoff', '07:00', ['Brakes'])).toContain('outside_hours');
    expect(await check(day, 'dropoff', '10:10', ['Brakes'])).toContain('off_grid');
  });

  it('lists each open time with whether waiting and drop-off are open', async () => {
    const { data: brakes } = await service.rpc('available_slots', { p_service_ids: [ids.Brakes], p_date: day });
    expect(brakes.every((r: any) => !r.wait && r.dropoff)).toBe(true);
    expect(brakes.at(-1).start_time).toBe('15:00:00');
    const { data: oil } = await service.rpc('available_slots', { p_service_ids: [ids['Oil change']], p_date: day });
    const at = (t: string) => oil.find((r: any) => r.start_time === t);
    expect(at('10:00:00')).toMatchObject({ wait: true, dropoff: true });
    expect(at('16:00:00')).toMatchObject({ wait: true, dropoff: false });
    const { data: days } = await service.rpc('available_slot_days', { p_service_ids: [ids.Brakes] });
    expect((days as string[]).length).toBeGreaterThan(0);
  });
});

describe('Auto-confirm conditions', () => {
  async function returningCustomer() {
    const email = `returning-${Date.now()}@example.com`;
    const [c] = await sql`insert into arts.customers (name, email, source) values ('Returning', ${email}, 'import') returning id`;
    await sql`insert into arts.service_history (customer_id, service_date, source) values (${c.id}, '2025-01-01', 'import')`;
    return { email, id: c.id as string };
  }

  async function allAutoReady() {
    await sql`update arts.services set approval_level = 'notify'`;
    await settings({ notes_require_review: false, new_customers_require_review: false });
  }

  it('launch posture: every booking is requested', async () => {
    const r = await book(payload());
    expect(r.ok).toBe(true);
    expect(r.status).toBe('requested');
  });

  it('auto-confirms when all five conditions hold', async () => {
    await allAutoReady();
    const r = await book(payload());
    expect(r.status).toBe('confirmed');
    expect(r.auto_confirmed).toBe(true);
  });

  it('condition 1: any type still at step 1 forces review', async () => {
    await allAutoReady();
    await sql`update arts.services set approval_level = 'approve' where name = 'Tire rotation'`;
    expect((await book(payload({ services: ['Oil change', 'Tire rotation'] }))).status).toBe('requested');
    expect((await book(payload({ services: ['Oil change'], start_time: '11:00' }))).status).toBe('confirmed');
  });

  it('condition 2: a slot that breaks a rule never books publicly', async () => {
    await allAutoReady();
    const r = await book(payload({ start_time: '09:05' }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('off_grid');
  });

  it('condition 3: notes force review while "notes require review" is on', async () => {
    await allAutoReady();
    await settings({ notes_require_review: true });
    expect((await book(payload({ customer_notes: 'Squeak on left turns' }))).status).toBe('requested');
    expect((await book(payload({ customer_notes: '', start_time: '11:00' }))).status).toBe('confirmed');
    await settings({ notes_require_review: false });
    expect((await book(payload({ customer_notes: 'Squeak', start_time: '13:00' }))).status).toBe('confirmed');
  });

  it('condition 4: always-review customers always go to Chris', async () => {
    await allAutoReady();
    const c = await returningCustomer();
    await sql`update arts.customers set always_review = true where id = ${c.id}`;
    const r = await book(payload({ customer: { name: 'Returning', email: c.email, phone: '' } }));
    expect(r.status).toBe('requested');
  });

  it('condition 5: new customers need review while the setting is on; returning customers do not', async () => {
    await allAutoReady();
    await settings({ new_customers_require_review: true });
    expect((await book(payload())).status).toBe('requested');
    const c = await returningCustomer();
    const r = await book(payload({ start_time: '11:00', customer: { name: 'Returning', email: c.email.toUpperCase(), phone: '' } }));
    expect(r.status).toBe('confirmed');
  });

  it('step 3 (digest) types auto-confirm with digest level; mixed uses notify', async () => {
    await allAutoReady();
    await sql`update arts.services set approval_level = 'digest' where name = 'Oil change'`;
    const a = await book(payload());
    expect(a.status).toBe('confirmed');
    const [row] = await sql`select approval_level, undo_until from arts.bookings where id = ${a.booking_id!}`;
    expect(row.approval_level).toBe('digest');
    expect(row.undo_until).toBeNull();
    const b = await book(payload({ services: ['Oil change', 'Tire rotation'], start_time: '11:00' }));
    const [row2] = await sql`select approval_level, undo_until from arts.bookings where id = ${b.booking_id!}`;
    expect(row2.approval_level).toBe('notify');
    expect(row2.undo_until).not.toBeNull();
  });

  it('a customer may hold at most [3] future bookings', async () => {
    const email = `busy-${Date.now()}@example.com`;
    for (const t of ['08:00', '09:00', '10:00']) {
      expect((await book(payload({ start_time: t, customer: { name: 'Busy', email, phone: '' } }))).ok).toBe(true);
    }
    const r = await book(payload({ start_time: '11:00', customer: { name: 'Busy', email, phone: '' } }));
    expect(r.violations).toContain('customer_limit');
  });
});

describe('Requested bookings hold capacity', () => {
  it('a requested booking blocks its slot like a confirmed one', async () => {
    await settings({ waiter_lanes: 1 });
    const r = await book(payload());
    expect(r.status).toBe('requested');
    expect(await check(day, 'wait', '09:00', ['Oil change'])).toContain('waiter_lanes');
  });
});

describe('Admin override', () => {
  it('admin can book through a broken rule only with override, and the broken rule is recorded', async () => {
    await settings({ waiter_lanes: 1 });
    await book(payload());
    const blocked = await book(payload({ created_by_type: 'admin' }));
    expect(blocked.ok).toBe(false);
    expect(blocked.violations).toContain('waiter_lanes');
    const forced = await book(payload({ created_by_type: 'admin', override: true, actor: { type: 'admin', label: 'Chris' } }));
    expect(forced.ok).toBe(true);
    expect(forced.status).toBe('confirmed');
    const [log] = await sql`select action, after from arts.audit_log where entity_id = ${forced.booking_id!}`;
    expect(log.action).toBe('booking.create_override');
    expect(log.after.violations_overridden).toContain('waiter_lanes');
  });

  it('public requests cannot use override', async () => {
    await settings({ waiter_lanes: 1 });
    await book(payload());
    expect((await book(payload({ override: true }))).ok).toBe(false);
  });
});

describe('Double-booking protection', () => {
  it('20 parallel requests for one wait slot produce exactly [waiter lanes] bookings', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => book(payload({ start_time: '10:00' }))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok).every((r) => r.violations!.includes('waiter_lanes'))).toBe(true);
    const [{ c }] = await sql`select count(*)::int as c from arts.bookings where date = ${day} and start_time = '10:00'`;
    expect(c).toBe(2);
  });

  it('20 parallel requests for a capped service produce exactly the cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(payload({ kind: 'dropoff', start_time: null, services: ['Brakes'] }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('20 parallel drop-offs stop exactly at the drop-off share', async () => {
    // 1 lane x 600 min, 50% share = 300 min; Something else = 70 min → 4 fit.
    await settings({ total_lanes: 1, dropoff_share_pct: 50 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(payload({ kind: 'dropoff', start_time: null, services: ['Something else'] }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(4);
  });
});

describe('Decisions and the approval ladder', () => {
  it('approve confirms and counts toward the ladder; decline resets it', async () => {
    const a = await book(payload());
    const actor = { type: 'admin', label: 'Chris' };
    expect((await service.rpc('decide_booking', { p_booking: a.booking_id, p_action: 'approve', p_actor: actor })).data.ok).toBe(true);
    let [s] = await sql`select approvals_in_a_row from arts.services where name = 'Oil change'`;
    expect(s.approvals_in_a_row).toBe(1);
    const b = await book(payload({ start_time: '11:00' }));
    await service.rpc('decide_booking', { p_booking: b.booking_id, p_action: 'decline', p_actor: actor, p_reason: 'Booked solid' });
    [s] = await sql`select approvals_in_a_row from arts.services where name = 'Oil change'`;
    expect(s.approvals_in_a_row).toBe(0);
  });

  it('undo works only within the window and resets the counter', async () => {
    await sql`update arts.services set approval_level = 'notify', approvals_in_a_row = 20`;
    await settings({ notes_require_review: false, new_customers_require_review: false });
    const a = await book(payload());
    expect(a.status).toBe('confirmed');
    const actor = { type: 'admin', label: 'Chris' };
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const late = await service.rpc('decide_booking', { p_booking: a.booking_id, p_action: 'undo', p_actor: actor, p_now: later });
    expect(late.data.ok).toBe(false);
    const ok = await service.rpc('decide_booking', { p_booking: a.booking_id, p_action: 'undo', p_actor: actor });
    expect(ok.data.ok).toBe(true);
    const [b] = await sql`select status from arts.bookings where id = ${a.booking_id!}`;
    expect(b.status).toBe('requested');
    const [s] = await sql`select approvals_in_a_row, last_undo_at from arts.services where name = 'Oil change'`;
    expect(s.approvals_in_a_row).toBe(0);
    expect(s.last_undo_at).not.toBeNull();
  });

  it('marking completed writes service history', async () => {
    const a = await book(payload({ services: ['Oil change', 'Tire rotation'] }));
    await service.rpc('set_booking_status', { p_booking: a.booking_id, p_status: 'completed', p_actor: { type: 'admin' } });
    const rows = await sql`select service_id from arts.service_history where booking_id = ${a.booking_id!}`;
    expect(rows).toHaveLength(2);
  });
});
