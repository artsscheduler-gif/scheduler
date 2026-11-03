// Admin actions. Every write an admin makes goes through here so it lands in
// the audit log. Callers must pass a verified admin (see requireAdmin).
import { createClient } from '@supabase/supabase-js';
import { db, getSettings, rpc } from './db.js';
import { env } from './env.js';
import { HttpError, type Req, type Result } from './http.js';
import * as V from './validate.js';
import { cancelAttachment, loadBooking, notifyCreated, sendConfirmation, toView, manageLink } from './bookings.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';
import { normalizePhone, normalizeEmail } from '../shared/phone.js';
import { toCsv, EXPORTS } from './export.js';
import { approveBatch, postcardPreview } from './reminders.js';
import { simulatorAction } from './simulator.js';

export interface Admin { id: string; email: string; role: 'owner' | 'staff'; label: string }

function decodeJwt(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// Validates the bearer token with Supabase Auth, then requires an admin role
// and a TOTP-verified (aal2) session.
export async function requireAdmin(req: Req): Promise<Admin> {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, { error: 'unauthenticated' });
  const auth = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } });
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, { error: 'unauthenticated' });
  const role = data.user.app_metadata?.role;
  if (role !== 'owner' && role !== 'staff') throw new HttpError(403, { error: 'forbidden' });
  const claims = decodeJwt(token);
  if (claims.aal !== 'aal2') throw new HttpError(403, { error: 'mfa_required' });
  // Server-side session limit: the free Supabase plan can't time-box sessions,
  // so refuse tokens whose sign-in (earliest amr entry) is older than the setting.
  const signedInAt = Math.min(...((claims.amr ?? []) as { timestamp?: number }[]).map((x) => x.timestamp ?? Infinity));
  if (Number.isFinite(signedInAt)) {
    const s = await getSettings();
    if (Date.now() / 1000 - signedInAt > s.session_timeout_hours * 3600) throw new HttpError(401, { error: 'session_expired' });
  }
  const email = data.user.email ?? '';
  return { id: data.user.id, email, role, label: (data.user.user_metadata?.name as string) || email };
}

const actor = (a: Admin) => ({ type: 'admin', id: a.id, label: a.label });

async function audit(a: Admin, action: string, entity: string, id: string | null, before: unknown, after: unknown) {
  await rpc('audit', { p_actor: actor(a), p_action: action, p_entity: entity, p_entity_id: id, p_before: before, p_after: after });
}

// ---------------------------------------------------------------------------

async function decide(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['booking_id', 'action', 'reason', 'date', 'kind', 'start_time', 'override']);
  const id = V.uuid(b.booking_id, 'booking_id');
  const action = b.action;
  if (!['approve', 'decline', 'propose', 'undo'].includes(action as string)) throw new V.ValidationError('action', 'unknown');
  const reason = V.str(b.reason, 'reason', { max: 500, optional: true }) || null;
  const p_new = action === 'propose' ? { ...V.slot(b), override: b.override === true } : null;

  const before = await loadBooking(id);
  if (!before) throw new HttpError(404, { error: 'not_found' });
  const r = await rpc<{ ok: boolean; error?: string; violations?: string[]; is_change?: boolean; replaced?: string }>('decide_booking', {
    p_booking: id, p_action: action, p_actor: actor(a), p_reason: reason, p_new,
  });
  if (!r.ok) return { status: 409, body: r };

  const s = await getSettings();
  const after = (await loadBooking(id))!;
  if (action === 'approve') {
    await sendConfirmation(s, after);
  } else if (action === 'propose') {
    await sendConfirmation(s, after, 'proposed', reason);
  } else if (action === 'decline') {
    if (r.is_change && r.replaced) {
      const original = (await loadBooking(r.replaced))!;
      await sendEmail(s, { kind: 'change_declined', to: original.customer.email, ...T.changeDeclinedEmail(s, toView(original), reason, manageLink(s, original.booking)), bookingId: id, customerId: original.customer.id });
    } else {
      await sendEmail(s, { kind: 'booking_declined', to: after.customer.email, ...T.declinedEmail(s, toView(after), reason), bookingId: id, customerId: after.customer.id });
    }
  } else if (action === 'undo') {
    await sendEmail(s, { kind: 'booking_review', to: after.customer.email, ...T.reviewingEmail(s, toView(after), manageLink(s, after.booking)), bookingId: id, customerId: after.customer.id });
  }
  return { status: 200, body: r };
}

async function check(body: unknown): Promise<Result> {
  const b = V.obj(body, ['date', 'kind', 'start_time', 'service_ids', 'exclude']);
  const slot = V.slot(b);
  const violations = await rpc<string[]>('check_booking', {
    p_date: slot.date, p_kind: slot.kind, p_start: slot.start_time,
    p_service_ids: V.uuids(b.service_ids, 'service_ids'),
    p_exclude: Array.isArray(b.exclude) ? V.uuids(b.exclude, 'exclude', 0) : [],
  });
  return { status: 200, body: { violations } };
}

async function create(a: Admin, body: unknown): Promise<Result> {
  const s = await getSettings();
  const b = V.obj(body, ['customer_id', 'vehicle_id', 'name', 'email', 'phone', 'vehicle', 'service_ids', 'customer_notes', 'date', 'kind', 'start_time', 'override', 'send_email']);
  const slot = V.slot(b);
  const customerId = b.customer_id ? V.uuid(b.customer_id, 'customer_id') : null;
  const p: Record<string, unknown> = {
    ...slot,
    service_ids: V.uuids(b.service_ids, 'service_ids'),
    customer_notes: V.str(b.customer_notes, 'customer_notes', { max: s.notes_max_length, optional: true }),
    created_by_type: 'admin',
    created_by: a.id,
    override: b.override === true,
    actor: actor(a),
  };
  if (customerId) {
    p.customer_id = customerId;
  } else {
    const email = b.email ? V.email(b.email) : null;
    const phone = b.phone ? V.phone(b.phone) : null;
    if (!email && !phone) throw new V.ValidationError('phone', 'phone or email is required');
    p.customer = { name: V.str(b.name, 'name', { max: 100 }), email, phone };
  }
  if (b.vehicle_id) p.vehicle_id = V.uuid(b.vehicle_id, 'vehicle_id');
  else if (b.vehicle) {
    const v = V.obj(b.vehicle, ['year', 'make', 'model', 'notes'], 'vehicle');
    p.vehicle = {
      year: V.int(v.year, 'vehicle.year', 1950, new Date().getFullYear() + 2, true),
      make: V.str(v.make, 'vehicle.make', { max: 40, optional: true }),
      model: V.str(v.model, 'vehicle.model', { max: 60, optional: true }),
      notes: V.str(v.notes, 'vehicle.notes', { max: 200, optional: true }),
    };
  }
  const r = await rpc<{ ok: boolean; booking_id?: string; violations?: string[] }>('create_booking', { p });
  if (!r.ok) return { status: 409, body: r };
  if (b.send_email !== false) {
    const l = await loadBooking(r.booking_id!);
    if (l?.customer.email) await sendConfirmation(s, l);
  }
  return { status: 200, body: r };
}

async function move(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['booking_id', 'date', 'kind', 'start_time', 'override', 'notify']);
  const id = V.uuid(b.booking_id, 'booking_id');
  const slot = V.slot(b);
  const r = await rpc<{ ok: boolean; violations?: string[] }>('move_booking', {
    p_booking: id, p_date: slot.date, p_kind: slot.kind, p_start: slot.start_time, p_override: b.override === true, p_actor: actor(a),
  });
  if (!r.ok) return { status: 409, body: r };
  const l = await loadBooking(id);
  if (l && b.notify !== false && l.booking.status === 'confirmed') await sendConfirmation(await getSettings(), l, 'proposed');
  return { status: 200, body: r };
}

async function setStatus(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['booking_id', 'status', 'notify', 'override']);
  const id = V.uuid(b.booking_id, 'booking_id');
  if (!['completed', 'cancelled', 'no_show', 'confirmed'].includes(b.status as string)) throw new V.ValidationError('status', 'invalid');
  const r = await rpc<{ ok: boolean; previous?: string; violations?: string[] }>('set_booking_status', {
    p_booking: id, p_status: b.status, p_actor: actor(a), p_override: b.override === true,
  });
  if (!r.ok) return { status: 409, body: r };
  if (b.status === 'cancelled' && b.notify !== false) {
    const s = await getSettings();
    const l = (await loadBooking(id))!;
    await sendEmail(s, { kind: 'booking_cancelled', to: l.customer.email, ...T.cancelledEmail(s, toView(l)), bookingId: id, customerId: l.customer.id, attachments: cancelAttachment(s, l) });
  }
  return { status: 200, body: r };
}

// ---- Customers ------------------------------------------------------------

const CUSTOMER_FIELDS = ['name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
  'email_opt_out', 'mail_opt_out', 'email_bounced', 'address_undeliverable', 'always_review'];

async function updateCustomer(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'fields']);
  const id = V.uuid(b.id, 'id');
  const f = V.obj(b.fields, CUSTOMER_FIELDS, 'fields');
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === 'boolean') patch[k] = v;
    else if (k === 'email') patch.email = v ? (normalizeEmail(String(v)) ?? (() => { throw new V.ValidationError('email', 'invalid'); })()) : null;
    else if (k === 'phone') patch.phone = v ? (normalizePhone(String(v)) ?? (() => { throw new V.ValidationError('phone', 'invalid'); })()) : null;
    else patch[k] = V.str(v, k, { max: k === 'name' ? 100 : 120, optional: k !== 'name' }) || null;
  }
  const { data: before } = await db().from('customers').select('*').eq('id', id).single();
  const { data: after, error } = await db().from('customers').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  await audit(a, 'customer.update', 'customer', id, before, after);
  return { status: 200, body: after };
}

async function updateVehicle(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'customer_id', 'year', 'make', 'model', 'notes']);
  const row = {
    year: V.int(b.year, 'year', 1950, new Date().getFullYear() + 2, true),
    make: V.str(b.make, 'make', { max: 40, optional: true }) || null,
    model: V.str(b.model, 'model', { max: 60, optional: true }) || null,
    notes: V.str(b.notes, 'notes', { max: 200, optional: true }),
  };
  if (b.id) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('vehicles').select('*').eq('id', id).single();
    const { data: after } = await db().from('vehicles').update(row).eq('id', id).select('*').single();
    await audit(a, 'vehicle.update', 'vehicle', id, before, after);
    return { status: 200, body: after };
  }
  const { data: after } = await db().from('vehicles').insert({ ...row, customer_id: V.uuid(b.customer_id, 'customer_id') }).select('*').single();
  await audit(a, 'vehicle.create', 'vehicle', after!.id, null, after);
  return { status: 200, body: after };
}

// Merges a duplicate into the customer being kept, in one transaction, and
// records it so it can be undone (arts.merge_customers / unmerge_customers).
async function mergeCustomers(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['keep_id', 'merge_id']);
  const keep = V.uuid(b.keep_id, 'keep_id');
  const merge = V.uuid(b.merge_id, 'merge_id');
  if (keep === merge) throw new V.ValidationError('merge_id', 'must differ');
  const r = await rpc<{ ok: boolean; error?: string; merge_id?: string }>('merge_customers', { p_keep: keep, p_merge: merge, p_actor: actor(a) });
  if (!r.ok) throw new HttpError(r.error === 'not_found' ? 404 : 409, { error: r.error });
  return { status: 200, body: r };
}

async function unmergeCustomers(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['merge_id']);
  const r = await rpc<{ ok: boolean; error?: string; restored?: string }>('unmerge_customers', { p_merge_id: V.uuid(b.merge_id, 'merge_id'), p_actor: actor(a) });
  if (!r.ok) throw new HttpError(r.error === 'not_found' ? 404 : 409, { error: r.error });
  return { status: 200, body: r };
}

// ---- Settings -------------------------------------------------------------

const SETTINGS_FIELDS: Record<string, 'int' | 'bool' | 'text' | 'time' | 'hours' | 'html'> = {
  shop_name: 'text', shop_phone: 'text', shop_address: 'text', timezone: 'text', booking_url: 'text',
  hours: 'hours', total_lanes: 'int', waiter_lanes: 'int', slot_step_minutes: 'int', buffer_minutes: 'int',
  dropoff_window_start: 'time', dropoff_window_end: 'time', dropoff_share_pct: 'int', floor_days: 'int', max_days_ahead: 'int',
  notes_require_review: 'bool', new_customers_require_review: 'bool', notes_max_length: 'int',
  request_turnaround_business_hours: 'int', escalate_staff_business_hours: 'int', escalate_owner_business_days: 'int',
  ladder_step2_approvals: 'int', ladder_step3_weeks: 'int', undo_window_hours: 'int',
  change_cutoff_hours: 'int', max_future_bookings: 'int', rate_limit_ip_per_hour: 'int', rate_limit_contact_per_day: 'int',
  appointment_reminder_hours: 'int', reminders_dry_run: 'bool', reminder_max_overdue_days: 'int',
  postcard_auto_approve: 'bool', postcard_size: 'text', postcard_cost_cents: 'int', postcard_front_html: 'html', postcard_back_html: 'html',
  from_email: 'text', from_name: 'text', staff_notify_email: 'text', owner_alert_email: 'text', alert_send_failure_pct: 'int',
  session_timeout_hours: 'int', brand_color: 'text', logo_url: 'text',
};

// Sensible bounds, so one bad value can't lock everyone out (timeout 0) or
// break scheduling. Anything not listed falls back to 0..100000.
const INT_RANGE: Record<string, [number, number]> = {
  total_lanes: [1, 20], waiter_lanes: [0, 20], slot_step_minutes: [5, 120], buffer_minutes: [0, 120],
  dropoff_share_pct: [0, 100], floor_days: [0, 60], max_days_ahead: [1, 365], notes_max_length: [50, 2000],
  request_turnaround_business_hours: [1, 72], escalate_staff_business_hours: [1, 72], escalate_owner_business_days: [1, 30],
  ladder_step2_approvals: [1, 1000], ladder_step3_weeks: [1, 52], undo_window_hours: [0, 72], change_cutoff_hours: [0, 336],
  max_future_bookings: [1, 50], rate_limit_ip_per_hour: [1, 1000], rate_limit_contact_per_day: [1, 100],
  appointment_reminder_hours: [1, 168], reminder_max_overdue_days: [0, 3650], postcard_cost_cents: [0, 1000],
  alert_send_failure_pct: [1, 100], session_timeout_hours: [1, 72],
};
const EMAIL_FIELDS = new Set(['from_email', 'staff_notify_email', 'owner_alert_email']);

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseHours(v: unknown) {
  const o = V.obj(v, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], 'hours');
  const out: Record<string, unknown> = {};
  for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const d = o[k];
    if (d === null || d === undefined) { out[k] = null; continue; }
    const dd = V.obj(d, ['open', 'close'], `hours.${k}`);
    const open = V.time(dd.open, `hours.${k}.open`);
    const close = V.time(dd.close, `hours.${k}.close`);
    if (close <= open) throw new V.ValidationError(`hours.${k}`, 'close must be after open');
    out[k] = { open, close };
  }
  return out;
}

async function updateSettings(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, Object.keys(SETTINGS_FIELDS), 'settings');
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    const t = SETTINGS_FIELDS[k];
    if (t === 'int') patch[k] = V.int(v, k, ...(INT_RANGE[k] ?? [0, 100000]));
    else if (EMAIL_FIELDS.has(k)) patch[k] = V.email(v, k);
    else if (t === 'bool') patch[k] = V.bool(v, k);
    else if (t === 'time') patch[k] = V.time(v, k);
    else if (t === 'hours') patch[k] = parseHours(v);
    else if (t === 'html') patch[k] = typeof v === 'string' && v.length <= 20000 ? v : (() => { throw new V.ValidationError(k, 'too long'); })();
    else patch[k] = V.str(v, k, { max: 200, optional: k === 'logo_url' });
  }
  if ('brand_color' in patch && !/^#[0-9a-f]{6}$/i.test(String(patch.brand_color))) throw new V.ValidationError('brand_color', 'must be #rrggbb');
  if ('timezone' in patch && !validTimezone(String(patch.timezone))) throw new V.ValidationError('timezone', 'must be a timezone like America/New_York');
  const { data: before } = await db().from('shop_settings').select('*').eq('id', 1).single();
  // Rules between fields, checked against the values as they'll be saved.
  const m = { ...(before as any), ...patch };
  if (m.waiter_lanes > m.total_lanes) throw new V.ValidationError('waiter_lanes', 'can’t be more than total lanes');
  if (String(m.dropoff_window_end).slice(0, 5) <= String(m.dropoff_window_start).slice(0, 5)) throw new V.ValidationError('dropoff_window_end', 'must be after the earliest drop-off time');
  if (m.floor_days > m.max_days_ahead) throw new V.ValidationError('floor_days', 'can’t be later than the latest online booking day');
  const { data: after, error } = await db().from('shop_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1).select('*').single();
  if (error) throw new V.ValidationError('settings', error.message);
  const changedBefore = Object.fromEntries(Object.keys(patch).map((k) => [k, (before as any)[k]]));
  await audit(a, 'settings.update', 'shop_settings', '1', changedBefore, patch);
  return { status: 200, body: after };
}

async function upsertService(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'name', 'description', 'duration_minutes', 'wait_eligible', 'daily_cap', 'lead_days', 'reminder_interval_months', 'sort_order', 'active', 'epicor_codes']);
  const row: Record<string, unknown> = {
    name: V.str(b.name, 'name', { max: 60 }),
    description: V.str(b.description, 'description', { max: 200, optional: true }),
    duration_minutes: V.int(b.duration_minutes, 'duration_minutes', 5, 600),
    wait_eligible: V.bool(b.wait_eligible, 'wait_eligible'),
    daily_cap: V.int(b.daily_cap, 'daily_cap', 0, 100, true),
    lead_days: V.int(b.lead_days, 'lead_days', 0, 365, true),
    reminder_interval_months: V.int(b.reminder_interval_months, 'reminder_interval_months', 1, 120, true),
    sort_order: V.int(b.sort_order ?? 0, 'sort_order', 0, 1000),
    active: b.active === undefined ? true : V.bool(b.active, 'active'),
  };
  if (Array.isArray(b.epicor_codes)) row.epicor_codes = b.epicor_codes.map((c, i) => V.str(c, `epicor_codes[${i}]`, { max: 40 }));
  if (b.id) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('services').select('*').eq('id', id).single();
    const { data: after } = await db().from('services').update(row).eq('id', id).select('*').single();
    await audit(a, 'service.update', 'service', id, before, after);
    return { status: 200, body: after };
  }
  const { data: after } = await db().from('services').insert(row).select('*').single();
  await audit(a, 'service.create', 'service', after!.id, null, after);
  return { status: 200, body: after };
}

async function setLevel(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['service_id', 'level']);
  const id = V.uuid(b.service_id, 'service_id');
  if (!['approve', 'notify', 'digest'].includes(b.level as string)) throw new V.ValidationError('level', 'invalid');
  const { data: before } = await db().from('services').select('*').eq('id', id).single();
  const { data: after } = await db().from('services').update({ approval_level: b.level, level_since: new Date().toISOString() }).eq('id', id).select('*').single();
  await audit(a, 'service.approval_level', 'service', id, { approval_level: before?.approval_level }, { approval_level: after?.approval_level });
  return { status: 200, body: after };
}

async function closure(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'start_date', 'end_date', 'reason', 'delete']);
  if (b.delete) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('closures').select('*').eq('id', id).single();
    await db().from('closures').delete().eq('id', id);
    await audit(a, 'closure.delete', 'closure', id, before, null);
    return { status: 200, body: { ok: true } };
  }
  const start = V.date(b.start_date, 'start_date');
  const end = b.end_date ? V.date(b.end_date, 'end_date') : start;
  if (end < start) throw new V.ValidationError('end_date', 'must be on or after start');
  const { data } = await db().from('closures').insert({ start_date: start, end_date: end, reason: V.str(b.reason, 'reason', { max: 100, optional: true }) }).select('*').single();
  await audit(a, 'closure.create', 'closure', data!.id, null, data);
  return { status: 200, body: data };
}

// Launch checklist (owner only): tick an item or edit its note.
async function auditItem(a: Admin, body: unknown): Promise<Result> {
  if (a.role !== 'owner') throw new HttpError(403, { error: 'owner_only' });
  const b = V.obj(body, ['id', 'done', 'note']);
  const id = V.uuid(b.id, 'id');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.done !== undefined) {
    const done = V.bool(b.done, 'done');
    Object.assign(patch, { done, done_at: done ? patch.updated_at : null, done_by: done ? a.label : null });
  }
  if (b.note !== undefined) patch.note = V.str(b.note, 'note', { max: 2000, optional: true });
  const { data: before } = await db().from('audit_items').select('done, note').eq('id', id).single();
  if (!before) throw new HttpError(404, { error: 'not_found' });
  const { data: after } = await db().from('audit_items').update(patch).eq('id', id).select('*').single();
  await audit(a, 'checklist.update', 'audit_item', id, before, { done: after!.done, note: after!.note });
  return { status: 200, body: after };
}

// Part-day blocks: one date, or every week on a weekday (1 = Monday).
async function timeBlock(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'date', 'weekday', 'start_time', 'end_time', 'reason', 'delete']);
  if (b.delete) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('time_blocks').select('*').eq('id', id).single();
    await db().from('time_blocks').delete().eq('id', id);
    await audit(a, 'block.delete', 'time_block', id, before, null);
    return { status: 200, body: { ok: true } };
  }
  const weekly = b.weekday !== undefined && b.weekday !== null;
  const row = {
    date: weekly ? null : V.date(b.date, 'date'),
    weekday: weekly ? V.int(b.weekday, 'weekday', 1, 7) : null,
    start_time: V.time(b.start_time, 'start_time'),
    end_time: V.time(b.end_time, 'end_time'),
    reason: V.str(b.reason, 'reason', { max: 100, optional: true }),
  };
  if (row.end_time <= row.start_time) throw new V.ValidationError('end_time', 'must be after the start');
  const { data } = await db().from('time_blocks').insert(row).select('*').single();
  await audit(a, 'block.create', 'time_block', data!.id, null, data);
  return { status: 200, body: data };
}

async function reminderRule(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['id', 'step', 'channel', 'offset_days', 'condition', 'active', 'delete']);
  if (b.delete) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('reminder_rules').select('*').eq('id', id).single();
    await db().from('reminder_rules').update({ active: false }).eq('id', id);
    await audit(a, 'reminder_rule.deactivate', 'reminder_rule', id, before, null);
    return { status: 200, body: { ok: true } };
  }
  if (!['email', 'postcard'].includes(b.channel as string)) throw new V.ValidationError('channel', 'invalid');
  if (!['no_booking_since_due', 'no_booking_since_previous_step'].includes(b.condition as string)) throw new V.ValidationError('condition', 'invalid');
  const row = {
    step: V.int(b.step, 'step', 1, 20),
    channel: b.channel,
    offset_days: V.int(b.offset_days, 'offset_days', -365, 365),
    condition: b.condition,
    active: b.active === undefined ? true : V.bool(b.active, 'active'),
  };
  if (b.id) {
    const id = V.uuid(b.id, 'id');
    const { data: before } = await db().from('reminder_rules').select('*').eq('id', id).single();
    const { data: after, error } = await db().from('reminder_rules').update(row).eq('id', id).select('*').single();
    if (error) throw new V.ValidationError('step', error.message);
    await audit(a, 'reminder_rule.update', 'reminder_rule', id, before, after);
    return { status: 200, body: after };
  }
  const { data: after, error } = await db().from('reminder_rules').insert(row).select('*').single();
  if (error) throw new V.ValidationError('step', error.message);
  await audit(a, 'reminder_rule.create', 'reminder_rule', after!.id, null, after);
  return { status: 200, body: after };
}

async function exportCsv(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['table']);
  const table = String(b.table);
  if (!(table in EXPORTS)) throw new V.ValidationError('table', 'unknown');
  const csv = await toCsv(table as keyof typeof EXPORTS);
  await audit(a, 'export', table, null, null, { rows: csv.split('\n').length - 2 });
  return { status: 200, body: { filename: `arts-${table}-${new Date().toISOString().slice(0, 10)}.csv`, csv } };
}

async function resendManage(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['booking_id']);
  const s = await getSettings();
  const l = await loadBooking(V.uuid(b.booking_id, 'booking_id'));
  if (!l) throw new HttpError(404, { error: 'not_found' });
  if (l.booking.status === 'confirmed') await sendConfirmation(s, l);
  else await notifyCreated(s, l.booking.id);
  await audit(a, 'booking.resend_email', 'booking', l.booking.id, null, null);
  return { status: 200, body: { ok: true } };
}

export async function adminAction(req: Req, action: string, body: unknown): Promise<Result> {
  const a = await requireAdmin(req);
  if (action.startsWith('sim-') || action === 'outbox-clear') return simulatorAction(a, action, body);
  switch (action) {
    case 'decide': return decide(a, body);
    case 'check': return check(body);
    case 'create': return create(a, body);
    case 'move': return move(a, body);
    case 'status': return setStatus(a, body);
    case 'resend': return resendManage(a, body);
    case 'customer': return updateCustomer(a, body);
    case 'vehicle': return updateVehicle(a, body);
    case 'merge': return mergeCustomers(a, body);
    case 'unmerge': return unmergeCustomers(a, body);
    case 'settings': return updateSettings(a, body);
    case 'service': return upsertService(a, body);
    case 'level': return setLevel(a, body);
    case 'closure': return closure(a, body);
    case 'block': return timeBlock(a, body);
    case 'audit-item': return auditItem(a, body);
    case 'rule': return reminderRule(a, body);
    case 'export': return exportCsv(a, body);
    case 'batch-approve': return approveBatch(a, body);
    case 'postcard-preview': return postcardPreview(body);
    default: throw new HttpError(404, { error: 'unknown_action' });
  }
}
