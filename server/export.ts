import { db } from './db.js';
import { toCsvString } from '../shared/csv.js';

// Art owns this data: every export is complete and readable without this app.
export const EXPORTS = {
  customers: {
    select: 'id, name, email, phone, address_line1, address_line2, city, state, postal_code, email_opt_out, mail_opt_out, email_bounced, address_undeliverable, always_review, source, epicor_id, merged_into, created_at',
  },
  vehicles: { select: 'id, customer_id, year, make, model, notes, created_at' },
  service_history: { select: 'id, customer_id, vehicle_id, service_id, service_date, mileage, raw_service, source, booking_id, created_at' },
  bookings: {
    select: 'id, root_id, customer_id, vehicle_id, date, kind, start_time, total_minutes, status, customer_notes, source, auto_confirmed, created_by_type, decided_at, decline_reason, created_at, booking_services(services(name))',
  },
  services: { select: 'id, name, description, duration_minutes, wait_eligible, daily_cap, lead_days, reminder_interval_months, approval_level, active' },
} as const;

export async function exportRows(table: keyof typeof EXPORTS): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const columns: string = EXPORTS[table].select;
    const { data, error } = await db().from(table).select(columns).order('id').range(from, from + 999);
    if (error) throw error;
    out.push(...(data as any[]));
    if (!data || data.length < 1000) break;
  }
  if (table === 'bookings') {
    return out.map(({ booking_services, ...b }: any) => ({ ...b, services: booking_services.map((x: any) => x.services.name).join('; ') }));
  }
  return out;
}

export async function toCsv(table: keyof typeof EXPORTS): Promise<string> {
  const rows = await exportRows(table);
  const columns = EXPORTS[table].select.split(',').map((c) => c.trim()).filter((c) => !c.includes('('));
  if (table === 'bookings') columns.push('services');
  return toCsvString(columns, rows);
}
