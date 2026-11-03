-- Status changes follow allowed transitions, and reopening a booking whose
-- capacity was released (cancelled, no-show) re-checks the rules first, so
-- "Reopen" can't silently double-book a slot that has since been taken.

drop function arts.set_booking_status(uuid, arts.booking_status, jsonb, timestamptz);

create function arts.set_booking_status(
  p_booking uuid, p_status arts.booking_status, p_actor jsonb,
  p_override boolean default false, p_now timestamptz default now()
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  b arts.bookings;
  before jsonb;
  v_violations text[] := '{}'::text[];
begin
  select * into b from arts.bookings where id = p_booking for update;
  if b.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if not (
    (b.status in ('requested', 'confirmed') and p_status in ('completed', 'no_show', 'cancelled'))
    or (b.status in ('completed', 'no_show', 'cancelled') and p_status = 'confirmed')
    or (b.status = 'completed' and p_status = 'no_show')
    or (b.status = 'no_show' and p_status = 'completed')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition', 'from', b.status);
  end if;
  -- Back to holding capacity after releasing it: the slot must still be free.
  if not arts.holding(b.status) and arts.holding(p_status) then
    perform arts.lock_date(b.date);
    v_violations := arts.check_booking(b.date, b.kind, b.start_time,
      array(select service_id from arts.booking_services where booking_id = b.id), array[b.id], p_now);
    -- Date-window rules don't apply to staff reopening a past or near booking.
    v_violations := array(select x from unnest(v_violations) x where x not in ('before_floor_date', 'beyond_max_days', 'lead_days'));
    if cardinality(v_violations) > 0 and not p_override then
      return jsonb_build_object('ok', false, 'violations', v_violations);
    end if;
  end if;
  before := arts.booking_json(b.id);
  update arts.bookings set status = p_status, updated_at = p_now,
    completed_at = case when p_status = 'completed' then p_now else completed_at end
    where id = b.id;
  -- Completed work drives the next service-due reminder.
  if p_status = 'completed' and b.status <> 'completed' then
    insert into arts.service_history (customer_id, vehicle_id, service_id, service_date, source, booking_id)
    select b.customer_id, b.vehicle_id, bs.service_id, b.date, 'booking', b.id
    from arts.booking_services bs where bs.booking_id = b.id;
  elsif b.status = 'completed' and p_status <> 'completed' then
    delete from arts.service_history where booking_id = b.id;
  end if;
  perform arts.audit(p_actor, 'booking.' || p_status::text, 'booking', b.id::text, before,
    arts.booking_json(b.id) || jsonb_build_object('violations_overridden', v_violations));
  return jsonb_build_object('ok', true, 'booking_id', b.id, 'previous', b.status);
end $$;

revoke execute on function arts.set_booking_status(uuid, arts.booking_status, jsonb, boolean, timestamptz) from public, anon, authenticated;
grant execute on function arts.set_booking_status(uuid, arts.booking_status, jsonb, boolean, timestamptz) to service_role;
