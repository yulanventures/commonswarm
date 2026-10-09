-- Allocation rollback. Anvil only in an approved database transaction.
-- Keep the new policy, schema, contexts, grants and retained work.
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
