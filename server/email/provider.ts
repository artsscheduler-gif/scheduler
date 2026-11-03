import { env } from '../env.js';
import { db } from '../db.js';

export interface EmailMessage {
  kind?: string; // email_log kind; providers that deliver ignore it
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export interface SendResult { id: string; costCents: number }

export interface EmailProvider {
  name: string;
  send(msg: EmailMessage): Promise<SendResult>;
  ping(): Promise<boolean>;
}

// Resend: https://resend.com/docs/api-reference/emails/send-email
export class ResendProvider implements EmailProvider {
  name = 'resend';
  constructor(private key: string) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        reply_to: msg.replyTo,
        headers: msg.headers,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !data.id) throw new Error(`Resend ${res.status}: ${data.message ?? 'send failed'}`);
    // Resend bills by plan tier, not per message; record 0 and track plan cost separately.
    return { id: data.id, costCents: 0 };
  }

  async ping(): Promise<boolean> {
    const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${this.key}` } });
    return res.ok;
  }
}

// Records messages in memory. Used in tests, local dev, and whenever no
// provider key is configured. Never delivers anything.
export class StubEmailProvider implements EmailProvider {
  name = 'stub';
  static outbox: EmailMessage[] = [];
  static failNext = 0;

  async send(msg: EmailMessage): Promise<SendResult> {
    if (StubEmailProvider.failNext > 0) {
      StubEmailProvider.failNext -= 1;
      throw new Error('stub failure');
    }
    StubEmailProvider.outbox.push(msg);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      console.log(`[email:stub] to=${msg.to} subject="${msg.subject}"`);
    }
    return { id: `stub_${Date.now()}_${StubEmailProvider.outbox.length}`, costCents: 0 };
  }

  async ping() {
    return true;
  }
}

// Staging: stores each message in arts.email_outbox for the admin Outbox tab.
// Delivers nothing, except a [TEST] copy to addresses on EMAIL_DELIVER_TO
// (sent from Resend's shared test sender, so no domain setup is needed).
export class CaptureEmailProvider implements EmailProvider {
  name = 'capture';
  constructor(private deliver: { to: string[]; from: string; via: EmailProvider | null } = { to: [], from: '', via: null }) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    const { data, error } = await db().from('email_outbox').insert({
      kind: msg.kind ?? null,
      to_email: msg.to,
      from_email: msg.from,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => a.filename) ?? [],
    }).select('id').single();
    if (error) throw new Error(`capture: ${error.message}`);
    if (this.deliver.via && this.deliver.to.includes(msg.to.toLowerCase())) {
      // Failure here is recorded on the outbox row, never retried: the capture already succeeded.
      const delivered = await this.deliver.via.send({ ...msg, from: this.deliver.from, subject: `[TEST] ${msg.subject}` })
        .then((r) => `sent:${r.id}`, (e: Error) => `failed:${e.message.slice(0, 200)}`);
      await db().from('email_outbox').update({ delivered }).eq('id', data.id);
    }
    return { id: data.id, costCents: 0 };
  }

  async ping() {
    return true;
  }
}

let provider: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (!provider) {
    provider = env.emailProvider === 'resend' && env.resendKey ? new ResendProvider(env.resendKey)
      : env.emailProvider === 'capture' ? new CaptureEmailProvider({
        to: env.deliverTo, from: env.deliverFrom, via: env.resendKey ? new ResendProvider(env.resendKey) : null,
      })
      : new StubEmailProvider();
  }
  return provider;
}

export function setEmailProvider(p: EmailProvider | null) {
  provider = p;
}
