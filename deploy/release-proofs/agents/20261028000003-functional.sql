-- Read-only invariants; original consent rows/handles remain historical records.
DO $proof$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s
 LEFT JOIN swarm.hosted_mcp_grant_agents ga USING(grant_id,principal_id,owner_user_id)
 LEFT JOIN swarm.agent_workspace_memberships am USING(principal_id,workspace_id,owner_user_id)
 WHERE ga.grant_id IS NULL OR am.principal_id IS NULL)
 OR EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.hosted_mcp_grants g USING(grant_id)
 WHERE c.owner_user_id<>g.owner_user_id OR c.manifest_digest<>g.manifest_digest OR NOT c.workspace_id=ANY(g.selected_workspace_ids))
 OR EXISTS(SELECT 1 FROM swarm.hosted_mcp_agent_workspace_adds a
 JOIN swarm.hosted_mcp_grants g USING(grant_id) WHERE a.owner_user_id<>g.owner_user_id)
 THEN RAISE EXCEPTION 'Hosted account agent binding invariant failed' USING ERRCODE='55000'; END IF;
END $proof$;
