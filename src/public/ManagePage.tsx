import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { CallUs, KindPicker, ServicePicker, Shell, SlotPicker, telHref, useConfig, type Picked } from './components';

interface Version {
  status: string;
  date: string;
  kind: 'wait' | 'dropoff';
  start_time: string | null;
  when: string;
  services: { id: string; name: string }[];
  customer_notes: string;
  vehicle: string;
}

interface ManageView {
  state: 'confirmed' | 'requested' | 'inactive';
  name?: string;
  current: Version | null;
  pending: Version | null;
  can_change: boolean;
  cutoff_hours: number;
  shop_phone: string;
  notes_max_length: number;
}

type Mode = 'view' | 'cancel' | 'reschedule' | 'services' | 'services-slot' | 'sent' | 'cancelled' | 'invalid' | 'outage';

function VersionCard({ v, label }: { v: Version; label: string }) {
  return (
    <div className="appt">
      <div className="appt-label">{label}</div>
      <div className="appt-when">{v.when}</div>
      <div>{v.services.map((s) => s.name).join(', ')}</div>
      {v.vehicle && <div className="muted">{v.vehicle}</div>}
      {v.customer_notes && <div className="appt-notes">“{v.customer_notes}”</div>}
    </div>
  );
}

export function ManagePage() {
  const { config } = useConfig();
  const t = new URLSearchParams(window.location.search).get('t') ?? '';
  const [view, setView] = useState<ManageView | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'wait' | 'dropoff' | null>(null);
  const [slot, setSlot] = useState<Picked | null>(null);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  function load() {
    api.manage(t).then((v: ManageView) => {
      setView(v);
      const latest = v.pending ?? v.current;
      if (latest) {
        setServiceIds(latest.services.map((s) => s.id));
        setNotes(latest.customer_notes);
      }
    }).catch((e) => setMode(e instanceof ApiError && e.status === 401 ? 'invalid' : 'outage'));
  }

  useEffect(load, []);

  const phone = view?.shop_phone ?? config?.shop_phone ?? '';
  const dropoffWindow = config?.dropoff_window ?? ['', ''];
  const waitAllowed = !!config && serviceIds.every((id) => config.services.find((s) => s.id === id)?.wait_eligible);

  // Picking a time keeps the kind only if it's still open at that time.
  function pick(p: Picked | null) {
    setSlot(p);
    if (!p) return setKind(null);
    setKind(p.time.wait && !p.time.dropoff ? 'wait' : !p.time.wait && p.time.dropoff ? 'dropoff' : kind && p.time[kind] ? kind : null);
  }
  const picked = slot && kind ? { date: slot.date, kind, start_time: slot.time.time } : null;

  async function run(fn: () => Promise<any>, onOk: Mode) {
    setBusy(true);
    try {
      await fn();
      setMode(onOk);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'needs_new_slot') {
        setSlot(null);
        setMode('services-slot');
      } else if (e instanceof ApiError && e.code === 'too_late') {
        load();
        setMode('view');
      } else if (e instanceof ApiError && e.code === 'invalid_link') {
        setMode('invalid');
      } else {
        setMode('outage');
      }
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'outage') return <Shell config={config}><CallUs phone={phone} reason="Something went wrong on our end" /></Shell>;
  if (mode === 'invalid') {
    return (
      <Shell config={config}>
        <h1>This link has expired</h1>
        <p>Links work until the appointment time. To make a change, call us{phone && <> at <a href={telHref(phone)}>{phone}</a></>}.</p>
      </Shell>
    );
  }
  if (!view) return <Shell config={config}><p className="loading">Loading your appointment…</p></Shell>;

  if (mode === 'cancelled' || view.state === 'inactive') {
    return (
      <Shell config={config}>
        <h1>{mode === 'cancelled' ? 'Cancelled' : 'No active appointment'}</h1>
        <p>{mode === 'cancelled' ? 'Your appointment is cancelled. We emailed you a confirmation.' : 'This appointment was cancelled or has already happened.'}</p>
        <a className="btn primary big" href="/">Book an appointment</a>
      </Shell>
    );
  }

  if (mode === 'sent') {
    return (
      <Shell config={config}>
        <h1>Change request sent</h1>
        <p>We’ll email you once the shop confirms. Until then, your original appointment stays as it was.</p>
        <button className="btn big" onClick={() => { setMode('view'); load(); }}>Back to my appointment</button>
      </Shell>
    );
  }

  const changeBlocked = !view.can_change;

  return (
    <Shell config={config}>
      {mode === 'view' && (
        <section>
          <h1>{view.name ? `Hi ${view.name}` : 'Your appointment'}</h1>
          {view.current && <VersionCard v={view.current} label="Confirmed" />}
          {view.pending && (
            <VersionCard v={view.pending} label={view.current ? 'Change requested — waiting for the shop' : 'Requested — waiting for the shop to confirm'} />
          )}
          {changeBlocked ? (
            <div className="notice">
              <p>Online changes close {view.cutoff_hours} hours before your appointment. Please call us to make a change.</p>
              {phone && <a className="btn primary big" href={telHref(phone)}>Call {phone}</a>}
            </div>
          ) : (
            <div className="stack">
              <button className="btn big" onClick={() => { setSlot(null); setMode('reschedule'); }}>Change date or time</button>
              <button className="btn big" onClick={() => setMode('services')}>Change services or notes</button>
              <button className="btn big danger" onClick={() => setMode('cancel')}>Cancel appointment</button>
            </div>
          )}
        </section>
      )}

      {mode === 'cancel' && (
        <section>
          <h1>Cancel this appointment?</h1>
          {(view.current ?? view.pending) && <VersionCard v={(view.current ?? view.pending)!} label="Appointment" />}
          <div className="actions">
            <button className="btn big" onClick={() => setMode('view')}>Keep it</button>
            <button className="btn big danger" disabled={busy} onClick={() => run(() => api.cancel(t), 'cancelled')}>Yes, cancel</button>
          </div>
        </section>
      )}

      {mode === 'reschedule' && config && (
        <section>
          <h1>Pick a new time</h1>
          <p className="lede">The shop confirms changes. Your current time stays held until they do.</p>
          <SlotPicker serviceIds={serviceIds} token={t} value={slot} onChange={pick} onOutage={() => setMode('outage')} />
          {slot && <KindPicker picked={slot.time} waitAllowed={waitAllowed} value={kind} dropoffWindow={dropoffWindow} onChange={setKind} />}
          <div className="actions sticky">
            <button className="btn big" onClick={() => setMode('view')}>Back</button>
            <button className="btn primary big" disabled={!picked || busy} onClick={() => run(() => api.reschedule({ t, ...picked }), 'sent')}>Request change</button>
          </div>
        </section>
      )}

      {mode === 'services' && config && (
        <section>
          <h1>Change services</h1>
          <ServicePicker services={config.services} selected={serviceIds} onChange={setServiceIds} />
          <label className="field">
            <span>Anything else we should know? <span className="muted">(optional)</span></span>
            <textarea value={notes} rows={3} maxLength={view.notes_max_length} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn big" onClick={() => setMode('view')}>Back</button>
            <button
              className="btn primary big"
              disabled={serviceIds.length === 0 || busy}
              onClick={() => run(() => api.changeServices({ t, service_ids: serviceIds, customer_notes: notes }), 'sent')}
            >
              Request change
            </button>
          </div>
        </section>
      )}

      {mode === 'services-slot' && config && (
        <section>
          <h1>Pick a new time</h1>
          <p className="notice">Those services don’t fit your current time. Pick a new one.</p>
          <SlotPicker serviceIds={serviceIds} token={t} value={slot} onChange={pick} onOutage={() => setMode('outage')} />
          {slot && <KindPicker picked={slot.time} waitAllowed={waitAllowed} value={kind} dropoffWindow={dropoffWindow} onChange={setKind} />}
          <div className="actions sticky">
            <button className="btn big" onClick={() => setMode('services')}>Back</button>
            <button
              className="btn primary big"
              disabled={!picked || busy}
              onClick={() => run(() => api.changeServices({ t, service_ids: serviceIds, customer_notes: notes, ...picked }), 'sent')}
            >
              Request change
            </button>
          </div>
        </section>
      )}
    </Shell>
  );
}
