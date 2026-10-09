-- Data-free reserve inverse ONLY. Apply in the reviewed outer transaction.
-- Phase 3 and phase 5 dependents must already be reversed or absent.
-- Fence in-flight allocations before changing or removing the gate.
-- Any future activation/flag flip must take this same exclusive lock.
SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
DO $reserve$
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts)
     OR EXISTS (SELECT 1 FROM swarm.agent_principals WHERE identity_lifetime <> 'durable')
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seats WHERE display_name IS NOT NULL OR disambiguator IS NOT NULL)
     OR EXISTS (SELECT 1 FROM swarm.config WHERE key = 'hosted_context_allocation_enabled' AND value <> 'false'::jsonb) THEN
    RAISE EXCEPTION 'reserve rollback refused: hosted identity data' USING ERRCODE = '55000';
  END IF;
END
$reserve$;
DROP FUNCTION IF EXISTS swarm.hosted_predecessor_status(uuid);
DROP TABLE swarm.hosted_agent_contexts;
ALTER TABLE swarm.hosted_mcp_seats DROP COLUMN display_name, DROP COLUMN disambiguator;
ALTER TABLE swarm.agent_principals DROP COLUMN identity_lifetime;
DELETE FROM swarm.config WHERE key = 'hosted_context_allocation_enabled';
-- No CASCADE. Unexpected later-phase dependencies refuse the transaction.
