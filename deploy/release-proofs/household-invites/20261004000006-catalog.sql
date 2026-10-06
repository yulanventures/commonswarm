-- Run as the local/release catalog role after migration 06.
SELECT coalesce((
SELECT to_regprocedure('swarm_read.human_invitations()') IS NOT NULL
 AND (SELECT count(*)=1 AND bool_and(prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog']
  AND md5(prosrc)='1708dada36fa54cdbf4401ae71500f97' AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))
  FROM pg_proc WHERE oid=to_regprocedure('swarm_read.human_invitations()'))
 AND has_schema_privilege('swarm_read',to_regnamespace('swarm_read'),'USAGE')
 AND NOT has_schema_privilege('swarm_read',to_regnamespace('swarm_read'),'CREATE')
 AND has_function_privilege('swarm_read',to_regprocedure('swarm_read.human_invitations()'),'EXECUTE')
 AND NOT has_function_privilege('swarm_command',to_regprocedure('swarm_read.human_invitations()'),'EXECUTE')
 AND NOT has_function_privilege('anon',to_regprocedure('swarm_read.human_invitations()'),'EXECUTE')
 AND NOT has_function_privilege('authenticated',to_regprocedure('swarm_read.human_invitations()'),'EXECUTE')
 AND (SELECT count(*)=2 AND bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable
   AND a.grantee IN ('swarm_admin'::regrole,'swarm_read'::regrole))
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=to_regprocedure('swarm_read.human_invitations()'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=to_regprocedure('swarm_read.human_invitations()') AND (a.grantee=0 OR a.is_grantable))
 AND (SELECT col_description(attrelid,attnum)='Recipient address binds the verified human invitation review path. Unconfigured legacy capability acceptance retains its historical behavior.' FROM pg_attribute WHERE attrelid=to_regclass('swarm.invitations') AND attname='email')
),false) AS catalog_ok
\gset
