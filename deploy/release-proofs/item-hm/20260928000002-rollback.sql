-- Authority-schema inverse for 20260928000002_hm_hosted_authority.sql.
-- Hosted receipts may outlive that schema. Preserve their kinds and replay
-- history alongside the pre-HM user/agent/join receipts; never rewrite them.
-- The caller supplies the transaction and rollback-catalog verification.
DROP VIEW IF EXISTS swarm_read.hosted_mcp_seats;
DROP VIEW IF EXISTS swarm_read.hosted_mcp_connections;

DROP FUNCTION IF EXISTS swarm.resolve_hosted_seat_read_authorization(uuid, text, text);
DROP FUNCTION IF EXISTS swarm.resolve_hosted_seat_command_authorization(uuid, text, text);
DROP FUNCTION IF EXISTS swarm.resolve_hosted_grant_authorization(uuid, uuid, uuid, text);

DROP TABLE IF EXISTS swarm.hosted_mcp_seat_handles;
DROP TABLE IF EXISTS swarm.hosted_mcp_seats;
DROP TABLE IF EXISTS swarm.hosted_mcp_grant_workspaces;
DROP TABLE IF EXISTS swarm.hosted_mcp_grants;

ALTER TABLE swarm.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_principal_kind_check;
ALTER TABLE swarm.idempotency_keys
  ADD CONSTRAINT idempotency_keys_principal_kind_check
  CHECK (principal_kind IN ('user', 'agent', 'join', 'hosted_grant', 'hosted_seat'));
