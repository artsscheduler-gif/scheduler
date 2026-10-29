// Ladder suggestions. Nothing moves on its own: admin shows the suggestion,
// Chris clicks.
export interface LadderInput {
  approval_level: 'approve' | 'notify' | 'digest';
  approvals_in_a_row: number;
  level_since: string;
  last_undo_at: string | null;
}

export function ladderSuggestion(s: LadderInput, step2Approvals: number, step3Weeks: number, now = new Date()): 'notify' | 'digest' | null {
  if (s.approval_level === 'approve' && s.approvals_in_a_row >= step2Approvals) return 'notify';
  if (s.approval_level === 'notify') {
    const since = Math.max(new Date(s.level_since).getTime(), s.last_undo_at ? new Date(s.last_undo_at).getTime() : 0);
    if (now.getTime() - since >= step3Weeks * 7 * 86400_000) return 'digest';
  }
  return null;
}

// Monday (ISO week start) of a date, YYYY-MM-DD.
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
