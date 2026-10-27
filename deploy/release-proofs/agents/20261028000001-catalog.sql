-- Safe before apply. Check owners, constraints, trigger wiring and all effective client grants.
SELECT coalesce((SELECT relowner='swarm_admin'::regrole AND relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
  AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  FROM pg_class c WHERE oid=to_regclass('swarm.agent_workspace_memberships')),false)
  AND (SELECT count(*)=4 AND bool_and(convalidated) FROM pg_constraint
    WHERE conrelid=to_regclass('swarm.agent_workspace_memberships') AND contype='f')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.agent_workspace_memberships')
    AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (principal_id, workspace_id)')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.agent_workspace_memberships')
    AND contype='f' AND confrelid=to_regclass('swarm.agent_principals')
    AND pg_get_constraintdef(oid)='FOREIGN KEY (principal_id, owner_user_id) REFERENCES swarm.agent_principals(principal_id, owner_user_id)')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_principals')
    AND tgname='agent_principals_sync_workspace_membership' AND tgenabled='O' AND tgtype=21
    AND tgfoid=to_regprocedure('swarm.sync_agent_workspace_membership()'))
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_join_credentials')
    AND tgname='agent_join_credentials_exclude_membership' AND tgenabled='O' AND tgtype=5
    AND tgfoid=to_regprocedure('swarm.exclude_join_registrar_membership()'))
  AND (SELECT count(*)=2 AND bool_and(prosecdef AND proowner='swarm_admin'::regrole
    AND proconfig=ARRAY['search_path=pg_catalog']
    AND md5(prosrc)=CASE proname
      WHEN 'sync_agent_workspace_membership' THEN 'eef7e8309ad6506f64d772210bef82ef'
      WHEN 'exclude_join_registrar_membership' THEN 'bedac595d2f49a4756ebac1ec2929102'
      END
    AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
    FROM pg_proc p WHERE oid IN (to_regprocedure('swarm.sync_agent_workspace_membership()'),
      to_regprocedure('swarm.exclude_join_registrar_membership()')))
  AND coalesce((SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true']
    AND md5(regexp_replace(pg_get_viewdef(oid), '(swarm[.]|auth[.])', '', 'g'))='871652633f16aa85203cde75872a75ca'
    AND has_table_privilege('authenticated',oid,'SELECT')
    AND NOT has_table_privilege('anon',oid,'SELECT')
    AND NOT has_table_privilege('swarm_read',oid,'SELECT')
    AND NOT has_table_privilege('swarm_command',oid,'SELECT')
    FROM pg_class WHERE oid=to_regclass('swarm_read.account_agents')),false)
  AS catalog_ok
\gset
