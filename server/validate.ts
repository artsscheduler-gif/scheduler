import { normalizeEmail, normalizePhone } from '../shared/phone.js';

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Obj = Record<string, unknown>;

export function obj(v: unknown, allowed: string[], field = 'body'): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(field, 'must be an object');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new ValidationError(`${field}.${k}`, 'unexpected field');
  return v as Obj;
}

export function str(v: unknown, field: string, opts: { min?: number; max: number; optional?: boolean }): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new ValidationError(field, 'is required');
  }
  if (typeof v !== 'string') throw new ValidationError(field, 'must be text');
  const s = v.trim();
  if (s.length < (opts.min ?? (opts.optional ? 0 : 1))) throw new ValidationError(field, 'is too short');
  if (s.length > opts.max) throw new ValidationError(field, `must be ${opts.max} characters or fewer`);
  // Control characters other than newlines/tabs are never legitimate here.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new ValidationError(field, 'contains invalid characters');
  return s;
}

export function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ValidationError(field, 'must be an id');
  return v.toLowerCase();
}

export function uuids(v: unknown, field: string, min = 1, max = 8): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new ValidationError(field, `must list ${min}–${max} items`);
  const out = v.map((x, i) => uuid(x, `${field}[${i}]`));
  return [...new Set(out)];
}

export function date(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new ValidationError(field, 'must be a date');
  return v;
}

export function time(v: unknown, field: string): string {
  if (typeof v !== 'string' || !TIME.test(v.slice(0, 5)) || v.length > 8) throw new ValidationError(field, 'must be a time');
  return v.slice(0, 5);
}

export function kind(v: unknown, field = 'kind'): 'wait' | 'dropoff' {
  if (v !== 'wait' && v !== 'dropoff') throw new ValidationError(field, 'must be wait or dropoff');
  return v;
}

export function int(v: unknown, field: string, min: number, max: number, optional = false): number | null {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new ValidationError(field, `must be a whole number ${min}–${max}`);
  return n;
}

export function email(v: unknown, field = 'email'): string {
  const e = normalizeEmail(typeof v === 'string' ? v : null);
  if (!e) throw new ValidationError(field, 'must be a valid email');
  return e;
}

export function phone(v: unknown, field = 'phone'): string {
  const p = normalizePhone(typeof v === 'string' ? v : null);
  if (!p) throw new ValidationError(field, 'must be a valid phone number');
  return p;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(field, 'must be true or false');
  return v;
}

export interface SlotInput { date: string; kind: 'wait' | 'dropoff'; start_time: string | null }

// Waiters always have a start time. Customers pick a drop-off time too; staff
// may leave it blank.
export function slot(b: Obj, timeRequired = false): SlotInput {
  const k = kind(b.kind);
  const timed = k === 'wait' || timeRequired || (b.start_time !== null && b.start_time !== undefined && b.start_time !== '');
  return { date: date(b.date, 'date'), kind: k, start_time: timed ? time(b.start_time, 'start_time') : null };
}

export interface PublicBookingInput extends SlotInput {
  service_ids: string[];
  customer_notes: string;
  name: string;
  email: string;
  phone: string;
  vehicle: { year: number | null; make: string; model: string; notes: string };
  turnstile: string;
  source: string | null;
}

export function publicBooking(body: unknown, notesMax: number): PublicBookingInput {
  const b = obj(body, ['service_ids', 'customer_notes', 'date', 'kind', 'start_time', 'name', 'email', 'phone', 'vehicle', 'turnstile', 'source']);
  const v = obj(b.vehicle, ['year', 'make', 'model', 'notes'], 'vehicle');
  return {
    ...slot(b, true),
    service_ids: uuids(b.service_ids, 'service_ids'),
    customer_notes: str(b.customer_notes, 'customer_notes', { max: notesMax, optional: true }),
    name: str(b.name, 'name', { max: 100 }),
    email: email(b.email),
    phone: phone(b.phone),
    vehicle: {
      year: int(v.year, 'vehicle.year', 1950, new Date().getFullYear() + 2, true),
      make: str(v.make, 'vehicle.make', { max: 40 }),
      model: str(v.model, 'vehicle.model', { max: 60 }),
      notes: str(v.notes, 'vehicle.notes', { max: 200, optional: true }),
    },
    turnstile: str(b.turnstile, 'turnstile', { max: 2048 }),
    source: typeof b.source === 'string' && /^[a-z0-9_-]{1,40}$/.test(b.source) ? b.source : null,
  };
}
