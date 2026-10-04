-- Run as the local/release catalog role after migration 06.
SELECT to_regprocedure('swarm_read.human_invitations()') IS NOT NULL
 AND (SELECT count(*)=1 AND bool_and(prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog']
  AND md5(prosrc)='d8fe3aa76fc15a376286386233154899' AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))
  FROM pg_proc WHERE oid=to_regprocedure('swarm_read.human_invitations()'))
 AND has_function_privilege('swarm_read','swarm_read.human_invitations()','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm_read.human_invitations()','EXECUTE')
 AND NOT has_function_privilege('anon','swarm_read.human_invitations()','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm_read.human_invitations()','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=to_regprocedure('swarm_read.human_invitations()') AND (a.grantee=0 OR a.is_grantable))
 AND (SELECT col_description(attrelid,attnum)='Recipient address binds the verified human invitation review path. Unconfigured legacy capability acceptance retains its historical behavior.' FROM pg_attribute WHERE attrelid='swarm.invitations'::regclass AND attname='email') AS catalog_ok
\gset
