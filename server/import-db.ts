import { db, rpc } from './db.js';
import type { ImportPlan, ServiceRef } from './import.js';

export async function loadImportContext(): Promise<{ services: ServiceRef[]; existing: { id: string; name: string; email: string | null; phone: string | null }[] }> {
  const { data: services } = await db().from('services').select('id, name, epicor_codes');
  const existing: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db().from('customers').select('id, name, email, phone').is('merged_into', null).range(from, from + 999);
    existing.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { services: (services ?? []) as ServiceRef[], existing };
}

// Writes the plan, one customer per transaction (arts.import_customer). Safe
// to re-run: customers already here (by Epicor id, email, or phone + last
// name) are filled in rather than duplicated, and only new vehicles and
// service records are added. A customer that fails is reported and skipped;
// the rest still import.
export async function commitImport(plan: ImportPlan, label: string) {
  const out = { created: 0, updated: 0, vehicles: 0, history: 0, failed: [] as { rows: number[]; error: string }[] };
  for (const c of plan.customers) {
    const { rows, key, ...payload } = c;
    const { data, error } = await db().rpc('import_customer', { p: payload });
    if (error) {
      out.failed.push({ rows, error: error.message });
      continue;
    }
    const r = data as { matched: string | null; vehicles: number; history: number };
    if (r.matched) out.updated++;
    else out.created++;
    out.vehicles += r.vehicles;
    out.history += r.history;
  }
  const result = { ...out, failed: out.failed.length };
  await rpc('audit', { p_actor: { type: 'system', label: `epicor import ${label}` }, p_action: 'import.commit', p_entity: 'import', p_entity_id: label, p_before: null, p_after: result });
  return out;
}
