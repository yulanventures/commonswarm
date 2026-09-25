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
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS a WHERE a.grantee = 0)
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('swarm_read.signal_delivery_receipts(uuid,uuid,bytea)')
  ), false)
  AND COALESCE((
    SELECT c.convalidated AND (
      pg_get_constraintdef(c.oid) = 'CHECK (((acked_at IS NULL) OR ((last_lease_id IS NOT NULL) AND (last_leased_by IS NOT NULL)) OR (ack_outcome = ''expired''::text) OR ((ack_outcome = ''failed_terminal''::text) AND (last_error_code = ''delivery_attempts_exhausted''::text))))'
      OR (EXISTS (SELECT 1 FROM swarm.signal_deliveries AS d
            WHERE d.acked_at IS NOT NULL AND d.ack_outcome = 'observed'
              AND (d.last_lease_id IS NULL OR d.last_leased_by IS NULL))
          AND pg_get_constraintdef(c.oid) LIKE '%(ack_outcome = ''observed''::text) AND (last_error_code IS NULL)%'))
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.conname = 'signal_deliveries_check9'
  ), false)
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260925000001')
  AS rollback_ok
\gset
