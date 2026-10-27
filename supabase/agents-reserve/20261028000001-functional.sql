-- Read-only: the new projection must match every legacy identity exactly.
DO $proof$ BEGIN
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
  ) THEN RAISE EXCEPTION 'Agent membership projection has diverged' USING ERRCODE='55000'; END IF;
END $proof$;
