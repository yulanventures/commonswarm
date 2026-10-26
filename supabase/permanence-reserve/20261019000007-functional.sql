-- Read-only functional check after 20261019000007: the pointer column, the
-- discovery functions, both guards with their triggers and the connection
-- policy readers are present, the readers return the policy columns, and
-- discovery refuses a malformed selector before it reads any row. Nothing here
-- writes or takes a row lock, so the same text runs under a read-only session.
DO $proof$ BEGIN
  IF to_regprocedure('swarm.discover_local_credential_ids(bytea)') IS NULL
    OR to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)') IS NULL
    OR to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid)') IS NULL
    OR to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)') IS NULL
    OR to_regprocedure('swarm.discover_local_join_ids(bytea,uuid)') IS NULL
    OR to_regprocedure('swarm.household_local_family_binding_guard()') IS NULL
    OR to_regprocedure('swarm.local_content_approval_pointer_guard()') IS NULL
    OR to_regprocedure('swarm_read.renewal_grant_roster(uuid)') IS NULL
    OR to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'local auth lock order objects are absent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.renewal_grants'::regclass
    AND attname='local_content_approval_token_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'local content approval pointer column is absent';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
      (tgrelid='swarm.household_content_connections'::regclass AND tgname='aa_household_local_family_binding')
      OR (tgrelid='swarm.renewal_grants'::regclass AND tgname='aa_local_content_approval_pointer')))<>2 THEN
    RAISE EXCEPTION 'local approval guard triggers are not bound and enabled';
  END IF;
  PERFORM count(*) FROM swarm.renewal_grants;
  PERFORM connection_expires_at,connection_expired_at FROM swarm_read.renewal_grant_roster(gen_random_uuid());
  PERFORM connection_expires_at,connection_expired_at FROM swarm_read.renewal_grant_for_token(gen_random_uuid(),gen_random_uuid());
  BEGIN
    PERFORM * FROM swarm.discover_local_credential_ids(NULL::bytea);
    RAISE EXCEPTION 'credential discovery admitted a NULL hash';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM swarm.discover_local_target_ids(gen_random_uuid(),NULL::uuid,ARRAY[]::uuid[],ARRAY[]::uuid[],false);
    RAISE EXCEPTION 'target discovery admitted an empty selector';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM swarm.discover_local_join_ids(NULL::bytea,NULL::uuid);
    RAISE EXCEPTION 'join discovery admitted a NULL credential';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END $proof$;
