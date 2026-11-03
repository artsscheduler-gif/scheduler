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
  ...(STAGING ? [['/admin/outbox', 'Outbox'], ['/admin/simulator', 'Simulator']] as [string, string][] : []),
];

export default function AdminApp() {
  return (
    <AuthGate>
      {(session) => (
        <div className="admin">
          <header className="admin-top">
            <strong className="admin-brand">Art’s Servicenter</strong>
            <nav aria-label="Admin">
              {NAV.map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'on' : '')}>{label}</NavLink>
              ))}
            </nav>
            <span className="muted small push">{session.user.email}</span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </header>
          <main className="admin-main">
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
            </Routes>
          </main>
        </div>
      )}
    </AuthGate>
  );
}
