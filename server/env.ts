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
  get resendKey() { return process.env.RESEND_API_KEY ?? ''; },
  get mailProvider() { return process.env.MAIL_PROVIDER ?? 'stub'; },
  get lobKey() { return process.env.LOB_API_KEY ?? ''; },
};
