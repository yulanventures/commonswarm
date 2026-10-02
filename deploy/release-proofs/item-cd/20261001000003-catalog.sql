-- Forward catalog for 20261001000003.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    (SELECT p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef = true AND p.provolatile='s' AND p.proconfig = ARRAY['search_path=pg_catalog']::text[] AND p.proretset = false AND p.prorettype='jsonb'::regtype AND NOT has_function_privilege('swarm_command',p.oid,'EXECUTE') AND has_function_privilege('swarm_read',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AND md5(p.prosrc)='5de08119ca1b0a039061379df8775b5c' FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)'))
  ), false) AS catalog_ok
\gset
