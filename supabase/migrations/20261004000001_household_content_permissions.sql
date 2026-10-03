-- Opt-in content consent only. No existing membership or MCP grant gains rights.
CREATE TABLE swarm.household_workspace_boundaries (
 workspace_id uuid PRIMARY KEY REFERENCES swarm.workspaces(workspace_id),
 purpose text NOT NULL CHECK (purpose IN ('personal', 'shared')),
 owner_user_id uuid REFERENCES swarm.users(user_id),
 CHECK ((purpose = 'personal' AND owner_user_id IS NOT NULL) OR (purpose = 'shared' AND owner_user_id IS NULL))
);
CREATE TABLE swarm.household_member_content_roles (
 workspace_id uuid NOT NULL,
 user_id uuid NOT NULL,
 content_role text NOT NULL CHECK (content_role IN ('reader', 'editor')),
 content_consent_id uuid NOT NULL,
 confirmed_at timestamptz NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY (workspace_id, user_id),
 FOREIGN KEY (workspace_id, user_id) REFERENCES swarm.memberships(workspace_id, user_id)
);
CREATE TABLE swarm.household_content_connections (
 connection_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 workspace_id uuid NOT NULL REFERENCES swarm.household_workspace_boundaries(workspace_id),
 principal_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('personal', 'shared')),
 operations text[] NOT NULL CHECK (cardinality(operations) BETWEEN 1 AND 3 AND operations <@ ARRAY['read','create','update']::text[]),
 consent_receipt_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 hosted_grant_id uuid REFERENCES swarm.hosted_mcp_grants(grant_id),
 PRIMARY KEY (connection_id, grant_id, workspace_id, principal_id),
 FOREIGN KEY (principal_id, workspace_id, owner_user_id) REFERENCES swarm.agent_principals(principal_id, workspace_id, owner_user_id),
 FOREIGN KEY (workspace_id, owner_user_id) REFERENCES swarm.household_member_content_roles(workspace_id, user_id),
 CHECK (hosted_grant_id IS NULL OR hosted_grant_id = grant_id)
);
ALTER TABLE swarm.household_workspace_boundaries OWNER TO swarm_admin;
ALTER TABLE swarm.household_workspace_boundaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_workspace_boundaries FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_workspace_boundaries FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_workspace_boundaries TO swarm_command;
ALTER TABLE swarm.household_member_content_roles OWNER TO swarm_admin;
ALTER TABLE swarm.household_member_content_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_member_content_roles FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_member_content_roles FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_member_content_roles TO swarm_command;
ALTER TABLE swarm.household_content_connections OWNER TO swarm_admin;
ALTER TABLE swarm.household_content_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_content_connections FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_content_connections FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_content_connections TO swarm_command;

-- Reserve rollback (verbatim in supabase/household-storage-reserve/ and
-- deploy/release-proofs/household-storage/; approved release procedure only):
-- DROP TABLE IF EXISTS swarm.household_content_connections;
-- DROP TABLE IF EXISTS swarm.household_member_content_roles;
-- DROP TABLE IF EXISTS swarm.household_workspace_boundaries;
