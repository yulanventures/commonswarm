-- Rollback catalog proof for 20260928000004_hm_hosted_check.sql.
-- The dependency migration 20260928000002 must remain present.
SELECT
  to_regclass('swarm.hosted_mcp_check_cursors') IS NULL
  AND to_regclass('swarm.hosted_mcp_check_batches') IS NULL
  AND to_regclass('swarm.hosted_mcp_check_batches_one_active') IS NULL
  AND to_regprocedure('swarm.hosted_mcp_check_batches_guard()') IS NULL
  AND to_regprocedure('swarm.hosted_mcp_check_cursors_guard()') IS NULL
  AND to_regprocedure('swarm.resolve_hosted_mcp_check_authorization(uuid,text)') IS NULL
  AND to_regprocedure(
    'swarm.hosted_mcp_check_visible_signals(uuid,uuid,uuid[])'
  ) IS NULL
  AND to_regclass('swarm.hosted_mcp_grants') IS NOT NULL
  AND to_regclass('swarm.hosted_mcp_seats') IS NOT NULL
  AND to_regprocedure(
    'swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'
  ) IS NOT NULL
  AND to_regprocedure(
    'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'
  ) IS NOT NULL
  AS rollback_ok
\gset
