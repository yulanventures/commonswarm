-- Read-only functional check after 20261019000002: both deadline columns, the
-- approval binding column and the now optional registration expiry are
-- readable, both partial deadline indexes exist with the migration's predicate
-- and the binding foreign key is validated. Raises when any is absent.
DO $proof$ BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants'))
      AND attname IN ('connection_expires_at','connection_expired_at') AND NOT attisdropped AND NOT attnotnull)<>4 THEN
    RAISE EXCEPTION 'connection deadline columns are absent';
  END IF;
  IF (SELECT count(*) FROM pg_index WHERE indexrelid IN (to_regclass('swarm.hosted_mcp_grants_connection_deadline_idx'),
      to_regclass('swarm.renewal_grants_connection_deadline_idx')) AND indisvalid
      AND pg_get_expr(indpred,indrelid)='((connection_expires_at IS NOT NULL) AND (connection_expired_at IS NULL))')<>2 THEN
    RAISE EXCEPTION 'connection deadline indexes are absent or carry another predicate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.household_content_connections')
      AND contype='f' AND convalidated AND confrelid=to_regclass('swarm.renewal_grants')) THEN
    RAISE EXCEPTION 'approval family binding foreign key is absent';
  END IF;
  IF coalesce((SELECT attnotnull FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.registered_clients')
      AND attname='expires_at' AND NOT attisdropped),true) THEN
    RAISE EXCEPTION 'registered client expiry is still mandatory';
  END IF;
  PERFORM count(*) FROM swarm.hosted_mcp_grants WHERE connection_expires_at IS NOT NULL AND connection_expired_at IS NULL;
  PERFORM count(*) FROM swarm.renewal_grants WHERE connection_expires_at IS NOT NULL AND connection_expired_at IS NULL;
  PERFORM count(*) FROM swarm.household_content_connections WHERE renewal_grant_id IS NOT NULL;
  PERFORM count(*) FROM commonswarm_oauth.registered_clients WHERE expires_at IS NULL;
END $proof$;
