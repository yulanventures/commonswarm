-- Read-only catalog and body verification for 20261103000001 (workspace lead).
SELECT (SELECT count(*)=5 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.workspace_live_lead(uuid)','ffc422a221b9eb58db2d89f0f7173eb7'),
  ('swarm.set_workspace_lead(uuid,uuid,uuid)','a531fae974042c792c3cdf602ec8666b'),
  ('swarm.clear_workspace_lead_on_principal_revoke()','2e3d6d4fe984f6b9bce0e7423cf85117'),
  ('swarm.clear_workspace_lead_on_agent_exit()','d4cce16d36e3b5bc19933cb0f79fb379'),
  ('swarm.clear_workspace_lead_on_owner_exit()','79f5cfdd045b8b882176ec4d5fc4476f')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.workspaces'::regclass AND attname='lead_agent_principal_id' AND NOT attisdropped AND atttypid='uuid'::regtype)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.workspaces'::regclass AND contype='f' AND confrelid='swarm.agent_principals'::regclass
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='swarm.workspaces'::regclass AND attname='lead_agent_principal_id')])
 AND has_function_privilege('swarm_command','swarm.set_workspace_lead(uuid,uuid,uuid)','EXECUTE')
 AND has_function_privilege('swarm_command','swarm.workspace_live_lead(uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.set_workspace_lead(uuid,uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.set_workspace_lead(uuid,uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.workspace_live_lead(uuid)','EXECUTE')
 AND (SELECT count(*)=3 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname,tgfoid) IN (
   ('swarm.agent_principals'::regclass,'agent_principals_clear_workspace_lead',to_regprocedure('swarm.clear_workspace_lead_on_principal_revoke()')),
   ('swarm.agent_workspace_memberships'::regclass,'agent_workspace_memberships_clear_lead',to_regprocedure('swarm.clear_workspace_lead_on_agent_exit()')),
   ('swarm.memberships'::regclass,'memberships_clear_workspace_lead',to_regprocedure('swarm.clear_workspace_lead_on_owner_exit()'))))
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.workspaces'::regclass AND attname='lead_agent_principal_id' AND attnum=6 AND NOT attisdropped)
 AS catalog_ok
\gset
