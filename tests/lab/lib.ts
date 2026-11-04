// Shared pieces for the test lab: a seeded random source (so any run can be
// replayed with LAB_SEED), the simulated clock, and fake people and cars.
import { vi } from 'vitest';
import { zonedTimeToUtc, addDays, localParts } from '../../shared/time';

export const TZ = 'America/New_York';

// ---- Seeded randomness --------------------------------------------------------

export class Rng {
  private s: number;
  constructor(public readonly seed: number) {
    this.s = seed >>> 0 || 1;
  }
  // mulberry32
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  weighted<T>(xs: readonly [T, number][]): T {
    const total = xs.reduce((n, [, w]) => n + w, 0);
    let r = this.next() * total;
    for (const [x, w] of xs) if ((r -= w) < 0) return x;
    return xs[xs.length - 1][0];
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }
}

export function labSeed(): number {
  return process.env.LAB_SEED ? Number(process.env.LAB_SEED) : Math.floor(Math.random() * 1e9);
}

// ---- Simulated clock ----------------------------------------------------------
// Only Date is faked: timers and network calls run normally. Database
// functions get the same instant through their p_now argument.

export class Clock {
  now = new Date();
  start() {
    vi.useFakeTimers({ toFake: ['Date'] });
  }
  stop() {
    vi.useRealTimers();
  }
  // Wall-clock time at the shop.
  set(date: string, time: string) {
    this.now = zonedTimeToUtc(date, time, TZ);
    vi.setSystemTime(this.now);
    return this.now;
  }
  get date() {
    return localParts(this.now, TZ).date;
  }
}

export function isoDow(date: string) {
  return ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

export function nextMonday(from: string) {
  let d = addDays(from, 1);
  while (isoDow(d) !== 1) d = addDays(d, 1);
  return d;
}

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ---- Fake people --------------------------------------------------------------

export const FIRST = ['Robert', 'Mary', 'James', 'Linda', 'Michael', 'Patricia', 'William', 'Barbara', 'David', 'Susan', 'Joseph', 'Karen',
  'Thomas', 'Nancy', 'Daniel', 'Lisa', 'Anthony', 'Donna', 'Mark', 'Sandra', 'José', 'Zoë', 'Siobhan', 'Nguyen', 'Mary Ann', 'D’Andre'];
export const NICK: Record<string, string> = { Robert: 'Bob', James: 'Jim', Michael: 'Mike', William: 'Bill', Joseph: 'Joe', Thomas: 'Tom', Daniel: 'Dan', Anthony: 'Tony', Patricia: 'Pat', Susan: 'Sue' };
export const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia', 'Rodriguez', 'Wilson', 'Martinez', 'Anderson',
  'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Kowalski', 'Schaeffer', 'O’Brien', "O'Neill", 'Van der Berg', 'Müller', 'Nguyen', 'De La Cruz'];
export const STREETS = ['Tilghman St', 'Hamilton Blvd', 'Cedar Crest Blvd', 'Main St', 'Walnut St', 'Union Blvd', 'Chew St', 'Liberty St', 'Mill Creek Rd'];
export const TOWNS: [string, string][] = [['Allentown', '18104'], ['Allentown', '18106'], ['Trexlertown', '18087'], ['Breinigsville', '18031'], ['Emmaus', '18049'], ['Fogelsville', '18051']];

// Online spelling -> how it's typed into TRACS.
export const CARS: { make: string; tracs: string; online: string[]; models: string[] }[] = [
  { make: 'Chevrolet', tracs: 'CHEVROLET', online: ['Chevrolet', 'Chevy', 'chevy'], models: ['Malibu', 'Equinox', 'Silverado 1500', 'Impala'] },
  { make: 'Ford', tracs: 'FORD', online: ['Ford', 'ford'], models: ['F-150', 'Escape', 'Focus', 'Explorer'] },
  { make: 'Toyota', tracs: 'TOYOTA', online: ['Toyota'], models: ['Camry', 'Corolla', 'RAV4', 'Tacoma'] },
  { make: 'Honda', tracs: 'HONDA', online: ['Honda', 'honda'], models: ['Civic', 'Accord', 'CR-V', 'Odyssey'] },
  { make: 'Volkswagen', tracs: 'VOLKSWAGEN', online: ['Volkswagen', 'VW'], models: ['Jetta', 'Passat', 'Tiguan'] },
  { make: 'Subaru', tracs: 'SUBARU', online: ['Subaru'], models: ['Outback', 'Forester', 'Crosstrek'] },
  { make: 'Jeep', tracs: 'JEEP', online: ['Jeep'], models: ['Wrangler', 'Grand Cherokee', 'Cherokee'] },
];

export interface Car { make: string; tracsMake: string; onlineMake: string; model: string; year: number }

export function makeCar(r: Rng): Car {
  const c = r.pick(CARS);
  return { make: c.make, tracsMake: c.tracs, onlineMake: r.pick(c.online), model: r.pick(c.models), year: r.int(2004, 2026) };
}

export function makePhone(r: Rng) {
  return `+1610${r.int(2000000, 9999999)}`;
}
