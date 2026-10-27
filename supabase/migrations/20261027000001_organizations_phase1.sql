-- Navigation hierarchy only. Workspace membership remains the sole access gate.
SET search_path = swarm, pg_catalog, public;
LOCK TABLE swarm.workspaces, swarm.memberships IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND char_length(slug) BETWEEN 1 AND 48),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  logo_object_key text, logo_updated_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_lower_key ON organizations(lower(slug));
CREATE TABLE org_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  invited_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE (org_id, principal_kind, principal_id)
);
CREATE INDEX org_mems_live_idx ON org_memberships(principal_kind, principal_id, org_id) WHERE revoked_at IS NULL;
ALTER TABLE organizations OWNER TO swarm_admin;
ALTER TABLE org_memberships OWNER TO swarm_admin;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organizations, org_memberships FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
ALTER TABLE workspaces ADD COLUMN org_id uuid REFERENCES organizations(id);

-- Full UUID suffix prevents collisions between workspaces with the same name.
INSERT INTO organizations (id, slug, display_name, created_by, created_at, updated_at, archived_at)
SELECT workspace_id,
  left(coalesce(nullif(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'org'), 15)
    || '-' || replace(workspace_id::text, '-', ''),
  coalesce(nullif(btrim(name), ''), 'Workspace'), created_by, created_at, created_at, archived_at
FROM workspaces;
UPDATE workspaces SET org_id = workspace_id;
ALTER TABLE workspaces ALTER COLUMN org_id SET NOT NULL;
INSERT INTO org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at)
SELECT workspace_id, 'user', user_id, role, invited_by, joined_at, revoked_at FROM memberships;

CREATE FUNCTION swarm.ensure_workspace_org() RETURNS trigger
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
CREATE TRIGGER workspaces_ensure_org BEFORE INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION swarm.ensure_workspace_org();

-- Mirror all legacy writes atomically, including role changes, revocation,
-- rejoining and deletion. This data is never consulted for workspace access.
CREATE FUNCTION swarm.sync_membership_to_org() RETURNS trigger
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
CREATE TRIGGER memberships_sync_org AFTER INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION swarm.sync_membership_to_org();
ALTER FUNCTION swarm.ensure_workspace_org() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_membership_to_org() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_workspace_org(), swarm.sync_membership_to_org()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Extend the existing security-barrier projection, without exposing either table.
CREATE OR REPLACE VIEW swarm_read.workspaces WITH (security_barrier = true) AS
SELECT w.workspace_id, w.name, w.archived_at, w.org_id, o.display_name AS org_display_name
FROM swarm.workspaces w JOIN swarm.organizations o ON o.id = w.org_id
WHERE swarm.is_member(w.workspace_id, auth.uid()) AND w.archived_at IS NULL;
ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.workspaces TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.workspaces FROM PUBLIC, anon;
RESET search_path;
