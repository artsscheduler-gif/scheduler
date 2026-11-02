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

await step('Print provider is live', () =>
  E.MAIL_PROVIDER === 'lob' && (E.LOB_API_KEY ?? '').startsWith('live_')
    ? ['PASS', 'lob live key']
    : ['FAIL', E.LOB_API_KEY?.startsWith('test_') ? 'Lob test key: postcards render but never mail' : `MAIL_PROVIDER=${E.MAIL_PROVIDER ?? 'stub'}`]);

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

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${failed ? `${failed} check(s) failed.` : 'All checks passed.'} DMARC alignment on a real send is verified by hand (README → Launch).`);
process.exit(failed ? 1 : 0);
