-- Local development seed. PLACEHOLDER appointment types until the shop
-- confirms its real list, durations, caps and intervals (see Open Items).
insert into arts.services (name, description, duration_minutes, wait_eligible, daily_cap, lead_days, reminder_interval_months, sort_order, epicor_codes) values
  ('Oil change', 'Oil and filter, top off fluids, quick look-over', 45, true, null, null, 6, 1, '{OIL,LOF}'),
  ('State inspection', 'State safety and emissions inspection', 60, true, null, null, 12, 2, '{INSP,PAINSP}'),
  ('Tire rotation', 'Rotate and check tire pressure', 30, true, null, null, 6, 3, '{ROT}'),
  ('Brakes', 'Brake inspection and repair', 180, false, 1, null, null, 4, '{BRK}'),
  ('Check engine light', 'Diagnose a warning light', 90, false, null, null, null, 5, '{DIAG}'),
  ('Something else', 'Tell us what''s going on and we''ll take a look', 60, false, null, null, null, 6, '{}');

-- Real shop details; Chris's email is still a placeholder (open item).
update arts.shop_settings set shop_name = 'Art''s Servicenter', shop_phone = '(610) 395-9338',
  shop_address = '6661 Tilghman St, Allentown, PA 18106', staff_notify_email = 'chris@example.com',
  logo_url = '/logo.png', brand_color = '#2b3990', slot_step_minutes = 30;
