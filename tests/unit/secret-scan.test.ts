import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function scan(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  writeFileSync(join(dir, 'index.js'), content);
  return spawnSync('node', ['scripts/check-bundle-secrets.mjs', dir], { encoding: 'utf8' });
}

describe('client bundle secret check', () => {
  it('passes a clean bundle', () => {
    expect(scan('console.log("hello")').status).toBe(0);
  });
  it('fails when the service role key leaks', () => {
    const r = scan(`const k = "${process.env.SUPABASE_SERVICE_ROLE_KEY}";`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('fails on the token secret and on provider key shapes', () => {
    expect(scan(`x="${process.env.TOKEN_SECRET}"`).status).toBe(1);
    expect(scan('k="sb_secret_abcdefghijklmnop"').status).toBe(1);
  });
});
