// Requires `npm run dev:api` and `npm run dev` (see README). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { BASE, SHOTS, launch, serverUp } from './helpers';
import { sql, resetData } from '../db/helpers';
import { bookToken, signToken } from '../../server/tokens';

const up = await serverUp();
let browser: Browser;

beforeAll(async () => {
  if (!up) return;
  await resetData();
  await sql`update arts.shop_settings set shop_phone = '(555) 010-0199', staff_notify_email = 'chris@example.com'`;
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await sql.end();
});

async function phone(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  return ctx.newPage();
}

async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w).toBeLessThanOrEqual(375);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

describe.skipIf(!up)('Phase 3: public booking on a 375px phone', () => {
  it('completes a full booking', async () => {
    const page = await phone();
    await page.goto(BASE);
    await page.getByText('Oil change', { exact: true }).click();
    await page.getByText('Tire rotation', { exact: true }).click();
    await page.getByLabel(/Anything else/).fill('Light comes on <b>sometimes</b>');
    await shot(page, '1-services');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('button.day').first().click();
    await page.getByRole('radio', { name: '10:00am' }).click();
    await shot(page, '2-when');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Next' }).click();

    // Time first, then wait or drop off; both are open at 10:00.
    await page.getByRole('radio', { name: /^Drop off/ }).click();
    await shot(page, '3-kind');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Name').fill('Robin Example');
    await page.getByLabel('Phone').fill('610-555-0142');
    await page.getByLabel('Email').fill(`robin-${Date.now()}@example.com`);
    // Model lists come from NHTSA vPIC; answer locally so the test doesn't depend on it.
    await page.route('https://vpic.nhtsa.dot.gov/**', (r) => r.fulfill({
      json: { Results: r.request().url().includes('/vehicletype/car') ? [{ Model_Name: 'Corolla' }, { Model_Name: 'Camry' }] : [{ Model_Name: 'RAV4' }] },
    }));
    await page.getByLabel('Year').selectOption('2016');
    await page.getByLabel('Make').selectOption('Toyota');
    await page.getByLabel('Model').selectOption('Corolla');
    // Turnstile test site key passes automatically.
    await page.getByRole('button', { name: 'Book it' }).waitFor();
    await page.waitForFunction(() => !(document.querySelector('button.primary') as HTMLButtonElement)?.disabled, null, { timeout: 20000 });
    await shot(page, '4-details');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Book it' }).click();

    await page.getByRole('heading', { name: 'Request received' }).waitFor();
    await shot(page, '5-done');
    const [b] = await sql`select b.status, b.kind, b.start_time, b.customer_notes, c.phone from arts.bookings b join arts.customers c on c.id = b.customer_id`;
    expect(b).toMatchObject({ status: 'requested', kind: 'dropoff', start_time: '10:00:00', customer_notes: 'Light comes on <b>sometimes</b>', phone: '+16105550142' });
  });

  it('offers only drop-off when a service is not wait-eligible', async () => {
    const page = await phone();
    await page.goto(BASE);
    await page.getByText('Brakes', { exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('button.day').first().click();
    await page.getByRole('radio', { name: '9:00am' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    expect(await page.getByRole('radio', { name: /^Wait/ }).isDisabled()).toBe(true);
    expect(await page.getByRole('radio', { name: /^Drop off/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('times and wait/drop-off work from the keyboard', async () => {
    const page = await phone();
    await page.goto(BASE);
    await page.getByText('Oil change', { exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('button.day').first().click();
    await page.getByRole('radio', { name: '7:30am' }).waitFor();
    // Focus lands on the day heading; Tab reaches the first time, arrows choose.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H3');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    expect(await page.getByRole('radio', { name: '8:00am' }).getAttribute('aria-checked')).toBe('true');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('radio', { name: /^Wait/ }).focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.getByRole('radio', { name: /^Drop off/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('a returning customer’s personal link fills in their details and cars', async () => {
    const [c] = await sql`insert into arts.customers (name, email, phone, source) values ('Lee Return', 'lee-return@example.com', '+16105550133', 'import') returning id`;
    const [v] = await sql`insert into arts.vehicles (customer_id, year, make, model) values (${c.id}, 2017, 'Subaru', 'Outback') returning id`;
    const page = await phone();
    await page.goto(`${BASE}/?src=email-step1&k=${bookToken(c.id, 1)}`);
    await page.waitForURL((u) => !u.searchParams.has('k')); // taken out of the address bar
    await page.getByText('Oil change', { exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('button.day').first().click();
    await page.getByRole('radio', { name: '11:00am' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('radio', { name: /^Wait/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Welcome back, Lee').waitFor();
    expect(await page.getByLabel('Email').inputValue()).toBe('lee-return@example.com');
    expect(await page.getByRole('radio', { name: '2017 Subaru Outback' }).isChecked()).toBe(true);
    expect(await page.getByLabel('Make').count()).toBe(0); // no car fields for a saved car
    await page.waitForFunction(() => !(document.querySelector('button.primary') as HTMLButtonElement)?.disabled, null, { timeout: 20000 });
    await page.getByRole('button', { name: 'Book it' }).click();
    await page.getByRole('heading', { name: /Request received|You’re booked/ }).waitFor();
    const [b] = await sql`select customer_id, vehicle_id from arts.bookings where customer_id = ${c.id}`;
    expect(b).toEqual({ customer_id: c.id, vehicle_id: v.id });
  });

  it('shows the phone fallback on a server error', async () => {
    const page = await phone();
    await page.route('**/api/availability?services=*', (r) => r.fulfill({ status: 503, body: '{"error":"unavailable"}' }));
    await page.goto(BASE);
    await page.getByText('Oil change', { exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Call us at').waitFor();
    expect(await page.getByRole('link', { name: /Call \(555\) 010-0199/ }).count()).toBe(1);
    await shot(page, '6-fallback');
  });

  it('manage link shows notes as plain text and cancels', async () => {
    const [b] = await sql`select root_id, date from arts.bookings limit 1`;
    const t = signToken({ p: 'manage', r: b.root_id, exp: Math.floor(Date.now() / 1000) + 86400 * 30 });
    const page = await phone();
    await page.goto(`${BASE}/manage?t=${t}`);
    await page.getByText('Requested — waiting for the shop to confirm').waitFor();
    // Free text renders literally, never as HTML.
    expect(await page.locator('.appt-notes b').count()).toBe(0);
    expect(await page.locator('.appt-notes').innerText()).toContain('<b>sometimes</b>');
    await shot(page, '7-manage');
    await page.getByRole('button', { name: 'Cancel appointment' }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.getByRole('heading', { name: 'Cancelled' }).waitFor();
    const [after] = await sql`select status from arts.bookings where root_id = ${b.root_id}`;
    expect(after.status).toBe('cancelled');
  });

  it('expired manage link explains itself', async () => {
    const page = await phone();
    await page.goto(`${BASE}/manage?t=bad.token`);
    await page.getByRole('heading', { name: 'This link has expired' }).waitFor();
  });
});
