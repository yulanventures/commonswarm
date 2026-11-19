-- Read-only rollback catalog verification for 20261119000002: the scope read is gone.
SELECT to_regprocedure('swarm_read.agent_removal_scope(uuid,uuid)') IS NULL AS rollback_ok;
