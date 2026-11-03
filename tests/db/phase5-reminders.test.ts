import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, resetData, serviceId, weekdayAhead, adminToken, reqWith } from './helpers';
import { daily, today } from '../../server/reminders';
import { getSettings } from '../../server/db';
import { adminAction } from '../../server/admin';
import { StubEmailProvider } from '../../server/email/provider';
import { StubMailProvider } from '../../server/mail/provider';

afterAll(() => sql.end());

let ids: Record<string, string> = {};

// Inserts a customer whose `service` comes due `dueInDays` from today.
async function customer(label: string, service: string, dueInDays: number, extra: Record<string, unknown> = {}) {
  const months = service === 'State inspection' ? 12 : 6;
  const [c] = await sql`insert into arts.customers ${sql({
    name: `${label} Person`, email: `${label.toLowerCase()}@example.com`, address_line1: '1 Main St', city: 'Easton', state: 'PA', postal_code: '18042', source: 'import', ...extra,
  })} returning id`;
  const [v] = await sql`insert into arts.vehicles (customer_id, year, make, model) values (${c.id}, 2015, 'Honda', 'Fit') returning id`;
  await sql`insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, source)
    values (${c.id}, ${v.id}, ${await serviceId(service)}, (arts.today() + ${dueInDays}::int - make_interval(months => ${months}))::date, 'import')`;
  ids[label] = c.id;
  return { id: c.id as string, vehicle: v.id as string };
}

async function seedScenario() {
  await customer('Ann', 'Oil change', 10); // step 1 fires (send_on = due-14)
  await customer('Ben', 'Oil change', 0); // due today: step 1 superseded, step 2 postcard
  await customer('Cal', 'Oil change', 30); // nothing yet
  await customer('Dee', 'Oil change', -40); // step 3 (due+30) fires; 1 and 2 superseded
  await customer('Eve', 'Oil change', -400); // older than max overdue: ignored
  const fay = await customer('Fay', 'Oil change', 5);
  await sql`insert into arts.bookings (root_id, customer_id, date, kind, total_minutes, status, created_by_type, start_time)
    values (gen_random_uuid(), ${fay.id}, arts.today() + 3, 'wait', 55, 'confirmed', 'public', '09:00')`; // booked since: stop
  await customer('Gus', 'Oil change', 5, { email_opt_out: true }); // email blocked
  await customer('Hal', 'Oil change', 0, { mail_opt_out: true }); // postcard blocked
  await customer('Ivy', 'Brakes', 0); // no reminder interval: ignored
  const jo = await customer('Jo', 'Oil change', 10);
  await sql`insert into arts.reminder_sends (customer_id, vehicle_id, service_id, due_date, step, channel, status)
    values (${jo.id}, ${jo.vehicle}, ${await serviceId('Oil change')}, arts.today() + 10, 1, 'email', 'sent')`; // already done
  await customer('Kim', 'State inspection', -1, { address_line1: '99 UNDELIVERABLE Rd' }); // due yesterday → postcard, bad address
}

async function sends() {
  const rows = await sql`select c.name, r.step, r.channel::text, r.status, r.error from arts.reminder_sends r join arts.customers c on c.id = r.customer_id
    where r.created_at > now() - interval '1 minute' order by c.name, r.step`;
  return rows.map((r) => `${r.name.split(' ')[0]} ${r.step} ${r.channel} ${r.status}${r.error ? ` (${r.error})` : ''}`);
}

beforeEach(async () => {
  await resetData();
  ids = {};
  StubEmailProvider.outbox = [];
  StubMailProvider.sent = [];
  await sql`update arts.shop_settings set shop_address = '123 Example St, Easton, PA 18042', staff_notify_email = 'chris@example.com'`;
});

describe('Phase 5: dry run on seed data', () => {
  it('yields the expected due list and sends nothing', async () => {
    await seedScenario();
    const s = await getSettings();
    expect(s.reminders_dry_run).toBe(true);
    await daily(s);
    expect(await sends()).toEqual([
      'Ann 1 email dry_run',
      'Ben 1 email skipped (superseded by a later step)',
      'Ben 2 postcard dry_run',
      'Dee 1 email skipped (superseded by a later step)',
      'Dee 2 postcard skipped (superseded by a later step)',
      'Dee 3 email dry_run',
      'Gus 1 email skipped (opted out of email)',
      'Hal 1 email skipped (superseded by a later step)',
      'Hal 2 postcard skipped (opted out of mail)',
      'Jo 1 email sent', // pre-existing; nothing new for Jo
      'Kim 1 email skipped (superseded by a later step)',
      'Kim 2 postcard dry_run',
    ]);
    expect(StubEmailProvider.outbox).toEqual([]);
    expect(StubMailProvider.sent).toEqual([]);
    const [{ c }] = await sql`select count(*)::int as c from arts.mail_batches`;
    expect(c).toBe(0);
  });
});

describe('Phase 5: live reminders', () => {
  it('emails, batches postcards for approval, and never contacts opt-outs', async () => {
    await seedScenario();
    await sql`update arts.shop_settings set reminders_dry_run = false`;
    const s = await getSettings();
    const r = await daily(s);
    expect(r).toMatchObject({ emailed: 2, batched: 2, dry_run: 0 });
    const to = StubEmailProvider.outbox.map((m) => m.to).sort();
    expect(to).toEqual(['ann@example.com', 'dee@example.com']);
    const ann = StubEmailProvider.outbox.find((m) => m.to === 'ann@example.com')!;
    expect(ann.html).toContain('/unsubscribe?t=');
    expect(ann.html).toContain('123 Example St'); // physical address in every marketing email
    expect(ann.headers?.['List-Unsubscribe']).toMatch(/unsubscribe/);
    expect(StubEmailProvider.outbox.find((m) => m.to === 'dee@example.com')!.subject).toMatch(/overdue/);

    // Postcards wait for approval.
    expect(StubMailProvider.sent).toEqual([]);
    const [batch] = await sql`select id, status, count, est_cost_cents from arts.mail_batches`;
    expect(batch).toMatchObject({ status: 'draft', count: 2, est_cost_cents: 160 });

    // Running again the same day sends nothing new.
    StubEmailProvider.outbox = [];
    const again = await daily(s);
    expect(again).toMatchObject({ emailed: 0, batched: 0 });

    // Hal opts out of nothing new; Ben opts out of mail after batching: the opt-out still wins.
    await sql`update arts.customers set mail_opt_out = true where id = ${ids.Ben}`;
    const { token } = await adminToken('owner');
    const res = await adminAction(reqWith(token), 'batch-approve', { batch_id: batch.id });
    expect(res.body).toMatchObject({ sent: 0, undeliverable: 1, failed: 0 });
    const [kim] = await sql`select address_undeliverable from arts.customers where id = ${ids.Kim}`;
    expect(kim.address_undeliverable).toBe(true);
    expect(StubMailProvider.sent).toEqual([]);

    const contacted = await sql`select distinct c.name from arts.reminder_sends r join arts.customers c on c.id = r.customer_id
      where r.status in ('sent', 'batched') and (c.email_opt_out or c.mail_opt_out)
      and ((r.channel = 'email' and c.email_opt_out) or (r.channel = 'postcard' and c.mail_opt_out))`;
    expect(contacted).toEqual([]);
  });

  it('approving a batch mails a deliverable postcard with a tracked QR link', async () => {
    await customer('Lou', 'Oil change', 0);
    await sql`update arts.shop_settings set reminders_dry_run = false`;
    await daily(await getSettings());
    const [batch] = await sql`select id from arts.mail_batches`;
    const { token } = await adminToken('owner');
    const res = await adminAction(reqWith(token), 'batch-approve', { batch_id: batch.id });
    expect(res.body).toMatchObject({ sent: 1 });
    const job = StubMailProvider.sent[0];
    expect(job.to).toMatchObject({ name: 'Lou Person', zip: '18042' });
    expect(job.from).toMatchObject({ line1: '123 Example St', city: 'Easton', state: 'PA' });
    expect(job.back).toContain('data:image/png;base64,');
    expect(job.front).toContain('oil change');
    const [b] = await sql`select status from arts.mail_batches where id = ${batch.id}`;
    expect(b.status).toBe('sent');
  });

  it('a new booking stops the sequence', async () => {
    const lou = await customer('Mo', 'Oil change', 10);
    await sql`insert into arts.bookings (root_id, customer_id, date, kind, total_minutes, status, created_by_type)
      values (gen_random_uuid(), ${lou.id}, arts.today() + 20, 'dropoff', 55, 'requested', 'public')`;
    await sql`update arts.shop_settings set reminders_dry_run = false`;
    expect(await daily(await getSettings())).toMatchObject({ due_steps: 0, emailed: 0 });
  });

  it('alerts Jake when send failures pass the threshold', async () => {
    await customer('Ned', 'Oil change', 10);
    await sql`update arts.shop_settings set reminders_dry_run = false, owner_alert_email = 'jake@example.com'`;
    StubEmailProvider.failNext = 3; // all retries for Ned fail
    const r = await daily(await getSettings());
    expect(r).toMatchObject({ failed: 1, failure_pct: 100 });
    expect(StubEmailProvider.outbox.some((m) => m.to === 'jake@example.com' && /Send failures/.test(m.subject))).toBe(true);
    // A failed step retries on the next run.
    StubEmailProvider.outbox = [];
    expect(await daily(await getSettings())).toMatchObject({ emailed: 1 });
  });
});

describe('Phase 5: appointment reminders and digest', () => {
  it('reminds confirmed customers [48] hours ahead, once', async () => {
    const oil = await serviceId('Oil change');
    const [c] = await sql`insert into arts.customers (name, email) values ('Pia', 'pia@example.com') returning id`;
    for (const d of [2, 5]) {
      const [b] = await sql`insert into arts.bookings (root_id, customer_id, date, kind, total_minutes, status, created_by_type, start_time)
        values (gen_random_uuid(), ${c.id}, arts.today() + ${d}::int, 'wait', 55, 'confirmed', 'public', '10:00') returning id`;
      await sql`update arts.bookings set root_id = id where id = ${b.id}`;
      await sql`insert into arts.booking_services values (${b.id}, ${oil})`;
    }
    const s = await getSettings();
    expect(await daily(s)).toMatchObject({ appointment_reminders: 1 });
    expect(StubEmailProvider.outbox.filter((m) => m.to === 'pia@example.com')[0].subject).toMatch(/^Reminder/);
    expect(await daily(s)).toMatchObject({ appointment_reminders: 0 });
  });

  it('sends Chris one digest of step 3 bookings', async () => {
    const oil = await serviceId('Oil change');
    const day = await weekdayAhead(3);
    const [c] = await sql`insert into arts.customers (name, email) values ('Quinn', 'q@example.com') returning id`;
    const [b] = await sql`insert into arts.bookings (root_id, customer_id, date, kind, total_minutes, status, created_by_type, start_time, auto_confirmed, approval_level)
      values (gen_random_uuid(), ${c.id}, ${day}, 'wait', 55, 'confirmed', 'public', '10:00', true, 'digest') returning id`;
    await sql`insert into arts.booking_services values (${b.id}, ${oil})`;
    const s = await getSettings();
    expect(await daily(s)).toMatchObject({ digest: 1 });
    expect(StubEmailProvider.outbox.find((m) => m.to === 'chris@example.com')!.text).toContain('Quinn');
    expect(await daily(s)).toMatchObject({ digest: 0 });
  });
});

describe('Phase 5: postcard renders', () => {
  it('renders front and back in a browser at postcard size', async () => {
    const { token } = await adminToken('staff');
    const r = (await adminAction(reqWith(token), 'postcard-preview', {})).body as any;
    expect(r.booking_url).toBe('https://book.artsservicecenter.com/?src=postcard');
    expect(r.back).toContain('data:image/png;base64,');
    const out = process.env.E2E_SHOTS;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 600, height: 408 } });
    for (const side of ['front', 'back'] as const) {
      await page.setContent(r[side]);
      const size = await page.evaluate(() => [document.body.offsetWidth, document.body.offsetHeight]);
      expect(size).toEqual([600, 408]); // 6.25in x 4.25in at 96dpi
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(`${out}/postcard-${side}.png`, await page.screenshot());
      }
    }
    await browser.close();
    expect(today(await getSettings())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
