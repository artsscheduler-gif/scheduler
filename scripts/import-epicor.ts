// Shop data import (NAPA TRACS export; monthly). Dry run by default: writes a report and changes nothing.
//   npm run import:epicor -- --file import/private/epicor.csv
//   npm run import:epicor -- --file import/private/epicor.csv --commit
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { csvObjects, toCsvString } from '../shared/csv.js';
import { planImport, reportMarkdown, type Mapping } from '../server/import.js';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i)]) process.env[line.slice(0, i)] = line.slice(i + 1);
}

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const file = arg('--file');
if (!file) {
  console.error('Usage: npm run import:epicor -- --file <export.csv> [--mapping import/epicor-mapping.json] [--commit]');
  process.exit(1);
}
const mapping = JSON.parse(readFileSync(arg('--mapping') ?? 'import/epicor-mapping.json', 'utf8')) as Mapping;
const { loadImportContext, commitImport } = await import('../server/import-db.js');
const ctx = await loadImportContext();
const plan = planImport(csvObjects(readFileSync(file, 'utf8')), mapping, ctx.services, ctx.existing);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = `import/private/reports/${stamp}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/report.md`, reportMarkdown(plan, file));
writeFileSync(`${dir}/rejected.csv`, toCsvString(['row', 'reason', 'data'], plan.rejected.map((r) => ({ ...r, data: JSON.stringify(r.data) }))));
writeFileSync(`${dir}/customers.csv`, toCsvString(
  ['name', 'email', 'phone', 'address_line1', 'city', 'state', 'postal_code', 'email_opt_out', 'mail_opt_out', 'vehicles', 'history', 'rows'],
  plan.customers.map((c) => ({ ...c, vehicles: c.vehicles.length, history: c.history.length, rows: c.rows.join(' ') })),
));
console.log(reportMarkdown(plan, file));
console.log(`Report written to ${dir}/`);

if (args.includes('--commit')) {
  const r = await commitImport(plan, stamp);
  console.log('Committed:', r);
  // Customers who booked online and probably match a TRACS record just imported.
  const { db } = await import('../server/db.js');
  const { data: pairs } = await db().rpc('customer_match_candidates');
  console.log(`${pairs?.length ?? 0} possible match(es) to review: admin → Customers → Possible matches.`);
} else {
  console.log('Dry run only. Review the report, then re-run with --commit.');
}
