import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery } from './shared';

interface Row { id: string; kind: string | null; to_email: string; from_email: string; subject: string; attachments: string[]; sim_date: string | null; created_at: string }

const t = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Message({ id }: { id: string }) {
  const msg = useQuery(() => must(supabase.from('email_outbox').select('*').eq('id', id).single()) as Promise<Row & { html: string; text: string }>, [id]);
  const [plain, setPlain] = useState(false);
  const m = msg.data;
  if (!m) return <p className="loading">Loading…</p>;
  return (
    <div className="outbox-msg">
      <dl className="outbox-head">
        <dt>From</dt><dd>{m.from_email}</dd>
        <dt>To</dt><dd>{m.to_email}</dd>
        <dt>Subject</dt><dd><strong>{m.subject}</strong></dd>
        <dt>Kind</dt><dd>{m.kind ?? '—'}{m.sim_date ? ` · simulated ${m.sim_date}` : ''}</dd>
        {m.attachments.length > 0 && <><dt>Attached</dt><dd>{m.attachments.join(', ')}</dd></>}
      </dl>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={!plain} className={plain ? '' : 'on'} onClick={() => setPlain(false)}>HTML</button>
        <button role="tab" aria-selected={plain} className={plain ? 'on' : ''} onClick={() => setPlain(true)}>Plain text</button>
      </div>
      {/* sandbox with no permissions: email HTML can't run script or reach the admin session */}
      {plain ? <pre className="outbox-text">{m.text}</pre> : <iframe title="Email preview" sandbox="" srcDoc={m.html} className="outbox-frame" />}
    </div>
  );
}

export function Outbox() {
  const rows = useQuery(() => must(supabase.from('email_outbox').select('id, kind, to_email, from_email, subject, attachments, sim_date, created_at').order('created_at', { ascending: false }).limit(300)) as Promise<Row[]>);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const list = (rows.data ?? []).filter((r) => !q || `${r.to_email} ${r.subject} ${r.kind}`.toLowerCase().includes(q.toLowerCase()));

  async function clear() {
    if (!confirm('Delete every captured email?')) return;
    await adminPost('outbox-clear', {});
    setSel(null);
    rows.reload();
  }

  return (
    <div className="settings">
      <div className="banner">Staging outbox. Nothing here was delivered: every email the app sends is captured instead. Simulated customers use <code>@sim.invalid</code> addresses.</div>
      <div className="row wrap">
        <input type="search" placeholder="Filter by recipient, subject or kind" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        <span className="muted small">{list.length} of {rows.data?.length ?? 0}{rows.data?.length === 300 ? ' (latest 300)' : ''}</span>
        <button className="btn push" onClick={rows.reload}>Refresh</button>
        <button className="btn danger" onClick={clear} disabled={!rows.data?.length}>Clear outbox</button>
      </div>
      <div className="outbox">
        <div className="outbox-list">
          {rows.data && list.length === 0 && <p className="muted">No emails yet. Book something, or use the Simulator.</p>}
          {list.map((r) => (
            <button key={r.id} className={sel === r.id ? 'on' : ''} onClick={() => setSel(r.id)}>
              <span className="small muted">{r.sim_date ? `Sim ${r.sim_date}` : t(r.created_at)} · {r.kind ?? 'email'}</span>
              <strong>{r.subject}</strong>
              <span className="small">{r.to_email}</span>
            </button>
          ))}
        </div>
        <div>{sel ? <Message id={sel} /> : <p className="muted">Pick an email to see it as the recipient would.</p>}</div>
      </div>
    </div>
  );
}
