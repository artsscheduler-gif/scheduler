import { chromium, type Browser } from 'playwright';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
export const SHOTS = process.env.E2E_SHOTS ?? '';

export async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/availability?config=1`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function launch(): Promise<Browser> {
  return chromium.launch();
}
