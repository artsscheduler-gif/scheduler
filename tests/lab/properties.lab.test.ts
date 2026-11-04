// Randomized rule checks (fast-check). Instead of hand-written cases, each
// property generates many random situations and checks a rule that must
// always hold. When one fails, fast-check shrinks it to the smallest case
// that still fails and prints it with a seed to replay.
// More runs: LAB_RUNS=200 npm run lab.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { sql, resetData } from '../db/helpers';
import { getSettings } from '../../server/db';
import { daily } from '../../server/reminders';
import { planImport, fullYear, parseDate, type Mapping } from '../../server/import';
import { commitImport, loadImportContext } from '../../server/import-db';
import { parseCsv, toCsvString } from '../../shared/csv';
import { normalizePhone, normalizeEmail } from '../../shared/phone';
import { zonedTimeToUtc, localParts, addDays } from '../../shared/time';
import * as V from '../../server/validate';
import { checkScheduling, checkRecords, checkReminders } from './invariants';
import { Clock, TZ, hhmm } from './lib';

const RUNS = Number(process.env.LAB_RUNS ?? 25);
const opts = (n = RUNS) => ({ numRuns: n, ...(process.env.LAB_SEED ? { seed: Number(process.env.LAB_SEED) } : {}) });
const actor = { type: 'admin', label: 'lab' };

afterAll(async () => {
  await sql.end();
});

// ---- Pure functions: cheap, so many runs -----------------------------------------

describe('pure functions', () => {
  it('a CSV written and read back gives the same cells (formula guard aside)', () => {
    fc.assert(fc.property(fc.array(fc.array(fc.string({ unit: 'grapheme' }), { minLength: 3, maxLength: 3 }), { maxLength: 6 }), (rows) => {
      const cols = ['a', 'b', 'c'];
      const back = parseCsv(toCsvString(cols, rows.map((r) => ({ a: r[0], b: r[1], c: r[2] }))));
      const expected = rows.map((r) => r.map((s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)));
      // A row that is all empty cells writes as ",," and reads back as three empties.
      expect(back.slice(1)).toEqual(expected);
    }), opts(500));
  });

  it('phone and email clean-up is stable (cleaning twice changes nothing)', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.stringMatching(/^\+?1?[\s(.-]*[2-9]\d{2}[\s).-]*\d{3}[\s.-]*\d{4}$/)), (raw) => {
      const p = normalizePhone(raw);
      if (p) expect(normalizePhone(p)).toBe(p);
    }), opts(500));
    fc.assert(fc.property(fc.oneof(fc.string(), fc.emailAddress()), (raw) => {
      const e = normalizeEmail(raw);
      if (e) expect(normalizeEmail(e)).toBe(e);
    }), opts(500));
  });

  it('two-digit car years land between 1900 and next year', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 99 }), (yy) => {
      const y = fullYear(yy);
      expect(y).toBeGreaterThanOrEqual(1900);
      expect(y).toBeLessThanOrEqual(new Date().getUTCFullYear() + 1);
      expect(y % 100).toBe(yy);
    }), opts(200));
  });

  it('dates read from TRACS are real calendar dates', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 14 }), fc.integer({ min: 0, max: 33 }), fc.oneof(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1900, max: 2100 })), (m, d, y) => {
      const out = parseDate(`${m}/${d}/${y}`, 'MM/DD/YYYY');
      if (out) {
        const dt = new Date(`${out}T00:00:00Z`);
        expect(dt.toISOString().slice(0, 10)).toBe(out);
        expect(dt.getUTCMonth() + 1).toBe(m);
        expect(dt.getUTCDate()).toBe(d);
      }
    }), opts(500));
  });

  it('shop-local times survive the clock changes (DST)', () => {
    // Every day 2026–2030, any time except the hour that doesn't exist when clocks spring forward.
    fc.assert(fc.property(fc.integer({ min: 0, max: 365 * 5 }), fc.integer({ min: 0, max: 24 * 4 - 1 }), (day, q) => {
      const date = addDays('2026-01-01', day);
      const time = hhmm(q * 15);
      const at = zonedTimeToUtc(date, time, TZ);
      const back = localParts(at, TZ);
      const gap = back.minutes !== q * 15 && q * 15 >= 120 && q * 15 < 180;
      if (!gap) expect({ date: back.date, time: hhmm(back.minutes) }).toEqual({ date, time });
    }), opts(1000));
  });

  it('the booking form rejects junk with a validation message, never a crash', () => {
    const junk = fc.dictionary(
      fc.constantFrom('service_ids', 'customer_notes', 'date', 'kind', 'start_time', 'name', 'email', 'phone', 'vehicle', 'turnstile', 'source', 'k', 'vehicle_id', 'extra'),
      fc.oneof(fc.anything(), fc.string(), fc.constant(null), fc.array(fc.uuid()), fc.record({ year: fc.anything(), make: fc.string(), model: fc.string() })),
    );
    fc.assert(fc.property(junk, (body) => {
      try {
        V.publicBooking(body, 500);
      } catch (e) {
        expect(e).toBeInstanceOf(V.ValidationError);
      }
    }), opts(1000));
  });
});

// ---- Booking rules under random customers, staff, and races ----------------------

type Cmd =
  | { t: 'book'; svc: number[]; day: number; slot: number; kind: 'wait' | 'dropoff'; by: 'public' | 'admin'; who: number }
  | { t: 'race'; svc: number[]; day: number; slot: number; kind: 'wait' | 'dropoff'; n: number }
  | { t: 'cancel'; pick: number }
  | { t: 'move'; pick: number; day: number; slot: number }
  | { t: 'change'; pick: number; day: number; slot: number }
  | { t: 'decide'; pick: number; action: 'approve' | 'decline' }
  | { t: 'reopen'; pick: number }
  | { t: 'status'; pick: number; status: 'completed' | 'no_show' | 'cancelled' };

const svcIdx = fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 2 });
const day = fc.integer({ min: 0, max: 2 });
const slot = fc.integer({ min: 0, max: 22 }); // 07:30 + 30 min steps
const pick = fc.nat(1000);
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('book' as const), svc: svcIdx, day, slot, kind: fc.constantFrom('wait' as const, 'dropoff' as const), by: fc.constantFrom('public' as const, 'admin' as const), who: fc.nat(30) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('race' as const), svc: svcIdx, day, slot, kind: fc.constantFrom('wait' as const, 'dropoff' as const), n: fc.integer({ min: 2, max: 8 }) }) },
  fc.record({ t: fc.constant('cancel' as const), pick }),
  fc.record({ t: fc.constant('move' as const), pick, day, slot }),
  fc.record({ t: fc.constant('change' as const), pick, day, slot }),
  { weight: 2, arbitrary: fc.record({ t: fc.constant('decide' as const), pick, action: fc.constantFrom('approve' as const, 'decline' as const) }) },
  fc.record({ t: fc.constant('reopen' as const), pick }),
  fc.record({ t: fc.constant('status' as const), pick, status: fc.constantFrom('completed' as const, 'no_show' as const, 'cancelled' as const) }),
);
const shopSetup = fc.record({
  total_lanes: fc.integer({ min: 1, max: 3 }),
  waiter_lanes: fc.integer({ min: 1, max: 2 }),
  dropoff_share_pct: fc.integer({ min: 20, max: 100 }),
  blocks: fc.array(fc.record({ day, start: fc.integer({ min: 15, max: 34 }), len: fc.integer({ min: 1, max: 6 }) }), { maxLength: 2 }),
  brakesCap: fc.integer({ min: 1, max: 2 }),
});

describe('booking rules', () => {
  let services: string[];
  let days: string[];
  beforeAll(async () => {
    await resetData();
    services = (await sql`select id::text from arts.services order by sort_order`).map((x) => x.id);
  });

  it('the checks themselves catch an overbooked day', async () => {
    await sql`truncate arts.audit_log, arts.booking_services, arts.bookings, arts.vehicles, arts.customers, arts.time_blocks cascade`;
    await sql`update arts.shop_settings set total_lanes = 1, waiter_lanes = 1 where id = 1`;
    const [{ d }] = await sql`select d::date::text as d from generate_series(arts.today() + 2, arts.today() + 14, interval '1 day') d where extract(isodow from d) <= 5 order by d limit 1`;
    for (let i = 0; i < 3; i++) {
      // Staff override: allowed to break the rules, so the checks must notice.
      await sql`select arts.create_booking(${sql.json({ date: d, kind: 'wait', start_time: '09:00', service_ids: [services[0]], created_by_type: 'admin', override: true,
        customer: { name: `Over Book${i}`, email: `o${i}@example.com`, phone: `+1610555900${i}` }, vehicle: { year: 2015, make: 'Honda', model: 'Fit' }, actor } as any)})`;
    }
    const rules = (await checkScheduling()).map((x) => x.rule);
    expect(rules).toContain('waiter lanes');
  });

  let accepted = 0;
  afterAll(() => {
    // Guard against a vacuous pass: the random runs must actually get bookings in.
    expect(accepted).toBeGreaterThan(RUNS);
  });

  it('no mix of customers, staff and simultaneous bookings ever overbooks', async () => {
    await fc.assert(fc.asyncProperty(shopSetup, fc.array(cmd, { minLength: 5, maxLength: 30 }), async (setup, cmds) => {
      await sql`truncate arts.audit_log, arts.booking_services, arts.bookings, arts.vehicles, arts.customers, arts.time_blocks, arts.rate_limits, arts.service_history cascade`;
      await sql`update arts.shop_settings set total_lanes = ${setup.total_lanes}, waiter_lanes = ${setup.waiter_lanes}, dropoff_share_pct = ${setup.dropoff_share_pct}, max_future_bookings = 3 where id = 1`;
      await sql`update arts.services set daily_cap = ${setup.brakesCap} where name = 'Brakes'`;
      days = (await sql`select d::date::text as d from generate_series(arts.today() + 2, arts.today() + 14, interval '1 day') d where extract(isodow from d) <= 5 order by d limit 3`).map((x) => x.d);
      for (const b of setup.blocks) {
        await sql`insert into arts.time_blocks (date, start_time, end_time) values (${days[b.day]}, ${hhmm(b.start * 30)}, ${hhmm(Math.min(35, b.start + b.len) * 30)})`;
      }
      const at = (d: number, s: number) => ({ date: days[d], start_time: hhmm(450 + s * 30) });
      const live = async () => sql`select id, root_id, status::text from arts.bookings order by created_at, id`;
      const book = (c: { svc: number[]; day: number; slot: number; kind: string }, by: string, who: number) => sql`select arts.create_booking(${sql.json({
        ...at(c.day, c.slot), kind: c.kind, service_ids: c.svc.map((i) => services[i]), created_by_type: by,
        customer: { name: `Lab Person${who}`, email: `p${who}@example.com`, phone: `+1610555${String(1000 + who)}` },
        vehicle: { year: 2015, make: 'Honda', model: 'Civic' }, actor,
      } as any)}) as r`;

      for (const c of cmds) {
        const rows = await live();
        const one = rows.length ? rows[(c as any).pick % rows.length] : null;
        if (c.t === 'book') await book(c, c.by, c.who);
        else if (c.t === 'race') await Promise.all(Array.from({ length: c.n }, (_, i) => book(c, 'public', 100 + i)));
        else if (!one) continue;
        else if (c.t === 'cancel') await sql`select arts.cancel_root(${one.root_id}, ${sql.json(actor)})`;
        else if (c.t === 'move') {
          const [b] = await sql`select kind::text from arts.bookings where id = ${one.id}`;
          const t = at(c.day, c.slot);
          await sql`select arts.move_booking(${one.id}, ${t.date}::date, ${b.kind}::arts.booking_kind, ${t.start_time}::time, false, ${sql.json(actor)})`;
        } else if (c.t === 'change') {
          const [b] = await sql`select kind::text from arts.bookings where id = ${one.id}`;
          const svc = (await sql`select service_id::text from arts.booking_services where booking_id = ${one.id}`).map((x) => x.service_id);
          await sql`select arts.create_booking(${sql.json({ root_id: one.root_id, change_kind: 'reschedule', ...at(c.day, c.slot), kind: b.kind, service_ids: svc, created_by_type: 'customer', actor } as any)})`;
        } else if (c.t === 'decide') await sql`select arts.decide_booking(${one.id}, ${c.action}, ${sql.json(actor)})`;
        else if (c.t === 'reopen') await sql`select arts.set_booking_status(${one.id}, 'confirmed', ${sql.json(actor)})`;
        else if (c.t === 'status') await sql`select arts.set_booking_status(${one.id}, ${c.status}::arts.booking_status, ${sql.json(actor)})`;
      }
      accepted += (await sql`select count(*)::int as n from arts.bookings where status in ('requested', 'confirmed', 'completed')`)[0].n;
      const broken = [...(await checkScheduling()), ...(await checkRecords())];
      expect(broken).toEqual([]);
    }), opts());
  }, 20 * 60_000);
});

// ---- Customer merge -----------------------------------------------------------------

const person = fc.record({
  email: fc.option(fc.constant('x'), { nil: null }),
  phone: fc.option(fc.constant('x'), { nil: null }),
  address: fc.boolean(),
  epicor: fc.boolean(),
  email_opt_out: fc.boolean(),
  mail_opt_out: fc.boolean(),
  email_bounced: fc.boolean(),
  cars: fc.integer({ min: 0, max: 2 }),
  shout: fc.boolean(), // types the car the TRACS way: FORD ESCAPE
  bookings: fc.integer({ min: 0, max: 2 }),
  visits: fc.integer({ min: 0, max: 3 }),
  visitsFromBookings: fc.boolean(),
  reminders: fc.integer({ min: 0, max: 2 }),
});

describe('customer merge', () => {
  it('merge then undo puts both customers back exactly as they were', async () => {
    await resetData();
    const oil = (await sql`select id from arts.services where name = 'Oil change'`)[0].id;
    let n = 0;
    await fc.assert(fc.asyncProperty(person, person, async (a, b) => {
      // Both records often hold the same car and the same visits, typed
      // differently: the merge folds those together and the undo must split them again.
      const make = async (p: typeof a, tag: string) => {
        const i = ++n;
        const [c] = await sql`insert into arts.customers ${sql({
          name: `Pat ${tag}${i}`, email: p.email && `m${i}@example.com`, phone: p.phone && `+1484555${String(1000 + i).slice(-4)}`,
          address_line1: p.address ? `${i} Main St` : null, city: p.address ? 'Allentown' : null, state: p.address ? 'PA' : null, postal_code: p.address ? '18104' : null,
          epicor_id: p.epicor ? `E${i}` : null, email_opt_out: p.email_opt_out, mail_opt_out: p.mail_opt_out, email_bounced: p.email_bounced, source: 'import',
        })} returning id`;
        const cars: string[] = [];
        for (let k = 0; k < p.cars; k++) cars.push((await sql`insert into arts.vehicles (customer_id, year, make, model) values (${c.id}, ${2010 + k}, ${p.shout ? 'FORD' : 'Ford'}, ${p.shout ? 'ESCAPE' : 'Escape'}) returning id`)[0].id);
        const bookings: string[] = [];
        for (let k = 0; k < p.bookings; k++) {
          const [{ r }] = await sql`select arts.create_booking(${sql.json({ customer_id: c.id, vehicle_id: cars[0] ?? null, date: addDays(new Date().toISOString().slice(0, 10), 20 + k), kind: 'dropoff', service_ids: [oil], created_by_type: 'admin', override: true, actor } as any)}) as r`;
          bookings.push(r.booking_id);
        }
        // Finished bookings make their own visit records; imported visits land on the same dates.
        if (p.visitsFromBookings) for (const id of bookings) await sql`select arts.set_booking_status(${id}, 'completed', ${sql.json(actor)})`;
        for (let k = 0; k < p.visits; k++) {
          await sql`insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, source)
            values (${c.id}, ${cars[k % (cars.length || 1)] ?? null}, ${oil}, ${addDays(new Date().toISOString().slice(0, 10), 20 + k)}, 'import')`;
        }
        for (let k = 0; k < p.reminders; k++) {
          await sql`insert into arts.reminder_sends (customer_id, vehicle_id, service_id, due_date, step, channel, status) values (${c.id}, ${cars[0] ?? null}, ${oil}, '2026-06-01', ${k + 1}, 'email', 'sent')`;
        }
        return c.id as string;
      };
      const keep = await make(a, 'K');
      const gone = await make(b, 'M');
      const snap = async () => ({
        customers: await sql`select * from arts.customers where id in (${keep}, ${gone}) order by id`,
        vehicles: await sql`select * from arts.vehicles where customer_id in (${keep}, ${gone}) order by id`,
        bookings: await sql`select id, customer_id, vehicle_id from arts.bookings where customer_id in (${keep}, ${gone}) order by id`,
        history: await sql`select * from arts.service_history where customer_id in (${keep}, ${gone}) order by id`,
        reminders: await sql`select * from arts.reminder_sends where customer_id in (${keep}, ${gone}) order by id`,
      });
      const before = await snap();
      const [{ r }] = await sql`select arts.merge_customers(${keep}, ${gone}, ${sql.json(actor)}) as r`;
      expect(r.ok).toBe(true);
      const [k] = await sql`select * from arts.customers where id = ${keep}`;
      // Nobody who opted out on either record is contacted afterwards.
      expect(k.email_opt_out).toBe(a.email_opt_out || b.email_opt_out);
      expect(k.mail_opt_out).toBe(a.mail_opt_out || b.mail_opt_out);
      expect(k.email_bounced).toBe(a.email_bounced || b.email_bounced);
      const [{ left }] = await sql`select (select count(*) from arts.vehicles where customer_id = ${gone}) + (select count(*) from arts.bookings where customer_id = ${gone})
        + (select count(*) from arts.service_history where customer_id = ${gone}) + (select count(*) from arts.reminder_sends where customer_id = ${gone}) as left`;
      expect(Number(left)).toBe(0);
      // One copy of each car, and of each visit.
      const [{ dupCars }] = await sql`select count(*)::int as "dupCars" from (select 1 from arts.vehicles where customer_id = ${keep} group by year, arts.norm_make(make), arts.norm_text(model) having count(*) > 1) x`;
      expect(dupCars).toBe(0);
      expect(await checkRecords()).toEqual([]);
      await sql`select arts.unmerge_customers(${r.merge_id}, ${sql.json(actor)})`;
      expect(await snap()).toEqual(before);
    }), opts());
  }, 10 * 60_000);
});

// ---- Reminders ----------------------------------------------------------------------

const reminderCustomer = fc.record({
  dueIn: fc.integer({ min: -40, max: 50 }), // days from the first run
  email: fc.boolean(),
  address: fc.boolean(),
  email_opt_out: fc.boolean(),
  mail_opt_out: fc.boolean(),
  email_bounced: fc.boolean(),
  booksOn: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }), // run index after which they book
  optsOutOn: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
});

describe('reminders', () => {
  it('reminders respect opt-outs, stop once someone books, and never repeat', async () => {
    const clock = new Clock();
    await fc.assert(fc.asyncProperty(fc.array(reminderCustomer, { minLength: 1, maxLength: 8 }), fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 12 }), async (people, runDays) => {
      await resetData();
      await sql`update arts.shop_settings set reminders_dry_run = false, postcard_auto_approve = true where id = 1`;
      const oil = (await sql`select id from arts.services where name = 'Oil change'`)[0].id;
      const start = addDays(new Date().toISOString().slice(0, 10), 7);
      const ids: string[] = [];
      for (const [i, p] of people.entries()) {
        const [c] = await sql`insert into arts.customers ${sql({
          name: `Rem Person${i}`, email: p.email ? `r${i}@example.com` : null, source: 'import',
          address_line1: p.address ? `${i} Main St` : null, city: p.address ? 'Allentown' : null, state: p.address ? 'PA' : null, postal_code: p.address ? '18104' : null,
          email_opt_out: p.email_opt_out, mail_opt_out: p.mail_opt_out, email_bounced: p.email_bounced,
        })} returning id`;
        await sql`insert into arts.service_history (customer_id, service_id, service_date, source)
          values (${c.id}, ${oil}, (${addDays(start, p.dueIn)}::date - interval '6 months')::date, 'import')`;
        ids.push(c.id);
      }
      const optOuts = new Map<string, { email?: string; mail?: string }>();
      for (const [i, p] of people.entries()) if (p.email_opt_out || p.mail_opt_out) optOuts.set(ids[i], { email: p.email_opt_out ? '2000-01-01T00:00:00.000Z' : undefined, mail: p.mail_opt_out ? '2000-01-01T00:00:00.000Z' : undefined });
      clock.start();
      try {
        for (const d of [...runDays].sort((x, y) => x - y)) {
          const date = addDays(start, d);
          clock.set(date, '06:00');
          const s = await getSettings();
          await daily(s, clock.now);
          // Running again the same day sends nothing new.
          const again = await daily(s, clock.now);
          expect({ emailed: again.emailed, batched: again.batched }).toEqual({ emailed: 0, batched: 0 });
          clock.set(date, '14:00');
          for (const [i, p] of people.entries()) {
            if (p.booksOn !== null && p.booksOn <= d && !(await sql`select 1 from arts.bookings where customer_id = ${ids[i]}`).length) {
              await sql`select arts.create_booking(${sql.json({ customer_id: ids[i], date: addDays(date, 10), kind: 'dropoff', service_ids: [oil], created_by_type: 'admin', override: true, actor } as any)}, ${clock.now})`;
            }
            if (p.optsOutOn !== null && p.optsOutOn <= d && !optOuts.get(ids[i])?.email) {
              await sql`update arts.customers set email_opt_out = true where id = ${ids[i]}`;
              optOuts.set(ids[i], { ...optOuts.get(ids[i]), email: clock.now.toISOString() });
            }
          }
        }
      } finally {
        clock.stop();
      }
      expect(await checkReminders({ optOuts })).toEqual([]);
      const [{ n }] = await sql`select count(*)::int as n from arts.reminder_sends r join arts.customers c on c.id = r.customer_id
        where r.status = 'sent' and r.channel = 'email' and (c.email is null or c.email_bounced)`;
      expect(n).toBe(0);
    }), opts());
  }, 20 * 60_000);
});

// ---- Import -------------------------------------------------------------------------

const messyName = fc.oneof(
  fc.constantFrom('Mary O’Brien', "SEAN O'NEILL", 'José Núñez', 'van der Berg, Piet', 'Zoë  Müller', 'D’Andre Smith-Jones', '  bob   smith ', 'Nguyễn Văn An', '李 伟', 'Robert "Bobby" Tables', ''),
  fc.string({ maxLength: 30 }),
);
const tracsRow = fc.record({
  'Customer ID': fc.oneof(fc.constant(''), fc.integer({ min: 1, max: 40 }).map((n) => `C${n}`)),
  'Customer Name': messyName,
  Email: fc.oneof(fc.constant(''), fc.emailAddress(), fc.string({ maxLength: 20 }), fc.constantFrom('BOB@EXAMPLE.COM ', 'bob@example')),
  Phone: fc.oneof(fc.constant(''), fc.constantFrom('(610) 555-0101', '610.555.0101', '1-610-555-0101', '555-0101', '+44 20 7946 0958', 'none'), fc.string({ maxLength: 14 })),
  Address: fc.oneof(fc.constant(''), fc.constantFrom('123 North Main Street', '9 W. Walnut St., Apt 2')),
  City: fc.constantFrom('', 'Allentown', 'ALLENTOWN'),
  State: fc.constantFrom('', 'PA', 'Pennsylvania', 'pa.', 'XX'),
  Zip: fc.constantFrom('', '18104', '8104', '18104-1234', 'ABCDE'),
  Year: fc.oneof(fc.constant(''), fc.integer({ min: 0, max: 99 }).map(String), fc.integer({ min: 1900, max: 2030 }).map(String), fc.constantFrom('n/a', '19')),
  Make: fc.constantFrom('', 'FORD', 'Chevy', 'Mercedes-Benz'),
  Model: fc.constantFrom('', 'F-150', 'Equinox', 'C 300'),
  'Last Service Date': fc.oneof(fc.constant(''), fc.constantFrom('02/30/2024', '13/01/2024', '1/5/25', '2024-03-07', 'yesterday'), fc.date({ min: new Date('1995-01-01'), max: new Date('2027-01-01'), noInvalidDate: true }).map((d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`)),
  'Last Service Type': fc.constantFrom('', 'LOF', 'OIL', 'PA State Inspection', 'Rotate Tires', 'ALIGN', 'lof'),
  Mileage: fc.constantFrom('', '45000', '45,000', 'abc'),
  'Email Opt Out': fc.constantFrom('', 'Y', 'no', 'x'),
  'Mail Opt Out': fc.constantFrom('', 'yes', 'N'),
});

describe('TRACS import', () => {
  it('messy rows never crash the import, and importing twice adds nothing', async () => {
    const mapping = JSON.parse(readFileSync('import/epicor-mapping.json', 'utf8')) as Mapping;
    await fc.assert(fc.asyncProperty(fc.array(tracsRow, { minLength: 1, maxLength: 15 }), async (rows) => {
      await resetData();
      const ctx = await loadImportContext();
      const plan = planImport(rows, mapping, ctx.services, ctx.existing);
      for (const c of plan.customers) {
        if (c.email) expect(normalizeEmail(c.email)).toBe(c.email);
        if (c.phone) expect(normalizePhone(c.phone)).toBe(c.phone);
        for (const h of c.history) expect(parseDate(h.service_date, 'YYYY-MM-DD')).toBe(h.service_date);
      }
      const first = await commitImport(plan, 'lab-1');
      expect(first.failed).toEqual([]);
      const ctx2 = await loadImportContext();
      const second = await commitImport(planImport(rows, mapping, ctx2.services, ctx2.existing), 'lab-2');
      expect({ created: second.created, vehicles: second.vehicles, history: second.history, failed: second.failed }).toEqual({ created: 0, vehicles: 0, history: 0, failed: [] });
    }), opts());
  }, 20 * 60_000);
});
