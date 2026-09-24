-- Section 5: one read-only Boolean. A missing constraint or roster view is false.
SELECT
  COALESCE((
    SELECT c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%ack_outcome = ''observed''%'
      AND pg_get_constraintdef(c.oid) LIKE '%last_error_code IS NULL%'
      AND c.convalidated
      AND pg_get_constraintdef(c.oid) LIKE '%last_lease_id IS NOT NULL%'
      AND pg_get_constraintdef(c.oid) LIKE '%last_leased_by IS NOT NULL%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%ack_outcome = ''replied''%'
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.signal_deliveries')
      AND c.conname = 'signal_deliveries_check9'
  ), false)
  AND COALESCE((
    SELECT v.relkind = 'v'
      AND v.reloptions @> ARRAY['security_barrier=true']
      AND pg_get_userbyid(v.relowner) = 'swarm_admin'
      AND has_table_privilege('authenticated', v.oid, 'SELECT')
      AND NOT has_table_privilege('anon', v.oid, 'SELECT')
      AND pg_get_viewdef(v.oid) LIKE '%min(d.enqueued_at)%'
      AND pg_get_viewdef(v.oid) LIKE '%d.acked_at IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.lease_id IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.leased_by IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.last_lease_id IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.last_leased_by IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%wake_path_release%'
      AND pg_get_viewdef(v.oid) LIKE '%s.until > statement_timestamp()%'
      AND pg_get_viewdef(v.oid) LIKE '%observed.ack_outcome%'
      AND pg_get_viewdef(v.oid) LIKE '%s.kind = ANY%'
      AND pg_get_viewdef(v.oid) LIKE '%s.to_agent_principal_id = d.recipient_agent_principal_id%'
      AND pg_get_viewdef(v.oid) LIKE '%r.recipient_agent_principal_id = d.recipient_agent_principal_id%'
      AND pg_get_viewdef(v.oid) LIKE '%swarm.is_member%'
    FROM pg_class AS v
    WHERE v.oid = to_regclass('swarm_read.agent_wake_path')
  ), false)
  AND to_regclass('swarm.wake_path_release') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint AS other
    WHERE other.conrelid = to_regclass('swarm.signal_deliveries')
      AND other.contype = 'c' AND other.conname <> 'signal_deliveries_check9'
      AND pg_get_constraintdef(other.oid) LIKE '%acked_at%'
      AND pg_get_constraintdef(other.oid) LIKE '%last_lease_id IS NOT NULL%'
      AND pg_get_constraintdef(other.oid) NOT LIKE '%observed%'
  ) AS catalog_ok
\gset
