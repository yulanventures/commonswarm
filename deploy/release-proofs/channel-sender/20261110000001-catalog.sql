-- Catalog proof for 20261110000001_delivery_sender_not_live: one read-only Boolean.
-- Both signal_deliveries checks are validated and admit failed_terminal / sender_not_live; the lease check still
-- refuses a lease-free replied ack or client error code; no other check on acked rows was left behind.
SELECT
  COALESCE((
    SELECT c.convalidated
      AND pg_get_constraintdef(c.oid) LIKE '%delivered_at IS NOT NULL%'
      AND pg_get_constraintdef(c.oid) LIKE '%sender_not_live%'
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%delivered_at IS NOT NULL%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%last_lease_id%'
  ), false)
  AND COALESCE((
    SELECT c.convalidated
      AND pg_get_constraintdef(c.oid) LIKE '%sender_not_live%'
      AND pg_get_constraintdef(c.oid) LIKE '%delivery_attempts_exhausted%'
      AND pg_get_constraintdef(c.oid) LIKE '%ack_outcome = ''observed''%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%replied%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%provider_refused%'
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%last_lease_id IS NOT NULL%'
  ), false)
  AND (SELECT count(*) FROM pg_constraint AS c
       WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%delivered_at IS NOT NULL%' AND pg_get_constraintdef(c.oid) NOT LIKE '%last_lease_id%') = 1
  AND (SELECT count(*) FROM pg_constraint AS c
       WHERE c.conrelid = to_regclass('swarm.signal_deliveries') AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%last_lease_id IS NOT NULL%') = 1
  AS catalog_ok
\gset
