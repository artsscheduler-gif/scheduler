import type { ReactElement } from 'react';
import { NavLink, Route, Routes, useSearchParams } from 'react-router';
import { Settings } from './Settings';
import { Activity } from './Activity';
import { Export } from './Export';
import { Team } from './Team';
import { Checklist } from './Checklist';
import { Lab } from './Lab';
import { Simulator } from './Simulator';
import { Outbox } from './Outbox';
import { TestRuns } from './TestRuns';
import { useRole } from './shared';
import { STAGING } from '../lib/env';
import { atLeast, type Role } from '../../shared/permissions';

// Settings → tabs. Chris (owner) sees only Shop, so for him there's no tab
// bar at all; the developer's tools live in the other tabs.
const TABS: { path: string; label: string; min: Role; staging?: boolean; page: ReactElement }[] = [
  { path: '', label: 'Shop', min: 'owner', page: <Settings /> },
  { path: 'simulator', label: 'Simulator', min: 'owner', staging: true, page: <SimulatorHub /> },
  { path: 'test-runs', label: 'Test runs', min: 'developer', page: <TestRuns /> },
  { path: 'activity', label: 'Activity', min: 'developer', page: <Activity /> },
  { path: 'export', label: 'Export', min: 'developer', page: <Export /> },
  { path: 'team', label: 'Team', min: 'developer', page: <Team /> },
  { path: 'checklist', label: 'Checklist', min: 'developer', page: <Checklist /> },
];

export const SETTINGS_TAB_PATHS = TABS.filter((t) => t.path).map((t) => t.path);

export function SettingsHub() {
  const role = useRole();
  const tabs = TABS.filter((t) => atLeast(role, t.min) && (!t.staging || STAGING));
  return (
    <>
      {tabs.length > 1 && (
        <nav className="subtabs" aria-label="Settings">
          {tabs.map((t) => (
            <NavLink key={t.path} to={`/admin/settings${t.path ? `/${t.path}` : ''}`} end className={({ isActive }) => (isActive ? 'on' : '')}>{t.label}</NavLink>
          ))}
        </nav>
      )}
      <Routes>
        {tabs.map((t) => <Route key={t.path} {...(t.path ? { path: t.path } : { index: true })} element={t.page} />)}
        <Route path="*" element={<p className="muted">That page isn’t available for your role.</p>} />
      </Routes>
    </>
  );
}

// The hands-on staging tools in one place: walk through a booking as the
// customer and as Chris, load sample data and fast-forward, and read every
// captured email.
const VIEWS = [
  { key: 'walkthrough', label: 'Walk-through', page: () => <Lab /> },
  { key: 'data', label: 'Sample data', page: () => <Simulator /> },
  { key: 'emails', label: 'All emails', page: () => <Outbox /> },
] as const;

function SimulatorHub() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.key === params.get('view')) ?? VIEWS[0];
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Simulator">
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={v.key === view.key} className={v.key === view.key ? 'on' : ''} onClick={() => setParams({ view: v.key })}>{v.label}</button>
        ))}
      </div>
      {view.page()}
    </>
  );
}
