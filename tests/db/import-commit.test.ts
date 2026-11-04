// Committing an Epicor import: re-runs don't duplicate, newer exports add only
// what's new, existing customers are filled in, families sharing a phone stay apart.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql, resetData } from './helpers';
import { csvObjects } from '../../shared/csv';
import { planImport, fullYear, type Mapping } from '../../server/import';
import { loadImportContext, commitImport } from '../../server/import-db';
import { adminAction } from '../../server/admin';
import { adminToken, reqWith } from './helpers';

afterAll(() => sql.end());

const mapping = JSON.parse(readFileSync('import/epicor-mapping.json', 'utf8')) as Mapping;
const HEADER = 'Customer ID,Customer Name,Email,Phone,Address,City,State,Zip,Year,Make,Model,Last Service Date,Last Service Type,Mileage,Email Opt Out,Mail Opt Out';

async function run(csv: string) {
  const ctx = await loadImportContext();
  return commitImport(planImport(csvObjects(csv), mapping, ctx.services, ctx.existing), 'test');
}

const counts = async () => (await sql`select (select count(*)::int from arts.customers) c, (select count(*)::int from arts.vehicles) v, (select count(*)::int from arts.service_history) h`)[0];

beforeEach(resetData);

describe('Epicor import commit', () => {
  it('importing the same file twice adds nothing the second time', async () => {
    const csv = readFileSync('tests/fixtures/epicor-sample.csv', 'utf8');
    const first = await run(csv);
    expect(first.failed).toEqual([]);
    const after1 = await counts();
    const second = await run(csv);
    expect(second.created).toBe(0);
    expect(second.history).toBe(0);
    expect(await counts()).toEqual(after1);
  });

  it('a newer export adds only the new service records', async () => {
    await run(`${HEADER}\n2001,Pat Doe,pat@example.com,6105550111,1 Main St,Easton,PA,18042,2015,Honda,Fit,03/01/2026,LOF,1000,,\n`);
    const r = await run(`${HEADER}\n2001,Pat Doe,pat@example.com,6105550111,1 Main St,Easton,PA,18042,2015,Honda,Fit,03/01/2026,LOF,1000,,\n2001,Pat Doe,pat@example.com,6105550111,1 Main St,Easton,PA,18042,2015,Honda,Fit,09/01/2026,LOF,5000,,\n`);
    expect(r).toMatchObject({ created: 0, updated: 1, vehicles: 0, history: 1 });
    expect(await counts()).toEqual({ c: 1, v: 1, h: 2 });
  });

  it('fills in a customer who booked online instead of duplicating them', async () => {
    const [c] = await sql`insert into arts.customers (name, email, phone, source) values ('Pat Doe', 'pat@example.com', null, 'booking') returning id`;
    const r = await run(`${HEADER}\n2001,Pat Doe,PAT@example.com,6105550111,1 Main St,Easton,PA,18042,2015,Honda,Fit,03/01/2026,LOF,,Y,\n`);
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const [row] = await sql`select phone, epicor_id, address_line1, email_opt_out, source from arts.customers where id = ${c.id}`;
    expect(row).toMatchObject({ phone: '+16105550111', epicor_id: '2001', address_line1: '1 MAIN ST', email_opt_out: true, source: 'booking' });
  });

  it('family members sharing a phone stay separate customers', async () => {
    await sql`insert into arts.customers (name, phone, source) values ('Pat Doe', '+16105550111', 'booking')`;
    const r = await run(`${HEADER}\n2002,Sam Smith,,6105550111,2 Oak St,Easton,PA,18042,2010,Ford,F-150,03/01/2026,LOF,,,\n`);
    expect(r.created).toBe(1);
    // Same last name on that phone but a different first name: a spouse, not the same person.
    const r2 = await run(`${HEADER}\n2003,Chris Doe,,6105550111,1 Main St,Easton,PA,18042,2012,Ford,Focus,03/01/2026,LOF,,,\n`);
    expect(r2.created).toBe(1);
    // Same first name (or a nickname of it) on that phone: the same customer.
    const r3 = await run(`${HEADER}\n2004,Patricia Doe,,6105550111,1 Main St,Easton,PA,18042,2015,Honda,Fit,03/01/2026,LOF,,,\n`);
    expect(r3.updated).toBe(1);
  });

  it('two-digit years mean 19xx when they are in the future', async () => {
    expect(fullYear(98, new Date('2026-06-01'))).toBe(1998);
    expect(fullYear(26, new Date('2026-06-01'))).toBe(2026);
    expect(fullYear(27, new Date('2026-06-01'))).toBe(2027);
    await run(`${HEADER}\n2004,Old Car,old@example.com,,,,,,98,Volvo,240,03/15/98,LOF,,,\n`);
    const [v] = await sql`select year from arts.vehicles`;
    const [h] = await sql`select service_date::text from arts.service_history`;
    expect(v.year).toBe(1998);
    expect(h.service_date).toBe('1998-03-15');
  });

  it('after a monthly import, an online customer is matched to the TRACS record the tech made', async () => {
    // Booked online with a cell number; the tech typed the home number into TRACS.
    const [app] = await sql`insert into arts.customers (name, phone, source) values ('Pat Doe', '+16105550111', 'booking') returning id`;
    await sql`insert into arts.vehicles (customer_id, year, make, model) values (${app.id}, 2015, 'Honda', 'Fit')`;
    await run(`${HEADER}\n3001,Patricia Doe,,6105559999,1 Main St,Easton,PA,18042,2015,Honda,Fit,03/01/2026,LOF,,,\n`);
    const dev = (await adminToken('developer')).token;
    const call = (action: string, body: unknown) => adminAction(reqWith(dev), action, body);
    const { pairs } = (await call('matches', {})).body as any;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ app_id: app.id, reasons: ['same car', 'similar first name'], tracs: { epicor_id: '3001' } });
    // Merge keeps the TRACS record.
    await call('merge', { keep_id: pairs[0].tracs_id, merge_id: app.id });
    expect(((await call('matches', {})).body as any).pairs).toEqual([]);
    const [kept] = await sql`select epicor_id from arts.customers where id = ${pairs[0].tracs_id}`;
    expect(kept.epicor_id).toBe('3001');
  });

  it('the same name alone is not suggested as a match', async () => {
    await sql`insert into arts.customers (name, email, source) values ('Sam Lee', 'sam@example.com', 'booking')`;
    await run(`${HEADER}\n3002,Sam Lee,,6105558888,9 Elm St,Easton,PA,18042,2010,Ford,F-150,03/01/2026,LOF,,,\n`);
    const dev = (await adminToken('developer')).token;
    expect(((await adminAction(reqWith(dev), 'matches', {})).body as any).pairs).toEqual([]);
  });

  it('cars match across spellings, and a visit already booked online isn’t imported twice', async () => {
    const [app] = await sql`insert into arts.customers (name, email, source) values ('Jo Park', 'jo@example.com', 'booking') returning id`;
    const [v] = await sql`insert into arts.vehicles (customer_id, year, make, model) values (${app.id}, 2019, 'Chevy', 'Silverado1500') returning id`;
    await sql`insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, source) values (${app.id}, ${v.id}, (select id from arts.services where name = 'Oil change'), '2026-03-01', 'booking')`;
    // Same email: linked by the import. TRACS spells the car out in full.
    await run(`${HEADER}\n3003,JO PARK,jo@example.com,,,,,,2019,CHEVROLET,SILVERADO 1500,03/01/2026,LOF,,,\n`);
    expect(await counts()).toEqual({ c: 1, v: 1, h: 1 });
  });

  it('“Not the same” hides a pair for good', async () => {
    await sql`insert into arts.customers (name, email, address_line1, source) values ('Sam Lee', 'sam@example.com', '9 ELM ST', 'booking')`;
    await run(`${HEADER}\n3002,Sam Lee,,6105558888,9 Elm St,Easton,PA,18042,2010,Ford,F-150,03/01/2026,LOF,,,\n`);
    const dev = (await adminToken('developer')).token;
    const call = (action: string, body: unknown) => adminAction(reqWith(dev), action, body);
    const [p] = ((await call('matches', {})).body as any).pairs;
    expect(p.reasons).toEqual(['same street', 'same name']);
    await call('match-dismiss', { app_id: p.app_id, tracs_id: p.tracs_id });
    expect(((await call('matches', {})).body as any).pairs).toEqual([]);
  });
});
