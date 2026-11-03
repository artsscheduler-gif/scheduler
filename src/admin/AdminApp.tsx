import { useEffect, useState, type ReactElement } from 'react';
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
import { RoleContext } from './shared';
import { STAGING } from '../lib/env';
import { atLeast, isRole, ROLE_LABEL, type Role } from '../../shared/permissions';

// Tabs and the lowest role that sees each (see shared/permissions).
const NAV: { to: string; label: string; min: Role; staging?: boolean }[] = [
  { to: '/admin', label: 'Day', min: 'staff' },
  { to: '/admin/book', label: 'Phone booking', min: 'staff' },
  { to: '/admin/customers', label: 'Customers', min: 'staff' },
  { to: '/admin/approvals', label: 'Approvals', min: 'owner' },
  { to: '/admin/postcards', label: 'Postcards', min: 'owner' },
  { to: '/admin/settings', label: 'Settings', min: 'owner' },
  { to: '/admin/activity', label: 'Activity', min: 'staff' },
  { to: '/admin/export', label: 'Export', min: 'owner' },
  { to: '/admin/team', label: 'Team', min: 'owner' },
  { to: '/admin/checklist', label: 'Checklist', min: 'developer' },
  { to: '/admin/lab', label: 'Test lab', min: 'developer', staging: true },
  { to: '/admin/outbox', label: 'Outbox', min: 'developer', staging: true },
  { to: '/admin/simulator', label: 'Simulator', min: 'developer', staging: true },
  { to: '/admin/help', label: 'Help', min: 'staff' },
];

const PAGES: Record<string, ReactElement> = {
  book: <div className="narrow-page"><h2>Phone booking</h2><BookingForm /></div>,
  customers: <Customers />, approvals: <Approvals />, postcards: <Postcards />, settings: <Settings />,
  activity: <Activity />, export: <Export />, team: <Team />, checklist: <Checklist />,
  lab: <Lab />, outbox: <Outbox />, simulator: <Simulator />,
};


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
      {(session) => {
        const role: Role = isRole(session.user.app_metadata?.role) ? session.user.app_metadata.role : 'staff';
        const tabs = NAV.filter((n) => atLeast(role, n.min) && (!n.staging || STAGING));
        return (
          <div className="admin">
            <header className="admin-top">
              <strong className="admin-brand">Art’s Servicenter</strong>
              <nav aria-label="Admin">
                {tabs.map(({ to, label }) => (
                  <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'on' : '')}>{label}</NavLink>
                ))}
              </nav>
              <span className="muted small push">{session.user.email} · {ROLE_LABEL[role]}</span>
              <button className="btn small" onClick={signOut}>Sign out</button>
            </header>
            <main className="admin-main">
              <ErrorBanner />
              <RoleContext.Provider value={role}>
                <Routes>
                  <Route index element={<DayView />} />
                  {tabs.filter((n) => n.to !== '/admin' && n.to !== '/admin/help').map((n) => {
                    const path = n.to.slice('/admin/'.length);
                    return <Route key={path} path={path} element={PAGES[path]} />;
                  })}
                  <Route path="help" element={<Help role={role} />} />
                  <Route path="*" element={<p className="muted">That page isn’t available for your role.</p>} />
                </Routes>
              </RoleContext.Provider>
            </main>
          </div>
        );
      }}
    </AuthGate>
  );
}
