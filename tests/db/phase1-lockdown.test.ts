import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';
import { anonCheck } from '../../scripts/lib/anon-check';
import { sql, service, resetData } from './helpers';

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

afterAll(() => sql.end());

describe('Phase 1: database locked by default', () => {
  it('anon key cannot read or write any table or call any function', async () => {
    await resetData();
    await sql`insert into arts.customers (name, email) values ('Probe', 'probe@example.com')`;
    const result = await anonCheck(url, anonKey, serviceKey);
    expect(result.tables.length).toBeGreaterThanOrEqual(15);
    expect(result.functions.length).toBeGreaterThan(5);
    expect(result.failures).toEqual([]);
  });

  it('every arts table has RLS forced on', async () => {
    const rows = await sql`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'arts' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('public sign-up is disabled', async () => {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error } = await anon.auth.signUp({ email: 'stranger@example.com', password: 'correct-horse-battery' });
    expect(error).not.toBeNull();
  });
});

describe('Phase 1: admin access (MFA for developers)', () => {
  const email = `admin-${Date.now()}@example.com`;
  const password = 'test-password-123456';

  it('a developer without a verified TOTP factor reads nothing; with it, reads data', async () => {
    const { data: created, error } = await service.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { role: 'developer' },
    });
    expect(error).toBeNull();

    const client = createClient<any, 'arts'>(url, anonKey, { db: { schema: 'arts' }, auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    // aal1: RLS hides every row.
    const before = await client.from('customers').select('id');
    expect(before.error).toBeNull();
    expect(before.data).toEqual([]);

    // Enroll and verify TOTP to reach aal2.
    const enroll = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'test' });
    expect(enroll.error).toBeNull();
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll.data!.totp.secret) });
    const challenge = await client.auth.mfa.challenge({ factorId: enroll.data!.id });
    const verify = await client.auth.mfa.verify({
      factorId: enroll.data!.id, challengeId: challenge.data!.id, code: totp.generate(),
    });
    expect(verify.error).toBeNull();

    const after = await client.from('customers').select('id');
    expect(after.error).toBeNull();
    expect(after.data!.length).toBeGreaterThan(0);

    // Admins still cannot write directly: writes go through server code.
    const write = await client.from('customers').insert({ name: 'Direct write' });
    expect(write.error).not.toBeNull();

    await service.auth.admin.deleteUser(created.user!.id);
  });

  it('owners and staff read data with email and password only, and still cannot write', async () => {
    const e2 = `staff-pw-${Date.now()}@example.com`;
    const { data: created } = await service.auth.admin.createUser({ email: e2, password, email_confirm: true, app_metadata: { role: 'staff' } });
    const client = createClient<any, 'arts'>(url, anonKey, { db: { schema: 'arts' }, auth: { persistSession: false } });
    await client.auth.signInWithPassword({ email: e2, password });
    const rows = await client.from('customers').select('id');
    expect(rows.data!.length).toBeGreaterThan(0);
    expect((await client.from('customers').insert({ name: 'Direct write' })).error).not.toBeNull();
    await service.auth.admin.deleteUser(created.user!.id);
  });

  it('a signed-in user without an admin role reads nothing even with MFA claims', async () => {
    const e2 = `user-${Date.now()}@example.com`;
    const { data: created } = await service.auth.admin.createUser({ email: e2, password, email_confirm: true });
    const client = createClient<any, 'arts'>(url, anonKey, { db: { schema: 'arts' }, auth: { persistSession: false } });
    await client.auth.signInWithPassword({ email: e2, password });
    const r = await client.from('customers').select('id');
    expect(r.data ?? []).toEqual([]);
    await service.auth.admin.deleteUser(created.user!.id);
  });
});
