import { db, getSettings, rpc, type ShopSettings } from './db.js';
import { env } from './env.js';
import { manageUrl } from './tokens.js';
import { buildIcs } from './ics.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';
import { zonedTimeToUtc, formatTime } from '../shared/time.js';
import { formatPhone } from '../shared/phone.js';

export interface BookingRow {
  id: string;
  root_id: string;
  replaces_booking_id: string | null;
  change_kind: string | null;
  customer_id: string;
  vehicle_id: string | null;
  date: string;
  kind: 'wait' | 'dropoff';
  start_time: string | null;
  total_minutes: number;
  status: string;
  customer_notes: string;
  auto_confirmed: boolean;
  approval_level: string | null;
  undo_until: string | null;
  decline_reason: string | null;
  created_at: string;
}

export interface LoadedBooking {
  booking: BookingRow;
  services: { id: string; name: string }[];
  customer: { id: string; name: string; email: string | null; phone: string | null };
  vehicle: { year: number | null; make: string | null; model: string | null } | null;
}

export async function loadBooking(id: string): Promise<LoadedBooking | null> {
  const { data } = await db()
    .from('bookings')
    .select('*, customers(id, name, email, phone), vehicles(year, make, model), booking_services(services(id, name, sort_order))')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  const { customers, vehicles, booking_services, ...booking } = data as any;
  return {
    booking,
    customer: customers,
    vehicle: vehicles,
    services: (booking_services as any[])
      .map((bs) => bs.services)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ id: s.id, name: s.name })),
  };
}

export function vehicleText(v: LoadedBooking['vehicle']): string {
  return v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '';
}

export function toView(l: LoadedBooking): T.BookingView {
  return {
    date: l.booking.date,
    kind: l.booking.kind,
    start_time: l.booking.start_time,
    services: l.services.map((s) => s.name),
    customer_notes: l.booking.customer_notes,
    customer_name: l.customer.name.split(' ')[0] || l.customer.name,
    vehicle: vehicleText(l.vehicle),
  };
}

export function appointmentStart(s: ShopSettings, b: { date: string; kind: string; start_time: string | null }): Date {
  const t = b.start_time ? b.start_time.slice(0, 5) : s.dropoff_window_start.slice(0, 5);
  return zonedTimeToUtc(b.date, t, s.timezone);
}

export function manageLink(s: ShopSettings, b: BookingRow): string {
  return manageUrl(b.root_id, appointmentStart(s, b));
}

function adminLink(path = '') {
  return `${env.appUrl}/admin${path}`;
}

function staffDetails(s: ShopSettings, l: LoadedBooking): [string, string][] {
  const d: [string, string][] = [
    ['Customer', `${l.customer.name} · ${formatPhone(l.customer.phone)} · ${l.customer.email ?? ''}`],
    ['When', T.whenText(s, l.booking)],
    ['Service', l.services.map((x) => x.name).join(', ')],
    ['Vehicle', vehicleText(l.vehicle)],
  ];
  if (l.booking.customer_notes) d.push(['Notes', l.booking.customer_notes]);
  return d;
}

// The appointment as a calendar event: waiters for the job's length, a timed
// drop-off as a 30-minute slot, an untimed drop-off across the drop-off window.
function calendarFile(s: ShopSettings, l: LoadedBooking, description: string, cancel = false) {
  const b = l.booking;
  const windowMin = (Date.parse(`2000-01-01T${s.dropoff_window_end}`) - Date.parse(`2000-01-01T${s.dropoff_window_start}`)) / 60_000;
  return buildIcs({
    uid: b.root_id,
    start: appointmentStart(s, b),
    minutes: b.kind === 'wait' ? b.total_minutes : b.start_time ? 30 : Math.max(30, windowMin),
    summary: `${s.shop_name}: ${l.services.map((x) => x.name).join(', ')}`,
    description, location: s.shop_address, cancel,
  });
}

// Attachment that removes the appointment from the customer's calendar.
export function cancelAttachment(s: ShopSettings, l: LoadedBooking) {
  const ics = calendarFile(s, l, `Cancelled. Call ${s.shop_phone} to book again.`, true);
  return [{ filename: 'cancel.ics', content: Buffer.from(ics).toString('base64'), contentType: 'text/calendar; method=CANCEL' }];
}

export async function sendConfirmation(s: ShopSettings, l: LoadedBooking, kind: 'confirmed' | 'proposed' = 'confirmed', note: string | null = null) {
  const link = manageLink(s, l.booking);
  const view = toView(l);
  const r = kind === 'proposed' ? T.proposedEmail(s, view, link, note) : T.confirmedEmail(s, view, link);
  const ics = calendarFile(s, l, `${T.whenText(s, l.booking)}\nChange or cancel: ${link}\n${s.shop_phone}`);
  const ok = await sendEmail(s, {
    kind: kind === 'proposed' ? 'booking_proposed' : 'booking_confirmed',
    to: l.customer.email,
    ...r,
    bookingId: l.booking.id,
    customerId: l.customer.id,
    attachments: [{ filename: 'appointment.ics', content: Buffer.from(ics).toString('base64'), contentType: 'text/calendar' }],
  });
  if (ok) await db().from('bookings').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', l.booking.id);
}

// Emails that follow a newly created booking or change request.
export async function notifyCreated(s: ShopSettings, bookingId: string) {
  const l = await loadBooking(bookingId);
  if (!l) return;
  const b = l.booking;
  const link = manageLink(s, b);

  if (b.change_kind) {
    const before = b.replaces_booking_id ? await loadBooking(b.replaces_booking_id) : null;
    await sendEmail(s, { kind: 'change_received', to: l.customer.email, ...T.changeReceivedEmail(s, toView(l), link), bookingId: b.id, customerId: l.customer.id });
    const details: [string, string][] = before
      ? [
          ['Before', `${T.whenText(s, before.booking)} · ${before.services.map((x) => x.name).join(', ')}${before.booking.customer_notes ? ` · “${before.booking.customer_notes}”` : ''}`],
          ['After', `${T.whenText(s, b)} · ${l.services.map((x) => x.name).join(', ')}${b.customer_notes ? ` · “${b.customer_notes}”` : ''}`],
          ['Customer', `${l.customer.name} · ${formatPhone(l.customer.phone)}`],
        ]
      : staffDetails(s, l);
    await sendEmail(s, {
      kind: 'staff_change_request',
      to: s.staff_notify_email,
      ...T.staffEmail(s, {
        subject: `Change request: ${l.customer.name}`,
        heading: `${l.customer.name} wants to change an appointment`,
        lines: ['Approve keeps the new version. Decline restores the original and emails the customer.'],
        details,
        button: { label: 'Review in admin', url: adminLink() },
      }),
      bookingId: b.id,
    });
  } else if (b.status === 'confirmed') {
    await sendConfirmation(s, l);
    if (b.approval_level === 'notify') {
      await sendEmail(s, {
        kind: 'staff_notify',
        to: s.staff_notify_email,
        ...T.staffEmail(s, {
          subject: `Booked: ${l.customer.name}, ${T.whenText(s, b)}`,
          heading: 'New booking (auto-confirmed)',
          lines: [`You can undo this for ${s.undo_window_hours} hours. Undo puts it back in your approval queue.`],
          details: staffDetails(s, l),
          button: { label: 'Undo', url: adminLink(`?undo=${b.id}`) },
        }),
        bookingId: b.id,
      });
    }
  } else {
    await sendEmail(s, { kind: 'booking_requested', to: l.customer.email, ...T.requestedEmail(s, toView(l), link), bookingId: b.id, customerId: l.customer.id });
    await sendEmail(s, {
      kind: 'staff_request',
      to: s.staff_notify_email,
      ...T.staffEmail(s, {
        subject: `Approval needed: ${l.customer.name}, ${T.whenText(s, b)}`,
        heading: 'New booking request',
        lines: ['The slot is held until you approve, propose a new time, or decline.'],
        details: staffDetails(s, l),
        button: { label: 'Review in admin', url: adminLink() },
      }),
      bookingId: b.id,
    });
  }
  await db().from('bookings').update({ staff_notified_at: new Date().toISOString() }).eq('id', b.id);
}

// ---------------------------------------------------------------------------
// Customer-facing reads
// ---------------------------------------------------------------------------

export async function publicConfig() {
  const s = await getSettings();
  const { data: services } = await db()
    .from('services')
    .select('id, name, description, wait_eligible')
    .eq('active', true)
    .order('sort_order');
  return {
    shop_name: s.shop_name,
    shop_phone: s.shop_phone,
    shop_address: s.shop_address,
    hours: s.hours,
    brand_color: s.brand_color,
    logo_url: s.logo_url,
    dropoff_window: [formatTime(s.dropoff_window_start), formatTime(s.dropoff_window_end)],
    notes_max_length: s.notes_max_length,
    services: services ?? [],
  };
}

// Every live version of an appointment: the confirmed one and/or a pending request.
export async function rootVersions(rootId: string): Promise<{ confirmed: BookingRow | null; pending: BookingRow | null; all: BookingRow[] }> {
  const { data } = await db().from('bookings').select('*').eq('root_id', rootId).order('created_at', { ascending: false });
  const all = (data ?? []) as BookingRow[];
  return {
    confirmed: all.find((b) => b.status === 'confirmed') ?? null,
    pending: all.find((b) => b.status === 'requested') ?? null,
    all,
  };
}

export function withinCutoff(s: ShopSettings, b: BookingRow, now = new Date()): boolean {
  return appointmentStart(s, b).getTime() - now.getTime() >= s.change_cutoff_hours * 3600_000;
}

// Collapses rule codes into the few reasons a customer is shown.
function publicReason(code: string | null): string {
  if (!code) return 'unavailable';
  if (code.startsWith('daily_cap:') || code === 'day_capacity' || code === 'dropoff_share' || code === 'waiter_lanes') return 'full';
  if (['not_wait_eligible', 'blocked', 'outside_hours', 'past'].includes(code)) return code;
  return 'unavailable';
}

// Customers pick a day and time first, then wait or drop off, so each time
// says which of the two is open.
export async function availability(serviceIds: string[], date: string | null, exclude: string[] = []) {
  if (date) {
    const slots = await rpc<{ start_time: string; wait: boolean; dropoff: boolean; wait_why: string | null; dropoff_why: string | null }[]>('available_slots', { p_service_ids: serviceIds, p_date: date, p_exclude: exclude });
    // Rule codes only (never names or counts), so the page can say why a choice is closed.
    return {
      times: (slots ?? []).map((r) => ({
        time: r.start_time.slice(0, 5), wait: r.wait, dropoff: r.dropoff,
        ...(r.wait ? {} : { wait_why: publicReason(r.wait_why) }), ...(r.dropoff ? {} : { dropoff_why: publicReason(r.dropoff_why) }),
      })),
    };
  }
  const days = await rpc<string[]>('available_slot_days', { p_service_ids: serviceIds, p_exclude: exclude });
  return { days: days ?? [] };
}
