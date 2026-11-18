-- Read-only rollback catalog verification for 20261118000006: the workspace read is gone; a person's own-grants read
-- and the closed table are as they were.
SELECT to_regprocedure('swarm_read.workspace_seat_admin_grants(uuid)') IS NULL
 AND to_regprocedure('swarm_read.my_seat_admin_grants()') IS NOT NULL
 AND has_function_privilege('authenticated','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND NOT has_table_privilege('authenticated','swarm.seat_admin_grants','SELECT')
 AND to_regclass('swarm.seat_admin_grants') IS NOT NULL
 AS rollback_ok
\gset
