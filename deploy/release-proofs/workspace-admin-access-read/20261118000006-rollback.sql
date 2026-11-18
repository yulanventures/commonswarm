-- Rollback for 20261118000006: drop the one read it added. No data, table or other function is touched.
-- Roll the site back first, or the Admins tab shows "could not load" with Retry until it is.
DROP FUNCTION IF EXISTS swarm_read.workspace_seat_admin_grants(uuid);
