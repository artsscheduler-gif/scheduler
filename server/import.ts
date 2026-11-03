// Epicor Service CRM import. The export format is unconfirmed (Open Items),
// so columns are mapped through import/epicor-mapping.json. One CSV row is one
// service record; customers and vehicles repeat across rows and are grouped.
import { normalizeEmail, normalizePhone } from '../shared/phone.js';

export interface Mapping {
  // Our field -> Epicor column header (first matching header wins).
  columns: Record<FieldName, string[]>;
  // Epicor service code/name (case-insensitive) -> our service name. Codes in
  // services.epicor_codes are also matched.
  services: Record<string, string>;
  // Values that mean "yes" in opt-out columns.
  truthy: string[];
  dateFormat: 'MM/DD/YYYY' | 'YYYY-MM-DD';
}

export type FieldName =
  | 'customer_id' | 'name' | 'first_name' | 'last_name' | 'email' | 'phone' | 'address1' | 'address2' | 'city' | 'state' | 'zip'
  | 'vehicle_year' | 'vehicle_make' | 'vehicle_model' | 'service_date' | 'service_type' | 'mileage' | 'email_opt_out' | 'mail_opt_out';

export interface ServiceRef { id: string; name: string; epicor_codes: string[] }

export interface ImportCustomer {
  key: string;
  epicor_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  email_opt_out: boolean;
  mail_opt_out: boolean;
  rows: number[];
  vehicles: { key: string; year: number | null; make: string | null; model: string | null }[];
  history: { vehicle_key: string | null; service_id: string | null; raw_service: string; service_date: string; mileage: number | null; row: number }[];
}

export interface Rejection { row: number; reason: string; data: Record<string, string> }
export interface Duplicate { kind: 'in_file' | 'existing'; customer: string; other: string; match: string }
export interface ImportPlan {
  customers: ImportCustomer[];
  rejected: Rejection[];
  duplicates: Duplicate[];
  unmappedServices: Record<string, number>;
  warnings: { row: number; message: string }[];
  totals: { rows: number; customers: number; vehicles: number; history: number; mapped_history: number; email_opt_outs: number; mail_opt_outs: number };
}

const STREET: [RegExp, string][] = [
  [/\bSTREET\b/g, 'ST'], [/\bAVENUE\b/g, 'AVE'], [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bLANE\b/g, 'LN'],
  [/\bBOULEVARD\b/g, 'BLVD'], [/\bCOURT\b/g, 'CT'], [/\bPLACE\b/g, 'PL'], [/\bHIGHWAY\b/g, 'HWY'], [/\bAPARTMENT\b/g, 'APT'],
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'], [/\bSUITE\b/g, 'STE'],
];

// USPS-style: uppercase, no punctuation, common suffixes abbreviated.
export function standardizeStreet(s: string | null | undefined): string | null {
  if (!s) return null;
  let out = s.toUpperCase().replace(/[.,]/g, ' ').replace(/#\s*/g, '# ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of STREET) out = out.replace(re, rep);
  return out || null;
}

const STATES: Record<string, string> = { PENNSYLVANIA: 'PA', 'NEW JERSEY': 'NJ', 'NEW YORK': 'NY', DELAWARE: 'DE', MARYLAND: 'MD' };

export function standardizeState(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = s.trim().toUpperCase().replace(/\./g, '');
  if (/^[A-Z]{2}$/.test(u)) return u;
  return STATES[u] ?? null;
}

export function standardizeZip(z: string | null | undefined): string | null {
  if (!z) return null;
  const d = z.replace(/[^\d]/g, '');
  if (d.length === 5) return d;
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  if (d.length === 4) return `0${d}`; // spreadsheet-eaten leading zero
  return null;
}

// Two-digit years: up to next year means 20xx, anything later 19xx ("98" is 1998).
export function fullYear(yy: number, now = new Date()): number {
  const pivot = (now.getUTCFullYear() + 1) % 100;
  return yy <= pivot ? 2000 + yy : 1900 + yy;
}

export function parseDate(v: string, fmt: Mapping['dateFormat']): string | null {
  const s = v.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us && fmt === 'MM/DD/YYYY') [m, d, y] = [Number(us[1]), Number(us[2]), us[3].length === 2 ? fullYear(Number(us[3])) : Number(us[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`);
}

function pick(row: Record<string, string>, names: string[] | undefined): string {
  for (const n of names ?? []) {
    const hit = Object.keys(row).find((k) => k.trim().toLowerCase() === n.trim().toLowerCase());
    if (hit && row[hit]?.trim()) return row[hit].trim();
  }
  return '';
}

export function planImport(
  rows: Record<string, string>[],
  mapping: Mapping,
  services: ServiceRef[],
  existing: { id: string; name: string; email: string | null; phone: string | null }[],
): ImportPlan {
  const truthy = new Set(mapping.truthy.map((t) => t.toLowerCase()));
  const yes = (v: string) => truthy.has(v.trim().toLowerCase());
  const byServiceName = new Map(services.map((s) => [s.name.toLowerCase(), s.id]));
  const byCode = new Map<string, string>();
  for (const s of services) for (const c of s.epicor_codes) byCode.set(c.toLowerCase(), s.id);
  for (const [code, name] of Object.entries(mapping.services)) {
    const id = byServiceName.get(name.toLowerCase());
    if (id) byCode.set(code.toLowerCase(), id);
  }

  const plan: ImportPlan = {
    customers: [], rejected: [], duplicates: [], unmappedServices: {}, warnings: [],
    totals: { rows: rows.length, customers: 0, vehicles: 0, history: 0, mapped_history: 0, email_opt_outs: 0, mail_opt_outs: 0 },
  };
  const customers = new Map<string, ImportCustomer>();

  rows.forEach((raw, i) => {
    const row = i + 2; // 1-based plus header line
    const get = (f: FieldName) => pick(raw, mapping.columns[f]);
    const name = get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ');
    if (!name) return plan.rejected.push({ row, reason: 'no customer name', data: raw });
    const emailRaw = get('email');
    const phoneRaw = get('phone');
    const email = normalizeEmail(emailRaw);
    const phone = normalizePhone(phoneRaw);
    if (emailRaw && !email) plan.warnings.push({ row, message: `invalid email "${emailRaw}" dropped` });
    if (phoneRaw && !phone) plan.warnings.push({ row, message: `invalid phone "${phoneRaw}" dropped` });
    const line1 = standardizeStreet(get('address1'));
    const city = get('city') ? get('city').trim().toUpperCase() : null;
    const state = standardizeState(get('state'));
    const zip = standardizeZip(get('zip'));
    if (get('zip') && !zip) plan.warnings.push({ row, message: `invalid ZIP "${get('zip')}" dropped` });
    if (!email && !phone && !(line1 && city && state && zip)) {
      return plan.rejected.push({ row, reason: 'no usable email, phone, or complete address', data: raw });
    }

    const epicorId = get('customer_id') || null;
    const key = epicorId ? `id:${epicorId}` : email ? `email:${email}` : phone ? `phone:${phone}` : `name:${name.toLowerCase()}|${line1}`;
    let c = customers.get(key);
    if (!c) {
      c = {
        key, epicor_id: epicorId, name: titleCase(name), email, phone,
        address_line1: line1, address_line2: standardizeStreet(get('address2')), city, state, postal_code: zip,
        email_opt_out: false, mail_opt_out: false, rows: [], vehicles: [], history: [],
      };
      customers.set(key, c);
    } else {
      c.email ??= email;
      c.phone ??= phone;
    }
    c.rows.push(row);
    // Opt-outs carry over: one "yes" on any row opts the customer out.
    if (yes(get('email_opt_out'))) c.email_opt_out = true;
    if (yes(get('mail_opt_out'))) c.mail_opt_out = true;

    const yearRaw = Number(get('vehicle_year')) || null;
    const year = yearRaw !== null && yearRaw < 100 ? fullYear(yearRaw) : yearRaw;
    const make = get('vehicle_make') ? titleCase(get('vehicle_make')) : null;
    const model = get('vehicle_model') || null;
    let vehicleKey: string | null = null;
    if (make || model) {
      vehicleKey = `${year ?? ''}|${(make ?? '').toLowerCase()}|${(model ?? '').toLowerCase()}`;
      if (!c.vehicles.some((v) => v.key === vehicleKey)) c.vehicles.push({ key: vehicleKey, year: year && year > 1950 && year < 2100 ? year : null, make, model });
    }

    const rawService = get('service_type');
    const dateRaw = get('service_date');
    if (rawService || dateRaw) {
      const date = parseDate(dateRaw, mapping.dateFormat);
      if (!date) {
        plan.warnings.push({ row, message: `service "${rawService}" skipped: bad date "${dateRaw}"` });
      } else {
        const serviceId = byCode.get(rawService.toLowerCase()) ?? byServiceName.get(rawService.toLowerCase()) ?? null;
        if (!serviceId && rawService) plan.unmappedServices[rawService] = (plan.unmappedServices[rawService] ?? 0) + 1;
        const mileage = Number(get('mileage').replace(/[^\d]/g, '')) || null;
        c.history.push({ vehicle_key: vehicleKey, service_id: serviceId, raw_service: rawService, service_date: date, mileage, row });
      }
    }
  });

  plan.customers = [...customers.values()];

  // Likely duplicates: same email or phone under different customer keys, or
  // matching a customer already in the database.
  const seen = new Map<string, ImportCustomer>();
  for (const c of plan.customers) {
    for (const [label, v] of [['email', c.email], ['phone', c.phone]] as const) {
      if (!v) continue;
      const other = seen.get(`${label}:${v}`);
      if (other && other !== c) plan.duplicates.push({ kind: 'in_file', customer: `${c.name} (rows ${c.rows.join(',')})`, other: `${other.name} (rows ${other.rows.join(',')})`, match: label });
      else seen.set(`${label}:${v}`, c);
    }
    // Same rule as arts.import_customer: email, or phone when the last names agree.
    const last = (n: string) => n.trim().toLowerCase().split(/\s+/).pop();
    const ex = existing.find((e) => (c.email && e.email?.toLowerCase() === c.email) || (c.phone && e.phone === c.phone && last(e.name) === last(c.name)));
    if (ex) plan.duplicates.push({ kind: 'existing', customer: `${c.name} (rows ${c.rows.join(',')})`, other: `${ex.name} [${ex.id}]`, match: ex.email?.toLowerCase() === c.email ? 'email' : 'phone' });
  }

  plan.totals.customers = plan.customers.length;
  plan.totals.vehicles = plan.customers.reduce((n, c) => n + c.vehicles.length, 0);
  plan.totals.history = plan.customers.reduce((n, c) => n + c.history.length, 0);
  plan.totals.mapped_history = plan.customers.reduce((n, c) => n + c.history.filter((h) => h.service_id).length, 0);
  plan.totals.email_opt_outs = plan.customers.filter((c) => c.email_opt_out).length;
  plan.totals.mail_opt_outs = plan.customers.filter((c) => c.mail_opt_out).length;
  return plan;
}

export function reportMarkdown(plan: ImportPlan, source: string): string {
  const t = plan.totals;
  const lines = [
    `# Epicor import dry run`,
    ``,
    `Source: \`${source}\``,
    ``,
    `| | |`,
    `|---|---|`,
    `| CSV rows | ${t.rows} |`,
    `| Customers to add | ${t.customers} |`,
    `| Vehicles to add | ${t.vehicles} |`,
    `| Service history rows | ${t.history} (${t.mapped_history} mapped to an appointment type) |`,
    `| Email opt-outs carried over | ${t.email_opt_outs} |`,
    `| Mail opt-outs carried over | ${t.mail_opt_outs} |`,
    `| Rows rejected | ${plan.rejected.length} |`,
    `| Likely duplicates | ${plan.duplicates.length} |`,
    ``,
    `## Rejected rows`,
    plan.rejected.length ? plan.rejected.map((r) => `- Row ${r.row}: ${r.reason}`).join('\n') : '_None._',
    ``,
    `## Already in the system (will be updated, not duplicated)`,
    plan.duplicates.some((d) => d.kind === 'existing')
      ? plan.duplicates.filter((d) => d.kind === 'existing').map((d) => `- Same ${d.match}: ${d.customer} → ${d.other}`).join('\n') : '_None._',
    ``,
    `## Likely duplicates within the file (review, then merge in admin after import)`,
    plan.duplicates.some((d) => d.kind === 'in_file')
      ? plan.duplicates.filter((d) => d.kind === 'in_file').map((d) => `- Same ${d.match}: ${d.customer} ↔ ${d.other}`).join('\n') : '_None._',
    ``,
    `## Epicor service types with no mapping (history kept, no reminders)`,
    Object.keys(plan.unmappedServices).length
      ? Object.entries(plan.unmappedServices).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- "${k}" × ${n}`).join('\n')
      : '_None._',
    ``,
    `## Warnings`,
    plan.warnings.length ? plan.warnings.map((w) => `- Row ${w.row}: ${w.message}`).join('\n') : '_None._',
    ``,
  ];
  return lines.join('\n');
}
