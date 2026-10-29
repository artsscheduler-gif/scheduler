import { describe, it, expect, afterAll } from 'vitest';
import { sql, resetData } from './helpers';
import { encrypt, decrypt, runBackup, downloadBackup, snapshot } from '../../server/backup';
import { applyRestore } from '../../scripts/lib/apply-restore';
import { randomBytes } from 'node:crypto';

afterAll(() => sql.end());

describe('Backups', () => {
  it('encrypts with AES-256-GCM and rejects tampering or a wrong key', () => {
    const data = { hello: 'world', n: [1, 2, 3] };
    const buf = encrypt(data);
    expect(buf.includes(Buffer.from('world'))).toBe(false);
    expect(decrypt(buf)).toEqual(data);
    const bad = Buffer.from(buf);
    bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad)).toThrow();
    expect(() => decrypt(buf, randomBytes(32).toString('hex'))).toThrow();
  });

  it('uploads to private storage and restores to an identical database', async () => {
    await resetData();
    const [c] = await sql`insert into arts.customers (name, email, merged_into) values ('Backup Bea', 'bea@example.com', null) returning id`;
    await sql`insert into arts.customers (name, merged_into) values ('Old Bea', ${c.id})`;
    await sql`insert into arts.audit_log (actor_type, action, entity) values ('system', 'test', 'x')`;
    const before = await snapshot();
    const r = await runBackup();
    expect(r.backup).toMatch(/^arts-\d{4}-\d{2}-\d{2}\.bak$/);

    await sql`truncate arts.customers, arts.audit_log cascade`;
    const restored = decrypt(await downloadBackup(r.backup));
    await applyRestore(process.env.DATABASE_URL!, restored);
    const after = await snapshot();
    expect(after.tables).toEqual(before.tables);
    // Sequences continue past restored ids.
    await sql`insert into arts.audit_log (actor_type, action, entity) values ('system', 'after-restore', 'x')`;
  });
});
