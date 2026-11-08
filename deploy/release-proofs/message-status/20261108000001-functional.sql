-- Read-only invariant proof: every Working snapshot names a membership of its agent in its workspace.
DO $proof$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.agent_message_working w WHERE NOT EXISTS(
   SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=w.principal_id AND am.workspace_id=w.workspace_id))
 THEN RAISE EXCEPTION 'Working snapshot without a membership' USING ERRCODE='55000'; END IF;
END $proof$;
