import { AuthGate, signOut } from './AuthGate';

export default function AdminApp() {
  return (
    <AuthGate>
      {(session) => (
        <div className="admin">
          <header className="admin-top">
            <strong>Art’s Service Center</strong>
            <span className="muted">{session.user.email}</span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </header>
        </div>
      )}
    </AuthGate>
  );
}
