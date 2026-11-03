-- Chris approves every online booking: no service confirms itself. (The
-- approval ladder stays in the schema in case it's wanted later.)
update arts.services set approval_level = 'approve', approvals_in_a_row = 0, level_since = now() where approval_level <> 'approve';
