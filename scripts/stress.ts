// Load tests: how the app holds up under volume and people acting at once.
//
//   npm run stress                 local database (wiped first):
//                                    - 50 people grab one slot at the same moment
//                                    - 5,000 customers due for a reminder on one day
//                                    - a 20,000-row TRACS export
//   npm run stress -- --staging    staging, kept small and cleaned up after:
//                                    - 25 simultaneous bookings for one slot
//                                    - 60 simultaneous availability lookups
//
// Writes tests/lab/out/stress.md.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const STAGING = process.argv.includes('--staging');
const out: string[] = [`# Load tests (${STAGING ? 'staging' : 'local'}) — ${new Date().toISOString().slice(0, 16)}`, ''];
const say = (line = '') => {
  console.log(line);
  out.push(line);
};
const ms = (t0: number) => Date.now() - t0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l.includes('=') || l.startsWith('#')) continue;
    const k = l.slice(0, l.indexOf('='));
    process.env[k] ??= l.slice(l.indexOf('=') + 1);
  }
}

async function local() {
  loadEnv('.env.local');
  process.env.EMAIL_PROVIDER = 'stub';
  process.env.MAIL_PROVIDER = 'stub';
  process.env.VITEST = '1'; // quiet stub providers, no retry pauses
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL!, { max: 20, onnotice: () => {} });
  const { getSettings } = await import('../server/db.js');
  const { runServiceReminders, planServiceReminders, JOB_BUDGET_MS, today } = await import('../server/reminders.js');
  const { StubEmailProvider } = await import('../server/email/provider.js');
  const { planImport } = await import('../server/import.js');
  const { commitImport, loadImportContext } = await import('../server/import-db.js');
  const reset = async () => {
    await sql`truncate arts.audit_log, arts.email_log, arts.reminder_sends, arts.mail_batches, arts.service_history, arts.booking_services, arts.bookings,
      arts.vehicles, arts.customer_match_dismissals, arts.customer_merges, arts.customers, arts.closures, arts.time_blocks, arts.rate_limits, arts.job_runs, arts.email_outbox cascade`;
  };
  const services = await sql`select id::text, name from arts.services order by sort_order`;
  const oil = services.find((s) => s.name === 'Oil change')!.id;

  // ---- 1. Race for one slot ----------------------------------------------------
  say('## 50 people book the same slot at the same moment');
  await reset();
  await sql`update arts.shop_settings set waiter_lanes = 1 where id = 1`;
  const [{ d }] = await sql`select d::date::text as d from generate_series(arts.today() + 3, arts.today() + 20, interval '1 day') d where extract(isodow from d) <= 5 order by d limit 1`;
  let t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => sql`select arts.create_booking(${sql.json({
    date: d, kind: 'wait', start_time: '09:00', service_ids: [oil], created_by_type: 'public',
    customer: { name: `Race Person${i}`, email: `race${i}@example.com`, phone: `+1610555${String(3000 + i)}` },
    vehicle: { year: 2016, make: 'Honda', model: 'Civic' }, actor: { type: 'customer', label: 'stress' },
  } as any)}) as r`.then(([x]) => x.r)));
  const won = results.filter((r) => r.ok).length;
  say(`- ${won} of 50 got the 09:00 waiter slot (1 waiter lane): ${won === 1 ? 'correct' : '**WRONG**'}; ${ms(t0)} ms for all 50`);
  const refusals = [...new Set(results.filter((r) => !r.ok).flatMap((r) => r.violations))];
  say(`- the rest were told: ${refusals.join(', ')}`);
  await sql`update arts.shop_settings set waiter_lanes = 2 where id = 1`;
  t0 = Date.now();
  const spread = await Promise.all(Array.from({ length: 200 }, (_, i) => sql`select arts.create_booking(${sql.json({
    date: d, kind: i % 3 ? 'wait' : 'dropoff', start_time: `${String(8 + (i % 8)).padStart(2, '0')}:${i % 2 ? '00' : '30'}`, service_ids: [oil], created_by_type: 'public',
    customer: { name: `Busy Day${i}`, email: `busy${i}@example.com`, phone: `+1610556${String(3000 + i)}` },
    vehicle: { year: 2016, make: 'Honda', model: 'Civic' }, actor: { type: 'customer', label: 'stress' },
  } as any)}) as r`.then(([x]) => x.r)));
  const [{ used, cap }] = await sql`select (select coalesce(sum(total_minutes), 0)::int from arts.bookings where date = ${d}::date and status in ('requested', 'confirmed')) as used,
    (select (s.total_lanes * (h.close_min - h.open_min))::int from arts.shop_settings s, arts.day_hours(${d}::date) h where s.id = 1) as cap`;
  say(`- 200 more bookings fired at the same day at once: ${spread.filter((r) => r.ok).length} accepted, day ${used} of ${cap} minutes: ${used <= cap ? 'within capacity' : '**OVERBOOKED**'}; ${ms(t0)} ms`);
  say();

  // ---- 2. Reminder night ------------------------------------------------------------
  say('## 5,000 customers due for a reminder on the same day');
  await reset();
  await sql`update arts.shop_settings set reminders_dry_run = false where id = 1`;
  const s = await getSettings();
  const on = today(s);
  await sql`insert into arts.customers (name, email, source)
    select 'Due Customer ' || g, 'due' || g || '@example.com', 'import' from generate_series(1, 5000) g`;
  // Due in 14 days: the first email step (14 days before) fires today.
  await sql`insert into arts.service_history (customer_id, service_id, service_date, source)
    select id, ${oil}, ((${on}::date + 14) - interval '6 months')::date, 'import' from arts.customers`;
  // Behave like Resend: a batch call of up to 100 takes about this long.
  const SEND_MS = Number(process.env.STRESS_SEND_MS ?? 600);
  const proto = StubEmailProvider.prototype as any;
  proto.sendBatch = async function (msgs: any[]) {
    await new Promise((r) => setTimeout(r, SEND_MS));
    return Promise.all(msgs.map((m) => this.send(m)));
  };
  t0 = Date.now();
  const plan = await planServiceReminders(s, on);
  const planMs = ms(t0);
  say(`- working out who's due: ${plan.length} reminders in ${planMs} ms (each run has ${JOB_BUDGET_MS} ms in total)`);
  let runs = 0;
  let sent = 0;
  const perRun: number[] = [];
  while (runs < 400) {
    runs++;
    t0 = Date.now();
    const r = await runServiceReminders(s, on, Date.now() + JOB_BUDGET_MS);
    perRun.push(r.emailed);
    sent += r.emailed;
    if (ms(t0) > 9500) say(`- **run ${runs} took ${ms(t0)} ms: over Vercel’s 10 s limit**`);
    if (!r.more) break;
  }
  const avg = Math.round(sent / runs);
  say(`- with ${SEND_MS} ms per batch call to the email provider, each run sends about ${avg}; all ${sent} took ${runs} runs`);
  // The daily run plus one catch-up run per hour from 8am to 6pm.
  const perDay = 1 + 10;
  say(`- the schedule allows ${perDay} runs a day, so ${Math.ceil(runs / perDay)} day(s) to get through a day like this${runs > perDay ? ' — **reminders would arrive days late**' : ''}`);
  say('- (the local database answers in about 1 ms; the hosted one takes 10–30 ms per query, so expect fewer per run on the real site)');
  delete proto.sendBatch;
  say();

  // ---- 3. Big TRACS export ------------------------------------------------------------
  say('## A 20,000-row TRACS export');
  await reset();
  const mapping = JSON.parse(readFileSync('import/epicor-mapping.json', 'utf8'));
  const rows: Record<string, string>[] = [];
  for (let i = 0; rows.length < 20000; i++) {
    for (let v = 0; v < 1 + (i % 3); v++) {
      rows.push({
        'Customer ID': `C${i}`, 'Customer Name': `Customer ${i} Last${i % 900}`, Email: i % 4 ? `c${i}@example.com` : '', Phone: `610${String(2000000 + i)}`,
        Address: `${i} Main St`, City: 'Allentown', State: 'PA', Zip: '18104', Year: String(2000 + (i % 25)), Make: ['FORD', 'HONDA', 'TOYOTA'][i % 3], Model: 'MODEL' + (i % 7),
        'Last Service Date': `${1 + (i % 12)}/${1 + (i % 28)}/2025`, 'Last Service Type': ['LOF', 'PA State Inspection', 'Rotate Tires'][v % 3],
      });
    }
  }
  t0 = Date.now();
  const ctx = await loadImportContext();
  const p = planImport(rows, mapping, ctx.services, ctx.existing);
  say(`- reading and checking: ${p.customers.length} customers from ${rows.length} rows in ${ms(t0)} ms`);
  t0 = Date.now();
  const r1 = await commitImport(p, 'stress-1');
  say(`- first import: ${r1.created} customers, ${r1.vehicles} cars, ${r1.history} visits in ${Math.round(ms(t0) / 1000)} s (locally; expect several times longer against the hosted database)`);
  t0 = Date.now();
  const ctx2 = await loadImportContext();
  const r2 = await commitImport(planImport(rows, mapping, ctx2.services, ctx2.existing), 'stress-2');
  say(`- the same export again (next month, nothing new): ${r2.created} new customers, ${r2.vehicles} cars, ${r2.history} visits in ${Math.round(ms(t0) / 1000)} s: ${r2.created + r2.vehicles + r2.history === 0 ? 'nothing duplicated' : '**DUPLICATES**'}`);
  t0 = Date.now();
  const [{ n }] = await sql`select count(*)::int as n from arts.customer_match_candidates()`;
  say(`- match list after the import: ${n} pairs in ${ms(t0)} ms`);
  await reset();
  await sql`update arts.shop_settings set reminders_dry_run = true where id = 1`;
  await sql.end();
}

async function staging() {
  const env = '/private/tmp/claude-501/-Users-jake/b24335ed-1712-4e49-bac7-07fed3fcef14/scratchpad/loadenv.sh';
  if (!process.env.SUPABASE_URL || !process.env.STAGING_URL) throw new Error(`Load staging env first (source ${env})`);
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient<any, 'arts'>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: 'arts' }, auth: { persistSession: false } });
  const runId = Date.now().toString(36);
  const { data: svc } = await db.from('services').select('id, name').eq('name', 'Oil change').single();
  const { data: days } = await db.rpc('available_slot_days', { p_service_ids: [svc!.id] });
  const day = (days as string[])[3] ?? (days as string[])[0];
  const { data: slots } = await db.rpc('available_slots', { p_service_ids: [svc!.id], p_date: day });
  const slot = (slots as any[]).find((x) => x.wait);
  const { data: settings } = await db.from('shop_settings').select('waiter_lanes').eq('id', 1).single();
  const { data: there } = await db.from('bookings').select('start_time, total_minutes').eq('date', day).eq('kind', 'wait').in('status', ['requested', 'confirmed']);
  const st = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const busy = (there ?? []).filter((b) => st(b.start_time) <= st(slot.start_time) && st(b.start_time) + b.total_minutes > st(slot.start_time)).length;
  const room = settings!.waiter_lanes - busy;

  say(`## 25 simultaneous bookings for one slot (staging, ${day} ${slot.start_time.slice(0, 5)})`);
  let t0 = Date.now();
  const res = await Promise.all(Array.from({ length: 25 }, (_, i) => db.rpc('create_booking', {
    p: {
      date: day, kind: 'wait', start_time: slot.start_time.slice(0, 5), service_ids: [svc!.id], created_by_type: 'public',
      customer: { name: `Stress Test${i}`, email: `stress-${runId}-${i}@sim.invalid`, phone: null },
      vehicle: { year: 2016, make: 'Honda', model: 'Civic' }, actor: { type: 'customer', label: 'stress test' },
    },
  })));
  const ok = res.filter((r) => (r.data as any)?.ok).length;
  const errors = res.filter((r) => r.error).length;
  say(`- room for ${room} more waiter(s) at that time; ${ok} of 25 got in, ${errors} errors, ${ms(t0)} ms: ${ok <= room && ok >= Math.min(1, room) && !errors ? 'correct' : '**WRONG**'}`);

  say('## 60 simultaneous availability lookups (staging website)');
  t0 = Date.now();
  const timings: number[] = [];
  const statuses = await Promise.all(Array.from({ length: 60 }, async (_, i) => {
    const t = Date.now();
    const r = await fetch(`${process.env.STAGING_URL}/api/availability?services=${svc!.id}${i % 2 ? `&date=${day}` : ''}`);
    timings.push(Date.now() - t);
    return r.status;
  }));
  const by = statuses.reduce<Record<number, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  say(`- responses: ${Object.entries(by).map(([k, v]) => `${v} × ${k}`).join(', ')}; median ${pct(timings, 50)} ms, slowest 5% ${pct(timings, 95)} ms, all done in ${ms(t0)} ms`);
  say(by[500] || by[502] || by[504] ? '- **some requests failed**' : '- no failures');

  // Clean up everything this run made.
  const { data: custs } = await db.from('customers').select('id').like('email', `stress-${runId}-%@sim.invalid`);
  const ids = (custs ?? []).map((c) => c.id);
  if (ids.length) {
    const { data: bks } = await db.from('bookings').select('id').in('customer_id', ids);
    const bids = (bks ?? []).map((b) => b.id);
    if (bids.length) {
      await db.from('booking_services').delete().in('booking_id', bids);
      await db.from('bookings').delete().in('id', bids);
    }
    await db.from('vehicles').delete().in('customer_id', ids);
    await db.from('customers').delete().in('id', ids);
  }
  const { count } = await db.from('customers').select('id', { count: 'exact', head: true }).like('email', `stress-${runId}-%@sim.invalid`);
  say(`- cleaned up: ${ids.length} test customers removed (${count ?? 0} left)`);
}

await (STAGING ? staging() : local());
mkdirSync('tests/lab/out', { recursive: true });
writeFileSync(`tests/lab/out/stress${STAGING ? '-staging' : ''}.md`, out.join('\n') + '\n');
