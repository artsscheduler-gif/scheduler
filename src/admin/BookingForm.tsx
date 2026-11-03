import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { OverrideConfirm, must, useServices } from './shared';
import { formatPhone } from '../../shared/phone';

interface Cust { id: string; name: string; phone: string | null; email: string | null; vehicles: { id: string; year: number | null; make: string | null; model: string | null }[] }

// Phone bookings: same data as the public form, entered by staff. Rules are
// checked; breaking one needs an explicit override click.
export function BookingForm({ initial, onDone }: { initial?: { date: string; kind: 'wait' | 'dropoff'; start_time: string }; onDone?: () => void }) {
  const { data: services } = useServices();
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Cust[]>([]);
  const [customer, setCustomer] = useState<Cust | null>(null);
  const [vehicleId, setVehicleId] = useState<string>('');
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [slot, setSlot] = useState(initial ?? { date: '', kind: 'wait' as 'wait' | 'dropoff', start_time: '09:00' });
  const [violations, setViolations] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (q.trim().length < 2) return setMatches([]);
    const t = setTimeout(async () => {
      const term = q.trim().replace(/[%,()]/g, '');
      const digits = term.replace(/\D/g, '');
      const ors = [`name.ilike.%${term}%`, `email.ilike.%${term}%`];
      if (digits.length >= 3) ors.push(`phone.ilike.%${digits}%`);
      const rows = await must(supabase.from('customers').select('id, name, phone, email, vehicles(id, year, make, model)').is('merged_into', null).or(ors.join(',')).limit(8));
      setMatches(rows as Cust[]);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function send(body: Record<string, unknown>, override = false) {
    const r = await adminPost('create', { ...body, override });
    if (r.ok) {
      setMsg(r.violations_overridden?.length ? 'Booked (rule overridden).' : 'Booked.');
      setViolations(null);
      onDone?.();
    } else if (r.violations) {
      setViolations(r.violations);
      setPending(body);
    } else setMsg(r.error ?? 'Could not book');
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      service_ids: serviceIds,
      customer_notes: String(f.get('notes') ?? ''),
      date: slot.date,
      kind: slot.kind,
      ...(slot.kind === 'wait' || slot.start_time ? { start_time: slot.start_time } : {}),
      send_email: f.get('send_email') === 'on',
    };
    if (customer) {
      body.customer_id = customer.id;
      if (vehicleId) body.vehicle_id = vehicleId;
      else body.vehicle = { year: String(f.get('year') ?? ''), make: String(f.get('make') ?? ''), model: String(f.get('model') ?? '') };
    } else {
      Object.assign(body, {
        name: String(f.get('name') ?? ''),
        phone: String(f.get('phone') ?? '') || undefined,
        email: String(f.get('email') ?? '') || undefined,
        vehicle: { year: String(f.get('year') ?? ''), make: String(f.get('make') ?? ''), model: String(f.get('model') ?? '') },
      });
    }
    try {
      await send(body);
    } catch (err) {
      setMsg(String((err as Error).message));
    }
  }

  return (
    <form className="admin-form" onSubmit={submit}>
      <fieldset>
        <legend>Customer</legend>
        {customer ? (
          <div className="row">
            <strong>{customer.name}</strong> <span className="muted">{formatPhone(customer.phone)} {customer.email}</span>
            <button type="button" className="btn small" onClick={() => { setCustomer(null); setVehicleId(''); }}>Change</button>
          </div>
        ) : (
          <>
            <label>Find existing<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, or email" /></label>
            {matches.length > 0 && (
              <ul className="matches">
                {matches.map((m) => (
                  <li key={m.id}><button type="button" className="linkish" onClick={() => { setCustomer(m); setVehicleId(m.vehicles[0]?.id ?? ''); setQ(''); }}>{m.name} · {formatPhone(m.phone)} · {m.email}</button></li>
                ))}
              </ul>
            )}
            <div className="grid3">
              <label>Name<input name="name" required maxLength={100} /></label>
              <label>Phone<input name="phone" type="tel" maxLength={20} /></label>
              <label>Email<input name="email" type="email" maxLength={254} /></label>
            </div>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Vehicle</legend>
        {customer && customer.vehicles.length > 0 && (
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} aria-label="Vehicle">
            {customer.vehicles.map((v) => <option key={v.id} value={v.id}>{[v.year, v.make, v.model].filter(Boolean).join(' ')}</option>)}
            <option value="">+ New vehicle</option>
          </select>
        )}
        {(!customer || !vehicleId) && (
          <div className="grid3">
            <label>Year<input name="year" inputMode="numeric" maxLength={4} /></label>
            <label>Make<input name="make" maxLength={40} /></label>
            <label>Model<input name="model" maxLength={60} /></label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Services</legend>
        <div className="checks">
          {services?.filter((s) => s.active).map((s) => (
            <label key={s.id} className="check-row">
              <input type="checkbox" checked={serviceIds.includes(s.id)} onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id))} />
              {s.name} <span className="muted small">{s.duration_minutes} min{s.wait_eligible ? '' : ' · drop-off only'}</span>
            </label>
          ))}
        </div>
        <label>Notes<textarea name="notes" maxLength={500} rows={2} /></label>
      </fieldset>

      <fieldset>
        <legend>When</legend>
        <div className="row wrap">
          <input type="date" required value={slot.date} onChange={(e) => setSlot({ ...slot, date: e.target.value })} aria-label="Date" />
          <select value={slot.kind} onChange={(e) => setSlot({ ...slot, kind: e.target.value as 'wait' | 'dropoff' })} aria-label="Type">
            <option value="wait">Wait</option>
            <option value="dropoff">Drop-off</option>
          </select>
          <input type="time" step={900} required={slot.kind === 'wait'} value={slot.start_time} onChange={(e) => setSlot({ ...slot, start_time: e.target.value })} aria-label={slot.kind === 'wait' ? 'Start time' : 'Drop-off time (optional)'} />
        </div>
      </fieldset>

      <label className="check-row"><input type="checkbox" name="send_email" defaultChecked /> Email the customer a confirmation</label>

      {violations && pending ? (
        <OverrideConfirm violations={violations} onCancel={() => setViolations(null)} onConfirm={() => send(pending, true)} />
      ) : (
        <button className="btn primary" disabled={serviceIds.length === 0}>Book</button>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}
    </form>
  );
}
