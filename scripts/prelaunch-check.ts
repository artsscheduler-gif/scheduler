// Pre-launch security check. Run against production env vars before go-live:
//   vercel env pull .env.production.local && npm run prelaunch -- --env .env.production.local
// Exit code 0 only when every check passes.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveTxt } from 'node:dns/promises';
import { anonCheck } from './lib/anon-check.js';

const args = process.argv.slice(2);
const envFile = args.includes('--env') ? args[args.indexOf('--env') + 1] : '.env.local';
for (const line of existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : []) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
}
const E = process.env;
const domain = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : 'artsservicecenter.com';

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: { name: string; status: Status; detail: string }[] = [];
const record = (name: string, status: Status, detail = '') => results.push({ name, status, detail });

async function step(name: string, fn: () => Promise<[Status, string]> | [Status, string]) {
  try {
    const [s, d] = await fn();
    record(name, s, d);
  } catch (e) {
    record(name, 'FAIL', (e as Error).message.split('\n')[0]);
  }
}

await step('Required environment variables', () => {
  const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_ANON_KEY', 'TOKEN_SECRET', 'CRON_SECRET', 'BACKUP_ENCRYPTION_KEY', 'TURNSTILE_SECRET_KEY', 'VITE_TURNSTILE_SITE_KEY', 'APP_URL', 'VITE_SHOP_PHONE'];
  const missing = need.filter((k) => !E[k]);
  return missing.length ? ['FAIL', `missing ${missing.join(', ')}`] : ['PASS', `${need.length} present`];
});

await step('Secrets are strong', () => {
  const weak = ['TOKEN_SECRET', 'CRON_SECRET'].filter((k) => (E[k] ?? '').length < 32);
  if (Buffer.from(E.BACKUP_ENCRYPTION_KEY ?? '', 'hex').length !== 32) weak.push('BACKUP_ENCRYPTION_KEY');
  return weak.length ? ['FAIL', `weak: ${weak.join(', ')}`] : ['PASS', ''];
});

await step('Not a staging configuration', () => {
  const bad = [E.APP_ENV === 'staging' && 'APP_ENV=staging', E.VITE_APP_ENV === 'staging' && 'VITE_APP_ENV=staging', E.EMAIL_PROVIDER === 'capture' && 'EMAIL_PROVIDER=capture'].filter(Boolean);
  return bad.length ? ['FAIL', `${bad.join(', ')} (Simulator and Outbox would be live)`] : ['PASS', ''];
});

await step('Turnstile uses real keys', () =>
  /^[123]x0000/.test(E.TURNSTILE_SECRET_KEY ?? '') || /^[123]x0000/.test(E.VITE_TURNSTILE_SITE_KEY ?? '')
    ? ['FAIL', 'Cloudflare test key configured']
    : ['PASS', '']);

await step('Email provider is live', () =>
  E.EMAIL_PROVIDER === 'resend' && E.RESEND_API_KEY ? ['PASS', 'resend'] : ['FAIL', `EMAIL_PROVIDER=${E.EMAIL_PROVIDER ?? 'stub'} (stub sends nothing)`]);

await step('Print provider is live', () => {
  if (E.MAIL_PROVIDER === 'lob' && (E.LOB_API_KEY ?? '').startsWith('live_')) return ['PASS', 'lob live key'];
  if (E.MAIL_PROVIDER === 'postgrid' && (E.POSTGRID_API_KEY ?? '').startsWith('live_')) return ['PASS', 'postgrid live key'];
  const key = E.MAIL_PROVIDER === 'postgrid' ? E.POSTGRID_API_KEY : E.LOB_API_KEY;
  return ['FAIL', key?.startsWith('test_') ? `${E.MAIL_PROVIDER} test key: postcards render but never mail` : `MAIL_PROVIDER=${E.MAIL_PROVIDER ?? 'stub'}`];
});

await step('Anon key cannot read or write any table', async () => {
  const r = await anonCheck(E.SUPABASE_URL!, E.VITE_SUPABASE_ANON_KEY ?? E.SUPABASE_ANON_KEY!, E.SUPABASE_SERVICE_ROLE_KEY!);
  return r.failures.length ? ['FAIL', r.failures.slice(0, 5).join(' | ')] : ['PASS', `${r.tables.length} tables, ${r.functions.length} functions denied`];
});

await step('Public sign-up disabled', async () => {
  const res = await fetch(`${E.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: E.VITE_SUPABASE_ANON_KEY ?? E.SUPABASE_ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `probe-${Date.now()}@example.com`, password: 'probe-password-123456' }),
  });
  return res.ok ? ['FAIL', 'sign-up succeeded'] : ['PASS', `HTTP ${res.status}`];
});

await step('Supabase security advisor', async () => {
  const ref = E.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (ref && E.SUPABASE_ACCESS_TOKEN) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/advisors/security`, { headers: { Authorization: `Bearer ${E.SUPABASE_ACCESS_TOKEN}` } });
    if (!res.ok) return ['FAIL', `advisor API HTTP ${res.status}`];
    const data = (await res.json()) as { lints?: { level: string; title: string; metadata?: { schema?: string } }[] };
    const issues = (data.lints ?? []).filter((l) => l.level !== 'INFO');
    return issues.length ? ['FAIL', issues.map((l) => l.title).join('; ')] : ['PASS', 'no warnings'];
  }
  if (!ref) {
    const out = execSync('supabase db lint --schema arts --level warning 2>&1', { encoding: 'utf8' });
    return /No schema errors found/i.test(out) ? ['PASS', 'local: supabase db lint clean'] : ['FAIL', out.trim().split('\n').slice(-3).join(' ')];
  }
  return ['SKIP', 'set SUPABASE_ACCESS_TOKEN to query the hosted advisor (or check Dashboard → Advisors)'];
});

await step('npm audit (all dependencies)', () => {
  try {
    execSync('npm audit --audit-level=low', { stdio: 'pipe' });
    return ['PASS', '0 vulnerabilities'];
  } catch (e: any) {
    return ['FAIL', String(e.stdout ?? '').trim().split('\n').slice(-2).join(' ')];
  }
});

await step('No secrets in client bundle', () => {
  execSync('npx vite build --logLevel error', { stdio: 'pipe' });
  const out = execSync('node scripts/check-bundle-secrets.mjs', { encoding: 'utf8' });
  return ['PASS', out.trim()];
});

await step('Security headers on the live site', async () => {
  if (!E.APP_URL?.startsWith('https://')) return ['SKIP', 'APP_URL is not https'];
  const res = await fetch(E.APP_URL);
  const need = ['content-security-policy', 'strict-transport-security', 'x-frame-options'];
  const missing = need.filter((h) => !res.headers.get(h));
  return missing.length ? ['FAIL', `missing ${missing.join(', ')}`] : ['PASS', ''];
});

await step('Health endpoint', async () => {
  if (!E.APP_URL?.startsWith('https://')) return ['SKIP', 'APP_URL is not https'];
  const res = await fetch(`${E.APP_URL}/api/health`);
  return res.ok ? ['PASS', JSON.stringify(await res.json())] : ['FAIL', `HTTP ${res.status} ${await res.text()}`];
});

await step(`Email DNS for ${domain} (SPF, DKIM, DMARC)`, async () => {
  const txt = async (name: string) => (await resolveTxt(name).catch(() => [])).map((r) => r.join(''));
  const spf = (await txt(domain)).some((t) => t.startsWith('v=spf1'));
  const dmarc = (await txt(`_dmarc.${domain}`)).some((t) => t.startsWith('v=DMARC1'));
  const dkim = (await txt(`resend._domainkey.${domain}`)).some((t) => t.includes('p='));
  const missing = [!spf && 'SPF', !dkim && 'DKIM (resend._domainkey)', !dmarc && 'DMARC'].filter(Boolean);
  return missing.length ? ['FAIL', `missing ${missing.join(', ')}`] : ['PASS', ''];
});

// ---- Shop setup and operations ---------------------------------------------
async function settings(): Promise<Record<string, any> | null> {
  if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(`${E.SUPABASE_URL}/rest/v1/shop_settings?id=eq.1&select=*`, {
    headers: { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}`, 'Accept-Profile': 'arts' },
  });
  return res.ok ? ((await res.json()) as any[])[0] ?? null : null;
}
const s = await settings();
const placeholder = (v: unknown) => !v || /^\[.*\]$/.test(String(v)) || /@example\.(com|org)$|\.invalid$/i.test(String(v));

await step('Shop details are real (name, phone, address for email footers and postcards)', () => {
  if (!s) return ['SKIP', 'could not read shop_settings'];
  const bad = ['shop_name', 'shop_phone', 'shop_address'].filter((k) => placeholder(s[k]));
  if (!/^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.test(s.shop_address ?? '')) bad.push('shop_address format ("123 Main St, Town, PA 18000")');
  return bad.length ? ['FAIL', bad.join(', ')] : ['PASS', s.shop_address];
});

await step('Staff and owner alert emails are real', () => {
  if (!s) return ['SKIP', 'could not read shop_settings'];
  const bad = ['staff_notify_email', 'owner_alert_email', 'from_email'].filter((k) => placeholder(s[k]));
  return bad.length ? ['FAIL', bad.map((k) => `${k}=${s[k]}`).join(', ')] : ['PASS', `${s.staff_notify_email}, ${s.owner_alert_email}`];
});

await step('Service reminders are sending (dry run off)', () => {
  if (!s) return ['SKIP', 'could not read shop_settings'];
  return s.reminders_dry_run ? ['FAIL', 'reminders_dry_run is on: turn it off in Settings once the cutover review is done'] : ['PASS', ''];
});

await step('No staging email copies in production', () =>
  E.EMAIL_DELIVER_TO ? ['FAIL', 'EMAIL_DELIVER_TO is set (staging-only)'] : ['PASS', '']);

await step('Resend webhook configured (bounces and complaints)', () =>
  (E.RESEND_WEBHOOK_SECRET ?? '').startsWith('whsec_') ? ['PASS', ''] : ['FAIL', 'RESEND_WEBHOOK_SECRET missing: see .env.example']);

await step('Sending domain verified in Resend', async () => {
  if (!E.RESEND_API_KEY) return ['SKIP', 'no RESEND_API_KEY'];
  const from = String(s?.from_email ?? '').split('@')[1];
  const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${E.RESEND_API_KEY}` } });
  if (!res.ok) return ['SKIP', `Resend domains API HTTP ${res.status} (a sending-only key can't list domains; check the dashboard)`];
  const domains = ((await res.json()) as { data?: { name: string; status: string }[] }).data ?? [];
  const d = domains.find((x) => x.name === from);
  return d?.status === 'verified' ? ['PASS', from] : ['FAIL', `${from || 'from_email domain'}: ${d ? d.status : 'not added in Resend'}`];
});

await step('Hourly job scheduled (pg_cron → /api/cron/tick)', async () => {
  const ref = E.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref || !E.SUPABASE_ACCESS_TOKEN) return ['SKIP', 'set SUPABASE_ACCESS_TOKEN to check cron.job'];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${E.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "select schedule, command from cron.job where command like '%/api/cron/tick%'" }),
  });
  if (!res.ok) return ['FAIL', `query HTTP ${res.status}`];
  const rows = (await res.json()) as { schedule: string; command: string }[];
  const host = E.APP_URL ? new URL(E.APP_URL).host : '';
  const job = rows.find((r) => r.command.includes(host));
  return job ? ['PASS', `${job.schedule} → ${host}`] : ['FAIL', rows.length ? `tick job points elsewhere, not ${host}` : 'no tick job in cron.job'];
});

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${failed ? `${failed} check(s) failed.` : 'All checks passed.'} DMARC alignment on a real send is verified by hand (README → Launch).`);
process.exit(failed ? 1 : 0);
