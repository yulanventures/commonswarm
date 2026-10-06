-- Prove migration 010's exact live-name index and removal of the old constraint.
SELECT NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'swarm.hosted_mcp_seats'::regclass
    AND conname = 'hosted_mcp_seats_grant_id_workspace_id_name_key'
) AND EXISTS (
  SELECT 1 FROM pg_index AS i
  JOIN pg_class AS c ON c.oid = i.indexrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_am AS am ON am.oid = c.relam
  WHERE n.nspname = 'swarm' AND c.relname = 'hosted_mcp_seats_live_name'
    AND i.indrelid = 'swarm.hosted_mcp_seats'::regclass
    AND am.amname = 'btree'
    AND i.indisunique AND i.indisvalid AND i.indisready
    AND i.indnkeyatts = 2 AND i.indnatts = 2
    AND i.indexprs IS NULL
    AND pg_get_indexdef(i.indexrelid, 1, true) = 'workspace_id'
    AND pg_get_indexdef(i.indexrelid, 2, true) = 'name'
    AND pg_get_expr(i.indpred, i.indrelid) = '(revoked_at IS NULL)'
    AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX hosted_mcp_seats_live_name ON swarm.hosted_mcp_seats USING btree (workspace_id, name) WHERE (revoked_at IS NULL)'
) AS catalog_ok
\gset
