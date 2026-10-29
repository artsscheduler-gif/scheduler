import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { csvObjects } from '../../shared/csv';
import { planImport, reportMarkdown, standardizeStreet, standardizeZip, parseDate, type Mapping } from '../../server/import';

const mapping = JSON.parse(readFileSync('import/epicor-mapping.json', 'utf8')) as Mapping;
const services = [
  { id: 'svc-oil', name: 'Oil change', epicor_codes: ['OIL'] },
  { id: 'svc-insp', name: 'State inspection', epicor_codes: [] },
  { id: 'svc-rot', name: 'Tire rotation', epicor_codes: [] },
];
const existing = [{ id: 'cust-ed', name: 'Ed Existing', email: 'ed@example.com', phone: null }];
const plan = planImport(csvObjects(readFileSync('tests/fixtures/epicor-sample.csv', 'utf8')), mapping, services, existing);

describe('Epicor import dry run on the sample export', () => {
  it('counts rows, customers, vehicles, and history', () => {
    expect(plan.totals).toEqual({ rows: 8, customers: 5, vehicles: 5, history: 5, mapped_history: 4, email_opt_outs: 1, mail_opt_outs: 1 });
  });

  it('rejects rows with no name, or no way to reach the customer', () => {
    expect(plan.rejected.map((r) => [r.row, r.reason])).toEqual([
      [5, 'no customer name'],
      [6, 'no usable email, phone, or complete address'],
    ]);
  });

  it('groups repeat rows and normalizes phone, email, address', () => {
    const john = plan.customers.find((c) => c.epicor_id === '1001')!;
    expect(john).toMatchObject({
      name: 'John McDonald', email: 'john.mcdonald@example.com', phone: '+16105550101',
      address_line1: '123 N MAIN ST', city: 'EASTON', state: 'PA', postal_code: '18042',
    });
    expect(john.rows).toEqual([2, 3]);
    expect(john.vehicles).toHaveLength(1);
    expect(john.history.map((h) => [h.service_id, h.service_date, h.mileage])).toEqual([
      ['svc-oil', '2026-03-15', 84211],
      ['svc-insp', '2025-09-02', 80100],
    ]);
  });

  it('carries opt-outs over', () => {
    expect(plan.customers.find((c) => c.epicor_id === '1002')!.email_opt_out).toBe(true);
    expect(plan.customers.find((c) => c.epicor_id === '1005')!.mail_opt_out).toBe(true);
  });

  it('flags duplicates in the file and against existing customers', () => {
    expect(plan.duplicates.map((d) => [d.kind, d.match, d.customer.split(' (')[0], d.other.split(' (')[0]])).toEqual([
      ['in_file', 'email', 'Rita M.', 'Rita Moreno'],
      ['existing', 'email', 'Existing Ed', 'Ed Existing [cust-ed]'],
    ]);
  });

  it('warns about bad values and lists unmapped service types', () => {
    expect(plan.warnings.map((w) => [w.row, w.message])).toEqual([
      [4, 'invalid email "sara@example" dropped'],
      [7, 'service "LOF" skipped: bad date "13/45/2026"'],
    ]);
    expect(plan.unmappedServices).toEqual({ 'Wiper Blades': 1 });
    expect(plan.customers.find((c) => c.epicor_id === '1005')!.postal_code).toBe('08064');
  });

  it('produces a readable report', () => {
    const md = reportMarkdown(plan, 'sample.csv');
    expect(md).toContain('| Customers to add | 5 |');
    expect(md).toContain('- Row 5: no customer name');
    expect(md).toContain('"Wiper Blades" × 1');
  });
});

describe('normalizers', () => {
  it('standardizes addresses, ZIPs, and dates', () => {
    expect(standardizeStreet('42 West Maple Avenue, Apartment 3')).toBe('42 W MAPLE AVE APT 3');
    expect(standardizeZip('18042-1234')).toBe('18042-1234');
    expect(standardizeZip('abc')).toBeNull();
    expect(parseDate('2/29/2024', 'MM/DD/YYYY')).toBe('2024-02-29');
    expect(parseDate('2/29/2025', 'MM/DD/YYYY')).toBeNull();
  });
});
