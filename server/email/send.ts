import { db, type ShopSettings } from '../db.js';
import { withRetry } from '../retry.js';
import { emailProvider, type EmailMessage } from './provider.js';

export interface SendOpts {
  kind: string;
  to: string | null | undefined;
  subject: string;
  html: string;
  text: string;
  bookingId?: string;
  customerId?: string;
  headers?: Record<string, string>;
  attachments?: EmailMessage['attachments'];
  idempotencyKey?: string;
}

// Sends one transactional email with retries and logs the outcome. Never throws.
export async function sendEmail(settings: ShopSettings, o: SendOpts): Promise<boolean> {
  if (!o.to || o.to.startsWith('[')) return false;
  const p = emailProvider();
  const r = await withRetry(
    () => p.send({
      kind: o.kind,
      to: o.to!,
      from: `${settings.from_name} <${settings.from_email}>`,
      subject: o.subject,
      html: o.html,
      text: o.text,
      replyTo: settings.from_email,
      headers: o.headers,
      attachments: o.attachments,
      idempotencyKey: o.idempotencyKey,
    }),
    3,
    process.env.VITEST ? 1 : 400,
  );
  await db().from('email_log').insert({
    kind: o.kind,
    to_email: o.to,
    booking_id: o.bookingId ?? null,
    customer_id: o.customerId ?? null,
    status: r.error ? 'failed' : p.name === 'stub' ? 'stubbed' : p.name === 'capture' ? 'captured' : 'sent',
    provider_id: r.value?.id ?? null,
    cost_cents: r.value?.costCents ?? null,
    error: r.error?.message?.slice(0, 500) ?? null,
  });
  return !r.error;
}
