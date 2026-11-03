import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// Compact signed tokens: base64url(payload).base64url(hmac-sha256).
type Purpose = 'manage' | 'unsub' | 'book';
export interface ManageToken { p: 'manage'; r: string; exp: number }
export interface UnsubToken { p: 'unsub'; c: string }
// A returning customer's booking key: from a reminder link, a postcard QR code,
// or an emailed code. Lets the booking page fill in their details and cars.
export interface BookToken { p: 'book'; c: string; exp: number }

function b64(buf: Buffer | string) {
  return Buffer.from(buf).toString('base64url');
}

function mac(body: string) {
  return createHmac('sha256', env.tokenSecret).update(body).digest();
}

export function signToken(payload: ManageToken | UnsubToken | BookToken): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(body))}`;
}

export function verifyToken<T extends ManageToken | UnsubToken | BookToken>(token: unknown, purpose: Purpose, now = Date.now()): T | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.p !== purpose) return null;
  if (purpose === 'manage') {
    if (typeof payload.r !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  }
  if (purpose === 'unsub' && typeof payload.c !== 'string') return null;
  if (purpose === 'book' && (typeof payload.c !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 <= now)) return null;
  return payload as T;
}

export function manageUrl(rootId: string, appointmentAt: Date): string {
  const t = signToken({ p: 'manage', r: rootId, exp: Math.floor(appointmentAt.getTime() / 1000) });
  return `${env.appUrl}/manage?t=${t}`;
}

export function bookToken(customerId: string, days: number): string {
  return signToken({ p: 'book', c: customerId, exp: Math.floor(Date.now() / 1000) + days * 86400 });
}

// A booking link for one customer (reminder emails, postcard QR codes).
export function personalBookingUrl(bookingUrl: string, customerId: string, src: string, days = 120): string {
  const u = new URL(bookingUrl);
  u.searchParams.set('src', src);
  u.searchParams.set('k', bookToken(customerId, days));
  return u.toString();
}

export function unsubscribeUrl(customerId: string): string {
  return `${env.appUrl}/unsubscribe?t=${signToken({ p: 'unsub', c: customerId })}`;
}

// For the List-Unsubscribe header: mail apps POST here directly (one click,
// no page), and a plain visit redirects to the unsubscribe page.
export function oneClickUnsubscribeUrl(customerId: string): string {
  return `${env.appUrl}/api/unsubscribe?t=${signToken({ p: 'unsub', c: customerId })}`;
}
