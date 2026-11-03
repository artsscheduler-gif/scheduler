import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { must, useQuery, useSettings } from './shared';

function diff(before: any, after: any): string {
  if (!before || !after) return '';
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !['updated_at', 'created_at'].includes(k));
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`).join('; ');
}

export function Activity() {
  const [tab, setTab] = useState<'audit' | 'reminders' | 'emails' | 'jobs'>('audit');
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(200);
  const { data: s } = useSettings();
  const audit = useQuery(() => must(supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit)) as Promise<any[]>, [limit]);
  const sends = useQuery(() => must(supabase.from('reminder_sends').select('*, customers(name), services(name)').order('created_at', { ascending: false }).limit(limit)) as Promise<any[]>, [limit]);
  const emails = useQuery(() => must(supabase.from('email_log').select('*').order('created_at', { ascending: false }).limit(limit)) as Promise<any[]>, [limit]);
  const jobs = useQuery(() => must(supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(Math.min(limit, 500))) as Promise<any[]>, [limit]);
  // Times in the shop's timezone, wherever the admin is viewed from.
  const t = (d: string) => new Date(d).toLocaleString('en-US', { timeZone: s?.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const f = filter.trim().toLowerCase();
  const match = (r: unknown) => !f || JSON.stringify(r).toLowerCase().includes(f);
  const shown = { audit: audit.data, reminders: sends.data, emails: emails.data, jobs: jobs.data }[tab];

  return (
    <div>
      <div className="tabs" role="tablist">
        {(['audit', 'reminders', 'emails', 'jobs'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {{ audit: 'Changes', reminders: 'Reminders', emails: 'Emails', jobs: 'Scheduled jobs' }[k]}
          </button>
        ))}
      </div>
      <div className="row wrap activity-tools">
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: name, action, email…" aria-label="Filter activity" />
        <span className="muted small">{shown ? `${shown.filter(match).length} of ${shown.length} loaded` : ''}{s ? ` · times in ${s.timezone}` : ''}</span>
        {shown && shown.length >= Math.min(limit, tab === 'jobs' ? 500 : limit) && <button className="btn small" onClick={() => setLimit((n) => n + 500)}>Show older</button>}
      </div>
      {tab === 'audit' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {audit.data?.filter(match).map((r) => (
              <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.actor_label || r.actor_type}<div className="muted small">{r.actor_type}</div></td><td>{r.action}</td><td className="small mono-wrap">{diff(r.before, r.after) || (r.after ? '' : 'removed')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'reminders' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>Customer</th><th>Service · due</th><th>Step</th><th>Status</th><th>Cost</th></tr></thead>
          <tbody>
            {sends.data?.filter(match).map((r) => (
              <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.customers?.name}</td><td>{r.services?.name} · {r.due_date}</td><td>{r.step} · {r.channel}</td><td>{r.status}{r.error ? ` — ${r.error}` : ''}</td><td>{r.cost_cents != null ? `$${(r.cost_cents / 100).toFixed(2)}` : ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'emails' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>To</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            {emails.data?.filter(match).map((r) => <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.to_email}</td><td>{r.kind}</td><td>{r.status}{r.error ? ` — ${r.error}` : ''}</td></tr>)}
          </tbody>
        </table>
      )}
      {tab === 'jobs' && (
        <table className="tbl">
          <thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Summary</th></tr></thead>
          <tbody>
            {jobs.data?.filter(match).map((r) => <tr key={r.id}><td className="nowrap">{t(r.started_at)}</td><td>{r.job}</td><td>{r.status}</td><td className="small mono-wrap">{r.error ? r.error.split('\n')[0] : JSON.stringify(r.summary)}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}
