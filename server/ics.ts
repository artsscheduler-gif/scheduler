// RFC 5545 calendar file for one appointment. The UID is the appointment's
// root id, so a reschedule updates the same calendar event (higher SEQUENCE)
// and a cancellation removes it (METHOD:CANCEL).
function stamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function escapeText(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 octets continue on the next line after a space,
// without splitting a UTF-8 character.
export function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// Increases with every update, so calendar apps take the newest version.
const sequence = (now: Date) => Math.floor((now.getTime() - Date.UTC(2026, 0, 1)) / 60_000);

export function buildIcs(opts: {
  uid: string; start: Date; minutes: number; summary: string; description: string; location: string;
  cancel?: boolean; now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const end = new Date(opts.start.getTime() + opts.minutes * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Arts Servicenter//Booking//EN',
    `METHOD:${opts.cancel ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${opts.uid}@artsservicecenter.com`,
    `SEQUENCE:${sequence(now)}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(opts.start)}`,
    `DTEND:${stamp(end)}`,
    `STATUS:${opts.cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeText(opts.summary)}`,
    `DESCRIPTION:${escapeText(opts.description)}`,
    `LOCATION:${escapeText(opts.location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}
