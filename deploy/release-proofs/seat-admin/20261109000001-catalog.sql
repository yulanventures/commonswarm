-- Read-only catalog verification for 20261109000001: the seat admin table, its guards and its privileges.
SELECT to_regclass('swarm.seat_admin_grants') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.seat_admin_grants'::regclass
   AND tgname='seat_admin_grants_forward_only' AND NOT tgisinternal)
 AND (SELECT count(*)=3 FROM pg_indexes WHERE schemaname='swarm' AND indexname IN
   ('seat_admin_grants_one_active','seat_admin_grants_one_active_workspace','seat_admin_grants_one_active_organization'))
 AND (SELECT relrowsecurity FROM pg_class WHERE oid='swarm.seat_admin_grants'::regclass)
 AND has_table_privilege('swarm_command','swarm.seat_admin_grants','SELECT,INSERT')
 AND NOT has_table_privilege('swarm_command','swarm.seat_admin_grants','DELETE')
 AND NOT has_column_privilege('swarm_command','swarm.seat_admin_grants','scope_names','UPDATE')
 AND has_column_privilege('swarm_command','swarm.seat_admin_grants','state','UPDATE')
 AND NOT has_table_privilege('authenticated','swarm.seat_admin_grants','SELECT')
 AND NOT has_table_privilege('anon','swarm.seat_admin_grants','SELECT')
 AND NOT has_table_privilege('swarm_read','swarm.seat_admin_grants','SELECT')
 AND has_function_privilege('authenticated','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND NOT has_function_privilege('anon','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND (SELECT prosecdef FROM pg_proc WHERE oid='swarm_read.my_seat_admin_grants()'::regprocedure)
 AND has_function_privilege('swarm_command','swarm.seat_admin_org_owner(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.seat_admin_org_owner(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.seat_admin_org_owner(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.seat_admin_text_set(text[])','EXECUTE')
 AND has_function_privilege('swarm_command','swarm.seat_admin_uuid_set(uuid[])','EXECUTE')
 AS catalog_ok
\gset
