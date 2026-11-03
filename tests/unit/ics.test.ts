import { describe, it, expect } from 'vitest';
import { buildIcs, escapeText, fold } from '../../server/ics';

const base = { uid: 'root-1', start: new Date('2026-11-10T15:00:00Z'), minutes: 45, summary: 'Art’s Servicenter: Oil change', description: 'Line one\nChange or cancel: https://arts.jvtestspace.com/manage?t=' + 'x'.repeat(120), location: '6661 Tilghman St, Allentown, PA 18106' };

describe('calendar file', () => {
  it('escapes text per RFC 5545', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\;b\\,c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const folded = fold(`DESCRIPTION:${'é'.repeat(80)}`);
    for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(`DESCRIPTION:${'é'.repeat(80)}`);
  });

  it('updates carry a higher SEQUENCE; a cancel removes the same event', () => {
    const a = buildIcs({ ...base, now: new Date('2026-11-03T12:00:00Z') });
    const b = buildIcs({ ...base, now: new Date('2026-11-04T12:00:00Z') });
    const seq = (s: string) => Number(s.match(/SEQUENCE:(\d+)/)![1]);
    expect(seq(b)).toBeGreaterThan(seq(a));
    const c = buildIcs({ ...base, cancel: true });
    expect(c).toContain('METHOD:CANCEL');
    expect(c).toContain('STATUS:CANCELLED');
    expect(c).toContain('UID:root-1@artsservicecenter.com');
    for (const line of a.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
