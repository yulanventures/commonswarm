-- After the reserve rollback: one read-only Boolean. True when the previous checks are back (no sender_not_live), or
-- when the rollback kept the widened checks because sender_not_live rows exist (its NOTICE says so).
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM swarm.signal_deliveries WHERE ack_outcome = 'failed_terminal' AND last_error_code = 'sender_not_live')
  THEN true
  ELSE COALESCE((
      SELECT c.convalidated AND pg_get_constraintdef(c.oid) NOT LIKE '%sender_not_live%'
      FROM pg_constraint AS c
      WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%delivered_at IS NOT NULL%'
        AND pg_get_constraintdef(c.oid) NOT LIKE '%last_lease_id%'
    ), false)
    AND COALESCE((
      SELECT c.convalidated
        AND pg_get_constraintdef(c.oid) NOT LIKE '%sender_not_live%'
        AND pg_get_constraintdef(c.oid) LIKE '%delivery_attempts_exhausted%'
      FROM pg_constraint AS c
      WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%last_lease_id IS NOT NULL%'
    ), false)
  END AS rollback_ok
\gset
