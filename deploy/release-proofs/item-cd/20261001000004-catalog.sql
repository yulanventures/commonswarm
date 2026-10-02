-- Forward catalog for 20261001000004.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    (SELECT p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef = true AND p.provolatile='v' AND p.proconfig = ARRAY['search_path=swarm, pg_catalog']::text[] AND p.proretset = true AND p.prorettype='record'::regtype AND NOT has_function_privilege('swarm_command',p.oid,'EXECUTE') AND has_function_privilege('swarm_read',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AND md5(p.prosrc)='f98683cd84e7096d574e8fb19532b097' FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'))
    AND (SELECT p.proargnames=ARRAY['p_token_hash','p_workspace_id','token_id','principal_id','owner_user_id','principal_workspace_id','run_id','device_id','first_use','membership_revoked_at','is_revoked','pending_delivery_count','wake_id','managed_at']::text[] AND p.proallargtypes=ARRAY['bytea'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'boolean'::regtype,'timestamptz'::regtype,'boolean'::regtype,'integer'::regtype,'text'::regtype,'timestamptz'::regtype]::oid[] FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'))
    AND (SELECT provolatile='v' FROM pg_proc WHERE oid=to_regprocedure('swarm.admin_child_scopes_live(uuid,jsonb)'))
  ), false) AS catalog_ok
\gset
