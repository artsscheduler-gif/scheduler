import { env } from './env.js';

// Cloudflare's documented test secrets: 1x… always passes, 2x… always fails.
// Pre-launch check refuses to pass while a test secret is configured.
export async function verifyTurnstile(token: unknown, ip: string | null): Promise<boolean> {
  const secret = env.turnstileSecret;
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) return false;
  if (secret.startsWith('1x0000000000000000000000000000000')) return true;
  if (secret.startsWith('2x0000000000000000000000000000000')) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
