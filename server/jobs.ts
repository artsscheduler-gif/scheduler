import { db, getSettings, type ShopSettings } from './db.js';
import { env } from './env.js';
import { addBusinessDays, addBusinessHours, type Closure } from './business-hours.js';
import { loadBooking, vehicleText } from './bookings.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';
import { formatPhone } from '../shared/phone.js';

export interface JobSummary { [k: string]: number | string | boolean }

// A run still 'running' after this was cut off (platform time limit or crash).
const STALE_RUN_MS = 15 * 60_000;

// Records every run in job_runs; alerts Jake when a run throws, or when an
// earlier run never finished (the platform kills it without running catch).
export async function runJob(job: string, fn: (s: ShopSettings) => Promise<JobSummary>): Promise<{ ok: boolean; summary?: JobSummary; error?: string }> {
  const { data: stale } = await db().from('job_runs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error: 'Stopped before finishing (likely the 10-second function limit or a crash).' })
    .eq('status', 'running').lt('started_at', new Date(Date.now() - STALE_RUN_MS).toISOString()).select('job, started_at');
  if (stale?.length) {
    await alertOwner(`${stale.length} scheduled run(s) didn’t finish`, stale.map((r) => `${r.job} started ${new Date(r.started_at).toISOString()} and never recorded a result.`)).catch(() => {});
  }
  const { data: run } = await db().from('job_runs').insert({ job }).select('id').single();
  try {
    const s = await getSettings();
    const summary = await fn(s);
    await db().from('job_runs').update({ status: 'ok', finished_at: new Date().toISOString(), summary }).eq('id', run!.id);
    return { ok: true, summary };
  } catch (e) {
    const error = (e as Error).stack ?? String(e);
    await db().from('job_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: error.slice(0, 4000) }).eq('id', run!.id);
    await alertOwner(`Job "${job}" failed`, [`The ${job} job threw an error and did not finish.`, error.slice(0, 1500)]).catch(() => {});
    return { ok: false, error: (e as Error).message };
  }
}

export async function alertOwner(subject: string, lines: string[]) {
  const s = await getSettings();
  await sendEmail(s, {
    kind: 'alert',
    to: s.owner_alert_email,
    ...T.staffEmail(s, { subject: `[Art's booking] ${subject}`, heading: subject, lines, button: { label: 'Open admin', url: `${env.appUrl}/admin` } }),
  });
}

async function closures(): Promise<Closure[]> {
  const { data } = await db().from('closures').select('start_date, end_date');
  return data ?? [];
}

// Marks an escalation as sent before sending, so overlapping runs can't both
// send it; a failed send releases it and the next hourly run tries again.
async function claim(id: string, field: 'escalated_staff_at' | 'escalated_owner_at', now: Date) {
  const { data } = await db().from('bookings').update({ [field]: now.toISOString() }).eq('id', id).is(field, null).select('id');
  return !!data?.length;
}

async function release(id: string, field: 'escalated_staff_at' | 'escalated_owner_at', now: Date) {
  await db().from('bookings').update({ [field]: null }).eq('id', id).eq(field, now.toISOString());
}

// Hourly: chase unanswered requests. Holds never silently expire.
export async function tick(s: ShopSettings, now = new Date()): Promise<JobSummary> {
  const cl = await closures();
  const { data: pending } = await db()
    .from('bookings')
    .select('id, created_at, staff_notified_at, escalated_staff_at, escalated_owner_at')
    .eq('status', 'requested');
  let staff = 0;
  let owner = 0;
  for (const b of pending ?? []) {
    const base = new Date(b.staff_notified_at ?? b.created_at);
    const staffDue = addBusinessHours(base, s.escalate_staff_business_hours, s, cl);
    const ownerDue = addBusinessDays(base, s.escalate_owner_business_days, s, cl);
    const needStaff = !b.escalated_staff_at && now >= staffDue;
    const needOwner = !b.escalated_owner_at && now >= ownerDue;
    if (!needStaff && !needOwner) continue;
    const l = await loadBooking(b.id);
    if (!l) continue;
    const details: [string, string][] = [
      ['Customer', `${l.customer.name} · ${formatPhone(l.customer.phone)}`],
      ['When', T.whenText(s, l.booking)],
      ['Service', l.services.map((x) => x.name).join(', ')],
      ['Vehicle', vehicleText(l.vehicle)],
      ['Waiting since', base.toLocaleString('en-US', { timeZone: s.timezone })],
    ];
    if (needStaff && (await claim(b.id, 'escalated_staff_at', now))) {
      const ok = await sendEmail(s, {
        kind: 'escalate_staff',
        to: s.staff_notify_email,
        ...T.staffEmail(s, {
          subject: `Still waiting: ${l.customer.name}`,
          heading: 'A booking request is still waiting',
          lines: [`This customer was promised an answer within ${s.request_turnaround_business_hours} business hours.`],
          details,
          button: { label: 'Review in admin', url: `${env.appUrl}/admin` },
        }),
        bookingId: b.id,
        idempotencyKey: `escalate-staff:${b.id}:${base.toISOString()}`,
      });
      if (ok) staff++;
      else await release(b.id, 'escalated_staff_at', now);
    }
    if (needOwner && (await claim(b.id, 'escalated_owner_at', now))) {
      const ok = await sendEmail(s, {
        kind: 'escalate_owner',
        to: s.owner_alert_email,
        ...T.staffEmail(s, {
          subject: `Unanswered for ${s.escalate_owner_business_days} business day(s): ${l.customer.name}`,
          heading: 'A booking request has gone unanswered',
          lines: ['Chris has been reminded. The slot is still held.'],
          details,
          button: { label: 'Open admin', url: `${env.appUrl}/admin` },
        }),
        bookingId: b.id,
        idempotencyKey: `escalate-owner:${b.id}:${base.toISOString()}`,
      });
      if (ok) owner++;
      else await release(b.id, 'escalated_owner_at', now);
    }
  }
  return { pending: pending?.length ?? 0, escalated_staff: staff, escalated_owner: owner };
}
