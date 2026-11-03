-- After each monthly TRACS import: customers who booked online (not in TRACS)
-- who probably match a customer the import just brought in, because the tech
-- set them up in TRACS at their first visit with slightly different details.
-- (Exact email/phone matches are linked by the import itself.) Reviewed in the
-- admin: merge into the TRACS record, or dismiss as not the same person.

create table arts.customer_match_dismissals (
  app_id uuid not null references arts.customers(id) on delete cascade,
  tracs_id uuid not null references arts.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (app_id, tracs_id)
);
alter table arts.customer_match_dismissals enable row level security;
alter table arts.customer_match_dismissals force row level security;
revoke all on arts.customer_match_dismissals from public, anon, authenticated;
grant select on arts.customer_match_dismissals to authenticated;
grant all on arts.customer_match_dismissals to service_role;
create policy admin_read on arts.customer_match_dismissals for select to authenticated using (arts.is_admin());
create policy service_all on arts.customer_match_dismissals for all to service_role using (true) with check (true);

-- Same last name, plus at least one of: phone, email, street, a car, or the full name.
create function arts.customer_match_candidates() returns table (app_id uuid, tracs_id uuid, reasons text[])
language sql stable set search_path = '' as $$
  with app as (
    select * from arts.customers
    where epicor_id is null and merged_into is null and name <> 'Removed customer'
  ), tracs as (
    select * from arts.customers where epicor_id is not null and merged_into is null
  ), pairs as (
    select a.id as app_id, t.id as tracs_id, array_remove(array[
      case when a.phone is not null and a.phone = t.phone then 'same phone' end,
      case when a.email is not null and lower(a.email) = lower(t.email) then 'same email' end,
      case when a.address_line1 is not null and upper(a.address_line1) = upper(t.address_line1) then 'same street' end,
      case when exists (
        select 1 from arts.vehicles va join arts.vehicles vt
          on vt.customer_id = t.id and lower(coalesce(vt.make, '')) = lower(coalesce(va.make, ''))
         and lower(coalesce(vt.model, '')) = lower(coalesce(va.model, '')) and va.year is not distinct from vt.year
        where va.customer_id = a.id and va.make is not null
      ) then 'same car' end,
      case when lower(trim(a.name)) = lower(trim(t.name)) then 'same name' end
    ], null) as reasons
    from app a
    join tracs t on lower(regexp_replace(trim(a.name), '^.*\s', '')) = lower(regexp_replace(trim(t.name), '^.*\s', ''))
  )
  select p.app_id, p.tracs_id, p.reasons from pairs p
  where cardinality(p.reasons) > 0
    and not exists (select 1 from arts.customer_match_dismissals d where d.app_id = p.app_id and d.tracs_id = p.tracs_id)
  order by cardinality(p.reasons) desc
$$;
revoke execute on function arts.customer_match_candidates() from public, anon, authenticated;
grant execute on function arts.customer_match_candidates() to service_role;
