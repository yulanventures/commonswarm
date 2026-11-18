-- Read-only rollback catalog verification for 20261118000001: the 20261117000002 body is back and the helper is gone.
SELECT to_regprocedure('swarm.agent_listener_is_live(uuid)') IS NULL
 AND (SELECT p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND md5(p.prosrc)='c1c6325eeff17d5d4dc7d61bfdf65319'
  FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.channel_effective_live_lead(uuid,uuid)'))
 AND has_function_privilege('swarm_command','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AS rollback_ok
\gset
