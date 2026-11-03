import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery, useRole, useServices, useSettings, type ServiceRow, type Settings as S } from './shared';
import { TECH_SETTINGS } from '../../shared/permissions';
import { DOW_KEYS, formatDate } from '../../shared/time';
import { LEVEL_LABEL } from '../../shared/rules';
import { BlockForm, blockLabel, type Block } from './DayView';

type Kind = 'text' | 'int' | 'bool' | 'time' | 'email' | 'color';
interface F { k: string; label: string; t: Kind; help?: string }

const SECTIONS: { title: string; fields: F[] }[] = [
  {
    title: 'Shop',
    fields: [
      { k: 'shop_name', label: 'Shop name', t: 'text' },
      { k: 'shop_phone', label: 'Shop phone', t: 'text', help: 'Shown on every page and used as the fallback when booking fails.' },
      { k: 'shop_address', label: 'Shop address', t: 'text', help: 'Printed in every email footer (required for marketing email).' },
      { k: 'timezone', label: 'Timezone', t: 'text' },
      { k: 'booking_url', label: 'Booking URL', t: 'text' },
      { k: 'brand_color', label: 'Brand color', t: 'color' },
      { k: 'logo_url', label: 'Logo URL', t: 'text' },
    ],
  },
  {
    title: 'Capacity',
    fields: [
      { k: 'total_lanes', label: 'Lanes (bay + tech)', t: 'int' },
      { k: 'waiter_lanes', label: 'Waiter lanes', t: 'int', help: 'Max waiters at the same time. Keep below total lanes so drop-offs always have room.' },
      { k: 'slot_step_minutes', label: 'Slot step (min)', t: 'int' },
      { k: 'buffer_minutes', label: 'Buffer per job (min)', t: 'int' },
      { k: 'dropoff_window_start', label: 'Earliest drop-off time', t: 'time' },
      { k: 'dropoff_window_end', label: 'Latest drop-off time', t: 'time' },
      { k: 'dropoff_share_pct', label: 'Drop-off share of day (%)', t: 'int', help: 'Keeps waiter slots from vanishing by 8am.' },
      { k: 'floor_days', label: 'Earliest online booking (days ahead)', t: 'int' },
      { k: 'max_days_ahead', label: 'Latest online booking (days ahead)', t: 'int' },
    ],
  },
  {
    title: 'Approvals',
    fields: [
      { k: 'notes_require_review', label: 'Bookings with notes need my review', t: 'bool' },
      { k: 'new_customers_require_review', label: 'New customers need my review', t: 'bool' },
      { k: 'notes_max_length', label: 'Notes max length', t: 'int' },
      { k: 'request_turnaround_business_hours', label: 'Promised turnaround (business hours)', t: 'int', help: 'Told to customers in the “request received” email.' },
      { k: 'escalate_staff_business_hours', label: 'Remind staff after (business hours)', t: 'int' },
      { k: 'escalate_owner_business_days', label: 'Alert owner after (business days)', t: 'int' },
      { k: 'ladder_step2_approvals', label: 'Suggest step 2 after N approvals in a row', t: 'int' },
      { k: 'ladder_step3_weeks', label: 'Suggest step 3 after N weeks at step 2 without undo', t: 'int' },
      { k: 'undo_window_hours', label: 'Undo window (hours)', t: 'int' },
      { k: 'change_cutoff_hours', label: 'Customer changes close (hours before)', t: 'int' },
      { k: 'max_future_bookings', label: 'Max future bookings per customer', t: 'int' },
      { k: 'rate_limit_ip_per_hour', label: 'Bookings per IP per hour', t: 'int' },
      { k: 'rate_limit_contact_per_day', label: 'Bookings per email/phone per day', t: 'int' },
    ],
  },
  {
    title: 'Notifications & reminders',
    fields: [
      { k: 'staff_notify_email', label: 'Staff email (requests, notices)', t: 'email' },
      { k: 'owner_alert_email', label: 'Owner email (escalations, failures)', t: 'email' },
      { k: 'from_email', label: 'Send from', t: 'email' },
      { k: 'from_name', label: 'Sender name', t: 'text' },
      { k: 'appointment_reminder_hours', label: 'Appointment reminder (hours before)', t: 'int' },
      { k: 'reminders_dry_run', label: 'Service reminders in dry-run mode (cutover: nothing is sent)', t: 'bool' },
      { k: 'reminder_max_overdue_days', label: 'Ignore services overdue by more than (days)', t: 'int' },
      { k: 'postcard_auto_approve', label: 'Auto-approve postcard batches', t: 'bool' },
      { k: 'postcard_cost_cents', label: 'Estimated cost per postcard (cents)', t: 'int' },
      { k: 'alert_send_failure_pct', label: 'Alert when send failures exceed (%)', t: 'int' },
      { k: 'session_timeout_hours', label: 'Admin session timeout (hours)', t: 'int' },
    ],
  },
];

function SettingsSection({ title, fields, s, onSaved }: { title: string; fields: F[]; s: S; onSaved: () => void }) {
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const patch: Record<string, unknown> = {};
    for (const fd of fields) {
      const raw = f.get(fd.k);
      // A cleared number box is a mistake, not zero.
      if (fd.t === 'int' && String(raw ?? '').trim() === '') return setMsg(`${fd.label} can’t be blank.`);
      const v = fd.t === 'bool' ? raw === 'on' : fd.t === 'int' ? Number(raw) : fd.t === 'time' ? String(raw).slice(0, 5) : String(raw ?? '');
      const cur = fd.t === 'time' ? String(s[fd.k]).slice(0, 5) : s[fd.k];
      if (v !== cur) patch[fd.k] = v;
    }
    if (!Object.keys(patch).length) return setMsg('No changes.');
    try {
      await adminPost('settings', patch);
      setMsg('Saved.');
      onSaved();
    } catch (err) {
      setMsg(String((err as Error).message));
    }
  }
  return (
    <form className="settings-section" onSubmit={save}>
      <h2>{title}</h2>
      <div className="settings-grid">
        {fields.map((fd) => (
          <label key={fd.k} className={fd.t === 'bool' ? 'check-row wide' : ''}>
            {fd.t === 'bool' ? (
              <><input type="checkbox" name={fd.k} defaultChecked={!!s[fd.k]} /> {fd.label}</>
            ) : (
              <>
                {fd.label}
                <input
                  name={fd.k}
                  type={fd.t === 'int' ? 'number' : fd.t === 'time' ? 'time' : fd.t === 'email' ? 'email' : fd.t === 'color' ? 'color' : 'text'}
                  defaultValue={fd.t === 'time' ? String(s[fd.k]).slice(0, 5) : s[fd.k]}
                />
              </>
            )}
            {fd.help && <span className="help">{fd.help}</span>}
          </label>
        ))}
      </div>
      <button className="btn primary">Save {title.toLowerCase()}</button> {msg && <span className="muted" role="status">{msg}</span>}
    </form>
  );
}

function Hours({ s, onSaved }: { s: S; onSaved: () => void }) {
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const hours: Record<string, unknown> = {};
    for (const d of DOW_KEYS) hours[d] = f.get(`${d}_open_flag`) === 'on' ? { open: String(f.get(`${d}_open`)), close: String(f.get(`${d}_close`)) } : null;
    try {
      await adminPost('settings', { hours });
      setMsg('Saved.');
      onSaved();
    } catch (err) {
      setMsg(String((err as Error).message));
    }
  }
  const names = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  return (
    <form className="settings-section" onSubmit={save}>
      <h2>Hours</h2>
      <table className="tbl narrow">
        <tbody>
          {DOW_KEYS.map((d) => (
            <tr key={d}>
              <td>{names[d]}</td>
              <td><label className="check-row"><input type="checkbox" name={`${d}_open_flag`} defaultChecked={!!s.hours[d]} /> open</label></td>
              <td><input type="time" name={`${d}_open`} defaultValue={s.hours[d]?.open ?? '07:30'} aria-label={`${names[d]} open`} /></td>
              <td><input type="time" name={`${d}_close`} defaultValue={s.hours[d]?.close ?? '17:30'} aria-label={`${names[d]} close`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn primary">Save hours</button> {msg && <span className="muted">{msg}</span>}
    </form>
  );
}

function ServiceEditor({ row, onSaved }: { row: Partial<ServiceRow>; onSaved: () => void }) {
  const [msg, setMsg] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (String(f.get(k) ?? '').trim() === '' ? null : Number(f.get(k)));
    try {
      await adminPost('service', {
        ...(row.id ? { id: row.id } : {}),
        name: String(f.get('name')),
        description: String(f.get('description') ?? ''),
        duration_minutes: Number(f.get('duration_minutes')),
        wait_eligible: f.get('wait_eligible') === 'on',
        daily_cap: num('daily_cap'),
        lead_days: num('lead_days'),
        reminder_interval_months: num('reminder_interval_months'),
        sort_order: Number(f.get('sort_order') ?? 0),
        active: f.get('active') === 'on',
        epicor_codes: String(f.get('epicor_codes') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      });
      setMsg('Saved.');
      if (!row.id) e.currentTarget.reset();
      onSaved();
    } catch (err) {
      setMsg(String((err as Error).message));
    }
  }
  const isNew = !row.id;
  return (
    <form className={`svc-card ${row.active === false ? 'off' : ''}`} onSubmit={save}>
      <div className="svc-head">
        <input name="name" defaultValue={row.name ?? ''} placeholder="Service name, e.g. Wheel alignment" required aria-label="Service name" className="svc-name" maxLength={60} />
        <label className="check-row"><input type="checkbox" name="active" defaultChecked={row.active ?? true} /> Offered online</label>
      </div>
      <label className="svc-field">What customers see
        <input name="description" defaultValue={row.description ?? ''} placeholder="One short line under the name" maxLength={200} />
      </label>
      <div className="svc-grid">
        <label className="svc-field">How long it takes (min)
          <input name="duration_minutes" type="number" min={5} max={600} step={5} required defaultValue={row.duration_minutes ?? 60} />
          <span className="help">Shop time this job holds. Sets which times are open.</span>
        </label>
        <label className="svc-field">Most per day
          <input name="daily_cap" type="number" min={0} defaultValue={row.daily_cap ?? ''} placeholder="No limit" />
          <span className="help">Online bookings stop once this many are booked that day.</span>
        </label>
        <label className="svc-field">Extra notice (days)
          <input name="lead_days" type="number" min={0} defaultValue={row.lead_days ?? ''} placeholder="Usual notice" />
          <span className="help">For jobs that need parts ordered first.</span>
        </label>
        <label className="svc-field">Remind every (months)
          <input name="reminder_interval_months" type="number" min={1} defaultValue={row.reminder_interval_months ?? ''} placeholder="No reminders" />
          <span className="help">When to remind customers it’s due again.</span>
        </label>
      </div>
      <label className="check-row"><input type="checkbox" name="wait_eligible" defaultChecked={row.wait_eligible ?? false} /> Customers can wait for this</label>
      <details className="svc-more">
        <summary>More</summary>
        <div className="svc-grid">
          <label className="svc-field">Position in the list
            <input name="sort_order" type="number" min={0} defaultValue={row.sort_order ?? 0} />
          </label>
          <label className="svc-field">Epicor codes
            <input name="epicor_codes" defaultValue={(row.epicor_codes ?? []).join(', ')} placeholder="e.g. OIL, LOF" />
            <span className="help">Matches past service history from Epicor for reminders.</span>
          </label>
        </div>
      </details>
      <div className="svc-foot">
        <button className="btn primary small">{isNew ? 'Add service' : 'Save'}</button>
        {msg && <span className="muted small" role="status">{msg}</span>}
        {row.approval_level && <span className="muted small push">Approval: {LEVEL_LABEL[row.approval_level]}</span>}
      </div>
    </form>
  );
}

function Closures() {
  const list = useQuery(() => must(supabase.from('closures').select('*').gte('end_date', new Date().toISOString().slice(0, 10)).order('start_date')) as Promise<any[]>);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await adminPost('closure', { start_date: f.get('start_date'), end_date: f.get('end_date') || undefined, reason: f.get('reason') });
    e.currentTarget.reset();
    list.reload();
  }
  return (
    <div className="settings-section">
      <h2>Closures</h2>
      <table className="tbl narrow">
        <tbody>
          {list.data?.map((c) => (
            <tr key={c.id}>
              <td>{formatDate(c.start_date, { month: 'short', day: 'numeric', year: 'numeric' })}{c.end_date !== c.start_date && ` – ${formatDate(c.end_date, { month: 'short', day: 'numeric', year: 'numeric' })}`}</td>
              <td>{c.reason}</td>
              <td><button className="btn small danger" onClick={async () => { if (!confirm('Remove this closure? Customers will be able to book that day again.')) return; await adminPost('closure', { id: c.id, delete: true }); list.reload(); }}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={add}>
        <input type="date" name="start_date" required aria-label="First closed day" />
        <input type="date" name="end_date" aria-label="Last closed day" />
        <input name="reason" placeholder="Reason (e.g. Thanksgiving)" maxLength={100} aria-label="Reason" />
        <button className="btn small">Add closure</button>
      </form>
      <p className="help">Existing bookings on a new closure date are not cancelled automatically. Check the day view.</p>
    </div>
  );
}

function TimeBlocks() {
  const today = new Date().toISOString().slice(0, 10);
  const list = useQuery(() => must(supabase.from('time_blocks').select('*').or(`date.gte.${today},weekday.not.is.null`).order('weekday', { nullsFirst: false }).order('date').order('start_time')) as Promise<Block[]>);
  const [adding, setAdding] = useState(false);
  return (
    <div className="settings-section">
      <h2>Blocked time</h2>
      <p className="help">Part of a day customers can’t book online, once or every week. Also available from the Block time button on the day view.</p>
      {list.data?.length === 0 && <p className="muted small">Nothing blocked.</p>}
      <ul className="blocks-list">
        {list.data?.map((b) => (
          <li key={b.id}>
            <span>{blockLabel(b)}</span>
            <button className="btn small danger" onClick={async () => { if (!confirm(`Remove ${blockLabel(b)}?`)) return; await adminPost('block', { id: b.id, delete: true }); list.reload(); }}>Remove</button>
          </li>
        ))}
      </ul>
      {adding
        ? <BlockForm date={today} onDone={() => { setAdding(false); list.reload(); }} />
        : <button className="btn small" onClick={() => setAdding(true)}>Block time</button>}
    </div>
  );
}

function ReminderRules() {
  const list = useQuery(() => must(supabase.from('reminder_rules').select('*').order('step')) as Promise<any[]>);
  async function save(e: FormEvent<HTMLFormElement>, id?: string) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await adminPost('rule', { ...(id ? { id } : {}), step: Number(f.get('step')), channel: f.get('channel'), offset_days: Number(f.get('offset_days')), condition: f.get('condition'), active: f.get('active') === 'on' });
    list.reload();
  }
  const row = (r: any) => (
    <form key={r?.id ?? 'new'} className="row" onSubmit={(e) => save(e, r?.id)}>
      <label>Step<input name="step" type="number" defaultValue={r?.step ?? (list.data?.length ?? 0) + 1} className="w4" /></label>
      <select name="channel" defaultValue={r?.channel ?? 'email'} aria-label="Channel"><option value="email">Email</option><option value="postcard">Postcard</option></select>
      <label><input name="offset_days" type="number" defaultValue={r?.offset_days ?? 0} className="w5" /> days from due (negative = before)</label>
      <select name="condition" defaultValue={r?.condition ?? 'no_booking_since_previous_step'} aria-label="Condition">
        <option value="no_booking_since_due">only if no booking since due</option>
        <option value="no_booking_since_previous_step">only if no booking since previous step</option>
      </select>
      <label className="check-row"><input type="checkbox" name="active" defaultChecked={r?.active ?? true} /> active</label>
      <button className="btn small">{r ? 'Save' : 'Add step'}</button>
    </form>
  );
  return (
    <div className="settings-section">
      <h2>Service reminder steps</h2>
      <p className="help">Due date = last completed service + that type’s reminder interval. A customer stops getting reminders when they book, opt out, bounce, or their address is undeliverable.</p>
      {list.data?.map(row)}
      {row(null)}
    </div>
  );
}

export function Settings() {
  const role = useRole();
  const s = useSettings();
  const services = useServices();
  if (!s.data) return <p className="loading">Loading…</p>;
  return (
    <div className="settings">
      <div className="settings-section">
        <h2>Services</h2>
        <p className="help">What customers can book, in this order. Changing a time affects new bookings only. Approval levels are set on the Approvals page.</p>
        <div className="svc-cards">
          {services.data?.map((r) => <ServiceEditor key={r.id} row={r} onSaved={services.reload} />)}
        </div>
        <details className="svc-add">
          <summary className="btn small">+ Add a service</summary>
          <ServiceEditor row={{}} onSaved={services.reload} />
        </details>
      </div>
      <Hours s={s.data} onSaved={s.reload} />
      <Closures />
      <TimeBlocks />
      {SECTIONS.map((sec) => ({ ...sec, fields: sec.fields.filter((f) => role === 'developer' || !TECH_SETTINGS.has(f.k)) }))
        .filter((sec) => sec.fields.length)
        .map((sec) => <SettingsSection key={sec.title} {...sec} s={s.data!} onSaved={s.reload} />)}
      {role !== 'developer' && <p className="muted small">Technical settings (timezone, sign-in timeout, sender address, alert emails, rate limits) are managed by the developer.</p>}
      <ReminderRules />
    </div>
  );
}
