-- Account directory projection only. Existing credentials and workspace gates are unchanged.
SET search_path = swarm, pg_catalog, public;
LOCK TABLE swarm.agent_principals, swarm.agent_join_credentials IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX agent_principals_principal_owner ON agent_principals(principal_id, owner_user_id);
CREATE TABLE agent_workspace_memberships (
  principal_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  added_by uuid NOT NULL REFERENCES users(user_id),
  added_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (principal_id, workspace_id),
  FOREIGN KEY (principal_id, owner_user_id)
    REFERENCES agent_principals(principal_id, owner_user_id)
);
CREATE INDEX agent_workspace_memberships_owner ON agent_workspace_memberships(owner_user_id, principal_id);
ALTER TABLE agent_workspace_memberships OWNER TO swarm_admin;
ALTER TABLE agent_workspace_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_workspace_memberships FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

INSERT INTO agent_workspace_memberships(principal_id, workspace_id, owner_user_id, added_by, added_at, revoked_at)
SELECT p.principal_id, p.workspace_id, p.owner_user_id, p.owner_user_id, p.created_at, p.revoked_at
FROM agent_principals p WHERE NOT EXISTS (
  SELECT 1 FROM agent_join_credentials c WHERE c.registrar_principal_id = p.principal_id
);

-- Covers command creation, local seat registration, hosted claims and every revocation writer.
CREATE FUNCTION swarm.sync_agent_workspace_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id = NEW.principal_id) THEN
    INSERT INTO swarm.agent_workspace_memberships(principal_id, workspace_id, owner_user_id, added_by, added_at, revoked_at)
    VALUES (NEW.principal_id, NEW.workspace_id, NEW.owner_user_id, NEW.owner_user_id, NEW.created_at, NEW.revoked_at)
    ON CONFLICT (principal_id, workspace_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_principals_sync_workspace_membership AFTER INSERT OR UPDATE OF revoked_at ON agent_principals
FOR EACH ROW EXECUTE FUNCTION swarm.sync_agent_workspace_membership();

-- Registrars are inserted before their credential, in the same transaction.
CREATE FUNCTION swarm.exclude_join_registrar_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM swarm.agent_workspace_memberships WHERE principal_id = NEW.registrar_principal_id;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_join_credentials_exclude_membership AFTER INSERT ON agent_join_credentials
FOR EACH ROW EXECUTE FUNCTION swarm.exclude_join_registrar_membership();
ALTER FUNCTION swarm.sync_agent_workspace_membership() OWNER TO swarm_admin;
ALTER FUNCTION swarm.exclude_join_registrar_membership() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.sync_agent_workspace_membership(), swarm.exclude_join_registrar_membership()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- The owner can discover their identities even after leaving a workspace. Workspace/org
-- names remain member-filtered so leaving a workspace does not reveal later renames.
CREATE VIEW swarm_read.account_agents WITH (security_barrier = true) AS
SELECT p.principal_id, p.name, p.model, p.transport, p.created_at, p.revoked_at,
  coalesce((SELECT jsonb_agg(jsonb_build_object(
    'workspace_id', m.workspace_id, 'workspace_name', w.name,
    'org_id', w.org_id, 'org_name', o.display_name,
    'added_at', m.added_at, 'revoked_at', m.revoked_at, 'archived_at', w.archived_at
  ) ORDER BY m.added_at, m.workspace_id)
  FROM swarm.agent_workspace_memberships m
  JOIN swarm.workspaces w ON w.workspace_id = m.workspace_id
  JOIN swarm.organizations o ON o.id = w.org_id
  WHERE m.principal_id = p.principal_id AND m.owner_user_id = p.owner_user_id
    AND swarm.is_member(m.workspace_id, auth.uid())), '[]'::jsonb) AS workspaces
FROM swarm.agent_principals p
WHERE p.owner_user_id = auth.uid() AND NOT EXISTS (
  SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id = p.principal_id
);
ALTER VIEW swarm_read.account_agents OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.account_agents TO authenticated;
REVOKE ALL ON swarm_read.account_agents FROM PUBLIC, anon, swarm_read, swarm_command;
RESET search_path;
