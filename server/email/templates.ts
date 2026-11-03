import type { ShopSettings } from '../db.js';
import { formatDate, formatTime } from '../../shared/time.js';
import { env } from '../env.js';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface Rendered { subject: string; html: string; text: string }

interface LayoutOpts {
  preheader?: string;
  heading: string;
  paragraphs: string[]; // already-escaped HTML fragments
  button?: { label: string; url: string };
  details?: [string, string][]; // label, value (plain text)
  unsubscribeUrl?: string; // marketing emails only
}

// Table layout with inline styles: renders in Gmail and Outlook.
export function layout(s: ShopSettings, o: LayoutOpts): { html: string; text: string } {
  const brand = /^#[0-9a-f]{6}$/i.test(s.brand_color) ? s.brand_color : '#2b3a4a';
  // A site-relative logo (e.g. /logo.png) needs the full URL in email.
  const logo = s.logo_url ? new URL(s.logo_url, `${env.appUrl}/`).href : '';
  const header = logo
    ? `<img src="${esc(logo)}" alt="${esc(s.shop_name)}" height="48" style="display:block;height:48px;border:0">`
    : `<span style="font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:0.3px">${esc(s.shop_name)}</span>`;
  const details = o.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;width:100%">${o.details
        .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5b6570;font-size:14px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-size:15px;color:#1d232a;white-space:pre-wrap">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';
  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td bgcolor="${brand}" style="border-radius:6px"><a href="${esc(o.button.url)}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px">${esc(o.button.label)}</a></td></tr></table>`
    : '';
  const unsub = o.unsubscribeUrl
    ? `<br><a href="${esc(o.unsubscribeUrl)}" style="color:#5b6570">Unsubscribe from reminder emails</a>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f1ed;font-family:Arial,Helvetica,sans-serif">
${o.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(o.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ed"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px">
<tr>${logo
  ? `<td bgcolor="#ffffff" style="padding:16px 28px;border-radius:8px 8px 0 0;border-bottom:4px solid ${brand}">${header}</td>`
  : `<td bgcolor="${brand}" style="padding:20px 28px;border-radius:8px 8px 0 0">${header}</td>`}</tr>
<tr><td style="padding:28px;color:#1d232a;font-size:16px;line-height:1.5">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1d232a">${esc(o.heading)}</h1>
${o.paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('\n')}
${details}${button}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e4e0d8;color:#5b6570;font-size:13px;line-height:1.5">
${esc(s.shop_name)} · ${esc(s.shop_address)} · ${esc(s.shop_phone)}${unsub}
</td></tr></table></td></tr></table></body></html>`;

  const strip = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    o.heading,
    '',
    ...o.paragraphs.map(strip),
    ...(o.details?.map(([k, v]) => `${k}: ${v}`) ?? []),
    o.button ? `\n${o.button.label}: ${o.button.url}` : '',
    '',
    `${s.shop_name} · ${s.shop_address} · ${s.shop_phone}`,
    o.unsubscribeUrl ? `Unsubscribe: ${o.unsubscribeUrl}` : '',
  ].join('\n');
  return { html, text };
}

export interface BookingView {
  date: string;
  kind: 'wait' | 'dropoff';
  start_time: string | null;
  services: string[];
  customer_notes: string;
  customer_name: string;
  vehicle: string;
}

export function whenText(s: ShopSettings, b: { date: string; kind: string; start_time: string | null }): string {
  const day = formatDate(b.date);
  if (b.kind === 'wait') return `${day} at ${formatTime(b.start_time)} (you’ll wait)`;
  if (b.start_time) return `${day}, drop off at ${formatTime(b.start_time)}`;
  return `${day}, drop off between ${formatTime(s.dropoff_window_start)} and ${formatTime(s.dropoff_window_end)}`;
}

function bookingDetails(s: ShopSettings, b: BookingView): [string, string][] {
  const d: [string, string][] = [
    ['When', whenText(s, b)],
    ['Service', b.services.join(', ')],
  ];
  if (b.vehicle) d.push(['Vehicle', b.vehicle]);
  if (b.customer_notes) d.push(['Your notes', b.customer_notes]);
  return d;
}

// ---- Customer emails ------------------------------------------------------

export function confirmedEmail(s: ShopSettings, b: BookingView, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    preheader: `You're booked: ${whenText(s, b)}`,
    heading: 'You’re booked',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, your appointment at ${esc(s.shop_name)} is confirmed. A calendar file is attached.`,
      `Need to change or cancel? Use the button below up to ${s.change_cutoff_hours} hours before, or call us at ${esc(s.shop_phone)}.`,
    ],
    details: bookingDetails(s, b),
    button: { label: 'Change or cancel', url: manageUrl },
  });
  return { subject: `Confirmed: ${whenText(s, b)}`, html, text };
}

export function requestedEmail(s: ShopSettings, b: BookingView, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    preheader: 'We got your request',
    heading: 'Request received',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, thanks for your request. We’re holding this time for you and will confirm within ${s.request_turnaround_business_hours} business hours.`,
      `You’ll get another email with a calendar file once it’s confirmed. Questions? Call ${esc(s.shop_phone)}.`,
    ],
    details: bookingDetails(s, b),
    button: { label: 'View or cancel', url: manageUrl },
  });
  return { subject: 'We got your request', html, text };
}

export function proposedEmail(s: ShopSettings, b: BookingView, manageUrl: string, note: string | null): Rendered {
  const { html, text } = layout(s, {
    heading: 'We’ve booked you for a different time',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, the time you asked for didn’t work on our end, so we’ve confirmed you for the time below.`,
      ...(note ? [`Note from the shop: ${esc(note)}`] : []),
      `If this doesn’t work, use the button to pick another time or cancel, or call ${esc(s.shop_phone)}.`,
    ],
    details: bookingDetails(s, b),
    button: { label: 'Change or cancel', url: manageUrl },
  });
  return { subject: `New time: ${whenText(s, b)}`, html, text };
}

export function declinedEmail(s: ShopSettings, b: BookingView, reason: string | null): Rendered {
  const { html, text } = layout(s, {
    heading: 'We couldn’t fit you in',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, sorry, we can’t take the appointment you requested for ${esc(whenText(s, b))}.`,
      ...(reason ? [`From the shop: ${esc(reason)}`] : []),
      `Please call us at ${esc(s.shop_phone)} and we’ll find a time that works.`,
    ],
    button: { label: 'Book another time', url: s.booking_url },
  });
  return { subject: 'About your appointment request', html, text };
}

export function reviewingEmail(s: ShopSettings, b: BookingView, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    heading: 'We’re double-checking your appointment',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, we’re taking a second look at your booking for ${esc(whenText(s, b))}. Your time is still held.`,
      `We’ll confirm within ${s.request_turnaround_business_hours} business hours, or call ${esc(s.shop_phone)}.`,
    ],
    button: { label: 'View or cancel', url: manageUrl },
  });
  return { subject: 'About your appointment', html, text };
}

export function changeReceivedEmail(s: ShopSettings, b: BookingView, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    heading: 'Change request received',
    paragraphs: [
      `Hi ${esc(b.customer_name)}, we got your change request. Until we confirm it, your original appointment stays as it was.`,
      `We’ll reply within ${s.request_turnaround_business_hours} business hours.`,
    ],
    details: bookingDetails(s, b),
    button: { label: 'View appointment', url: manageUrl },
  });
  return { subject: 'We got your change request', html, text };
}

export function changeDeclinedEmail(s: ShopSettings, original: BookingView, reason: string | null, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    heading: 'Your original appointment stands',
    paragraphs: [
      `Hi ${esc(original.customer_name)}, we couldn’t make the change you asked for, so your original appointment is unchanged.`,
      ...(reason ? [`From the shop: ${esc(reason)}`] : []),
    ],
    details: bookingDetails(s, original),
    button: { label: 'View appointment', url: manageUrl },
  });
  return { subject: 'About your change request', html, text };
}

export function cancelledEmail(s: ShopSettings, b: BookingView): Rendered {
  const { html, text } = layout(s, {
    heading: 'Appointment cancelled',
    paragraphs: [`Hi ${esc(b.customer_name)}, your appointment for ${esc(whenText(s, b))} is cancelled. Hope to see you soon.`],
    button: { label: 'Book again', url: s.booking_url },
  });
  return { subject: 'Your appointment is cancelled', html, text };
}

export function appointmentReminderEmail(s: ShopSettings, b: BookingView, manageUrl: string): Rendered {
  const { html, text } = layout(s, {
    preheader: `See you ${whenText(s, b)}`,
    heading: 'See you soon',
    paragraphs: [`Hi ${esc(b.customer_name)}, a reminder about your appointment at ${esc(s.shop_name)}.`],
    details: bookingDetails(s, b),
    button: { label: 'Change or cancel', url: manageUrl },
  });
  return { subject: `Reminder: ${whenText(s, b)}`, html, text };
}

export function serviceDueEmail(
  s: ShopSettings,
  o: { name: string; service: string; vehicle: string; dueDate: string; overdue: boolean; bookUrl: string; unsubscribeUrl: string },
): Rendered {
  const { html, text } = layout(s, {
    heading: o.overdue ? `Your ${o.service.toLowerCase()} is overdue` : `Time for your ${o.service.toLowerCase()}`,
    paragraphs: [
      `Hi ${esc(o.name)}, our records show your ${esc(o.vehicle || 'vehicle')} is ${o.overdue ? 'past due' : 'coming due'} for ${esc(o.service.toLowerCase())} (${esc(formatDate(o.dueDate, { month: 'long', day: 'numeric', year: 'numeric' }))}).`,
      `Book online in a couple of minutes, or call ${esc(s.shop_phone)}.`,
    ],
    button: { label: 'Book now', url: o.bookUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
  return { subject: o.overdue ? `${o.service} overdue` : `${o.service} coming due`, html, text };
}

// ---- Staff emails ---------------------------------------------------------

export function staffEmail(s: ShopSettings, o: { subject: string; heading: string; lines: string[]; details?: [string, string][]; button?: { label: string; url: string } }): Rendered {
  const { html, text } = layout(s, { heading: o.heading, paragraphs: o.lines.map(esc), details: o.details, button: o.button });
  return { subject: o.subject, html, text };
}
