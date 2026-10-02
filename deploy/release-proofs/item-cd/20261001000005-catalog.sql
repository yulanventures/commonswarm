-- Forward catalog for 20261001000005.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    (SELECT p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef = true AND p.provolatile='s' AND p.proconfig = ARRAY['search_path=pg_catalog']::text[] AND p.proretset = true AND p.prorettype='record'::regtype AND has_function_privilege('swarm_command',p.oid,'EXECUTE') AND NOT has_function_privilege('swarm_read',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AND md5(p.prosrc)='4bdb153e32776752da8cf62f6d430e1a' FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)'))
    AND to_regclass('swarm.admin_routine_workspace_events') IS NULL
    AND (SELECT p.proargnames=ARRAY['p_workspace_id','p_grant_id','p_stream_id','seq','type','schema_version','actor_user','actor_agent_principal','admin_identity_id','grant_id','grant_manifest_digest','occurred_at_server','payload']::text[] AND p.proallargtypes=ARRAY['uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'bigint'::regtype,'text'::regtype,'integer'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'text'::regtype,'timestamptz'::regtype,'jsonb'::regtype]::oid[] FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)'))
    AND NOT has_table_privilege('swarm_command',to_regclass('swarm.events'),'SELECT')
    AND has_table_privilege('swarm_command',to_regclass('swarm.events'),'INSERT')
  ), false) AS catalog_ok
\gset
