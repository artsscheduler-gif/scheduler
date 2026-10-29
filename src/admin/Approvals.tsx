import { useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery, useServices, useSettings } from './shared';
import { ladderSuggestion, weekOf } from '../../shared/ladder';
import { LEVEL_LABEL } from '../../shared/rules';
import { formatDate } from '../../shared/time';

const NEXT = { approve: 'notify', notify: 'digest', digest: null } as const;
const PREV = { approve: null, notify: 'approve', digest: 'notify' } as const;

export function Approvals() {
  const s = useSettings();
  const services = useServices();
  const since = new Date(Date.now() - 12 * 7 * 86400_000).toISOString();
  // New public bookings only: change requests and staff bookings don't count.
  const rows = useQuery(() => must(supabase.from('bookings').select('id, created_at, auto_confirmed, booking_services(service_id)').eq('created_by_type', 'public').is('change_kind', null).gte('created_at', since)) as Promise<any[]>);

  const stats = useMemo(() => {
    const byWeek = new Map<string, { n: number; auto: number }>();
    const byType = new Map<string, { n: number; auto: number }>();
    for (const r of rows.data ?? []) {
      const w = weekOf(r.created_at);
      const cur = byWeek.get(w) ?? { n: 0, auto: 0 };
      cur.n++; if (r.auto_confirmed) cur.auto++;
      byWeek.set(w, cur);
      for (const bs of r.booking_services) {
        const t = byType.get(bs.service_id) ?? { n: 0, auto: 0 };
        t.n++; if (r.auto_confirmed) t.auto++;
        byType.set(bs.service_id, t);
      }
    }
    return { byWeek: [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0])), byType };
  }, [rows.data]);

  if (!s.data || !services.data) return <p className="loading">Loading…</p>;
  const pct = (x: { n: number; auto: number } | undefined) => (x && x.n ? `${Math.round((100 * x.auto) / x.n)}%` : '—');

  async function move(id: string, level: string) {
    await adminPost('level', { service_id: id, level });
    services.reload();
  }

  return (
    <div className="approvals">
      <h2>Approval ladder</h2>
      <p className="help">
        Every type starts at step 1 (you approve each booking). The system suggests a step up when your own history supports it:
        step 2 after {s.data.ladder_step2_approvals} approvals in a row with no change; step 3 after {s.data.ladder_step3_weeks} weeks at step 2 with no undo.
        Declines, proposed times and undos reset the count. Nothing moves unless you click.
      </p>
      <table className="tbl">
        <thead>
          <tr><th>Type</th><th>Step</th><th>Approvals in a row</th><th>Auto-confirm rate (12 wk)</th><th></th></tr>
        </thead>
        <tbody>
          {services.data.filter((x) => x.active).map((svc) => {
            const sug = ladderSuggestion(svc, s.data!.ladder_step2_approvals, s.data!.ladder_step3_weeks);
            const next = NEXT[svc.approval_level];
            const prev = PREV[svc.approval_level];
            return (
              <tr key={svc.id} className={sug ? 'suggest' : ''}>
                <td><strong>{svc.name}</strong></td>
                <td>{LEVEL_LABEL[svc.approval_level]}<div className="muted small">since {formatDate(svc.level_since.slice(0, 10), { month: 'short', day: 'numeric' })}</div></td>
                <td>{svc.approval_level === 'approve' ? `${svc.approvals_in_a_row} / ${s.data!.ladder_step2_approvals}` : '—'}</td>
                <td>{pct(stats.byType.get(svc.id))} <span className="muted small">of {stats.byType.get(svc.id)?.n ?? 0}</span></td>
                <td className="row">
                  {sug && <span className="badge ok">Ready for step {sug === 'notify' ? 2 : 3}</span>}
                  {next && <button className={`btn small ${sug ? 'primary' : ''}`} onClick={() => move(svc.id, next)}>Move up</button>}
                  {prev && <button className="btn small" onClick={() => move(svc.id, prev)}>Move down</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Auto-confirm rate by week</h2>
      <table className="tbl narrow">
        <thead><tr><th>Week of</th><th>Online bookings</th><th>Auto-confirmed</th></tr></thead>
        <tbody>
          {stats.byWeek.map(([w, x]) => <tr key={w}><td>{formatDate(w, { month: 'short', day: 'numeric' })}</td><td>{x.n}</td><td>{pct(x)}</td></tr>)}
          {stats.byWeek.length === 0 && <tr><td colSpan={3} className="muted">No online bookings yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
