/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_TURNSTILE_SITE_KEY: string;
  readonly VITE_SHOP_PHONE?: string;
  readonly VITE_APP_ENV?: string;
}
