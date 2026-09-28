-- HM lane 2: hosted MCP authority projections and narrow internal resolution.
-- Public issuance remains disabled; only the internal command/read interfaces
-- consume these rows.

CREATE TABLE swarm.hosted_mcp_grants (
  grant_id uuid PRIMARY KEY,
  provider_grant_id text NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL REFERENCES swarm.users(user_id),
  home_workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  resource text NOT NULL CHECK (resource = 'https://mcp.commonswarm.com/mcp'),
  selected_workspace_ids uuid[] NOT NULL CHECK (
    cardinality(selected_workspace_ids) BETWEEN 1 AND 100
    AND home_workspace_id = ANY(selected_workspace_ids)
  ),
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
  interaction_ref text NOT NULL CHECK (length(interaction_ref) BETWEEN 1 AND 2048),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  created_at timestamptz NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  CHECK ((state = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
      OR (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
      OR (state = 'revoked' AND revoked_at IS NOT NULL)),
  UNIQUE (grant_id, owner_user_id),
  UNIQUE (grant_id, owner_user_id, manifest_digest)
);

CREATE TABLE swarm.hosted_mcp_grant_workspaces (
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
  owner_user_id uuid NOT NULL REFERENCES swarm.users(user_id),
  manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
  consent_receipt_id uuid NOT NULL UNIQUE,
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (grant_id, workspace_id),
  UNIQUE (grant_id, workspace_id, owner_user_id),
  FOREIGN KEY (grant_id, owner_user_id, manifest_digest)
    REFERENCES swarm.hosted_mcp_grants(grant_id, owner_user_id, manifest_digest)
);

CREATE TABLE swarm.hosted_mcp_seats (
  seat_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  principal_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (
    length(name) BETWEEN 1 AND 80
    AND name = btrim(name, ' ')
    AND name !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (grant_id, workspace_id, name),
  UNIQUE (seat_id, grant_id, workspace_id, principal_id),
  FOREIGN KEY (grant_id, workspace_id, owner_user_id)
    REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id, workspace_id, owner_user_id),
  FOREIGN KEY (principal_id, workspace_id, owner_user_id)
    REFERENCES swarm.agent_principals(principal_id, workspace_id, owner_user_id)
);

CREATE TABLE swarm.hosted_mcp_seat_handles (
  handle text PRIMARY KEY CHECK (handle ~ '^seat_[A-Za-z0-9_-]{22,64}$'),
  seat_id uuid NOT NULL UNIQUE,
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id)
    REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)
);

CREATE INDEX hosted_mcp_grants_owner
  ON swarm.hosted_mcp_grants(owner_user_id, created_at DESC);
CREATE INDEX hosted_mcp_grant_workspaces_workspace
  ON swarm.hosted_mcp_grant_workspaces(workspace_id, grant_id);
CREATE INDEX hosted_mcp_seats_grant_live
  ON swarm.hosted_mcp_seats(grant_id) WHERE revoked_at IS NULL;
CREATE INDEX hosted_mcp_seats_workspace_name
  ON swarm.hosted_mcp_seats(workspace_id, name);

ALTER TABLE swarm.hosted_mcp_grants OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_mcp_grant_workspaces OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_mcp_seats OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_mcp_seat_handles OWNER TO swarm_admin;

ALTER TABLE swarm.hosted_mcp_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.hosted_mcp_grant_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.hosted_mcp_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.hosted_mcp_seat_handles ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.hosted_mcp_grants
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.hosted_mcp_grant_workspaces
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.hosted_mcp_seats
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.hosted_mcp_seat_handles
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  swarm.hosted_mcp_grants,
  swarm.hosted_mcp_grant_workspaces,
  swarm.hosted_mcp_seats,
  swarm.hosted_mcp_seat_handles
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT SELECT, INSERT, UPDATE ON TABLE
  swarm.hosted_mcp_grants,
  swarm.hosted_mcp_grant_workspaces,
  swarm.hosted_mcp_seats,
  swarm.hosted_mcp_seat_handles
TO swarm_command;

-- The grant capability can claim in one consented workspace only. The provider
-- family check is deliberately outside this function and is repeated by the
-- trusted hosted authentication module on every operation.
CREATE FUNCTION swarm.resolve_hosted_grant_authorization(
  p_grant_id uuid,
  p_owner_user_id uuid,
  p_workspace_id uuid,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  owner_user_id uuid,
  provider_grant_id text,
  workspace_id uuid,
  stream_id uuid,
  manifest_digest bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.owner_user_id, g.provider_grant_id,
         c.workspace_id, s.stream_id, g.manifest_digest
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id
   AND c.owner_user_id = g.owner_user_id
   AND c.workspace_id = p_workspace_id
   AND c.revoked_at IS NULL
  JOIN swarm.workspaces AS w
    ON w.workspace_id = c.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = c.workspace_id
   AND m.user_id = g.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS s
    ON s.workspace_id = c.workspace_id AND s.kind = 'workspace'
  WHERE p_tool = 'claim_hosted_seat'
    AND g.grant_id = p_grant_id
    AND g.owner_user_id = p_owner_user_id
    AND g.state = 'active'
    AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = g.owner_user_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = g.grant_id)
    )
$fn$;

CREATE FUNCTION swarm.resolve_hosted_seat_command_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('ask', 'note', 'reply', 'working_on')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;

-- The read resolver deliberately repeats the complete durable fence rather
-- than granting swarm_read direct access to any hosted authority table.
CREATE FUNCTION swarm.resolve_hosted_seat_read_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('whoami', 'members', 'check')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;

ALTER FUNCTION swarm.resolve_hosted_grant_authorization(uuid, uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION swarm.resolve_hosted_grant_authorization(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, swarm_read;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text)
  FROM PUBLIC, anon, authenticated, swarm_read;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text)
  FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_grant_authorization(uuid, uuid, uuid, text)
  TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text)
  TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text)
  TO swarm_read;

CREATE VIEW swarm_read.hosted_mcp_connections
WITH (security_barrier = true)
AS
  SELECT g.grant_id, g.client_id, g.resource, g.home_workspace_id,
         g.selected_workspace_ids, g.state, g.created_at, g.activated_at,
         g.revoked_at
  FROM swarm.hosted_mcp_grants AS g
  WHERE g.owner_user_id = auth.uid();

CREATE VIEW swarm_read.hosted_mcp_seats
WITH (security_barrier = true)
AS
  SELECT hs.seat_id, hs.grant_id, hs.workspace_id, hs.principal_id,
         hs.name, hs.created_at, hs.revoked_at
  FROM swarm.hosted_mcp_seats AS hs
  WHERE hs.owner_user_id = auth.uid();

ALTER VIEW swarm_read.hosted_mcp_connections OWNER TO swarm_admin;
ALTER VIEW swarm_read.hosted_mcp_seats OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.hosted_mcp_connections, swarm_read.hosted_mcp_seats
  FROM PUBLIC, anon;
GRANT SELECT ON swarm_read.hosted_mcp_connections, swarm_read.hosted_mcp_seats
  TO authenticated, swarm_read;

ALTER TABLE swarm.idempotency_keys
  DROP CONSTRAINT idempotency_keys_principal_kind_check;
ALTER TABLE swarm.idempotency_keys
  ADD CONSTRAINT idempotency_keys_principal_kind_check
  CHECK (principal_kind IN ('user', 'agent', 'join', 'hosted_grant', 'hosted_seat'));
