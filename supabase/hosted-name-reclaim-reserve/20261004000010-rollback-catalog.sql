-- Prove the original constraint is restored and the live-name index is gone.
SELECT coalesce((
SELECT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = to_regclass('swarm.hosted_mcp_seats')
    AND conname = 'hosted_mcp_seats_grant_id_workspace_id_name_key'
    AND contype = 'u' AND convalidated
    AND pg_get_constraintdef(oid) = 'UNIQUE (grant_id, workspace_id, name)'
) AND to_regclass('swarm.hosted_mcp_seats_live_name') IS NULL
),false) AS rollback_ok
\gset
