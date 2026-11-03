import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery, useRole } from './shared';
import { formatPhone } from '../../shared/phone';
import { formatDate, formatTime } from '../../shared/time';
import { STATUS_LABEL } from '../../shared/rules';

const FIELDS: [string, string][] = [
  ['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'],
  ['address_line1', 'Address'], ['address_line2', 'Address line 2'], ['city', 'City'], ['state', 'State'], ['postal_code', 'ZIP'],
];
const FLAGS: [string, string][] = [
  ['email_opt_out', 'Opted out of email reminders'],
  ['mail_opt_out', 'Opted out of postcards'],
  ['always_review', 'Always review this customer’s bookings'],
  ['email_bounced', 'Email bounced'],
  ['address_undeliverable', 'Address undeliverable'],
];

function search(term: string) {
  const t = term.trim().replace(/[%,()]/g, '');
  let q = supabase.from('customers').select('id, name, phone, email, city, source, always_review, email_opt_out, mail_opt_out').is('merged_into', null).order('name').limit(50);
  if (t) {
    const digits = t.replace(/\D/g, '');
    const ors = [`name.ilike.%${t}%`, `email.ilike.%${t}%`];
    if (digits.length >= 3) ors.push(`phone.ilike.%${digits}%`);
    q = q.or(ors.join(','));
  }
  return must(q);
}

async function searchByPlate(term: string) {
  const t = term.trim().replace(/[%,()]/g, '');
  if (t.length < 2) return [];
  const rows = await must(supabase.from('vehicles').select('customer_id, notes').ilike('notes', `%${t}%`).limit(20));
  const ids = [...new Set((rows as any[]).map((r) => r.customer_id))];
  if (!ids.length) return [];
  return must(supabase.from('customers').select('id, name, phone, email, city, source, always_review, email_opt_out, mail_opt_out').in('id', ids).is('merged_into', null));
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const role = useRole();
  const c = useQuery(() => must(supabase.from('customers').select('*, vehicles(*)').eq('id', id).single()), [id]);
  const history = useQuery(() => must(supabase.from('service_history').select('id, service_date, raw_service, source, mileage, services(name), vehicles(year, make, model)').eq('customer_id', id).order('service_date', { ascending: false })), [id]);
  const bookings = useQuery(() => must(supabase.from('bookings').select('id, date, kind, start_time, status, booking_services(services(name))').eq('customer_id', id).neq('status', 'replaced').order('date', { ascending: false }).limit(50)), [id]);
  const reminders = useQuery(() => must(supabase.from('reminder_sends').select('id, step, channel, status, due_date, created_at, services(name)').eq('customer_id', id).order('created_at', { ascending: false }).limit(30)), [id]);
  const merges = useQuery(() => must(supabase.from('customer_merges').select('id, merged_before, created_at').eq('keep_id', id).is('undone_at', null).order('created_at', { ascending: false })) as Promise<any[]>, [id]);
  const [dupes, setDupes] = useState<any[]>([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const d = c.data as any;
    if (!d) return;
    const ors = [`name.ilike.${d.name.replace(/[%,()]/g, '')}`];
    if (d.email) ors.push(`email.eq.${d.email}`);
    if (d.phone) ors.push(`phone.eq.${d.phone}`);
    supabase.from('customers').select('id, name, phone, email').is('merged_into', null).neq('id', id).or(ors.join(',')).limit(5).then(({ data }) => setDupes(data ?? []));
  }, [c.data]);

  if (!c.data) return <p className="loading">Loading…</p>;
  const cust = c.data as any;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fields: Record<string, unknown> = {};
    for (const [k] of FIELDS) {
      const v = String(f.get(k) ?? '').trim();
      if (v !== (cust[k] ?? '') && !(k === 'phone' && v === formatPhone(cust.phone))) fields[k] = v;
    }
    for (const [k] of FLAGS) if ((f.get(k) === 'on') !== cust[k]) fields[k] = f.get(k) === 'on';
    if (!Object.keys(fields).length) return setMsg('No changes.');
    try {
      await adminPost('customer', { id, fields });
      setMsg('Saved.');
      c.reload();
      onChanged();
    } catch (err) {
      setMsg(String((err as Error).message));
    }
  }

  async function merge(otherId: string, otherName: string) {
    if (!confirm(`Merge “${otherName}” into “${cust.name}”? Their bookings, vehicles and history move here. Opt-outs from either record are kept. You can undo this below.`)) return;
    try {
      await adminPost('merge', { keep_id: id, merge_id: otherId });
      setMsg('Merged.');
    } catch (e) {
      setMsg(`Not merged: ${(e as Error).message}`);
    }
    c.reload(); history.reload(); bookings.reload(); merges.reload(); onChanged();
  }

  async function forget() {
    if (!confirm(`Forget ${cust.name}? Their details, vehicles and history are removed and upcoming appointments are cancelled. This can’t be undone.`)) return;
    if (prompt('Type FORGET to confirm') !== 'FORGET') return;
    const r = await adminPost('forget', { customer_id: id });
    setMsg(`Removed.${r.cancelled_upcoming ? ` ${r.cancelled_upcoming} upcoming appointment(s) cancelled.` : ''}`);
    c.reload(); history.reload(); bookings.reload(); onChanged();
  }

  async function unmerge(mergeId: string, name: string) {
    if (!confirm(`Undo the merge with “${name}”? Their bookings, vehicles and history go back to their own record.`)) return;
    try {
      await adminPost('unmerge', { merge_id: mergeId });
      setMsg('Merge undone.');
    } catch (e) {
      setMsg(`Couldn’t undo: ${(e as Error).message}`);
    }
    c.reload(); history.reload(); bookings.reload(); merges.reload(); onChanged();
  }

  return (
    <div className="cust-detail">
      <h2>{cust.name}</h2>
      <p className="muted small">Source: {cust.source}{cust.epicor_id ? ` · Epicor #${cust.epicor_id}` : ''} · added {new Date(cust.created_at).toLocaleDateString()}</p>
      <form className="admin-form" onSubmit={save} key={cust.id + cust.name + cust.phone}>
        <div className="grid3">
          {FIELDS.map(([k, label]) => (
            <label key={k}>{label}<input name={k} defaultValue={k === 'phone' ? formatPhone(cust.phone) : cust[k] ?? ''} /></label>
          ))}
        </div>
        <div className="flags">
          {FLAGS.map(([k, label]) => (
            <label key={k} className="check-row"><input type="checkbox" name={k} defaultChecked={cust[k]} /> {label}</label>
          ))}
        </div>
        <button className="btn primary">Save</button> {msg && <span className="muted" role="status">{msg}</span>}
      </form>

      {dupes.length > 0 && (
        <div className="notice">
          <strong>Possible duplicates</strong>
          {dupes.map((d) => (
            <div key={d.id} className="row">
              <span>{d.name} · {formatPhone(d.phone)} · {d.email}</span>
              <button className="btn small" onClick={() => merge(d.id, d.name)}>Merge into this customer</button>
            </div>
          ))}
        </div>
      )}

      {!!merges.data?.length && (
        <div className="notice">
          <strong>Merged into this customer</strong>
          {merges.data.map((m) => (
            <div key={m.id} className="row">
              <span>{m.merged_before.name}{m.merged_before.phone ? ` · ${formatPhone(m.merged_before.phone)}` : ''}{m.merged_before.email ? ` · ${m.merged_before.email}` : ''} · {new Date(m.created_at).toLocaleDateString()}</span>
              <button className="btn small" onClick={() => unmerge(m.id, m.merged_before.name)}>Undo merge</button>
            </div>
          ))}
        </div>
      )}

      <h3>Vehicles</h3>
      <table className="tbl">
        <tbody>
          {cust.vehicles.map((v: any) => (
            <VehicleRow key={v.id} v={v} onSaved={c.reload} />
          ))}
          <VehicleRow v={{ customer_id: id }} onSaved={c.reload} />
        </tbody>
      </table>

      <h3>Bookings</h3>
      <table className="tbl">
        <tbody>
          {(bookings.data as any[] | null)?.map((b) => (
            <tr key={b.id}>
              <td><Link to={`/admin?date=${b.date}&booking=${b.id}`}>{formatDate(b.date, { month: 'short', day: 'numeric', year: 'numeric' })}</Link></td>
              <td>{b.kind === 'wait' ? `${formatTime(b.start_time)} wait` : b.start_time ? `drop-off ${formatTime(b.start_time)}` : 'drop-off'}</td>
              <td>{b.booking_services.map((x: any) => x.services.name).join(', ')}</td><td>{STATUS_LABEL[b.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Service history</h3>
      <table className="tbl">
        <tbody>
          {(history.data as any[] | null)?.map((h) => (
            <tr key={h.id}><td>{formatDate(h.service_date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>{h.services?.name ?? h.raw_service}</td><td>{[h.vehicles?.year, h.vehicles?.make, h.vehicles?.model].filter(Boolean).join(' ')}</td><td className="muted">{h.mileage ? `${h.mileage.toLocaleString()} mi` : ''} {h.source}</td></tr>
          ))}
          {history.data?.length === 0 && <tr><td className="muted">None</td></tr>}
        </tbody>
      </table>

      {role !== 'staff' && (
        <div className="danger-zone">
          <h3>Remove this customer</h3>
          <p className="help">For a customer who asks to be forgotten: removes their name, contact details, vehicles and service history, and cancels upcoming appointments (no email is sent). Past bookings stay without their details. This can’t be undone.</p>
          <button className="btn small danger" onClick={forget}>Forget this customer</button>
        </div>
      )}

      <h3>Reminders sent</h3>
      <table className="tbl">
        <tbody>
          {(reminders.data as any[] | null)?.map((r) => (
            <tr key={r.id}><td>{new Date(r.created_at).toLocaleDateString()}</td><td>Step {r.step} · {r.channel}</td><td>{r.services?.name}</td><td>{r.status}</td></tr>
          ))}
          {reminders.data?.length === 0 && <tr><td className="muted">None</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function VehicleRow({ v, onSaved }: { v: any; onSaved: () => void }) {
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await adminPost('vehicle', { ...(v.id ? { id: v.id } : { customer_id: v.customer_id }), year: String(f.get('year') ?? ''), make: String(f.get('make') ?? ''), model: String(f.get('model') ?? ''), notes: String(f.get('notes') ?? '') });
    if (!v.id) e.currentTarget.reset();
    onSaved();
  }
  async function remove() {
    const name = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'this vehicle';
    if (!confirm(`Delete ${name}? Its service history goes too, so reminders for it stop. Past bookings stay.`)) return;
    await adminPost('vehicle', { id: v.id, delete: true });
    onSaved();
  }
  return (
    <tr>
      <td colSpan={4}>
        <form className="row" onSubmit={save}>
          <input name="year" defaultValue={v.year ?? ''} placeholder="Year" size={5} aria-label="Year" />
          <input name="make" defaultValue={v.make ?? ''} placeholder="Make" aria-label="Make" />
          <input name="model" defaultValue={v.model ?? ''} placeholder="Model" aria-label="Model" />
          <input name="notes" defaultValue={v.notes ?? ''} placeholder="Plate / notes" aria-label="Plate or notes" />
          <button className="btn small">{v.id ? 'Save' : 'Add vehicle'}</button>
          {v.id && <button type="button" className="btn small danger" onClick={remove}>Delete</button>}
        </form>
      </td>
    </tr>
  );
}

// After a monthly TRACS import: online-booked customers who probably match a
// TRACS record the tech created at their first visit. Merge keeps the TRACS record.
function MatchReview({ onMerged }: { onMerged: () => void }) {
  const q = useQuery(() => adminPost<{ pairs: any[] }>('matches', {}));
  const [msg, setMsg] = useState('');
  if (!q.data?.pairs.length) return null;
  const who = (c: any) => [c.name, formatPhone(c.phone), c.email, c.address_line1, (c.vehicles ?? []).map((v: any) => [v.year, v.make, v.model].filter(Boolean).join(' ')).join(', ')].filter(Boolean).join(' · ');
  async function merge(p: any) {
    if (!confirm(`Merge “${p.app.name}” (booked online) into the TRACS record “${p.tracs.name}”? Their bookings move to the TRACS record. You can undo this on the customer’s page.`)) return;
    await adminPost('merge', { keep_id: p.tracs_id, merge_id: p.app_id });
    setMsg(`Merged ${p.app.name}.`);
    q.reload();
    onMerged();
  }
  async function dismiss(p: any) {
    await adminPost('match-dismiss', { app_id: p.app_id, tracs_id: p.tracs_id });
    q.reload();
  }
  return (
    <div className="settings-section match-review">
      <h2>Possible matches from the last import <span className="count-pill">{q.data.pairs.length}</span></h2>
      <p className="help">Customers who booked online, and a TRACS record that’s probably the same person (the tech set them up at their first visit).</p>
      <ul className="acct-list">
        {q.data.pairs.map((p) => (
          <li key={`${p.app_id}-${p.tracs_id}`}>
            <div><span className="badge">Booked online</span> {who(p.app)}</div>
            <div><span className="badge">TRACS #{p.tracs.epicor_id}</span> {who(p.tracs)}</div>
            <div className="muted small">Why: {p.reasons.join(', ')}</div>
            <div className="row">
              <button className="btn small primary" onClick={() => merge(p)}>Merge into TRACS record</button>
              <button className="btn small" onClick={() => dismiss(p)}>Not the same</button>
            </div>
          </li>
        ))}
      </ul>
      {msg && <p className="muted small" role="status">{msg}</p>}
    </div>
  );
}

export function Customers() {
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [byPlate, setByPlate] = useState(false);
  const selected = params.get('id');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(t);
  }, [term]);
  const list = useQuery(() => (byPlate ? searchByPlate(debounced) : search(debounced)) as Promise<any[]>, [debounced, byPlate]);

  return (
    <>
    <MatchReview onMerged={() => list.reload()} />
    <div className="split">
      <aside className="list-pane">
        <input className="search" placeholder={byPlate ? 'Plate or car notes' : 'Search name, phone, email'} value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search customers" />
        <label className="check-row small"><input type="checkbox" checked={byPlate} onChange={(e) => setByPlate(e.target.checked)} /> Search plate / car notes</label>
        <ul className="pick-list">
          {list.data?.map((c) => (
            <li key={c.id}>
              <button className={selected === c.id ? 'on' : ''} onClick={() => setParams({ id: c.id })}>
                <strong>{c.name}</strong>
                <span className="muted small">{formatPhone(c.phone)} {c.email}</span>
                {(c.email_opt_out || c.mail_opt_out || c.always_review) && (
                  <span className="small">{c.always_review && <span className="badge warn">review</span>}{c.email_opt_out && <span className="badge">no email</span>}{c.mail_opt_out && <span className="badge">no mail</span>}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="detail-pane">{selected ? <Detail id={selected} onChanged={list.reload} /> : <p className="muted">Pick a customer.</p>}</section>
    </div>
    </>
  );
}
