-- Rollback for 20261119000001: drop the one read-only function it added. No table, column or other function is touched.
DROP FUNCTION IF EXISTS swarm_read.agent_removal_scope(uuid, uuid);
