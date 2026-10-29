// Local stand-in for Vercel's function router: serves /api/* from the files
// in /api on port 3000 so `npm run dev` works without linking a Vercel project.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
}

function resolveRoute(path: string): { file: string; params: Record<string, string> } | null {
  const parts = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  let dir = 'api';
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const entries = readdirSync(dir);
    if (last && entries.includes(`${parts[i]}.ts`)) return { file: join(dir, `${parts[i]}.ts`), params };
    if (!last && entries.includes(parts[i])) { dir = join(dir, parts[i]); continue; }
    const dyn = entries.find((e) => /^\[.+\](\.ts)?$/.test(e));
    if (!dyn) return null;
    params[dyn.replace(/^\[|\](\.ts)?$/g, '')] = parts[i];
    if (last && dyn.endsWith('.ts')) return { file: join(dir, dyn), params };
    dir = join(dir, dyn);
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = resolveRoute(url.pathname);
  if (!route) {
    res.statusCode = 404;
    return res.end('{"error":"not_found"}');
  }
  const mod = await import(pathToFileURL(join(process.cwd(), route.file)).href);
  (req as any).query = { ...Object.fromEntries(url.searchParams), ...route.params };
  try {
    await mod.default(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end();
  }
}).listen(3000, () => console.log('dev api on http://localhost:3000'));
