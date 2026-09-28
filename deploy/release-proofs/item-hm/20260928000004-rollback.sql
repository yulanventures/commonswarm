-- Complete inverse for 20260928000004_hm_hosted_check.sql.
-- Restores the 20260928000002 hosted-authority catalog unchanged.
-- Function identity is its input signature; the explicit TABLE return has no
-- dependency on the replaceable swarm_read.signals row type.
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_visible_signals(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS swarm.resolve_hosted_mcp_check_authorization(uuid, text);

DROP TRIGGER IF EXISTS hosted_mcp_check_batches_guard
  ON swarm.hosted_mcp_check_batches;
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_batches_guard();
DROP TRIGGER IF EXISTS hosted_mcp_check_cursors_guard
  ON swarm.hosted_mcp_check_cursors;
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_cursors_guard();

DROP TABLE IF EXISTS swarm.hosted_mcp_check_batches;
DROP TABLE IF EXISTS swarm.hosted_mcp_check_cursors;
