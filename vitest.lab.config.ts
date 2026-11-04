import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The test lab: a simulated month at the shop plus randomized rule checks.
// Runs against the local database (it wipes it first), never staging.
export default defineConfig({
  test: {
    ...base.test,
    include: ['tests/lab/**/*.lab.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 30 * 60_000,
  },
});
