-- Read-only invariant proof. Credentials keep their immutable origin tuple.
DO $proof$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am JOIN swarm.agent_principals p USING(principal_id)
   WHERE am.owner_user_id<>p.owner_user_id)
 OR EXISTS(SELECT 1 FROM swarm.renewal_grants g JOIN swarm.agent_principals p USING(principal_id)
   WHERE ROW(g.workspace_id,g.created_by) IS DISTINCT FROM ROW(p.workspace_id,p.owner_user_id))
 OR EXISTS(SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_tokens pred ON pred.token_id=t.predecessor_token_id
   WHERE ROW(t.principal_id,t.run_id,t.lineage_id,t.renewal_grant_id,t.parent_admin_grant_id)
     IS DISTINCT FROM ROW(pred.principal_id,pred.run_id,pred.lineage_id,pred.renewal_grant_id,pred.parent_admin_grant_id))
 OR EXISTS(SELECT 1 FROM swarm.local_content_approval_workspaces ap JOIN swarm.renewal_grants g USING(renewal_grant_id)
   WHERE NOT EXISTS(SELECT 1 FROM swarm.household_content_connections c WHERE c.connection_id=ap.token_id
     AND c.workspace_id=ap.workspace_id AND c.renewal_grant_id=g.renewal_grant_id AND c.principal_id=g.principal_id AND c.grant_id=g.run_id))
 THEN RAISE EXCEPTION 'Local account-agent binding invariant failed' USING ERRCODE='55000'; END IF;
END $proof$;
