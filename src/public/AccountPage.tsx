import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Account } from './api';
import { Shell, useConfig } from './components';
import { FindMyCars, useReturningCustomer } from './returning';
import { formatDate } from '../../shared/time';
import { formatPhone } from '../../shared/phone';

// My account: a returning customer's details, cars, visits and preferences.
// Reached from a personal link, an emailed code, or a remembered device.

type Car = Account['cars'][number];
const carName = (c: Pick<Car, 'year' | 'make' | 'model'>) => [c.year, c.make, c.model].filter(Boolean).join(' ') || 'Car';

function CarForm({ car, k, onDone, onCancel }: { car?: Car; k: string; onDone: () => void; onCancel?: () => void }) {
  const [err, setErr] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr('');
    try {
      await api.updateAccount({
        k, action: 'car', ...(car ? { car_id: car.id } : {}),
        car: { year: String(f.get('year') ?? ''), make: String(f.get('make') ?? ''), model: String(f.get('model') ?? ''), notes: String(f.get('notes') ?? ''), vin: String(f.get('vin') ?? '') },
      });
      onDone();
    } catch (x) {
      setErr(x instanceof ApiError && x.field ? `Check ${x.field}.` : 'That didn’t save. Try again.');
    }
  }
  return (
    <form className="acct-car-form" onSubmit={save}>
      <div className="row3">
        <label className="field"><span>Year</span><input name="year" inputMode="numeric" maxLength={4} defaultValue={car?.year ?? ''} /></label>
        <label className="field"><span>Make</span><input name="make" required maxLength={40} defaultValue={car?.make ?? ''} /></label>
        <label className="field"><span>Model</span><input name="model" required maxLength={60} defaultValue={car?.model ?? ''} /></label>
      </div>
      <label className="field"><span>Plate / notes <span className="muted">(optional)</span></span><input name="notes" maxLength={200} defaultValue={car?.notes ?? ''} /></label>
      <label className="field"><span>VIN <span className="muted">(optional)</span></span><input name="vin" maxLength={20} defaultValue={car?.vin ?? ''} autoCapitalize="characters" /></label>
      {err && <p className="field-err" role="alert">{err}</p>}
      <div className="row">
        <button className="btn primary">{car ? 'Save car' : 'Add car'}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export function AccountPage() {
  const { config } = useConfig();
  const me = useReturningCustomer();
  const [acct, setAcct] = useState<Account | null>(null);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<string | null>(null); // car id, 'new', or null
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);

  useEffect(() => {
    if (!me.key) return setAcct(null);
    api.account(me.key).then(setAcct).catch(() => me.signOut());
  }, [me.key, n]);

  async function saveDetails(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setMsg('');
    try {
      await api.updateAccount({ k: me.key, action: 'details', details: f });
      setMsg('Saved.');
      reload();
    } catch (x) {
      setMsg(x instanceof ApiError && x.field ? `Check ${x.field.replace('_', ' ')}.` : 'That didn’t save. Try again.');
    }
  }

  async function savePrefs(email_opt_out: boolean, mail_opt_out: boolean) {
    await api.updateAccount({ k: me.key, action: 'prefs', email_opt_out, mail_opt_out });
    reload();
  }

  async function removeCar(c: Car) {
    if (!confirm(`Remove ${carName(c)} from your account? Its service history goes too, and we’ll stop sending reminders for it.`)) return;
    await api.updateAccount({ k: me.key, action: 'remove-car', car_id: c.id });
    reload();
  }

  if (!me.key) {
    return (
      <Shell config={config}>
        <h1>My account</h1>
        <p className="lede">See your cars, past visits and upcoming appointments, and update your details.</p>
        <FindMyCars open title="Sign in with your email" onIn={me.signIn} />
        <p className="muted small">Not on file yet? <a href="/">Book an appointment</a> and you’ll have an account.</p>
      </Shell>
    );
  }
  if (!acct) return <Shell config={config}><p className="loading">Loading your account…</p></Shell>;
  const d = acct.details;

  return (
    <Shell config={config}>
      <div className="acct-head">
        <h1>Hi {d.name.split(' ')[0]}</h1>
        <button className="linklike small" onClick={me.signOut}>Sign out</button>
      </div>
      <a className="btn primary big" href="/">Book an appointment</a>

      <section className="acct-section">
        <h2>Upcoming</h2>
        {acct.upcoming.length === 0 ? <p className="muted">No upcoming appointments.</p> : (
          <ul className="acct-list">
            {acct.upcoming.map((u) => (
              <li key={u.manage}>
                <strong>{u.when}</strong>
                <div className="muted small">{u.services} · {u.status === 'requested' ? 'waiting for the shop to confirm' : 'confirmed'}</div>
                <a href={u.manage} className="small">Change or cancel</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="acct-section">
        <h2>Your cars</h2>
        <ul className="acct-list">
          {acct.cars.map((c) => (
            <li key={c.id}>
              {editing === c.id ? <CarForm car={c} k={me.key!} onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} /> : (
                <>
                  <strong>{carName(c)}</strong>
                  <div className="muted small">{[c.notes, c.vin && `VIN ${c.vin}`].filter(Boolean).join(' · ')}</div>
                  <div className="row">
                    <button className="linklike small" onClick={() => setEditing(c.id)}>Edit</button>
                    <button className="linklike small" onClick={() => removeCar(c)}>Remove</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        {editing === 'new'
          ? <CarForm k={me.key} onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />
          : <button className="btn" onClick={() => setEditing('new')}>Add a car</button>}
      </section>

      <section className="acct-section">
        <h2>Past visits</h2>
        {acct.history.length === 0 ? <p className="muted">No visits on file yet.</p> : (
          <table className="acct-history">
            <tbody>
              {acct.history.map((h, i) => (
                <tr key={i}>
                  <td className="nowrap">{formatDate(h.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td>{h.service}<div className="muted small">{[h.car, h.mileage && `${h.mileage.toLocaleString()} mi`].filter(Boolean).join(' · ')}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="acct-section">
        <h2>Your details</h2>
        <form onSubmit={saveDetails} key={JSON.stringify(d)}>
          <label className="field"><span>Name</span><input name="name" required maxLength={100} defaultValue={d.name} /></label>
          <label className="field"><span>Phone</span><input name="phone" type="tel" required defaultValue={formatPhone(d.phone)} /></label>
          <label className="field"><span>Email</span><input name="email" type="email" required defaultValue={d.email ?? ''} /></label>
          <label className="field"><span>Street address <span className="muted">(for mailed reminders)</span></span><input name="address_line1" maxLength={100} defaultValue={d.address_line1 ?? ''} /></label>
          <label className="field"><span>Apt / suite <span className="muted">(optional)</span></span><input name="address_line2" maxLength={100} defaultValue={d.address_line2 ?? ''} /></label>
          <div className="row3">
            <label className="field"><span>City</span><input name="city" maxLength={60} defaultValue={d.city ?? ''} /></label>
            <label className="field"><span>State</span><input name="state" maxLength={2} defaultValue={d.state ?? ''} /></label>
            <label className="field"><span>ZIP</span><input name="postal_code" inputMode="numeric" maxLength={10} defaultValue={d.postal_code ?? ''} /></label>
          </div>
          <button className="btn primary">Save details</button> {msg && <span className="muted small" role="status">{msg}</span>}
        </form>
      </section>

      <section className="acct-section">
        <h2>Reminders</h2>
        <label className="check-row"><input type="checkbox" checked={!d.email_opt_out} onChange={(e) => savePrefs(!e.target.checked, d.mail_opt_out)} /> Email me when a service is due</label>
        <label className="check-row"><input type="checkbox" checked={!d.mail_opt_out} onChange={(e) => savePrefs(d.email_opt_out, !e.target.checked)} /> Mail me a postcard when a service is due</label>
        <p className="muted small">Appointment confirmations and reminders for visits you book are always sent.</p>
      </section>
    </Shell>
  );
}
