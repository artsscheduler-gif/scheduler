-- The printer's proof (PDF link) for each postcard sent, shown in the admin.
alter table arts.reminder_sends add column preview_url text;
