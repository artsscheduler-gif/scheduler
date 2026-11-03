-- Customer merge in one transaction, recorded so it can be undone: which rows
-- moved, and what each customer looked like before.

create table arts.customer_merges (
  id uuid primary key default gen_random_uuid(),
  keep_id uuid not null references arts.customers(id),
  merged_id uuid not null references arts.customers(id),
  keep_before jsonb not null,
  merged_before jsonb not null,
  patch jsonb not null,
  moved jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index customer_merges_keep_idx on arts.customer_merges (keep_id);

alter table arts.customer_merges enable row level security;
alter table arts.customer_merges force row level security;
revoke all on arts.customer_merges from public, anon, authenticated;
grant select on arts.customer_merges to authenticated;
grant all on arts.customer_merges to service_role;
create policy admin_read on arts.customer_merges for select to authenticated using (arts.is_admin());
create policy service_all on arts.customer_merges for all to service_role using (true) with check (true);

create function arts.merge_customers(p_keep uuid, p_merge uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  k arts.customers;
  m arts.customers;
  patch jsonb;
  moved jsonb;
  mid uuid;
begin
  if p_keep = p_merge then return jsonb_build_object('ok', false, 'error', 'same_customer'); end if;
  select * into k from arts.customers where id = p_keep for update;
  select * into m from arts.customers where id = p_merge for update;
  if k.id is null or m.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.merged_into is not null or m.merged_into is not null then return jsonb_build_object('ok', false, 'error', 'already_merged'); end if;

  moved := jsonb_build_object(
    'vehicles', coalesce((select jsonb_agg(id) from arts.vehicles where customer_id = p_merge), '[]'),
    'bookings', coalesce((select jsonb_agg(id) from arts.bookings where customer_id = p_merge), '[]'),
    'service_history', coalesce((select jsonb_agg(id) from arts.service_history where customer_id = p_merge), '[]'),
    'reminder_sends', coalesce((select jsonb_agg(id) from arts.reminder_sends where customer_id = p_merge), '[]'),
    'email_log', coalesce((select jsonb_agg(id) from arts.email_log where customer_id = p_merge), '[]'));
  update arts.vehicles set customer_id = p_keep where customer_id = p_merge;
  update arts.bookings set customer_id = p_keep where customer_id = p_merge;
  update arts.service_history set customer_id = p_keep where customer_id = p_merge;
  update arts.reminder_sends set customer_id = p_keep where customer_id = p_merge;
  update arts.email_log set customer_id = p_keep where customer_id = p_merge;

  -- Blanks are filled from the merged record; opt-outs and flags carry over,
  -- so nobody who opted out on either record is contacted.
  patch := jsonb_strip_nulls(jsonb_build_object(
    'email', case when k.email is null then m.email end,
    'phone', case when k.phone is null then m.phone end,
    'address_line1', case when k.address_line1 is null then m.address_line1 end,
    'address_line2', case when k.address_line1 is null then m.address_line2 end,
    'city', case when k.address_line1 is null then m.city end,
    'state', case when k.address_line1 is null then m.state end,
    'postal_code', case when k.address_line1 is null then m.postal_code end,
    'epicor_id', case when k.epicor_id is null then m.epicor_id end,
    'email_opt_out', case when m.email_opt_out and not k.email_opt_out then true end,
    'mail_opt_out', case when m.mail_opt_out and not k.mail_opt_out then true end,
    'email_bounced', case when m.email_bounced and not k.email_bounced then true end,
    'always_review', case when m.always_review and not k.always_review then true end));
  -- The merged record gives up its email/phone first (they may be unique).
  update arts.customers set merged_into = p_keep, email = null, phone = null where id = p_merge;
  update arts.customers c set
    email = coalesce(patch ->> 'email', c.email),
    phone = coalesce(patch ->> 'phone', c.phone),
    address_line1 = coalesce(patch ->> 'address_line1', c.address_line1),
    address_line2 = coalesce(patch ->> 'address_line2', c.address_line2),
    city = coalesce(patch ->> 'city', c.city),
    state = coalesce(patch ->> 'state', c.state),
    postal_code = coalesce(patch ->> 'postal_code', c.postal_code),
    epicor_id = coalesce(patch ->> 'epicor_id', c.epicor_id),
    email_opt_out = c.email_opt_out or coalesce((patch ->> 'email_opt_out')::boolean, false),
    mail_opt_out = c.mail_opt_out or coalesce((patch ->> 'mail_opt_out')::boolean, false),
    email_bounced = c.email_bounced or coalesce((patch ->> 'email_bounced')::boolean, false),
    always_review = c.always_review or coalesce((patch ->> 'always_review')::boolean, false)
  where c.id = p_keep;

  insert into arts.customer_merges (keep_id, merged_id, keep_before, merged_before, patch, moved)
  values (p_keep, p_merge, to_jsonb(k), to_jsonb(m), patch, moved) returning id into mid;
  perform arts.audit(p_actor, 'customer.merge', 'customer', p_keep::text, jsonb_build_object('keep', to_jsonb(k), 'merged', to_jsonb(m)),
    jsonb_build_object('merge_id', mid, 'patch', patch, 'moved', moved));
  return jsonb_build_object('ok', true, 'merge_id', mid);
end $$;

-- Puts both customers back: the moved rows return, the merged record gets its
-- email/phone back, and fields the merge filled in are cleared again unless
-- someone has changed them since.
create function arts.unmerge_customers(p_merge_id uuid, p_actor jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r arts.customer_merges;
  t text;
  f text;
begin
  select * into r from arts.customer_merges where id = p_merge_id for update;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if r.undone_at is not null then return jsonb_build_object('ok', false, 'error', 'already_undone'); end if;

  foreach t in array array['vehicles', 'bookings', 'service_history', 'reminder_sends', 'email_log'] loop
    execute format('update arts.%I set customer_id = $1 where id in (select (jsonb_array_elements_text($2))::uuid)', t)
      using r.merged_id, r.moved -> t;
  end loop;

  for f in select jsonb_object_keys(r.patch) loop
    execute format('update arts.customers set %I = ($1 ->> %L)::%s where id = $2 and %I::text is not distinct from ($3 ->> %L)',
      f, f, case when f in ('email_opt_out', 'mail_opt_out', 'email_bounced', 'always_review') then 'boolean' else 'text' end, f, f)
      using r.keep_before, r.keep_id, r.patch;
  end loop;

  update arts.customers set merged_into = null, email = r.merged_before ->> 'email', phone = r.merged_before ->> 'phone'
    where id = r.merged_id;
  update arts.customer_merges set undone_at = now() where id = r.id;
  perform arts.audit(p_actor, 'customer.unmerge', 'customer', r.keep_id::text, null, jsonb_build_object('merge_id', r.id, 'restored', r.merged_id));
  return jsonb_build_object('ok', true, 'restored', r.merged_id);
end $$;

revoke execute on function arts.merge_customers(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function arts.unmerge_customers(uuid, jsonb) from public, anon, authenticated;
grant execute on function arts.merge_customers(uuid, uuid, jsonb) to service_role;
grant execute on function arts.unmerge_customers(uuid, jsonb) to service_role;
