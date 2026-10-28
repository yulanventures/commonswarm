-- BEFORE INSERT runs before the workspace ON CONFLICT check, including retries.
CREATE OR REPLACE FUNCTION swarm.ensure_workspace_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    INSERT INTO swarm.organizations(id,slug,display_name,created_by,created_at,updated_at,archived_at,generated)
    VALUES(NEW.workspace_id,
      left(coalesce(nullif(btrim(regexp_replace(lower(NEW.name),'[^a-z0-9]+','-','g'),'-'),''),'org'),15)
        || '-' || replace(NEW.workspace_id::text,'-',''),
      coalesce(nullif(btrim(NEW.name),''),'Workspace'),NEW.created_by,NEW.created_at,NEW.created_at,NEW.archived_at,true)
    ON CONFLICT (id) DO NOTHING;
    NEW.org_id:=NEW.workspace_id;
    -- Founding an organization grants org ownership, not owning a workspace.
    INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role)
    VALUES(NEW.org_id,'user',NEW.created_by,'owner')
    ON CONFLICT (org_id, principal_kind, principal_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION swarm.ensure_workspace_org() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_workspace_org()
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
