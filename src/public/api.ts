export interface Service { id: string; name: string; description: string; wait_eligible: boolean }
export interface PublicConfig {
  shop_name: string;
  shop_phone: string;
  shop_address: string;
  hours: Record<string, { open: string; close: string } | null>;
  brand_color: string;
  logo_url: string;
  dropoff_window: [string, string];
  notes_max_length: number;
  services: Service[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public field?: string) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON (e.g. a platform error page) is treated as an outage.
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'unavailable', data?.field);
  return data as T;
}

// One bookable time and which ways of booking it are open.
export type ClosedWhy = 'full' | 'not_wait_eligible' | 'blocked' | 'outside_hours' | 'past' | 'unavailable';
export interface OpenTime { time: string; wait: boolean; dropoff: boolean; wait_why?: ClosedWhy; dropoff_why?: ClosedWhy }

export const api = {
  config: () => call<PublicConfig>('/api/availability?config=1'),
  days: (services: string[], t?: string) =>
    call<{ days: string[] }>(`/api/availability?${new URLSearchParams({ services: services.join(','), ...(t ? { t } : {}) })}`),
  times: (services: string[], date: string, t?: string) =>
    call<{ times: OpenTime[] }>(`/api/availability?${new URLSearchParams({ services: services.join(','), date, ...(t ? { t } : {}) })}`),
  book: (body: unknown) => call<{ status: 'confirmed' | 'requested'; date: string; kind: string; start_time: string | null; turnaround_hours: number }>('/api/book', { method: 'POST', body: JSON.stringify(body) }),
  manage: (t: string) => call<any>(`/api/manage?${new URLSearchParams({ t })}`),
  cancel: (t: string) => call<any>('/api/cancel', { method: 'POST', body: JSON.stringify({ t }) }),
  reschedule: (body: unknown) => call<any>('/api/reschedule', { method: 'POST', body: JSON.stringify(body) }),
  changeServices: (body: unknown) => call<any>('/api/change-services', { method: 'POST', body: JSON.stringify(body) }),
  unsubscribe: (t: string, channel: 'email' | 'mail') => call<any>('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ t, channel }) }),
};

// Shown whenever we can't load config at all. Set at build time so the
// fallback works even when the database is down.
export const FALLBACK_PHONE = import.meta.env.VITE_SHOP_PHONE || '';
