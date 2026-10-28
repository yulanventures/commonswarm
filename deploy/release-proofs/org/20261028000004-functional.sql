-- Read-only post-migration consistency: org membership is a durable superset.
DO $proof$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
   WHERE m.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.org_memberships o
     WHERE o.org_id=w.org_id AND o.principal_kind='user' AND o.principal_id=m.user_id AND o.revoked_at IS NULL))
 THEN RAISE EXCEPTION 'Live workspace member missing organization membership'; END IF;
 IF EXISTS(SELECT 1 FROM swarm.workspaces w JOIN swarm.organizations o ON o.id=w.org_id
   WHERE w.archived_at IS NULL AND o.archived_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Live workspace in archived organization'; END IF;
END $proof$;
