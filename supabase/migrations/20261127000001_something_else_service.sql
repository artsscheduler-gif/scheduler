-- "Something else" now requires the customer to describe the problem. Every
-- booking already goes to the shop for approval, so the shop reads the
-- description and confirms or proposes a different time.
alter table arts.services add column needs_description boolean not null default false;

update arts.services
   set needs_description = true,
       description = 'Not on the list? Tell us what is going on and we will confirm a time.'
 where name = 'Something else';

insert into arts.services (name, description, duration_minutes, wait_eligible, sort_order, needs_description)
select 'Something else', 'Not on the list? Tell us what is going on and we will confirm a time.', 60, false, 999, true
where not exists (select 1 from arts.services where needs_description);
