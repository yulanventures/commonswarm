-- Roll back edge/site first. Refuses after organization data diverges.
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

DROP VIEW swarm_read.organizations;
DROP FUNCTION swarm.org_allows_workspace_create(uuid,uuid);
DROP FUNCTION swarm.move_workspace_to_org(uuid,uuid,uuid,uuid);
ALTER TABLE swarm.organizations DROP COLUMN generated;
CREATE OR REPLACE FUNCTION swarm.ensure_workspace_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    INSERT INTO swarm.organizations (id, slug, display_name, created_by, created_at, updated_at, archived_at)
    VALUES (NEW.workspace_id,
      left(coalesce(nullif(btrim(regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'org'), 15)
        || '-' || replace(NEW.workspace_id::text, '-', ''),
      coalesce(nullif(btrim(NEW.name), ''), 'Workspace'), NEW.created_by, NEW.created_at, NEW.created_at, NEW.archived_at);
    NEW.org_id := NEW.workspace_id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION swarm.sync_membership_to_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
      (OLD.workspace_id, OLD.user_id) IS DISTINCT FROM (NEW.workspace_id, NEW.user_id)) THEN
    DELETE FROM swarm.org_memberships m USING swarm.workspaces w
    WHERE w.workspace_id = OLD.workspace_id AND m.org_id = w.org_id
      AND m.principal_kind = 'user' AND m.principal_id = OLD.user_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO swarm.org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at)
    SELECT org_id, 'user', NEW.user_id, NEW.role, NEW.invited_by, NEW.joined_at, NEW.revoked_at
    FROM swarm.workspaces WHERE workspace_id = NEW.workspace_id
    ON CONFLICT (org_id, principal_kind, principal_id) DO UPDATE SET
      role = EXCLUDED.role, invited_by = EXCLUDED.invited_by,
      created_at = EXCLUDED.created_at, revoked_at = EXCLUDED.revoked_at;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
ALTER FUNCTION swarm.ensure_workspace_org() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_membership_to_org() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_workspace_org(),swarm.sync_membership_to_org()
 FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
