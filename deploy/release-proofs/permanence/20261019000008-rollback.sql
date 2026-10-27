-- Restore the 20260728000002 definition of swarm.renewal_grants_revoke_cascade()
-- verbatim and drop the trusted residual revoke API that 20261019000008 created.
-- Apply inside one transaction as a swarm_admin member, after the 20261019000009
-- reserve and before the 20261019000007 reserve: 00008 is inseparable from
-- 00007, and no later migration replaces either function. CREATE OR REPLACE
-- keeps the owner, the search_path setting, the owner-only ACL, the comment and
-- the AFTER UPDATE cascade trigger binding; the definer mode returns to invoker
-- rights because the 20260728000002 text declares no SECURITY DEFINER. The
-- owner, ACL and comment statements below repeat 20260728000002 exactly.
-- Kept on purpose: every revocation tombstone and revoked_at stamp that the
-- 00008 cascade or the residual path wrote. They are terminal facts the older
-- cascade and agent authentication already honour; nothing is rewritten.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_revoke_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
  VALUES ('renewal_grant', NEW.renewal_grant_id, NEW.revoked_by)
  ON CONFLICT (kind, target_id) DO NOTHING;

  UPDATE swarm.agent_tokens
  SET revoked_at = statement_timestamp()
  WHERE renewal_grant_id = NEW.renewal_grant_id
    AND revoked_at IS NULL;

  RETURN NULL;
END
$$;

ALTER FUNCTION swarm.renewal_grants_revoke_cascade() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_revoke_cascade() FROM PUBLIC;

COMMENT ON FUNCTION swarm.renewal_grants_revoke_cascade() IS
  'Makes grant revocation lineage-wide without asking any caller to remember to do it: tombstones the grant and revokes every token issued under it, so the descendants fail the revocation check agent-auth already runs on every command.';

DROP FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid);
