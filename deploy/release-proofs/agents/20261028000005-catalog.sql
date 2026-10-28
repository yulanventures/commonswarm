-- Read-only catalog and body verification for 20261028000005.
SELECT (SELECT count(*)=3 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.agent_delivery_read_context(bytea,uuid)','f77ce7bb2b625990109a9223b4ae8fd4'),
  ('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','2d41274fdb0cffba57430d1c484e8f94'),
  ('swarm.ensure_hosted_grant_agent()','5797dd7f97f5c15364c8c26fa727d35a')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND has_function_privilege('swarm_read','swarm.agent_delivery_read_context(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.agent_delivery_read_context(bytea,uuid)','EXECUTE')
 AND has_function_privilege('swarm_command','swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.ensure_hosted_grant_agent()','EXECUTE')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_seats')
   AND tgfoid=to_regprocedure('swarm.ensure_hosted_grant_agent()') AND tgenabled='O' AND tgtype=7)
 AS catalog_ok
\gset
