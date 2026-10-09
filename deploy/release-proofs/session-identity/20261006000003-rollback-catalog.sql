-- Data-free reserve result only. Live allocation rollback retains this schema.
WITH incoming_expected(tab,definition) AS (VALUES
 ('hosted_mcp_seat_handles','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_cursors','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_batches','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)')
), incoming_actual AS (
 SELECT r.relname::text,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
 WHERE c.confrelid=to_regclass('swarm.hosted_mcp_seats') AND c.contype='f'
), incoming_diff AS (
 (SELECT * FROM incoming_expected EXCEPT ALL SELECT * FROM incoming_actual)
 UNION ALL (SELECT * FROM incoming_actual EXCEPT ALL SELECT * FROM incoming_expected)
)
SELECT COALESCE(
  to_regclass('swarm.hosted_agent_contexts') IS NULL
  AND to_regprocedure('swarm.hosted_predecessor_status(uuid)') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.agent_principals')
    AND attname='identity_lifetime' AND NOT attisdropped)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.hosted_mcp_seats')
    AND attname IN ('display_name','disambiguator') AND NOT attisdropped)
  AND NOT EXISTS(SELECT 1 FROM swarm.config WHERE key='hosted_context_allocation_enabled')
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN ('agent_principals_identity_lifetime_check','hosted_mcp_seats_display_name_check','hosted_mcp_seats_disambiguator_check'))
  AND (SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass('swarm.hosted_mcp_seats_live_name'))=
    'CREATE UNIQUE INDEX hosted_mcp_seats_live_name ON swarm.hosted_mcp_seats USING btree (workspace_id, name) WHERE (revoked_at IS NULL)'
  AND NOT EXISTS(SELECT 1 FROM incoming_diff)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.confrelid=to_regclass('swarm.hosted_mcp_seats') AND c.contype='f'
    AND (c.confupdtype<>'a' OR c.confdeltype<>'a' OR c.confmatchtype<>'s' OR c.condeferrable OR c.condeferred OR NOT c.convalidated)),
 false) AS rollback_ok
\gset
