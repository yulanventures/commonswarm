-- Read-only catalog and body verification for 20261118000006 (an owner reads every agent admin grant covering a workspace).
SELECT (SELECT count(*)=1 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.provolatile='s'
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)='2b788e6214cd58f8c460e57be6aa3127'
   AND p.prorettype='jsonb'::regtype)
 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.workspace_seat_admin_grants(uuid)'))
 AND has_function_privilege('authenticated','swarm_read.workspace_seat_admin_grants(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm_read.workspace_seat_admin_grants(uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm_read.workspace_seat_admin_grants(uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm_read.workspace_seat_admin_grants(uuid)','EXECUTE')
 -- Nothing else moved: people still read their own grants, and the table stays closed to them.
 AND has_function_privilege('authenticated','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND NOT has_table_privilege('authenticated','swarm.seat_admin_grants','SELECT')
 AND NOT has_table_privilege('anon','swarm.seat_admin_grants','SELECT')
 AS catalog_ok
\gset
