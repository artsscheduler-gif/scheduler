import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { CallUs, KindPicker, ServicePicker, Shell, SlotPicker, Turnstile, useConfig, type Picked } from './components';
import { VehicleFields } from './vehicle';
import { formatDate, formatTime } from '../../shared/time';

type Step = 1 | 2 | 3 | 4 | 'done' | 'outage';

function sourceParam(): string | null {
  const s = new URLSearchParams(window.location.search).get('src');
  return s && /^[a-z0-9_-]{1,40}$/i.test(s) ? s.toLowerCase() : null;
}

export function BookingApp() {
  const { config, failed } = useConfig();
  const [step, setStep] = useState<Step>(1);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<'wait' | 'dropoff' | null>(null);
  const [slot, setSlot] = useState<Picked | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // Bumped after a failed submit: a Turnstile token is single-use, so get a fresh one.
  const [tsKey, setTsKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.book>> | null>(null);
  const [slotGone, setSlotGone] = useState(false);

  const waitAllowed = useMemo(
    () => !!config && serviceIds.length > 0 && serviceIds.every((id) => config.services.find((s) => s.id === id)?.wait_eligible),
    [config, serviceIds],
  );

  // A new time resets the choice, unless only one way is open at that time.
  useEffect(() => {
    if (!slot) return setKind(null);
    setKind(slot.time.wait && !slot.time.dropoff ? 'wait' : !slot.time.wait && slot.time.dropoff ? 'dropoff' : null);
  }, [slot?.date, slot?.time.time]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('.pub-main h1')?.focus();
  }, [step]);

  if (failed || step === 'outage') {
    return (
      <Shell config={config}>
        <CallUs phone={config?.shop_phone ?? ''} />
      </Shell>
    );
  }
  if (!config) return <Shell config={null}><p className="loading">Loading…</p></Shell>;

  const selectedNames = serviceIds.map((id) => config.services.find((s) => s.id === id)?.name).filter(Boolean).join(', ');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!slot || !kind) return;
    const f = new FormData(e.currentTarget);
    setSubmitting(true);
    setFieldError(null);
    try {
      const r = await api.book({
        service_ids: serviceIds,
        customer_notes: notes,
        date: slot.date,
        kind,
        start_time: slot.time.time,
        name: String(f.get('name') ?? ''),
        email: String(f.get('email') ?? ''),
        phone: String(f.get('phone') ?? ''),
        vehicle: {
          year: String(f.get('year') ?? ''),
          make: String(f.get('make') ?? ''),
          model: String(f.get('model') ?? ''),
          notes: String(f.get('vnotes') ?? ''),
        },
        turnstile: token ?? '',
        ...(sourceParam() ? { source: sourceParam() } : {}),
      });
      setResult(r);
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slot_unavailable') {
        setSlot(null);
        setSlotGone(true);
        setStep(2);
      } else if (err instanceof ApiError && err.code === 'invalid' && err.field) {
        setFieldError(err.field);
      } else if (err instanceof ApiError && err.code === 'verification_failed') {
        setFieldError('turnstile');
      } else {
        setStep('outage');
      }
      setToken(null);
      setTsKey((k) => k + 1);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'done' && result) {
    const when = result.kind === 'wait'
      ? `${formatDate(result.date)} at ${formatTime(result.start_time)}, waiting`
      : `${formatDate(result.date)}, drop off at ${formatTime(result.start_time)}`;
    return (
      <Shell config={config}>
        <div className="done">
          <div className="done-mark" aria-hidden="true">✓</div>
          {result.status === 'confirmed' ? (
            <>
              <h1 tabIndex={-1}>You’re booked</h1>
              <p className="done-when">{when}</p>
              <p>We emailed your confirmation with a calendar file and a link to change or cancel.</p>
            </>
          ) : (
            <>
              <h1 tabIndex={-1}>Request received</h1>
              <p className="done-when">{when}</p>
              <p>We’re holding this time for you. We’ll email to confirm, usually within {result.turnaround_hours} business hours.</p>
              <p className="muted">Didn’t get an email in a few minutes? Check spam, or call {config.shop_phone}.</p>
            </>
          )}
        </div>
      </Shell>
    );
  }

  const errFor = (field: string) => fieldError === field || fieldError?.startsWith(`${field}.`);

  return (
    <Shell config={config} step={step as number}>
      {step === 1 && (
        <section>
          <h1 tabIndex={-1}>What do you need?</h1>
          <p className="lede">Pick one or more.</p>
          <ServicePicker services={config.services} selected={serviceIds} onChange={(ids) => { setServiceIds(ids); setSlot(null); }} />
          <label className="field">
            <span>Anything else we should know? <span className="muted">(optional)</span></span>
            <textarea
              value={notes}
              maxLength={config.notes_max_length}
              rows={3}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Noises, warning lights, when it started…"
            />
            <span className="count">{notes.length}/{config.notes_max_length}</span>
          </label>
          <div className="actions">
            <button className="btn primary big" disabled={serviceIds.length === 0} onClick={() => setStep(2)}>Next</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section>
          <h1 tabIndex={-1}>When works for you?</h1>
          {slotGone && <p className="notice" role="alert">Sorry — that time was just taken. Please pick another.</p>}
          <SlotPicker serviceIds={serviceIds} value={slot} onChange={setSlot} onOutage={() => setStep('outage')} />
          <div className="actions sticky">
            <button className="btn big" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary big" disabled={!slot} onClick={() => { setSlotGone(false); setStep(3); }}>Next</button>
          </div>
        </section>
      )}

      {step === 3 && slot && (
        <section>
          <h1 tabIndex={-1}>Wait or drop off?</h1>
          <p className="lede">{selectedNames} · {formatDate(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })} at {formatTime(slot.time.time)}</p>
          <KindPicker picked={slot.time} waitAllowed={waitAllowed} value={kind} dropoffWindow={config.dropoff_window} onChange={setKind} />
          <div className="actions">
            <button className="btn big" onClick={() => setStep(2)}>Back</button>
            <button className="btn primary big" disabled={!kind} onClick={() => setStep(4)}>Next</button>
          </div>
        </section>
      )}

      {step === 4 && slot && (
        <section>
          <h1 tabIndex={-1}>You and your car</h1>
          <p className="lede">
            {selectedNames} · {formatDate(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })} at {formatTime(slot.time.time)}, {kind === 'wait' ? 'waiting' : 'drop off'}
          </p>
          <form onSubmit={submit} noValidate={false}>
            <label className={`field ${errFor('name') ? 'bad' : ''}`}>
              <span>Name</span>
              <input name="name" autoComplete="name" required maxLength={100} />
            </label>
            <label className={`field ${errFor('phone') ? 'bad' : ''}`}>
              <span>Phone</span>
              <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required maxLength={20} />
              {errFor('phone') && <span className="field-err">Enter a 10-digit phone number.</span>}
            </label>
            <label className={`field ${errFor('email') ? 'bad' : ''}`}>
              <span>Email</span>
              <input name="email" type="email" autoComplete="email" required maxLength={254} />
              {errFor('email') && <span className="field-err">Check your email address.</span>}
            </label>
            <VehicleFields errFor={errFor} />
            <label className="field">
              <span>Car notes <span className="muted">(optional — color, plate)</span></span>
              <input name="vnotes" maxLength={200} />
            </label>
            <Turnstile key={tsKey} onToken={setToken} />
            {fieldError === 'turnstile' && <p className="field-err">Please complete the check above and try again.</p>}
            {fieldError && fieldError !== 'turnstile' && <p className="field-err" role="alert">Please fix the highlighted field.</p>}
            <div className="actions">
              <button type="button" className="btn big" onClick={() => setStep(3)}>Back</button>
              <button className="btn primary big" disabled={submitting || !token}>{submitting ? 'Booking…' : 'Book it'}</button>
            </div>
          </form>
        </section>
      )}
    </Shell>
  );
}
