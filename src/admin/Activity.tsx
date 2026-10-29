import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { must, useQuery } from './shared';

function diff(before: any, after: any): string {
  if (!before || !after) return '';
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !['updated_at', 'created_at'].includes(k));
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`).join('; ');
}

export function Activity() {
  const [tab, setTab] = useState<'audit' | 'reminders' | 'emails' | 'jobs'>('audit');
  const audit = useQuery(() => must(supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)) as Promise<any[]>);
  const sends = useQuery(() => must(supabase.from('reminder_sends').select('*, customers(name), services(name)').order('created_at', { ascending: false }).limit(200)) as Promise<any[]>);
  const emails = useQuery(() => must(supabase.from('email_log').select('*').order('created_at', { ascending: false }).limit(200)) as Promise<any[]>);
  const jobs = useQuery(() => must(supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(60)) as Promise<any[]>);
  const t = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div>
      <div className="tabs" role="tablist">
        {(['audit', 'reminders', 'emails', 'jobs'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {{ audit: 'Changes', reminders: 'Reminders', emails: 'Emails', jobs: 'Scheduled jobs' }[k]}
          </button>
        ))}
      </div>
      {tab === 'audit' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {audit.data?.map((r) => (
              <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.actor_label || r.actor_type}<div className="muted small">{r.actor_type}</div></td><td>{r.action}</td><td className="small mono-wrap">{diff(r.before, r.after) || (r.after ? '' : 'removed')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'reminders' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>Customer</th><th>Service · due</th><th>Step</th><th>Status</th><th>Cost</th></tr></thead>
          <tbody>
            {sends.data?.map((r) => (
              <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.customers?.name}</td><td>{r.services?.name} · {r.due_date}</td><td>{r.step} · {r.channel}</td><td>{r.status}{r.error ? ` — ${r.error}` : ''}</td><td>{r.cost_cents != null ? `$${(r.cost_cents / 100).toFixed(2)}` : ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'emails' && (
        <table className="tbl">
          <thead><tr><th>When</th><th>To</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            {emails.data?.map((r) => <tr key={r.id}><td className="nowrap">{t(r.created_at)}</td><td>{r.to_email}</td><td>{r.kind}</td><td>{r.status}{r.error ? ` — ${r.error}` : ''}</td></tr>)}
          </tbody>
        </table>
      )}
      {tab === 'jobs' && (
        <table className="tbl">
          <thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Summary</th></tr></thead>
          <tbody>
            {jobs.data?.map((r) => <tr key={r.id}><td className="nowrap">{t(r.started_at)}</td><td>{r.job}</td><td>{r.status}</td><td className="small mono-wrap">{r.error ? r.error.split('\n')[0] : JSON.stringify(r.summary)}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}
