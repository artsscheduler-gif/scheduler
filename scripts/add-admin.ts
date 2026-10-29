// Invite an admin. They get an email to set a password, then must enroll TOTP.
//   npm run admin:add -- --email chris@example.com --role staff --name Chris
// Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (.env.local locally).
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const role = arg('--role') ?? 'staff';
const name = arg('--name') ?? '';
const redirectTo = `${(process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/admin`;
if (!email || !['owner', 'staff'].includes(role)) {
  console.error('Usage: npm run admin:add -- --email <email> --role owner|staff [--name <display name>]');
  process.exit(1);
}
const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data, error } = await supa.auth.admin.inviteUserByEmail(email, { redirectTo, data: { name } });
if (error) {
  console.error('Invite failed:', error.message);
  process.exit(1);
}
const { error: e2 } = await supa.auth.admin.updateUserById(data.user.id, { app_metadata: { role } });
if (e2) {
  console.error('Role assignment failed:', e2.message);
  process.exit(1);
}
console.log(`Invited ${email} as ${role}. They set a password from the email, then enroll an authenticator app on first sign-in.`);
if (args.includes('--remove')) console.log('(--remove is not supported here; see README: remove an admin)');
