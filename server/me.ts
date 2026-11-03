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
