BEGIN READ ONLY;
SELECT 'DB_IDENTITY' || E'\t' || current_database() || E'\t' || current_user;
SELECT 'DB_MIGRATION_04_LEDGER' || E'\t' || count(*)
FROM supabase_migrations.schema_migrations WHERE version='20260928000004';
SELECT 'DB_MIGRATION_04_TABLES' || E'\t' ||
  ((to_regclass('swarm.hosted_mcp_check_cursors') IS NOT NULL)::int +
   (to_regclass('swarm.hosted_mcp_check_batches') IS NOT NULL)::int);
SELECT 'DB_TEMP_PRINCIPALS_TOTAL' || E'\t' || count(*)
FROM swarm.agent_principals
WHERE name IN ('hm37-hosted-021020','hm37-local-021020','hm37-sender-021020');
SELECT 'DB_TEMP_PRINCIPALS_ACTIVE' || E'\t' || count(*)
FROM swarm.agent_principals
WHERE name IN ('hm37-hosted-021020','hm37-local-021020','hm37-sender-021020')
  AND revoked_at IS NULL;
SELECT 'DB_TEMP_AGENT_TOKENS_TOTAL' || E'\t' || count(*)
FROM swarm.agent_tokens AS t JOIN swarm.agent_principals AS p USING (principal_id)
WHERE p.name IN ('hm37-hosted-021020','hm37-local-021020','hm37-sender-021020');
SELECT 'DB_TEMP_AGENT_TOKENS_ACTIVE_UNEXPIRED' || E'\t' || count(*)
FROM swarm.agent_tokens AS t JOIN swarm.agent_principals AS p USING (principal_id)
WHERE p.name IN ('hm37-hosted-021020','hm37-local-021020','hm37-sender-021020')
  AND t.revoked_at IS NULL AND t.expires_at > statement_timestamp();
SELECT 'DB_TEMP_HOSTED_SEATS_TOTAL' || E'\t' || count(*)
FROM swarm.hosted_mcp_seats WHERE name='hm37-hosted-021020';
SELECT 'DB_TEMP_HOSTED_SEATS_ACTIVE' || E'\t' || count(*)
FROM swarm.hosted_mcp_seats WHERE name='hm37-hosted-021020' AND revoked_at IS NULL;
SELECT 'DB_TEMP_HOSTED_HANDLES_ACTIVE' || E'\t' || count(*)
FROM swarm.hosted_mcp_seat_handles AS h
JOIN swarm.hosted_mcp_seats AS s USING (seat_id, grant_id, workspace_id, principal_id)
WHERE s.name='hm37-hosted-021020' AND h.revoked_at IS NULL;
SELECT 'DB_TEMP_HOSTED_GRANTS_ACTIVE' || E'\t' || count(DISTINCT g.grant_id)
FROM swarm.hosted_mcp_grants AS g
JOIN swarm.hosted_mcp_seats AS s USING (grant_id)
WHERE s.name='hm37-hosted-021020' AND g.revoked_at IS NULL;
COMMIT;
