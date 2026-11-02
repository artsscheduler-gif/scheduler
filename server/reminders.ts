// Service-due reminders, appointment reminders, the staff digest, and
// postcard batches. All run from the daily job.
import { db, getSettings, rpc, type ShopSettings } from './db.js';
import { env } from './env.js';
import type { Result } from './http.js';
import { HttpError } from './http.js';
import type { Admin } from './admin.js';
import type { JobSummary } from './jobs.js';
import { alertOwner } from './jobs.js';
import * as V from './validate.js';
import { sendEmail } from './email/send.js';
import { emailProvider } from './email/provider.js';
import { withRetry } from './retry.js';
import * as T from './email/templates.js';
import { unsubscribeUrl } from './tokens.js';
import { mailProvider, type Address } from './mail/provider.js';
import { renderPostcard, trackedBookingUrl } from './postcard.js';
import { loadBooking, manageLink, toView, vehicleText } from './bookings.js';
import { addDays } from '../shared/time.js';

interface Rule { id: string; step: number; channel: 'email' | 'postcard'; offset_days: number; condition: 'no_booking_since_due' | 'no_booking_since_previous_step'; active: boolean }
interface Customer {
  id: string; name: string; email: string | null; email_opt_out: boolean; mail_opt_out: boolean; email_bounced: boolean;
  address_undeliverable: boolean; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; postal_code: string | null;
}
export interface DueItem { customer_id: string; vehicle_id: string | null; service_id: string; last_date: string; due_date: string }

export function today(s: ShopSettings, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(now);
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export function hasAddress(c: Customer) {
  return !!(c.address_line1 && c.city && c.state && c.postal_code);
}

function addressOf(c: Customer): Address {
  return { name: c.name, line1: c.address_line1!, line2: c.address_line2, city: c.city!, state: c.state!, zip: c.postal_code! };
}

function shopAddress(s: ShopSettings): Address {
  // shop_address is one line: "Street, City, ST 12345".
  const m = s.shop_address.match(/^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) throw new Error('shop_address must look like "123 Main St, Town, PA 18000" to send postcards');
  return { name: s.shop_name, line1: m[1], city: m[2], state: m[3], zip: m[4] };
}

// The due list, limited to items where some reminder step could apply today.
export async function dueList(s: ShopSettings, on: string, rules: Rule[]): Promise<DueItem[]> {
  const rows = await rpc<DueItem[]>('due_list', {});
  const minOffset = Math.min(0, ...rules.map((r) => r.offset_days));
  const latest = addDays(on, -minOffset); // due dates up to here have a step on or before today
  const earliest = addDays(on, -s.reminder_max_overdue_days);
  return rows.filter((r) => r.due_date <= latest && r.due_date >= earliest);
}

type StepPlan = { item: DueItem; rule: Rule; action: 'send' | 'skip'; reason?: string };

// Decides which reminder steps fire today. Pure apart from reads.
export async function planServiceReminders(s: ShopSettings, on: string): Promise<StepPlan[]> {
  const { data: rulesData } = await db().from('reminder_rules').select('*').eq('active', true).order('step');
  const rules = (rulesData ?? []) as Rule[];
  if (!rules.length) return [];
  const items = await dueList(s, on, rules);
  if (!items.length) return [];

  const customerIds = [...new Set(items.map((i) => i.customer_id))];
  const [{ data: sends }, { data: bookings }] = await Promise.all([
    db().from('reminder_sends').select('customer_id, vehicle_id, service_id, due_date, step, status, created_at').in('customer_id', customerIds),
    db().from('bookings').select('customer_id, created_at, status').in('customer_id', customerIds).in('status', ['requested', 'confirmed', 'completed']),
  ]);

  const key = (i: { customer_id: string; vehicle_id: string | null; service_id: string; due_date: string }) => `${i.customer_id}|${i.vehicle_id ?? ''}|${i.service_id}|${i.due_date}`;
  const sentByKey = new Map<string, { step: number; status: string; created_at: string }[]>();
  for (const r of sends ?? []) {
    const k = key(r);
    sentByKey.set(k, [...(sentByKey.get(k) ?? []), r]);
  }
  const bookedAt = (customer: string) => (bookings ?? []).filter((b) => b.customer_id === customer).map((b) => b.created_at.slice(0, 10));

  const plan: StepPlan[] = [];
  for (const item of items) {
    const prior = sentByKey.get(key(item)) ?? [];
    const booked = bookedAt(item.customer_id);
    // The customer booked since the service that made them due: stop.
    if (booked.some((d) => d > item.last_date)) continue;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const done = prior.find((p) => p.step === rule.step && p.status !== 'failed');
      if (done) continue;
      const sendOn = addDays(item.due_date, rule.offset_days);
      if (sendOn > on) break;
      // Catching up (e.g. first run after import): only the latest step that's due fires.
      const next = rules[i + 1];
      if (next && addDays(item.due_date, next.offset_days) <= on) {
        plan.push({ item, rule, action: 'skip', reason: 'superseded by a later step' });
        continue;
      }
      const prev = [...prior].filter((p) => p.step < rule.step && ['sent', 'batched', 'dry_run'].includes(p.status)).sort((a, b) => b.step - a.step)[0];
      const since = rule.condition === 'no_booking_since_due' ? item.due_date : prev?.created_at.slice(0, 10) ?? item.due_date;
      if (booked.some((d) => d >= since)) break;
      plan.push({ item, rule, action: 'send' });
      break;
    }
  }
  return plan;
}

async function draftBatch(on: string): Promise<string> {
  const week = mondayOf(on);
  const { data: existing } = await db().from('mail_batches').select('id').eq('status', 'draft').eq('week_of', week).maybeSingle();
  if (existing) return existing.id;
  const { data } = await db().from('mail_batches').insert({ week_of: week }).select('id').single();
  return data!.id;
}

async function refreshBatch(s: ShopSettings, batchId: string) {
  const { count } = await db().from('reminder_sends').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('status', 'batched');
  await db().from('mail_batches').update({ count: count ?? 0, est_cost_cents: (count ?? 0) * s.postcard_cost_cents }).eq('id', batchId);
}

export async function runServiceReminders(s: ShopSettings, on: string) {
  const plan = await planServiceReminders(s, on);
  const out = { due_steps: plan.length, emailed: 0, batched: 0, skipped: 0, dry_run: 0, failed: 0 };
  if (!plan.length) return out;

  const customerIds = [...new Set(plan.map((p) => p.item.customer_id))];
  const [{ data: custs }, { data: svcs }, { data: vehicles }] = await Promise.all([
    db().from('customers').select('*').in('id', customerIds),
    db().from('services').select('id, name'),
    db().from('vehicles').select('id, year, make, model').in('customer_id', customerIds),
  ]);
  const cust = new Map((custs as Customer[]).map((c) => [c.id, c]));
  const svcName = new Map((svcs ?? []).map((x) => [x.id, x.name as string]));
  const veh = new Map((vehicles ?? []).map((v) => [v.id, vehicleText(v)]));
  let batchId: string | null = null;

  for (const p of plan) {
    const c = cust.get(p.item.customer_id)!;
    const base = {
      customer_id: c.id, vehicle_id: p.item.vehicle_id, service_id: p.item.service_id, due_date: p.item.due_date,
      rule_id: p.rule.id, step: p.rule.step, channel: p.rule.channel,
    };
    const record = async (status: string, extra: Record<string, unknown> = {}) => {
      // The unique index makes each step fire at most once per due cycle.
      let q = db().from('reminder_sends').select('id').eq('customer_id', c.id).eq('service_id', p.item.service_id).eq('due_date', p.item.due_date).eq('step', p.rule.step);
      q = p.item.vehicle_id ? q.eq('vehicle_id', p.item.vehicle_id) : q.is('vehicle_id', null);
      const existing = (await q.maybeSingle()).data;
      if (existing) await db().from('reminder_sends').update({ status, ...extra }).eq('id', existing.id);
      else await db().from('reminder_sends').insert({ ...base, status, ...extra });
    };

    if (p.action === 'skip') {
      await record('skipped', { error: p.reason });
      out.skipped++;
      continue;
    }

    // Opt-outs, bounces and bad addresses are never contacted.
    const blocked = p.rule.channel === 'email'
      ? (!c.email && 'no email') || (c.email_opt_out && 'opted out of email') || (c.email_bounced && 'email bounced')
      : (!hasAddress(c) && 'no mailing address') || (c.mail_opt_out && 'opted out of mail') || (c.address_undeliverable && 'address undeliverable');
    if (blocked) {
      await record('skipped', { error: blocked });
      out.skipped++;
      continue;
    }

    if (s.reminders_dry_run) {
      await record('dry_run');
      out.dry_run++;
      continue;
    }

    if (p.rule.channel === 'email') {
      const r = T.serviceDueEmail(s, {
        name: c.name.split(' ')[0] || c.name,
        service: svcName.get(p.item.service_id) ?? 'service',
        vehicle: (p.item.vehicle_id && veh.get(p.item.vehicle_id)) || '',
        dueDate: p.item.due_date,
        overdue: p.item.due_date < on,
        bookUrl: (() => { const u = new URL(s.booking_url); u.searchParams.set('src', `email-step${p.rule.step}`); return u.toString(); })(),
        unsubscribeUrl: unsubscribeUrl(c.id),
      });
      const unsub = unsubscribeUrl(c.id);
      const provider = emailProvider();
      const res = await withRetry(() => provider.send({
        kind: `service_due_step${p.rule.step}`,
        to: c.email!, from: `${s.from_name} <${s.from_email}>`, replyTo: s.from_email, ...r,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      }), 3, process.env.VITEST ? 1 : 500);
      if (res.error) {
        await record('failed', { error: res.error.message.slice(0, 500), attempts: res.tries });
        out.failed++;
      } else {
        await record('sent', { provider_id: res.value!.id, cost_cents: res.value!.costCents, sent_at: new Date().toISOString(), attempts: res.tries });
        out.emailed++;
      }
    } else {
      batchId ??= await draftBatch(on);
      await record('batched', { batch_id: batchId });
      out.batched++;
    }
  }
  if (batchId) await refreshBatch(s, batchId);
  return out;
}

// ---- Appointment reminders & digest ------------------------------------------

export async function runAppointmentReminders(s: ShopSettings, on: string) {
  const until = addDays(on, Math.ceil(s.appointment_reminder_hours / 24));
  const { data } = await db().from('bookings').select('id').eq('status', 'confirmed').is('reminder_sent_at', null).gt('date', on).lte('date', until);
  let sent = 0;
  let failed = 0;
  for (const { id } of data ?? []) {
    const l = await loadBooking(id);
    if (!l?.customer.email) continue;
    const ok = await sendEmail(s, { kind: 'appointment_reminder', to: l.customer.email, ...T.appointmentReminderEmail(s, toView(l), manageLink(s, l.booking)), bookingId: id, customerId: l.customer.id });
    if (ok) {
      await db().from('bookings').update({ reminder_sent_at: new Date().toISOString() }).eq('id', id);
      sent++;
    } else failed++;
  }
  return { appointment_reminders: sent, appointment_failed: failed };
}

export async function runDigest(s: ShopSettings) {
  const { data } = await db().from('bookings').select('id').eq('auto_confirmed', true).eq('approval_level', 'digest').is('digest_sent_at', null).neq('status', 'replaced');
  if (!data?.length) return { digest: 0 };
  const rows: [string, string][] = [];
  for (const { id } of data) {
    const l = await loadBooking(id);
    if (l) rows.push([l.customer.name, `${T.whenText(s, l.booking)} · ${l.services.map((x) => x.name).join(', ')} · ${l.booking.status}`]);
  }
  const ok = await sendEmail(s, {
    kind: 'staff_digest',
    to: s.staff_notify_email,
    ...T.staffEmail(s, {
      subject: `Daily digest: ${rows.length} booking${rows.length === 1 ? '' : 's'} auto-confirmed`,
      heading: 'Booked since yesterday',
      lines: ['These confirmed on their own (step 3 types). Nothing to do unless something looks off.'],
      details: rows,
      button: { label: 'Open admin', url: `${env.appUrl}/admin` },
    }),
  });
  if (ok) await db().from('bookings').update({ digest_sent_at: new Date().toISOString() }).in('id', data.map((d) => d.id));
  return { digest: rows.length };
}

// ---- Postcard batches -------------------------------------------------------

export async function sendBatch(s: ShopSettings, batchId: string, approvedBy: string | null) {
  const { data: batch } = await db().from('mail_batches').select('*').eq('id', batchId).single();
  if (!batch || batch.status === 'sent') throw new HttpError(409, { error: 'batch_not_open' });
  await db().from('mail_batches').update({ status: 'approved', approved_by: approvedBy, approved_at: new Date().toISOString() }).eq('id', batchId);

  const { data: sends } = await db().from('reminder_sends').select('id, customer_id, vehicle_id, service_id, due_date, customers(*), services(name), vehicles(year, make, model)').eq('batch_id', batchId).eq('status', 'batched');
  const mp = mailProvider();
  const from = shopAddress(s);
  let sent = 0;
  let undeliverable = 0;
  let failed = 0;
  for (const r of (sends ?? []) as any[]) {
    const c = r.customers as Customer;
    // Opt-outs recorded after batching still win.
    if (c.mail_opt_out || c.address_undeliverable || !hasAddress(c)) {
      await db().from('reminder_sends').update({ status: 'skipped', error: 'opted out or no address at send time' }).eq('id', r.id);
      continue;
    }
    try {
      const v = await withRetry(() => mp.verify(addressOf(c)), 3, process.env.VITEST ? 1 : 500);
      if (v.error) throw v.error;
      if (!v.value!.deliverable) {
        await db().from('customers').update({ address_undeliverable: true }).eq('id', c.id);
        await db().from('reminder_sends').update({ status: 'undeliverable', error: v.value!.detail }).eq('id', r.id);
        undeliverable++;
        continue;
      }
      const card = await renderPostcard(s, { name: c.name, service: r.services?.name ?? 'service', vehicle: vehicleText(r.vehicles), due_date: r.due_date });
      const res = await withRetry(() => mp.sendPostcard({ to: addressOf(c), from, front: card.front, back: card.back, size: s.postcard_size, idempotencyKey: r.id }), 3, process.env.VITEST ? 1 : 500);
      if (res.error) throw res.error;
      await db().from('reminder_sends').update({ status: 'sent', provider_id: res.value!.id, cost_cents: res.value!.costCents ?? s.postcard_cost_cents, sent_at: new Date().toISOString() }).eq('id', r.id);
      sent++;
    } catch (e) {
      await db().from('reminder_sends').update({ status: 'failed', error: (e as Error).message.slice(0, 500) }).eq('id', r.id);
      failed++;
    }
  }
  await db().from('mail_batches').update({ status: 'sent', sent_at: new Date().toISOString(), count: sent }).eq('id', batchId);
  return { sent, undeliverable, failed };
}

export async function approveBatch(a: Admin, body: unknown): Promise<Result> {
  const b = V.obj(body, ['batch_id']);
  const id = V.uuid(b.batch_id, 'batch_id');
  const s = await getSettings();
  const r = await sendBatch(s, id, a.id);
  await rpc('audit', { p_actor: { type: 'admin', id: a.id, label: a.label }, p_action: 'mail_batch.approve', p_entity: 'mail_batch', p_entity_id: id, p_before: null, p_after: r });
  return { status: 200, body: r };
}

export async function postcardPreview(body: unknown): Promise<Result> {
  const b = V.obj(body ?? {}, ['front_html', 'back_html']);
  const s = await getSettings();
  const card = await renderPostcard(
    s,
    { name: 'Pat Sample', service: 'Oil change', vehicle: '2017 Honda Accord', due_date: today(s) },
    {
      front: typeof b.front_html === 'string' && b.front_html.trim() ? b.front_html.slice(0, 20000) : undefined,
      back: typeof b.back_html === 'string' && b.back_html.trim() ? b.back_html.slice(0, 20000) : undefined,
    },
  );
  return { status: 200, body: { ...card, booking_url: trackedBookingUrl(s), size: s.postcard_size } };
}

// ---- Daily job --------------------------------------------------------------

export async function daily(s: ShopSettings, now = new Date()): Promise<JobSummary> {
  const on = today(s, now);
  const service = await runServiceReminders(s, on);
  const appt = await runAppointmentReminders(s, on);
  const digest = await runDigest(s);

  let autoBatches = 0;
  if (s.postcard_auto_approve && !s.reminders_dry_run) {
    const { data } = await db().from('mail_batches').select('id').eq('status', 'draft').lt('week_of', mondayOf(on));
    for (const b of data ?? []) {
      await sendBatch(s, b.id, null);
      autoBatches++;
    }
  }

  const attempts = service.emailed + service.failed + appt.appointment_reminders + appt.appointment_failed;
  const failures = service.failed + appt.appointment_failed;
  const failurePct = attempts ? (100 * failures) / attempts : 0;
  if (failurePct > s.alert_send_failure_pct) {
    await alertOwner(`Send failures at ${failurePct.toFixed(1)}%`, [
      `${failures} of ${attempts} reminder emails failed in today’s run (threshold ${s.alert_send_failure_pct}%).`,
      'Check the Activity page and the email provider dashboard.',
    ]);
  }
  return { ...service, ...appt, ...digest, auto_batches: autoBatches, failure_pct: Math.round(failurePct * 10) / 10 };
}
