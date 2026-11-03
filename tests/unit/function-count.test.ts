import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Vercel Hobby refuses a deployment with more than 12 serverless functions
// (each file under api/ is one). Fail here instead of at deploy time.
function count(dir: string): number {
  return readdirSync(dir).reduce((n, f) => {
    const p = join(dir, f);
    return n + (statSync(p).isDirectory() ? count(p) : /\.(ts|js|mjs)$/.test(f) ? 1 : 0);
  }, 0);
}

describe('deploy limits', () => {
  it('stays within Vercel Hobby’s 12 serverless functions', () => {
    expect(count('api')).toBeLessThanOrEqual(12);
  });
});
