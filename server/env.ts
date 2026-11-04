// Server-side configuration. Only code under /server and /api may import this.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() { return req('SUPABASE_URL'); },
  get serviceKey() { return req('SUPABASE_SERVICE_ROLE_KEY'); },
  get appUrl() { return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''); },
  get tokenSecret() { return req('TOKEN_SECRET'); },
  get cronSecret() { return req('CRON_SECRET'); },
  get backupKey() { return req('BACKUP_ENCRYPTION_KEY'); },
  get turnstileSecret() { return process.env.TURNSTILE_SECRET_KEY ?? ''; },
  get emailProvider() { return process.env.EMAIL_PROVIDER ?? 'stub'; },
  // 'staging' turns on the Outbox and Simulator admin actions. Never set it in production.
  get staging() { return process.env.APP_ENV === 'staging'; },
  get resendKey() { return process.env.RESEND_API_KEY ?? ''; },
  // Staging only: addresses that also get a real copy of captured email.
  get deliverTo() { return (process.env.EMAIL_DELIVER_TO ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); },
  get deliverFrom() { return process.env.EMAIL_DELIVER_FROM || 'Art’s Servicenter TEST <onboarding@resend.dev>'; },
  get mailProvider() { return process.env.MAIL_PROVIDER ?? 'stub'; },
  get lobKey() { return process.env.LOB_API_KEY ?? ''; },
  get postgridKey() { return process.env.POSTGRID_API_KEY ?? ''; },
  // Starts the test lab on GitHub from the admin (Settings → Test runs → Run now).
  get githubDispatchToken() { return process.env.GITHUB_DISPATCH_TOKEN ?? ''; },
  get githubRepo() { return process.env.GITHUB_REPO || 'artsscheduler-gif/scheduler'; },
};
