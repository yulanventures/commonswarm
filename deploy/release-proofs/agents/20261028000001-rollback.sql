-- Refuse to discard independent memberships once a later slice starts using them.
LOCK TABLE swarm.agent_principals, swarm.agent_join_credentials, swarm.agent_workspace_memberships
IN SHARE ROW EXCLUSIVE MODE;
DO $guard$ BEGIN
  IF EXISTS (
    (SELECT p.principal_id, p.workspace_id, p.owner_user_id, p.owner_user_id, p.created_at, p.revoked_at
     FROM swarm.agent_principals p WHERE NOT EXISTS (
       SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id)
     EXCEPT SELECT principal_id, workspace_id, owner_user_id, added_by, added_at, revoked_at
       FROM swarm.agent_workspace_memberships)
    UNION ALL
    (SELECT principal_id, workspace_id, owner_user_id, added_by, added_at, revoked_at
     FROM swarm.agent_workspace_memberships
     EXCEPT SELECT p.principal_id, p.workspace_id, p.owner_user_id, p.owner_user_id, p.created_at, p.revoked_at
     FROM swarm.agent_principals p WHERE NOT EXISTS (
       SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id))
  ) THEN RAISE EXCEPTION 'Agent memberships have diverged; preserve them before rollback' USING ERRCODE='55000'; END IF;
END $guard$;
DROP VIEW swarm_read.account_agents;
DROP TRIGGER agent_principals_sync_workspace_membership ON swarm.agent_principals;
DROP TRIGGER agent_join_credentials_exclude_membership ON swarm.agent_join_credentials;
DROP FUNCTION swarm.sync_agent_workspace_membership();
DROP FUNCTION swarm.exclude_join_registrar_membership();
DROP TABLE swarm.agent_workspace_memberships;
DROP INDEX swarm.agent_principals_principal_owner;
