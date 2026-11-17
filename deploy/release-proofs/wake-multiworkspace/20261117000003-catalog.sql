-- Read-only catalog and body verification for 20261117000003 (multi-workspace wake eligibility).
SELECT (SELECT count(*)=2 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.provolatile='s'
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.actor_wake_path_eligible_deliveries(text,uuid)','07f016a7b7d2d40dfe0cb1719137c835'),
  ('swarm.agent_has_live_workspace_seat(uuid,uuid)','8e1788cb85034e657aceb7133ed4b046')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid IN (to_regprocedure('swarm.actor_wake_path_eligible_deliveries(text,uuid)'),
     to_regprocedure('swarm.agent_has_live_workspace_seat(uuid,uuid)'))
     AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.agent_has_live_workspace_seat(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.agent_has_live_workspace_seat(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.agent_has_live_workspace_seat(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.agent_has_live_workspace_seat(uuid,uuid)','EXECUTE')
 AND (SELECT v.relkind='v' AND v.relowner='swarm_admin'::regrole AND v.reloptions @> ARRAY['security_barrier=true']
   AND NOT has_table_privilege('authenticated',v.oid,'SELECT') AND NOT has_table_privilege('swarm_read',v.oid,'SELECT')
   AND NOT has_table_privilege('swarm_command',v.oid,'SELECT') AND NOT has_table_privilege('anon',v.oid,'SELECT')
   AND pg_get_viewdef(v.oid) LIKE '%agent_has_live_workspace_seat(d.recipient_agent_principal_id, d.workspace_id)%'
   AND pg_get_viewdef(v.oid) LIKE '%m.mentioned_agent_principal_id = d.recipient_agent_principal_id%'
   AND pg_get_viewdef(v.oid) LIKE '%later_mention.mentioned_agent_principal_id = d.recipient_agent_principal_id%'
   AND pg_get_viewdef(v.oid) LIKE '%cm.agent_principal_id = d.recipient_agent_principal_id%'
   AND pg_get_viewdef(v.oid) LIKE '%p.turn_only = false%'
   AND pg_get_viewdef(v.oid) NOT LIKE '%p.workspace_id = d.workspace_id%'
   FROM pg_class v WHERE v.oid=to_regclass('swarm.wake_path_eligible_deliveries'))
 AND NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
   WHERE r.ev_class=to_regclass('swarm.wake_path_eligible_deliveries') AND d.refclassid='pg_class'::regclass
     AND d.refobjid=to_regclass('swarm.agent_workspace_memberships'))
 AS catalog_ok
\gset
