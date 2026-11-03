-- Read-only catalog and body verification for 20261103000002 (reconnect inherits stranded hosted agents).
SELECT (SELECT p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)='24f42cae59bf2bcf72bcf0986e09eec8'
   FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.inherit_stranded_hosted_agents(uuid)'))
 AND has_function_privilege('swarm_command','swarm.inherit_stranded_hosted_agents(uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.inherit_stranded_hosted_agents(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.inherit_stranded_hosted_agents(uuid)','EXECUTE')
 AND NOT has_function_privilege('commonswarm_oauth_runtime','swarm.inherit_stranded_hosted_agents(uuid)','EXECUTE')
 AS catalog_ok
\gset
