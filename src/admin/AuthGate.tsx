import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { isRole, mfaRequired } from '../../shared/permissions';

type Stage =
  | { kind: 'loading' }
  | { kind: 'signin' }
  | { kind: 'set-password' }
  | { kind: 'enroll'; factorId: string; qr: string; secret: string; uri: string }
  | { kind: 'challenge'; factorId: string }
  | { kind: 'denied' }
  | { kind: 'ready'; session: Session };

const LOGIN_AT_KEY = 'arts.admin.verifiedAt';
// The TOTP secret is only returned at enroll time, so keep it for this tab.
// Otherwise a reload would start a new enrollment and the QR the admin already
// scanned would stop matching.
const ENROLL_KEY = 'arts.admin.pendingEnroll';
type PendingEnroll = { factorId: string; qr: string; secret: string; uri: string };

function readEnroll(): PendingEnroll | null {
  try {
    return JSON.parse(sessionStorage.getItem(ENROLL_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function writeEnroll(v: PendingEnroll | null) {
  try {
    if (v === null) sessionStorage.removeItem(ENROLL_KEY);
    else sessionStorage.setItem(ENROLL_KEY, JSON.stringify(v));
  } catch {
    // Storage blocked: a reload starts a fresh enrollment.
  }
}

function readLoginAt(): number {
  try {
    return Number(localStorage.getItem(LOGIN_AT_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function writeLoginAt(v: number | null) {
  try {
    if (v === null) localStorage.removeItem(LOGIN_AT_KEY);
    else localStorage.setItem(LOGIN_AT_KEY, String(v));
  } catch {
    // Storage blocked: the server-side session timebox still applies.
  }
}

// Session length from Settings, read at sign-in; 12 hours until then.
let timeoutMs = 12 * 3600_000;

export async function signOut() {
  writeLoginAt(null);
  writeEnroll(null);
  await supabase.auth.signOut();
}

export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [error, setError] = useState('');

  async function resolve() {
    setError('');
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return setStage({ kind: 'signin' });

    const role = session.user.app_metadata?.role;
    if (!isRole(role)) return setStage({ kind: 'denied' });

    const hash = window.location.hash;
    if (/type=(invite|recovery)/.test(hash)) return setStage({ kind: 'set-password' });

    // Only developers need the authenticator code; owners and staff sign in
    // with email and password (see shared/permissions: mfaRequired).
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.data?.currentLevel === 'aal2' || !mfaRequired(role)) {
      const { data: s } = await supabase.from('shop_settings').select('session_timeout_hours').eq('id', 1).single();
      const limitMs = (s?.session_timeout_hours ?? 12) * 3600_000;
      timeoutMs = limitMs;
      const at = readLoginAt();
      if (!at || Date.now() - at > limitMs) {
        await signOut();
        return setStage({ kind: 'signin' });
      }
      return setStage({ kind: 'ready', session });
    }

    const factors = await supabase.auth.mfa.listFactors();
    const totp = factors.data?.totp.find((f) => f.status === 'verified');
    if (totp) return setStage({ kind: 'challenge', factorId: totp.id });

    // Resume this tab's enrollment if it's still pending, so the QR stays the same.
    const pending = readEnroll();
    const unverified = (factors.data?.all ?? []).filter((f) => f.status !== 'verified');
    if (pending && unverified.some((f) => f.id === pending.factorId)) return setStage({ kind: 'enroll', ...pending });

    // Clean up abandoned enrollments, then start a fresh one.
    for (const f of unverified) await supabase.auth.mfa.unenroll({ factorId: f.id });
    // A clear name in the authenticator app, so entries for different logins aren't mixed up.
    // Plain letters only: some apps reject punctuation like an apostrophe in the issuer.
    const enroll = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'Arts Servicenter', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (enroll.error) return setError(enroll.error.message);
    const next = { factorId: enroll.data.id, qr: enroll.data.totp.qr_code, secret: enroll.data.totp.secret, uri: enroll.data.totp.uri };
    writeEnroll(next);
    setStage({ kind: 'enroll', ...next });
  }

  useEffect(() => {
    resolve();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setStage({ kind: 'signin' });
    });
    const timer = setInterval(() => {
      const at = readLoginAt();
      if (at && Date.now() - at > timeoutMs) signOut();
    }, 60_000);
    return () => {
      data.subscription.unsubscribe();
      clearInterval(timer);
    };
  }, []);

  async function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({ email: String(f.get('email')), password: String(f.get('password')) });
    if (error) return setError('Email or password is incorrect.');
    writeLoginAt(Date.now()); // starts the sign-in timeout (developers restart it after their code)
    resolve();
  }

  async function onSetPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pw = String(new FormData(e.currentTarget).get('password'));
    if (pw.length < 8) return setError('Use at least 8 characters.');
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return setError(error.message);
    history.replaceState(null, '', window.location.pathname);
    resolve();
  }

  async function onCode(e: FormEvent<HTMLFormElement>, factorId: string) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '');
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return setError(`That code didn’t work (${error.message}). Codes change every 30 seconds — try the current one.`);
    writeEnroll(null);
    writeLoginAt(Date.now());
    resolve();
  }

  if (stage.kind === 'ready') return <>{children(stage.session)}</>;

  return (
    <main className="auth">
      <div className="auth-card">
        <h1>Art’s Servicenter · Admin</h1>
        {stage.kind === 'loading' && <p>Loading…</p>}
        {stage.kind === 'signin' && (
          <form onSubmit={onSignIn}>
            <label>Email<input name="email" type="email" autoComplete="username" required /></label>
            <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="btn primary">Sign in</button>
            <p className="muted">Admin access is by invitation only.</p>
          </form>
        )}
        {stage.kind === 'set-password' && (
          <form onSubmit={onSetPassword}>
            <p>Choose a password for your admin account.</p>
            <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
            <button className="btn primary">Save password</button>
          </form>
        )}
        {stage.kind === 'enroll' && (
          <form onSubmit={(e) => onCode(e, stage.factorId)}>
            <p>Two-step sign-in is required. Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.</p>
            <img className="qr" src={stage.qr} alt="Authenticator QR code" width={231} height={231} />
            <p className="muted small">On this phone? <a href={stage.uri}>Add to authenticator app</a>.</p>
            <p className="muted small">Can’t scan? Enter this key: <code>{stage.secret}</code></p>
            <label>6-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required /></label>
            <button className="btn primary">Verify</button>
          </form>
        )}
        {stage.kind === 'challenge' && (
          <form onSubmit={(e) => onCode(e, stage.factorId)}>
            <label>6-digit code from your authenticator app<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" autoFocus required /></label>
            <button className="btn primary">Verify</button>
          </form>
        )}
        {stage.kind === 'denied' && (
          <>
            <p>This account doesn’t have admin access.</p>
            <button className="btn" onClick={signOut}>Sign out</button>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
