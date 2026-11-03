import { supabase } from '../lib/supabase';
import { must, useQuery } from './shared';
import { formatDate, formatTime } from '../../shared/time';
import { formatPhone } from '../../shared/phone';
import { STATUS_LABEL } from '../../shared/rules';

// Read-only view of a customer for the shop: contact, cars, visits, upcoming.
// Customer records come from TRACS, so changes are made there (or by the developer).

// Not in TRACS yet: booked online or by phone and never imported.
export const notInTracs = (c: { epicor_id?: string | null } | null | undefined) => !!c && !c.epicor_id;

export function TracsBadge({ c }: { c: { epicor_id?: string | null } | null | undefined }) {
  return notInTracs(c) ? <span className="badge tracs-badge" title="Not in TRACS yet: set them up at this first visit.">New: add to TRACS</span> : null;
}

export function CustomerCard({ id }: { id: string }) {
  const q = useQuery(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [c, cars, history, upcoming] = await Promise.all([
      must(supabase.from('customers').select('name, email, phone, address_line1, address_line2, city, state, postal_code, email_opt_out, mail_opt_out, email_bounced, epicor_id, source').eq('id', id).single()),
      must(supabase.from('vehicles').select('id, year, make, model, notes, vin').eq('customer_id', id).order('created_at')),
      must(supabase.from('service_history').select('service_date, raw_service, mileage, services(name), vehicles(year, make, model)').eq('customer_id', id).order('service_date', { ascending: false }).limit(15)),
      must(supabase.from('bookings').select('id, date, kind, start_time, status, booking_services(services(name))').eq('customer_id', id).in('status', ['requested', 'confirmed']).gte('date', today).order('date')),
    ]);
    return { c: c as any, cars: cars as any[], history: history as any[], upcoming: upcoming as any[] };
  }, [id]);
  if (q.error) return <p className="error">{q.error}</p>;
  if (!q.data) return <p className="loading">Loading…</p>;
  const { c, cars, history, upcoming } = q.data;
  const car = (v: any) => (v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '');
  const address = [c.address_line1, c.address_line2, [c.city, c.state].filter(Boolean).join(', '), c.postal_code].filter(Boolean).join(' · ');
  return (
    <div className="cust-card">
      <dl className="kv">
        <dt>Phone</dt><dd>{formatPhone(c.phone) || '—'}</dd>
        <dt>Email</dt><dd>{c.email ?? '—'}{c.email_bounced ? ' (bounced)' : ''}</dd>
        <dt>Address</dt><dd>{address || '—'}</dd>
        <dt>TRACS</dt><dd>{c.epicor_id ? `#${c.epicor_id}` : <TracsBadge c={c} />}</dd>
        <dt>Reminders</dt><dd>{[c.email_opt_out ? 'no email' : 'email', c.mail_opt_out ? 'no postcards' : 'postcards'].join(', ')}</dd>
      </dl>
      <h3>Cars</h3>
      {cars.length ? <ul className="plain">{cars.map((v) => <li key={v.id}>{car(v)}{v.notes ? ` · ${v.notes}` : ''}{v.vin ? ` · VIN ${v.vin}` : ''}</li>)}</ul> : <p className="muted">None on file.</p>}
      <h3>Upcoming</h3>
      {upcoming.length ? <ul className="plain">{upcoming.map((b) => <li key={b.id}>{formatDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}{b.start_time ? ` ${formatTime(b.start_time)}` : ''} · {b.kind === 'wait' ? 'wait' : 'drop-off'} · {(b.booking_services ?? []).map((x: any) => x.services?.name).join(', ')} · {STATUS_LABEL[b.status]}</li>)}</ul> : <p className="muted">Nothing booked.</p>}
      <h3>Past visits</h3>
      {history.length ? <ul className="plain">{history.map((h, i) => <li key={i}>{formatDate(h.service_date, { month: 'short', day: 'numeric', year: 'numeric' })} · {h.services?.name ?? h.raw_service ?? 'Service'}{h.vehicles ? ` · ${car(h.vehicles)}` : ''}{h.mileage ? ` · ${h.mileage.toLocaleString()} mi` : ''}</li>)}</ul> : <p className="muted">None on file.</p>}
      <p className="muted small">Customer details come from TRACS. Corrections go into TRACS and arrive with the next monthly import.</p>
    </div>
  );
}
