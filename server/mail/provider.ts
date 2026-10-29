import { env } from '../env.js';

export interface Address {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface PostcardJob {
  to: Address;
  from: Address;
  front: string; // HTML
  back: string; // HTML
  size: '4x6' | '6x9';
  idempotencyKey: string;
}

export interface MailProvider {
  name: string;
  verify(a: Address): Promise<{ deliverable: boolean; detail: string }>;
  sendPostcard(job: PostcardJob): Promise<{ id: string; costCents: number | null; previewUrl?: string }>;
  ping(): Promise<boolean>;
}

function lobAddress(a: Address) {
  return { name: a.name.slice(0, 40), address_line1: a.line1, address_line2: a.line2 || undefined, address_city: a.city, address_state: a.state, address_zip: a.zip, address_country: 'US' };
}

// Lob: https://docs.lob.com. A test_ key renders the PDF but never prints or mails.
export class LobProvider implements MailProvider {
  name = 'lob';
  constructor(private key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Basic ${Buffer.from(`${this.key}:`).toString('base64')}`, 'Content-Type': 'application/json', ...extra };
  }

  async verify(a: Address) {
    const res = await fetch('https://api.lob.com/v1/us_verifications', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ primary_line: a.line1, secondary_line: a.line2 ?? '', city: a.city, state: a.state, zip_code: a.zip }),
    });
    const data = (await res.json()) as { deliverability?: string; error?: { message: string } };
    if (!res.ok) throw new Error(`Lob verify ${res.status}: ${data.error?.message ?? ''}`);
    const d = data.deliverability ?? 'unknown';
    return { deliverable: d === 'deliverable' || d.startsWith('deliverable_'), detail: d };
  }

  async sendPostcard(job: PostcardJob) {
    const res = await fetch('https://api.lob.com/v1/postcards', {
      method: 'POST',
      headers: this.headers({ 'Idempotency-Key': job.idempotencyKey }),
      body: JSON.stringify({ to: lobAddress(job.to), from: lobAddress(job.from), front: job.front, back: job.back, size: job.size, use_type: 'marketing' }),
    });
    const data = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
    if (!res.ok || !data.id) throw new Error(`Lob postcard ${res.status}: ${data.error?.message ?? ''}`);
    // Lob doesn't return a price per piece; cost comes from the settings estimate.
    return { id: data.id, costCents: null, previewUrl: data.url };
  }

  async ping() {
    const res = await fetch('https://api.lob.com/v1/postcards?limit=1', { headers: this.headers() });
    return res.ok;
  }
}

// Records jobs in memory. Addresses missing a line1/zip or containing
// "UNDELIVERABLE" fail verification so tests can exercise that path.
export class StubMailProvider implements MailProvider {
  name = 'stub';
  static sent: PostcardJob[] = [];

  async verify(a: Address) {
    const ok = !!a.line1 && /^\d{5}/.test(a.zip) && !/UNDELIVERABLE/i.test(a.line1);
    return { deliverable: ok, detail: ok ? 'deliverable' : 'undeliverable' };
  }

  async sendPostcard(job: PostcardJob) {
    StubMailProvider.sent.push(job);
    return { id: `stub_psc_${StubMailProvider.sent.length}`, costCents: null };
  }

  async ping() {
    return true;
  }
}

let provider: MailProvider | null = null;

export function mailProvider(): MailProvider {
  if (!provider) provider = env.mailProvider === 'lob' && env.lobKey ? new LobProvider(env.lobKey) : new StubMailProvider();
  return provider;
}
