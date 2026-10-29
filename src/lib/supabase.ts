import { createClient } from '@supabase/supabase-js';

// Anon key + the admin's own session. RLS only returns rows to MFA-verified
// owner/staff users; every write goes through /api/admin.
export const supabase = createClient<any, 'arts'>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { db: { schema: 'arts' } },
);
