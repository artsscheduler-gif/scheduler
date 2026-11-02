// Staging builds (VITE_APP_ENV=staging) show the TEST SITE banner and the
// Outbox and Simulator admin tabs. The server refuses those actions unless
// APP_ENV=staging is also set there.
export const STAGING = import.meta.env.VITE_APP_ENV === 'staging';
