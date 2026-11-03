import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery, useRole, useSettings } from './shared';
import { formatDate } from '../../shared/time';

function Preview({ html, size }: { html: string; size: string }) {
  const [w, h] = size === '6x9' ? [888, 600] : [600, 408];
  return (
    <div className="pc-frame" style={{ width: w / 1.5, height: h / 1.5 }}>
      {/* sandbox with no permissions: template HTML can't run script or reach the admin session */}
      <iframe title="Postcard preview" sandbox="" srcDoc={html} style={{ width: w, height: h, transform: 'scale(0.6667)', transformOrigin: '0 0' }} />
    </div>
  );
}

function Batch({ b, onDone }: { b: any; onDone: () => void }) {
  const rows = useQuery(() => must(supabase.from('reminder_sends').select('id, status, due_date, preview_url, provider_id, customers(name, city, state, mail_opt_out), services(name)').eq('batch_id', b.id).order('created_at')) as Promise<any[]>, [b.id]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function approve() {
    if (b.status === 'draft' && !confirm(`Approve and mail ${b.count} postcard${b.count === 1 ? '' : 's'} (about $${(b.est_cost_cents / 100).toFixed(2)})?`)) return;
    setBusy(true);
    try {
      const r = await adminPost('batch-approve', { batch_id: b.id });
      setMsg(`Sent ${r.sent}. Undeliverable ${r.undeliverable}. Failed ${r.failed}.${r.remaining ? ` ${r.remaining} still to mail: click Continue sending.` : ''}`);
      onDone();
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-section">
      <div className="row">
        <h3>Week of {formatDate(b.week_of, { month: 'short', day: 'numeric' })} · {b.status}</h3>
        <span className="push">{b.count} postcards · est. ${(b.est_cost_cents / 100).toFixed(2)}</span>
        {b.status === 'draft' && <button className="btn primary" disabled={busy || !b.count} onClick={approve}>Approve and send</button>}
        {/* A big batch is mailed over several calls (10-second limit); it picks up where it stopped. */}
        {b.status === 'approved' && <button className="btn primary" disabled={busy} onClick={approve}>{busy ? 'Sending…' : 'Continue sending'}</button>}
      </div>
      <table className="tbl">
        <tbody>
          {rows.data?.map((r) => (
            <tr key={r.id}><td>{r.customers?.name}</td><td>{r.customers?.city}, {r.customers?.state}</td><td>{r.services?.name} due {r.due_date}</td><td>{r.status}{r.customers?.mail_opt_out ? ' (opted out; will be skipped)' : ''}{r.provider_id && !r.provider_id.startsWith('stub') && <> · <ProofLink id={r.provider_id} url={r.preview_url} /></>}</td></tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

const PRINTER = { lob: 'Lob', postgrid: 'PostGrid', stub: '' } as Record<string, string>;
const MODE_TEXT = {
  stub: () => 'Postcards are not connected to a printer: approving a batch marks it sent, but nothing is made or mailed. To connect one, set MAIL_PROVIDER to lob or postgrid and add its key (LOB_API_KEY or POSTGRID_API_KEY) in Vercel.',
  test: (p: string) => `Connected to ${p} with a test key: ${p} makes each card (see “View card”) but nothing is printed or mailed, and nothing is charged.`,
  live: (p: string) => `Connected to ${p} with a live key: approved cards are printed and mailed, and each one costs money.`,
} as const;

// The printer's PDF proof: shown if saved, otherwise fetched on request (it
// takes a few seconds after sending for the printer to render it).
function ProofLink({ id, url: saved }: { id: string; url?: string | null }) {
  const [url, setUrl] = useState(saved ?? null);
  const [state, setState] = useState<'' | 'busy' | 'notyet'>('');
  if (url) return <a href={url} target="_blank" rel="noreferrer">View card</a>;
  async function get() {
    setState('busy');
    const r = await adminPost<{ url: string | null }>('postcard-proof', { id });
    if (r.url) { setUrl(r.url); window.open(r.url, '_blank', 'noreferrer'); setState(''); } else setState('notyet');
  }
  return (
    <>
      <button className="linklike" onClick={get} disabled={state === 'busy'}>{state === 'busy' ? 'Getting card…' : 'View card'}</button>
      {state === 'notyet' && <span className="muted"> (still being made, try again in a minute)</span>}
    </>
  );
}

// Which printer is connected, and a one-card test to the shop's own address.
function PrinterCheck() {
  const role = useRole();
  const status = useQuery(() => adminPost<{ mode: keyof typeof MODE_TEXT; printer: string }>('postcard-status', {}));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; preview_url: string | null; mode: string; printer: string } | null>(null);
  const [err, setErr] = useState('');
  const mode = status.data?.mode;
  const printer = PRINTER[status.data?.printer ?? 'stub'] ?? status.data?.printer ?? '';
  async function test() {
    if (mode === 'live' && !confirm('This prints and mails one real postcard to the shop’s own address, and costs money. Send it?')) return;
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      setResult(await adminPost('postcard-test', {}));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!mode) return null;
  return (
    <div className={`settings-section printer-${mode}`}>
      <h2>Printer</h2>
      <p>{MODE_TEXT[mode](printer)}</p>
      {role !== 'staff' && <button className="btn small" disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send a test postcard to the shop'}</button>}
      {result && (
        <p className="small" role="status">
          {result.mode === 'stub' ? 'Test card made (not connected to a printer, so nothing was sent).' : <>{printer} accepted the card ({result.id}). <ProofLink id={result.id} url={result.preview_url} /></>}
        </p>
      )}
      {err && <p className="error small" role="alert">{printer || 'The printer'} said: {err}</p>}
    </div>
  );
}

export function Postcards() {
  const role = useRole();
  const s = useSettings();
  const batches = useQuery(() => must(supabase.from('mail_batches').select('*').order('created_at', { ascending: false }).limit(20)) as Promise<any[]>);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [preview, setPreview] = useState<{ front: string; back: string; size: string } | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!s.data) return;
    setFront(s.data.postcard_front_html);
    setBack(s.data.postcard_back_html);
  }, [s.data]);

  useEffect(() => {
    const t = setTimeout(() => {
      adminPost('postcard-preview', { front_html: front, back_html: back }).then(setPreview).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [front, back]);

  async function save() {
    await adminPost('settings', { postcard_front_html: front, postcard_back_html: back });
    setMsg('Template saved.');
    s.reload();
  }

  if (!s.data) return <p className="loading">Loading…</p>;
  const draft = batches.data?.filter((b) => b.status === 'draft' || b.status === 'approved') ?? [];
  const past = batches.data?.filter((b) => b.status === 'sent') ?? [];
  return (
    <div className="settings">
      {s.data.reminders_dry_run && (
        <div className="banner">Reminders are in <strong>dry-run</strong> mode (cutover). Nothing is emailed or batched; the daily job only logs what it would send. Turn it off in Settings when Epicor stops sending.</div>
      )}
      <PrinterCheck />
      <h2>Next batch</h2>
      {draft.length === 0 && <p className="muted">No postcards waiting. The daily job adds service-due postcards here; {s.data.postcard_auto_approve ? 'auto-approve is ON.' : 'nothing mails until you approve.'}</p>}
      {draft.map((b) => <Batch key={b.id} b={b} onDone={batches.reload} />)}

      {/* The postcard design is HTML: developer only (shared/permissions TECH_SETTINGS). */}
      {role === 'developer' && (
      <div className="settings-section">
        <h2>Template</h2>
        <p className="help">
          HTML for a {s.data.postcard_size} postcard. Leave a side empty to use the default. Placeholders: {'{{name}} {{service}} {{vehicle}} {{due_date}} {{shop_name}} {{shop_phone}} {{shop_address}} {{qr}} {{booking_url}} {{booking_url_display}} {{brand_color}} {{width}} {{height}}'}.
          Keep the right half of the back clear for the address and postage.
        </p>
        <div className="pc-edit">
          <div>
            <label className="admin-form"><span>Front</span><textarea rows={12} value={front} onChange={(e) => setFront(e.target.value)} placeholder="(default front)" spellCheck={false} className="code" /></label>
            {preview && <Preview html={preview.front} size={preview.size} />}
          </div>
          <div>
            <label className="admin-form"><span>Back</span><textarea rows={12} value={back} onChange={(e) => setBack(e.target.value)} placeholder="(default back)" spellCheck={false} className="code" /></label>
            {preview && <Preview html={preview.back} size={preview.size} />}
          </div>
        </div>
        <div className="row"><button className="btn primary" onClick={save}>Save template</button><button className="btn" onClick={() => { setFront(''); setBack(''); }}>Reset to default</button>{msg && <span className="muted">{msg}</span>}</div>
      </div>
      )}

      {past.length > 0 && (
        <div className="settings-section">
          <h2>Past batches</h2>
          <table className="tbl narrow">
            <tbody>{past.map((b) => <tr key={b.id}><td>{formatDate(b.week_of, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>{b.status}</td><td>{b.count} sent</td><td>{b.sent_at ? new Date(b.sent_at).toLocaleDateString() : ''}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
