// The five public endpoints (availability, book, cancel, reschedule, change
// services) plus the token-gated manage view. Pure functions so tests can
// call them without HTTP.
import { getSettings, rpc, db, type ShopSettings } from './db.js';
import { HttpError, type Result } from './http.js';
import * as V from './validate.js';
import { verifyTurnstile } from './turnstile.js';
import { verifyToken, type ManageToken, type UnsubToken } from './tokens.js';
import {
  availability, loadBooking, notifyCreated, publicConfig, rootVersions, toView, withinCutoff,
  appointmentStart, type BookingRow,
} from './bookings.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';
import { formatPhone } from '../shared/phone.js';

const SLOT_RULES = new Set([
  'closed', 'before_floor_date', 'lead_days', 'beyond_max_days', 'day_capacity', 'dropoff_share',
  'not_wait_eligible', 'start_required', 'outside_hours', 'off_grid', 'waiter_lanes',
]);

function slotProblem(violations: string[]) {
  return violations.every((v) => SLOT_RULES.has(v) || v.startsWith('daily_cap:'));
}

async function limit(key: string, max: number, windowSeconds: number) {
  const ok = await rpc<boolean>('rate_hit', { p_key: key, p_limit: max, p_window_seconds: windowSeconds });
  if (!ok) throw new HttpError(429, { error: 'rate_limited' });
}

// ---- availability ---------------------------------------------------------

export async function getAvailability(params: URLSearchParams, ip: string): Promise<Result> {
  if (params.get('config') === '1') return { status: 200, body: await publicConfig() };
  const s = await getSettings();
  await limit(`avail:${ip}`, s.rate_limit_ip_per_hour * 30, 3600);
  const services = V.uuids((params.get('services') ?? '').split(',').filter(Boolean), 'services');
  const kind = V.kind(params.get('kind'));
  const date = params.get('date') ? V.date(params.get('date'), 'date') : null;
  let exclude: string[] = [];
  const t = params.get('t');
  if (t) {
    const tok = verifyToken<ManageToken>(t, 'manage');
    if (!tok) throw new HttpError(401, { error: 'invalid_link' });
    const v = await rootVersions(tok.r);
    exclude = v.all.filter((b) => b.status === 'confirmed' || b.status === 'requested').map((b) => b.id);
  }
  // Times or dates only: never names, never counts.
  return { status: 200, body: await availability(services, kind, date, exclude) };
}

// ---- book -----------------------------------------------------------------

export async function postBook(body: unknown, ip: string): Promise<Result> {
  const s = await getSettings();
  const input = V.publicBooking(body, s.notes_max_length);
  await limit(`book:ip:${ip}`, s.rate_limit_ip_per_hour, 3600);
  await limit(`book:email:${input.email}`, s.rate_limit_contact_per_day, 86400);
  await limit(`book:phone:${input.phone}`, s.rate_limit_contact_per_day, 86400);
  if (!(await verifyTurnstile(input.turnstile, ip))) throw new HttpError(400, { error: 'verification_failed' });

  const r = await rpc<{ ok: boolean; booking_id?: string; status?: string; violations?: string[] }>('create_booking', {
    p: {
      date: input.date,
      kind: input.kind,
      start_time: input.start_time,
      service_ids: input.service_ids,
      customer_notes: input.customer_notes,
      customer: { name: input.name, email: input.email, phone: input.phone },
      vehicle: input.vehicle,
      created_by_type: 'public',
      source: input.source,
      actor: { type: 'customer', label: input.name },
    },
  });

  if (!r.ok) {
    const v = r.violations ?? [];
    // Customer-specific refusals look exactly like any other outage.
    if (!slotProblem(v)) throw new HttpError(503, { error: 'unavailable' });
    return { status: 409, body: { error: 'slot_unavailable' } };
  }

  try {
    await notifyCreated(s, r.booking_id!);
  } catch (e) {
    console.error('[book] notify failed', e);
  }

  // The page reflects what a brand-new customer would see, so the response
  // never reveals whether the email or phone matched an existing record.
  const publicStatus = r.status === 'confirmed' && !s.new_customers_require_review ? 'confirmed' : 'requested';
  return {
    status: 200,
    body: {
      status: publicStatus,
      date: input.date,
      kind: input.kind,
      start_time: input.start_time,
      turnaround_hours: s.request_turnaround_business_hours,
    },
  };
}

// ---- manage ---------------------------------------------------------------

async function resolve(token: unknown) {
  const tok = verifyToken<ManageToken>(token, 'manage');
  if (!tok) throw new HttpError(401, { error: 'invalid_link' });
  const v = await rootVersions(tok.r);
  const live = v.confirmed ?? v.pending;
  return { ...v, live, rootId: tok.r };
}

async function describe(s: ShopSettings, b: BookingRow | null) {
  if (!b) return null;
  const l = await loadBooking(b.id);
  if (!l) return null;
  return {
    status: b.status,
    date: b.date,
    kind: b.kind,
    start_time: b.start_time?.slice(0, 5) ?? null,
    when: T.whenText(s, b),
    services: l.services,
    customer_notes: b.customer_notes,
    vehicle: [l.vehicle?.year, l.vehicle?.make, l.vehicle?.model].filter(Boolean).join(' '),
  };
}

export async function getManage(token: unknown): Promise<Result> {
  const s = await getSettings();
  const r = await resolve(token);
  if (!r.live) return { status: 200, body: { state: 'inactive', shop_phone: s.shop_phone } };
  const first = (await loadBooking(r.live.id))?.customer.name.split(' ')[0] ?? '';
  return {
    status: 200,
    body: {
      state: r.confirmed ? 'confirmed' : 'requested',
      name: first,
      current: await describe(s, r.confirmed),
      pending: await describe(s, r.pending),
      can_change: withinCutoff(s, r.live),
      cutoff_hours: s.change_cutoff_hours,
      shop_phone: s.shop_phone,
      notes_max_length: s.notes_max_length,
    },
  };
}

function customerActor(l: { customer: { id: string; name: string } }) {
  return { type: 'customer', id: l.customer.id, label: l.customer.name };
}

export async function postCancel(body: unknown): Promise<Result> {
  const b = V.obj(body, ['t']);
  const s = await getSettings();
  const r = await resolve(b.t);
  if (!r.live) return { status: 200, body: { ok: true, state: 'inactive' } };
  if (!withinCutoff(s, r.live)) throw new HttpError(403, { error: 'too_late', shop_phone: s.shop_phone });
  const shown = r.confirmed ?? r.live;
  const l = (await loadBooking(shown.id))!;
  await rpc('cancel_root', { p_root: r.rootId, p_actor: customerActor(l) });
  try {
    await sendEmail(s, { kind: 'booking_cancelled', to: l.customer.email, ...T.cancelledEmail(s, toView(l)), bookingId: shown.id, customerId: l.customer.id });
    await sendEmail(s, {
      kind: 'staff_cancel',
      to: s.staff_notify_email,
      ...T.staffEmail(s, {
        subject: `Cancelled: ${l.customer.name}, ${T.whenText(s, shown)}`,
        heading: 'A customer cancelled',
        lines: ['The slot and capacity are released.'],
        details: [
          ['Customer', `${l.customer.name} · ${formatPhone(l.customer.phone)}`],
          ['Was', T.whenText(s, shown)],
          ['Service', l.services.map((x) => x.name).join(', ')],
        ],
      }),
      bookingId: shown.id,
    });
  } catch (e) {
    console.error('[cancel] notify failed', e);
  }
  return { status: 200, body: { ok: true, state: 'cancelled' } };
}

async function submitChange(
  token: unknown,
  change: 'reschedule' | 'services',
  next: (latest: BookingRow, serviceIds: string[]) => { slot: V.SlotInput; service_ids: string[]; customer_notes: string },
): Promise<Result> {
  const s = await getSettings();
  const r = await resolve(token);
  if (!r.live) throw new HttpError(409, { error: 'inactive' });
  if (!withinCutoff(s, r.live)) throw new HttpError(403, { error: 'too_late', shop_phone: s.shop_phone });
  // Changes build on the latest version (a pending request replaces the previous one).
  const latest = r.pending ?? r.confirmed!;
  const l = (await loadBooking(latest.id))!;
  const n = next(latest, l.services.map((x) => x.id));
  const res = await rpc<{ ok: boolean; booking_id?: string; violations?: string[] }>('create_booking', {
    p: {
      root_id: r.rootId,
      change_kind: change,
      date: n.slot.date,
      kind: n.slot.kind,
      start_time: n.slot.start_time,
      service_ids: n.service_ids,
      customer_notes: n.customer_notes,
      created_by_type: 'customer',
      actor: customerActor(l),
    },
  });
  if (!res.ok) {
    if (!slotProblem(res.violations ?? [])) throw new HttpError(503, { error: 'unavailable' });
    return { status: 409, body: { error: 'needs_new_slot' } };
  }
  try {
    await notifyCreated(s, res.booking_id!);
  } catch (e) {
    console.error('[change] notify failed', e);
  }
  return { status: 200, body: { ok: true, state: 'requested', turnaround_hours: s.request_turnaround_business_hours } };
}

export async function postReschedule(body: unknown): Promise<Result> {
  const b = V.obj(body, ['t', 'date', 'kind', 'start_time']);
  const slot = V.slot(b);
  return submitChange(b.t, 'reschedule', (latest, serviceIds) => ({
    slot, service_ids: serviceIds, customer_notes: latest.customer_notes,
  }));
}

export async function postChangeServices(body: unknown): Promise<Result> {
  const s = await getSettings();
  const b = V.obj(body, ['t', 'service_ids', 'customer_notes', 'date', 'kind', 'start_time']);
  const serviceIds = V.uuids(b.service_ids, 'service_ids');
  const notes = V.str(b.customer_notes, 'customer_notes', { max: s.notes_max_length, optional: true });
  const newSlot = b.date ? V.slot(b) : null;
  return submitChange(b.t, 'services', (latest) => ({
    slot: newSlot ?? { date: latest.date, kind: latest.kind, start_time: latest.start_time?.slice(0, 5) ?? null },
    service_ids: serviceIds,
    customer_notes: notes,
  }));
}

// ---- unsubscribe ----------------------------------------------------------

export async function postUnsubscribe(body: unknown): Promise<Result> {
  const b = V.obj(body, ['t', 'channel']);
  const tok = verifyToken<UnsubToken>(b.t, 'unsub');
  if (!tok) throw new HttpError(401, { error: 'invalid_link' });
  const channel = b.channel === 'mail' ? 'mail' : 'email';
  const field = channel === 'mail' ? 'mail_opt_out' : 'email_opt_out';
  const { data: before } = await db().from('customers').select('email_opt_out, mail_opt_out').eq('id', tok.c).maybeSingle();
  if (!before) return { status: 200, body: { ok: true } };
  await db().from('customers').update({ [field]: true }).eq('id', tok.c);
  await rpc('audit', {
    p_actor: { type: 'customer', id: tok.c, label: 'unsubscribe link' },
    p_action: `customer.opt_out_${channel}`, p_entity: 'customer', p_entity_id: tok.c,
    p_before: before, p_after: { ...before, [field]: true },
  });
  return { status: 200, body: { ok: true } };
}

export { appointmentStart };
