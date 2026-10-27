-- Organizations own their roles; workspaces still own all content authority.
SET search_path = swarm, pg_catalog, public;
LOCK TABLE swarm.workspaces, swarm.memberships, swarm.organizations, swarm.org_memberships IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE organizations ADD COLUMN generated boolean NOT NULL DEFAULT false;
UPDATE organizations o SET generated=true WHERE EXISTS
  (SELECT 1 FROM workspaces w WHERE w.workspace_id=o.id AND w.org_id=o.id);

-- Phase-1 owner rows are durable org owners. Do not infer org authority from
-- workspace ownership again after this cutover.
INSERT INTO org_memberships(org_id,principal_kind,principal_id,role,invited_by,created_at,revoked_at)
SELECT w.org_id,'user',m.user_id,'owner',m.invited_by,m.joined_at,m.revoked_at
FROM memberships m JOIN workspaces w USING(workspace_id) WHERE m.role='owner'
ON CONFLICT(org_id,principal_kind,principal_id) DO NOTHING;

-- A live workspace membership can ensure org membership, never elevate a live
-- org role. Org membership persists independently when a workspace is left.
CREATE OR REPLACE FUNCTION swarm.sync_membership_to_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.revoked_at IS NULL THEN
    INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role,invited_by,created_at)
    SELECT org_id,'user',NEW.user_id,'member',NEW.invited_by,NEW.joined_at
    FROM swarm.workspaces WHERE workspace_id=NEW.workspace_id
    ON CONFLICT(org_id,principal_kind,principal_id) DO UPDATE
      SET role='member',revoked_at=NULL WHERE org_memberships.revoked_at IS NOT NULL;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION swarm.ensure_workspace_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    INSERT INTO swarm.organizations(id,slug,display_name,created_by,created_at,updated_at,archived_at,generated)
    VALUES(NEW.workspace_id,
      left(coalesce(nullif(btrim(regexp_replace(lower(NEW.name),'[^a-z0-9]+','-','g'),'-'),''),'org'),15)
        || '-' || replace(NEW.workspace_id::text,'-',''),
      coalesce(nullif(btrim(NEW.name),''),'Workspace'),NEW.created_by,NEW.created_at,NEW.created_at,NEW.archived_at,true);
    NEW.org_id:=NEW.workspace_id;
    -- Founding an organization grants org ownership, not owning a workspace.
    INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role)
    VALUES(NEW.org_id,'user',NEW.created_by,'owner');
  END IF;
  RETURN NEW;
END $$;

-- Only the trusted human command handler can call these writers. Row locks
-- serialize org archive/move/create and org-role revocation with admission.
CREATE FUNCTION swarm.org_allows_workspace_create(p_org uuid,p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM swarm.organizations WHERE id=p_org AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM swarm.org_memberships WHERE org_id=p_org AND principal_kind='user'
    AND principal_id=p_user AND revoked_at IS NULL AND role<>'guest' FOR UPDATE;
  RETURN FOUND;
END $$;

CREATE FUNCTION swarm.move_workspace_to_org(p_workspace uuid,p_destination uuid,p_user uuid,p_replay_source uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE source uuid;
BEGIN
  SELECT org_id INTO source FROM swarm.workspaces
    WHERE workspace_id=p_workspace AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_replay_source IS NOT NULL THEN source:=p_replay_source; END IF;
  -- Workspace first, then both orgs in UUID order. Membership writers already
  -- lock their workspace; no authority is taken from a pre-lock discovery.
  PERFORM 1 FROM swarm.organizations WHERE id IN(source,p_destination) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM swarm.organizations WHERE id IN(source,p_destination)
    AND (archived_at IS NULL OR p_replay_source IS NOT NULL AND id=source))
    <> (CASE WHEN source=p_destination THEN 1 ELSE 2 END) THEN RETURN NULL; END IF;
  PERFORM 1 FROM swarm.memberships WHERE workspace_id=p_workspace AND user_id=p_user
    AND role='owner' AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM swarm.org_memberships WHERE org_id IN(source,p_destination) AND principal_kind='user'
    AND principal_id=p_user ORDER BY org_id FOR UPDATE;
  IF (SELECT count(*) FROM swarm.org_memberships WHERE org_id IN(source,p_destination) AND principal_kind='user'
    AND principal_id=p_user AND role IN('owner','admin') AND revoked_at IS NULL)
    <> (CASE WHEN source=p_destination THEN 1 ELSE 2 END) THEN RETURN NULL; END IF;
  IF p_replay_source IS NOT NULL THEN
    RETURN jsonb_build_object('workspace_id',p_workspace,'from_org_id',source,'org_id',p_destination);
  END IF;
  UPDATE swarm.workspaces SET org_id=p_destination WHERE workspace_id=p_workspace;
  INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role)
  SELECT p_destination,'user',user_id,'member' FROM swarm.memberships
    WHERE workspace_id=p_workspace AND revoked_at IS NULL ORDER BY user_id
  ON CONFLICT(org_id,principal_kind,principal_id) DO UPDATE
    SET role='member',revoked_at=NULL WHERE org_memberships.revoked_at IS NOT NULL;
  UPDATE swarm.organizations SET archived_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=source AND source<>p_destination AND generated
      AND NOT EXISTS(SELECT 1 FROM swarm.workspaces WHERE org_id=source);
  RETURN jsonb_build_object('workspace_id',p_workspace,'from_org_id',source,'org_id',p_destination);
END $$;

ALTER FUNCTION swarm.org_allows_workspace_create(uuid,uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.move_workspace_to_org(uuid,uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.org_allows_workspace_create(uuid,uuid),swarm.move_workspace_to_org(uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.org_allows_workspace_create(uuid,uuid),swarm.move_workspace_to_org(uuid,uuid,uuid,uuid) TO swarm_command;
-- Preserve the phase-1 trigger function owners and private ACLs.
ALTER FUNCTION swarm.ensure_workspace_org() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_membership_to_org() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_workspace_org(),swarm.sync_membership_to_org()
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

CREATE VIEW swarm_read.organizations WITH(security_barrier=true) AS
SELECT o.id,o.display_name,m.role FROM swarm.organizations o JOIN swarm.org_memberships m ON m.org_id=o.id
WHERE m.principal_kind='user' AND m.principal_id=auth.uid() AND m.revoked_at IS NULL AND o.archived_at IS NULL;
ALTER VIEW swarm_read.organizations OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.organizations FROM PUBLIC,anon;
GRANT SELECT ON swarm_read.organizations TO authenticated,swarm_read;
RESET search_path;
