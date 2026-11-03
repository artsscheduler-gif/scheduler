import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { adminPost } from './api';
import { must, useQuery } from './shared';

// Launch checklist (owner only). Items come from code audits: run /audit in
// Claude Code in the project folder, which loads its findings here.

interface Item {
  id: string; key: string; section: string; sort: number; title: string; detail: string;
  priority: 'now' | 'before-launch' | 'soon' | 'later'; owner: 'jake' | 'claude' | 'both';
  done: boolean; done_at: string | null; done_by: string | null; note: string;
  audit_status: 'new' | 'present' | 'fixed' | 'not_found';
}
interface Run { id: string; ran_at: string; summary: string; found: number; added: number; fixed: number }

const PRIORITY = { now: 'Do now', 'before-launch': 'Before launch', soon: 'Soon', later: 'Later' } as const;
const OWNER = { jake: 'You', claude: 'Claude', both: 'Both' } as const;
const when = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// What the latest audit said, when it's worth calling out next to the tick.
function auditFlag(i: Item): { text: string; tone: 'ok' | 'warn' } | null {
  if (i.audit_status === 'fixed' && !i.done) return { text: 'Latest audit: fixed. Tick it off.', tone: 'ok' };
  if (i.audit_status === 'not_found' && !i.done) return { text: 'Latest audit didn’t find this. Check, then tick it off.', tone: 'ok' };
  if (i.audit_status === 'present' && i.done) return { text: 'Ticked, but the latest audit still finds it.', tone: 'warn' };
  if (i.audit_status === 'new' && !i.done) return { text: 'New in the latest audit', tone: 'warn' };
  return null;
}

function Row({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(item.note);
  const [err, setErr] = useState('');
  const flag = auditFlag(item);

  // Show the tick at once; put it back if the save fails.
  async function save(patch: { done?: boolean; note?: string }) {
    setErr('');
    onChange({ ...item, ...patch });
    try {
      onChange(await adminPost<Item>('audit-item', { id: item.id, ...patch }));
    } catch (e) {
      onChange(item);
      setErr(`Not saved: ${(e as Error).message}`);
    }
  }

  return (
    <li className={`ck-item ${item.done ? 'done' : ''}`}>
      <label className="ck-main">
        <input type="checkbox" checked={item.done} onChange={(e) => save({ done: e.target.checked })} />
        <span className="ck-title">{item.title}</span>
      </label>
      <div className="ck-meta">
        <span className={`ck-pri p-${item.priority}`}>{PRIORITY[item.priority]}</span>
        <span className="ck-owner">{OWNER[item.owner]}</span>
        {flag && <span className={`ck-flag ${flag.tone}`}>{flag.text}</span>}
        {item.done && item.done_at && <span className="muted small">Done {when(item.done_at)}{item.done_by ? ` · ${item.done_by}` : ''}</span>}
        <button className="linklike small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Less' : 'Details'}</button>
      </div>
      {open && (
        <div className="ck-detail">
          {item.detail && <p>{item.detail}</p>}
          <label className="ck-note">Notes / decision
            <textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== item.note && save({ note })} placeholder="Anything to remember about this item" />
          </label>
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </li>
  );
}

export function Checklist() {
  const items = useQuery(() => must(supabase.from('audit_items').select('*').order('sort')) as Promise<Item[]>);
  const runs = useQuery(() => must(supabase.from('audit_runs').select('*').order('ran_at', { ascending: false }).limit(1)) as Promise<Run[]>);
  const [rows, setRows] = useState<Item[] | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [mine, setMine] = useState(false);
  const list = rows ?? items.data;

  const sections = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of list ?? []) m.set(i.section, [...(m.get(i.section) ?? []), i]);
    return [...m.entries()];
  }, [list]);

  if (items.error) return <p className="error">{items.error}</p>;
  if (!list) return <p className="loading">Loading…</p>;

  const update = (i: Item) => setRows((cur) => (cur ?? list).map((x) => (x.id === i.id ? i : x)));
  const total = list.length;
  const done = list.filter((i) => i.done).length;
  const run = runs.data?.[0];

  return (
    <div className="checklist">
      <div className="ck-head">
        <div>
          <h2>Launch checklist</h2>
          <p className="muted small">
            {done} of {total} done
            {run && <> · Last audit {when(run.ran_at)}: {run.found} findings, {run.added} new, {run.fixed} verified fixed</>}
          </p>
          <div className="ck-bar" aria-hidden="true"><span style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
        </div>
        <div className="ck-rerun">
          <strong>Rerun the audit</strong>
          <span className="small">In Claude Code, in the project folder, type</span>
          <code>/audit</code>
          <span className="small muted">Takes a few minutes. New problems are added here; fixed ones are flagged.</span>
        </div>
      </div>
      <div className="row wrap">
        <label className="check-row"><input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide done</label>
        <label className="check-row"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label>
      </div>
      {total === 0 && <p className="muted">No items yet. Run /audit in Claude Code to fill this in.</p>}
      {sections.map(([section, all]) => {
        const shown = all.filter((i) => (!hideDone || !i.done) && (!mine || i.owner !== 'claude'));
        const d = all.filter((i) => i.done).length;
        return (
          <section key={section} className="settings-section ck-section">
            <h3>{section} <span className="muted small">{d}/{all.length}</span></h3>
            {shown.length === 0 ? <p className="muted small">All done.</p> : (
              <ul className="ck-list">{shown.map((i) => <Row key={i.id} item={i} onChange={update} />)}</ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
