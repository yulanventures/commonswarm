-- One read-only Boolean: the catalog after 20260925000001-rollback.sql matches the pre-G catalog for every object the
-- migration touched. check9 may be either the pre-G definition or, when unclaimed observed rows exist, the widened one.
SELECT
  to_regclass('swarm.wake_path_eligible_deliveries') IS NULL
  AND to_regclass('swarm_read.agent_wake_path_deliveries') IS NULL
  AND to_regclass('swarm_read.agent_wake_path') IS NULL
  AND to_regclass('swarm.wake_path_release') IS NULL
  AND to_regclass('swarm.signal_deliveries_unclaimed_observed') IS NULL
  AND to_regprocedure('swarm_read.signal_delivery_receipts_without_wake_path(uuid,uuid,bytea)') IS NULL
  AND COALESCE((
    SELECT pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND p.prosecdef
      AND pg_get_functiondef(p.oid) NOT LIKE '%wake_path%'
      AND pg_get_functiondef(p.oid) LIKE '%signal_delivery_receipts_without_main_queue_count%'
      AND p.provolatile = 'v'
      AND p.proacl IS NOT NULL
      -- Exactly the pre-G grantees: the owner, authenticated and swarm_read, each EXECUTE only; no PUBLIC.
      AND (SELECT array_agg(g.grant_text ORDER BY g.grant_text)
           FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                          || ':' || a.privilege_type AS grant_text
                 FROM aclexplode(p.proacl) AS a) AS g)
          = ARRAY['authenticated:EXECUTE', 'swarm_admin:EXECUTE', 'swarm_read:EXECUTE']
      AND obj_description(p.oid, 'pg_proc') = 'Author-scoped directed receipts and live broadcast member/agent rosters. Agent seen_at is a CLI render or listener feed-consumption attestation; legacy agent keys remain additive through the 0.1.47 wire.'
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('swarm_read.signal_delivery_receipts(uuid,uuid,bytea)')
  ), false)
  AND COALESCE((
    SELECT c.convalidated AND (
      pg_get_constraintdef(c.oid) = 'CHECK (((acked_at IS NULL) OR ((last_lease_id IS NOT NULL) AND (last_leased_by IS NOT NULL)) OR (ack_outcome = ''expired''::text) OR ((ack_outcome = ''failed_terminal''::text) AND (last_error_code = ''delivery_attempts_exhausted''::text))))'
      OR (EXISTS (SELECT 1 FROM swarm.signal_deliveries AS d
            WHERE d.acked_at IS NOT NULL AND d.ack_outcome = 'observed'
              AND (d.last_lease_id IS NULL OR d.last_leased_by IS NULL))
          AND pg_get_constraintdef(c.oid) = 'CHECK (((acked_at IS NULL) OR ((last_lease_id IS NOT NULL) AND (last_leased_by IS NOT NULL)) OR (ack_outcome = ''expired''::text) OR ((ack_outcome = ''observed''::text) AND (last_error_code IS NULL)) OR ((ack_outcome = ''failed_terminal''::text) AND (last_error_code = ''delivery_attempts_exhausted''::text))))'))
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.conname = 'signal_deliveries_check9'
  ), false)
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260925000001')
  AS rollback_ok
\gset
