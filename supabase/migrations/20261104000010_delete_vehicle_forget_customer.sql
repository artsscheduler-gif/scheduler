-- Removing a sold car, and forgetting a customer who asks.

-- A vehicle goes with its service history and reminders (so reminders for it
-- stop); past bookings stay, without the vehicle.
create function arts.delete_vehicle(p_vehicle uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v arts.vehicles;
  nh int;
begin
  select * into v from arts.vehicles where id = p_vehicle for update;
  if v.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update arts.bookings set vehicle_id = null where vehicle_id = p_vehicle;
  delete from arts.reminder_sends where vehicle_id = p_vehicle;
  delete from arts.service_history where vehicle_id = p_vehicle;
  get diagnostics nh = row_count;
  delete from arts.vehicles where id = p_vehicle;
  perform arts.audit(p_actor, 'vehicle.delete', 'vehicle', p_vehicle::text, to_jsonb(v), jsonb_build_object('history_removed', nh));
  return jsonb_build_object('ok', true, 'history_removed', nh);
end $$;

-- "Forget me": personal details, vehicles, history and reminders are removed;
-- upcoming appointments are cancelled. Past bookings stay as anonymous rows so
-- the schedule and counts remain correct. The audit entry records only the id.
create function arts.forget_customer(p_customer uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  c arts.customers;
  ncancel int;
begin
  select * into c from arts.customers where id = p_customer for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update arts.bookings set status = 'cancelled', updated_at = now()
    where customer_id = p_customer and status in ('requested', 'confirmed') and date >= arts.today();
  get diagnostics ncancel = row_count;
  update arts.bookings set vehicle_id = null, customer_notes = '' where customer_id = p_customer;
  delete from arts.reminder_sends where customer_id = p_customer;
  delete from arts.service_history where customer_id = p_customer;
  delete from arts.vehicles where customer_id = p_customer;
  update arts.email_log set to_email = 'removed' where customer_id = p_customer;
  delete from arts.customer_merges where keep_id = p_customer or merged_id = p_customer;
  update arts.customers set name = 'Removed customer', email = null, phone = null, address_line1 = null, address_line2 = null,
    city = null, state = null, postal_code = null, epicor_id = null,
    email_opt_out = true, mail_opt_out = true, always_review = false
    where id = p_customer or merged_into = p_customer;
  perform arts.audit(p_actor, 'customer.forget', 'customer', p_customer::text, null, jsonb_build_object('cancelled_upcoming', ncancel));
  return jsonb_build_object('ok', true, 'cancelled_upcoming', ncancel);
end $$;

revoke execute on function arts.delete_vehicle(uuid, jsonb) from public, anon, authenticated;
revoke execute on function arts.forget_customer(uuid, jsonb) from public, anon, authenticated;
grant execute on function arts.delete_vehicle(uuid, jsonb) to service_role;
grant execute on function arts.forget_customer(uuid, jsonb) to service_role;
