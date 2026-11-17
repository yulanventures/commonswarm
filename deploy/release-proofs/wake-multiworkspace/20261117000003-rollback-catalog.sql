-- Read-only rollback catalog verification for 20261117000003: the 20261113000003 definitions are back.
SELECT to_regprocedure('swarm.agent_has_live_workspace_seat(uuid,uuid)') IS NULL
 AND (SELECT p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND md5(p.prosrc)='2e6692db6ecc148acd2c969144392abe'
   FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.actor_wake_path_eligible_deliveries(text,uuid)'))
 AND NOT has_function_privilege('authenticated','swarm.actor_wake_path_eligible_deliveries(text,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.actor_wake_path_eligible_deliveries(text,uuid)','EXECUTE')
 AND (SELECT v.relkind='v' AND v.relowner='swarm_admin'::regrole AND v.reloptions @> ARRAY['security_barrier=true']
   AND NOT has_table_privilege('authenticated',v.oid,'SELECT') AND NOT has_table_privilege('swarm_read',v.oid,'SELECT')
   AND pg_get_viewdef(v.oid) LIKE '%p.workspace_id = d.workspace_id%'
   AND pg_get_viewdef(v.oid) NOT LIKE '%signal_mentions%'
   AND pg_get_viewdef(v.oid) NOT LIKE '%agent_has_live_workspace_seat%'
   FROM pg_class v WHERE v.oid=to_regclass('swarm.wake_path_eligible_deliveries'))
 AS rollback_ok
\gset
