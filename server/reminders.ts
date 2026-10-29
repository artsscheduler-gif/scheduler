import type { Result } from './http.js';
import type { Admin } from './admin.js';

export async function approveBatch(_a: Admin, _body: unknown): Promise<Result> {
  return { status: 501, body: { error: 'not_implemented' } };
}

export async function postcardPreview(_body: unknown): Promise<Result> {
  return { status: 501, body: { error: 'not_implemented' } };
}

import type { ShopSettings } from './db.js';
import type { JobSummary } from './jobs.js';

export async function daily(_s: ShopSettings): Promise<JobSummary> {
  return {};
}
