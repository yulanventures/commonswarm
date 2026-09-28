-- HM lane 6: isolated OAuth provider storage and least-privilege runtime role.
-- Deliberately contains no transaction control; the migration runner owns it.
-- Apply after 20260928000002_hm_hosted_authority.sql: the status boundary
-- deliberately depends on swarm.hosted_mcp_grants and swarm.users from lane 2.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commonswarm_oauth_runtime') THEN
    CREATE ROLE commonswarm_oauth_runtime
      LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END
$role$;

-- Match the existing role convention: the migration may create a constrained
-- role, but it must not try to repair elevated attributes on a surviving
-- cluster role. A drifted role is a hard failure for the least-privilege
-- contract and must be repaired by the operator before retrying the migration.
DO $role_attributes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'commonswarm_oauth_runtime'
      AND (
        NOT rolcanlogin
        OR rolinherit
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'commonswarm_oauth_runtime has unsafe role attributes';
  END IF;
END
$role_attributes$;

ALTER ROLE commonswarm_oauth_runtime SET search_path = commonswarm_oauth, pg_catalog;

DO $database_privilege$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO commonswarm_oauth_runtime', current_database());
END
$database_privilege$;

CREATE SCHEMA commonswarm_oauth AUTHORIZATION swarm_admin;
REVOKE ALL ON SCHEMA commonswarm_oauth FROM PUBLIC;
GRANT USAGE ON SCHEMA commonswarm_oauth TO commonswarm_oauth_runtime;
REVOKE CREATE ON SCHEMA commonswarm_oauth FROM commonswarm_oauth_runtime;
REVOKE ALL ON SCHEMA swarm FROM commonswarm_oauth_runtime;

CREATE TABLE commonswarm_oauth.provider_artifacts (
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 96),
  artifact_id_hash text NOT NULL CHECK (length(artifact_id_hash) = 43),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  grant_id text CHECK (grant_id IS NULL OR length(grant_id) BETWEEN 1 AND 2048),
  uid text CHECK (uid IS NULL OR length(uid) BETWEEN 1 AND 2048),
  user_code_hash text CHECK (user_code_hash IS NULL OR length(user_code_hash) = 43),
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (model, artifact_id_hash)
);
CREATE INDEX provider_artifacts_grant_idx
  ON commonswarm_oauth.provider_artifacts (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX provider_artifacts_uid_idx
  ON commonswarm_oauth.provider_artifacts (model, uid) WHERE uid IS NOT NULL;
CREATE INDEX provider_artifacts_user_code_idx
  ON commonswarm_oauth.provider_artifacts (model, user_code_hash) WHERE user_code_hash IS NOT NULL;
CREATE INDEX provider_artifacts_expiry_idx
  ON commonswarm_oauth.provider_artifacts (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE commonswarm_oauth.refresh_family_tombstones (
  grant_id text PRIMARY KEY CHECK (length(grant_id) BETWEEN 1 AND 2048),
  revoked_at timestamptz NOT NULL
);

CREATE TABLE commonswarm_oauth.browser_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  user_id uuid,
  user_email text CHECK (user_email IS NULL OR length(user_email) <= 320),
  user_display_name text CHECK (user_display_name IS NULL OR length(user_display_name) <= 512),
  authenticated_at timestamptz,
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX browser_sessions_expiry_idx ON commonswarm_oauth.browser_sessions (expires_at);

CREATE TABLE commonswarm_oauth.interactions (
  interaction_uid text PRIMARY KEY CHECK (length(interaction_uid) BETWEEN 1 AND 2048),
  session_hash bytea NOT NULL REFERENCES commonswarm_oauth.browser_sessions(session_hash),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 4096),
  resource text NOT NULL CHECK (resource = 'https://mcp.commonswarm.com/mcp'),
  requested_scopes text[] NOT NULL CHECK (cardinality(requested_scopes) BETWEEN 1 AND 32),
  pkce_challenge text NOT NULL CHECK (length(pkce_challenge) BETWEEN 43 AND 128),
  oauth_state text CHECK (oauth_state IS NULL OR length(oauth_state) <= 2048),
  signin_state_hash bytea CHECK (signin_state_hash IS NULL OR octet_length(signin_state_hash) = 32),
  signin_pkce_verifier text CHECK (signin_pkce_verifier IS NULL OR length(signin_pkce_verifier) BETWEEN 43 AND 128),
  signin_state_consumed_at timestamptz,
  user_id uuid,
  selected_workspace_ids uuid[] NOT NULL DEFAULT '{}',
  selection_version bigint NOT NULL DEFAULT 0 CHECK (selection_version >= 0),
  manifest_digest bytea CHECK (manifest_digest IS NULL OR octet_length(manifest_digest) = 32),
  provider_grant_id text CHECK (provider_grant_id IS NULL OR length(provider_grant_id) <= 2048),
  commonswarm_grant_id uuid,
  consent_token_hash bytea CHECK (consent_token_hash IS NULL OR octet_length(consent_token_hash) = 32),
  consent_token_consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX interactions_session_idx ON commonswarm_oauth.interactions (session_hash);
CREATE INDEX interactions_expiry_idx ON commonswarm_oauth.interactions (expires_at);

CREATE TABLE commonswarm_oauth.cimd_cache (
  client_id text PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND 2048),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  metadata_digest bytea NOT NULL CHECK (octet_length(metadata_digest) = 32),
  validated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > validated_at)
);
CREATE INDEX cimd_cache_expiry_idx ON commonswarm_oauth.cimd_cache (expires_at);

CREATE TABLE commonswarm_oauth.consent_orchestration (
  interaction_uid text NOT NULL REFERENCES commonswarm_oauth.interactions(interaction_uid) ON DELETE CASCADE,
  step_kind text NOT NULL CHECK (step_kind IN ('begin', 'consent', 'activate', 'revoke_grant', 'revoke_seat')),
  workspace_id uuid NOT NULL,
  command_id uuid NOT NULL,
  receipt_id uuid,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 128),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (interaction_uid, step_kind, workspace_id),
  UNIQUE (command_id)
);

ALTER TABLE commonswarm_oauth.provider_artifacts OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.refresh_family_tombstones OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.browser_sessions OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.interactions OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.cimd_cache OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.consent_orchestration OWNER TO swarm_admin;

ALTER TABLE commonswarm_oauth.provider_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commonswarm_oauth.refresh_family_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE commonswarm_oauth.browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commonswarm_oauth.interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commonswarm_oauth.cimd_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE commonswarm_oauth.consent_orchestration ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_runtime_artifacts ON commonswarm_oauth.provider_artifacts
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
CREATE POLICY oauth_runtime_tombstones_read ON commonswarm_oauth.refresh_family_tombstones
  FOR SELECT TO commonswarm_oauth_runtime USING (true);
CREATE POLICY oauth_runtime_tombstones_insert ON commonswarm_oauth.refresh_family_tombstones
  FOR INSERT TO commonswarm_oauth_runtime WITH CHECK (true);
CREATE POLICY oauth_runtime_sessions ON commonswarm_oauth.browser_sessions
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
CREATE POLICY oauth_runtime_interactions ON commonswarm_oauth.interactions
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
CREATE POLICY oauth_runtime_cimd ON commonswarm_oauth.cimd_cache
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
CREATE POLICY oauth_runtime_orchestration ON commonswarm_oauth.consent_orchestration
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA commonswarm_oauth FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  commonswarm_oauth.provider_artifacts,
  commonswarm_oauth.browser_sessions,
  commonswarm_oauth.interactions,
  commonswarm_oauth.cimd_cache,
  commonswarm_oauth.consent_orchestration
TO commonswarm_oauth_runtime;
GRANT SELECT, INSERT ON commonswarm_oauth.refresh_family_tombstones
  TO commonswarm_oauth_runtime;

CREATE FUNCTION commonswarm_oauth.hosted_grant_is_active(
  p_state text,
  p_revoked_at timestamptz,
  p_person_exists boolean,
  p_tombstoned boolean
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT p_state = 'active' AND p_revoked_at IS NULL
    AND p_person_exists AND NOT p_tombstoned
$function$;
ALTER FUNCTION commonswarm_oauth.hosted_grant_is_active(text, timestamptz, boolean, boolean)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_oauth.hosted_grant_is_active(text, timestamptz, boolean, boolean)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE FUNCTION commonswarm_oauth.resolve_hosted_grant_status(p_provider_grant_id text)
RETURNS TABLE (
  grant_id uuid,
  client_id text,
  owner_user_id uuid,
  resource text,
  active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN QUERY EXECUTE
    'SELECT g.grant_id, g.client_id, g.owner_user_id, g.resource,
            commonswarm_oauth.hosted_grant_is_active(
              g.state, g.revoked_at, u.user_id IS NOT NULL, t.grant_id IS NOT NULL
            ) AS active
       FROM swarm.hosted_mcp_grants AS g
       LEFT JOIN swarm.users AS u ON u.user_id = g.owner_user_id
       LEFT JOIN commonswarm_oauth.refresh_family_tombstones AS t
         ON t.grant_id = g.provider_grant_id
      WHERE g.provider_grant_id = $1
      LIMIT 1'
  USING p_provider_grant_id;
END
$function$;
ALTER FUNCTION commonswarm_oauth.resolve_hosted_grant_status(text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_oauth.resolve_hosted_grant_status(text)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.resolve_hosted_grant_status(text)
  TO commonswarm_oauth_runtime;

CREATE FUNCTION commonswarm_oauth.provider_family_active(p_provider_grant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones AS t
    WHERE t.grant_id = p_provider_grant_id
  ) AND COALESCE((
    SELECT s.active
    FROM commonswarm_oauth.resolve_hosted_grant_status(p_provider_grant_id) AS s
  ), false)
$function$;
ALTER FUNCTION commonswarm_oauth.provider_family_active(text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_oauth.provider_family_active(text)
  FROM PUBLIC, anon, authenticated, swarm_command, commonswarm_oauth_runtime;

DO $resource_role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swarm_read') THEN
    GRANT USAGE ON SCHEMA commonswarm_oauth TO swarm_read;
    GRANT EXECUTE ON FUNCTION commonswarm_oauth.provider_family_active(text) TO swarm_read;
  END IF;
END
$resource_role$;

ALTER DEFAULT PRIVILEGES FOR ROLE swarm_admin IN SCHEMA commonswarm_oauth
  REVOKE ALL ON TABLES FROM PUBLIC;
-- Function EXECUTE for PUBLIC is a global built-in default. A schema-local
-- REVOKE is a no-op unless a schema-local default ACL already exists.
ALTER DEFAULT PRIVILEGES FOR ROLE swarm_admin
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
