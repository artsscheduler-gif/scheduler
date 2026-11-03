// Weekly encrypted export to private Supabase Storage. Never emailed.
// Format: "ARTSBK1" | iv (12) | auth tag (16) | AES-256-GCM(gzip(JSON)).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { db } from './db.js';
import { env } from './env.js';

export const BACKUP_TABLES = [
  'shop_settings', 'closures', 'time_blocks', 'services', 'customers', 'vehicles', 'bookings', 'booking_services', 'service_history',
  'reminder_rules', 'mail_batches', 'reminder_sends', 'email_log', 'audit_log', 'job_runs',
] as const;
const MAGIC = Buffer.from('ARTSBK1');
const BUCKET = 'backups';

function key(hex = env.backupKey): Buffer {
  const k = Buffer.from(hex, 'hex');
  if (k.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes of hex');
  return k;
}

export function encrypt(data: object, keyHex?: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(keyHex), iv);
  const body = Buffer.concat([c.update(gzipSync(JSON.stringify(data))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decrypt(buf: Buffer, keyHex?: string): any {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Art’s backup file');
  const iv = buf.subarray(7, 19);
  const tag = buf.subarray(19, 35);
  const d = createDecipheriv('aes-256-gcm', key(keyHex), iv);
  d.setAuthTag(tag);
  return JSON.parse(gunzipSync(Buffer.concat([d.update(buf.subarray(35)), d.final()])).toString('utf8'));
}

export async function snapshot(): Promise<{ version: 1; created_at: string; tables: Record<string, unknown[]> }> {
  const tables: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db().from(t).select('*').range(from, from + 999);
      if (error) throw new Error(`${t}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    tables[t] = rows;
  }
  return { version: 1, created_at: new Date().toISOString(), tables };
}

export async function runBackup(keepWeeks = 12) {
  const snap = await snapshot();
  const file = encrypt(snap);
  const storage = db().storage;
  const { data: buckets } = await storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) await storage.createBucket(BUCKET, { public: false });
  const name = `arts-${snap.created_at.slice(0, 10)}.bak`;
  const { error } = await storage.from(BUCKET).upload(name, file, { contentType: 'application/octet-stream', upsert: true });
  if (error) throw new Error(`backup upload: ${error.message}`);
  const { data: list } = await storage.from(BUCKET).list('', { sortBy: { column: 'name', order: 'desc' } });
  const old = (list ?? []).filter((f) => f.name.endsWith('.bak')).slice(keepWeeks).map((f) => f.name);
  if (old.length) await storage.from(BUCKET).remove(old);
  const rows = Object.values(snap.tables).reduce((n, r) => n + r.length, 0);
  return { backup: name, bytes: file.length, rows, pruned: old.length };
}

export async function downloadBackup(name: string): Promise<Buffer> {
  const { data, error } = await db().storage.from(BUCKET).download(name);
  if (error || !data) throw new Error(`download ${name}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}
