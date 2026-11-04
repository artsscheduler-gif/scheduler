// "A month at Art's": plays out several weeks of the shop at simulated speed
// and checks every rule after each day. Replay a run with LAB_SEED=<seed>;
// change the length with LAB_DAYS. Writes tests/lab/out/report.md.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sql, resetData } from '../db/helpers';
import { StubEmailProvider } from '../../server/email/provider';
import { addDays } from '../../shared/time';
import { checkAll, type Broken } from './invariants';
import { Rng, labSeed, nextMonday, isoDow, hhmm } from './lib';
import { Shop } from './shop';

const SEED = labSeed();
const DAYS = Number(process.env.LAB_DAYS ?? 42);
const CUSTOMERS = Number(process.env.LAB_CUSTOMERS ?? 220);

afterAll(async () => {
  await sql.end();
});

describe(`a month at Art's (seed ${SEED})`, () => {
  it(`runs ${DAYS} days without breaking a rule`, async () => {
    const rng = new Rng(SEED);
    const shop = new Shop(rng);
    await resetData();
    await shop.setup();
    const start = nextMonday(new Date().toISOString().slice(0, 10));
    shop.clock.start();
    const broken: (Broken & { day: string })[] = [];
    const started = Date.now();
    try {
      shop.clock.set(addDays(start, -1), '12:00');
      await shop.seedTracs(CUSTOMERS, start);
      const regulars = shop.people.filter((p) => p.tracsId);

      for (let i = 0; i < DAYS; i++) {
        const date = addDays(start, i);
        const open = isoDow(date) <= 5;

        shop.clock.set(date, '06:00');
        await shop.nightlyJob();
        await shop.someoneUnsubscribes();

        // Online bookings come in all day, every day.
        const arrivals = rng.int(6, 16);
        for (let k = 0; k < arrivals; k++) {
          shop.clock.set(date, hhmm(rng.int(6 * 60, 22 * 60)));
          const who = rng.weighted<'regular' | 'regular-link' | 'new' | 'family' | 'online-again' | 'anything'>([
            ['regular', 40], ['regular-link', 12], ['new', 25], ['family', 5], ['online-again', 10], ['anything', 8],
          ]);
          if (who === 'regular' || who === 'regular-link') await shop.customerBooks(rng.pick(regulars), { loggedIn: who === 'regular-link' });
          else if (who === 'new') await shop.customerBooks(shop.newPerson());
          else if (who === 'family') await shop.customerBooks(shop.addHousehold(rng.pick(regulars)));
          else if (who === 'online-again') {
            const online = shop.people.filter((p) => !p.tracsId || p.tracsId.startsWith('W'));
            await shop.customerBooks(online.length ? rng.pick(online) : shop.newPerson());
          } else await shop.customerTriesAnything(rng.chance(0.5) ? rng.pick(regulars) : shop.newPerson());
        }

        shop.clock.set(date, '19:30');
        await shop.customerChangesMind();

        if (open) {
          shop.clock.set(date, '08:15');
          await shop.chrisAnswersRequests();
          shop.clock.set(date, '12:00');
          await shop.hourlyJob();
          if (rng.chance(0.25)) await shop.chrisMovesOne();
          if (rng.chance(0.1)) await shop.chrisChangesTheCalendar('block');
          if (i === 9) await shop.chrisChangesTheCalendar('closure');
          shop.clock.set(date, '15:30');
          await shop.chrisAnswersRequests();
          shop.clock.set(date, '17:45');
          await shop.closeOutDay();
        }

        // The TRACS export arrives every four weeks.
        if (i % 28 === 27) {
          shop.clock.set(date, '20:00');
          await shop.monthlyTracsFeed();
          await shop.dataQuality();
        }

        shop.clock.set(date, '23:00');
        for (const b of await checkAll({ ...shop.ctx })) broken.push({ ...b, day: date });
      }
      shop.clock.set(addDays(start, DAYS), '20:00');
      await shop.monthlyTracsFeed();
      await shop.dataQuality();
      for (const b of await checkAll({ ...shop.ctx })) broken.push({ ...b, day: 'end' });
    } finally {
      shop.clock.stop();
    }

    const totals = (await sql`
      select (select count(*) from arts.customers)::int as customers, (select count(*) from arts.bookings)::int as bookings,
             (select count(*) from arts.reminder_sends where status = 'sent')::int as reminders_sent,
             (select count(*) from arts.email_log)::int as emails, (select count(*) from arts.customer_merges)::int as merges`)[0];
    const report = writeReport({ seed: SEED, days: DAYS, start, seconds: Math.round((Date.now() - started) / 1000), shop, broken, totals, outbox: StubEmailProvider.outbox.length });
    console.log(report);
    // The same rule failing every day after it first broke is one problem.
    const first = new Map<string, Broken & { day: string }>();
    for (const b of broken) if (!first.has(b.rule + b.detail)) first.set(b.rule + b.detail, b);
    expect([...first.values()], `Rules broken (replay with LAB_SEED=${SEED})`).toEqual([]);
  }, 30 * 60_000);
});

function writeReport(r: { seed: number; days: number; start: string; seconds: number; shop: Shop; broken: (Broken & { day: string })[]; totals: Record<string, number>; outbox: number }) {
  const lines: string[] = [];
  lines.push(`# Test lab: ${r.days} days at Art's`, '', `Seed ${r.seed} · simulated from ${r.start} · took ${r.seconds}s`, `Replay: \`LAB_SEED=${r.seed} npm run lab\``, '');
  lines.push('## Rules broken', '');
  const byRule = new Map<string, (Broken & { day: string })[]>();
  for (const b of r.broken) byRule.set(b.rule, [...(byRule.get(b.rule) ?? []), b]);
  if (!byRule.size) lines.push('None.');
  for (const [rule, xs] of byRule) {
    const uniq = [...new Map(xs.map((x) => [x.detail, x])).values()];
    lines.push(`- **${rule}** (${uniq.length}, first on ${uniq[0].day})`, ...uniq.slice(0, 5).map((x) => `  - ${x.day}: ${x.detail}`));
  }
  lines.push('', '## Findings to look at', '');
  if (!r.shop.findings.size) lines.push('None.');
  for (const [kind, xs] of [...r.shop.findings].sort((a, b) => b[1].length - a[1].length)) {
    const uniq = [...new Set(xs.map((x) => x.replace(/^\S+: /, '')))];
    lines.push(`- **${kind}** (${uniq.length})`, ...uniq.slice(0, 4).map((x) => `  - ${x}`));
  }
  lines.push('', '## What happened', '');
  for (const [k, v] of Object.entries(r.totals)) lines.push(`- ${k.replace(/_/g, ' ')}: ${v}`);
  for (const [k, v] of Object.entries(r.shop.stats).sort()) lines.push(`- ${k}: ${v}`);
  const md = lines.join('\n') + '\n';
  mkdirSync('tests/lab/out', { recursive: true });
  writeFileSync('tests/lab/out/report.md', md);
  writeFileSync('tests/lab/out/report.json', JSON.stringify({ seed: r.seed, days: r.days, broken: r.broken, findings: Object.fromEntries(r.shop.findings), stats: r.shop.stats, totals: r.totals }, null, 2));
  return md;
}
