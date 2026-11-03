// Human-readable names for rule codes returned by arts.check_booking.
export function describeViolation(code: string): string {
  if (code.startsWith('daily_cap:')) return `Daily limit reached for ${code.slice(10)}`;
  const map: Record<string, string> = {
    no_services: 'No appointment type selected',
    service_inactive: 'An appointment type is no longer offered',
    closed: 'Shop is closed that day',
    before_floor_date: 'Too soon: earliest online booking date not reached',
    lead_days: 'Too soon for this type of work (lead time)',
    beyond_max_days: 'Too far ahead',
    day_capacity: 'Day is full (all lanes booked)',
    dropoff_share: 'Drop-off share for the day is used up',
    not_wait_eligible: 'One of these services can’t be done while waiting',
    start_required: 'Pick a start time',
    outside_hours: 'Outside shop hours',
    off_grid: 'Start time isn’t on the booking grid',
    waiter_lanes: 'All waiter lanes are taken at that time',
    blocked: 'That time is blocked off',
    customer_limit: 'Customer already has the maximum number of future bookings',
    notes_too_long: 'Notes are too long',
    invalid_request: 'Request is missing a date or type',
    booking_not_active: 'Appointment is no longer active',
  };
  return map[code] ?? code;
}

export const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  declined: 'Declined',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  replaced: 'Replaced',
};

export const LEVEL_LABEL: Record<string, string> = {
  approve: '1 · Approve',
  notify: '2 · Confirm & notify',
  digest: '3 · Confirm & digest',
};
