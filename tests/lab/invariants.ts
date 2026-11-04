// Rules that must hold no matter what customers and staff did. Each check
// reads the database directly and recomputes the answer on its own (it does
// not call the scheduling functions it is checking), so a bug in those
// functions shows up here as a broken rule.
import { sql } from '../db/helpers';
import { isoDow, toMin } from './lib';

export interface Broken { rule: string; detail: string }

export interface CheckContext {
  // Days where staff changed hours, blocks or closures after bookings were
  // made: bookings there may legitimately no longer fit, so capacity rules
  // are skipped for them (the lab reports them separately).
  exemptDays?: Set<string>;
  // When each customer opted out, in simulated time (ISO).
  optOuts?: Map<string, { email?: string; mail?: string }>;
  // Only check scheduling on and after this date (older days are history).
  fromDate?: string;
}

const DAY_KEYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function mergedMinutes(ranges: [number, number][]) {
  const rs = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const r of rs) {
    if (!cur || r[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [r[0], r[1]];
    } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

export async function checkScheduling(ctx: CheckContext = {}): Promise<Broken[]> {
  const out: Broken[] = [];
  const [s] = await sql`select * from arts.shop_settings where id = 1`;
  const closures = await sql`select start_date::text as s, end_date::text as e from arts.closures`;
  const blocks = await sql`select date::text as date, weekday, start_time::text as st, end_time::text as en from arts.time_blocks`;
  const bookings = await sql`
    select b.id, b.root_id::text, b.date::text as date, b.kind::text as kind, b.start_time::text as start_time, b.total_minutes, b.status::text as status,
           array(select bs.service_id::text from arts.booking_services bs where bs.booking_id = b.id) as services
    from arts.bookings b
    where b.status in ('requested', 'confirmed', 'completed') and b.date >= ${ctx.fromDate ?? '1900-01-01'}::date`;
  const caps = new Map((await sql`select id::text, name, daily_cap from arts.services where daily_cap is not null`).map((x) => [x.id, x]));

  const byDay = new Map<string, typeof bookings>();
  for (const b of bookings) byDay.set(b.date, [...(byDay.get(b.date) ?? []), b] as any);

  for (const [date, all] of byDay) {
    if (ctx.exemptDays?.has(date)) continue;
    // While a change waits for Chris, the old version keeps its hold too:
    // two versions of one appointment count once (the larger of the two).
    const roots = new Map<string, (typeof all)[number]>();
    for (const b of all) if (!roots.has(b.root_id) || b.total_minutes > roots.get(b.root_id)!.total_minutes) roots.set(b.root_id, b);
    const list = [...roots.values()];
    const h = s.hours[DAY_KEYS[isoDow(date)]] as { open: string; close: string } | null;
    const closed = !h || closures.some((c) => c.s <= date && date <= c.e);
    if (closed) {
      out.push({ rule: 'no bookings on closed days', detail: `${date}: ${all.length} booking(s)` });
      continue;
    }
    const open = toMin(h.open);
    const close = toMin(h.close);
    const dayBlocks = blocks.filter((b) => b.date === date || b.weekday === isoDow(date)).map((b) => [toMin(b.st), toMin(b.en)] as [number, number]);
    const blocked = mergedMinutes(dayBlocks.map(([a, b]) => [Math.max(a, open), Math.min(b, close)]));
    const cap = s.total_lanes * Math.max(0, close - open - blocked);
    const used = list.reduce((n, b) => n + b.total_minutes, 0);
    const drop = list.filter((b) => b.kind === 'dropoff').reduce((n, b) => n + b.total_minutes, 0);
    if (used > cap) out.push({ rule: 'day capacity', detail: `${date}: ${used} booked minutes > ${cap} available` });
    if (drop > Math.floor((cap * s.dropoff_share_pct) / 100)) out.push({ rule: 'drop-off share', detail: `${date}: ${drop} drop-off minutes > ${s.dropoff_share_pct}% of ${cap}` });

    const waiters = all.filter((b) => b.kind === 'wait');
    for (const w of waiters) {
      if (!w.start_time) {
        out.push({ rule: 'waiters have a start time', detail: `${date}: booking ${w.id}` });
        continue;
      }
      const st = toMin(w.start_time);
      const en = st + w.total_minutes;
      if (st < open || en > close) out.push({ rule: 'waiters inside opening hours', detail: `${date} ${w.start_time}: ${w.total_minutes} min, open ${h.open}–${h.close}` });
      if ((st - open) % s.slot_step_minutes) out.push({ rule: 'waiters on the time grid', detail: `${date} ${w.start_time}` });
      if (dayBlocks.some(([a, b]) => st < b && en > a)) out.push({ rule: 'waiters clear of blocked time', detail: `${date} ${w.start_time}` });
      // Concurrent waiters at this waiter's start.
      const at = new Set(all.filter((x) => x.kind === 'wait' && x.start_time && toMin(x.start_time) <= st && toMin(x.start_time) + x.total_minutes > st).map((x) => x.root_id)).size;
      if (at > s.waiter_lanes) out.push({ rule: 'waiter lanes', detail: `${date} ${w.start_time}: ${at} waiters at once (max ${s.waiter_lanes})` });
    }
    for (const d of all.filter((b) => b.kind === 'dropoff' && b.start_time)) {
      const st = toMin(d.start_time);
      if (dayBlocks.some(([a, b]) => st >= a && st < b)) out.push({ rule: 'drop-offs not during blocked time', detail: `${date} ${d.start_time}` });
    }
    for (const [id, svc] of caps) {
      const n = list.filter((b) => b.services.includes(id)).length;
      if (n > svc.daily_cap) out.push({ rule: 'service daily cap', detail: `${date}: ${n} × ${svc.name} (cap ${svc.daily_cap})` });
    }
  }
  return dedupe(out);
}

export async function checkRecords(_ctx: CheckContext = {}): Promise<Broken[]> {
  const out: Broken[] = [];
  for (const r of await sql`
    select root_id, count(*) filter (where status = 'confirmed') as c, count(*) filter (where status = 'requested') as q
    from arts.bookings group by root_id having count(*) filter (where status = 'confirmed') > 1 or count(*) filter (where status = 'requested') > 1`) {
    out.push({ rule: 'one live version per booking', detail: `root ${r.root_id}: ${r.c} confirmed, ${r.q} requested` });
  }
  for (const r of await sql`
    select b.id from arts.bookings b join arts.customers c on c.id = b.customer_id where c.merged_into is not null`) {
    out.push({ rule: 'no bookings left on a merged-away customer', detail: `booking ${r.id}` });
  }
  for (const r of await sql`
    select b.id, b.customer_id, v.customer_id as owner from arts.bookings b join arts.vehicles v on v.id = b.vehicle_id where v.customer_id <> b.customer_id`) {
    out.push({ rule: 'a booking’s car belongs to its customer', detail: `booking ${r.id}` });
  }
  for (const r of await sql`
    select h.id from arts.service_history h join arts.vehicles v on v.id = h.vehicle_id where v.customer_id <> h.customer_id`) {
    out.push({ rule: 'a visit’s car belongs to its customer', detail: `history ${r.id}` });
  }
  for (const r of await sql`
    select b.id, b.status::text, (select count(*) from arts.booking_services bs where bs.booking_id = b.id) as svc,
           (select count(*) from arts.service_history h where h.booking_id = b.id) as hist
    from arts.bookings b
    where (b.status = 'completed') <> exists (select 1 from arts.service_history h where h.booking_id = b.id)
       or (b.status = 'completed' and (select count(*) from arts.service_history h where h.booking_id = b.id) <> (select count(*) from arts.booking_services bs where bs.booking_id = b.id))`) {
    out.push({ rule: 'completed visits (and only those) are in service history', detail: `booking ${r.id} ${r.status}: ${r.hist} history rows for ${r.svc} services` });
  }
  for (const r of await sql`
    select b.id, b.date::text, b.created_at from arts.bookings b
    where b.created_by_type = 'public' and b.change_kind is null
      and b.date < arts.today(b.created_at) + (select floor_days from arts.shop_settings where id = 1)
      and not exists (select 1 from arts.audit_log a where a.entity_id = b.id::text and a.action in ('booking.move', 'booking.move_override', 'booking.propose'))`) {
    out.push({ rule: 'online bookings respect the minimum notice', detail: `booking ${r.id} for ${r.date} made ${r.created_at.toISOString()}` });
  }
  return dedupe(out);
}

export async function checkReminders(ctx: CheckContext = {}): Promise<Broken[]> {
  const out: Broken[] = [];
  const sent = await sql`
    select r.id, r.customer_id::text, r.channel::text, r.status, r.sent_at, r.created_at, r.due_date::text, r.vehicle_id, r.service_id, r.step,
           c.merged_into, c.email_bounced
    from arts.reminder_sends r join arts.customers c on c.id = r.customer_id
    where r.status in ('sent', 'batched')`;
  for (const r of sent) {
    if (r.merged_into) out.push({ rule: 'no reminders on a merged-away customer', detail: `reminder ${r.id}` });
    const o = ctx.optOuts?.get(r.customer_id);
    const at = (r.sent_at ?? r.created_at) as Date;
    const optedAt = r.channel === 'email' ? o?.email : o?.mail;
    if (optedAt && at.toISOString() > optedAt && r.status === 'sent') {
      out.push({ rule: `nobody who opted out of ${r.channel} gets one`, detail: `customer ${r.customer_id}: opted out ${optedAt}, sent ${at.toISOString()}` });
    }
  }
  // The stop rule: once a customer books after the visit that made them due,
  // no further reminder for it.
  for (const r of await sql`
    select r.id, r.customer_id, r.created_at, b.id as booking, b.created_at as booked_at
    from arts.reminder_sends r
    join arts.services s on s.id = r.service_id
    join lateral (
      select max(h.service_date) as last from arts.service_history h
      where h.customer_id = r.customer_id and h.vehicle_id is not distinct from r.vehicle_id and h.service_id = r.service_id
        and (h.service_date + make_interval(months => s.reminder_interval_months))::date = r.due_date
    ) l on true
    join arts.bookings b on b.customer_id = r.customer_id and b.status in ('requested', 'confirmed', 'completed')
      and b.created_at < r.created_at and b.created_at::date > l.last
    where r.status in ('sent', 'batched') and r.channel = 'email'`) {
    out.push({ rule: 'reminders stop once the customer books', detail: `reminder ${r.id}: booked ${r.booked_at.toISOString()}, reminded ${r.created_at.toISOString()}` });
  }
  // An appointment reminder goes once per date the booking had.
  for (const r of await sql`
    select e.booking_id, count(*) as n,
      1 + (select count(*) from arts.audit_log a where a.entity_id = e.booking_id::text and a.action in ('booking.move', 'booking.move_override')) as allowed
    from arts.email_log e where e.kind = 'appointment_reminder' and e.status <> 'failed'
    group by e.booking_id`) {
    if (Number(r.n) > Number(r.allowed)) out.push({ rule: 'one appointment reminder per appointment', detail: `booking ${r.booking_id}: ${r.n} reminders` });
  }
  return dedupe(out);
}

export async function checkAll(ctx: CheckContext = {}) {
  return [...(await checkScheduling(ctx)), ...(await checkRecords(ctx)), ...(await checkReminders(ctx))];
}

function dedupe(xs: Broken[]) {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.rule}|${x.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
