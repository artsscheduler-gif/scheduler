// Requires the dev servers in staging mode (APP_ENV=staging,
// EMAIL_PROVIDER=capture, VITE_APP_ENV=staging; see README). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import * as OTPAuth from 'otpauth';
import { BASE, SHOTS, launch, serverUp } from './helpers';
import { sql, service, resetData } from '../db/helpers';

const up = await serverUp();
const staging = up && (await fetch(BASE).then((r) => r.text()).catch(() => '')) !== '' && (await stagingBuild());
let browser: Browser;

async function stagingBuild() {
  const b = await launch();
  const p = await b.newPage();
  await p.goto(BASE);
  const on = await p.locator('.staging-flag').count();
  await b.close();
  return on > 0;
}

beforeAll(async () => {
  if (!staging) return;
  await resetData();
  await sql`update arts.shop_settings set shop_phone = '(555) 010-0199', staff_notify_email = 'chris@example.com', owner_alert_email = 'jake@example.com'`;
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await sql.end();
});

describe.skipIf(!staging)('Staging: simulator and outbox', () => {
  it('loads customers, books, fast-forwards, and shows captured email', async () => {
    const email = `jake-e2e-${Date.now()}@example.com`;
    await service.auth.admin.createUser({ email, password: 'test-password-123456', email_confirm: true, app_metadata: { role: 'owner' } });
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
    await page.getByLabel('6-digit code').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate());
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('heading', { name: /Waiting for you/ }).waitFor();

    await page.getByRole('link', { name: 'Simulator' }).click();
    await page.getByLabel('Customers').fill('60');
    await page.getByRole('button', { name: 'Add customers' }).click();
    await page.getByText(/Added 60 customers/).waitFor();
    await page.getByLabel('Bookings').fill('3');
    await page.getByRole('button', { name: 'Add requests' }).click();
    await page.getByText(/Created \d booking request/).waitFor();
    await page.getByLabel('Days').fill('21');
    await page.getByRole('button', { name: 'Fast-forward' }).click();
    await page.getByText(/Ran 21 days/).waitFor({ timeout: 60000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/staging-1-simulator.png`, fullPage: true });

    await page.getByRole('link', { name: 'Outbox' }).click();
    await page.locator('.outbox-list button').first().waitFor();
    expect(await page.locator('.outbox-list button').count()).toBeGreaterThan(3);
    await page.getByLabel('Filter').fill('service_due');
    await page.locator('.outbox-list button').first().click();
    await page.locator('.outbox-frame').waitFor();
    expect(await page.locator('.outbox-head').innerText()).toMatch(/sim\.invalid/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/staging-2-outbox.png` });
    expect(errors).toEqual([]);
  }, 120000);
});
