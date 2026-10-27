-- Grandfather existing connections onto the permanent policy (decided by Tom,
-- 2026-10-24). Data only: no runtime authority, ACL or function changes.
-- The migration runner owns the transaction. Every change is journaled so the
-- paired rollback reserve can restore the exact prior row values.
--
-- Three populations, measured on production on 2026-10-25:
--   A. CLI time-boxed families whose horizon is still ahead become standing,
--      through the owner-only conversion carve-out of
--      swarm.renewal_grants_spend_or_revoke_only. Families whose horizon has
--      already passed are dead and stay dead.
--   B. Active hosted MCP grants without a provider resource binding receive the
--      same append-only binding row the 20261003000001 backfill created, so the
--      OAuth adapter can apply the permanent policy to their artifacts.
--   C. Live local Lists/docs approvals (finite expiry, token still known) are
--      linked to their token's family and lose the technical expiry. An approval
--      whose approved token already rotated is first re-keyed to the live token
--      of the same lineage and family, then linked. The family binding guard
--      validates each row; a refused row is left exactly as it was.
-- Hosted approvals already carry NULL expiry; no admin grants exist. Nothing
-- here touches those tables.

DO $role$
BEGIN
  IF NOT (pg_has_role(current_user,'swarm_admin','MEMBER')
          OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN
    RAISE EXCEPTION 'permanence grandfather requires swarm_admin membership';
  END IF;
END $role$;

CREATE TABLE IF NOT EXISTS swarm.permanence_grandfather_journal (
  entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relation text NOT NULL CHECK (relation IN (
    'swarm.renewal_grants','commonswarm_oauth.provider_grant_resources','swarm.household_content_connections')),
  row_key jsonb NOT NULL,
  action text NOT NULL CHECK (action IN (
    'converted','skipped-provenance','inserted','bound','skipped-binding')),
  previous jsonb,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_at timestamptz
);
ALTER TABLE swarm.permanence_grandfather_journal OWNER TO swarm_admin;
ALTER TABLE swarm.permanence_grandfather_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON swarm.permanence_grandfather_journal FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Append-only evidence. The only permitted change is the rollback reserve
-- stamping restored_at once.
CREATE OR REPLACE FUNCTION swarm.permanence_grandfather_journal_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND OLD.restored_at IS NULL AND NEW.restored_at IS NOT NULL
     AND (to_jsonb(NEW)-'restored_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'restored_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SWARM_APPEND_ONLY' USING ERRCODE='55000';
END $fn$;
ALTER FUNCTION swarm.permanence_grandfather_journal_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.permanence_grandfather_journal_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS permanence_grandfather_journal_guard ON swarm.permanence_grandfather_journal;
CREATE TRIGGER permanence_grandfather_journal_guard
  BEFORE UPDATE OR DELETE ON swarm.permanence_grandfather_journal
  FOR EACH ROW EXECUTE FUNCTION swarm.permanence_grandfather_journal_guard();

-- Catalog proofs call these instead of naming the journal, so they stay
-- error-safe before this migration exists. Invoker rights: owner members only.
CREATE OR REPLACE FUNCTION swarm.permanence_grandfather_complete()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM swarm.renewal_grants g
      WHERE g.kind='timeboxed' AND g.revoked_at IS NULL AND g.connection_expired_at IS NULL
        AND (g.connection_expires_at IS NULL OR g.connection_expires_at > clock_timestamp())
        AND g.horizon_expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
          WHERE j.relation='swarm.renewal_grants' AND j.restored_at IS NULL
            AND j.row_key->>'renewal_grant_id'=g.renewal_grant_id::text))
    AND NOT EXISTS (SELECT 1 FROM swarm.hosted_mcp_grants g
      WHERE g.state='active' AND g.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.provider_grant_resources r WHERE r.hosted_grant_id=g.grant_id))
    AND NOT EXISTS (SELECT 1 FROM swarm.household_content_connections c
      WHERE c.hosted_grant_id IS NULL AND c.revoked_at IS NULL
        AND c.expires_at IS NOT NULL AND c.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
          WHERE j.relation='swarm.household_content_connections' AND j.restored_at IS NULL
            AND j.row_key->>'grant_id'=c.grant_id::text AND j.row_key->>'workspace_id'=c.workspace_id::text
            AND j.row_key->>'principal_id'=c.principal_id::text
            AND (j.row_key->>'connection_id'=c.connection_id::text OR j.previous->>'connection_id'=c.connection_id::text)))
$fn$;
CREATE OR REPLACE FUNCTION swarm.permanence_grandfather_restored()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  -- Every restorable entry is stamped and its target row exists exactly once
  -- with the recorded prior values; a missing target is a failed restore.
  SELECT NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
      WHERE j.action IN ('converted','bound') AND j.restored_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
      WHERE j.action='converted' AND NOT EXISTS (SELECT 1 FROM swarm.renewal_grants g
        WHERE g.renewal_grant_id=(j.row_key->>'renewal_grant_id')::uuid
          AND g.kind=j.previous->>'kind'
          AND g.horizon_expires_at IS NOT DISTINCT FROM (j.previous->>'horizon_expires_at')::timestamptz
          AND g.max_successors IS NOT DISTINCT FROM (j.previous->>'max_successors')::integer))
    AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
      WHERE j.action='bound' AND (SELECT count(*) FROM swarm.household_content_connections c
        WHERE c.connection_id=(j.previous->>'connection_id')::uuid AND c.grant_id=(j.row_key->>'grant_id')::uuid
          AND c.workspace_id=(j.row_key->>'workspace_id')::uuid AND c.principal_id=(j.row_key->>'principal_id')::uuid
          AND c.renewal_grant_id IS NULL
          AND c.expires_at IS NOT DISTINCT FROM (j.previous->>'expires_at')::timestamptz) <> 1)
$fn$;
DO $acl$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['swarm.permanence_grandfather_complete()','swarm.permanence_grandfather_restored()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO swarm_admin', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, swarm_read, swarm_command', f);
  END LOOP;
END $acl$;

-- The conversion carve-out and the approval guards key on the table owner.
SET LOCAL ROLE swarm_admin;

-- A. Time-boxed families with a future horizon become standing.
DO $convert$
DECLARE
  g record;
  converted integer := 0;
  skipped integer := 0;
BEGIN
  FOR g IN
    SELECT renewal_grant_id, kind, max_successors, horizon_expires_at
    FROM swarm.renewal_grants
    WHERE kind='timeboxed' AND revoked_at IS NULL AND connection_expired_at IS NULL
      AND (connection_expires_at IS NULL OR connection_expires_at > clock_timestamp())
      AND horizon_expires_at > clock_timestamp()
      -- Re-running after a restore reconsiders; an unrestored verdict stands.
      AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
        WHERE j.relation='swarm.renewal_grants' AND j.restored_at IS NULL
          AND j.row_key->>'renewal_grant_id'=renewal_grants.renewal_grant_id::text)
    ORDER BY renewal_grant_id
  LOOP
    -- The old edge keeps running during the window. Lock the row, then decide
    -- on a fresh clock so an elapsed horizon is never revived.
    PERFORM 1 FROM swarm.renewal_grants
      WHERE renewal_grant_id=g.renewal_grant_id AND kind='timeboxed' AND revoked_at IS NULL
        AND connection_expired_at IS NULL
        AND (connection_expires_at IS NULL OR connection_expires_at > clock_timestamp())
        AND horizon_expires_at > clock_timestamp()
      FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    BEGIN
      UPDATE swarm.renewal_grants
        SET kind='standing', max_successors=NULL, horizon_expires_at=NULL
        WHERE renewal_grant_id=g.renewal_grant_id;
      INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
        VALUES ('swarm.renewal_grants', jsonb_build_object('renewal_grant_id',g.renewal_grant_id), 'converted',
          jsonb_build_object('kind',g.kind,'max_successors',g.max_successors,'horizon_expires_at',g.horizon_expires_at));
      converted := converted+1;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      -- SWARM_RENEWAL_GRANT_IMMUTABLE: the carve-out's provenance checks refused
      -- this family. It keeps its horizon; the owner can issue a fresh Allow.
      -- SQLERRM here is the guard's fixed refusal code, never row data.
      INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
        VALUES ('swarm.renewal_grants', jsonb_build_object('renewal_grant_id',g.renewal_grant_id), 'skipped-provenance',
          jsonb_build_object('kind',g.kind,'max_successors',g.max_successors,'horizon_expires_at',g.horizon_expires_at,
            'refusal',left(SQLERRM,64)));
      skipped := skipped+1;
    END;
  END LOOP;
  RAISE NOTICE 'permanence grandfather A: % families converted, % skipped', converted, skipped;
END $convert$;

-- B. Hosted families without a resource binding get the backfill-shaped row.
DO $bindings$
DECLARE inserted integer;
BEGIN
  WITH added AS (
    INSERT INTO commonswarm_oauth.provider_grant_resources
      (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id,created_at)
    SELECT g.provider_grant_id,g.resource,'hosted_mcp',g.owner_user_id,g.client_id,g.grant_id,g.grant_id,g.created_at
    FROM swarm.hosted_mcp_grants g
    WHERE g.state='active' AND g.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
        WHERE r.provider_grant_id=g.provider_grant_id OR r.hosted_grant_id=g.grant_id)
    ORDER BY g.grant_id
    RETURNING hosted_grant_id
  )
  INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
    SELECT 'commonswarm_oauth.provider_grant_resources', jsonb_build_object('hosted_grant_id',hosted_grant_id), 'inserted', NULL
    FROM added;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE NOTICE 'permanence grandfather B: % hosted bindings inserted', inserted;
END $bindings$;

-- C. Live local approvals join their family and drop the technical expiry.
DO $approvals$
DECLARE
  c record;
  t record;
  live_token uuid;
  target uuid;
  key jsonb;
  prev jsonb;
  bound integer := 0;
  skipped integer := 0;
BEGIN
  FOR c IN
    SELECT connection_id, grant_id, workspace_id, principal_id, expires_at, renewal_grant_id
    FROM swarm.household_content_connections
    WHERE hosted_grant_id IS NULL AND revoked_at IS NULL
      AND expires_at IS NOT NULL AND expires_at > clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM swarm.permanence_grandfather_journal j
        WHERE j.relation='swarm.household_content_connections' AND j.restored_at IS NULL
          AND j.row_key->>'grant_id'=household_content_connections.grant_id::text
          AND j.row_key->>'workspace_id'=household_content_connections.workspace_id::text
          AND j.row_key->>'principal_id'=household_content_connections.principal_id::text
          AND (j.row_key->>'connection_id'=household_content_connections.connection_id::text
            OR j.previous->>'connection_id'=household_content_connections.connection_id::text))
    ORDER BY connection_id, grant_id, workspace_id, principal_id
  LOOP
    -- Lock the approval and decide on a fresh clock: a lapsed or withdrawn
    -- approval is never revived, whatever the selection snapshot saw.
    PERFORM 1 FROM swarm.household_content_connections
      WHERE connection_id=c.connection_id AND grant_id=c.grant_id
        AND workspace_id=c.workspace_id AND principal_id=c.principal_id
        AND hosted_grant_id IS NULL AND revoked_at IS NULL AND renewal_grant_id IS NULL
        AND expires_at IS NOT NULL AND expires_at > clock_timestamp()
      FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    key := jsonb_build_object('connection_id',c.connection_id,'grant_id',c.grant_id,
      'workspace_id',c.workspace_id,'principal_id',c.principal_id);
    prev := jsonb_build_object('connection_id',c.connection_id,'expires_at',c.expires_at,
      'renewal_grant_id',c.renewal_grant_id);
    SELECT token_id, renewal_grant_id, lineage_id, expires_at, revoked_at, surrender_only INTO t
      FROM swarm.agent_tokens WHERE token_id=c.connection_id;
    IF t.token_id IS NULL OR t.renewal_grant_id IS NULL OR c.renewal_grant_id IS NOT NULL THEN
      INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
        VALUES ('swarm.household_content_connections', key, 'skipped-binding', prev);
      skipped := skipped+1;
      CONTINUE;
    END IF;
    target := c.connection_id;
    IF t.revoked_at IS NOT NULL OR t.surrender_only OR t.expires_at <= clock_timestamp() THEN
      -- The approved bearer rotated. The approval belongs to the agent's family;
      -- re-key it to the family's live token of the same lineage.
      SELECT x.token_id INTO live_token FROM swarm.agent_tokens x
        WHERE x.lineage_id=t.lineage_id AND x.renewal_grant_id=t.renewal_grant_id
          AND x.principal_id=c.principal_id AND x.run_id=c.grant_id
          AND x.revoked_at IS NULL AND NOT x.surrender_only AND x.expires_at > clock_timestamp()
        ORDER BY x.expires_at DESC, x.token_id LIMIT 1;
      IF live_token IS NULL THEN
        INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
          VALUES ('swarm.household_content_connections', key, 'skipped-binding', prev);
        skipped := skipped+1;
        CONTINUE;
      END IF;
      target := live_token;
    END IF;
    BEGIN
      IF target <> c.connection_id THEN
        UPDATE swarm.household_content_connections SET connection_id=target
          WHERE connection_id=c.connection_id AND grant_id=c.grant_id
            AND workspace_id=c.workspace_id AND principal_id=c.principal_id;
      END IF;
      UPDATE swarm.household_content_connections
        SET renewal_grant_id=t.renewal_grant_id, expires_at=NULL
        WHERE connection_id=target AND grant_id=c.grant_id
          AND workspace_id=c.workspace_id AND principal_id=c.principal_id;
      INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
        VALUES ('swarm.household_content_connections', key || jsonb_build_object('connection_id',target), 'bound', prev);
      bound := bound+1;
    EXCEPTION WHEN SQLSTATE '23514' OR unique_violation THEN
      -- The family binding guard refused (expired or revoked token, ended run,
      -- suspended or revoked family, or an existing row for the live token).
      -- The subtransaction rolled the re-key back; the row is unchanged.
      -- SQLERRM is the guard's fixed refusal code, never row data.
      INSERT INTO swarm.permanence_grandfather_journal(relation,row_key,action,previous)
        VALUES ('swarm.household_content_connections', key, 'skipped-binding', prev || jsonb_build_object('refusal',left(SQLERRM,64)));
      skipped := skipped+1;
    END;
  END LOOP;
  RAISE NOTICE 'permanence grandfather C: % approvals bound, % skipped', bound, skipped;
END $approvals$;

RESET ROLE;
