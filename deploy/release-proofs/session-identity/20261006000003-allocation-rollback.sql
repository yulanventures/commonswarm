-- Allocation rollback. Anvil only in an approved database transaction.
-- Keep the new policy, schema, contexts, grants and retained work.
-- Fence in-flight allocations before changing or removing the gate.
-- Any future activation/flag flip must take this same exclusive lock.
SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
UPDATE swarm.config
SET value = 'false'::jsonb
WHERE key = 'hosted_context_allocation_enabled';
DO $allocation_stop$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM swarm.config
    WHERE key = 'hosted_context_allocation_enabled' AND value = 'false'::jsonb
  ) THEN
    RAISE EXCEPTION 'allocation rollback refused: missing gate' USING ERRCODE = '55000';
  END IF;
END
$allocation_stop$;
