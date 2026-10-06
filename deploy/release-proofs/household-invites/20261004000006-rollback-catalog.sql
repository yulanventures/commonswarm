SELECT to_regprocedure('swarm_read.human_invitations()') IS NULL
 AND to_regclass('swarm.admin_routine_invitations') IS NOT NULL
 AND to_regclass('swarm.household_member_content_roles') IS NOT NULL
 AND to_regclass('swarm.admin_events') IS NOT NULL AND (SELECT col_description(attrelid,attnum)='Bookkeeping and invite-page rendering only; never an authorization input.' FROM pg_attribute WHERE attrelid='swarm.invitations'::regclass AND attname='email') AS rollback_ok
\gset
