import { supabase } from '../lib/supabase';

export class AdminError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
  }
}

export async function adminPost<T = any>(action: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/api/admin/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  // The sign-in has ended (timed out, or ended elsewhere, e.g. a password
  // change): go back to the sign-in screen rather than show an error.
  if (res.status === 401 && (json?.error === 'session_expired' || json?.error === 'unauthenticated')) {
    await supabase.auth.signOut();
    window.location.assign('/admin');
  }
  if (!res.ok && res.status !== 409) throw new AdminError(res.status, json);
  return json as T;
}
