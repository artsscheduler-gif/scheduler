import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, todayIn, useQuery, useSettings } from './shared';
import { Message, deliveredNote } from './Outbox';
import { DayView } from './DayView';
import { addDays } from '../../shared/time';

// Staging test lab: play the customer in a phone-sized window, play Chris in
// the day view beside the email feed, and watch every email each step sends.
// The customer phone is a pop-up, not an iframe, because the site's headers
// forbid framing (and should keep doing so in production).

interface Row { id: string; kind: string | null; to_email: string; subject: string; sim_date: string | null; created_at: string; delivered: string | null }

const SINCE_KEY = 'arts.lab.since';
const PHONE = 'arts-customer-phone';

function readSince(): string {
  try {
    const v = localStorage.getItem(SINCE_KEY);
    if (v) return v;
  } catch { /* storage blocked: start from now */ }
  return new Date().toISOString();
}

function writeSince(v: string) {
  try { localStorage.setItem(SINCE_KEY, v); } catch { /* per-viewer convenience only */ }
}

export function openPhone(url = '/') {
  const w = window.open(url, PHONE, 'popup,width=400,height=820');
  w?.focus();
}

const at = (d: string) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// Links in an email: customer links open in the phone window, the rest in a tab.
function EmailLinks({ id }: { id: string }) {
  const msg = useQuery(() => must(supabase.from('email_outbox').select('html').eq('id', id).single()) as Promise<{ html: string }>, [id]);
  if (!msg.data) return null;
  const doc = new DOMParser().parseFromString(msg.data.html, 'text/html');
  const links = [...doc.querySelectorAll('a[href]')]
    .map((a) => ({ text: (a.textContent ?? '').trim() || a.getAttribute('href')!, href: a.getAttribute('href')! }))
    .filter((l) => /^https?:/.test(l.href));
  if (links.length === 0) return null;
  return (
    <div className="lab-links">
      {links.map((l) => {
        const u = new URL(l.href);
        const admin = u.pathname.startsWith('/admin');
        return admin
          ? <a key={l.href} className="btn small" href={l.href} target="_blank" rel="noreferrer">{l.text} ↗</a>
          : <button key={l.href} className="btn small primary" onClick={() => openPhone(l.href)}>{l.text} → customer phone</button>;
      })}
    </div>
  );
}

export function Lab() {
  const { data: s } = useSettings();
  const [since, setSince] = useState(readSince);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [jobDate, setJobDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [resetMsg, setResetMsg] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => supabase.from('email_outbox').select('id, kind, to_email, subject, sim_date, created_at, delivered')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(200)
      .then(({ data }) => { if (live && data) setRows((data as Row[]).reverse()); });
    load();
    const timer = setInterval(load, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [since]);

  useEffect(() => {
    if (s && !jobDate) setJobDate(addDays(todayIn(s.timezone), 1));
  }, [s]);

  if (!s) return <p className="loading">Loading…</p>;

  const who = (to: string) => to === s.staff_notify_email ? 'chris' : to === s.owner_alert_email ? 'owner' : 'customer';
  const LABEL = { chris: 'To Chris', owner: 'To owner', customer: 'To customer' } as const;

  function startFresh() {
    const now = new Date().toISOString();
    writeSince(now);
    setSince(now);
    setOpen(null);
  }

  async function resetAll() {
    if (!confirm('Reset the test site? This deletes every booking, customer, car and captured email, and all blocked time. Services, hours, settings and logins stay.')) return;
    setBusy(true);
    setResetMsg('');
    try {
      const r = await adminPost<{ bookings: number; customers: number }>('sim-reset-all', {});
      startFresh();
      setResetMsg(`Test site reset: removed ${r.bookings} booking${r.bookings === 1 ? '' : 's'} and ${r.customers} customer${r.customers === 1 ? '' : 's'}.`);
    } catch (e) {
      setResetMsg(`Not reset: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runJobs() {
    setBusy(true);
    setMsg('');
    try {
      let r = await adminPost('sim-day', { date: jobDate, live: true });
      for (let n = 0; r.more && n < 20; n++) {
        const next = await adminPost('sim-day', { date: jobDate, live: true });
        r = { ...next, emails: r.emails + next.emails, appointment_reminders: r.appointment_reminders + (next.appointment_reminders ?? 0) };
      }
      setMsg(`Ran the daily jobs as of ${r.date}: ${r.emails} email${r.emails === 1 ? '' : 's'} (${r.appointment_reminders} appointment reminder${r.appointment_reminders === 1 ? '' : 's'}).`);
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lab">
      <div className="banner">
        <strong>Test lab.</strong> You play the customer in the phone window and Chris on the right. Every email lands in the feed; nothing is delivered.
        <ol className="lab-steps">
          <li><button className="btn small primary" onClick={() => openPhone('/')}>Open customer phone</button> and book.</li>
          <li>Watch “request received” (customer) and the new-request alert (Chris) arrive.</li>
          <li>As Chris, approve, propose another time, or decline in <em>Waiting for you</em>.</li>
          <li>Open the customer’s email and use its link to change or cancel. Chris gets the change request.</li>
          <li>Run the daily jobs for the day before the appointment to see the reminder.</li>
        </ol>
        <div className="row wrap lab-reset">
          <button className="btn small danger" disabled={busy} onClick={resetAll}>Reset test site</button>
          <span className="muted small">Clears all bookings, customers and emails for a clean start. Keeps services, hours, settings and logins.</span>
        </div>
        {resetMsg && <p className="small" role="status">{resetMsg}</p>}
      </div>

      <div className="lab-grid">
        <section className="lab-feed" aria-label="Email flow">
          <div className="row wrap">
            <h2>Email flow</h2>
            <span className="muted small">{rows.length} since {new Date(since).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            <button className="btn small push" onClick={startFresh}>Start fresh</button>
          </div>
          <p className="muted small">Chris = {s.staff_notify_email} · owner = {s.owner_alert_email}</p>
          {rows.length === 0 && <p className="muted">No emails yet. Book something in the customer phone.</p>}
          <ol className="lab-list">
            {rows.map((r) => (
              <li key={r.id} className={`lab-item to-${who(r.to_email)} ${open === r.id ? 'on' : ''}`}>
                <button className="lab-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <span className="lab-badge">{LABEL[who(r.to_email)]}</span>
                  <strong>{r.subject}</strong>
                  <span className="muted small">{r.sim_date ? `simulated ${r.sim_date}` : at(r.created_at)} · {r.to_email}</span>
                  {r.delivered && <span className={`small ${r.delivered.startsWith('sent:') ? 'ok-text' : 'error'}`}>{deliveredNote(r.delivered)}</span>}
                </button>
                {open === r.id && (
                  <div className="lab-open">
                    <EmailLinks id={r.id} />
                    <Message id={r.id} />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="lab-jobs">
            <h3>Reminders</h3>
            <div className="row wrap">
              <label>Daily jobs as of <input type="date" value={jobDate} onChange={(e) => setJobDate(e.target.value)} /></label>
              <button className="btn" disabled={busy || !jobDate} onClick={runJobs}>{busy ? 'Running…' : 'Run'}</button>
            </div>
            {msg && <p className="muted small" role="status">{msg}</p>}
          </div>
        </section>

        <section className="lab-chris" aria-label="Chris's view">
          <h2 className="lab-chris-title">Chris’s view</h2>
          {/* Refresh (without losing open forms) whenever a new email arrives. */}
          <DayView refresh={rows.at(-1)?.id} />
        </section>
      </div>
    </div>
  );
}
