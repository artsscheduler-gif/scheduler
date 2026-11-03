// Returning customers: emailed codes, personal links, booking with a saved car.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql, resetData, serviceId, weekdayAhead } from './helpers';
import { getAccount, getMe, postAccount, postMeCode, postMeVerify } from '../../server/me';
import { postBook } from '../../server/public';
import { bookToken, personalBookingUrl } from '../../server/tokens';
import { StubEmailProvider } from '../../server/email/provider';
import { renderPostcard } from '../../server/postcard';
import { getSettings } from '../../server/db';

afterAll(() => sql.end());

let pat: string, car: string, other: string;

beforeEach(async () => {
  await resetData();
  StubEmailProvider.outbox = [];
  [{ id: pat }] = await sql`insert into arts.customers (name, email, phone, source) values ('Pat Doe', 'pat@example.com', '+16105550111', 'import') returning id`;
  [{ id: car }] = await sql`insert into arts.vehicles (customer_id, year, make, model, notes) values (${pat}, 2015, 'Honda', 'Fit', 'ABC-1234') returning id`;
  const [o] = await sql`insert into arts.customers (name, email, source) values ('Sam Roe', 'sam@example.com', 'import') returning id`;
  [{ id: other }] = await sql`insert into arts.vehicles (customer_id, year, make, model) values (${o.id}, 2019, 'Ford', 'Escape') returning id`;
});

const codeFrom = () => StubEmailProvider.outbox.at(-1)!.subject.match(/^(\d{6})/)![1];

describe('Emailed code', () => {
  it('a code emailed to an address on file unlocks the customer and their cars', async () => {
    await postMeCode({ email: 'PAT@example.com' }, '10.7.0.1');
    expect(StubEmailProvider.outbox.at(-1)!.to).toBe('pat@example.com');
    await expect(postMeVerify({ email: 'pat@example.com', code: '000000' }, '10.7.0.1')).rejects.toMatchObject({ body: { error: 'wrong_code' } });
    const r = (await postMeVerify({ email: 'pat@example.com', code: codeFrom(), remember: true }, '10.7.0.1')).body as any;
    expect(r.profile).toEqual({ name: 'Pat Doe', email: 'pat@example.com', phone: '+16105550111', vehicles: [{ id: car, label: '2015 Honda Fit (ABC-1234)' }] });
    // Used once only.
    await expect(postMeVerify({ email: 'pat@example.com', code: codeFrom() }, '10.7.0.1')).rejects.toMatchObject({ body: { error: 'code_expired' } });
  });

  it('answers the same for an unknown email, and sends nothing', async () => {
    expect((await postMeCode({ email: 'nobody@example.com' }, '10.7.0.2')).body).toEqual({ ok: true });
    expect(StubEmailProvider.outbox).toHaveLength(0);
  });

  it('stops after five wrong guesses', async () => {
    await postMeCode({ email: 'pat@example.com' }, '10.7.0.3');
    for (let i = 0; i < 5; i++) await postMeVerify({ email: 'pat@example.com', code: '111111' }, '10.7.0.3').catch(() => {});
    await expect(postMeVerify({ email: 'pat@example.com', code: codeFrom() }, '10.7.0.3')).rejects.toMatchObject({ body: { error: 'code_expired' } });
  });
});

describe('Personal links', () => {
  it('reminder and postcard links carry a key that opens the customer', async () => {
    const url = new URL(personalBookingUrl('https://book.example.com/', pat, 'email-step1'));
    expect(url.searchParams.get('src')).toBe('email-step1');
    expect(((await getMe(url.searchParams.get('k'))).body as any).name).toBe('Pat Doe');
    await expect(getMe('bad.key')).rejects.toMatchObject({ status: 401 });
    // The QR code encodes the same URL the template's {{booking_url}} prints.
    const card = await renderPostcard(await getSettings(), { name: 'Pat Doe', service: 'Oil change', vehicle: '2015 Honda Fit', due_date: '2026-12-01', customerId: pat }, { front: '{{booking_url}}', back: '' });
    const link = new URL(card.front.replace(/&amp;/g, '&'));
    expect(link.searchParams.get('src')).toBe('postcard');
    expect(((await getMe(link.searchParams.get('k'))).body as any).name).toBe('Pat Doe');
  });
});

describe('Booking with a saved car', () => {
  const body = async (over: Record<string, unknown>) => ({
    service_ids: [await serviceId('Oil change')], customer_notes: '', date: await weekdayAhead(4), kind: 'wait', start_time: '09:00',
    name: 'Pat Doe', email: 'pat@example.com', phone: '610-555-0111', turnstile: 'x', ...over,
  });

  it('books under their record and car', async () => {
    const r = await postBook(await body({ k: bookToken(pat, 1), vehicle_id: car }), '10.7.1.1');
    expect(r.status).toBe(200);
    const [b] = await sql`select customer_id, vehicle_id from arts.bookings`;
    expect(b).toEqual({ customer_id: pat, vehicle_id: car });
  });

  it('refuses someone else’s car or a car without a key', async () => {
    await expect(postBook(await body({ k: bookToken(pat, 1), vehicle_id: other }), '10.7.1.2')).rejects.toMatchObject({ field: 'vehicle_id' });
    await expect(postBook(await body({ vehicle_id: car }), '10.7.1.3')).rejects.toMatchObject({ field: 'vehicle_id' });
  });
});

describe('My account', () => {
  const k = () => bookToken(pat, 1);

  it('shows details, cars, visits and upcoming appointments', async () => {
    await sql`insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, mileage, source) values (${pat}, ${car}, ${await serviceId('Oil change')}, '2026-03-01', 45210, 'import')`;
    await postBook({ service_ids: [await serviceId('Oil change')], customer_notes: '', date: await weekdayAhead(5), kind: 'wait', start_time: '09:00',
      name: 'Pat Doe', email: 'pat@example.com', phone: '610-555-0111', turnstile: 'x', k: k(), vehicle_id: car }, '10.7.2.1');
    const a = (await getAccount(k())).body as any;
    expect(a.details).toMatchObject({ name: 'Pat Doe', email: 'pat@example.com' });
    expect(a.cars).toEqual([expect.objectContaining({ id: car, make: 'Honda', notes: 'ABC-1234' })]);
    expect(a.history).toEqual([{ date: '2026-03-01', service: 'Oil change', car: '2015 Honda Fit', mileage: 45210 }]);
    expect(a.upcoming).toHaveLength(1);
    expect(a.upcoming[0].manage).toMatch(/\/manage\?t=/);
  });

  it('updates details, preferences and cars, and audits as the customer', async () => {
    await postAccount({ k: k(), action: 'details', details: { name: 'Pat Doe', email: 'pat@example.com', phone: '610-555-0199', address_line1: '1 Main St', city: 'Easton', state: 'pa', postal_code: '18042' } });
    await postAccount({ k: k(), action: 'prefs', email_opt_out: false, mail_opt_out: true });
    const added = (await postAccount({ k: k(), action: 'car', car: { year: '2020', make: 'Toyota', model: 'RAV4', notes: '', vin: '2t3p1rfv8lw123456' } })).body as any;
    await postAccount({ k: k(), action: 'remove-car', car_id: car });
    const [c] = await sql`select phone, state, mail_opt_out from arts.customers where id = ${pat}`;
    expect(c).toEqual({ phone: '+16105550199', state: 'PA', mail_opt_out: true });
    const cars = await sql`select id, vin from arts.vehicles where customer_id = ${pat}`;
    expect(cars).toEqual([{ id: added.id, vin: '2T3P1RFV8LW123456' }]);
    const actors = await sql`select distinct actor_type from arts.audit_log where action like '%self%' or action = 'vehicle.delete'`;
    expect(actors.map((r) => r.actor_type)).toEqual(['customer']);
  });

  it('cannot touch another customer’s car, or act without a valid key', async () => {
    await expect(postAccount({ k: k(), action: 'remove-car', car_id: other })).rejects.toMatchObject({ status: 404 });
    await expect(getAccount('bad')).rejects.toMatchObject({ status: 401 });
    await expect(postAccount({ k: k(), action: 'car', car: { make: 'X', model: 'Y', vin: 'IOQ123' } })).rejects.toMatchObject({ field: 'vin' });
  });
});
