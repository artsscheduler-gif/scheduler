// Who can do what in the admin. Used by the server (enforced) and the admin
// screens (what's shown). Three roles:
//   staff     - day-to-day: requests, the schedule, customers, phone bookings
//   owner     - runs the business (Chris): plus services, hours, settings,
//               approvals, postcards, export/import and the team
//   developer - maintains the system (Jake): plus technical settings and the
//               launch checklist. Only a developer can add,
//               change or remove a developer.
export type Role = 'developer' | 'owner' | 'staff';
export const ROLES: Role[] = ['developer', 'owner', 'staff'];
export const ROLE_LABEL: Record<Role, string> = { developer: 'Developer', owner: 'Owner', staff: 'Staff' };
const RANK: Record<Role, number> = { staff: 0, owner: 1, developer: 2 };

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as string[]).includes(v);
}

// The authenticator (6-digit code) is required for developers only; owners
// and staff sign in with email and password. (Revisit in the security audit.)
export function mfaRequired(role: Role) {
  return role === 'developer';
}

export function atLeast(role: Role, min: Role) {
  return RANK[role] >= RANK[min];
}

// Settings where a wrong value breaks sign-in, email delivery or the site.
export const TECH_SETTINGS = new Set([
  'timezone', 'session_timeout_hours', 'rate_limit_ip_per_hour', 'rate_limit_contact_per_day',
  'from_email', 'from_name', 'owner_alert_email', 'alert_send_failure_pct', 'booking_url', 'logo_url',
  'postcard_front_html', 'postcard_back_html', 'postcard_size',
]);

// Minimum role for each admin action.
const ACTION_ROLE: Record<string, Role> = {
  decide: 'staff', check: 'staff', create: 'staff', move: 'staff', status: 'staff', resend: 'staff',
  customer: 'staff', vehicle: 'staff', merge: 'staff', unmerge: 'staff', block: 'staff', 'postcard-preview': 'staff', 'postcard-status': 'staff',
  forget: 'owner', settings: 'owner', service: 'owner', level: 'owner', closure: 'owner', rule: 'owner',
  export: 'owner', 'batch-approve': 'owner', 'workbook-apply': 'owner', 'postcard-test': 'owner',
  'team-list': 'owner', 'team-invite': 'owner', 'team-remove': 'owner', 'team-role': 'owner', 'team-reset-mfa': 'owner',
  // Test-site tools (only on staging): owners test there too.
  'outbox-clear': 'owner',
  'audit-item': 'developer',
};

export function minRoleFor(action: string): Role {
  if (action.startsWith('sim-')) return 'owner';
  return ACTION_ROLE[action] ?? 'developer';
}
