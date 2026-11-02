import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

export const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

export const service = createClient<any, 'arts'>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: 'arts' },
  auth: { persistSession: false },
});

// Wipes transactional data and restores default settings + seed services.
export async function resetData() {
  await sql`truncate arts.audit_log, arts.email_log, arts.reminder_sends, arts.mail_batches, arts.service_history,
    arts.booking_services, arts.bookings, arts.vehicles, arts.customers, arts.closures, arts.rate_limits, arts.job_runs, arts.email_outbox cascade`;
  await sql`delete from arts.shop_settings`;
  await sql`insert into arts.shop_settings (id) values (1)`;
  await sql`truncate arts.reminder_rules, arts.services cascade`;
  await sql`insert into arts.reminder_rules (step, channel, offset_days, condition) values
    (1, 'email', -14, 'no_booking_since_due'), (2, 'postcard', 0, 'no_booking_since_previous_step'), (3, 'email', 30, 'no_booking_since_previous_step')`;
  await sql.unsafe(readFileSync('supabase/seed.sql', 'utf8'));
}

export async function serviceId(name: string): Promise<string> {
  const [row] = await sql`select id from arts.services where name = ${name}`;
  if (!row) throw new Error(`no service ${name}`);
  return row.id;
}

// A weekday at least `minDays` ahead in shop-local time.
export async function weekdayAhead(minDays = 3): Promise<string> {
  const [row] = await sql`
    select d::date::text as d from generate_series(arts.today() + ${minDays}::int, arts.today() + 30, interval '1 day') d
    where extract(isodow from d) between 1 and 5 order by d limit 1`;
  return row.d;
}

import { createClient as createAnonClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';

// Creates (or reuses) an admin and returns an aal2 access token.
export async function adminToken(role: 'owner' | 'staff' = 'staff', withMfa = true): Promise<{ token: string; userId: string }> {
  const email = `${role}-${withMfa ? 'mfa' : 'nomfa'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = 'test-password-123456';
  const { data: created, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { role }, user_metadata: { name: role === 'staff' ? 'Chris' : 'Jake' },
  });
  if (error) throw error;
  const client = createAnonClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  if (withMfa) {
    const enroll = await client.auth.mfa.enroll({ factorType: 'totp' });
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll.data!.totp.secret) });
    const ch = await client.auth.mfa.challenge({ factorId: enroll.data!.id });
    await client.auth.mfa.verify({ factorId: enroll.data!.id, challengeId: ch.data!.id, code: totp.generate() });
  }
  const { data } = await client.auth.getSession();
  return { token: data.session!.access_token, userId: created.user!.id };
}

export function reqWith(token: string): any {
  return { headers: { authorization: `Bearer ${token}` }, method: 'POST' };
}
