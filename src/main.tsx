import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import './styles.css';
import { BookingApp } from './public/BookingApp';
import { ManagePage } from './public/ManagePage';
import { UnsubscribePage } from './public/UnsubscribePage';
import { STAGING } from './lib/env';

// Admin code (and the Supabase client) never loads on the public pages.
const AdminApp = lazy(() => import('./admin/AdminApp'));

if (STAGING) {
  const robots = document.createElement('meta');
  robots.name = 'robots';
  robots.content = 'noindex, nofollow';
  document.head.append(robots);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {STAGING && <div className="staging-flag" role="note">TEST SITE: nothing booked here is real, and no email leaves this site.</div>}
      <Routes>
        <Route path="/" element={<BookingApp />} />
        <Route path="/manage" element={<ManagePage />} />
        <Route path="/unsubscribe" element={<UnsubscribePage />} />
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<div className="admin-loading">Loading…</div>}>
              <AdminApp />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
