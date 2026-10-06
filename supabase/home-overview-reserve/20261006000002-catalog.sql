-- Exact read surface: two definer functions, fixed paths, human-only RPC access.
SELECT coalesce((
SELECT
 (SELECT proowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
   AND prosecdef AND provolatile = 'v' AND prorettype = 'jsonb'::regtype
   AND proconfig = ARRAY['search_path=pg_catalog']::text[] AND pronargs = 0
  FROM pg_proc WHERE oid = to_regprocedure('swarm_read.home_overview()'))
 AND (SELECT proowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
   AND prosecdef AND provolatile = 's' AND prorettype = 'boolean'::regtype
   AND proconfig = ARRAY['search_path=pg_catalog']::text[] AND pronargs = 2
  FROM pg_proc WHERE oid = to_regprocedure('swarm.household_human_can_read(uuid,uuid)'))
 AND has_function_privilege('authenticated',to_regprocedure('swarm_read.home_overview()'),'EXECUTE')
 AND NOT EXISTS (
  SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid IN (to_regprocedure('swarm_read.home_overview()'),to_regprocedure('swarm.household_human_can_read(uuid,uuid)'))
   AND (a.is_grantable AND a.grantee <> p.proowner
    OR a.privilege_type <> 'EXECUTE'
    OR a.grantee NOT IN (p.proowner, CASE WHEN p.oid = to_regprocedure('swarm_read.home_overview()')
     THEN (SELECT oid FROM pg_roles WHERE rolname = 'authenticated') ELSE p.proowner END))
 )
 AND NOT has_function_privilege('anon',to_regprocedure('swarm_read.home_overview()'),'EXECUTE')
 AND NOT has_function_privilege('swarm_read',to_regprocedure('swarm_read.home_overview()'),'EXECUTE')
 AND NOT has_function_privilege('swarm_command',to_regprocedure('swarm_read.home_overview()'),'EXECUTE')
 AND NOT has_function_privilege('anon',to_regprocedure('swarm.household_human_can_read(uuid,uuid)'),'EXECUTE')
 AND NOT has_function_privilege('authenticated',to_regprocedure('swarm.household_human_can_read(uuid,uuid)'),'EXECUTE')
 AND NOT has_function_privilege('swarm_read',to_regprocedure('swarm.household_human_can_read(uuid,uuid)'),'EXECUTE')
 AND NOT has_function_privilege('swarm_command',to_regprocedure('swarm.household_human_can_read(uuid,uuid)'),'EXECUTE')

),false) AS catalog_ok
\gset
