-- Roll back 20261019000002 only after the reserves of every later permanence
-- version were applied, in reverse order: 20261025000001, 20261022000992,
-- 20261021000990, 20261019000010, 20261019000008, 20261019000007,
-- 20261019000004 and 20261019000003. Their functions, the 20261019000007
-- approval binding guard and the 20261019000010 connections view read the
-- columns dropped here; the guard below refuses while any of those four
-- markers is still installed.
-- Owner-chosen data lost by this rollback: every connection deadline and
-- recorded connection expiry on swarm.hosted_mcp_grants and
-- swarm.renewal_grants, and the family binding of every approval in
-- swarm.household_content_connections (the 20261025000001 reserve already
-- unbinds the grandfathered ones). No row is deleted.
-- Permanent client registrations (NULL expiry) get the 30 day window the
-- pre-permanence runtime gives a fresh or retained registration, measured from
-- this rollback, before NOT NULL is restored; their rows stay.
-- Kept on purpose: owners, RLS, policies and ACLs of all four tables, and the
-- 30 day default, ordering check and expiry index of
-- commonswarm_oauth.registered_clients.
DO $guard$ BEGIN
  IF to_regprocedure('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)') IS NOT NULL
    OR to_regprocedure('commonswarm_oauth.lock_hosted_client_streams(text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_content_connections')
      AND tgname='aa_household_local_family_binding' AND NOT tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm_read.hosted_mcp_connections')
      AND attname IN ('connection_expires_at','connection_expired_at') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'roll back 20261019000003 through 20261025000001 before 20261019000002'
      USING ERRCODE='55000';
  END IF;
END $guard$;
UPDATE commonswarm_oauth.registered_clients
SET expires_at = statement_timestamp() + interval '30 days'
WHERE expires_at IS NULL;
ALTER TABLE commonswarm_oauth.registered_clients ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE swarm.household_content_connections DROP COLUMN IF EXISTS renewal_grant_id;
DROP INDEX IF EXISTS swarm.hosted_mcp_grants_connection_deadline_idx;
DROP INDEX IF EXISTS swarm.renewal_grants_connection_deadline_idx;
ALTER TABLE swarm.hosted_mcp_grants
  DROP COLUMN IF EXISTS connection_expires_at,
  DROP COLUMN IF EXISTS connection_expired_at;
ALTER TABLE swarm.renewal_grants
  DROP COLUMN IF EXISTS connection_expires_at,
  DROP COLUMN IF EXISTS connection_expired_at;
