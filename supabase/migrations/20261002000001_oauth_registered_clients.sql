-- RFC 7591 registrations share provider grants and isolated OAuth storage.
-- The migration runner owns the transaction.
CREATE TABLE commonswarm_oauth.registered_clients (
  client_id text PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND 2048),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '30 days'),
  CHECK (expires_at > registered_at),
  CHECK (last_used_at IS NULL OR last_used_at >= registered_at)
);
CREATE INDEX registered_clients_expiry_idx ON commonswarm_oauth.registered_clients (expires_at);
ALTER TABLE commonswarm_oauth.registered_clients OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.registered_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY oauth_runtime_registered_clients ON commonswarm_oauth.registered_clients
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
REVOKE ALL ON commonswarm_oauth.registered_clients
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE, DELETE ON commonswarm_oauth.registered_clients
  TO commonswarm_oauth_runtime;
