-- Read-only backfill and compatibility assertions.
DO $proof$ BEGIN
 IF NOT (SELECT
 (SELECT count(*) FROM swarm.organizations) = (SELECT count(*) FROM swarm.workspaces)
 AND NOT EXISTS (SELECT 1 FROM swarm.workspaces w LEFT JOIN swarm.organizations o ON o.id=w.org_id
   WHERE w.org_id IS DISTINCT FROM w.workspace_id OR o.id IS NULL)
 AND NOT EXISTS (
   (SELECT w.org_id, 'user'::text, m.user_id, m.role, m.invited_by, m.joined_at, m.revoked_at
     FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    EXCEPT SELECT org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at FROM swarm.org_memberships)
   UNION ALL
   (SELECT org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at FROM swarm.org_memberships
    EXCEPT SELECT w.org_id, 'user'::text, m.user_id, m.role, m.invited_by, m.joined_at, m.revoked_at
     FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)))) THEN
 RAISE EXCEPTION 'Organization backfill or membership mirror is incomplete';
 END IF;
END $proof$;
