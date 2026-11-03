import { useRef, useState } from 'react';
import { adminPost } from './api';
import { useRole, useSettings } from './shared';

const TABLES = [
  ['customers', 'Customers'],
  ['vehicles', 'Vehicles'],
  ['service_history', 'Service history'],
  ['bookings', 'Bookings'],
  ['services', 'Services'],
] as const;

interface Change { sheet: string; action: string; label: string; detail: string }
interface Problem { sheet: string; row?: number; message: string }
interface Preview { applied: boolean; changes: Change[]; problems: Problem[] }

// The spreadsheet code is large, so it loads only when used.
const workbook = () => import('./workbook');

export function Export() {
  const role = useRole();
  const { data: s } = useSettings();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function downloadAll() {
    setBusy('download');
    setMsg('');
    try {
      await (await workbook()).downloadWorkbook(role, s?.shop_name ?? 'Shop');
    } catch (e) {
      setMsg(`Couldn’t build the workbook: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function upload(file: File) {
    setBusy('check');
    setMsg('');
    setPreview(null);
    try {
      const p = await (await workbook()).readWorkbook(file);
      setPayload(p);
      setPreview(await adminPost<Preview>('workbook-apply', { payload: p, apply: false }));
    } catch (e) {
      setMsg(`Couldn’t read that file: ${(e as Error).message}`);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function apply() {
    setBusy('apply');
    try {
      const r = await adminPost<Preview>('workbook-apply', { payload, apply: true });
      setPreview(null);
      setMsg(r.applied ? `Saved ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}.` : 'Nothing saved: fix the problems listed and upload again.');
      if (!r.applied) setPreview(r);
    } catch (e) {
      setMsg(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function downloadCsv(table: string) {
    setMsg('');
    try {
      const r = await adminPost<{ filename: string; csv: string }>('export', { table });
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  const bySheet = (preview?.changes ?? []).reduce<Record<string, Change[]>>((m, c) => ({ ...m, [c.sheet]: [...(m[c.sheet] ?? []), c] }), {});

  return (
    <div className="settings">
      <div className="settings-section">
        <h2>Excel workbook</h2>
        <p>Everything in the admin as one Excel file: services, hours, closures, blocked time, reminder steps and settings (blue tabs, editable), plus customers, vehicles, service history and bookings (grey tabs, for reference).</p>
        <button className="btn primary" disabled={!!busy} onClick={downloadAll}>{busy === 'download' ? 'Building…' : 'Download workbook (.xlsx)'}</button>
      </div>

      <div className="settings-section">
        <h2>Upload changes</h2>
        <p className="help">Edit the blue tabs in Excel, save, and upload the file here. You’ll see every change before anything is saved. Tabs you leave out are left alone; the grey tabs are ignored.</p>
        <input ref={fileRef} type="file" accept=".xlsx" aria-label="Upload edited workbook" disabled={!!busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {busy === 'check' && <p className="loading">Checking…</p>}
        {preview && (
          <div className="wb-preview">
            {preview.problems.length > 0 && (
              <div className="notice" role="alert">
                <strong>Fix these, then upload again</strong>
                <ul>{preview.problems.map((p, i) => <li key={i}>{p.sheet}{p.row ? `, row ${p.row}` : ''}: {p.message}</li>)}</ul>
              </div>
            )}
            {preview.changes.length === 0 && preview.problems.length === 0 && <p className="muted">No changes found: the file matches what’s saved.</p>}
            {Object.entries(bySheet).map(([sheet, cs]) => (
              <div key={sheet}>
                <h3>{sheet}</h3>
                <ul className="wb-changes">
                  {cs.map((c, i) => <li key={i}><span className={`wb-act wb-${c.action.replace(' ', '-')}`}>{c.action}</span> <strong>{c.label}</strong>{c.detail ? ` · ${c.detail}` : ''}</li>)}
                </ul>
              </div>
            ))}
            {preview.changes.length > 0 && preview.problems.length === 0 && (
              <div className="row">
                <button className="btn primary" disabled={!!busy} onClick={apply}>{busy === 'apply' ? 'Saving…' : `Save ${preview.changes.length} change${preview.changes.length === 1 ? '' : 's'}`}</button>
                <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>Single tables (CSV)</h2>
        <div className="row wrap">
          {TABLES.map(([k, label]) => <button key={k} className="btn small" onClick={() => downloadCsv(k)}>{label}</button>)}
        </div>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}
