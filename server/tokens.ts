import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// Compact signed tokens: base64url(payload).base64url(hmac-sha256).
type Purpose = 'manage' | 'unsub';
export interface ManageToken { p: 'manage'; r: string; exp: number }
export interface UnsubToken { p: 'unsub'; c: string }

function b64(buf: Buffer | string) {
  return Buffer.from(buf).toString('base64url');
}

function mac(body: string) {
  return createHmac('sha256', env.tokenSecret).update(body).digest();
}

export function signToken(payload: ManageToken | UnsubToken): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(body))}`;
}

export function verifyToken<T extends ManageToken | UnsubToken>(token: unknown, purpose: Purpose, now = Date.now()): T | null {
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
  return payload as T;
}

export function manageUrl(rootId: string, appointmentAt: Date): string {
  const t = signToken({ p: 'manage', r: rootId, exp: Math.floor(appointmentAt.getTime() / 1000) });
  return `${env.appUrl}/manage?t=${t}`;
}

export function unsubscribeUrl(customerId: string): string {
  return `${env.appUrl}/unsubscribe?t=${signToken({ p: 'unsub', c: customerId })}`;
}
