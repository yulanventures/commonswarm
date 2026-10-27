SELECT to_regclass('swarm.agent_workspace_memberships') IS NULL
  AND to_regclass('swarm.agent_principals_principal_owner') IS NULL
  AND to_regclass('swarm_read.account_agents') IS NULL
  AND to_regprocedure('swarm.sync_agent_workspace_membership()') IS NULL
  AND to_regprocedure('swarm.exclude_join_registrar_membership()') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN (
    'agent_principals_sync_workspace_membership', 'agent_join_credentials_exclude_membership')
    AND tgrelid IN (to_regclass('swarm.agent_principals'), to_regclass('swarm.agent_join_credentials')))
  AS rollback_ok
\gset
