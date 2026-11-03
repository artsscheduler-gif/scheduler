import { useState, type FormEvent } from 'react';
import { adminPost } from './api';
import { useQuery } from './shared';
import { ROLE_LABEL, ROLES, type Role } from '../../shared/permissions';

// Owners and developers: who can sign in to the admin. Only a developer can
// add, change or remove a developer.

interface Member { id: string; email: string; name: string; role: Role; last_sign_in_at: string | null; mfa: boolean; invited: boolean }

const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

export function Team() {
  const team = useQuery(() => adminPost<{ members: Member[]; me: string; my_role: Role }>('team-list', {}));
  const [msg, setMsg] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action: string, body: Record<string, unknown>, done: string) {
    setMsg('');
    try {
      await adminPost(action, body);
      setMsg(done);
      team.reload();
    } catch (e) {
      setMsg(`Not done: ${(e as Error).message.replace(/_/g, ' ')}`);
    }
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg('');
    setLink('');
    try {
      const r = await adminPost<{ link: string; emailed: boolean }>('team-invite', { email: f.get('email'), name: f.get('name'), role: f.get('role') });
      setLink(r.link);
      setMsg(r.emailed ? 'Invite emailed. You can also send them the link below.' : 'The email didn’t send. Send them the link below yourself.');
      e.currentTarget.reset();
      team.reload();
    } catch (err) {
      setMsg(`Not invited: ${(err as Error).message.replace(/_/g, ' ')}`);
    } finally {
      setBusy(false);
    }
  }

  if (team.error) return <p className="error">{team.error}</p>;
  if (!team.data) return <p className="loading">Loading…</p>;
  const me = team.data.me;
  const dev = team.data.my_role === 'developer';
  const grantable = ROLES.filter((r) => dev || r !== 'developer');
  const canManage = (m: Member) => m.id !== me && (dev || m.role !== 'developer');

  return (
    <div className="settings">
      <div className="settings-section">
        <h2>Team</h2>
        <p className="help">Everyone who can sign in. <b>Staff</b> handle requests, the schedule and customers. <b>Owners</b> also manage services, settings, approvals, postcards, export and the team. <b>Developers</b> can also change technical settings and use the test tools. See Help → Team.</p>
        <table className="tbl">
          <thead><tr><th>Who</th><th>Role</th><th>Last sign-in</th><th>Authenticator</th><th></th></tr></thead>
          <tbody>
            {team.data.members.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name || m.email}</strong>{m.name && <div className="muted small">{m.email}</div>}{m.id === me && <div className="muted small">You</div>}</td>
                <td>
                  {canManage(m) ? (
                    <select value={m.role} aria-label={`Role for ${m.name || m.email}`} onChange={(e) => act('team-role', { user_id: m.id, role: e.target.value }, 'Role changed.')}>
                      {grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : ROLE_LABEL[m.role]}
                </td>
                <td>{m.invited ? 'Invited, not signed in yet' : when(m.last_sign_in_at)}</td>
                <td>{m.mfa ? 'Set up' : 'Not yet'}</td>
                <td className="row wrap">
                  {m.mfa && canManage(m) && <button className="btn small" onClick={() => confirm(`Reset ${m.name || m.email}’s authenticator? They’ll scan a new QR code at their next sign-in.`) && act('team-reset-mfa', { user_id: m.id }, 'Authenticator reset.')}>Reset authenticator</button>}
                  {canManage(m) && <button className="btn small danger" onClick={() => confirm(`Remove ${m.name || m.email}? They can no longer sign in.`) && act('team-remove', { user_id: m.id }, 'Removed.')}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="settings-section">
        <h2>Add someone</h2>
        <form className="row wrap" onSubmit={invite}>
          <input name="name" placeholder="Name" aria-label="Name" maxLength={60} />
          <input name="email" type="email" required placeholder="Email" aria-label="Email" />
          <select name="role" aria-label="Role" defaultValue="staff">{grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          <button className="btn primary" disabled={busy}>{busy ? 'Inviting…' : 'Send invite'}</button>
        </form>
        <p className="help">They get an email with a link to choose a password, then set up an authenticator app at first sign-in.</p>
        {link && (
          <div className="notice">
            <strong>Set-password link</strong> (works once)
            <div className="row"><input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} /><button className="btn small" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button></div>
          </div>
        )}
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}
