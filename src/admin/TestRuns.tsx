import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AdminError, adminPost } from './api';
import { must, useQuery } from './shared';

// Settings → Test runs: results of the automated test lab. Each run plays out
// six simulated weeks at the shop and a set of randomized rule checks on a
// throwaway database on GitHub (nightly, or "Run now"), then saves here.

interface Check { name: string; group: string; status: 'passed' | 'failed' | 'skipped'; message: string }
interface Run {
  id: string; source: string; status: 'queued' | 'passed' | 'failed' | 'error'; requested_by: string | null;
  requested_at: string; finished_at: string | null; seed: number | null; days: number | null; commit: string | null;
  run_url: string | null; duration_s: number | null; broken: { rule: string; detail: string; day: string }[];
  findings: Record<string, { count: number; examples: string[] }>; stats: Record<string, number>; checks: Check[]; error: string | null;
}

const STATUS: Record<Run['status'], [string, string]> = {
  queued: ['Running…', 'badge warn'], passed: ['Passed', 'badge ok'], failed: ['Rule broken', 'badge bad'], error: ['Didn’t finish', 'badge bad'],
};
const SOURCE: Record<string, string> = { nightly: 'Nightly', manual: 'Run now', replay: 'Replay', local: 'From a laptop' };
const when = (d: string) => new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// A run that was asked for but never reported back.
const stale = (r: Run) => r.status === 'queued' && Date.now() - Date.parse(r.requested_at) > 45 * 60_000;

export function TestRuns() {
  const runs = useQuery(() => must(supabase.from('lab_runs').select('*').order('requested_at', { ascending: false }).limit(30)) as Promise<Run[]>);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const list = runs.data ?? [];
  const waiting = list.some((r) => r.status === 'queued' && !stale(r));

  // While a run is going, check back every 20 seconds.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(runs.reload, 20_000);
    return () => clearInterval(t);
  }, [waiting, runs.reload]);

  async function start(seed?: number | null) {
    setBusy(true);
    setMsg('');
    try {
      const r = await adminPost('lab-run', seed ? { seed } : {});
      if (r?.error) setMsg(r.error);
      else setMsg('Started. Results show here in about 3–5 minutes.');
      runs.reload();
    } catch (e) {
      setMsg(e instanceof AdminError && e.body?.error === 'not_configured'
        ? '“Run now” isn’t connected yet: it needs GITHUB_DISPATCH_TOKEN in Vercel (see Help → Test runs). Nightly runs still happen.'
        : `Couldn’t start a run: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const latest = list.find((r) => r.status !== 'queued');
  return (
    <div className="settings test-runs">
      <div className="settings-section">
        <h2>Test runs</h2>
        <p className="help">
          Every night the test lab plays out six weeks at the shop — customers booking and changing their minds, Chris answering, the reminder
          jobs, a monthly TRACS import — and checks that no rule ever breaks (no overbooking, nobody contacted after opting out, merges that undo
          cleanly…). It also throws thousands of random situations at the booking, merge, reminder and import code. Nothing here touches the real data.
        </p>
        <div className="row wrap">
          <button className="btn primary" disabled={busy || waiting} onClick={() => start()}>{waiting ? 'A run is going…' : 'Run now'}</button>
          {latest && <span className="small">Latest: <span className={STATUS[latest.status][1]}>{STATUS[latest.status][0]}</span> {when(latest.finished_at ?? latest.requested_at)}</span>}
        </div>
        {msg && <p className="small" role="status">{msg}</p>}
      </div>

      {runs.error && <p className="error">{runs.error}</p>}
      {runs.data && !list.length && <p className="muted">No runs yet. The first nightly run happens at about 3am, or press Run now.</p>}

      {list.length > 0 && (
        <table className="tbl runs-tbl">
          <thead>
            <tr><th>When</th><th>Result</th><th>Rules broken</th><th>Checks</th><th>Findings</th><th>Started by</th><th /></tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const failed = r.checks.filter((c) => c.status === 'failed').length;
              const [label, cls] = stale(r) ? ['No result', 'badge bad'] : STATUS[r.status];
              return (
                <tr key={r.id} className={open === r.id ? 'on' : ''}>
                  <td>{when(r.requested_at)}</td>
                  <td><span className={cls}>{label}</span></td>
                  <td>{r.status === 'queued' ? '' : r.broken.length}</td>
                  <td>{r.checks.length ? `${r.checks.length - failed}/${r.checks.length} passed` : ''}</td>
                  <td>{r.status === 'queued' ? '' : Object.values(r.findings).reduce((n, f) => n + f.count, 0)}</td>
                  <td className="small">{SOURCE[r.source] ?? r.source}{r.requested_by ? ` · ${r.requested_by}` : ''}{r.seed ? ` · seed ${r.seed}` : ''}</td>
                  <td>{r.status !== 'queued' && <button className="btn small" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{open === r.id ? 'Hide' : 'Details'}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {open && list.find((r) => r.id === open) && <RunDetail run={list.find((r) => r.id === open)!} onReplay={(seed) => start(seed)} busy={busy || waiting} />}
      {list.filter((r) => r.status !== 'queued').length > 1 && <Trend runs={list.filter((r) => r.status === 'passed' || r.status === 'failed').slice(0, 10).reverse()} />}
    </div>
  );
}

function RunDetail({ run, onReplay, busy }: { run: Run; onReplay: (seed: number) => void; busy: boolean }) {
  const findings = Object.entries(run.findings).sort((a, b) => b[1].count - a[1].count);
  return (
    <div className="settings-section run-detail">
      <div className="row wrap">
        <h3>Run of {when(run.requested_at)}</h3>
        {run.seed !== null && <button className="btn small" disabled={busy} onClick={() => onReplay(run.seed!)}>Replay this run</button>}
        {run.run_url && <a className="small" href={run.run_url} target="_blank" rel="noreferrer">Full log on GitHub</a>}
        <span className="muted small push">
          {run.days ? `${run.days} simulated days` : ''}{run.duration_s ? ` · took ${Math.round(run.duration_s / 60)} min` : ''}{run.commit ? ` · code ${run.commit}` : ''}
        </span>
      </div>
      {run.error && <pre className="run-msg">{run.error}</pre>}

      <h4>Rules broken</h4>
      {run.broken.length === 0 ? <p className="muted small">None.</p> : (
        <ul>{run.broken.map((b, i) => <li key={i}><strong>{b.rule}</strong>: {b.detail} <span className="muted small">(simulated {b.day})</span></li>)}</ul>
      )}

      <h4>Checks</h4>
      <ul className="checks">
        {run.checks.map((c, i) => (
          <li key={i}>
            <span className={c.status === 'passed' ? 'badge ok' : c.status === 'failed' ? 'badge bad' : 'badge'}>{c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '–'}</span>
            {c.group && <span className="muted small">{c.group} · </span>}{c.name}
            {c.message && <pre className="run-msg">{c.message}</pre>}
          </li>
        ))}
      </ul>

      <h4>Findings to look at</h4>
      <p className="help">Not rule breaks: things the lab thinks a person should judge, with a few examples each.</p>
      {findings.length === 0 ? <p className="muted small">None.</p> : (
        <ul>
          {findings.map(([kind, f]) => (
            <li key={kind}>
              <strong>{kind}</strong> ({f.count})
              <ul className="small">{f.examples.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>What happened in the simulated weeks</summary>
        <table className="tbl narrow small">
          <tbody>{Object.entries(run.stats).sort().map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td>{v}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

// How each kind of finding has moved over recent runs.
function Trend({ runs }: { runs: Run[] }) {
  const kinds = [...new Set(runs.flatMap((r) => Object.keys(r.findings)))];
  if (!kinds.length) return null;
  return (
    <div className="settings-section">
      <h3>Findings over the last {runs.length} runs</h3>
      <div className="table-scroll">
        <table className="tbl small trend-tbl">
          <thead>
            <tr><th>Finding</th>{runs.map((r) => <th key={r.id}>{new Date(r.requested_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</th>)}</tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k}><td>{k}</td>{runs.map((r) => <td key={r.id}>{r.findings[k]?.count ?? 0}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
