// "Run now" on Settings → Test runs: records the request, then asks GitHub to
// start the test lab workflow (.github/workflows/lab.yml). The workflow saves
// its result onto the same row (scripts/lab-report.ts).
import { db } from './db.js';
import { env } from './env.js';
import { HttpError, type Result } from './http.js';
import * as V from './validate.js';
import type { Admin } from './admin.js';

export async function labRun(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['seed']);
  const seed = b.seed === undefined || b.seed === null || b.seed === '' ? null : V.int(b.seed, 'seed', 0, 2 ** 31);
  if (!env.githubDispatchToken) throw new HttpError(501, { error: 'not_configured' });
  const { data: row, error } = await db().from('lab_runs')
    .insert({ source: seed === null ? 'manual' : 'replay', status: 'queued', requested_by: a.label, seed })
    .select('*').single();
  if (error) throw new Error(error.message);
  const res = await fetch(`https://api.github.com/repos/${env.githubRepo}/actions/workflows/lab.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.githubDispatchToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs: { request_id: row.id, source: row.source, ...(seed === null ? {} : { seed: String(seed) }) } }),
  });
  if (!res.ok) {
    const msg = `GitHub ${res.status}: ${((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'could not start the run'}`;
    await db().from('lab_runs').update({ status: 'error', error: msg, finished_at: new Date().toISOString() }).eq('id', row.id);
    throw new HttpError(502, { error: msg });
  }
  return { status: 200, body: row };
}
