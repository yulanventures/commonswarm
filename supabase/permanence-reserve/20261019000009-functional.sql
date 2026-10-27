-- Read-only functional check after 20261019000009: the audit trigger function
-- is installed with the pre-M00002 snapshot tolerance, it is bound to the
-- restriction table by an enabled trigger, and the table is readable. Nothing
-- here writes, so the same text runs under a read-only session.
DO $proof$ BEGIN
  IF to_regclass('swarm.household_hosted_content_restrictions') IS NULL
    OR to_regprocedure('swarm.audit_household_hosted_restriction()') IS NULL THEN
    RAISE EXCEPTION 'hosted restriction audit objects are absent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.household_hosted_content_restrictions'::regclass
    AND tgname='household_hosted_restriction_audit' AND NOT tgisinternal AND tgenabled='O'
    AND tgfoid='swarm.audit_household_hosted_restriction()'::regprocedure) THEN
    RAISE EXCEPTION 'hosted restriction audit trigger is not bound and enabled';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='swarm.audit_household_hosted_restriction()'::regprocedure
    AND prosrc LIKE '%renewal_grant_id%') THEN
    RAISE EXCEPTION 'hosted restriction audit lacks the pre-M00002 snapshot tolerance';
  END IF;
  PERFORM count(*) FROM swarm.household_hosted_content_restrictions;
END $proof$;
