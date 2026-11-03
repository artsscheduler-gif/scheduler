// Uploading the edited Excel workbook: preview, then save.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql, resetData, adminToken, reqWith, serviceId } from './helpers';
import { adminAction } from '../../server/admin';

afterAll(() => sql.end());

let owner: string;
const wb = (payload: unknown, apply = false) => adminAction(reqWith(owner), 'workbook-apply', { payload, apply });

async function currentServices() {
  const rows = await sql`select * from arts.services order by sort_order`;
  return rows.map((s) => ({ id: s.id, name: s.name, description: s.description, duration_minutes: s.duration_minutes, wait_eligible: s.wait_eligible,
    daily_cap: s.daily_cap, lead_days: s.lead_days, reminder_interval_months: s.reminder_interval_months, active: s.active, sort_order: s.sort_order, epicor_codes: s.epicor_codes }));
}

beforeEach(async () => {
  await resetData();
  owner = (await adminToken('owner')).token;
});

describe('Workbook upload', () => {
  it('previews changes, then saves them', async () => {
    const services = await currentServices();
    const oil = services.find((s) => s.name === 'Oil change')!;
    oil.duration_minutes = 50;
    const payload = {
      services: [...services, { name: 'Wheel alignment', description: 'Four-wheel alignment', duration_minutes: 60, wait_eligible: false, daily_cap: null, lead_days: null, reminder_interval_months: null, active: true, sort_order: 9, epicor_codes: [] }],
      closures: [{ start_date: '2026-12-24', end_date: '2026-12-26', reason: 'Christmas' }],
      settings: { notes_max_length: 400, timezone: 'America/Chicago' },
    };
    const preview = (await wb(payload)).body as any;
    expect(preview.applied).toBe(false);
    expect(preview.problems).toEqual([]);
    const lines = preview.changes.map((c: any) => `${c.sheet}|${c.action}|${c.label}`);
    expect(lines).toEqual(expect.arrayContaining(['Services|update|Oil change', 'Services|add|Wheel alignment', 'Closures|add|2026-12-24 to 2026-12-26 (Christmas)', 'Settings|update|notes_max_length']));
    // An owner's workbook can't change technical settings: silently ignored.
    expect(lines.some((l: string) => l.includes('timezone'))).toBe(false);
    expect((await sql`select duration_minutes from arts.services where id = ${oil.id}`)[0].duration_minutes).not.toBe(50);

    const saved = (await wb(payload, true)).body as any;
    expect(saved.applied).toBe(true);
    expect((await sql`select duration_minutes from arts.services where id = ${oil.id}`)[0].duration_minutes).toBe(50);
    expect((await sql`select count(*)::int c from arts.services where name = 'Wheel alignment'`)[0].c).toBe(1);
    expect((await sql`select reason from arts.closures`)[0].reason).toBe('Christmas');
    expect((await sql`select notes_max_length, timezone from arts.shop_settings`)[0]).toEqual({ notes_max_length: 400, timezone: 'America/New_York' });
    // Re-uploading the same content finds nothing to do.
    const again = (await wb({ ...payload, services: await currentServices(), closures: (await sql`select id, start_date::text, end_date::text, reason from arts.closures`) })).body as any;
    expect(again.changes.filter((c: any) => c.sheet !== 'Settings')).toEqual([]);
  });

  it('removing a row turns a service off and deletes a closure; a missing sheet is left alone', async () => {
    await sql`insert into arts.closures (start_date, end_date, reason) values ('2026-12-31', '2026-12-31', 'NYE')`;
    const services = (await currentServices()).filter((s) => s.name !== 'Brakes');
    const preview = (await wb({ services, closures: [] })).body as any;
    expect(preview.changes.map((c: any) => `${c.action}|${c.label}`)).toEqual(expect.arrayContaining(['turn off|Brakes', 'remove|2026-12-31 (NYE)']));
    await wb({ services, closures: [] }, true);
    expect((await sql`select active from arts.services where name = 'Brakes'`)[0].active).toBe(false);
    expect((await sql`select count(*)::int c from arts.closures`)[0].c).toBe(0);
    // No blocks sheet in the upload: existing blocks stay.
    await sql`insert into arts.time_blocks (weekday, start_time, end_time) values (5, '15:00', '17:00')`;
    await wb({ services: await currentServices() }, true);
    expect((await sql`select count(*)::int c from arts.time_blocks`)[0].c).toBe(1);
  });

  it('reports bad rows with their sheet and row number and saves nothing', async () => {
    const services = await currentServices();
    const bad = { services: [...services, { _row: 9, name: 'Broken', duration_minutes: 2, wait_eligible: false, active: true, sort_order: 1, epicor_codes: [] }], hours: { mon: { open: '17:00', close: '07:00' } } };
    const r = (await wb(bad, true)).body as any;
    expect(r.applied).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ sheet: 'Services', row: 9 }), expect.objectContaining({ sheet: 'Settings' })]));
    expect((await sql`select count(*)::int c from arts.services where name = 'Broken'`)[0].c).toBe(0);
  });

  it('staff cannot upload', async () => {
    const staff = (await adminToken('staff')).token;
    await expect(adminAction(reqWith(staff), 'workbook-apply', { payload: {}, apply: false })).rejects.toMatchObject({ status: 403 });
    expect(await serviceId('Oil change')).toBeTruthy();
  });
});
