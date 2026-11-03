// Postcards ready for Lob: QR as a link, test-key address checks, test card.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { sql, resetData, adminToken, reqWith } from './helpers';
import { renderPostcard } from '../../server/postcard';
import { getSettings } from '../../server/db';
import { LobProvider } from '../../server/mail/provider';
import { adminAction } from '../../server/admin';
import qr from '../../api/qr';

afterAll(() => sql.end());
beforeEach(async () => {
  await resetData();
  await sql`update arts.shop_settings set shop_address = '6661 Tilghman St, Allentown, PA 18106'`;
});

async function get(url: string) {
  const u = new URL(url, 'http://x');
  const req = Object.assign(new PassThrough(), { method: 'GET', url: u.pathname + u.search, headers: {}, query: Object.fromEntries(u.searchParams) });
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0), setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: Buffer | string) { if (b) this.body = Buffer.from(b); } };
  await qr(req as any, res as any);
  return res;
}

describe('Postcards for Lob', () => {
  it('printed cards link to the QR image, keeping well under Lob’s 10,000 characters', async () => {
    const s = await getSettings();
    const card = await renderPostcard(s, { name: 'Pat Doe', service: 'Oil change', vehicle: '2015 Honda Fit', due_date: '2026-12-01', customerId: '00000000-0000-0000-0000-000000000001' }, undefined, { qrLink: true });
    expect(card.back).toContain('/api/qr?d=');
    expect(card.back).not.toContain('data:image');
    expect(card.front.length).toBeLessThan(10000);
    expect(card.back.length).toBeLessThan(10000);
  });

  it('serves QR images only for our own links', async () => {
    const s = await getSettings();
    const ok = await get(`/api/qr?d=${encodeURIComponent(`${s.booking_url}?src=postcard`)}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['Content-Type']).toBe('image/png');
    expect(ok.body.subarray(1, 4).toString()).toBe('PNG');
    expect((await get(`/api/qr?d=${encodeURIComponent('https://evil.example.com/')}`)).statusCode).toBe(400);
  });

  it('a Lob test key never marks an address undeliverable', async () => {
    const r = await new LobProvider('test_abc').verify({ name: 'X', line1: '1 Nowhere', city: 'Nowhere', state: 'PA', zip: '00000' });
    expect(r).toEqual({ deliverable: true, detail: 'not checked (Lob test key)' });
  });

  it('owners can send a test card; it reports the printer mode', async () => {
    const owner = (await adminToken('owner')).token;
    expect((await adminAction(reqWith(owner), 'postcard-status', {})).body).toEqual({ mode: 'stub' });
    const r = (await adminAction(reqWith(owner), 'postcard-test', {})).body as any;
    expect(r).toMatchObject({ mode: 'stub' });
    const staff = (await adminToken('staff')).token;
    await expect(adminAction(reqWith(staff), 'postcard-test', {})).rejects.toMatchObject({ status: 403 });
  });
});
