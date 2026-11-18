-- Rollback for 20261118000001: put swarm.channel_effective_live_lead back exactly as
-- 20261117000002_channel_leads.sql defines it (owner and grants carry over through CREATE OR REPLACE),
-- then drop swarm.agent_listener_is_live, which only it called.
SET search_path = swarm, pg_catalog, public;
CREATE OR REPLACE FUNCTION swarm.channel_effective_live_lead(p_workspace uuid, p_channel uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_mode text;
  v_agent uuid;
  v_archived timestamptz;
  v_lead uuid;
BEGIN
  IF p_workspace IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_channel IS NULL THEN
    RETURN swarm.workspace_live_lead(p_workspace);
  END IF;
  SELECT c.lead_mode, c.lead_agent_principal_id, c.archived_at
  INTO v_mode, v_agent, v_archived
  FROM swarm.channels AS c
  WHERE c.workspace_id = p_workspace AND c.channel_id = p_channel;
  IF NOT FOUND OR v_archived IS NOT NULL OR v_mode = 'none' THEN
    RETURN NULL;
  END IF;
  IF v_mode = 'workspace' THEN
    v_lead := swarm.workspace_live_lead(p_workspace);
  ELSE
    SELECT p.principal_id INTO v_lead
    FROM swarm.agent_principals AS p
    JOIN swarm.workspaces AS w
      ON w.workspace_id = p_workspace AND w.archived_at IS NULL
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id AND am.workspace_id = p_workspace AND am.revoked_at IS NULL
    JOIN swarm.memberships AS owner_m
      ON owner_m.workspace_id = p_workspace AND owner_m.user_id = p.owner_user_id AND owner_m.revoked_at IS NULL
    WHERE p.principal_id = v_agent
      AND p.revoked_at IS NULL AND p.transport = 'local' AND NOT p.turn_only
      AND NOT EXISTS (
        SELECT 1 FROM swarm.agent_join_credentials AS j WHERE j.registrar_principal_id = p.principal_id);
  END IF;
  IF v_lead IS NULL OR NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_lead) THEN
    RETURN NULL;
  END IF;
  RETURN v_lead;
END;
$$;
DROP FUNCTION IF EXISTS swarm.agent_listener_is_live(uuid);
RESET search_path;
