-- Test site only (the server refuses unless APP_ENV=staging): wipe bookings,
-- customers and everything hanging off them, captured email and blocked
-- times, for a clean slate. Services, hours, closures, settings, reminder
-- steps, admins, the audit log and the launch checklist are kept.
create or replace function arts.reset_test_data() returns jsonb
language plpgsql set search_path = '' as $$
declare
  n_bookings int;
  n_customers int;
begin
  select count(*) into n_bookings from arts.bookings;
  select count(*) into n_customers from arts.customers;
  truncate arts.booking_services, arts.bookings, arts.service_history, arts.reminder_sends, arts.mail_batches,
    arts.email_log, arts.email_outbox, arts.login_codes, arts.customer_merges, arts.time_blocks,
    arts.vehicles, arts.customers, arts.rate_limits;
  update arts.services set approvals_in_a_row = 0 where approvals_in_a_row <> 0;
  return jsonb_build_object('bookings', n_bookings, 'customers', n_customers);
end $$;

revoke execute on function arts.reset_test_data() from public, anon, authenticated;
grant execute on function arts.reset_test_data() to service_role;
