-- Lane B: private account stream, grants, human confirmations and credentials.
-- No workspace administration or worker provisioning is enabled here.
CREATE TABLE swarm.admin_accounts (
  owner_user_id uuid PRIMARY KEY REFERENCES swarm.users(user_id),
  stream_id uuid NOT NULL UNIQUE,
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  projection jsonb NOT NULL DEFAULT '{"grants":{},"consents":{},"lineages":{},"rate_buckets":{}}'::jsonb,
  CHECK (jsonb_typeof(projection) = 'object')
);
CREATE TABLE swarm.admin_grants (
  grant_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  admin_identity_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  resource text NOT NULL CHECK (resource = 'https://api.commonswarm.com/admin'),
  mode text NOT NULL DEFAULT 'granular' CHECK (mode IN ('granular', 'full_account')),
  registry_version integer NOT NULL CHECK (registry_version = 1),
  scope_names text[] NOT NULL DEFAULT ARRAY['admin:read'],
  workspace_selector text NOT NULL DEFAULT 'selected' CHECK (workspace_selector IN ('selected', 'owned_and_selected')),
  workspace_ids uuid[] NOT NULL,
  created_workspace_policy jsonb NOT NULL,
  target_rules jsonb NOT NULL,
  worker_scope_ceiling text[] NOT NULL,
  role_ceiling text NOT NULL CHECK (role_ceiling = 'member'),
  renewal_limits jsonb NOT NULL,
  issuance_limits jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_deadline timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'suspended', 'expired')),
  consent_receipt_id uuid NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  suspended_at timestamptz,
  revoked_at timestamptz,
  reason_code text,
  withdrawn_workspace_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (grant_id, owner_user_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (expires_at <= refresh_deadline AND refresh_deadline <= created_at + interval '30 days'),
  CHECK ((mode = 'granular' AND workspace_selector = 'selected') OR
         (mode = 'full_account' AND workspace_selector = 'owned_and_selected'))
);
CREATE TABLE swarm.admin_consents (
  consent_receipt_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  -- Kept out of events/audit. Binds the receipt to verified human session claims.
  session_binding text NOT NULL CHECK (session_binding ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  full_account_selected boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (jsonb_typeof(manifest) = 'object'),
  CHECK (manifest->>'mode' <> 'full_account' OR full_account_selected)
);
CREATE TABLE swarm.admin_credentials (
  credential_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES swarm.admin_grants(grant_id),
  credential_lineage_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  access_hash bytea NOT NULL UNIQUE CHECK (octet_length(access_hash) = 32),
  refresh_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_hash) = 32),
  access_expires_at timestamptz NOT NULL,
  refresh_deadline timestamptz NOT NULL,
  scope_names text[] NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (credential_lineage_id, generation)
);
CREATE TABLE swarm.admin_events (
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  seq bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  command_id text NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (owner_user_id, seq),
  CHECK (event->>'stream_kind' = 'account'),
  CHECK (event->>'owner_user_id' = owner_user_id::text),
  CHECK ((event->>'seq')::bigint = seq)
);
CREATE TRIGGER admin_events_append_only BEFORE UPDATE OR DELETE ON swarm.admin_events
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
CREATE TABLE swarm.admin_command_results (
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  actor_key text NOT NULL,
  command_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  PRIMARY KEY (owner_user_id, actor_key, command_id)
);
CREATE TABLE swarm.admin_rate_buckets (
  bucket_key text NOT NULL,
  hour_start bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (bucket_key, hour_start)
);
CREATE TABLE swarm.admin_security_audit (
  audit_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  reason_code text NOT NULL
);
CREATE TRIGGER admin_security_audit_append_only BEFORE UPDATE OR DELETE ON swarm.admin_security_audit
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

DO $permissions$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_accounts','admin_grants','admin_consents','admin_credentials',
    'admin_events','admin_command_results','admin_rate_buckets','admin_security_audit'] LOOP
    EXECUTE format('ALTER TABLE swarm.%I OWNER TO swarm_admin', t);
    EXECUTE format('ALTER TABLE swarm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY swarm_command_all ON swarm.%I FOR ALL TO swarm_command USING (true) WITH CHECK (true)', t);
    EXECUTE format('REVOKE ALL ON swarm.%I FROM PUBLIC, anon, authenticated, swarm_read, swarm_command', t);
    EXECUTE format('GRANT SELECT, INSERT ON swarm.%I TO swarm_command', t);
  END LOOP;
END
$permissions$;
GRANT UPDATE ON swarm.admin_accounts, swarm.admin_grants, swarm.admin_consents,
  swarm.admin_credentials, swarm.admin_rate_buckets TO swarm_command;
CREATE INDEX admin_grants_owner ON swarm.admin_grants(owner_user_id, created_at);
CREATE INDEX admin_grants_connection ON swarm.admin_grants(connection_id);
CREATE UNIQUE INDEX admin_grants_active_connection ON swarm.admin_grants(owner_user_id, connection_id) WHERE state = 'active';
CREATE INDEX admin_credentials_grant ON swarm.admin_credentials(grant_id);

-- Reserve rollback (verbatim SQL also retained outside deploy/ in the sibling
-- admin-delegation-reserve/20261001000001-rollback.sql; execute only under an
-- approved release procedure; removes all lane-B data):
-- DROP TABLE IF EXISTS swarm.admin_security_audit;
-- DROP TABLE IF EXISTS swarm.admin_rate_buckets;
-- DROP TABLE IF EXISTS swarm.admin_command_results;
-- DROP TABLE IF EXISTS swarm.admin_events;
-- DROP TABLE IF EXISTS swarm.admin_credentials;
-- DROP TABLE IF EXISTS swarm.admin_consents;
-- DROP TABLE IF EXISTS swarm.admin_grants;
-- DROP TABLE IF EXISTS swarm.admin_accounts;
