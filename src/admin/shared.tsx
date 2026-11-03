import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '../../shared/permissions';
import { supabase } from '../lib/supabase';
import { describeViolation } from '../../shared/rules';

export interface Settings { [k: string]: any }
export interface ServiceRow {
  id: string; name: string; description: string; duration_minutes: number; wait_eligible: boolean;
  daily_cap: number | null; lead_days: number | null; reminder_interval_months: number | null;
  approval_level: 'approve' | 'notify' | 'digest'; approvals_in_a_row: number; level_since: string;
  last_undo_at: string | null; sort_order: number; active: boolean; epicor_codes: string[];
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && setData(d)).catch((e) => live && setError(String(e?.message ?? e)));
    return () => { live = false; };
  }, [...deps, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

export async function must<T>(p: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export function useSettings() {
  return useQuery(() => must(supabase.from('shop_settings').select('*').eq('id', 1).single()) as Promise<Settings>);
}

export function useServices() {
  return useQuery(() => must(supabase.from('services').select('*').order('sort_order')) as Promise<ServiceRow[]>);
}

// Renders broken rules and asks for an explicit click to override.
export function OverrideConfirm({ violations, onConfirm, onCancel, verb = 'Book anyway' }: { violations: string[]; onConfirm: () => void; onCancel: () => void; verb?: string }) {
  return (
    <div className="override" role="alertdialog" aria-label="Rule override">
      <strong>This breaks {violations.length === 1 ? 'a booking rule' : `${violations.length} booking rules`}:</strong>
      <ul>{violations.map((v) => <li key={v}>{describeViolation(v)}</li>)}</ul>
      <div className="row">
        <button className="btn danger solid" onClick={onConfirm}>{verb}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function minutesOf(t: string) {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

export function todayIn(tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// The signed-in admin's role, for showing only what they can use.
export const RoleContext = createContext<Role>('staff');
export const useRole = () => useContext(RoleContext);
