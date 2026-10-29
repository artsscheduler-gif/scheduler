import QRCode from 'qrcode';
import type { ShopSettings } from './db.js';
import { esc } from './email/templates.js';

export interface PostcardVars {
  name: string;
  service: string;
  vehicle: string;
  due_date: string;
}

// Default templates, used while the settings fields are empty. Placeholder
// branding only: shop name in type, no invented logo or colors beyond the
// configurable brand color. Sizes follow Lob's HTML spec (bleed included).
const DIMS = { '4x6': { w: '6.25in', h: '4.25in' }, '6x9': { w: '9.25in', h: '6.25in' } };

export function defaultFront(): string {
  return `<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: {{width}}; height: {{height}}; font-family: Arial, Helvetica, sans-serif; background: {{brand_color}}; color: #fff; }
  .safe { position: absolute; inset: 0.3in; display: flex; flex-direction: column; justify-content: space-between; }
  .shop { font-size: 22pt; font-weight: bold; letter-spacing: 0.5pt; }
  .due { font-size: 30pt; font-weight: bold; line-height: 1.1; }
  .sub { font-size: 13pt; margin-top: 6pt; opacity: 0.9; }
  .phone { font-size: 14pt; font-weight: bold; }
</style></head><body><div class="safe">
  <div class="shop">{{shop_name}}</div>
  <div><div class="due">Your {{service}} is due.</div><div class="sub">{{vehicle}}</div></div>
  <div class="phone">{{shop_phone}}</div>
</div></body></html>`;
}

export function defaultBack(): string {
  // Lob reserves the right half of the back for address and postage, so all
  // content stays in the left half.
  return `<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: {{width}}; height: {{height}}; font-family: Arial, Helvetica, sans-serif; color: #1d232a; background: #fff; }
  .left { position: absolute; left: 0.3in; top: 0.3in; bottom: 0.3in; width: 2.6in; display: flex; flex-direction: column; justify-content: space-between; }
  h1 { font-size: 15pt; line-height: 1.2; }
  p { font-size: 10pt; line-height: 1.35; margin-top: 5pt; }
  .qr { width: 1.05in; height: 1.05in; display: block; }
  .url { font-size: 9pt; font-weight: bold; margin-top: 3pt; word-break: break-all; }
  .foot { font-size: 8pt; color: #555; }
</style></head><body><div class="left">
  <div><h1>Hi {{name}}, it’s time.</h1><p>Our records show your {{vehicle}} is due for {{service}} ({{due_date}}). Booking takes two minutes.</p></div>
  <div><img class="qr" src="{{qr}}" alt=""><div class="url">{{booking_url_display}}</div><p>or call <b>{{shop_phone}}</b></p></div>
  <div class="foot">{{shop_name}} · {{shop_address}}</div>
</div></body></html>`;
}

export function trackedBookingUrl(s: ShopSettings): string {
  const u = new URL(s.booking_url);
  u.searchParams.set('src', 'postcard');
  return u.toString();
}

export async function renderPostcard(s: ShopSettings, v: PostcardVars, overrides?: { front?: string; back?: string }) {
  const url = trackedBookingUrl(s);
  const qr = await QRCode.toDataURL(url, { margin: 0, width: 300, errorCorrectionLevel: 'M' });
  const dims = DIMS[s.postcard_size];
  const vars: Record<string, string> = {
    name: esc(v.name.split(' ')[0] || v.name),
    service: esc(v.service.toLowerCase()),
    vehicle: esc(v.vehicle || 'vehicle'),
    due_date: esc(new Date(`${v.due_date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })),
    shop_name: esc(s.shop_name),
    shop_phone: esc(s.shop_phone),
    shop_address: esc(s.shop_address),
    booking_url: esc(url),
    booking_url_display: esc(new URL(s.booking_url).host),
    brand_color: /^#[0-9a-f]{6}$/i.test(s.brand_color) ? s.brand_color : '#2b3a4a',
    qr,
    width: dims.w,
    height: dims.h,
  };
  const fill = (tpl: string) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
  return {
    front: fill(overrides?.front ?? (s.postcard_front_html || defaultFront())),
    back: fill(overrides?.back ?? (s.postcard_back_html || defaultBack())),
    url,
  };
}
