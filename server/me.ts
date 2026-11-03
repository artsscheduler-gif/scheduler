// Returning customers on the booking page: who they are and which cars we
// have for them, unlocked by a booking key (BookToken) from a reminder link,
// a postcard QR code, or a 6-digit code emailed to an address on file.
import { createHash, randomInt } from 'node:crypto';
import { db, getSettings, rpc } from './db.js';
import { HttpError, type Result } from './http.js';
import * as V from './validate.js';
import { bookToken, verifyToken, type BookToken } from './tokens.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';
import { manageLink } from './bookings.js';

const CODE_MINUTES = 10;
const CODE_TRIES = 5;

const hash = (email: string, code: string) => createHash('sha256').update(`${email}:${code}`).digest('hex');

async function limit(key: string, max: number, windowSeconds: number) {
  const ok = await rpc<boolean>('rate_hit', { p_key: key, p_limit: max, p_window_seconds: windowSeconds });
  if (!ok) throw new HttpError(429, { error: 'rate_limited' });
}

export interface Profile { name: string; email: string | null; phone: string | null; vehicles: { id: string; label: string }[] }

// The customer behind a booking key, or null if the key is bad, expired, or
// the customer was merged away or removed.
export async function customerFromKey(k: unknown): Promise<{ id: string; profile: Profile } | null> {
  const tok = verifyToken<BookToken>(k, 'book');
  if (!tok) return null;
  const { data: c } = await db().from('customers').select('id, name, email, phone, merged_into').eq('id', tok.c).maybeSingle();
  if (!c || c.merged_into || c.name === 'Removed customer') return null;
  const { data: vs } = await db().from('vehicles').select('id, year, make, model, notes').eq('customer_id', c.id).order('created_at');
  return {
    id: c.id,
    profile: {
      name: c.name, email: c.email, phone: c.phone,
      vehicles: (vs ?? []).map((v) => ({ id: v.id, label: [v.year, v.make, v.model].filter(Boolean).join(' ') + (v.notes ? ` (${v.notes})` : '') })).filter((v) => v.label.trim()),
    },
  };
}

export async function getMe(k: unknown): Promise<Result> {
  const me = await customerFromKey(k);
  if (!me) throw new HttpError(401, { error: 'invalid_link' });
  return { status: 200, body: me.profile };
}

// Sends a code if the email is on file. The answer is the same either way, so
// nobody can use this to learn who is a customer.
export async function postMeCode(body: unknown, ip: string): Promise<Result> {
  const b = V.obj(body, ['email']);
  const email = V.email(b.email);
  await limit(`code:ip:${ip}`, 20, 3600);
  await limit(`code:email:${email}`, 5, 3600);
  const { data: c } = await db().from('customers').select('id').eq('email', email).is('merged_into', null).limit(1).maybeSingle();
  if (c) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db().from('login_codes').insert({ email, code_hash: hash(email, code), expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString() });
    const s = await getSettings();
    await sendEmail(s, {
      kind: 'login_code', to: email, customerId: c.id,
      ...T.staffEmail(s, {
        subject: `${code} is your ${s.shop_name} code`,
        heading: `Your code: ${code}`,
        lines: [`Enter this code on the booking page to see your cars and details. It works for ${CODE_MINUTES} minutes.`, 'Didn’t ask for it? You can ignore this email.'],
      }),
    });
  }
  return { status: 200, body: { ok: true } };
}

export async function postMeVerify(body: unknown, ip: string): Promise<Result> {
  const b = V.obj(body, ['email', 'code', 'remember']);
  const email = V.email(b.email);
  const code = String(b.code ?? '').replace(/\D/g, '');
  await limit(`verify:ip:${ip}`, 30, 3600);
  const { data: row } = await db().from('login_codes').select('*').eq('email', email).is('used_at', null)
    .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!row || row.attempts >= CODE_TRIES) throw new HttpError(400, { error: 'code_expired' });
  await db().from('login_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
  if (code.length !== 6 || hash(email, code) !== row.code_hash) throw new HttpError(400, { error: 'wrong_code' });
  await db().from('login_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
  const { data: c } = await db().from('customers').select('id').eq('email', email).is('merged_into', null).limit(1).maybeSingle();
  if (!c) throw new HttpError(400, { error: 'code_expired' });
  // "Remember this device": a year; otherwise the key lasts the day.
  const key = bookToken(c.id, b.remember === true ? 365 : 1);
  const me = await customerFromKey(key);
  return { status: 200, body: { key, profile: me!.profile } };
}

// ---- My account ---------------------------------------------------------------
// Everything a returning customer can see and change about themselves.

const customerActor = (id: string, name: string) => ({ type: 'customer', id, label: name });

async function requireMe(k: unknown) {
  const me = await customerFromKey(k);
  if (!me) throw new HttpError(401, { error: 'invalid_link' });
  return me;
}

export async function getAccount(k: unknown): Promise<Result> {
  const me = await requireMe(k);
  const s = await getSettings();
  const [{ data: c }, { data: cars }, { data: history }, { data: upcoming }] = await Promise.all([
    db().from('customers').select('name, email, phone, address_line1, address_line2, city, state, postal_code, email_opt_out, mail_opt_out').eq('id', me.id).single(),
    db().from('vehicles').select('id, year, make, model, notes, vin').eq('customer_id', me.id).order('created_at'),
    db().from('service_history').select('service_date, raw_service, mileage, services(name), vehicles(year, make, model)').eq('customer_id', me.id).order('service_date', { ascending: false }).limit(100),
    db().from('bookings').select('id, root_id, date, kind, start_time, status, booking_services(services(name))').eq('customer_id', me.id)
      .in('status', ['requested', 'confirmed']).gte('date', new Date().toISOString().slice(0, 10)).order('date'),
  ]);
  const car = (v: any) => (v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '');
  return {
    status: 200,
    body: {
      details: c,
      cars: cars ?? [],
      history: (history ?? []).map((h: any) => ({ date: h.service_date, service: h.services?.name ?? h.raw_service ?? 'Service', car: car(h.vehicles), mileage: h.mileage })),
      upcoming: (upcoming ?? []).map((b: any) => ({
        when: T.whenText(s, b), status: b.status, services: (b.booking_services ?? []).map((x: any) => x.services?.name).join(', '),
        manage: manageLink(s, b),
      })),
    },
  };
}

export async function postAccount(body: unknown): Promise<Result> {
  const b = V.obj(body, ['k', 'action', 'details', 'car', 'car_id', 'email_opt_out', 'mail_opt_out']);
  const me = await requireMe(b.k);
  const actor = customerActor(me.id, me.profile.name);
  const audit = (action: string, entity: string, id: string, before: unknown, after: unknown) =>
    rpc('audit', { p_actor: actor, p_action: action, p_entity: entity, p_entity_id: id, p_before: before, p_after: after });

  if (b.action === 'details') {
    const d = V.obj(b.details, ['name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code'], 'details');
    const opt = (v: unknown, f: string, max: number) => V.str(v, f, { max, optional: true }) || null;
    const row = {
      name: V.str(d.name, 'name', { max: 100 }),
      email: V.email(d.email),
      phone: V.phone(d.phone),
      address_line1: opt(d.address_line1, 'address_line1', 100),
      address_line2: opt(d.address_line2, 'address_line2', 100),
      city: opt(d.city, 'city', 60),
      state: d.state ? V.str(d.state, 'state', { max: 2 }).toUpperCase() : null,
      postal_code: d.postal_code ? (/^\d{5}(-\d{4})?$/.test(String(d.postal_code).trim()) ? String(d.postal_code).trim() : (() => { throw new V.ValidationError('postal_code', 'must be a 5-digit ZIP'); })()) : null,
    };
    const { data: before } = await db().from('customers').select('name, email, phone, address_line1, address_line2, city, state, postal_code').eq('id', me.id).single();
    // A new address may be deliverable even if the old one wasn't.
    const addressChanged = before && (before.address_line1 !== row.address_line1 || before.postal_code !== row.postal_code);
    await db().from('customers').update({ ...row, ...(addressChanged ? { address_undeliverable: false } : {}) }).eq('id', me.id);
    await audit('customer.self_update', 'customer', me.id, before, row);
    return { status: 200, body: { ok: true } };
  }

  if (b.action === 'prefs') {
    const row = { email_opt_out: V.bool(b.email_opt_out, 'email_opt_out'), mail_opt_out: V.bool(b.mail_opt_out, 'mail_opt_out') };
    const { data: before } = await db().from('customers').select('email_opt_out, mail_opt_out').eq('id', me.id).single();
    await db().from('customers').update(row).eq('id', me.id);
    await audit('customer.self_prefs', 'customer', me.id, before, row);
    return { status: 200, body: { ok: true } };
  }

  if (b.action === 'car') {
    const v = V.obj(b.car, ['year', 'make', 'model', 'notes', 'vin'], 'car');
    const vin = String(v.vin ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) throw new V.ValidationError('vin', 'must be 11–17 letters and numbers (no I, O or Q)');
    const row = {
      year: V.int(v.year, 'year', 1950, new Date().getFullYear() + 2, true),
      make: V.str(v.make, 'make', { max: 40 }),
      model: V.str(v.model, 'model', { max: 60 }),
      notes: V.str(v.notes, 'notes', { max: 200, optional: true }),
      vin: vin || null,
    };
    if (b.car_id) {
      const id = V.uuid(b.car_id, 'car_id');
      if (!me.profile.vehicles.some((x) => x.id === id)) throw new HttpError(404, { error: 'not_found' });
      const { data: before } = await db().from('vehicles').select('*').eq('id', id).single();
      await db().from('vehicles').update(row).eq('id', id);
      await audit('vehicle.self_update', 'vehicle', id, before, row);
      return { status: 200, body: { ok: true } };
    }
    const { data } = await db().from('vehicles').insert({ ...row, customer_id: me.id }).select('id').single();
    await audit('vehicle.self_create', 'vehicle', data!.id, null, row);
    return { status: 200, body: { ok: true, id: data!.id } };
  }

  if (b.action === 'remove-car') {
    const id = V.uuid(b.car_id, 'car_id');
    if (!me.profile.vehicles.some((x) => x.id === id)) throw new HttpError(404, { error: 'not_found' });
    await rpc('delete_vehicle', { p_vehicle: id, p_actor: actor });
    return { status: 200, body: { ok: true } };
  }

  throw new V.ValidationError('action', 'unknown');
}
