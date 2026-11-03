// The whole admin as one Excel file, and reading an edited copy back.
// Setup sheets (blue tabs) can be edited and uploaded; data sheets (grey tabs)
// are for reference and analysis only. Each editable row keeps a hidden-ish
// "id" column so an upload updates that row instead of adding a new one.
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { must } from './shared';
import { SECTIONS } from './Settings';
import { TECH_SETTINGS, type Role } from '../../shared/permissions';
import type { WorkbookPayload } from '../../server/workbook';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const EDITABLE = ['Services', 'Hours', 'Closures', 'Blocked time', 'Reminder steps', 'Settings'];

const yes = (b: unknown) => (b ? 'Yes' : 'No');

// Every row of a table, a page at a time (the API returns at most 1,000 per call).
async function all(table: string, select: string, order: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = (await must(supabase.from(table).select(select).order(order).range(from, from + 999))) as any[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

function sheet(rows: Record<string, unknown>[], headers: string[], widths: number[]) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: headers.length - 1 } }) };
  return ws;
}

export async function downloadWorkbook(role: Role, shopName: string) {
  const [s] = (await must(supabase.from('shop_settings').select('*').eq('id', 1))) as any[];
  const [services, closures, blocks, rules, customers, vehicles, history, bookings] = await Promise.all([
    all('services', '*', 'sort_order'),
    all('closures', '*', 'start_date'),
    all('time_blocks', '*', 'start_time'),
    all('reminder_rules', '*', 'step'),
    all('customers', 'id, name, email, phone, address_line1, address_line2, city, state, postal_code, email_opt_out, mail_opt_out, email_bounced, source, epicor_id, created_at', 'name'),
    all('vehicles', 'id, customer_id, year, make, model, notes, customers(name)', 'customer_id'),
    all('service_history', 'id, service_date, raw_service, mileage, source, customers(name), services(name), vehicles(year, make, model)', 'service_date'),
    all('bookings', 'id, date, kind, start_time, status, customer_notes, created_by_type, created_at, customers(name, phone, email), vehicles(year, make, model), booking_services(services(name))', 'date'),
  ]);
  const car = (v: any) => (v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '');
  const wb = XLSX.utils.book_new();

  const readme = [
    [`${shopName}: admin workbook`, ''],
    ['Exported', new Date().toLocaleString()],
    ['', ''],
    ['Sheets you can edit and upload back (Export tab → Upload changes):', ''],
    ...EDITABLE.map((n) => [`  ${n}`, '']),
    ['', ''],
    ['How to edit', ''],
    ['  • Change values in place. Add a row for something new (leave its id blank).', ''],
    ['  • Don’t change or copy the id column: it’s how each row is matched.', ''],
    ['  • Deleting a row removes that closure or blocked time; for a service or reminder step it turns it off.', ''],
    ['  • Yes/No columns take Yes or No. Times like 7:30 or 15:00. Dates like 2026-12-24.', ''],
    ['  • Leave a sheet out of the file to leave it unchanged.', ''],
    ['  • Uploading shows every change first; nothing is saved until you confirm.', ''],
    ['', ''],
    ['Reference only (changes to these are ignored): Customers, Vehicles, Service history, Bookings', ''],
  ];
  const rm = XLSX.utils.aoa_to_sheet(readme);
  rm['!cols'] = [{ wch: 90 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, rm, 'Read me');

  XLSX.utils.book_append_sheet(wb, sheet(services.map((x) => ({
    id: x.id, Name: x.name, 'What customers see': x.description, Minutes: x.duration_minutes, 'Customers can wait': yes(x.wait_eligible),
    'Most per day': x.daily_cap ?? '', 'Extra notice (days)': x.lead_days ?? '', 'Remind every (months)': x.reminder_interval_months ?? '',
    'Offered online': yes(x.active), Position: x.sort_order, 'Epicor codes': (x.epicor_codes ?? []).join(', '),
  })), ['id', 'Name', 'What customers see', 'Minutes', 'Customers can wait', 'Most per day', 'Extra notice (days)', 'Remind every (months)', 'Offered online', 'Position', 'Epicor codes'], [10, 22, 40, 9, 12, 12, 12, 14, 12, 9, 18]), 'Services');

  XLSX.utils.book_append_sheet(wb, sheet(DAY_KEYS.map((k, i) => ({
    Day: DAY_NAMES[i], Open: yes(s.hours?.[k]), Opens: s.hours?.[k]?.open ?? '', Closes: s.hours?.[k]?.close ?? '',
  })), ['Day', 'Open', 'Opens', 'Closes'], [14, 8, 10, 10]), 'Hours');

  XLSX.utils.book_append_sheet(wb, sheet(closures.map((x) => ({ id: x.id, 'First day': x.start_date, 'Last day': x.end_date, Reason: x.reason })),
    ['id', 'First day', 'Last day', 'Reason'], [10, 12, 12, 30]), 'Closures');

  XLSX.utils.book_append_sheet(wb, sheet(blocks.map((x) => ({
    id: x.id, Date: x.date ?? '', 'Every week on': x.weekday ? DAY_NAMES[x.weekday - 1] : '', From: String(x.start_time).slice(0, 5), To: String(x.end_time).slice(0, 5), Reason: x.reason,
  })), ['id', 'Date', 'Every week on', 'From', 'To', 'Reason'], [10, 12, 14, 8, 8, 30]), 'Blocked time');

  XLSX.utils.book_append_sheet(wb, sheet(rules.map((x) => ({
    id: x.id, Step: x.step, Channel: x.channel === 'postcard' ? 'Postcard' : 'Email', 'Days from due (negative = before)': x.offset_days,
    'Only if': x.condition === 'no_booking_since_due' ? 'No booking since due' : 'No booking since previous step', Active: yes(x.active),
  })), ['id', 'Step', 'Channel', 'Days from due (negative = before)', 'Only if', 'Active'], [10, 6, 10, 18, 30, 8]), 'Reminder steps');

  const settingRows = SECTIONS.flatMap((sec) => sec.fields
    .filter((f) => role === 'developer' || !TECH_SETTINGS.has(f.k))
    .map((f) => ({
      Setting: f.k, Section: sec.title, Description: f.label,
      Value: f.t === 'bool' ? yes(s[f.k]) : f.t === 'time' ? String(s[f.k] ?? '').slice(0, 5) : s[f.k] ?? '',
    })));
  XLSX.utils.book_append_sheet(wb, sheet(settingRows, ['Setting', 'Section', 'Description', 'Value'], [26, 22, 50, 34]), 'Settings');

  XLSX.utils.book_append_sheet(wb, sheet(customers.map((c) => ({
    Name: c.name, Email: c.email ?? '', Phone: c.phone ?? '', Address: c.address_line1 ?? '', 'Address 2': c.address_line2 ?? '', City: c.city ?? '',
    State: c.state ?? '', ZIP: c.postal_code ?? '', 'Email opt-out': yes(c.email_opt_out), 'Mail opt-out': yes(c.mail_opt_out), 'Email bounced': yes(c.email_bounced),
    Source: c.source, 'Epicor #': c.epicor_id ?? '', Added: String(c.created_at).slice(0, 10),
  })), ['Name', 'Email', 'Phone', 'Address', 'Address 2', 'City', 'State', 'ZIP', 'Email opt-out', 'Mail opt-out', 'Email bounced', 'Source', 'Epicor #', 'Added'], [24, 28, 14, 26, 10, 14, 6, 8, 10, 10, 10, 9, 10, 11]), 'Customers');

  XLSX.utils.book_append_sheet(wb, sheet(vehicles.map((v) => ({ Customer: v.customers?.name ?? '', Year: v.year ?? '', Make: v.make ?? '', Model: v.model ?? '', 'Plate / notes': v.notes })),
    ['Customer', 'Year', 'Make', 'Model', 'Plate / notes'], [24, 6, 14, 18, 24]), 'Vehicles');

  XLSX.utils.book_append_sheet(wb, sheet(history.map((h) => ({
    Date: h.service_date, Customer: h.customers?.name ?? '', Service: h.services?.name ?? h.raw_service ?? '', Vehicle: car(h.vehicles), Mileage: h.mileage ?? '', Source: h.source,
  })), ['Date', 'Customer', 'Service', 'Vehicle', 'Mileage', 'Source'], [11, 24, 22, 24, 9, 9]), 'Service history');

  XLSX.utils.book_append_sheet(wb, sheet(bookings.map((b) => ({
    Date: b.date, Time: b.start_time ? String(b.start_time).slice(0, 5) : '', Type: b.kind === 'wait' ? 'Wait' : 'Drop-off', Status: b.status,
    Customer: b.customers?.name ?? '', Phone: b.customers?.phone ?? '', Email: b.customers?.email ?? '', Vehicle: car(b.vehicles),
    Services: (b.booking_services ?? []).map((x: any) => x.services?.name).join(', '), Notes: b.customer_notes, 'Booked by': b.created_by_type, 'Booked on': String(b.created_at).slice(0, 10),
  })), ['Date', 'Time', 'Type', 'Status', 'Customer', 'Phone', 'Email', 'Vehicle', 'Services', 'Notes', 'Booked by', 'Booked on'], [11, 6, 9, 10, 22, 14, 26, 22, 26, 30, 10, 11]), 'Bookings');

  // Blue tabs: editable. Grey: reference.
  wb.Workbook = { Sheets: wb.SheetNames.map((n) => ({ name: n, Hidden: 0 })) } as any;
  for (const n of wb.SheetNames) (wb.Sheets[n] as any)['!tabcolor'] = { rgb: EDITABLE.includes(n) ? '2B3990' : 'A0A0A0' };

  XLSX.writeFile(wb, `${shopName.replace(/[^A-Za-z0-9]+/g, '-')}-admin-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
}

// ---- Reading an edited workbook ------------------------------------------------

function cellDate(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v).trim();
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : s;
}

function cellTime(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v instanceof Date) return `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`;
  if (typeof v === 'number' && v < 1) { const m = Math.round(v * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  const m = String(v).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return String(v);
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
}

const cellBool = (v: unknown) => (typeof v === 'boolean' ? v : /^(y|yes|true|1|x)$/i.test(String(v ?? '').trim()));
const cellInt = (v: unknown) => (v === '' || v === undefined || v === null ? null : Number(v));
const cellText = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

function rows(wb: XLSX.WorkBook, name: string): (Record<string, unknown> & { _row: number })[] | undefined {
  const ws = wb.Sheets[name];
  if (!ws) return undefined;
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true })
    .map((r, i) => ({ ...r, _row: i + 2 }))
    .filter((r) => Object.entries(r).some(([k, v]) => k !== '_row' && k !== 'id' && cellText(v) !== ''));
}

// Turns an uploaded workbook into the setup changes the server checks and applies.
export async function readWorkbook(file: File): Promise<WorkbookPayload> {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const out: WorkbookPayload = {};
  const svc = rows(wb, 'Services');
  if (svc) out.services = svc.map((r) => ({
    _row: r._row, id: cellText(r.id) || null, name: cellText(r.Name), description: cellText(r['What customers see']),
    duration_minutes: cellInt(r.Minutes), wait_eligible: cellBool(r['Customers can wait']), daily_cap: cellInt(r['Most per day']),
    lead_days: cellInt(r['Extra notice (days)']), reminder_interval_months: cellInt(r['Remind every (months)']),
    active: cellBool(r['Offered online']), sort_order: cellInt(r.Position) ?? 0,
    epicor_codes: cellText(r['Epicor codes']).split(',').map((x) => x.trim()).filter(Boolean),
  }));
  const hours = rows(wb, 'Hours');
  if (hours) {
    out.hours = {};
    for (const r of hours) {
      const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === cellText(r.Day).toLowerCase());
      if (i < 0) continue;
      out.hours[DAY_KEYS[i]] = cellBool(r.Open) ? { open: cellTime(r.Opens) ?? '', close: cellTime(r.Closes) ?? '' } : null;
    }
  }
  const cl = rows(wb, 'Closures');
  if (cl) out.closures = cl.map((r) => ({ _row: r._row, id: cellText(r.id) || null, start_date: cellDate(r['First day']), end_date: cellDate(r['Last day']), reason: cellText(r.Reason) }));
  const bl = rows(wb, 'Blocked time');
  if (bl) out.blocks = bl.map((r) => {
    const wd = DAY_NAMES.findIndex((d) => d.toLowerCase() === cellText(r['Every week on']).toLowerCase());
    return { _row: r._row, id: cellText(r.id) || null, date: wd >= 0 ? undefined : cellDate(r.Date), weekday: wd >= 0 ? wd + 1 : undefined, start_time: cellTime(r.From), end_time: cellTime(r.To), reason: cellText(r.Reason) };
  });
  const rl = rows(wb, 'Reminder steps');
  if (rl) out.rules = rl.map((r) => ({
    _row: r._row, id: cellText(r.id) || null, step: cellInt(r.Step), channel: cellText(r.Channel).toLowerCase(),
    offset_days: cellInt(r['Days from due (negative = before)']),
    condition: /previous/i.test(cellText(r['Only if'])) ? 'no_booking_since_previous_step' : 'no_booking_since_due', active: cellBool(r.Active),
  }));
  const st = rows(wb, 'Settings');
  if (st) {
    const types = new Map(SECTIONS.flatMap((s) => s.fields).map((f) => [f.k, f.t]));
    out.settings = {};
    for (const r of st) {
      const k = cellText(r.Setting);
      const t = types.get(k);
      if (!t) continue;
      out.settings[k] = t === 'bool' ? cellBool(r.Value) : t === 'int' ? cellInt(r.Value) : t === 'time' ? cellTime(r.Value) : cellText(r.Value);
    }
  }
  return out;
}
