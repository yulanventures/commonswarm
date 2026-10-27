-- Additive storage only. Existing mint/auth/cleanup behavior remains in place.
-- The migration runner owns the transaction; no existing row is converted.
ALTER TABLE swarm.hosted_mcp_grants
  ADD COLUMN connection_expires_at timestamptz,
  ADD COLUMN connection_expired_at timestamptz;

ALTER TABLE swarm.renewal_grants
  ADD COLUMN connection_expires_at timestamptz,
  ADD COLUMN connection_expired_at timestamptz;

-- The elapsed fence is independent of the nullable owner deadline. Enforcement
-- and irreversible transition rules belong to the subsequent reviewed slice.
CREATE INDEX hosted_mcp_grants_connection_deadline_idx
  ON swarm.hosted_mcp_grants (connection_expires_at)
  WHERE connection_expires_at IS NOT NULL AND connection_expired_at IS NULL;
CREATE INDEX renewal_grants_connection_deadline_idx
  ON swarm.renewal_grants (connection_expires_at)
  WHERE connection_expires_at IS NOT NULL AND connection_expired_at IS NULL;

ALTER TABLE swarm.household_content_connections
  ADD COLUMN renewal_grant_id uuid
    REFERENCES swarm.renewal_grants (renewal_grant_id);

-- PostgreSQL CHECK already accepts NULL. Keep the existing finite ordering
-- check and 30-day default, along with all owners, RLS policies and ACLs.
ALTER TABLE commonswarm_oauth.registered_clients
  ALTER COLUMN expires_at DROP NOT NULL;
