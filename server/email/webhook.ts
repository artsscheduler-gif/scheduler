// Resend webhook (delivered via Svix): hard bounces mark the customer's email
// as bounced, spam complaints opt them out of email. Both stop reminders.
// Signature: base64(HMAC-SHA256(secret, `${svix-id}.${svix-timestamp}.${raw body}`)).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, rpc } from '../db.js';
import { HttpError, type Result } from '../http.js';

const TOLERANCE_S = 5 * 60;

export function verifySvix(secret: string, headers: Record<string, string | undefined>, raw: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = headers['svix-signature'];
  if (!id || !ts || !sigs || !/^\d+$/.test(ts) || Math.abs(nowS - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

interface ResendEvent { type?: string; data?: { to?: string[] | string; bounce?: { type?: string; message?: string } } }

export async function handleResendWebhook(secret: string, headers: Record<string, string | undefined>, raw: string): Promise<Result> {
  if (!secret) throw new HttpError(503, { error: 'not_configured' });
  if (!verifySvix(secret, headers, raw)) throw new HttpError(401, { error: 'bad_signature' });
  const ev = JSON.parse(raw) as ResendEvent;
  const to = ([] as string[]).concat(ev.data?.to ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  let field: 'email_bounced' | 'email_opt_out' | null = null;
  // Transient bounces (mailbox full, greylisting) retry on their own; only permanent ones stop mail.
  if (ev.type === 'email.bounced' && ev.data?.bounce?.type !== 'Transient') field = 'email_bounced';
  if (ev.type === 'email.complained') field = 'email_opt_out';
  if (!field || !to.length) return { status: 200, body: { ok: true, ignored: ev.type ?? 'unknown' } };

  let updated = 0;
  for (const email of to) {
    const { data } = await db().from('customers').update({ [field]: true }).eq('email', email).is('merged_into', null).eq(field, false).select('id');
    for (const c of data ?? []) {
      updated++;
      await rpc('audit', {
        p_actor: { type: 'system', label: 'Resend webhook' }, p_action: field === 'email_bounced' ? 'customer.email_bounced' : 'customer.spam_complaint',
        p_entity: 'customer', p_entity_id: c.id, p_before: { [field]: false }, p_after: { [field]: true, reason: ev.data?.bounce?.message ?? ev.type },
      });
    }
  }
  return { status: 200, body: { ok: true, updated } };
}
