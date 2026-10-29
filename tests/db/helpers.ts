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
    arts.booking_services, arts.bookings, arts.vehicles, arts.customers, arts.closures, arts.rate_limits, arts.job_runs cascade`;
  await sql`delete from arts.shop_settings`;
  await sql`insert into arts.shop_settings (id) values (1)`;
  await sql`update arts.services set approval_level = 'approve', approvals_in_a_row = 0, last_undo_at = null, active = true`;
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
