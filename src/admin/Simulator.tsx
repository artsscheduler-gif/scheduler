import { useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { adminPost } from './api';
import { useQuery } from './shared';
import { addDays } from '../../shared/time';

interface Status { today: string; dry_run: boolean; customers: number; bookings: number; outbox: number; email_provider: string }
interface DayResult { date: string; emails: number; due_steps: number; emailed: number; batched: number; skipped: number; dry_run: number; appointment_reminders: number; digest: number; escalated_staff: number; escalated_owner: number }

export function Simulator() {
  const st = useQuery(() => adminPost<Status>('sim-status', {}));
  const [nCust, setNCust] = useState(25);
  const [nBook, setNBook] = useState(5);
  const [days, setDays] = useState(14);
  const [from, setFrom] = useState('');
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [log, setLog] = useState<DayResult[]>([]);
  const stop = useRef(false);
  const s = st.data;

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setMsg('');
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy('');
      st.reload();
    }
  }

  const loadCustomers = () => run('customers', async () => {
    const r = await adminPost('sim-customers', { count: nCust });
    return `Added ${r.customers} customers, ${r.vehicles} vehicles, ${r.history} service records.`;
  });

  const addBookings = () => run('bookings', async () => {
    let made = 0;
    const failed: string[] = [];
    for (let left = nBook; left > 0; left -= 10) {
      const r = await adminPost('sim-bookings', { count: Math.min(10, left) });
      made += r.made.length;
      failed.push(...r.failed);
    }
    return `Created ${made} booking request${made === 1 ? '' : 's'}.${failed.length ? ` ${failed.length} couldn’t be placed: ${[...new Set(failed)].join('; ')}.` : ''}`;
  });

  const fastForward = () => run('days', async () => {
    stop.current = false;
    setLog([]);
    const start = from || s!.today;
    let i = 0;
    for (; i < days && !stop.current; i++) {
      const r = await adminPost<DayResult>('sim-day', { date: addDays(start, i), live });
      setLog((l) => [...l, r]);
    }
    return `${stop.current ? 'Stopped after' : 'Ran'} ${i} day${i === 1 ? '' : 's'}. Open the Outbox to read the emails and Postcards for batches.`;
  });

  const tick = () => run('tick', async () => {
    const r = await adminPost('sim-tick', {});
    return `${r.pending} waiting request(s). Escalated to staff: ${r.escalated_staff}. To owner: ${r.escalated_owner}.`;
  });

  const reset = () => {
    if (!confirm('Delete every simulated customer (@sim.invalid) with their vehicles, bookings, history and reminders?')) return;
    run('reset', async () => `Removed ${(await adminPost('sim-reset', {})).customers} simulated customers.`);
  };

  if (st.error) return <p className="error">{st.error}</p>;
  if (!s) return <p className="loading">Loading…</p>;
  const total = log.reduce((n, d) => n + d.emails, 0);

  return (
    <div className="settings">
      <div className="banner">
        Staging simulator. Today is {s.today}. {s.customers} simulated customers, {s.bookings} simulated bookings, {s.outbox} captured emails.
        {s.email_provider !== 'capture' && <> <strong>EMAIL_PROVIDER is “{s.email_provider}”, not “capture”, so emails won’t show in the Outbox.</strong></>}
      </div>

      <div className="settings-section">
        <h3>1. Load customers</h3>
        <p className="help">Fake customers with vehicles and past service, as if imported from Epicor. Due dates fall between 60 days ago and about 75 days ahead, so a few weeks of fast-forward hits every reminder step. About 10% have no mailing address and 10% opted out of email.</p>
        <div className="row"><input type="number" min={1} max={300} className="w5" value={nCust} onChange={(e) => setNCust(+e.target.value)} aria-label="Customers" /><button className="btn primary" disabled={!!busy} onClick={loadCustomers}>{busy === 'customers' ? 'Adding…' : 'Add customers'}</button></div>
      </div>

      <div className="settings-section">
        <h3>2. Booking requests</h3>
        <p className="help">Requests placed the same way the public form places them, half from returning simulated customers and half from new ones. Each one sends the customer email and Chris’s notification. Then approve or decline them in <NavLink to="/admin/approvals">Approvals</NavLink>.</p>
        <div className="row"><input type="number" min={1} max={50} className="w5" value={nBook} onChange={(e) => setNBook(+e.target.value)} aria-label="Bookings" /><button className="btn primary" disabled={!!busy} onClick={addBookings}>{busy === 'bookings' ? 'Booking…' : 'Add requests'}</button></div>
      </div>

      <div className="settings-section">
        <h3>3. Fast-forward</h3>
        <p className="help">Runs the daily job (service reminders, appointment reminders, digest, postcard batches) and the escalation check for each day, as if that day had arrived. Emails it produces are tagged with the simulated date. What actually happened is recorded, so running a day twice doesn’t send twice.</p>
        <div className="row wrap">
          <label>Days <input type="number" min={1} max={120} className="w5" value={days} onChange={(e) => setDays(+e.target.value)} /></label>
          <label>Starting <input type="date" value={from || s.today} onChange={(e) => setFrom(e.target.value)} /></label>
          {s.dry_run && <label><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Send reminders anyway (dry-run is on in Settings)</label>}
          {busy === 'days'
            ? <button className="btn" onClick={() => { stop.current = true; }}>Stop</button>
            : <button className="btn primary" disabled={!!busy} onClick={fastForward}>Fast-forward</button>}
        </div>
        {log.length > 0 && (
          <table className="tbl narrow">
            <thead><tr><th>Date</th><th>Emails</th><th>Reminder steps</th><th>Postcards batched</th><th>Skipped</th><th>Appt reminders</th><th>Escalations</th></tr></thead>
            <tbody>
              {log.map((d) => (
                <tr key={d.date}><td>{d.date}</td><td>{d.emails}</td><td>{d.due_steps}{d.dry_run ? ` (${d.dry_run} dry run)` : ''}</td><td>{d.batched}</td><td>{d.skipped}</td><td>{d.appointment_reminders}</td><td>{d.escalated_staff + d.escalated_owner}</td></tr>
              ))}
              <tr><td><strong>Total</strong></td><td><strong>{total}</strong></td><td colSpan={5} /></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-section">
        <h3>Other</h3>
        <div className="row wrap">
          <button className="btn" disabled={!!busy} onClick={tick}>Run escalation check now</button>
          <button className="btn danger push" disabled={!!busy} onClick={reset}>Reset simulated data</button>
        </div>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}
