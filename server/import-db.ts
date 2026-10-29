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

// Writes the plan. Not transactional across tables, but idempotent per
// customer: a customer whose epicor_id already exists is skipped.
export async function commitImport(plan: ImportPlan, label: string) {
  let customers = 0;
  let vehicles = 0;
  let history = 0;
  let skipped = 0;
  for (const c of plan.customers) {
    if (c.epicor_id) {
      const { data: dup } = await db().from('customers').select('id').eq('epicor_id', c.epicor_id).maybeSingle();
      if (dup) { skipped++; continue; }
    }
    const { data: row, error } = await db().from('customers').insert({
      name: c.name, email: c.email, phone: c.phone,
      address_line1: c.address_line1, address_line2: c.address_line2, city: c.city, state: c.state, postal_code: c.postal_code,
      email_opt_out: c.email_opt_out, mail_opt_out: c.mail_opt_out, source: 'import', epicor_id: c.epicor_id,
    }).select('id').single();
    if (error) throw new Error(`customer rows ${c.rows.join(',')}: ${error.message}`);
    customers++;
    const vehicleIds = new Map<string, string>();
    for (const v of c.vehicles) {
      const { data: vr } = await db().from('vehicles').insert({ customer_id: row!.id, year: v.year, make: v.make, model: v.model }).select('id').single();
      vehicleIds.set(v.key, vr!.id);
      vehicles++;
    }
    if (c.history.length) {
      await db().from('service_history').insert(c.history.map((h) => ({
        customer_id: row!.id, vehicle_id: h.vehicle_key ? vehicleIds.get(h.vehicle_key) ?? null : null,
        service_id: h.service_id, service_date: h.service_date, mileage: h.mileage, raw_service: h.raw_service, source: 'import',
      })));
      history += c.history.length;
    }
  }
  const result = { customers, vehicles, history, skipped_existing_epicor_ids: skipped };
  await rpc('audit', { p_actor: { type: 'system', label: `epicor import ${label}` }, p_action: 'import.commit', p_entity: 'import', p_entity_id: label, p_before: null, p_after: result });
  return result;
}
