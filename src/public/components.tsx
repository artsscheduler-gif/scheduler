import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, FALLBACK_PHONE, type OpenTime, type PublicConfig, type Service } from './api';
import { formatDate, formatTime } from '../../shared/time';

export function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

export function useConfig() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.config().then(setConfig).catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (config && /^#[0-9a-f]{6}$/i.test(config.brand_color)) {
      const root = document.documentElement.style;
      root.setProperty('--brand', config.brand_color);
      // Text on brand-colored surfaces: dark on light brands (yellow), white on dark ones.
      root.setProperty('--on-brand', luminance(config.brand_color) > 0.45 ? '#1d232a' : '#fff');
    }
    if (config) document.title = `Book a service · ${config.shop_name}`;
  }, [config]);
  return { config, failed };
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

// Collapse runs of days with the same hours: "Mon–Fri 7:30am–5:30pm".
function hoursLines(hours: PublicConfig['hours']): string[] {
  const label = (h: { open: string; close: string } | null) => (h ? `${formatTime(h.open)}–${formatTime(h.close)}` : '');
  const lines: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const cur = label(hours[DAYS[i][0]] ?? null);
    let j = i;
    while (j + 1 < DAYS.length && label(hours[DAYS[j + 1][0]] ?? null) === cur) j++;
    if (cur) lines.push(`${DAYS[i][1]}${j > i ? `–${DAYS[j][1]}` : ''} ${cur}`);
    i = j + 1;
  }
  return lines;
}

export function Shell({ config, step, children }: { config: PublicConfig | null; step?: number; children: ReactNode }) {
  const phone = config?.shop_phone || FALLBACK_PHONE;
  return (
    <div className="public">
      <header className="pub-header">
        <div className="pub-header-inner">
          {config?.logo_url ? (
            <img src={config.logo_url} alt={config.shop_name} className="pub-logo" />
          ) : (
            <span className="pub-name">{config?.shop_name ?? ''}</span>
          )}
          {phone && (
            <a className="pub-phone" href={telHref(phone)}>
              <span aria-hidden="true">☎</span> {phone}
            </a>
          )}
        </div>
        {step !== undefined && (
          <div className="progress" aria-label={`Step ${step} of 4`}>
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={i <= step ? 'on' : ''} />
            ))}
          </div>
        )}
      </header>
      <main className="pub-main">{children}</main>
      {config && (
        <footer className="pub-footer">
          <div className="pub-footer-inner">
            <div>
              <strong>{config.shop_name}</strong>
              {config.shop_address && <div>{config.shop_address}</div>}
              {phone && <a href={telHref(phone)}>{phone}</a>}
            </div>
            {config.hours && (
              <div>
                {hoursLines(config.hours).map((l) => <div key={l}>{l}</div>)}
              </div>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

export function CallUs({ phone, reason }: { phone: string; reason?: string }) {
  const p = phone || FALLBACK_PHONE;
  return (
    <div className="callus" role="alert">
      <h2>{reason ?? 'We can’t book this online right now'}</h2>
      {p ? (
        <>
          <p>Call us at <strong>{p}</strong> to book. We’ll get you in.</p>
          <a className="btn primary big" href={telHref(p)}>Call {p}</a>
        </>
      ) : (
        <p>Please call the shop to book.</p>
      )}
    </div>
  );
}

export function isOutage(e: unknown) {
  return !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 429;
}

export function ServicePicker({
  services, selected, onChange,
}: { services: Service[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="choices">
      <legend className="sr-only">Appointment type</legend>
      {services.map((s) => {
        const on = selected.includes(s.id);
        return (
          <label key={s.id} className={`choice ${on ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? selected.filter((x) => x !== s.id) : [...selected, s.id])}
            />
            <span className="choice-body">
              <span className="choice-title">{s.name}</span>
              {s.description && <span className="choice-desc">{s.description}</span>}
            </span>
            <span className="check" aria-hidden="true" />
          </label>
        );
      })}
    </fieldset>
  );
}

// Wait or drop off, for a time already picked. Only the ways that are open at
// that time can be chosen; the other says why.
export function KindPicker({
  picked, waitAllowed, value, onChange, dropoffWindow,
}: {
  picked: OpenTime; waitAllowed: boolean; value: 'wait' | 'dropoff' | null;
  onChange: (k: 'wait' | 'dropoff') => void; dropoffWindow: [string, string];
}) {
  const at = formatTime(picked.time);
  const waitWhy = !waitAllowed || picked.wait_why === 'not_wait_eligible' ? 'Not available for this kind of work.'
    : picked.wait_why === 'outside_hours' ? `The work would run past closing if you start waiting at ${at}. Pick an earlier time to wait.`
    : picked.wait_why === 'blocked' ? `We can’t take a waiting customer at ${at}. Pick another time to wait.`
    : `No waiting spot left at ${at}. Pick another time to wait.`;
  const dropWhy = picked.dropoff_why === 'outside_hours' ? `Drop-offs are ${dropoffWindow[0]}–${dropoffWindow[1]}. Pick a time in that range to drop off.`
    : picked.dropoff_why === 'blocked' ? `We can’t take a drop-off at ${at}. Pick another time to drop off.`
    : 'No drop-off spots left that day. Pick another day to drop off.';
  return (
    <div className="choices" role="radiogroup" aria-label="Wait or drop off">
      <button type="button" role="radio" aria-checked={value === 'wait'} disabled={!picked.wait} className={`choice ${value === 'wait' ? 'on' : ''}`} onClick={() => onChange('wait')}>
        <span className="choice-body">
          <span className="choice-title">Wait</span>
          <span className="choice-desc">{picked.wait ? `Come in at ${at} and wait at the shop while we work.` : waitWhy}</span>
        </span>
      </button>
      <button type="button" role="radio" aria-checked={value === 'dropoff'} disabled={!picked.dropoff} className={`choice ${value === 'dropoff' ? 'on' : ''}`} onClick={() => onChange('dropoff')}>
        <span className="choice-body">
          <span className="choice-title">Drop off</span>
          <span className="choice-desc">{picked.dropoff ? `Drop it off at ${at}. We’ll call when it’s ready.` : dropWhy}</span>
        </span>
      </button>
    </div>
  );
}

export interface Slot { date: string; kind: 'wait' | 'dropoff'; start_time: string | null }
export interface Picked { date: string; time: OpenTime }

// Calendar of bookable days, then the open times on the chosen day.
export function SlotPicker({
  serviceIds, token, value, onChange, onOutage,
}: {
  serviceIds: string[]; token?: string; value: Picked | null; onChange: (p: Picked | null) => void; onOutage: (e?: unknown) => void;
}) {
  const [days, setDays] = useState<string[] | null>(null);
  const [date, setDate] = useState<string | null>(value?.date ?? null);
  const [times, setTimes] = useState<OpenTime[] | null>(null);
  const timesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDays(null);
    api.days(serviceIds, token).then((r) => setDays(r.days)).catch(onOutage);
  }, [serviceIds.join(','), token]);

  useEffect(() => {
    if (!date) return setTimes(null);
    setTimes(null);
    api.times(serviceIds, date, token).then((r) => {
      setTimes(r.times);
      requestAnimationFrame(() => timesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }).catch(onOutage);
  }, [date, serviceIds.join(','), token]);

  if (!days) return <p className="loading">Finding open days…</p>;
  if (days.length === 0) return <p>No open days online for this. Please call us — we may still be able to fit you in.</p>;

  const set = new Set(days);
  const first = new Date(`${days[0]}T12:00:00Z`);
  const last = new Date(`${days[days.length - 1]}T12:00:00Z`);
  // Start grid on the Sunday on or before the first open day.
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const cells: string[] = [];
  for (const d = new Date(start); d <= last || d.getUTCDay() !== 0; d.setUTCDate(d.getUTCDate() + 1)) {
    cells.push(d.toISOString().slice(0, 10));
  }
  const weeks: string[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function pickDay(d: string) {
    setDate(d);
    onChange(null);
  }

  return (
    <div className="slot-picker">
      <table className="cal" role="grid" aria-label="Choose a day">
        <thead>
          <tr>{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <th key={i} scope="col">{d}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((w, wi) => (
            <tr key={wi}>
              {w.map((d) => {
                const dayNum = Number(d.slice(8));
                const showMonth = dayNum === 1 || (wi === 0 && d === w[0]);
                const open = set.has(d);
                return (
                  <td key={d}>
                    {open ? (
                      <button type="button" className={`day ${date === d ? 'on' : ''}`} onClick={() => pickDay(d)} aria-pressed={date === d} aria-label={formatDate(d)}>
                        {showMonth && <span className="mon">{formatDate(d, { month: 'short' })}</span>}
                        {dayNum}
                      </button>
                    ) : (
                      <span className="day off" aria-hidden="true">
                        {showMonth && <span className="mon">{formatDate(d, { month: 'short' })}</span>}
                        {dayNum}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {date && (
        <div ref={timesRef} className="times-wrap">
          <h3>{formatDate(date)}</h3>
          {!times && <p className="loading">Loading times…</p>}
          {times && times.length === 0 && <p>That day just filled up. Pick another day.</p>}
          {times && times.length > 0 && (
            <div role="radiogroup" aria-label="Time">
              {[
                { label: 'Morning', group: times.filter((t) => t.time < '12:00') },
                { label: 'Afternoon', group: times.filter((t) => t.time >= '12:00') },
              ].filter((g) => g.group.length > 0).map(({ label, group }) => (
                <div key={label} className="time-group">
                  <h4>{label}</h4>
                  <div className="times">
                    {group.map((t) => {
                      const on = value?.date === date && value.time.time === t.time;
                      return (
                        <button key={t.time} type="button" role="radio" aria-checked={on} className={`time ${on ? 'on' : ''}`} onClick={() => onChange({ date, time: t })}>
                          {formatTime(t.time)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void };
  }
}

export function Turnstile({ onToken }: { onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    function render() {
      if (cancelled || !ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, {
        sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
    }
    if (window.turnstile) render();
    else {
      const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
      const s = existing ?? document.createElement('script');
      if (!existing) {
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.dataset.turnstile = '1';
        document.head.appendChild(s);
      }
      s.addEventListener('load', render);
    }
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, []);
  return <div ref={ref} className="turnstile" />;
}
