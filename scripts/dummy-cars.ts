// STAGING ONLY. Gives every customer who has no car one to three made-up cars,
// so the TRACS customer list (which has no vehicles) can be demoed and tested.
// Each car's notes say TEST DATA. The customer's imported last visit is linked
// to their first car with a made-up mileage (some low-mileage drivers on purpose).
//   APP_ENV=staging npx tsx scripts/dummy-cars.ts            add cars
//   APP_ENV=staging npx tsx scripts/dummy-cars.ts --remove   take them all out again
import { db } from '../server/db.js';

export const DUMMY_NOTE = 'TEST DATA: made-up car';

if (process.env.APP_ENV !== 'staging') {
  console.error('Refusing to run: set APP_ENV=staging. This writes made-up cars and must never touch production.');
  process.exit(1);
}

// Art's is a European import and domestic shop: weight the mix that way.
const CARS: [string, string[], number][] = [
  ['Volkswagen', ['Jetta', 'Passat', 'Golf', 'GTI', 'Tiguan', 'Atlas', 'Beetle'], 14],
  ['Audi', ['A4', 'A6', 'Q5', 'Q7', 'A3', 'Q3'], 10],
  ['BMW', ['328i', '330i', '528i', 'X3', 'X5', 'X1'], 10],
  ['Mercedes-Benz', ['C300', 'E350', 'GLC300', 'ML350', 'GLE350'], 9],
  ['Volvo', ['XC90', 'XC60', 'S60', 'V60', 'XC40'], 6],
  ['Mini', ['Cooper', 'Countryman', 'Clubman'], 3],
  ['Porsche', ['Cayenne', 'Macan', '911'], 2],
  ['Ford', ['F-150', 'Escape', 'Explorer', 'Fusion', 'Edge'], 9],
  ['Chevrolet', ['Silverado 1500', 'Equinox', 'Malibu', 'Traverse', 'Tahoe'], 7],
  ['Jeep', ['Grand Cherokee', 'Wrangler', 'Cherokee', 'Compass'], 6],
  ['Toyota', ['Camry', 'RAV4', 'Corolla', 'Highlander', 'Tacoma'], 8],
  ['Honda', ['Accord', 'CR-V', 'Civic', 'Pilot', 'Odyssey'], 8],
  ['Subaru', ['Outback', 'Forester', 'Crosstrek', 'Impreza'], 5],
  ['Ram', ['1500', '2500'], 3],
  ['Hyundai', ['Elantra', 'Santa Fe', 'Tucson'], 3],
  ['Nissan', ['Altima', 'Rogue', 'Pathfinder'], 3],
];

// Seeded so a re-run after --remove gives the same cars.
let seed = 20261127;
const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function weighted<T>(items: [T, number][]): T {
  let r = rand() * items.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[items.length - 1][0];
}

async function all<T>(make: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function inChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function remove() {
  const cars = await all<{ id: string }>(() => db().from('vehicles').select('id').eq('notes', DUMMY_NOTE).order('id'));
  await inChunks(cars.map((c) => c.id), 200, async (ids) => {
    const h = await db().from('service_history').update({ vehicle_id: null, mileage: null }).in('vehicle_id', ids).eq('source', 'import');
    if (h.error) throw h.error;
    const v = await db().from('vehicles').delete().in('id', ids);
    if (v.error) throw v.error;
  });
  console.log(`Removed ${cars.length} made-up cars.`);
}

async function add() {
  const customers = await all<{ id: string; name: string }>(() => db().from('customers').select('id, name').is('merged_into', null).order('id'));
  const owners = new Set((await all<{ customer_id: string }>(() => db().from('vehicles').select('customer_id').order('id'))).map((v) => v.customer_id));
  const bare = customers.filter((c) => !owners.has(c.id));
  const thisYear = new Date().getUTCFullYear();

  const rows: { customer_id: string; year: number; make: string; model: string; notes: string }[] = [];
  for (const c of bare) {
    const business = /\b(inc|llc|co|corp|company|church|ucc|fleet|services?|auto|sales)\b/i.test(c.name);
    const count = business ? int(2, 4) : weighted<number>([[1, 70], [2, 25], [3, 5]]);
    for (let i = 0; i < count; i++) {
      const [make, models] = weighted(CARS.map(([m, list, w]) => [[m, list] as const, w]));
      rows.push({ customer_id: c.id, year: int(thisYear - 18, thisYear - 1), make, model: models[int(0, models.length - 1)], notes: DUMMY_NOTE });
    }
  }
  const inserted: { id: string; customer_id: string; year: number }[] = [];
  await inChunks(rows, 500, async (chunk) => {
    const { data, error } = await db().from('vehicles').insert(chunk).select('id, customer_id, year');
    if (error) throw error;
    inserted.push(...data);
  });

  // Link each imported last visit to the customer's first made-up car, with a
  // mileage from the car's age. About 1 in 6 drive under 5,000 miles a year.
  const firstCar = new Map<string, { id: string; year: number }>();
  for (const v of inserted) if (!firstCar.has(v.customer_id)) firstCar.set(v.customer_id, v);
  const visits = await all<{ id: string; customer_id: string; service_date: string }>(() => db().from('service_history')
    .select('id, customer_id, service_date').eq('source', 'import').is('vehicle_id', null).order('id'));
  const linkable = visits.filter((h) => firstCar.has(h.customer_id));
  let low = 0;
  const updates = linkable.map((h) => {
    const car = firstCar.get(h.customer_id)!;
    const years = Math.max(0.5, Number(h.service_date.slice(0, 4)) - car.year + 0.5);
    const perYear = rand() < 0.17 ? int(1500, 5000) : int(7000, 16000);
    if (perYear <= 5000) low++;
    return { id: h.id, vehicle_id: car.id, mileage: Math.round((years * perYear) / 100) * 100 };
  });
  await pool(updates, 16, async (u) => {
    const { error } = await db().from('service_history').update({ vehicle_id: u.vehicle_id, mileage: u.mileage }).eq('id', u.id);
    if (error) throw error;
  });

  console.log(`${bare.length} customers had no car. Added ${inserted.length} made-up cars.`);
  console.log(`Linked ${updates.length} imported visits to a car with a made-up mileage (${low} low-mileage drivers).`);
}

await (process.argv.includes('--remove') ? remove() : add());
