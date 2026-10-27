-- Guarded phase-1 rollback reserve. Refuse to discard independent organization data.
LOCK TABLE swarm.workspaces, swarm.memberships IN SHARE ROW EXCLUSIVE MODE;
DO $guard$ BEGIN
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
     FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)))) OR EXISTS (
 SELECT 1 FROM swarm.organizations o JOIN swarm.workspaces w ON w.workspace_id=o.id
 WHERE o.display_name IS DISTINCT FROM coalesce(nullif(btrim(w.name),''),'Workspace')
 OR o.slug IS DISTINCT FROM left(coalesce(nullif(btrim(regexp_replace(lower(w.name), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'org'), 15) || '-' || replace(w.workspace_id::text, '-', '')
 OR o.logo_object_key IS NOT NULL OR o.logo_updated_at IS NOT NULL
 OR o.created_by<>w.created_by OR o.created_at<>w.created_at OR o.updated_at<>w.created_at
 OR o.archived_at IS DISTINCT FROM w.archived_at)
 THEN RAISE EXCEPTION 'Organization data has diverged; preserve it before rollback' USING ERRCODE='55000'; END IF;
END $guard$;
DROP VIEW swarm_read.workspaces;
CREATE OR REPLACE VIEW swarm_read.workspaces
WITH (security_barrier = true)
AS
  SELECT
    w.workspace_id,
    w.name,
    w.archived_at
  FROM swarm.workspaces AS w
  WHERE swarm.is_member(w.workspace_id, auth.uid())
    AND w.archived_at IS NULL;

ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.workspaces TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.workspaces FROM PUBLIC, anon;

DROP TRIGGER memberships_sync_org ON swarm.memberships;
DROP TRIGGER workspaces_ensure_org ON swarm.workspaces;
DROP FUNCTION swarm.sync_membership_to_org();
DROP FUNCTION swarm.ensure_workspace_org();
ALTER TABLE swarm.workspaces DROP COLUMN org_id;
DROP TABLE swarm.org_memberships;
DROP TABLE swarm.organizations;
