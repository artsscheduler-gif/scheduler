import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationError } from './validate.js';

export type Req = IncomingMessage & { body?: unknown; query?: Record<string, string | string[] | undefined> };
export type Res = ServerResponse;
export interface Result { status: number; body: unknown; headers?: Record<string, string> }

export class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.error ?? status));
  }
}

export function clientIp(req: Req): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || (req.headers['x-real-ip'] as string) || req.socket?.remoteAddress || 'unknown';
}

export function query(req: Req, key: string): string | null {
  const v = req.query?.[key] ?? new URL(req.url ?? '/', 'http://x').searchParams.get(key);
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

async function readBody(req: Req): Promise<unknown> {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32_000) throw new HttpError(413, { error: 'too_large' });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: Res, r: Result) {
  res.statusCode = r.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  res.end(JSON.stringify(r.body));
}

// Wraps an endpoint: method check, JSON parsing, validation errors as 400,
// everything unexpected as a generic 503 so the client falls back to the phone.
export function endpoint(methods: string[], fn: (req: Req, body: unknown) => Promise<Result>) {
  return async (req: Req, res: Res) => {
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      return send(res, { status: 405, body: { error: 'method_not_allowed' } });
    }
    try {
      const body = req.method === 'GET' ? undefined : await readBody(req);
      send(res, await fn(req, body));
    } catch (e) {
      if (e instanceof ValidationError) return send(res, { status: 400, body: { error: 'invalid', field: e.field, message: e.message } });
      if (e instanceof HttpError) return send(res, { status: e.status, body: e.body });
      if (e instanceof SyntaxError) return send(res, { status: 400, body: { error: 'invalid_json' } });
      console.error('[endpoint]', req.url, e);
      send(res, { status: 503, body: { error: 'unavailable' } });
    }
  };
}
