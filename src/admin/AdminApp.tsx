import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { AuthGate, signOut } from './AuthGate';
import { DayView } from './DayView';
import { BookingForm } from './BookingForm';
import { Customers } from './Customers';
import { Settings } from './Settings';
import { Approvals } from './Approvals';
import { Postcards } from './Postcards';
import { Activity } from './Activity';
import { Export } from './Export';
import { Outbox } from './Outbox';
import { Simulator } from './Simulator';
import { Lab } from './Lab';
import { Checklist } from './Checklist';
import { Help } from './Help';
import { Team } from './Team';
import { STAGING } from '../lib/env';

const NAV: [string, string][] = [
  ['/admin', 'Day'],
  ['/admin/book', 'Phone booking'],
  ['/admin/customers', 'Customers'],
  ['/admin/approvals', 'Approvals'],
  ['/admin/postcards', 'Postcards'],
  ['/admin/settings', 'Settings'],
  ['/admin/activity', 'Activity'],
  ['/admin/export', 'Export'],
  ...(STAGING ? [['/admin/lab', 'Test lab'], ['/admin/outbox', 'Outbox'], ['/admin/simulator', 'Simulator']] as [string, string][] : []),
];

// Any admin action that fails without handling its own error shows here,
// instead of failing silently.
function ErrorBanner() {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent) => {
      setErr(e.reason instanceof Error ? e.reason.message : String(e.reason));
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onReject);
    return () => window.removeEventListener('unhandledrejection', onReject);
  }, []);
  if (!err) return null;
  return (
    <div className="banner error-banner" role="alert">
      That didn’t work: {err}. Check the result, then try again or reload the page.
      <button className="btn small" onClick={() => setErr(null)}>Dismiss</button>
    </div>
  );
}

export default function AdminApp() {
  return (
    <AuthGate>
      {(session) => (
        <div className="admin">
          <header className="admin-top">
            <strong className="admin-brand">Art’s Servicenter</strong>
            <nav aria-label="Admin">
              {[...NAV, ...(session.user.app_metadata?.role === 'owner' ? [['/admin/team', 'Team'], ['/admin/checklist', 'Checklist']] as [string, string][] : []), ['/admin/help', 'Help'] as [string, string]].map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'on' : '')}>{label}</NavLink>
              ))}
            </nav>
            <span className="muted small push">{session.user.email}</span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </header>
          <main className="admin-main">
            <ErrorBanner />
            <Routes>
              <Route index element={<DayView />} />
              <Route path="book" element={<div className="narrow-page"><h2>Phone booking</h2><BookingForm /></div>} />
              <Route path="customers" element={<Customers />} />
              <Route path="approvals" element={<Approvals />} />
              <Route path="postcards" element={<Postcards />} />
              <Route path="settings" element={<Settings />} />
              <Route path="activity" element={<Activity />} />
              <Route path="export" element={<Export />} />
              {STAGING && <Route path="outbox" element={<Outbox />} />}
              {STAGING && <Route path="simulator" element={<Simulator />} />}
              {STAGING && <Route path="lab" element={<Lab />} />}
              {session.user.app_metadata?.role === 'owner' && <Route path="checklist" element={<Checklist />} />}
              {session.user.app_metadata?.role === 'owner' && <Route path="team" element={<Team />} />}
              <Route path="help" element={<Help owner={session.user.app_metadata?.role === 'owner'} />} />
            </Routes>
          </main>
        </div>
      )}
    </AuthGate>
  );
}
