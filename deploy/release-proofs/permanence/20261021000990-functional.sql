-- Read-only functional check after 20261021000990: the eleven fenced routines
-- and the three fence triggers exist, and the read paths answer for unknown
-- keys without writing. No JWT claims are set, so the human projections return
-- nothing. Raises when any object is missing or a read fails.
DO $proof$ BEGIN
  IF to_regprocedure('swarm.prepare_renewal_grant(uuid,uuid)') IS NULL
    OR to_regprocedure('swarm.discover_local_credential_ids(bytea)') IS NULL
    OR to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)') IS NULL
    OR to_regprocedure('swarm.agent_tokens_successor_fence()') IS NULL
    OR to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)') IS NULL
    OR to_regprocedure('swarm.household_local_family_binding_guard()') IS NULL
    OR to_regprocedure('swarm.local_content_approval_pointer_guard()') IS NULL
    OR to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('swarm_read.home_overview()') IS NULL
    OR to_regprocedure('swarm_read.renewal_grant_roster(uuid)') IS NULL
    OR to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'local suspension fence routines are absent';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN ('agent_tokens_successor_fence','aa_household_local_family_binding','aa_local_content_approval_pointer'))<>3 THEN
    RAISE EXCEPTION 'local suspension fence triggers are not all enabled';
  END IF;
  -- An unknown credential hash matches no token: the discovery returns no row and raises nothing.
  PERFORM * FROM swarm.discover_local_credential_ids(decode(md5(random()::text)||md5(random()::text),'hex'));
  PERFORM * FROM swarm_read.renewal_grant_for_token(gen_random_uuid(),gen_random_uuid());
  PERFORM * FROM swarm_read.local_connection_selection(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
  PERFORM swarm_read.home_overview();
  PERFORM * FROM swarm_read.renewal_grant_roster(gen_random_uuid());
END $proof$;
