-- Read-only functional check after 20261019000010: the selection helper, both
-- human projections and the extended hosted connection view exist and answer.
-- No JWT claims are set, so the projections return nothing and write nothing.
-- Raises when any object is missing or a read fails.
DO $proof$ BEGIN
  IF to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('swarm_read.home_overview()') IS NULL
    OR to_regprocedure('swarm_read.renewal_grant_roster(uuid)') IS NULL
    OR to_regclass('swarm_read.hosted_mcp_connections') IS NULL THEN
    RAISE EXCEPTION 'local permanence read model objects are absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm_read.hosted_mcp_connections')
      AND attname IN ('connection_expires_at','connection_expired_at') AND NOT attisdropped
      GROUP BY attrelid HAVING count(*)=2) THEN
    RAISE EXCEPTION 'hosted_mcp_connections lacks the connection expiry columns';
  END IF;
  PERFORM * FROM swarm_read.local_connection_selection(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
  PERFORM swarm_read.home_overview();
  PERFORM * FROM swarm_read.renewal_grant_roster(gen_random_uuid());
  PERFORM count(*) FROM swarm_read.hosted_mcp_connections;
END $proof$;
