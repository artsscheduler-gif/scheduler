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
    await service.auth.admin.createUser({ email, password: 'test-password-123456', email_confirm: true, app_metadata: { role: 'developer' } });
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

  it('test lab: customer books in the phone window, Chris approves, emails show the flow', async () => {
    await sql`delete from arts.email_outbox`;
    const email = `jake-lab-${Date.now()}@example.com`;
    await service.auth.admin.createUser({ email, password: 'test-password-123456', email_confirm: true, app_metadata: { role: 'developer' } });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${BASE}/admin`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('test-password-123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const secret = await page.locator('code').innerText();
    await page.getByLabel('6-digit code').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate());
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('heading', { name: /Waiting for you/ }).waitFor();
    await page.getByRole('link', { name: 'Test lab' }).click();

    const [phone] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open customer phone' }).click()]);
    await phone.route('https://vpic.nhtsa.dot.gov/**', (r) => r.fulfill({ json: { Results: [{ Model_Name: 'Civic' }] } }));
    await phone.getByText('Oil change', { exact: true }).click();
    await phone.getByRole('button', { name: 'Next' }).click();
    await phone.locator('button.day').first().click();
    await phone.getByRole('radio', { name: '10:00am' }).click();
    await phone.getByRole('button', { name: 'Next' }).click();
    await phone.getByRole('radio', { name: /^Drop off/ }).click();
    await phone.getByRole('button', { name: 'Next' }).click();
    await phone.getByLabel('Name').fill('Lab Customer');
    await phone.getByLabel('Phone').fill('610-555-0999');
    await phone.getByLabel('Email').fill('lab-customer@example.com');
    await phone.getByLabel('Year').selectOption('2018');
    await phone.getByLabel('Make').selectOption('Honda');
    await phone.getByLabel('Model').selectOption('Civic');
    await phone.waitForFunction(() => !(document.querySelector('button.primary') as HTMLButtonElement)?.disabled, null, { timeout: 20000 });
    await phone.getByRole('button', { name: 'Book it' }).click();
    await phone.getByRole('heading', { name: 'Request received' }).waitFor();

    // Both sides of the request show up in the feed.
    await page.locator('.lab-item.to-customer', { hasText: 'We got your request' }).waitFor();
    await page.locator('.lab-item.to-chris').first().waitFor();

    // Chris approves; the customer gets the confirmation.
    await page.locator('.req', { hasText: 'Lab Customer' }).getByRole('button', { name: 'Approve' }).click();
    const confirmed = page.locator('.lab-item.to-customer', { hasText: 'Confirmed:' });
    await confirmed.waitFor();
    expect(await confirmed.innerText()).toMatch(/drop off at 10:00am/);
    await confirmed.locator('.lab-row').click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/staging-3-lab.png` });

    // The email's change link opens in the customer phone.
    await confirmed.locator('.lab-links button').first().click();
    await phone.waitForURL(/\/manage\?t=/);
    await phone.getByRole('button', { name: 'Change date or time' }).waitFor();

    // Owner-only launch checklist: tick an item and it saves.
    await sql`insert into arts.audit_items (key, section, sort, title, priority, owner) values ('e2e-item', '9. E2E', 999, 'E2E checklist item', 'now', 'claude') on conflict (key) do update set done = false`;
    await page.getByRole('link', { name: 'Checklist' }).click();
    await page.getByRole('heading', { name: 'Launch checklist' }).waitFor();
    const saved = page.waitForResponse((r) => r.url().includes('/api/admin/audit-item') && r.request().method() === 'POST');
    await page.getByRole('checkbox', { name: 'E2E checklist item' }).check();
    expect((await saved).status()).toBe(200);
    expect((await sql`select done from arts.audit_items where key = 'e2e-item'`)[0].done).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/staging-4-checklist.png`, fullPage: true });
    await sql`delete from arts.audit_items where key = 'e2e-item'`;

    // Owner-only Team page lists admins.
    await page.getByRole('link', { name: 'Team' }).click();
    await page.getByRole('heading', { name: 'Team' }).waitFor();
    await page.getByText('You', { exact: true }).waitFor();
    expect(errors).toEqual([]);
  }, 120000);
});
