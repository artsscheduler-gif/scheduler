// Who can sign in to the admin (owners and developers; see shared/permissions).
// Owners manage owners and staff; only a developer can add, change or remove a developer. Invites send a set-password link
// (through the shop's email) and return it so the owner can also pass it on.
import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { getSettings, rpc } from './db.js';
import { HttpError, type Result } from './http.js';
import type { Admin } from './admin.js';
import * as V from './validate.js';
import { isRole, ROLES, type Role } from '../shared/permissions.js';
import { sendEmail } from './email/send.js';
import * as T from './email/templates.js';

const auth = () => createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } }).auth.admin;
const audit = (a: Admin, action: string, id: string, after: unknown) =>
  rpc('audit', { p_actor: { type: 'admin', id: a.id, label: a.label }, p_action: action, p_entity: 'admin_user', p_entity_id: id, p_before: null, p_after: after });

interface Member { id: string; email: string; name: string; role: string; last_sign_in_at: string | null; mfa: boolean; invited: boolean }

async function members(): Promise<Member[]> {
  const { data, error } = await auth().listUsers({ perPage: 1000 });
  if (error) throw new Error(error.message);
  return data.users
    .filter((u) => isRole(u.app_metadata?.role))
    .map((u) => ({
      id: u.id, email: u.email ?? '', name: (u.user_metadata?.name as string) ?? '', role: u.app_metadata.role,
      last_sign_in_at: u.last_sign_in_at ?? null,
      mfa: (u.factors ?? []).some((f) => f.status === 'verified'),
      invited: !u.last_sign_in_at,
    }))
    .sort((x, y) => ROLES.indexOf(x.role as Role) - ROLES.indexOf(y.role as Role) || x.email.localeCompare(y.email));
}

// The role someone may hand out: a developer any role, an owner owner or staff.
function grantable(a: Admin, v: unknown): Role {
  const role: Role = isRole(v) ? v : 'staff';
  if (role === 'developer' && a.role !== 'developer') throw new HttpError(403, { error: 'developer_only' });
  return role;
}

export async function teamAction(a: Admin, action: string, body: unknown): Promise<Result> {
  if (action === 'team-list') return { status: 200, body: { members: await members(), me: a.id, my_role: a.role } };

  if (action === 'team-invite') {
    const b = V.obj(body, ['email', 'role', 'name']);
    const email = V.email(b.email);
    const role = grantable(a, b.role);
    const name = V.str(b.name, 'name', { max: 60, optional: true });
    const redirectTo = `${env.appUrl}/admin`;
    const { data, error } = await auth().generateLink({ type: 'invite', email, options: { data: { name }, redirectTo } });
    if (error) throw new HttpError(409, { error: error.message.includes('already') ? 'already_registered' : error.message });
    await auth().updateUserById(data.user.id, { app_metadata: { role } });
    const link = data.properties.action_link;
    const s = await getSettings();
    const sent = await sendEmail(s, {
      kind: 'admin_invite', to: email,
      ...T.staffEmail(s, {
        subject: `You’re invited to the ${s.shop_name} admin`,
        heading: 'Set up your admin sign-in',
        lines: [`${a.label} added you to the ${s.shop_name} booking admin. Choose a password, then add the 6-digit code from an authenticator app (Google Authenticator, 1Password, etc.).`, 'This link works once.'],
        button: { label: 'Set my password', url: link },
      }),
    });
    await audit(a, 'admin.invite', data.user.id, { email, role, emailed: sent });
    return { status: 200, body: { ok: true, link, emailed: sent } };
  }

  const b = V.obj(body, ['user_id', 'role']);
  const id = V.uuid(b.user_id, 'user_id');
  const team = await members();
  const target = team.find((m) => m.id === id);
  if (!target) throw new HttpError(404, { error: 'not_found' });
  const developers = team.filter((m) => m.role === 'developer');
  if (target.role === 'developer' && a.role !== 'developer') throw new HttpError(403, { error: 'developer_only' });

  if (action === 'team-remove') {
    if (id === a.id) throw new HttpError(409, { error: 'cannot_remove_yourself' });
    if (target.role === 'developer' && developers.length <= 1) throw new HttpError(409, { error: 'last_developer' });
    const { error } = await auth().deleteUser(id);
    if (error) throw new Error(error.message);
    await audit(a, 'admin.remove', id, { email: target.email, role: target.role });
    return { status: 200, body: { ok: true } };
  }

  if (action === 'team-role') {
    const role = grantable(a, b.role);
    if (id === a.id) throw new HttpError(409, { error: 'cannot_change_your_own_role' });
    if (target.role === 'developer' && role !== 'developer' && developers.length <= 1) throw new HttpError(409, { error: 'last_developer' });
    await auth().updateUserById(id, { app_metadata: { role } });
    await audit(a, 'admin.role', id, { email: target.email, role });
    return { status: 200, body: { ok: true } };
  }

  if (action === 'team-reset-mfa') {
    // They'll scan a new QR code at their next sign-in (lost or new phone).
    const { data, error } = await auth().mfa.listFactors({ userId: id });
    if (error) throw new Error(error.message);
    for (const f of data.factors) await auth().mfa.deleteFactor({ id: f.id, userId: id });
    await audit(a, 'admin.reset_mfa', id, { email: target.email, factors_removed: data.factors.length });
    return { status: 200, body: { ok: true, removed: data.factors.length } };
  }

  throw new HttpError(404, { error: 'unknown_action' });
}
