-- Read-only catalog and body verification for 20261118000001 (channel lead backup).
SELECT (SELECT count(*)=2 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.channel_effective_live_lead(uuid,uuid)','3fe3ceef25ffe034bbfee40f88c18944'),
  ('swarm.agent_listener_is_live(uuid)','59ef0215a699a9d1bb9cd22af1bddfad')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND has_function_privilege('swarm_command','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.agent_listener_is_live(uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.agent_listener_is_live(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.agent_listener_is_live(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.agent_listener_is_live(uuid)','EXECUTE')
 AS catalog_ok
\gset
