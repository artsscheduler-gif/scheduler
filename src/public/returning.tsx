import { useEffect, useState } from 'react';
import { api, ApiError, type Profile } from './api';

// Returning customers: a booking key from a reminder link or postcard QR code
// (?k=…), or one earned by entering a code emailed to an address on file.
// "Remember this device" keeps it in localStorage; otherwise it lasts the visit.
const STORE = 'arts.bookingKey';

function stored(): string | null {
  try {
    return sessionStorage.getItem(STORE) ?? localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

function store(key: string | null, remember = false) {
  try {
    sessionStorage.removeItem(STORE);
    localStorage.removeItem(STORE);
    if (key) (remember ? localStorage : sessionStorage).setItem(STORE, key);
  } catch {
    // Storage blocked: the key just won't survive a reload.
  }
}

export function useReturningCustomer() {
  const [key, setKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    // A personal link wins; take it out of the address bar so it isn't shared by accident.
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get('k');
    if (fromLink) {
      params.delete('k');
      history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
      store(fromLink);
    }
    const k = fromLink ?? stored();
    if (!k) return;
    api.me(k).then((p) => { setKey(k); setProfile(p); }).catch(() => store(null));
  }, []);

  return {
    key, profile,
    signIn(k: string, p: Profile, remember: boolean) { store(k, remember); setKey(k); setProfile(p); },
    signOut() { store(null); setKey(null); setProfile(null); },
  };
}

// "Been here before?" box: email → code → in.
export function FindMyCars({ onIn, open: startOpen = false, title }: { onIn: (key: string, profile: Profile, remember: boolean) => void; open?: boolean; title?: string }) {
  const [open, setOpen] = useState(startOpen);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    setBusy(true);
    setErr('');
    try {
      await api.sendCode(email);
      setSent(true);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'invalid' ? 'Check your email address.' : e instanceof ApiError && e.status === 429 ? 'Too many tries. Wait a bit, or just fill in the form below.' : 'That didn’t work. Fill in the form below instead.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setErr('');
    try {
      const r = await api.verifyCode(email, code, remember);
      onIn(r.key, r.profile, remember);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'wrong_code' ? 'That code isn’t right. Check the email and try again.' : 'That code has expired. Send a new one.');
      if (e instanceof ApiError && e.code === 'code_expired') setSent(false);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="find-cars">
        <span>Been here before?</span>
        <button type="button" className="linklike" onClick={() => setOpen(true)}>Find my cars</button>
      </div>
    );
  }
  return (
    <div className="find-cars open">
      {title && <strong>{title}</strong>}
      {!sent ? (
        <>
          <label className="field">
            <span>Your email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <p className="muted small">If it’s on file, we’ll email you a 6-digit code.</p>
          <div className="row">
            <button type="button" className="btn" disabled={busy || !email.includes('@')} onClick={send}>{busy ? 'Sending…' : 'Email me a code'}</button>
            {!startOpen && <button type="button" className="linklike small" onClick={() => setOpen(false)}>Cancel</button>}
          </div>
        </>
      ) : (
        <>
          <p className="small">If <b>{email}</b> is on file, a code is on its way. It can take a minute; check spam too.</p>
          <label className="field">
            <span>6-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="check-row small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me on this device</label>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy || code.length !== 6} onClick={verify}>{busy ? 'Checking…' : 'Continue'}</button>
            <button type="button" className="linklike small" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </div>
        </>
      )}
      {err && <p className="field-err" role="alert">{err}</p>}
    </div>
  );
}
