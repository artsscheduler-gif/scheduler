// CI guard: fails the build if any server secret appears in the client bundle.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY', 'TOKEN_SECRET', 'CRON_SECRET', 'BACKUP_ENCRYPTION_KEY',
  'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'LOB_API_KEY', 'DATABASE_URL',
];

// Load .env.local too, so local builds are checked against local secrets.
const fileEnv = existsSync('.env.local')
  ? Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {};

const secrets = SECRET_VARS
  .map((k) => [k, process.env[k] || fileEnv[k]])
  .filter(([, v]) => v && v.length >= 12);

// Patterns that should never ship regardless of env: service-role JWTs and
// provider secret key prefixes.
const patterns = [
  [/"role"\s*:\s*"service_role"/, 'service_role JWT payload'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/, 'service_role JWT'],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{10,}/, 'Resend API key'],
  [/(live|test)_[a-f0-9]{30,}/, 'Lob API key'],
  [/SUPABASE_SERVICE_ROLE_KEY|TOKEN_SECRET|CRON_SECRET/, 'server env var name'],
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const dir = process.argv[2] ?? 'dist';
const problems = [];
for (const file of walk(dir)) {
  const text = readFileSync(file, 'utf8');
  for (const [name, value] of secrets) if (text.includes(value)) problems.push(`${file}: contains ${name}`);
  for (const [re, label] of patterns) if (re.test(text)) problems.push(`${file}: matches ${label}`);
}
if (problems.length) {
  console.error('Secret check FAILED:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`Secret check passed (${secrets.length} secrets, ${patterns.length} patterns, ${dir}).`);
