// Writes .env.local from the running local Supabase stack, with test-mode
// keys for every provider. Never use these values in production.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const raw = execSync('supabase status -o env', { encoding: 'utf8' });
const s = Object.fromEntries(
  raw.split('\n').map((l) => l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const env = {
  SUPABASE_URL: s.API_URL,
  SUPABASE_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: s.ANON_KEY,
  VITE_SUPABASE_URL: s.API_URL,
  VITE_SUPABASE_ANON_KEY: s.ANON_KEY,
  DATABASE_URL: s.DB_URL,
  APP_URL: 'http://localhost:5173',
  TOKEN_SECRET: randomBytes(32).toString('hex'),
  CRON_SECRET: randomBytes(24).toString('hex'),
  BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  // Cloudflare's published always-pass test keys.
  VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  VITE_SHOP_PHONE: '(555) 010-0199', // placeholder
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  EMAIL_PROVIDER: 'stub',
  RESEND_API_KEY: '',
  MAIL_PROVIDER: 'stub',
  LOB_API_KEY: '',
};
writeFileSync('.env.local', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
console.log('wrote .env.local');
