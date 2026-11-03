-- Staging can also deliver a copy to a short allowlist of inboxes
-- (EMAIL_DELIVER_TO). Record what happened to that copy.
alter table arts.email_outbox add column delivered text; -- null = not delivered; 'sent:<id>' or 'failed:<reason>'
