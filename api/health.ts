import { endpoint } from '../server/http.js';
import { db } from '../server/db.js';
import { emailProvider } from '../server/email/provider.js';
import { mailProvider } from '../server/mail/provider.js';

async function check(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await Promise.race([fn(), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
  } catch {
    return false;
  }
}

// Watched by the uptime monitor. Reports reachability only: no data.
export default endpoint(['GET', 'HEAD'], async () => {
  const [database, email, mail] = await Promise.all([
    check(async () => !(await db().from('shop_settings').select('id').eq('id', 1).single()).error),
    check(() => emailProvider().ping()),
    check(() => mailProvider().ping()),
  ]);
  const ok = database && email && mail;
  return { status: ok ? 200 : 503, body: { ok, database, email, mail } };
});
