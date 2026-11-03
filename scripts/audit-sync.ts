// Loads a code-audit run into the admin Launch checklist (arts.audit_items).
//   npx tsx scripts/audit-sync.ts dump                  # current items as JSON (for the /audit command)
//   npx tsx scripts/audit-sync.ts apply audit/run.json  # record a run
//   add --env .env.local to target the local database (default .env.staging.local)
//
// run.json: { "summary": "...", "findings": [Finding], "fixed": ["key", ...] }
// Finding:  { key, section, sort, title, detail, priority, owner }
// Items are matched by key. A run never changes the owner's ticks or notes; it
// only refreshes the text and records what the audit saw (audit_status).
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const envFile = arg('--env') ?? '.env.staging.local';
for (const line of existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"|"$/g, '').trim();
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(`Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${envFile}.`);
  process.exit(1);
}
const db = createClient<any, 'arts'>(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'arts' }, auth: { persistSession: false } });

export interface Finding { key: string; section: string; sort: number; title: string; detail: string; priority: string; owner: string }
export interface Run { summary: string; findings: Finding[]; fixed?: string[] }

const PRIORITIES = ['now', 'before-launch', 'soon', 'later'];
const OWNERS = ['jake', 'claude', 'both'];

function check(run: Run) {
  const keys = new Set<string>();
  for (const f of run.findings) {
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(f.key)) throw new Error(`bad key: ${f.key}`);
    if (keys.has(f.key)) throw new Error(`duplicate key: ${f.key}`);
    keys.add(f.key);
    if (!f.title || !f.section) throw new Error(`${f.key}: title and section are required`);
    if (!PRIORITIES.includes(f.priority)) throw new Error(`${f.key}: priority must be one of ${PRIORITIES.join(', ')}`);
    if (!OWNERS.includes(f.owner)) throw new Error(`${f.key}: owner must be one of ${OWNERS.join(', ')}`);
  }
  for (const k of run.fixed ?? []) if (keys.has(k)) throw new Error(`${k} is both a finding and fixed`);
}

async function must<T>(p: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

async function dump() {
  const rows = await must(db.from('audit_items').select('key, section, sort, title, priority, owner, done, audit_status, note').order('sort'));
  console.log(JSON.stringify(rows, null, 2));
}

async function apply(file: string) {
  const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
  check(run);
  const existing = await must(db.from('audit_items').select('id, key')) as { id: string; key: string }[];
  const byKey = new Map(existing.map((r) => [r.key, r.id]));
  const [r] = await must(db.from('audit_runs').insert({ summary: run.summary ?? '', found: run.findings.length }).select('id')) as { id: string }[];
  const now = new Date().toISOString();
  let added = 0;
  for (const f of run.findings) {
    const fields = { section: f.section, sort: f.sort, title: f.title, detail: f.detail ?? '', priority: f.priority, owner: f.owner, last_seen_run: r.id, updated_at: now };
    if (byKey.has(f.key)) {
      await must(db.from('audit_items').update({ ...fields, audit_status: 'present' }).eq('key', f.key));
    } else {
      // On the very first run everything is new, so don't flag it as such.
      await must(db.from('audit_items').insert({ key: f.key, ...fields, audit_status: existing.length ? 'new' : 'present', first_seen_run: r.id }));
      added++;
    }
  }
  const seen = new Set(run.findings.map((f) => f.key));
  const fixed = (run.fixed ?? []).filter((k) => byKey.has(k));
  if (fixed.length) await must(db.from('audit_items').update({ audit_status: 'fixed', updated_at: now }).in('key', fixed));
  const missing = existing.map((e) => e.key).filter((k) => !seen.has(k) && !fixed.includes(k));
  if (missing.length) await must(db.from('audit_items').update({ audit_status: 'not_found', updated_at: now }).in('key', missing));
  await must(db.from('audit_runs').update({ added, fixed: fixed.length }).eq('id', r.id));
  console.log(`Run recorded: ${run.findings.length} findings (${added} new), ${fixed.length} verified fixed, ${missing.length} not found this time.`);
}

const cmd = args[0];
if (cmd === 'dump') await dump();
else if (cmd === 'apply' && args[1]) await apply(args[1]);
else {
  console.error('Usage: audit-sync.ts dump | apply <run.json> [--env file]');
  process.exit(1);
}
