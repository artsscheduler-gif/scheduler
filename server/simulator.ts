// Staging-only test tools: fake customers, fake booking requests, and a
// fast-forward that runs the daily and hourly jobs for a chosen date. Every
// action refuses to run unless APP_ENV=staging. Simulated customers all have
// an @sim.invalid email (a TLD that can never deliver), which is also how
// reset finds them.
import { db, getSettings, rpc } from './db.js';
import { env } from './env.js';
import { HttpError, type Result } from './http.js';
import type { Admin } from './admin.js';
import * as V from './validate.js';
import { daily, today, JOB_BUDGET_MS } from './reminders.js';
import { tick } from './jobs.js';
import { notifyCreated } from './bookings.js';
import { addDays, zonedTimeToUtc } from '../shared/time.js';

export const SIM_DOMAIN = 'sim.invalid';

const FIRST = ['Pat', 'Sam', 'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Riley', 'Drew', 'Dana', 'Lee', 'Robin', 'Kim', 'Terry', 'Chris', 'Leslie', 'Shawn', 'Jesse', 'Avery'];
const LAST = ['Miller', 'Kowalski', 'Nguyen', 'Garcia', 'Schaeffer', 'Reinhart', 'Patel', 'Brennan', 'Fenstermacher', 'Lopez', 'Hoffman', 'Kline', 'Romano', 'Bauer', 'Walsh', 'Kim', 'Yoder', 'Santos', 'Dietrich', 'Okafor'];
const CARS: [string, string][] = [
  ['Honda', 'Accord'], ['Honda', 'CR-V'], ['Toyota', 'Camry'], ['Toyota', 'RAV4'], ['Ford', 'F-150'], ['Ford', 'Escape'],
  ['Chevrolet', 'Silverado'], ['Chevrolet', 'Equinox'], ['Subaru', 'Outback'], ['Jeep', 'Grand Cherokee'], ['Hyundai', 'Elantra'], ['Nissan', 'Rogue'],
];
const STREETS = ['Maple Ave', 'Hamilton St', 'Union Blvd', 'Main St', 'Chestnut St', 'Cedar Crest Blvd', 'Tilghman St', 'Broad St'];
const TOWNS: [string, string][] = [['Allentown', '18104'], ['Bethlehem', '18017'], ['Easton', '18042'], ['Emmaus', '18049'], ['Whitehall', '18052'], ['Macungie', '18062']];
const AREA = ['610', '484', '267', '215', '570', '717', '412', '814', '272', '223'];
const NOTES = ['', '', '', 'Squeaking when I brake', 'Check engine light came on yesterday', 'Can you also check the wipers?', 'Need it back by 4 if possible', 'Pulls to the right a little'];

let seed = Date.now() % 2147483647;
function rand() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function requireStaging() {
  if (!env.staging) throw new HttpError(404, { error: 'unknown_action' });
}

async function audit(a: Admin, action: string, after: unknown) {
  await rpc('audit', { p_actor: { type: 'admin', id: a.id, label: a.label }, p_action: action, p_entity: 'simulator', p_entity_id: null, p_before: null, p_after: after });
}

// Fictional 555-01xx numbers, unique across simulated customers.
async function freePhones(n: number): Promise<string[]> {
  const { data } = await db().from('customers').select('phone').like('email', `%@${SIM_DOMAIN}`);
  const used = new Set((data ?? []).map((r) => r.phone));
  const out: string[] = [];
  for (const area of AREA) {
    for (let i = 0; i < 100 && out.length < n; i++) {
      const p = `+1${area}55501${String(i).padStart(2, '0')}`;
      if (!used.has(p)) out.push(p);
    }
  }
  if (out.length < n) throw new HttpError(409, { error: 'sim_full', message: 'Simulated phone numbers are used up. Reset simulated data first.' });
  return out;
}

function fakePerson(i: number) {
  const first = pick(FIRST);
  const last = pick(LAST);
  return { name: `${first} ${last}`, email: `${first}.${last}.${Date.now().toString(36)}${i}@${SIM_DOMAIN}`.toLowerCase() };
}

// ---- actions -----------------------------------------------------------------

async function status(): Promise<Result> {
  const s = await getSettings();
  const [c, o, b] = await Promise.all([
    db().from('customers').select('id', { count: 'exact', head: true }).like('email', `%@${SIM_DOMAIN}`),
    db().from('email_outbox').select('id', { count: 'exact', head: true }),
    db().from('bookings').select('id', { count: 'exact', head: true }).eq('source', 'sim'),
  ]);
  return {
    status: 200,
    body: { today: today(s), dry_run: s.reminders_dry_run, customers: c.count ?? 0, bookings: b.count ?? 0, outbox: o.count ?? 0, email_provider: env.emailProvider },
  };
}

// Customers with service history spread so their due dates land from
// two months ago to two and a half months ahead: a fast-forward over the next
// few weeks hits every reminder step.
async function customers(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['count']);
  const n = V.int(b.count, 'count', 1, 300)!;
  const s = await getSettings();
  const on = today(s);
  const { data: svcs } = await db().from('services').select('id, reminder_interval_months').eq('active', true).not('reminder_interval_months', 'is', null);
  if (!svcs?.length) throw new HttpError(409, { error: 'no_services', message: 'No active service has a reminder interval.' });
  const phones = await freePhones(n);

  const rows = phones.map((phone, i) => {
    const [town, zip] = pick(TOWNS);
    const hasAddress = !chance(0.1);
    return {
      ...fakePerson(i),
      phone,
      address_line1: hasAddress ? `${100 + Math.floor(rand() * 9000)} ${pick(STREETS)}` : null,
      city: hasAddress ? town : null,
      state: hasAddress ? 'PA' : null,
      postal_code: hasAddress ? zip : null,
      email_opt_out: chance(0.1),
      mail_opt_out: chance(0.05),
      source: 'import',
    };
  });
  const { data: inserted, error } = await db().from('customers').insert(rows).select('id');
  if (error) throw new Error(`sim customers: ${error.message}`);

  const vehicles = inserted!.flatMap((c) => Array.from({ length: chance(0.2) ? 2 : 1 }, () => {
    const [make, model] = pick(CARS);
    return { customer_id: c.id, year: 2008 + Math.floor(rand() * 17), make, model };
  }));
  const { data: vs, error: ve } = await db().from('vehicles').insert(vehicles).select('id, customer_id');
  if (ve) throw new Error(`sim vehicles: ${ve.message}`);

  const history = vs!.flatMap((v) => {
    const chosen = svcs.filter(() => chance(0.6));
    return (chosen.length ? chosen : [pick(svcs)]).map((svc) => {
      const due = addDays(on, Math.floor(rand() * 136) - 60);
      return { customer_id: v.customer_id, vehicle_id: v.id, service_id: svc.id, service_date: addMonths(due, -svc.reminder_interval_months!), source: 'import', raw_service: 'simulated' };
    });
  });
  const { error: he } = await db().from('service_history').insert(history);
  if (he) throw new Error(`sim history: ${he.message}`);

  await audit(a, 'sim.customers', { customers: n, vehicles: vs!.length, history: history.length });
  return { status: 200, body: { customers: n, vehicles: vs!.length, history: history.length } };
}

// Booking requests through the same database function and emails as the
// public form, minus Turnstile and rate limits. Half are returning simulated
// customers, half brand new. An optional slot pins the service and time
// (the staging smoke test uses it to fill and release capacity).
async function bookings(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['count', 'slot']);
  const n = V.int(b.count, 'count', 1, 10)!;
  const fixed = b.slot === undefined ? null : (() => {
    const x = V.obj(b.slot, ['service_id', 'date', 'kind', 'start_time'], 'slot');
    return { service_id: V.uuid(x.service_id, 'slot.service_id'), ...V.slot(x) };
  })();
  const s = await getSettings();
  const { data: svcs } = await db().from('services').select('id, wait_eligible').eq('active', true);
  const { data: existing } = await db().from('customers').select('name, email, phone, vehicles(year, make, model)').like('email', `%@${SIM_DOMAIN}`).is('merged_into', null).limit(500);
  const phones = await freePhones(n);
  const made: { booking_id: string; status: string; date: string }[] = [];
  const failed: string[] = [];

  for (let i = 0; i < n; i++) {
    const returning = existing?.length && chance(0.5) ? pick(existing) : null;
    const who = returning ? { name: returning.name, email: returning.email!, phone: returning.phone! } : { ...fakePerson(i), phone: phones[i] };
    const car = returning?.vehicles?.[0] ?? (() => { const [make, model] = pick(CARS); return { year: 2010 + Math.floor(rand() * 15), make, model }; })();
    const svc = fixed ? { id: fixed.service_id, wait_eligible: fixed.kind === 'wait' } : pick(svcs ?? []);
    const kind = fixed ? fixed.kind : svc.wait_eligible && chance(0.5) ? 'wait' : 'dropoff';
    let date = fixed?.date ?? '';
    let start: string | null = fixed?.start_time ?? null;
    if (!fixed) {
      const days = await rpc<string[]>('available_days', { p_service_ids: [svc.id], p_kind: kind, p_exclude: [] });
      if (!days?.length) { failed.push('no open days'); continue; }
      date = pick(days.slice(0, 15));
    }
    if (!fixed) {
      // Like the public form: every request has a time, waiting or dropping off.
      const slots = await rpc<{ start_time: string; wait: boolean; dropoff: boolean }[]>('available_slots', { p_service_ids: [svc.id], p_date: date, p_exclude: [] });
      const open = (slots ?? []).filter((x) => x[kind]);
      if (!open.length) { failed.push(`no times on ${date}`); continue; }
      start = pick(open).start_time.slice(0, 5);
    }
    const r = await rpc<{ ok: boolean; booking_id?: string; status?: string; violations?: string[] }>('create_booking', {
      p: {
        date, kind, start_time: start, service_ids: [svc.id], customer_notes: pick(NOTES),
        customer: who, vehicle: { year: car.year, make: car.make, model: car.model, notes: '' },
        created_by_type: 'public', source: 'sim', actor: { type: 'customer', label: who.name },
      },
    });
    if (!r.ok) { failed.push((r.violations ?? []).join(', ') || 'refused'); continue; }
    await notifyCreated(s, r.booking_id!);
    made.push({ booking_id: r.booking_id!, status: r.status!, date });
  }
  await audit(a, 'sim.bookings', { made: made.length, failed: failed.length });
  return { status: 200, body: { made, failed } };
}

// Runs the daily job (as of mid-day) and the hourly escalation check (as of
// late afternoon) for one shop-local date. The client calls this once per
// day so each request stays well under the function time limit.
async function day(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['date', 'live']);
  const date = V.date(b.date, 'date');
  const live = b.live === true;
  const s0 = await getSettings();
  const s = live ? { ...s0, reminders_dry_run: false } : s0;
  const started = new Date().toISOString();
  // Same time budget as the real job; the client calls again while `more` is set.
  const summary = await daily(s, zonedTimeToUtc(date, '12:00', s.timezone), Date.now() + JOB_BUDGET_MS);
  const esc = summary.more ? {} : await tick(s, zonedTimeToUtc(date, '16:30', s.timezone));
  const { data: tagged } = await db().from('email_outbox').update({ sim_date: date }).is('sim_date', null).gte('created_at', started).select('id');
  await audit(a, 'sim.day', { date, live });
  return { status: 200, body: { date, ...summary, ...esc, emails: tagged?.length ?? 0 } };
}

async function tickNow(a: Admin): Promise<Result> {
  const s = await getSettings();
  const r = await tick(s);
  await audit(a, 'sim.tick', r);
  return { status: 200, body: r };
}

// Deletes every simulated customer and everything hanging off them. Real
// customers (any other email domain) are never touched.
async function reset(a: Admin): Promise<Result> {
  const { data: cs } = await db().from('customers').select('id').like('email', `%@${SIM_DOMAIN}`);
  const ids = (cs ?? []).map((c) => c.id);
  if (ids.length) {
    const { data: bs } = await db().from('bookings').select('id').in('customer_id', ids);
    const bids = (bs ?? []).map((x) => x.id);
    const del = async (table: string, col: string, vals: string[]) => {
      if (!vals.length) return;
      for (let i = 0; i < vals.length; i += 200) {
        const { error } = await db().from(table).delete().in(col, vals.slice(i, i + 200));
        if (error) throw new Error(`reset ${table}: ${error.message}`);
      }
    };
    await del('email_log', 'customer_id', ids);
    await del('email_log', 'booking_id', bids);
    await del('reminder_sends', 'customer_id', ids);
    await del('service_history', 'customer_id', ids);
    // Change requests point at the versions they replace; clear those links first.
    if (bids.length) await db().from('bookings').update({ replaces_booking_id: null }).in('id', bids);
    await del('bookings', 'id', bids);
    await del('vehicles', 'customer_id', ids);
    await db().from('customers').update({ merged_into: null }).in('merged_into', ids);
    await del('customers', 'id', ids);
  }
  // Draft postcard batches left with nothing in them.
  const { data: drafts } = await db().from('mail_batches').select('id, reminder_sends(id)').eq('status', 'draft');
  const empty = (drafts ?? []).filter((d: any) => !d.reminder_sends?.length).map((d) => d.id);
  if (empty.length) await db().from('mail_batches').delete().in('id', empty);
  await audit(a, 'sim.reset', { customers: ids.length });
  return { status: 200, body: { customers: ids.length } };
}

async function clearOutbox(a: Admin): Promise<Result> {
  const { error } = await db().from('email_outbox').delete().not('id', 'is', null);
  if (error) throw new Error(`clear outbox: ${error.message}`);
  await audit(a, 'sim.outbox_clear', null);
  return { status: 200, body: { ok: true } };
}

export async function simulatorAction(a: Admin, action: string, body: unknown): Promise<Result> {
  requireStaging();
  switch (action) {
    case 'sim-status': return status();
    case 'sim-customers': return customers(a, body);
    case 'sim-bookings': return bookings(a, body);
    case 'sim-day': return day(a, body);
    case 'sim-tick': return tickNow(a);
    case 'sim-reset': return reset(a);
    case 'outbox-clear': return clearOutbox(a);
    default: throw new HttpError(404, { error: 'unknown_action' });
  }
}
