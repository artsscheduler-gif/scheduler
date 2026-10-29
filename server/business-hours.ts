import type { ShopSettings } from './db.js';
import { DOW_KEYS, addDays, localParts, zonedTimeToUtc } from '../shared/time.js';

export interface Closure { start_date: string; end_date: string }

function hoursFor(date: string, settings: ShopSettings, closures: Closure[]): { open: number; close: number } | null {
  if (closures.some((c) => date >= c.start_date && date <= c.end_date)) return null;
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const h = settings.hours[DOW_KEYS[dow]];
  if (!h) return null;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return { open: toMin(h.open), close: toMin(h.close) };
}

function at(date: string, minutes: number, tz: string): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return zonedTimeToUtc(date, `${hh}:${mm}`, tz);
}

// Adds working minutes, counting only open shop hours.
export function addBusinessHours(start: Date, hours: number, settings: ShopSettings, closures: Closure[]): Date {
  let remaining = hours * 60;
  let { date, minutes } = localParts(start, settings.timezone);
  for (let i = 0; i < 400; i++) {
    const h = hoursFor(date, settings, closures);
    if (h) {
      const from = Math.max(minutes, h.open);
      if (from < h.close) {
        const avail = h.close - from;
        if (remaining <= avail) return at(date, from + remaining, settings.timezone);
        remaining -= avail;
      }
    }
    date = addDays(date, 1);
    minutes = 0;
  }
  return new Date(start.getTime() + hours * 3600_000);
}

// Same wall-clock time N open days later (clamped into open hours).
export function addBusinessDays(start: Date, days: number, settings: ShopSettings, closures: Closure[]): Date {
  let { date, minutes } = localParts(start, settings.timezone);
  let left = days;
  for (let i = 0; i < 400 && left > 0; i++) {
    date = addDays(date, 1);
    if (hoursFor(date, settings, closures)) left -= 1;
  }
  const h = hoursFor(date, settings, closures);
  if (!h) return new Date(start.getTime() + days * 86400_000);
  return at(date, Math.min(Math.max(minutes, h.open), h.close), settings.timezone);
}
