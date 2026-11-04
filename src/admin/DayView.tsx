import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { Modal, OverrideConfirm, minutesOf, must, todayIn, useQuery, useRole, useSettings, type Settings } from './shared';
import { BookingForm } from './BookingForm';
import { CustomerCard, TracsBadge } from './CustomerCard';
import { addDays, formatDate, formatTime, DOW_KEYS } from '../../shared/time';
import { formatPhone } from '../../shared/phone';
import { STATUS_LABEL } from '../../shared/rules';

const SELECT = 'id, root_id, replaces_booking_id, change_kind, date, kind, start_time, total_minutes, status, customer_notes, auto_confirmed, approval_level, undo_until, created_at, created_by_type, source, customer_id, customers(id, name, phone, email, always_review, epicor_id), vehicles(year, make, model, notes), booking_services(services(id, name))';

export interface B {
  id: string; root_id: string; replaces_booking_id: string | null; change_kind: string | null;
  date: string; kind: 'wait' | 'dropoff'; start_time: string | null; total_minutes: number; status: string;
  customer_notes: string; auto_confirmed: boolean; approval_level: string | null; undo_until: string | null;
  created_at: string; created_by_type: string; source: string | null; customer_id: string;
  customers: { id: string; name: string; phone: string | null; email: string | null; always_review: boolean; epicor_id: string | null };
  vehicles: { year: number | null; make: string | null; model: string | null; notes: string } | null;
  booking_services: { services: { id: string; name: string } }[];
}

const svcNames = (b: B) => b.booking_services.map((x) => x.services.name).join(', ');
const vehicle = (b: B) => [b.vehicles?.year, b.vehicles?.make, b.vehicles?.model].filter(Boolean).join(' ');

function when(s: Settings, b: Pick<B, 'date' | 'kind' | 'start_time'>) {
  const d = formatDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' });
  if (b.kind === 'wait') return `${d} · ${formatTime(b.start_time)} wait`;
  return b.start_time ? `${d} · drop-off ${formatTime(b.start_time)}` : `${d} · drop-off ${formatTime(s.dropoff_window_start)}–${formatTime(s.dropoff_window_end)}`;
}

function hoursFor(s: Settings, date: string) {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const h = s.hours[DOW_KEYS[dow]];
  return h ? { open: minutesOf(h.open), close: minutesOf(h.close) } : null;
}

// ---------------------------------------------------------------------------

function SlotFields({ value, onChange }: { value: { date: string; kind: 'wait' | 'dropoff'; start_time: string }; onChange: (v: any) => void }) {
  return (
    <div className="row wrap">
      <input type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} aria-label="Date" />
      <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value })} aria-label="Type">
        <option value="wait">Wait</option>
        <option value="dropoff">Drop-off</option>
      </select>
      <input type="time" step={900} value={value.start_time} onChange={(e) => onChange({ ...value, start_time: e.target.value })} aria-label={value.kind === 'wait' ? 'Start time' : 'Drop-off time (optional)'} title={value.kind === 'wait' ? undefined : 'Optional for drop-offs'} />
    </div>
  );
}

function RequestCard({ b, original, s, onDone }: { b: B; original: B | null; s: Settings; onDone: () => void }) {
  const [mode, setMode] = useState<'idle' | 'propose' | 'decline'>('idle');
  const [slot, setSlot] = useState({ date: b.date, kind: b.kind, start_time: b.start_time?.slice(0, 5) ?? (b.kind === 'wait' ? '09:00' : '') });
  const [reason, setReason] = useState('');
  const [violations, setViolations] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setErr('');
    try {
      const r = await adminPost('decide', { booking_id: b.id, action, reason: reason || undefined, ...extra });
      if (r.ok) return onDone();
      if (r.violations) setViolations(r.violations);
      else setErr(r.error ?? 'Could not save');
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const isNew = b.created_by_type === 'public' && !b.change_kind;
  return (
    <div className={`req ${b.change_kind ? 'change' : ''}`}>
      <div className="req-head">
        <span className="badge">{b.change_kind ? 'Change request' : 'New request'}</span>
        <strong>{b.customers.name}</strong> <TracsBadge c={b.customers} />
        <span className="muted">{formatPhone(b.customers.phone)}</span>
        {b.customers.always_review && <span className="badge warn">Always review</span>}
        <span className="muted small push">received {new Date(b.created_at).toLocaleString('en-US', { timeZone: s.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      {original ? (
        <div className="beforeafter">
          <div><span className="lbl">Before</span>{when(s, original)}<br />{svcNames(original)}{original.customer_notes && <div className="note">“{original.customer_notes}”</div>}</div>
          <div><span className="lbl">After</span>{when(s, b)}<br />{svcNames(b)}{b.customer_notes && <div className="note">“{b.customer_notes}”</div>}</div>
        </div>
      ) : (
        <div className="req-body">
          <div><strong>{when(s, b)}</strong> · {svcNames(b)}</div>
          <div className="muted">{vehicle(b)}{b.vehicles?.notes ? ` · ${b.vehicles.notes}` : ''}</div>
          {b.customer_notes && <div className="note">“{b.customer_notes}”</div>}
        </div>
      )}
      {mode === 'idle' && (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => act('approve')}>Approve</button>
          <button className="btn" onClick={() => setMode('propose')}>Propose new time</button>
          <button className="btn danger" onClick={() => setMode('decline')}>Decline</button>
          {isNew && <span className="muted small push">{b.source ? `via ${b.source}` : ''}</span>}
        </div>
      )}
      {mode === 'propose' && (
        <div className="stack-sm">
          <SlotFields value={slot} onChange={setSlot} />
          <input placeholder="Note to customer (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          {violations ? (
            <OverrideConfirm violations={violations} verb="Propose anyway" onCancel={() => setViolations(null)} onConfirm={() => { setViolations(null); act('propose', { ...slot, override: true }); }} />
          ) : (
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => act('propose', slot)}>Confirm at this time</button>
              <button className="btn" onClick={() => setMode('idle')}>Back</button>
            </div>
          )}
        </div>
      )}
      {mode === 'decline' && (
        <div className="stack-sm">
          <input placeholder={b.change_kind ? 'Reason (the original appointment stays)' : 'Reason for the customer'} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="row">
            <button className="btn danger solid" disabled={busy} onClick={() => act('decline')}>Decline and email customer</button>
            <button className="btn" onClick={() => setMode('idle')}>Back</button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function BookingDetail({ b, s, onClose, onChanged }: { b: B; s: Settings; onClose: () => void; onChanged: () => void }) {
  const role = useRole();
  const [slot, setSlot] = useState({ date: b.date, kind: b.kind, start_time: b.start_time?.slice(0, 5) ?? (b.kind === 'wait' ? '09:00' : '') });
  const [violations, setViolations] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');

  const [reopen, setReopen] = useState<string[] | null>(null);
  async function status(st: string, override = false) {
    if (st === 'cancelled' && !confirm('Cancel this booking and email the customer?')) return;
    try {
      const r = await adminPost('status', { booking_id: b.id, status: st, override });
      if (r.ok) { onChanged(); onClose(); } else if (r.violations) setReopen(r.violations); else setMsg(r.error);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }
  async function move(override = false) {
    const r = await adminPost('move', { booking_id: b.id, ...slot, override });
    if (r.ok) { onChanged(); onClose(); } else if (r.violations) setViolations(r.violations); else setMsg(r.error);
  }
  async function undo() {
    if (!confirm('Undo the auto-confirm and put this booking back in your queue?')) return;
    const r = await adminPost('decide', { booking_id: b.id, action: 'undo' });
    if (r.ok) { onChanged(); onClose(); } else setMsg(r.error === 'undo_window_closed' ? 'The undo window has closed.' : r.error);
  }

  const canUndo = b.status === 'confirmed' && b.auto_confirmed && b.undo_until && new Date(b.undo_until) > new Date();
  return (
    <Modal title={b.customers.name} onClose={onClose}>
      <dl className="kv">
        <dt>Status</dt><dd>{STATUS_LABEL[b.status]}{b.auto_confirmed ? ' (auto-confirmed)' : ''}</dd>
        <dt>When</dt><dd>{when(s, b)} · {b.total_minutes} min</dd>
        <dt>Service</dt><dd>{svcNames(b)}</dd>
        <dt>Vehicle</dt><dd>{vehicle(b)}{b.vehicles?.notes ? ` · ${b.vehicles.notes}` : ''}</dd>
        <dt>Phone</dt><dd>{formatPhone(b.customers.phone)}</dd>
        <dt>Email</dt><dd>{b.customers.email}</dd>
        {b.customer_notes && <><dt>Notes</dt><dd className="note">{b.customer_notes}</dd></>}
      </dl>
      <TracsBadge c={b.customers} />
      <details className="cust-details">
        <summary>Customer details</summary>
        <CustomerCard id={b.customer_id} />
        {role === 'developer' && <p><Link to={`/admin/customers?id=${b.customer_id}`}>Edit customer record</Link></p>}
      </details>
      <div className="row wrap">
        {['confirmed', 'requested'].includes(b.status) && <button className="btn primary" onClick={() => status('completed')}>Mark completed</button>}
        {['confirmed', 'requested'].includes(b.status) && <button className="btn" onClick={() => status('no_show')}>No-show</button>}
        {['confirmed', 'requested'].includes(b.status) && <button className="btn danger" onClick={() => status('cancelled')}>Cancel</button>}
        {['completed', 'no_show', 'cancelled'].includes(b.status) && <button className="btn" onClick={() => status('confirmed')}>Reopen as confirmed</button>}
        {canUndo && <button className="btn" onClick={undo}>Undo auto-confirm</button>}
        <button className="btn" onClick={async () => { await adminPost('resend', { booking_id: b.id }); setMsg('Email re-sent.'); }}>Resend email</button>
      </div>
      {reopen && (
        <OverrideConfirm violations={reopen} verb="Reopen anyway" onCancel={() => setReopen(null)} onConfirm={() => status('confirmed', true)} />
      )}
      {['confirmed', 'requested'].includes(b.status) && (
        <div className="move">
          <h3>Move</h3>
          <SlotFields value={slot} onChange={setSlot} />
          {violations ? (
            <OverrideConfirm violations={violations} verb="Move anyway" onCancel={() => setViolations(null)} onConfirm={() => move(true)} />
          ) : (
            <button className="btn" onClick={() => move(false)}>Move and email customer</button>
          )}
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export interface Block { id: string; date: string | null; weekday: number | null; start_time: string; end_time: string; reason: string }

const WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const isoDow = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;

export function blockLabel(b: Block) {
  const when = b.weekday ? `Every ${WEEKDAY[b.weekday]}` : formatDate(b.date!, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${when}, ${formatTime(b.start_time)}–${formatTime(b.end_time)}${b.reason ? ` · ${b.reason}` : ''}`;
}

// Find a booking by customer name, phone, or email, across all dates.
function BookingSearch({ onPick }: { onPick: (date: string, id: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<B[] | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setRows(null);
    const timer = setTimeout(async () => {
      const digits = term.replace(/\D/g, '');
      const like = `%${term.replace(/[%_,()]/g, ' ')}%`;
      const ors = [`name.ilike.${like}`, `email.ilike.${like}`, ...(digits.length >= 3 ? [`phone.ilike.%${digits}%`] : [])];
      const custs = (await must(supabase.from('customers').select('id').is('merged_into', null).or(ors.join(',')).limit(25))) as { id: string }[];
      if (!custs.length) return setRows([]);
      const found = (await must(supabase.from('bookings').select(SELECT).in('customer_id', custs.map((c) => c.id)).neq('status', 'replaced').order('date', { ascending: false }).limit(25))) as unknown as B[];
      setRows(found);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <div className="booking-search">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a booking: name, phone or email" aria-label="Find a booking" />
      {rows && (
        <ul className="search-results">
          {rows.length === 0 && <li className="muted">No bookings found.</li>}
          {rows.map((b) => (
            <li key={b.id}>
              <button className="linkish" onClick={() => { setQ(''); onPick(b.date, b.id); }}>
                <strong>{b.customers.name}</strong> · {formatDate(b.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                {b.start_time ? ` ${formatTime(b.start_time)}` : ''} {b.kind === 'wait' ? 'wait' : 'drop-off'} · {svcNames(b)} · <span className="muted">{STATUS_LABEL[b.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The day as a plain list for printing (shown only when printing).
function PrintDay({ s, date, rows, blocks }: { s: Settings; date: string; rows: B[]; blocks: Block[] }) {
  const live = rows.filter((b) => ['confirmed', 'requested', 'completed'].includes(b.status))
    .sort((a, b) => (a.start_time ?? '99').localeCompare(b.start_time ?? '99'));
  return (
    <div className="print-day">
      <h2>{s.shop_name} · {formatDate(date)}</h2>
      {blocks.length > 0 && <p>Blocked: {blocks.map((bl) => `${formatTime(bl.start_time)}–${formatTime(bl.end_time)}${bl.reason ? ` (${bl.reason})` : ''}`).join(', ')}</p>}
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Customer</th><th>Phone</th><th>Vehicle</th><th>Services</th><th>Notes</th><th>Status</th></tr></thead>
        <tbody>
          {live.map((b) => (
            <tr key={b.id}>
              <td>{b.start_time ? formatTime(b.start_time) : '—'}</td><td>{b.kind === 'wait' ? 'Wait' : 'Drop-off'}</td>
              <td>{b.customers.name}</td><td>{formatPhone(b.customers.phone)}</td>
              <td>{vehicle(b)}{b.vehicles?.notes ? ` · ${b.vehicles.notes}` : ''}</td><td>{svcNames(b)}</td>
              <td>{b.customer_notes}</td><td>{STATUS_LABEL[b.status]}</td>
            </tr>
          ))}
          {live.length === 0 && <tr><td colSpan={8}>No bookings.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Total minutes covered by possibly overlapping [start, end) spans.
function mergedMinutes(spans: number[][]) {
  let total = 0;
  let end = -1;
  for (const [s, e] of spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
}

export interface Affected { id: string; date: string; kind: string; start_time: string | null; customer: string }

// Bookings already inside a closure or block being saved. Saving doesn't
// cancel or move them and nobody is told, so staff see them and decide.
export function AffectedBookings({ list, what, onConfirm, onCancel }: { list: Affected[]; what: string; onConfirm: () => void; onCancel: () => void }) {
  const one = list.length === 1;
  return (
    <div className="banner" role="alert">
      <p><strong>{one ? '1 booking is' : `${list.length} bookings are`} already in this {what}.</strong> Saving won’t cancel or move {one ? 'it' : 'them'}, and {one ? 'the customer isn’t' : 'the customers aren’t'} told. Move or call {one ? 'them' : 'each one'} from the day view.</p>
      <ul>
        {list.map((b) => (
          <li key={b.id}>{formatDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })} · {b.start_time ? formatTime(b.start_time) : 'any time'} {b.kind === 'wait' ? 'wait' : 'drop-off'} · {b.customer}</li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="btn primary small" onClick={onConfirm}>Save anyway</button>
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Block part of a day from online booking, once or every week.
export function BlockForm({ date, onDone }: { date: string; onDone: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ body: Record<string, unknown>; list: Affected[] } | null>(null);
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setErr('');
    try {
      const r = await adminPost('block', body);
      if (r?.error === 'bookings_affected') setPending({ body, list: r.bookings });
      else {
        setPending(null);
        onDone();
      }
    } catch (x) {
      setErr(String((x as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const d = String(f.get('date'));
    await send({
      ...(f.get('weekly') === 'on' ? { weekday: isoDow(d) } : { date: d }),
      start_time: f.get('start_time'), end_time: f.get('end_time'), reason: f.get('reason'),
    });
  }
  return (
    <form className="block-form" onSubmit={save}>
      <label>Day<input type="date" name="date" required defaultValue={date} /></label>
      <div className="row">
        <label>From<input type="time" name="start_time" required step={900} defaultValue="13:00" /></label>
        <label>To<input type="time" name="end_time" required step={900} defaultValue="17:30" /></label>
      </div>
      <label>Reason <span className="muted small">(only staff see this)</span><input name="reason" maxLength={100} placeholder="Tech out, long job, meeting…" /></label>
      <label className="check-row"><input type="checkbox" name="weekly" /> Repeat every week on this weekday</label>
      <p className="help">Customers can’t book online during this time, and it comes off the day’s capacity. Bookings already in that time stay; you can still book over it by phone.</p>
      {err && <p className="error">{err}</p>}
      {pending
        ? <AffectedBookings list={pending.list} what="time" onConfirm={() => send({ ...pending.body, confirm: true })} onCancel={() => setPending(null)} />
        : <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Block time'}</button>}
    </form>
  );
}

export function DayView({ refresh }: { refresh?: unknown } = {}) {
  const { data: s } = useSettings();
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState<string>(params.get('date') ?? '');
  const [detail, setDetail] = useState<B | null>(null);
  const [newAt, setNewAt] = useState<{ date: string; kind: 'wait' | 'dropoff'; start_time: string } | null>(null);
  // A drop asks first: moving emails the customer. violations is set once the rules object.
  const [dragMove, setDragMove] = useState<{ b: B; slot: any; violations: string[] | null; err?: string } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const undoId = params.get('undo');
  const openId = params.get('booking'); // from a customer's booking list or search

  useEffect(() => {
    if (s && !date) setDate(todayIn(s.timezone));
  }, [s]);

  const requests = useQuery(async () => {
    const rows = (await must(supabase.from('bookings').select(SELECT).eq('status', 'requested').order('created_at'))) as unknown as B[];
    const origIds = rows.map((r) => r.replaces_booking_id).filter(Boolean) as string[];
    const originals = origIds.length ? ((await must(supabase.from('bookings').select(SELECT).in('id', origIds))) as unknown as B[]) : [];
    return { rows, originals: Object.fromEntries(originals.map((o) => [o.id, o])) as Record<string, B> };
  }, []);

  const undoable = useQuery(async () => {
    const rows = (await must(supabase.from('bookings').select(SELECT).eq('status', 'confirmed').eq('auto_confirmed', true).gt('undo_until', new Date().toISOString()).order('created_at', { ascending: false }))) as unknown as B[];
    return rows;
  }, []);

  const day = useQuery(async () => {
    if (!date) return [] as B[];
    return (await must(supabase.from('bookings').select(SELECT).eq('date', date).neq('status', 'replaced').neq('status', 'declined').order('start_time'))) as unknown as B[];
  }, [date]);

  const blocks = useQuery(async () => {
    if (!date) return [] as Block[];
    return (await must(supabase.from('time_blocks').select('*').or(`date.eq.${date},weekday.eq.${isoDow(date)}`).order('start_time'))) as Block[];
  }, [date]);

  // Stay current on a shop iPad left open: refresh every minute, when the tab
  // comes back into view, and when the Test lab sees a new email.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && reloadAll();
    const timer = setInterval(onVisible, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => { if (refresh !== undefined) reloadAll(); }, [refresh]);

  // Wait for the booking's own day to load (the previous day's data may come first).
  useEffect(() => {
    const b = openId && day.data?.find((x) => x.id === openId);
    if (!b) return;
    setDetail(b);
    params.delete('booking');
    setParams(params, { replace: true });
  }, [openId, day.data]);

  function reloadAll() {
    requests.reload();
    undoable.reload();
    day.reload();
    blocks.reload();
  }

  const layout = useMemo(() => {
    if (!s || !date || !day.data) return null;
    const hrs = hoursFor(s, date);
    const holding = day.data.filter((b) => ['requested', 'confirmed', 'completed'].includes(b.status));
    const visible = day.data.filter((b) => showCancelled || !['cancelled'].includes(b.status));
    const waits = visible.filter((b) => b.kind === 'wait').sort((a, b) => a.start_time!.localeCompare(b.start_time!));
    const laneEnds: number[] = Array.from({ length: s.total_lanes }, () => -1);
    const placed = waits.map((b) => {
      const st = minutesOf(b.start_time!);
      let lane = laneEnds.findIndex((end) => end <= st);
      if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
      laneEnds[lane] = st + b.total_minutes;
      return { b, lane, st };
    });
    // Same as the server: blocked minutes come off the day's capacity.
    const blocked = hrs ? mergedMinutes((blocks.data ?? []).map((bl) => [Math.max(minutesOf(bl.start_time), hrs.open), Math.min(minutesOf(bl.end_time), hrs.close)])) : 0;
    const cap = hrs ? s.total_lanes * Math.max(0, hrs.close - hrs.open - blocked) : 0;
    const used = holding.reduce((n, b) => n + b.total_minutes, 0);
    const dropUsed = holding.filter((b) => b.kind === 'dropoff').reduce((n, b) => n + b.total_minutes, 0);
    return { hrs, placed, dropoffs: visible.filter((b) => b.kind === 'dropoff'), cap, used, dropUsed, dropCap: Math.floor((cap * s.dropoff_share_pct) / 100) };
  }, [s, date, day.data, blocks.data, showCancelled]);

  if (!s || !date) return <p className="loading">Loading…</p>;

  const PPM = 1.6; // pixels per minute
  const step = s.slot_step_minutes;

  function goto(d: string) {
    setDate(d);
    params.set('date', d);
    setParams(params, { replace: true });
  }

  function minuteAt(e: { clientX: number; currentTarget: HTMLElement }) {
    const rect = e.currentTarget.getBoundingClientRect();
    const m = layout!.hrs!.open + (e.clientX - rect.left) / PPM;
    const snapped = layout!.hrs!.open + Math.max(0, Math.round((m - layout!.hrs!.open) / step) * step);
    return `${String(Math.floor(snapped / 60)).padStart(2, '0')}:${String(snapped % 60).padStart(2, '0')}`;
  }

  async function dropMove(b: B, slot: { date: string; kind: 'wait' | 'dropoff'; start_time: string | null }, notify: boolean, override = false) {
    try {
      const r = await adminPost('move', { booking_id: b.id, ...slot, start_time: slot.start_time ?? undefined, override, notify });
      if (r.ok) { setDragMove(null); reloadAll(); } else if (r.violations) setDragMove({ b, slot, violations: r.violations, notify } as any);
      else setDragMove({ b, slot, violations: null, err: r.error ?? 'Could not move' });
    } catch (e) {
      setDragMove({ b, slot, violations: null, err: String((e as Error).message) });
    }
  }

  function askMove(b: B, slot: { date: string; kind: 'wait' | 'dropoff'; start_time: string | null }) {
    if (b.kind === slot.kind && (b.start_time ?? '').slice(0, 5) === (slot.start_time ?? '')) return; // dropped where it was
    setDragMove({ b, slot, violations: null });
  }

  function onLaneDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/booking');
    const b = day.data?.find((x) => x.id === id);
    if (b) askMove(b, { date, kind: 'wait', start_time: minuteAt(e) });
  }

  function onDropoffDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/booking');
    const b = day.data?.find((x) => x.id === id);
    if (b && b.kind !== 'dropoff') askMove(b, { date, kind: 'dropoff', start_time: null });
  }

  const undoTarget = undoId ? undoable.data?.find((b) => b.id === undoId) : null;
  const hours = layout?.hrs ? Array.from({ length: Math.ceil((layout.hrs.close - layout.hrs.open) / 60) + 1 }, (_, i) => layout.hrs!.open + i * 60).filter((m) => m <= layout.hrs!.close) : [];

  return (
    <div className="day-view">
      {undoId && (
        <div className="banner">
          {undoTarget ? (
            <>Undo the auto-confirmed booking for <strong>{undoTarget.customers.name}</strong> ({when(s, undoTarget)})?{' '}
              <button className="btn small" onClick={async () => { await adminPost('decide', { booking_id: undoId, action: 'undo' }); params.delete('undo'); setParams(params); reloadAll(); }}>Undo — put it in my queue</button>{' '}
              <button className="btn small" onClick={() => { params.delete('undo'); setParams(params); }}>Keep it</button></>
          ) : (
            <>That booking can no longer be undone (the window closed or it was already changed). <button className="btn small" onClick={() => { params.delete('undo'); setParams(params); }}>OK</button></>
          )}
        </div>
      )}

      <BookingSearch onPick={(d, id) => { goto(d); params.set('booking', id); setParams(params, { replace: true }); }} />

      <section className="queue" aria-label="Waiting for you">
        <h2>Waiting for you {requests.data && <span className="count-pill">{requests.data.rows.length}</span>}</h2>
        {requests.error && <p className="error" role="alert">Couldn’t load requests: {requests.error} <button className="btn small" onClick={requests.reload}>Try again</button></p>}
        {requests.data?.rows.length === 0 && <p className="muted">Nothing to approve.</p>}
        {requests.data?.rows.map((b) => (
          <RequestCard key={b.id} b={b} s={s} original={b.replaces_booking_id ? requests.data!.originals[b.replaces_booking_id] ?? null : null} onDone={reloadAll} />
        ))}
        {!!undoable.data?.length && (
          <details className="undoable">
            <summary>{undoable.data.length} auto-confirmed booking{undoable.data.length > 1 ? 's' : ''} you can still undo</summary>
            {undoable.data.map((b) => (
              <div key={b.id} className="row">
                <span><strong>{b.customers.name}</strong> · {when(s, b)} · {svcNames(b)}</span>
                <span className="muted small">until {new Date(b.undo_until!).toLocaleTimeString('en-US', { timeZone: s.timezone, hour: 'numeric', minute: '2-digit' })}</span>
                <button className="btn small" onClick={async () => { if (!confirm(`Undo the auto-confirmed booking for ${b.customers.name} and put it back in your queue?`)) return; await adminPost('decide', { booking_id: b.id, action: 'undo' }); reloadAll(); }}>Undo</button>
              </div>
            ))}
          </details>
        )}
      </section>

      <section className="day-panel" aria-label="Day schedule">
        <div className="day-head">
          <button className="btn small" onClick={() => goto(addDays(date, -1))} aria-label="Previous day">←</button>
          <h2>{formatDate(date)}</h2>
          <button className="btn small" onClick={() => goto(addDays(date, 1))} aria-label="Next day">→</button>
          <button className="btn small" onClick={() => goto(todayIn(s.timezone))}>Today</button>
          <input type="date" value={date} onChange={(e) => e.target.value && goto(e.target.value)} aria-label="Go to date" />
          <label className="small"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> show cancelled</label>
          <button className="btn small" onClick={() => setBlocking(true)}>Block time</button>
          <button className="btn small" onClick={() => window.print()}>Print day</button>
          {layout && layout.cap > 0 && (
            <div className="capacity push">
              <span>Booked <strong>{layout.used}</strong> / {layout.cap} min ({Math.round((100 * layout.used) / layout.cap)}%)</span>
              <span>Drop-off <strong>{layout.dropUsed}</strong> / {layout.dropCap} min</span>
            </div>
          )}
        </div>

        {!!blocks.data?.length && (
          <ul className="blocks-list">
            {blocks.data.map((bl) => (
              <li key={bl.id}>
                <span>Blocked: {blockLabel(bl)}</span>
                <button className="btn small" onClick={async () => { if (!confirm(`Remove ${bl.weekday ? 'this weekly block (every week)' : 'this block'}? Customers will be able to book that time again.`)) return; await adminPost('block', { id: bl.id, delete: true }); blocks.reload(); }}>
                  {bl.weekday ? 'Remove (every week)' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {day.error && <p className="error" role="alert">Couldn’t load this day: {day.error} <button className="btn small" onClick={day.reload}>Try again</button></p>}
        {!layout?.hrs ? (
          <p className="muted">Closed this day.</p>
        ) : (
          <div className="day-grid">
            <div className="timeline-wrap">
              <div className="timeline" style={{ width: (layout.hrs.close - layout.hrs.open) * PPM + 60 }}>
                <div className="tl-hours" style={{ marginLeft: 60 }}>
                  {hours.map((m) => (
                    <span key={m} style={{ left: (m - layout.hrs!.open) * PPM }}>{formatTime(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)}</span>
                  ))}
                </div>
                {Array.from({ length: s.total_lanes }, (_, lane) => (
                  <div key={lane} className="tl-row">
                    <div className="tl-label">Lane {lane + 1}</div>
                    <div
                      className="tl-lane"
                      style={{ width: (layout.hrs!.close - layout.hrs!.open) * PPM, backgroundSize: `${60 * PPM}px 100%` }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onLaneDrop}
                      onClick={(e) => { if (e.target === e.currentTarget) setNewAt({ date, kind: 'wait', start_time: minuteAt(e) }); }}
                      title="Click to book a waiter here"
                    >
                      {blocks.data?.map((bl) => {
                        const st = Math.max(minutesOf(bl.start_time), layout.hrs!.open);
                        const en = Math.min(minutesOf(bl.end_time), layout.hrs!.close);
                        return en > st && <div key={bl.id} className="tl-block" style={{ left: (st - layout.hrs!.open) * PPM, width: (en - st) * PPM }} title={blockLabel(bl)} />;
                      })}
                      {layout.placed.filter((p) => p.lane === lane).map(({ b, st }) => (
                        <button
                          key={b.id}
                          className={`blk st-${b.status}`}
                          style={{ left: (st - layout.hrs!.open) * PPM, width: Math.max(b.total_minutes * PPM - 2, 24) }}
                          draggable={['confirmed', 'requested'].includes(b.status)}
                          onDragStart={(e) => e.dataTransfer.setData('text/booking', b.id)}
                          onClick={() => setDetail(b)}
                          title={`${b.customers.name} · ${formatTime(b.start_time)} · ${svcNames(b)}`}
                        >
                          <strong>{b.customers.name}</strong>
                          <span>{formatTime(b.start_time)} · {svcNames(b)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dropoffs" onDragOver={(e) => e.preventDefault()} onDrop={onDropoffDrop}>
              <div className="row">
                <h3>Drop-offs ({layout.dropoffs.length})</h3>
                <button className="btn small push" onClick={() => setNewAt({ date, kind: 'dropoff', start_time: '' })}>+ Add</button>
              </div>
              {layout.dropoffs.length === 0 && <p className="muted small">None yet. Drag a waiter here to make it a drop-off.</p>}
              {layout.dropoffs.map((b) => (
                <button key={b.id} className={`drop st-${b.status}`} draggable={['confirmed', 'requested'].includes(b.status)} onDragStart={(e) => e.dataTransfer.setData('text/booking', b.id)} onClick={() => setDetail(b)}>
                  <strong>{b.customers.name}</strong> <span className="muted">{b.start_time ? `${formatTime(b.start_time)} · ` : ''}{b.total_minutes} min</span> <TracsBadge c={b.customers} />
                  <span>{svcNames(b)} · {vehicle(b)}</span>
                  {b.status !== 'confirmed' && <span className="badge">{STATUS_LABEL[b.status]}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {s && date && day.data && <PrintDay s={s} date={date} rows={day.data} blocks={blocks.data ?? []} />}
        <p className="legend muted small">
          <span className="key st-confirmed" /> confirmed <span className="key st-requested" /> requested (held) <span className="key st-completed" /> completed <span className="key st-no_show" /> no-show · Drag to move · click an empty lane to book
        </p>
      </section>

      {detail && <BookingDetail b={detail} s={s} onClose={() => setDetail(null)} onChanged={reloadAll} />}
      {blocking && (
        <Modal title="Block time" onClose={() => setBlocking(false)}>
          <BlockForm date={date} onDone={() => { setBlocking(false); blocks.reload(); }} />
        </Modal>
      )}
      {newAt && (
        <Modal title="New booking" onClose={() => setNewAt(null)}>
          <BookingForm initial={newAt} onDone={() => { setNewAt(null); reloadAll(); }} />
        </Modal>
      )}
      {dragMove && (
        <Modal title="Move booking" onClose={() => setDragMove(null)}>
          <p><strong>{dragMove.b.customers.name}</strong>: {when(s, dragMove.b)} → {when(s, { ...dragMove.slot })}</p>
          {dragMove.violations ? (
            <OverrideConfirm violations={dragMove.violations} verb="Move anyway" onCancel={() => setDragMove(null)} onConfirm={() => dropMove(dragMove.b, dragMove.slot, (dragMove as any).notify ?? true, true)} />
          ) : (
            <div className="row wrap">
              <button className="btn primary" onClick={() => dropMove(dragMove.b, dragMove.slot, true)}>Move and email customer</button>
              <button className="btn" onClick={() => dropMove(dragMove.b, dragMove.slot, false)}>Move, don’t email</button>
              <button className="btn" onClick={() => setDragMove(null)}>Cancel</button>
            </div>
          )}
          {dragMove.err && <p className="error">{dragMove.err}</p>}
        </Modal>
      )}
    </div>
  );
}
