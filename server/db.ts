import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

let client: SupabaseClient<any, 'arts'> | null = null;

// Service-role client. Bypasses RLS: only server code holds this key.
export function db(): SupabaseClient<any, 'arts'> {
  if (!client) {
    client = createClient<any, 'arts'>(env.supabaseUrl, env.serviceKey, {
      db: { schema: 'arts' },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export async function getSettings(): Promise<ShopSettings> {
  const { data, error } = await db().from('shop_settings').select('*').eq('id', 1).single();
  if (error) throw new Error(`settings: ${error.message}`);
  return data as ShopSettings;
}

export type DayHours = { open: string; close: string } | null;

export interface ShopSettings {
  shop_name: string;
  shop_phone: string;
  shop_address: string;
  timezone: string;
  booking_url: string;
  hours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', DayHours>;
  total_lanes: number;
  waiter_lanes: number;
  slot_step_minutes: number;
  buffer_minutes: number;
  dropoff_window_start: string;
  dropoff_window_end: string;
  dropoff_share_pct: number;
  floor_days: number;
  max_days_ahead: number;
  notes_require_review: boolean;
  new_customers_require_review: boolean;
  notes_max_length: number;
  request_turnaround_business_hours: number;
  escalate_staff_business_hours: number;
  escalate_owner_business_days: number;
  ladder_step2_approvals: number;
  ladder_step3_weeks: number;
  undo_window_hours: number;
  change_cutoff_hours: number;
  max_future_bookings: number;
  rate_limit_ip_per_hour: number;
  rate_limit_contact_per_day: number;
  appointment_reminder_hours: number;
  reminders_dry_run: boolean;
  reminder_max_overdue_days: number;
  postcard_auto_approve: boolean;
  postcard_size: '4x6' | '6x9';
  postcard_cost_cents: number;
  postcard_front_html: string;
  postcard_back_html: string;
  from_email: string;
  from_name: string;
  staff_notify_email: string;
  owner_alert_email: string;
  alert_send_failure_pct: number;
  session_timeout_hours: number;
  brand_color: string;
  logo_url: string;
}
