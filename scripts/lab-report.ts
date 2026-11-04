// Saves a test lab run (npm run lab) to the staging database, where Settings →
// Test runs shows it. A run that breaks a rule also adds (or reopens) an item
// on the Checklist so it isn't missed.
//
// Reads tests/lab/out/report.json (the simulated weeks) and
// tests/lab/out/vitest.json (every lab test, from vitest's JSON reporter).
// Needs REPORT_SUPABASE_URL and REPORT_SERVICE_ROLE_KEY (staging); without
// them it prints the summary and saves nothing. LAB_REQUEST_ID fills in the
// row created by "Run now"; LAB_SOURCE says what started the run.
import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const OUT = 'tests/lab/out';
const read = (f: string) => (existsSync(`${OUT}/${f}`) ? JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')) : null);
const month = read('report.json') as null | { seed: number; days: number; broken: { rule: string; detail: string; day: string }[]; findings: Record<string, string[]>; stats: Record<string, number>; totals: Record<string, number>; seconds?: number };
const vitest = read('vitest.json') as null | { startTime?: number; testResults: { assertionResults: { title: string; ancestorTitles: string[]; status: string; failureMessages: string[] }[]; message?: string }[] };

const checks = (vitest?.testResults ?? []).flatMap((f) => f.assertionResults.map((t) => ({
  name: t.title,
  group: t.ancestorTitles[0] ?? '',
  status: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped',
  // The first lines say what failed; fast-check adds the smallest failing case and its seed.
  message: t.failureMessages.join('\n').split('\n').filter((l) => !/^\s+at |node_modules/.test(l)).slice(0, 14).join('\n').slice(0, 2000),
})));
const fileErrors = (vitest?.testResults ?? []).map((f) => f.message).filter(Boolean) as string[];

// The same rule broken on every day after it first broke is one problem.
const broken = [...new Map((month?.broken ?? []).map((b) => [b.rule + b.detail, b])).values()];
const failedChecks = checks.filter((c) => c.status === 'failed');
const status = !month && !checks.length ? 'error' : broken.length || failedChecks.length || fileErrors.length ? 'failed' : 'passed';
const server = process.env.GITHUB_SERVER_URL;
const row = {
  source: (process.env.LAB_SOURCE || (process.env.GITHUB_EVENT_NAME === 'schedule' ? 'nightly' : process.env.GITHUB_ACTIONS ? 'manual' : 'local')) as string,
  status,
  finished_at: new Date().toISOString(),
  seed: month?.seed ?? null,
  days: month?.days ?? null,
  commit: process.env.GITHUB_SHA?.slice(0, 7) ?? null,
  run_url: server ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  duration_s: vitest?.startTime ? Math.round((Date.now() - vitest.startTime) / 1000) : null,
  broken: broken.slice(0, 50),
  // A few examples of each finding is enough to judge it.
  findings: Object.fromEntries(Object.entries(month?.findings ?? {}).map(([k, xs]) => [k, [...new Set(xs.map((x) => x.replace(/^\S+: /, '')))]]).map(([k, xs]) => [k, { count: xs.length, examples: (xs as string[]).slice(0, 5) }])),
  stats: { ...(month?.totals ?? {}), ...(month?.stats ?? {}) },
  checks,
  error: status === 'error' ? fileErrors.join('\n').slice(0, 2000) || 'The lab produced no results (it may have failed to start).' : fileErrors.join('\n').slice(0, 2000) || null,
};

console.log(`Lab ${status}: ${broken.length} rule(s) broken, ${failedChecks.length} of ${checks.length} checks failed, seed ${row.seed}`);

const url = process.env.REPORT_SUPABASE_URL;
const key = process.env.REPORT_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log('REPORT_SUPABASE_URL / REPORT_SERVICE_ROLE_KEY not set: not saved.');
  process.exit(0);
}
const db = createClient<any, 'arts'>(url, key, { db: { schema: 'arts' }, auth: { persistSession: false } });
const requestId = process.env.LAB_REQUEST_ID || null;
const { error } = requestId
  ? await db.from('lab_runs').update(row).eq('id', requestId)
  : await db.from('lab_runs').insert(row);
if (error) throw new Error(`saving the run: ${error.message}`);

// A broken rule or failed check goes on the Checklist (reopened if it was ticked before).
const problems = [
  ...broken.map((b) => ({ title: `Test lab: ${b.rule}`, detail: `${b.detail} (simulated day ${b.day})` })),
  ...failedChecks.map((c) => ({ title: `Test lab: ${c.name}`, detail: c.message.split('\n').slice(0, 4).join(' ') })),
];
for (const p of [...new Map(problems.map((x) => [x.title, x])).values()].slice(0, 10)) {
  const k = `lab-${p.title.replace(/^Test lab: /, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;
  const detail = `${p.detail}\nReplay: LAB_SEED=${row.seed ?? '?'} npm run lab${row.run_url ? ` · ${row.run_url}` : ''}`;
  const { data: existing } = await db.from('audit_items').select('id, done').eq('key', k).maybeSingle();
  if (!existing) {
    await db.from('audit_items').insert({ key: k, section: '3. Found by the test lab', sort: 0, title: p.title, detail, priority: 'now', owner: 'claude' });
  } else {
    await db.from('audit_items').update({ detail, done: false, done_at: null, done_by: null, updated_at: new Date().toISOString() }).eq('id', existing.id);
  }
}
console.log(`Saved${problems.length ? `; ${problems.length} problem(s) on the Checklist` : ''}.`);
