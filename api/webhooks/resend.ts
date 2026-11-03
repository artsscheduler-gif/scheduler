import type { Req, Res } from '../../server/http.js';
import { HttpError } from '../../server/http.js';
import { handleResendWebhook } from '../../server/email/webhook.js';

// The signature covers the exact bytes sent, so read the raw body ourselves
// instead of letting it be parsed and re-serialized.
async function rawBody(req: Req): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new HttpError(413, { error: 'too_large' });
    chunks.push(Buffer.from(c as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('{"error":"method_not_allowed"}');
  }
  try {
    const raw = await rawBody(req);
    const h = req.headers as Record<string, string | undefined>;
    const r = await handleResendWebhook(process.env.RESEND_WEBHOOK_SECRET ?? '', h, raw);
    res.statusCode = r.status;
    res.end(JSON.stringify(r.body));
  } catch (e) {
    res.statusCode = e instanceof HttpError ? e.status : 400;
    res.end(JSON.stringify(e instanceof HttpError ? e.body : { error: 'invalid' }));
  }
}
