import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'node:fs';

function loadEnv(path: string) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

export default defineConfig({
  test: {
    env: { ...loadEnv('.env.local'), EMAIL_PROVIDER: 'stub', MAIL_PROVIDER: 'stub' },
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
