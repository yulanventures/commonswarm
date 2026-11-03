-- Read-only invariant proof: no workspace names a lead that is not live there.
DO $proof$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.workspaces w WHERE w.lead_agent_principal_id IS NOT NULL AND w.archived_at IS NULL
   AND swarm.workspace_live_lead(w.workspace_id) IS DISTINCT FROM w.lead_agent_principal_id)
 THEN RAISE EXCEPTION 'Workspace lead invariant failed' USING ERRCODE='55000'; END IF;
END $proof$;
