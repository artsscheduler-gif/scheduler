// Requires the dev servers (see README). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import * as OTPAuth from 'otpauth';
import { BASE, SHOTS, launch, serverUp } from './helpers';
import { sql, service, resetData, serviceId, weekdayAhead } from '../db/helpers';
import { postBook } from '../../server/public';

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

describe.skipIf(!up)('Phase 4: admin console', () => {
  it('signs in with MFA enrollment, approves a request, and every page renders', async () => {
    const oil = await serviceId('Oil change');
    const day = await weekdayAhead(3);
    await postBook({
      service_ids: [oil], customer_notes: 'Please check the <script>alert(1)</script> wipers', date: day, kind: 'wait', start_time: '10:00',
      name: 'Jordan Queue', email: `jq-${Date.now()}@example.com`, phone: '610-555-0777',
      vehicle: { year: 2019, make: 'Mazda', model: 'CX-5', notes: 'ABC-1234' }, turnstile: 'x',
    }, '10.8.0.1');

    const email = `chris-e2e-${Date.now()}@example.com`;
    await service.auth.admin.createUser({ email, password: 'test-password-123456', email_confirm: true, app_metadata: { role: 'staff' } });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/admin`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('test-password-123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const secret = await page.locator('code').innerText();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-0-mfa.png` });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify' }).click();

    await page.getByRole('heading', { name: /Waiting for you/ }).waitFor();
    await page.getByText('Jordan Queue').first().waitFor();
    expect(await page.locator('script', { hasText: 'alert(1)' }).count()).toBe(0);
    await page.goto(`${BASE}/admin?date=${day}`);
    await page.locator('.blk').first().waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-1-day.png`, fullPage: true });

    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Nothing to approve.').waitFor();
    const [b] = await sql`select status from arts.bookings`;
    expect(b.status).toBe('confirmed');

    for (const [path, text] of [['customers', 'Pick a customer.'], ['approvals', 'Approval ladder'], ['settings', 'Appointment types'], ['activity', 'Changes'], ['export', 'Export'], ['book', 'Phone booking']]) {
      await page.goto(`${BASE}/admin/${path}`);
      await page.getByText(text).first().waitFor();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-${path}.png`, fullPage: true });
    }
    await page.goto(`${BASE}/admin/customers`);
    await page.getByRole('checkbox', { name: /plate/ }).check();
    await page.getByLabel('Search customers').fill('ABC-12');
    await page.getByRole('button', { name: /Jordan Queue/ }).click();
    await page.getByRole('heading', { name: 'Jordan Queue' }).waitFor();
    expect(errors).toEqual([]);
  });
});
