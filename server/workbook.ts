// Upload of the edited Excel workbook (setup sheets only). The browser reads
// the file and sends its rows; here they're validated with the same checks
// as the admin screens and compared with what's saved. `apply: false` returns
// the list of changes (a preview); `apply: true` saves them, through the same
// handlers the screens use, so every change is audited.
// A sheet left out of the upload is left alone. Removing a service or a
// reminder step from its sheet turns it off rather than deleting it.
import { db } from './db.js';
import { HttpError, type Result } from './http.js';
import * as V from './validate.js';
import {
  checkBlock, checkClosure, checkRule, checkService, checkSettings, closure, reminderRule, settingType, timeBlock,
  updateSettings, upsertService, type Admin,
} from './admin.js';
import { TECH_SETTINGS } from '../shared/permissions.js';

type Row = Record<string, unknown> & { _row?: number; id?: string | null };
export interface WorkbookPayload {
  services?: Row[];
  hours?: Record<string, { open: string; close: string } | null>;
  closures?: Row[];
  blocks?: Row[];
  rules?: Row[];
  settings?: Record<string, unknown>;
}
interface Change { sheet: string; action: 'add' | 'update' | 'remove' | 'turn off'; label: string; detail: string; run: () => Promise<unknown> }
interface Problem { sheet: string; row?: number; message: string }

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(blank)' : Array.isArray(v) ? v.join(', ') || '(blank)' : String(v));
const t5 = (v: unknown) => (typeof v === 'string' ? v.slice(0, 5) : v);

function diffText(before: Record<string, unknown>, after: Record<string, unknown>, labels: Record<string, string>) {
  return Object.keys(after).filter((k) => !same(t5(before[k]), t5(after[k]))).map((k) => `${labels[k] ?? k}: ${show(t5(before[k]))} → ${show(t5(after[k]))}`).join('; ');
}

function problem(problems: Problem[], sheet: string, row: number | undefined, e: unknown) {
  const msg = e instanceof V.ValidationError ? `${e.field}: ${e.message}` : e instanceof HttpError ? String(e.body.error) : (e as Error).message;
  problems.push({ sheet, row, message: msg });
}

const SERVICE_LABELS = { name: 'Name', description: 'What customers see', duration_minutes: 'Minutes', wait_eligible: 'Can wait', daily_cap: 'Most per day', lead_days: 'Extra notice', reminder_interval_months: 'Remind every', sort_order: 'Position', active: 'Offered online', epicor_codes: 'Epicor codes' };

export async function workbookApply(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['payload', 'apply']);
  const p = (b.payload ?? {}) as WorkbookPayload;
  const changes: Change[] = [];
  const problems: Problem[] = [];

  // Services
  if (Array.isArray(p.services)) {
    const { data: current } = await db().from('services').select('*');
    const seen = new Set<string>();
    for (const r of p.services) {
      try {
        const { row } = checkService(fields(r));
        const id = r.id ? String(r.id) : null;
        const cur = id ? current?.find((s) => s.id === id) : null;
        if (id && !cur) throw new Error('id not found (don’t edit the id column)');
        if (id) seen.add(id);
        if (!cur) changes.push({ sheet: 'Services', action: 'add', label: String(row.name), detail: `${row.duration_minutes} min`, run: () => upsertService(a, { ...row }) });
        else {
          const d = diffText(cur, row, SERVICE_LABELS);
          if (d) changes.push({ sheet: 'Services', action: 'update', label: String(row.name), detail: d, run: () => upsertService(a, { ...row, id }) });
        }
      } catch (e) {
        problem(problems, 'Services', r._row, e);
      }
    }
    for (const s of current ?? []) {
      if (!seen.has(s.id) && s.active) {
        changes.push({ sheet: 'Services', action: 'turn off', label: s.name, detail: 'Row removed from the sheet: no longer offered online (history kept)', run: () => upsertService(a, { ...pickService(s), active: false }) });
      }
    }
  }

  // Closures and blocked time: removed rows are deleted.
  for (const [sheet, rows, table, check, save] of [
    ['Closures', p.closures, 'closures', checkClosure, closure],
    ['Blocked time', p.blocks, 'time_blocks', checkBlock, timeBlock],
  ] as const) {
    if (!Array.isArray(rows)) continue;
    const { data: current } = await db().from(table).select('*');
    const seen = new Set<string>();
    for (const r of rows) {
      try {
        const row = (check as (x: unknown) => Record<string, unknown>)(fields(r));
        const id = r.id ? String(r.id) : null;
        const cur = id ? current?.find((x) => x.id === id) : null;
        if (id && !cur) throw new Error('id not found (don’t edit the id column)');
        if (id) seen.add(id);
        const label = describe(sheet, row);
        if (!cur) changes.push({ sheet, action: 'add', label, detail: '', run: () => save(a, row) });
        else {
          const d = diffText(cur, row, {});
          if (d) changes.push({ sheet, action: 'update', label, detail: d, run: () => save(a, { ...row, id }) });
        }
      } catch (e) {
        problem(problems, sheet, r._row, e);
      }
    }
    for (const x of current ?? []) {
      if (!seen.has(x.id) && (sheet !== 'Closures' || x.end_date >= new Date().toISOString().slice(0, 10))) {
        changes.push({ sheet, action: 'remove', label: describe(sheet, x), detail: 'Row removed from the sheet', run: () => save(a, { id: x.id, delete: true }) });
      }
    }
  }

  // Reminder steps: removed rows are turned off.
  if (Array.isArray(p.rules)) {
    const { data: current } = await db().from('reminder_rules').select('*');
    const seen = new Set<string>();
    for (const r of p.rules) {
      try {
        const row = checkRule(fields(r));
        const id = r.id ? String(r.id) : null;
        const cur = id ? current?.find((x) => x.id === id) : null;
        if (id && !cur) throw new Error('id not found (don’t edit the id column)');
        if (id) seen.add(id);
        const label = `Step ${row.step} (${row.channel})`;
        if (!cur) changes.push({ sheet: 'Reminder steps', action: 'add', label, detail: `${row.offset_days} days from due`, run: () => reminderRule(a, row) });
        else {
          const d = diffText(cur, row, { offset_days: 'Days from due', active: 'Active' });
          if (d) changes.push({ sheet: 'Reminder steps', action: 'update', label, detail: d, run: () => reminderRule(a, { ...row, id }) });
        }
      } catch (e) {
        problem(problems, 'Reminder steps', r._row, e);
      }
    }
    for (const x of current ?? []) {
      if (!seen.has(x.id) && x.active) changes.push({ sheet: 'Reminder steps', action: 'turn off', label: `Step ${x.step} (${x.channel})`, detail: 'Row removed from the sheet', run: () => reminderRule(a, { id: x.id, delete: true }) });
    }
  }

  // Settings and hours: one combined change, checked together.
  const patch: Record<string, unknown> = {};
  if (p.settings && typeof p.settings === 'object') {
    for (const [k, v] of Object.entries(p.settings)) {
      const type = settingType(k);
      if (!type || type === 'hours' || type === 'html') continue;
      if (TECH_SETTINGS.has(k) && a.role !== 'developer') continue; // not in an owner's workbook; ignore if added
      patch[k] = v;
    }
  }
  if (p.hours && typeof p.hours === 'object') {
    // A day missing from the sheet keeps its saved hours.
    const { data: cur } = await db().from('shop_settings').select('hours').eq('id', 1).single();
    const saved = (cur?.hours ?? {}) as Record<string, unknown>;
    patch.hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, d in p.hours! ? p.hours![d] : saved[d] ?? null]));
  }
  if (Object.keys(patch).length) {
    try {
      const { patch: clean, before } = await checkSettings(a, patch);
      // Hours compare day by day (stored key order differs from the sheet's).
      const changed = Object.fromEntries(Object.entries(clean).filter(([k, v]) => (k === 'hours' ? hoursDiff(before[k], v) !== '' : !same(t5(v), t5(before[k])))));
      for (const k of Object.keys(changed)) {
        changes.push({ sheet: k === 'hours' ? 'Hours' : 'Settings', action: 'update', label: k === 'hours' ? 'Opening hours' : k, detail: k === 'hours' ? hoursDiff(before.hours, changed.hours) : `${show(t5(before[k]))} → ${show(t5(changed[k]))}`, run: async () => undefined });
      }
      if (Object.keys(changed).length) changes.push({ sheet: 'Settings', action: 'update', label: '', detail: '', run: () => updateSettings(a, changed) });
    } catch (e) {
      problem(problems, 'Settings', undefined, e);
    }
  }

  const visible = changes.filter((c) => c.label);
  if (!b.apply || problems.length) {
    return { status: 200, body: { applied: false, changes: visible.map(({ run: _, ...c }) => c), problems } };
  }
  for (const c of changes) await c.run();
  return { status: 200, body: { applied: true, changes: visible.map(({ run: _, ...c }) => c), problems: [] } };
}

// The row's own fields: without the sheet row number and the id column.
function fields(r: Row) {
  const { _row: _r, id: _id, ...rest } = r;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}

function pickService(s: Record<string, any>) {
  const { name, description, duration_minutes, wait_eligible, daily_cap, lead_days, reminder_interval_months, sort_order, active, epicor_codes, id } = s;
  return { id, name, description, duration_minutes, wait_eligible, daily_cap, lead_days, reminder_interval_months, sort_order, active, epicor_codes };
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function describe(sheet: string, r: Record<string, any>) {
  if (sheet === 'Closures') return `${r.start_date}${r.end_date && r.end_date !== r.start_date ? ` to ${r.end_date}` : ''}${r.reason ? ` (${r.reason})` : ''}`;
  return `${r.weekday ? `Every ${DAYS[r.weekday]}` : r.date} ${t5(r.start_time)}–${t5(r.end_time)}${r.reason ? ` (${r.reason})` : ''}`;
}

function hoursDiff(before: any, after: any) {
  const out: string[] = [];
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const f = (h: any) => (h ? `${h.open}–${h.close}` : 'closed');
    if (f(before?.[d]) !== f(after?.[d])) out.push(`${d}: ${f(before?.[d])} → ${f(after?.[d])}`);
  }
  return out.join('; ');
}
