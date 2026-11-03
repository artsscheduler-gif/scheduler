import QRCode from 'qrcode';
import type { Req, Res } from '../server/http.js';
import { query } from '../server/http.js';
import { getSettings } from '../server/db.js';
import { env } from '../server/env.js';

// QR code image for postcards: the printer (Lob) fetches it while rendering
// the card, which keeps the card design small. Only for links to our own
// booking page or site, so it can't be used as a general QR generator.
export default async function handler(req: Req, res: Res) {
  const d = query(req, 'd') ?? '';
  let ok = false;
  try {
    const host = new URL(d).host;
    const s = await getSettings();
    ok = d.length <= 1000 && [new URL(s.booking_url).host, new URL(env.appUrl).host].includes(host);
  } catch {
    ok = false;
  }
  if (!ok) {
    res.statusCode = 400;
    return res.end('bad link');
  }
  const png = await QRCode.toBuffer(d, { margin: 0, width: 300, errorCorrectionLevel: 'M' });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(png);
}
