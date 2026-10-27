-- Read-only functional check after 20261019000008: both functions exist, the
-- cascade trigger is bound and enabled, the tombstone ledger is readable, and
-- the residual revoke API refuses a malformed selector before it reads or locks
-- any row. Nothing here writes, so the same text runs under a read-only session.
DO $proof$ BEGIN
  IF to_regprocedure('swarm.renewal_grants_revoke_cascade()') IS NULL
    OR to_regprocedure('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'local inactive parent closure objects are absent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.renewal_grants'::regclass
    AND tgname='renewal_grants_revoke_cascade' AND NOT tgisinternal AND tgenabled='O'
    AND tgfoid='swarm.renewal_grants_revoke_cascade()'::regprocedure) THEN
    RAISE EXCEPTION 'renewal grant revocation cascade trigger is not bound and enabled';
  END IF;
  PERFORM count(*) FROM swarm.revocation_tombstones;
  BEGIN
    PERFORM swarm.revoke_local_residual_tokens(NULL,NULL,NULL,NULL);
    RAISE EXCEPTION 'residual revoke admitted a NULL selector';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM swarm.revoke_local_residual_tokens(gen_random_uuid(),gen_random_uuid(),'revoke_everything',gen_random_uuid());
    RAISE EXCEPTION 'residual revoke admitted an unknown kind';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END $proof$;
