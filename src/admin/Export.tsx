import { useState } from 'react';
import { adminPost } from './api';

const TABLES = [
  ['customers', 'Customers'],
  ['vehicles', 'Vehicles'],
  ['service_history', 'Service history'],
  ['bookings', 'Bookings'],
  ['services', 'Appointment types'],
] as const;

export function Export() {
  const [msg, setMsg] = useState('');
  async function download(table: string) {
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
  return (
    <div className="settings-section">
      <h2>Export</h2>
      <p>This is Art’s data. Download any of it as a spreadsheet (CSV), any time.</p>
      <div className="row wrap">
        {TABLES.map(([k, label]) => <button key={k} className="btn" onClick={() => download(k)}>{label}</button>)}
      </div>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
