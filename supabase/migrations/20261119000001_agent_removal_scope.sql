-- 20261119000001: identify whether removing an agent from a workspace is workspace-only or permanent retirement.
--
-- People & agents, Remove an agent (inventory item 47): revoke_agent_principal routes hosted_mcp agents and
-- non-origin local workspaces through changeAgentWorkspace (workspace-only removal), while a local agent in its
-- origin workspace falls through to AgentPrincipalRevoked (permanent identity, key and connection retirement
-- across every workspace). The workspace roster read does not expose agent_principals.workspace_id, so a local
-- agent's confirmation could not tell the viewer which outcome would occur before pressing Remove.
--
-- This adds one read-only function and changes no table, column, view or existing function.
--
-- Who may read: a signed-in person (never an agent credential) who is a live member of the live workspace and
-- would pass revoke_agent_principal's actor gate (workspace owner/admin, or the agent's own owner). Anyone else,
-- and any unknown, archived or revoked workspace/principal, receives NULL so the read never probes existence.
--
-- Disclosure: returns only 'workspace', 'permanent', or NULL. Never returns the origin workspace id/name or any
-- other workspace list.
CREATE FUNCTION swarm_read.agent_removal_scope(p_workspace_id uuid, p_principal_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  viewer uuid;
  actor_role text;
  p_transport text;
  p_origin uuid;
  p_owner uuid;
  live_member boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_principal_id IS NULL OR claims IS NULL
    OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
    OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  viewer := (claims->>'sub')::uuid;
  SELECT m.role INTO actor_role
  FROM swarm.workspaces w
  JOIN swarm.memberships m ON m.workspace_id = w.workspace_id AND m.user_id = viewer AND m.revoked_at IS NULL
  WHERE w.workspace_id = p_workspace_id AND w.archived_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT p.transport, p.workspace_id, p.owner_user_id,
    EXISTS (
      SELECT 1 FROM swarm.agent_workspace_memberships am
      WHERE am.principal_id = p.principal_id AND am.workspace_id = p_workspace_id AND am.revoked_at IS NULL
    )
  INTO p_transport, p_origin, p_owner, live_member
  FROM swarm.agent_principals p
  WHERE p.principal_id = p_principal_id
    AND p.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id = p.principal_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF actor_role NOT IN ('owner', 'admin') AND p_owner IS DISTINCT FROM viewer THEN
    RETURN NULL;
  END IF;

  -- Mirrors supabase/functions/command/index.ts revoke_agent_principal dispatch.
  IF (p_transport = 'hosted_mcp' AND (p_origin = p_workspace_id OR live_member))
    OR (p_transport = 'local' AND p_origin <> p_workspace_id AND live_member) THEN
    RETURN 'workspace';
  END IF;
  IF p_transport = 'local' AND p_origin = p_workspace_id THEN
    RETURN 'permanent';
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION swarm_read.agent_removal_scope(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.agent_removal_scope(uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.agent_removal_scope(uuid, uuid) TO authenticated;

-- Rollback (verbatim in deploy/release-proofs/agent-removal-scope/20261119000001-rollback.sql):
-- DROP FUNCTION IF EXISTS swarm_read.agent_removal_scope(uuid, uuid);
