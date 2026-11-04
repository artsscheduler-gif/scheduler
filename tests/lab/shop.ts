// A simulated Art's: customers booking online, Chris answering requests and
// running the day, the nightly reminder job, and a monthly TRACS feed. It
// drives the real database functions and server code with a simulated clock.
//
// The lab knows the truth the app can't see (which records are really the
// same person), so it can tell when the app got that wrong. Anything odd that
// isn't a hard rule break is recorded as a finding for a person to judge.
import { randomUUID } from 'node:crypto';
import { sql } from '../db/helpers';
import { getSettings, type ShopSettings } from '../../server/db';
import { daily } from '../../server/reminders';
import { tick } from '../../server/jobs';
import { closure, timeBlock, type Admin } from '../../server/admin';
import { postUnsubscribe } from '../../server/public';
import { withinCutoff, type BookingRow } from '../../server/bookings';
import { unsubscribeUrl } from '../../server/tokens';
import { addDays } from '../../shared/time';
import { checkScheduling, type CheckContext } from './invariants';
import { Clock, Rng, isoDow, makeCar, makePhone, hhmm, FIRST, LAST, NICK, STREETS, TOWNS, type Car } from './lib';

export interface Person {
  pid: number;
  first: string;
  last: string;
  email: string | null;
  phone: string | null;
  address: { line1: string; city: string; zip: string } | null;
  cars: Car[];
  tracsId: string | null;
  household: number | null;
  // How the tech typed them into TRACS (for people who first booked online).
  variant?: string;
}

const CODES: Record<string, string> = { 'Oil change': 'OIL', 'State inspection': 'INSP', 'Tire rotation': 'ROT', Brakes: 'BRK', 'Check engine light': 'DIAG' };

const CHRIS: Admin = { id: randomUUID(), email: 'chris@example.com', role: 'owner', label: 'Chris (lab)' };
const actorChris = { type: 'admin', id: CHRIS.id, label: CHRIS.label };

export class Shop {
  readonly clock = new Clock();
  readonly people: Person[] = [];
  readonly owner = new Map<string, number>(); // customer id -> person
  readonly ctx: Required<Pick<CheckContext, 'exemptDays' | 'optOuts'>> = { exemptDays: new Set(), optOuts: new Map() };
  readonly findings = new Map<string, string[]>();
  readonly stats: Record<string, number> = {};
  services: { id: string; name: string; wait_eligible: boolean; reminder_interval_months: number | null }[] = [];
  s!: ShopSettings;
  private nextPid = 1;
  private household = 1;

  constructor(readonly rng: Rng) {}

  count(k: string, n = 1) {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }

  find(kind: string, example: string) {
    const xs = this.findings.get(kind) ?? [];
    xs.push(`${this.clock.date}: ${example}`);
    this.findings.set(kind, xs);
  }

  svc(name: string) {
    return this.services.find((x) => x.name === name)!.id;
  }

  // ---- Setup ------------------------------------------------------------------

  async setup() {
    await sql`update arts.shop_settings set reminders_dry_run = false, postcard_auto_approve = true,
      staff_notify_email = 'chris@example.com', owner_alert_email = 'chris@example.com' where id = 1`;
    this.services = (await sql`select id::text, name, wait_eligible, reminder_interval_months from arts.services order by sort_order`) as any;
    this.s = await getSettings();
  }

  newPerson(extra: Partial<Person> = {}): Person {
    const r = this.rng;
    const first = r.pick(FIRST);
    const last = r.pick(LAST);
    const pid = this.nextPid++;
    const slug = `${first}.${last}`.normalize('NFD').replace(/[^A-Za-z.]/g, '').toLowerCase();
    const [city, zip] = r.pick(TOWNS);
    const p: Person = {
      pid, first, last,
      email: r.chance(0.8) ? `${slug}${pid}@example.com` : null,
      phone: makePhone(r),
      address: { line1: `${r.int(10, 9999)} ${r.pick(STREETS)}`, city, zip },
      cars: Array.from({ length: r.weighted([[1, 6], [2, 3], [3, 1]] as [number, number][]) }, () => makeCar(r)),
      tracsId: null,
      household: null,
      ...extra,
    };
    this.people.push(p);
    return p;
  }

  // A spouse or grown kid: same last name, home phone and address, own car,
  // sometimes the same email.
  addHousehold(p: Person) {
    p.household ??= this.household++;
    const r = this.rng;
    return this.newPerson({
      last: p.last, phone: p.phone, address: p.address, household: p.household,
      email: r.weighted<string | null>([[p.email, 2], [`${r.pick(FIRST).toLowerCase()}.${p.pid}h@example.com`, 6], [null, 2]]),
      cars: [makeCar(r)],
    });
  }

  // The starting customer list: people already in TRACS with past visits.
  async seedTracs(n: number, start: string) {
    for (let i = 0; i < n; i++) {
      const p = this.newPerson();
      p.tracsId = `T${String(p.pid).padStart(5, '0')}`;
      const visits = this.pastVisits(p, start);
      await this.importTracs(p, visits);
      if (this.rng.chance(0.12)) {
        const h = this.addHousehold(p);
        h.tracsId = `T${String(h.pid).padStart(5, '0')}`;
        await this.importTracs(h, this.pastVisits(h, start));
      }
    }
  }

  private pastVisits(p: Person, start: string) {
    const out: { car: number; service: string; code: string; date: string }[] = [];
    p.cars.forEach((_, car) => {
      let d = addDays(start, -this.rng.int(20, 700));
      while (d < start) {
        out.push({ car, service: 'Oil change', code: 'OIL', date: d });
        if (this.rng.chance(0.35)) out.push({ car, service: 'Tire rotation', code: 'ROT', date: d });
        if (this.rng.chance(0.3)) out.push({ car, service: 'State inspection', code: 'INSP', date: d });
        d = addDays(d, this.rng.int(150, 260));
      }
    });
    return out;
  }

  // One customer in the TRACS feed, the way the tech typed them in.
  async importTracs(p: Person, visits: { car: number; service: string | null; code: string; date: string }[], typed: Partial<{ name: string; email: string | null; phone: string | null }> = {}) {
    const payload = {
      epicor_id: p.tracsId,
      name: typed.name ?? `${p.first} ${p.last}`.toUpperCase(),
      email: typed.email !== undefined ? typed.email : p.email,
      phone: typed.phone !== undefined ? typed.phone : p.phone,
      address_line1: p.address?.line1.toUpperCase() ?? null,
      city: p.address?.city.toUpperCase() ?? null,
      state: 'PA',
      postal_code: p.address?.zip ?? null,
      email_opt_out: false,
      mail_opt_out: false,
      vehicles: p.cars.map((c, i) => ({ key: String(i), year: c.year, make: c.tracsMake, model: c.model.toUpperCase() })),
      history: visits.map((v) => ({ vehicle_key: String(v.car), service_id: v.service ? this.svc(v.service) : null, raw_service: v.code, service_date: v.date, mileage: null })),
    };
    const [{ r }] = await sql`select arts.import_customer(${sql.json(payload as any)}) as r`;
    const known = this.owner.get(r.customer_id);
    if (known === undefined) this.owner.set(r.customer_id, p.pid);
    else if (known !== p.pid) {
      const other = this.people.find((x) => x.pid === known)!;
      this.find('TRACS import attached a record to a different person', `${p.first} ${p.last} (${p.tracsId}) was matched by ${r.matched} onto ${other.first} ${other.last}${other.household && other.household === p.household ? ' (same household)' : ''}`);
    }
    return r as { customer_id: string; matched: string | null };
  }

  // ---- Customers ----------------------------------------------------------------

  pickServices(): string[] {
    const r = this.rng;
    const main = r.weighted<string>([['Oil change', 40], ['State inspection', 20], ['Tire rotation', 8], ['Brakes', 8], ['Check engine light', 12], ['Something else', 12]]);
    const out = [main];
    if (main === 'Oil change' && r.chance(0.3)) out.push('Tire rotation');
    if (main === 'Oil change' && r.chance(0.1)) out.push('State inspection');
    return out.map((n) => this.svc(n));
  }

  async customerBooks(p: Person, opts: { loggedIn?: boolean } = {}) {
    const r = this.rng;
    const now = this.clock.now;
    const services = this.pickServices();
    const days = (await sql`select d::text as d from arts.available_slot_days(${services}::uuid[], '{}'::uuid[], ${now}) d order by d limit 15`).map((x) => x.d as string);
    if (!days.length) {
      this.count('booking: no open days offered');
      return null;
    }
    const day = days[Math.min(days.length - 1, Math.floor(r.next() ** 2 * days.length))];
    const slots = await sql`select start_time::text, wait, dropoff from arts.available_slots(${services}::uuid[], ${day}::date, '{}'::uuid[], ${now}) where wait or dropoff`;
    if (!slots.length) {
      this.find('a day was offered with no times on it', `${day} for ${services.length} service(s)`);
      return null;
    }
    const slot = r.pick(slots);
    const kind = slot.wait && (!slot.dropoff || r.chance(0.5)) ? 'wait' : 'dropoff';
    const car = r.pick(p.cars);
    let customerId: string | undefined;
    let vehicleId: string | undefined;
    if (opts.loggedIn) {
      // Personal link: books under their own record, picking a saved car.
      customerId = [...this.owner].find(([id, pid]) => pid === p.pid && this.activeIds.has(id))?.[0];
      if (customerId) {
        const [v] = await sql`select id::text from arts.vehicles where customer_id = ${customerId} and year = ${car.year} and lower(model) = ${car.model.toLowerCase()} limit 1`;
        vehicleId = v?.id;
      }
    }
    const payload = {
      ...(customerId ? { customer_id: customerId } : {}),
      ...(vehicleId ? { vehicle_id: vehicleId } : {}),
      date: day, kind, start_time: slot.start_time.slice(0, 5), service_ids: services,
      customer_notes: r.chance(0.2) ? r.pick(['Squeaks when braking', 'Car is making a noise — “clunk”', 'Please call before any work over $200', 'Can you check the wipers too? 🙏']) : '',
      customer: { name: `${p.first} ${p.last}`, email: p.email ?? `${p.pid}.nomail@example.com`, phone: p.phone },
      ...(vehicleId ? {} : { vehicle: { year: car.year, make: car.onlineMake, model: car.model } }),
      created_by_type: 'public',
      actor: { type: 'customer', label: `${p.first} ${p.last}` },
    };
    const [{ res }] = await sql`select arts.create_booking(${sql.json(payload as any)}, ${now}) as res`;
    if (!res.ok) {
      if (res.violations.includes('customer_limit')) this.count('booking: refused, already has the most future bookings');
      else this.find('a time the site offered was refused at booking', `${day} ${slot.start_time} ${kind}: ${res.violations.join(', ')}`);
      return null;
    }
    this.count(`booking: made (${opts.loggedIn ? 'personal link' : 'online form'})`);
    this.claim(res.customer_id, p, 'online booking');
    return res as { booking_id: string; root_id: string; customer_id: string };
  }

  // Who a customer record belongs to. If the app put this person onto
  // someone else's record, that's worth a look.
  private claim(customerId: string, p: Person, how: string) {
    const known = this.owner.get(customerId);
    if (known === undefined) this.owner.set(customerId, p.pid);
    else if (known !== p.pid) {
      const other = this.people.find((x) => x.pid === known)!;
      const why = other.phone === p.phone ? 'same phone' : other.email === p.email ? 'same email' : 'unknown';
      this.find(`${how} landed on another person’s record`, `${p.first} ${p.last} booked as ${other.first} ${other.last} (${why}${other.household === p.household && p.household ? ', same household' : ''})`);
    }
  }

  get activeIds() {
    return new Set(this.owner.keys());
  }

  // Random times, including bad ones, sent straight to the booking function:
  // whatever it accepts must still obey every rule.
  async customerTriesAnything(p: Person) {
    const r = this.rng;
    const services = this.pickServices();
    const date = addDays(this.clock.date, r.int(-2, 70));
    const kind = r.chance(0.5) ? 'wait' : 'dropoff';
    // (The website always sends a time; only staff can leave a drop-off untimed.)
    const start = hhmm(r.int(24, 76) * 15);
    const car = r.pick(p.cars);
    const payload = {
      date, kind, start_time: start, service_ids: services, customer_notes: '',
      customer: { name: `${p.first} ${p.last}`, email: p.email ?? `${p.pid}.nomail@example.com`, phone: p.phone },
      vehicle: { year: car.year, make: car.onlineMake, model: car.model }, created_by_type: 'public', actor: { type: 'customer', label: 'lab' },
    };
    const [{ res }] = await sql`select arts.create_booking(${sql.json(payload as any)}, ${this.clock.now}) as res`;
    this.count(res.ok ? 'random attempt: accepted' : 'random attempt: refused');
    if (res.ok) {
      this.claim(res.customer_id, p, 'online booking');
    }
  }

  async customerChangesMind() {
    const r = this.rng;
    const live = await sql`
      select b.id, b.root_id, b.replaces_booking_id, b.date::text as date, b.kind::text as kind, b.start_time::text as start_time, b.status::text as status, b.customer_notes from arts.bookings b where b.status in ('confirmed', 'requested') and b.date > ${this.clock.date}::date
        and not exists (select 1 from arts.bookings x where x.root_id = b.root_id and x.status = 'requested' and x.id <> b.id and b.status = 'confirmed')`;
    for (const b of live as unknown as BookingRow[]) {
      const roll = r.next();
      if (roll > 0.05) continue;
      if (!withinCutoff(this.s, b, this.clock.now)) {
        this.count('change: too late to change online');
        continue;
      }
      if (roll < 0.018) {
        await sql`select arts.cancel_root(${b.root_id}, ${sql.json({ type: 'customer', label: 'lab' })}, ${this.clock.now})`;
        this.count('change: customer cancelled');
        continue;
      }
      const services = (await sql`select service_id::text from arts.booking_services where booking_id = ${b.id}`).map((x) => x.service_id);
      const exclude = (await sql`select id from arts.bookings where root_id = ${b.root_id} and status in ('confirmed', 'requested')`).map((x) => x.id);
      const days = (await sql`select d::text as d from arts.available_slot_days(${services}::uuid[], ${exclude}::uuid[], ${this.clock.now}) d order by d limit 10`).map((x) => x.d);
      if (!days.length) continue;
      const day = r.pick(days);
      const slots = await sql`select start_time::text, wait, dropoff from arts.available_slots(${services}::uuid[], ${day}::date, ${exclude}::uuid[], ${this.clock.now}) where wait or dropoff`;
      if (!slots.length) continue;
      const slot = r.pick(slots);
      const kind = slot.wait ? 'wait' : 'dropoff';
      const next = { ...b, date: day, kind, start_time: slot.start_time } as BookingRow;
      if (!withinCutoff(this.s, next, this.clock.now)) continue;
      const [{ res }] = await sql`select arts.create_booking(${sql.json({
        root_id: b.root_id, change_kind: 'reschedule', date: day, kind, start_time: slot.start_time.slice(0, 5), service_ids: services,
        customer_notes: b.customer_notes, created_by_type: 'customer', actor: { type: 'customer', label: 'lab' },
      } as any)}, ${this.clock.now}) as res`;
      if (res.ok) this.count('change: customer asked to reschedule');
      else this.find('a time the site offered was refused on reschedule', `${day} ${slot.start_time} ${kind}: ${res.violations.join(', ')}`);
    }
  }

  // Opt-outs come from the unsubscribe link in a reminder email.
  async someoneUnsubscribes() {
    const got = await sql`select distinct r.customer_id::text from arts.reminder_sends r join arts.customers c on c.id = r.customer_id
      where r.status = 'sent' and r.sent_at::date = ${this.clock.date}::date and not c.email_opt_out`;
    for (const { customer_id } of got) {
      if (!this.rng.chance(0.05)) continue;
      const channel = this.rng.chance(0.7) ? 'email' : 'mail';
      const t = new URL(unsubscribeUrl(customer_id)).searchParams.get('t');
      await postUnsubscribe({ t, channel });
      const o = this.ctx.optOuts.get(customer_id) ?? {};
      o[channel] ??= this.clock.now.toISOString();
      this.ctx.optOuts.set(customer_id, o);
      this.count(`opt-out: ${channel}`);
    }
  }

  // ---- Chris --------------------------------------------------------------------

  async chrisAnswersRequests() {
    const r = this.rng;
    const pending = await sql`select b.id, b.root_id, b.replaces_booking_id, b.date::text as date, b.kind::text as kind, b.start_time::text as start_time, b.status::text as status, b.customer_notes, array(select service_id::text from arts.booking_services where booking_id = b.id) as services
      from arts.bookings b where b.status = 'requested' order by b.created_at`;
    for (const b of pending) {
      if (r.chance(0.08)) continue; // busy; gets to it later
      const roll = r.next();
      if (roll < 0.85 || b.date <= this.clock.date) {
        const [{ res }] = await sql`select arts.decide_booking(${b.id}, 'approve', ${sql.json(actorChris)}, null, null, ${this.clock.now}) as res`;
        this.count(res.ok ? 'chris: approved' : 'chris: approve failed');
      } else if (roll < 0.93) {
        const exclude = [b.id, b.replaces_booking_id].filter(Boolean);
        const days = (await sql`select d::text as d from arts.available_slot_days(${b.services}::uuid[], ${exclude}::uuid[], ${this.clock.now}) d order by d limit 6`).map((x) => x.d);
        const day = days.length ? r.pick(days) : null;
        const slots = day ? await sql`select start_time::text, wait, dropoff from arts.available_slots(${b.services}::uuid[], ${day}::date, ${exclude}::uuid[], ${this.clock.now}) where wait or dropoff` : [];
        if (!slots.length) continue;
        const slot = r.pick(slots);
        const kind = slot.wait && b.kind === 'wait' ? 'wait' : slot.dropoff ? 'dropoff' : 'wait';
        const [{ res }] = await sql`select arts.decide_booking(${b.id}, 'propose', ${sql.json(actorChris)}, 'Earlier slot is full', ${sql.json({ date: day, kind, start_time: slot.start_time.slice(0, 5) })}, ${this.clock.now}) as res`;
        if (res.ok) this.count('chris: offered another time');
        else this.find('Chris couldn’t offer a time the system listed as open', `${day} ${slot.start_time} ${kind}: ${(res.violations ?? [res.error]).join(', ')}`);
      } else {
        await sql`select arts.decide_booking(${b.id}, 'decline', ${sql.json(actorChris)}, 'Can’t fit this one in', null, ${this.clock.now})`;
        this.count('chris: declined');
      }
    }
  }

  async chrisMovesOne() {
    const r = this.rng;
    const [b] = await sql`select b.id, b.root_id, b.replaces_booking_id, b.date::text as date, b.kind::text as kind, b.start_time::text as start_time, b.status::text as status, b.customer_notes, array(select service_id::text from arts.booking_services where booking_id = b.id) as services
      from arts.bookings b where b.status = 'confirmed' and b.date > ${this.clock.date}::date order by random() limit 1`;
    if (!b) return;
    const exclude = [b.id, b.replaces_booking_id].filter(Boolean);
    const days = (await sql`select d::text as d from arts.available_slot_days(${b.services}::uuid[], ${exclude}::uuid[], ${this.clock.now}) d order by d limit 8`).map((x) => x.d);
    if (!days.length) return;
    const day = r.pick(days);
    const [slot] = await sql`select start_time::text, wait, dropoff from arts.available_slots(${b.services}::uuid[], ${day}::date, ${exclude}::uuid[], ${this.clock.now}) where (wait and ${b.kind} = 'wait') or (dropoff and ${b.kind} = 'dropoff') order by random() limit 1`;
    if (!slot) return;
    const [{ res }] = await sql`select arts.move_booking(${b.id}, ${day}::date, ${b.kind}::arts.booking_kind, ${slot.start_time}::time, false, ${sql.json(actorChris)}, ${this.clock.now}) as res`;
    if (res.ok) this.count('chris: moved a booking');
    else this.find('Chris couldn’t move a booking to a time the system listed as open', `${day} ${slot.start_time}: ${res.violations.join(', ')}`);
  }

  // Chris blocks time or closes a day without looking at what's booked.
  async chrisChangesTheCalendar(what: 'block' | 'closure') {
    const r = this.rng;
    let date = addDays(this.clock.date, r.int(3, 21));
    while (!this.s.hours[(['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[isoDow(date)] as keyof ShopSettings['hours']]) date = addDays(date, 1);
    const before = (await checkScheduling({ fromDate: date })).filter((x) => x.detail.startsWith(date)).length;
    if (what === 'block') {
      const st = r.pick([8 * 60, 10 * 60, 12 * 60, 14 * 60]);
      await timeBlock(CHRIS, { date, start_time: hhmm(st), end_time: hhmm(st + r.pick([60, 120, 180])), reason: 'Parts run' });
      this.count('chris: blocked time');
    } else {
      await closure(CHRIS, { start_date: date, end_date: date, reason: 'Family event' });
      this.count('chris: closed a day');
    }
    const after = await checkScheduling({ fromDate: date });
    const hit = after.filter((x) => x.detail.startsWith(date));
    if (hit.length > before) {
      this.ctx.exemptDays.add(date);
      const [{ n }] = await sql`select count(*)::int as n from arts.bookings where date = ${date}::date and status in ('requested', 'confirmed')`;
      this.find(`Chris ${what === 'block' ? 'blocked time' : 'closed a day'} over existing bookings, with no warning`, `${date}: ${n} booking(s) already there (${hit.map((h) => h.rule).join(', ')})`);
    }
  }

  // End of day: who showed up.
  async closeOutDay() {
    const today = this.clock.date;
    for (const b of await sql`select id, status::text from arts.bookings where date = ${today}::date and status in ('confirmed', 'requested')`) {
      if (b.status === 'requested') {
        this.find('a request was still unanswered on its appointment day', `booking ${b.id}`);
        await sql`select arts.decide_booking(${b.id}, 'approve', ${sql.json(actorChris)}, null, null, ${this.clock.now})`;
      }
      const status = this.rng.chance(0.93) ? 'completed' : 'no_show';
      const [{ res }] = await sql`select arts.set_booking_status(${b.id}, ${status}::arts.booking_status, ${sql.json(actorChris)}, false, ${this.clock.now}) as res`;
      if (!res.ok) this.find('couldn’t mark a visit done', `booking ${b.id}: ${res.error ?? res.violations}`);
      else this.count(`visit: ${status}`);
    }
  }

  // ---- Jobs ---------------------------------------------------------------------

  async nightlyJob() {
    this.s = await getSettings();
    const r = await daily(this.s, this.clock.now);
    for (const k of ['emailed', 'batched', 'skipped', 'failed', 'appointment_reminders']) if (r[k]) this.count(`reminders: ${k}`, Number(r[k]));
  }

  async hourlyJob() {
    const r = await tick(this.s, this.clock.now);
    if (r.escalated_staff) this.count('escalation: staff reminded', Number(r.escalated_staff));
    if (r.escalated_owner) this.count('escalation: owner alerted', Number(r.escalated_owner));
  }

  // ---- Monthly TRACS feed --------------------------------------------------------
  // People who first booked online were typed into TRACS by the tech at their
  // first visit, a little differently each time. The feed brings them back in.

  async monthlyTracsFeed() {
    const r = this.rng;
    const completed = await sql`
      select b.customer_id::text, b.date::text, bs.service_id::text, v.year, v.model
      from arts.bookings b join arts.booking_services bs on bs.booking_id = b.id left join arts.vehicles v on v.id = b.vehicle_id
      where b.status = 'completed'`;
    const visitsOf = (p: Person) => completed.filter((x) => this.owner.get(x.customer_id) === p.pid).map((x) => ({
      car: Math.max(0, p.cars.findIndex((c) => c.year === x.year && c.model.toLowerCase() === String(x.model ?? '').toLowerCase())),
      service: this.services.find((s) => s.id === x.service_id)!.name,
      code: CODES[this.services.find((s) => s.id === x.service_id)!.name] ?? 'MISC',
      date: x.date,
    }));
    let fed = 0;
    for (const p of this.people) {
      const visits = visitsOf(p);
      if (!p.tracsId && !visits.length) continue; // never came in
      let typed: Parameters<Shop['importTracs']>[2] = {};
      if (!p.tracsId) {
        p.tracsId = `W${String(p.pid).padStart(5, '0')}`;
        p.variant = r.weighted<string>([['exact', 4], ['no email', 2], ['nickname, new phone', 2], ['typo in last name', 1], ['work phone, no email', 1]]);
      }
      if (p.variant) {
        const nick = NICK[p.first] ?? p.first;
        typed = {
          'exact': {},
          'no email': { email: null },
          'nickname, new phone': { name: `${nick} ${p.last}`.toUpperCase(), phone: makePhone(r), email: null },
          'typo in last name': { name: `${p.first} ${p.last.slice(0, -1)}${p.last.endsWith('y') ? 'i' : 'y'}`.toUpperCase(), email: null, phone: makePhone(r) },
          'work phone, no email': { phone: makePhone(r), email: null },
        }[p.variant]!;
      }
      await this.importTracs(p, visits, typed);
      fed++;
    }
    this.count('tracs feed: customers imported', fed);
    await this.reviewMatches();
  }

  // Customers → Possible matches: merge the real ones, dismiss the rest.
  async reviewMatches() {
    const cands = await sql`select app_id::text, tracs_id::text, reasons from arts.customer_match_candidates()`;
    const done = new Set<string>();
    for (const c of cands) {
      if (done.has(c.app_id)) continue;
      const a = this.owner.get(c.app_id);
      const t = this.owner.get(c.tracs_id);
      if (a !== undefined && a === t) {
        const [{ res }] = await sql`select arts.merge_customers(${c.tracs_id}, ${c.app_id}, ${sql.json(actorChris)}) as res`;
        if (!res.ok) this.find('a merge from the match list failed', `${res.error}`);
        else {
          this.count('matches: merged');
          done.add(c.app_id);
          // Now and then someone merges by mistake and undoes it.
          if (this.rng.chance(0.1)) {
            await sql`select arts.unmerge_customers(${res.merge_id}, ${sql.json(actorChris)})`;
            this.count('matches: merge undone');
          }
        }
      } else {
        const pa = this.people.find((x) => x.pid === a);
        const pt = this.people.find((x) => x.pid === t);
        this.find('the match list suggested two different people', `${pa?.first} ${pa?.last} vs ${pt?.first} ${pt?.last} (${c.reasons.join(', ')})${pa?.household && pa.household === pt?.household ? ' — same household' : ''}`);
        await sql`insert into arts.customer_match_dismissals (app_id, tracs_id) values (${c.app_id}, ${c.tracs_id}) on conflict do nothing`;
        this.count('matches: dismissed');
      }
    }
    // People who still have a separate online record the list never offered.
    const app = await sql`select id::text from arts.customers where epicor_id is null and merged_into is null`;
    const tracs = await sql`select id::text from arts.customers where epicor_id is not null and merged_into is null`;
    const tracsOwners = new Set(tracs.map((x) => this.owner.get(x.id)));
    for (const { id } of app) {
      const pid = this.owner.get(id);
      if (pid === undefined || !tracsOwners.has(pid)) continue;
      if (cands.some((c) => c.app_id === id)) continue;
      const p = this.people.find((x) => x.pid === pid)!;
      this.find('a person’s online record and TRACS record were never matched', `${p.first} ${p.last} (typed into TRACS as: ${p.variant ?? 'exact'})`);
    }
  }

  // ---- Data quality after the feed -----------------------------------------------

  async dataQuality() {
    for (const r of await sql`
      select c.name, v.year, lower(v.model) as model, count(*)::int as n from arts.vehicles v join arts.customers c on c.id = v.customer_id
      where c.merged_into is null group by c.id, c.name, v.year, lower(v.model) having count(*) > 1`) {
      this.find('the same car appears twice on one customer', `${r.name}: ${r.year} ${r.model} × ${r.n}`);
    }
    for (const r of await sql`
      select c.name, h.service_date::text as d, s.name as svc, count(*)::int as n
      from arts.service_history h join arts.customers c on c.id = h.customer_id join arts.services s on s.id = h.service_id
      where c.merged_into is null group by c.id, c.name, h.service_date, s.name having count(*) > 1`) {
      this.find('the same visit appears twice in a customer’s history', `${r.name}: ${r.svc} on ${r.d} × ${r.n}`);
    }
    for (const r of await sql`
      select c.name, count(*)::int as n from arts.reminder_sends r1 join arts.customers c on c.id = r1.customer_id
      where r1.status in ('sent', 'batched') and r1.created_at > ${this.clock.now}::timestamptz - interval '7 days'
      group by c.id, c.name having count(*) > 2`) {
      this.find('a customer got more than 2 reminders in a week', `${r.name}: ${r.n}`);
    }
  }
}

