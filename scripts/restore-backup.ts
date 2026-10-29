// Restore a backup.
//   npm run backup:restore -- --list
//   npm run backup:restore -- --name arts-2026-11-01.bak            (decrypt to backups/ as JSON, no DB changes)
//   npm run backup:restore -- --file path.bak --apply --yes          (REPLACES all arts data in the target DB)
// Uses SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BACKUP_ENCRYPTION_KEY / DATABASE_URL from the environment.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const { decrypt, downloadBackup } = await import('../server/backup.js');
const { db } = await import('../server/db.js');
const { applyRestore } = await import('./lib/apply-restore.js');

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--list')) {
  const { data } = await db().storage.from('backups').list('', { sortBy: { column: 'name', order: 'desc' } });
  for (const f of data ?? []) console.log(f.name, f.metadata?.size ?? '');
  process.exit(0);
}

const buf = arg('--file') ? readFileSync(arg('--file')!) : arg('--name') ? await downloadBackup(arg('--name')!) : null;
if (!buf) {
  console.error('Pass --list, --name <backup>, or --file <path>');
  process.exit(1);
}
const snap = decrypt(buf);
mkdirSync('backups', { recursive: true });
const out = `backups/restore-${snap.created_at.slice(0, 19).replace(/[:]/g, '-')}.json`;
writeFileSync(out, JSON.stringify(snap, null, 1));
console.log(`Decrypted backup from ${snap.created_at} → ${out}`);
for (const [t, rows] of Object.entries(snap.tables)) console.log(`  ${t}: ${(rows as unknown[]).length}`);

if (args.includes('--apply')) {
  if (!args.includes('--yes')) {
    console.error('Refusing to overwrite the database without --yes.');
    process.exit(1);
  }
  await applyRestore(process.env.DATABASE_URL!, snap);
  console.log('Restore applied.');
}
process.exit(0);
