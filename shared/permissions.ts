// Who can do what in the admin. Used by the server (enforced) and the admin
// screens (what's shown). Three roles:
//   staff     - day-to-day: requests, the schedule, phone bookings
//   owner     - runs the business (Chris): plus services, hours, settings
//               and postcards
//   developer - maintains the system (Jake): plus customer records and
//               merges, activity, export/import, the team, technical
//               settings, the launch checklist and test tools. Only a developer can add,
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
  block: 'staff', 'postcard-preview': 'staff', 'postcard-status': 'staff', 'postcard-proof': 'staff',
  settings: 'owner', service: 'owner', closure: 'owner', rule: 'owner', 'batch-approve': 'owner', 'postcard-test': 'owner',
  // Customer records come from TRACS; fixing and merging them is the developer's job.
  customer: 'developer', vehicle: 'developer', merge: 'developer', unmerge: 'developer', forget: 'developer',
  matches: 'developer', 'match-dismiss': 'developer',
  level: 'developer', export: 'developer', 'workbook-apply': 'developer',
  'team-list': 'developer', 'team-invite': 'developer', 'team-remove': 'developer', 'team-role': 'developer', 'team-reset-mfa': 'developer',
  'outbox-clear': 'developer', 'audit-item': 'developer',
};

export function minRoleFor(action: string): Role {
  if (action.startsWith('sim-')) return 'developer';
  return ACTION_ROLE[action] ?? 'developer';
}
