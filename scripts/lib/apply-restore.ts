import postgres from 'postgres';
import { BACKUP_TABLES } from '../../server/backup.js';

// Replaces every arts table with the snapshot, in one transaction.
export async function applyRestore(databaseUrl: string, snap: { tables: Record<string, any[]> }) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`truncate ${BACKUP_TABLES.map((t) => `arts.${t}`).join(', ')} cascade`);
      // Bookings reference each other (replaces_booking_id): insert without, then patch.
      for (const t of BACKUP_TABLES) {
        let rows = snap.tables[t] ?? [];
        if (!rows.length) continue;
        if (t === 'bookings') rows = rows.map((r) => ({ ...r, replaces_booking_id: null }));
        if (t === 'customers') rows = rows.map((r) => ({ ...r, merged_into: null }));
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const overriding = t === 'audit_log' ? 'overriding system value' : '';
          await tx.unsafe(`insert into arts.${t} ${overriding} select * from jsonb_populate_recordset(null::arts.${t}, $1::text::jsonb)`, [JSON.stringify(chunk)]);
        }
      }
      for (const b of (snap.tables.bookings ?? []).filter((r) => r.replaces_booking_id)) {
        await tx`update arts.bookings set replaces_booking_id = ${b.replaces_booking_id} where id = ${b.id}`;
      }
      for (const c of (snap.tables.customers ?? []).filter((r) => r.merged_into)) {
        await tx`update arts.customers set merged_into = ${c.merged_into} where id = ${c.id}`;
      }
      await tx.unsafe(`select setval(pg_get_serial_sequence('arts.audit_log', 'id'), coalesce((select max(id) from arts.audit_log), 1))`);
    });
  } finally {
    await sql.end();
  }
}
