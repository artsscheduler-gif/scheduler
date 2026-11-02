// Staging smoke test. Re-runnable; cleans up after itself.
//   npm run smoke:staging                          # reads .env.staging.local, URL from STAGING_URL or APP_URL
//   npm run smoke:staging -- --env .env.local --url http://localhost:5173
// Exit code 0 only when nothing failed. Prints PASS/FAIL/SKIP per check and
// writes the same lines to smoke-staging.log (gitignored by *.log).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import { chromium } from 'playwright';
import { anonCheck } from './lib/anon-check.js';

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const envFile = arg('--env') ?? '.env.staging.local';
for (const line of existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"|"$/g, '').trim();
}
const E = process.env;
const URL_ = (arg('--url') ?? E.STAGING_URL ?? E.APP_URL ?? '').replace(/\/$/, '');
const ANON = E.VITE_SUPABASE_ANON_KEY || E.SUPABASE_ANON_KEY || '';
if (!URL_ || !E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY || !ANON) {
  console.error(`Need --url (or STAGING_URL), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the anon key in ${envFile}.`);
  process.exit(2);
}
const HTTPS = URL_.startsWith('https://');
const TEST_TURNSTILE = (E.TURNSTILE_SECRET_KEY ?? '').startsWith('1x0000');
const LOB_TEST = E.MAIL_PROVIDER === 'lob' && (E.LOB_API_KEY ?? '').startsWith('test_');

const service = createClient<any, 'arts'>(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'arts' }, auth: { persistSession: false } });

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: { name: string; status: Status; detail: string }[] = [];
async function check(name: string, fn: () => Promise<[Status, string]>) {
  let r: [Status, string];
  try {
    r = await fn();
  } catch (e) {
    r = ['FAIL', (e as Error).message.split('\n')[0]];
  }
  results.push({ name, status: r[0], detail: r[1] });
  console.log(`${r[0].padEnd(4)}  ${name}${r[1] ? `  ${r[1]}` : ''}`);
}
const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg); };

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${URL_}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const post = (path: string, body: unknown, token?: string) => json(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

console.log(`Smoke test against ${URL_}\n`);
const browser = await chromium.launch();

// ---- 1. pages load ------------------------------------------------------------
const config = (await json('/api/availability?config=1')).body as { services: { id: string; name: string; wait_eligible: boolean }[] } | null;

await check('1. Homepage and booking page load', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const res = await page.goto(URL_);
  assert(res?.ok(), `HTTP ${res?.status()}`);
  assert(config?.services?.length, 'no services in public config');
  await page.getByText(config!.services[0].name, { exact: true }).first().waitFor({ timeout: 15000 });
  assert(!errors.length, `page errors: ${errors.join('; ')}`);
  await page.close();
  return ['PASS', `${config!.services.length} services listed`];
});

// ---- 2. headers ---------------------------------------------------------------
await check('2. Security headers (CSP, HSTS, frame denial on /admin)', async () => {
  if (!HTTPS) return ['SKIP', 'not https (headers come from vercel.json on Vercel only)'];
  const root = await fetch(URL_);
  const admin = await fetch(`${URL_}/admin`);
  const missing = [
    !root.headers.get('content-security-policy') && 'CSP',
    !root.headers.get('strict-transport-security') && 'HSTS',
    !(admin.headers.get('x-frame-options') === 'DENY' || /frame-ancestors 'none'/.test(admin.headers.get('content-security-policy') ?? '')) && 'frame denial on /admin',
  ].filter(Boolean);
  return missing.length ? ['FAIL', `missing ${missing.join(', ')}`] : ['PASS', ''];
});

// ---- 3. availability is times only --------------------------------------------
const waitSvc = config?.services.find((s) => s.wait_eligible);
let slot: { date: string; time: string } | null = null;
await check('3. Availability returns dates/times only', async () => {
  assert(waitSvc, 'no wait-eligible service');
  const d = await json(`/api/availability?services=${waitSvc!.id}&kind=wait`);
  assert(d.status === 200, `days HTTP ${d.status}`);
  assert(JSON.stringify(Object.keys(d.body)) === '["days"]', `unexpected keys ${Object.keys(d.body)}`);
  assert(d.body.days.every((x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)), 'non-date values in days');
  for (const date of d.body.days.slice(0, 6)) {
    const t = await json(`/api/availability?services=${waitSvc!.id}&kind=wait&date=${date}`);
    assert(JSON.stringify(Object.keys(t.body)) === '["times"]', `unexpected keys ${Object.keys(t.body)}`);
    assert(t.body.times.every((x: unknown) => typeof x === 'string' && /^\d{2}:\d{2}$/.test(x)), 'non-time values in times');
    if (t.body.times.length) { slot = { date, time: t.body.times[0] }; break; }
  }
  const raw = JSON.stringify(d.body);
  assert(!/@|\+1\d{10}|name|count/i.test(raw), 'response contains personal data or counts');
  return ['PASS', `${d.body.days.length} open days`];
});

// ---- 4. turnstile -------------------------------------------------------------
await check('4. Booking without a valid Turnstile token is rejected', async () => {
  if (TEST_TURNSTILE) return ['SKIP', 'Cloudflare test secret (1x…) accepts every token by design'];
  assert(waitSvc && slot, 'no open slot to try');
  const r = await post('/api/book', {
    service_ids: [waitSvc!.id], customer_notes: '', date: slot!.date, kind: 'wait', start_time: slot!.time,
    name: 'Smoke Reject', email: `smoke-reject-${Date.now()}@sim.invalid`, phone: '6105550199',
    vehicle: { year: 2015, make: 'Ford', model: 'Focus', notes: '' }, turnstile: 'not-a-real-token',
  });
  return r.status === 400 && r.body?.error === 'verification_failed' ? ['PASS', 'HTTP 400 verification_failed'] : ['FAIL', `HTTP ${r.status} ${JSON.stringify(r.body)}`];
});

await check('4b. Turnstile widget loads on the booking form', async () => {
  assert(waitSvc, 'no wait-eligible service');
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (/turnstile/i.test(m.text()) && m.type() !== 'log') consoleErrors.push(m.text()); });
  await page.goto(URL_);
  await page.getByText(waitSvc!.name, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('radio', { name: /^Wait/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('button.day').first().click();
  await page.locator('button.time').first().click();
  await page.getByRole('button', { name: 'Next' }).click();
  // The widget's iframe sits in a closed shadow root, so check the API loaded and the box rendered.
  await page.waitForFunction(() => !!(window as any).turnstile && (document.querySelector('.turnstile') as HTMLElement)?.offsetHeight > 0, null, { timeout: 20000 });
  await page.waitForTimeout(4000);
  const token = await page.evaluate(() => !(document.querySelector('button.primary') as HTMLButtonElement)?.disabled);
  await page.close();
  const host = new URL(URL_).host;
  if (consoleErrors.some((m) => /110200/.test(m))) return ['FAIL', `widget rejects hostname ${host} (error 110200): add it to the widget's hostnames`];
  if (consoleErrors.length) return ['FAIL', consoleErrors[0].slice(0, 160)];
  return ['PASS', `widget rendered${token ? ', token issued' : ', no token yet (a real key may show a challenge to headless browsers)'}${TEST_TURNSTILE ? ' (test key)' : ''}`];
});

// ---- 5–7. auth walls and health ------------------------------------------------
await check('5. /admin shows sign-in when not authenticated', async () => {
  const page = await browser.newPage();
  await page.goto(`${URL_}/admin`);
  await page.getByLabel('Password').waitFor({ timeout: 15000 });
  await page.close();
  const api = await post('/api/admin/sim-status', {});
  const outbox = await fetch(`${E.SUPABASE_URL}/rest/v1/email_outbox?select=id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Accept-Profile': 'arts' } });
  const rows = outbox.ok ? ((await outbox.json()) as unknown[]) : [];
  assert(api.status === 401, `admin API without a session returned ${api.status}`);
  assert(rows.length === 0, 'anon key can read the outbox');
  return ['PASS', `sign-in form shown; admin API 401; outbox anon read HTTP ${outbox.status}`];
});

await check('6. Cron endpoint rejects requests without the secret', async () => {
  const a = await json('/api/cron/daily');
  const b = await json('/api/cron/daily', { headers: { Authorization: 'Bearer wrong' } });
  return a.status === 401 && b.status === 401 ? ['PASS', 'HTTP 401 / 401'] : ['FAIL', `HTTP ${a.status} / ${b.status}`];
});

await check('7. Health endpoint: database and providers reachable', async () => {
  const h = await json('/api/health');
  return h.status === 200 && h.body?.database && h.body?.email && h.body?.mail ? ['PASS', JSON.stringify(h.body)] : ['FAIL', `HTTP ${h.status} ${JSON.stringify(h.body)}`];
});

// ---- 8. simulator flow ---------------------------------------------------------
const adminEmail = `smoke-${Date.now()}@sim.invalid`;
let adminId: string | null = null;
let token = '';
const outboxSince = new Date().toISOString();

async function signInAdmin() {
  const password = `Smoke-${crypto.randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true, app_metadata: { role: 'owner' }, user_metadata: { name: 'Smoke test' } });
  if (error) throw error;
  adminId = data.user.id;
  const client = createClient(E.SUPABASE_URL!, ANON, { auth: { persistSession: false } });
  const s = await client.auth.signInWithPassword({ email: adminEmail, password });
  if (s.error) throw s.error;
  const enroll = await client.auth.mfa.enroll({ factorType: 'totp' });
  if (enroll.error) throw enroll.error;
  const ch = await client.auth.mfa.challenge({ factorId: enroll.data.id });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll.data.totp.secret) }).generate();
  const v = await client.auth.mfa.verify({ factorId: enroll.data.id, challengeId: ch.data!.id, code });
  if (v.error) throw v.error;
  token = (await client.auth.getSession()).data.session!.access_token;
}

const admin = async (action: string, body: unknown = {}) => {
  const r = await post(`/api/admin/${action}`, body, token);
  if (r.status !== 200) throw new Error(`${action}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const timesOn = async (date: string) => (await json(`/api/availability?services=${waitSvc!.id}&kind=wait&date=${date}`)).body.times as string[];
const outbox = async (kind: string, to?: string) => {
  let q = service.from('email_outbox').select('kind, to_email, html, sim_date').eq('kind', kind).gte('created_at', outboxSince);
  if (to) q = q.eq('to_email', to);
  const { data, error } = await q;
  if (error) throw new Error(`outbox read: ${error.message}`);
  return data ?? [];
};

let simReady = false;
await check('8a. Test admin signs in with TOTP; simulator enabled', async () => {
  await signInAdmin();
  const st = await admin('sim-status');
  simReady = true;
  assert(st.email_provider === 'capture', `EMAIL_PROVIDER is ${st.email_provider}, not capture`);
  return ['PASS', `today ${st.today}, dry-run ${st.dry_run}`];
});

let bookingId: string | null = null;
let customerEmail = '';
await check('8b. Load fake customers', async () => {
  assert(simReady, 'simulator not reachable');
  const r = await admin('sim-customers', { count: 40 });
  return ['PASS', `${r.customers} customers, ${r.history} service records`];
});

await check('8c. Book one appointment; it lands as requested in the approval queue', async () => {
  assert(simReady && waitSvc && slot, 'simulator or open slot unavailable');
  customerEmail = `smoke-${Date.now()}@sim.invalid`;
  let how: string;
  if (TEST_TURNSTILE) {
    const r = await post('/api/book', {
      service_ids: [waitSvc!.id], customer_notes: 'Smoke test', date: slot!.date, kind: 'wait', start_time: slot!.time,
      name: 'Smoke Customer', email: customerEmail, phone: '6105550198',
      vehicle: { year: 2018, make: 'Honda', model: 'Civic', notes: '' }, turnstile: 'XXXX.DUMMY.TOKEN.XXXX',
    });
    assert(r.status === 200, `book HTTP ${r.status} ${JSON.stringify(r.body)}`);
    const { data } = await service.from('bookings').select('id, customers!inner(email)').eq('customers.email', customerEmail).single();
    bookingId = data!.id;
    how = 'public /api/book';
  } else {
    // A real Turnstile secret can't be solved by a script; the Simulator places
    // the request through the same database function and emails.
    const r = await admin('sim-bookings', { count: 1, slot: { service_id: waitSvc!.id, date: slot!.date, kind: 'wait', start_time: slot!.time } });
    assert(r.made.length === 1, `not booked: ${r.failed.join('; ')}`);
    bookingId = r.made[0].booking_id;
    const { data } = await service.from('bookings').select('customers(email)').eq('id', bookingId).single();
    customerEmail = (data as any).customers.email;
    how = 'Simulator (real Turnstile key)';
  }
  const { data: b } = await service.from('bookings').select('status').eq('id', bookingId).single();
  assert(b?.status === 'requested', `status is ${b?.status}`);
  return ['PASS', `${slot!.date} ${slot!.time} via ${how}`];
});

await check('8d. Approve it; confirmation email appears in the Outbox', async () => {
  assert(bookingId, 'no booking');
  const r = await admin('decide', { booking_id: bookingId, action: 'approve' });
  assert(r.ok, `approve refused: ${JSON.stringify(r)}`);
  const mail = await outbox('booking_confirmed', customerEmail);
  assert(mail.length === 1, `${mail.length} confirmation emails`);
  return ['PASS', ''];
});

await check('8e. Cancel through the manage link; capacity is released', async () => {
  assert(bookingId, 'no booking');
  // Fill the rest of the slot so it disappears from availability.
  for (let i = 0; i < 6 && (await timesOn(slot!.date)).includes(slot!.time); i++) {
    const r = await admin('sim-bookings', { count: 1, slot: { service_id: waitSvc!.id, date: slot!.date, kind: 'wait', start_time: slot!.time } });
    if (!r.made.length) break;
  }
  assert(!(await timesOn(slot!.date)).includes(slot!.time), `could not fill ${slot!.time}`);
  const [mail] = await outbox('booking_confirmed', customerEmail);
  const t = mail?.html.match(/\/manage\?t=([^"'&<\s]+)/)?.[1];
  assert(t, 'no manage link in the confirmation email');
  const r = await post('/api/cancel', { t: decodeURIComponent(t!) });
  assert(r.status === 200 && r.body?.state === 'cancelled', `cancel HTTP ${r.status} ${JSON.stringify(r.body)}`);
  assert((await timesOn(slot!.date)).includes(slot!.time), `${slot!.time} still unavailable after cancel`);
  return ['PASS', `${slot!.time} on ${slot!.date} filled, then reopened`];
});

await check('8f. Fast-forward: due reminders reach the Outbox', async () => {
  assert(simReady, 'simulator not reachable');
  const st = await admin('sim-status');
  let emails = 0;
  let batched = 0;
  for (let i = 0; i < 14; i++) {
    const d = new Date(`${st.today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const r = await admin('sim-day', { date: d.toISOString().slice(0, 10), live: true });
    emails += r.emails;
    batched += r.batched;
  }
  const due = (await service.from('email_outbox').select('id', { count: 'exact', head: true }).like('kind', 'service_due%').gte('created_at', outboxSince)).count ?? 0;
  assert(due > 0, 'no service-due reminders captured');
  const { count: drafts } = await service.from('mail_batches').select('id', { count: 'exact', head: true }).eq('status', 'draft');
  const pc = LOB_TEST ? (drafts ? `; ${drafts} draft postcard batch(es)` : '; NO draft postcard batch') : `; ${batched} postcards batched (stub provider)`;
  if (LOB_TEST && !drafts) return ['FAIL', `${due} reminder emails${pc}`];
  return ['PASS', `${due} reminder emails over 14 days${pc}`];
});

// ---- 9. RLS -------------------------------------------------------------------
await check('9. Anon key cannot read or write any table or call any function', async () => {
  const r = await anonCheck(E.SUPABASE_URL!, ANON, E.SUPABASE_SERVICE_ROLE_KEY!);
  return r.failures.length ? ['FAIL', r.failures.slice(0, 5).join(' | ')] : ['PASS', `${r.tables.length} tables, ${r.functions.length} functions denied`];
});

// ---- cleanup --------------------------------------------------------------------
await check('Cleanup: simulated data and the test admin removed', async () => {
  if (simReady) await admin('sim-reset');
  if (adminId) {
    const { error } = await service.auth.admin.deleteUser(adminId);
    if (error) throw error;
  }
  return ['PASS', 'captured emails left in the Outbox for review'];
});

await browser.close();
const failed = results.filter((r) => r.status === 'FAIL').length;
const summary = `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped.`;
console.log(summary);
writeFileSync('smoke-staging.log', `${new Date().toISOString()} ${URL_}\n${results.map((r) => `${r.status.padEnd(4)}  ${r.name}  ${r.detail}`).join('\n')}${summary}\n`);
process.exit(failed ? 1 : 0);
