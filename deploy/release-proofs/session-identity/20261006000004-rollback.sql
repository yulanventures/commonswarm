-- Data-free reserve only, in the operator-owned transaction.
SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
DO $reserve$
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts)
    OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_check_batches WHERE context_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM swarm.audit_log WHERE context_id IS NOT NULL OR context_details @? '$.**.context_id')
    OR EXISTS (SELECT 1 FROM swarm.idempotency_keys WHERE context_id IS NOT NULL OR response @? '$.**.context_id')
    OR EXISTS (SELECT 1 FROM swarm.events WHERE payload @? '$.**.context_id')
    OR EXISTS (SELECT 1 FROM swarm.household_object_events WHERE event @? '$.**.context_id')
    OR EXISTS (SELECT 1 FROM swarm.household_todo_events WHERE event @? '$.**.context_id')
    OR EXISTS (SELECT 1 FROM swarm.household_object_streams WHERE projection @? '$.**.context_id') THEN
    RAISE EXCEPTION 'reserve rollback refused: hosted context history' USING ERRCODE='55000';
  END IF;
END
$reserve$;
-- Complete source-built inverse at prerequisite 539b5e83279ec856ea78b56995e583c5291d6852.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='hosted-agent-context-expiry' AND database=current_database() AND username=current_user;

DROP TRIGGER hosted_household_event_context ON swarm.household_object_events;

DROP TRIGGER hosted_household_event_context ON swarm.household_todo_events;

DROP TRIGGER hosted_event_context ON swarm.events;

DROP TRIGGER hosted_outcome_context ON swarm.idempotency_keys;

DROP TRIGGER hosted_legacy_handle_guard ON swarm.hosted_mcp_seat_handles;

DROP TRIGGER hosted_context_guard ON swarm.hosted_agent_contexts;

DROP VIEW swarm_read.agent_principals;
CREATE OR REPLACE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  SELECT
    p.principal_id,
    p.workspace_id,
    p.owner_user_id,
    p.name,
    p.created_at,
    p.revoked_at,
    p.model,
    p.managed_at,
    p.transport,
    p.turn_only
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS c
      WHERE c.registrar_principal_id = p.principal_id
    );
ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_principals TO authenticated,swarm_read;
REVOKE ALL ON swarm_read.agent_principals FROM anon;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('ask', 'note', 'reply', 'working_on')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;
ALTER FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('whoami', 'members', 'check')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;
ALTER FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) TO swarm_read;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_check_authorization(
  p_grant_id uuid,
  p_handle text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT *
  FROM swarm.resolve_hosted_seat_read_authorization(p_grant_id, p_handle, 'check')
$fn$;
ALTER FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_cursors_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cursor_created_at IS NOT NULL OR NEW.cursor_signal_id IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR (OLD.cursor_created_at IS NOT NULL AND NEW.cursor_created_at IS NULL)
     OR (OLD.cursor_created_at IS NOT NULL AND
       (NEW.cursor_created_at, NEW.cursor_signal_id) <=
       (OLD.cursor_created_at, OLD.cursor_signal_id))
     OR (NEW.cursor_created_at IS NOT NULL AND NOT EXISTS (
       SELECT 1
       FROM swarm.hosted_mcp_check_batches AS b
       WHERE b.seat_id = NEW.seat_id
         AND b.grant_id = NEW.grant_id
         AND b.workspace_id = NEW.workspace_id
         AND b.principal_id = NEW.principal_id
         AND b.terminal_created_at = NEW.cursor_created_at
         AND b.terminal_signal_id = NEW.cursor_signal_id
         AND b.acknowledged_at IS NOT NULL
     ))
  THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;
ALTER FUNCTION swarm.hosted_mcp_check_cursors_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_cursors_guard() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(s.id ORDER BY date_trunc('milliseconds', s.created_at), s.id),
           max(date_trunc('milliseconds', s.created_at)) FILTER (
             WHERE s.id = NEW.terminal_signal_id
           )
    INTO v_ordered_ids, v_terminal_created_at
    FROM unnest(NEW.signal_ids) AS requested(signal_id)
    JOIN swarm.signals AS s ON s.id = requested.signal_id
    WHERE s.workspace_id = NEW.workspace_id
      AND (
        s.to_agent_principal_id = NEW.principal_id
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_recipients AS recipient
          WHERE recipient.workspace_id = s.workspace_id
            AND recipient.signal_id = s.id
            AND recipient.recipient_agent_principal_id = NEW.principal_id
        )
      );
    IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
       OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
       OR (SELECT count(DISTINCT signal_id)
           FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
          cardinality(NEW.signal_ids)
       OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
    THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
     OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
     OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.acknowledged_at IS NOT NULL
     OR NEW.acknowledged_at IS NULL
  THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;
ALTER FUNCTION swarm.hosted_mcp_check_batches_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_batches_guard() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(
  batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  deleted integer;
  retain_days integer;
  claim_days integer;
  claim_id_re text := '^claim_[0-9a-f]{32}_[0-9a-z]+$';
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
  END IF;
  retain_days := GREATEST(
    1,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'idempotency_retention_days'
      ),
      1
    )
  );
  claim_days := GREATEST(
    2,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'claim_idempotency_retention_days'
      ),
      2
    )
  );
  DELETE FROM swarm.idempotency_keys
  WHERE (principal_kind, principal_id, command_id) IN (
    SELECT principal_kind, principal_id, command_id
    FROM swarm.idempotency_keys
    WHERE (
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
ALTER FUNCTION swarm.purge_expired_idempotency_keys(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys(integer) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

DROP FUNCTION swarm.hosted_household_event_context();

DROP FUNCTION swarm.audit_hosted_authorization_denial(uuid, text, text);

DROP FUNCTION swarm.hosted_event_context();

DROP FUNCTION swarm.hosted_outcome_context();

DROP FUNCTION swarm.audit_hosted_context(uuid, uuid, text, text, text, text);

DROP FUNCTION swarm.hosted_context_guard();

DROP FUNCTION swarm.hosted_principal_context_summary(uuid);

DROP FUNCTION swarm.resolve_hosted_discovery(uuid, uuid);

DROP FUNCTION swarm.sweep_hosted_agent_contexts();

DROP FUNCTION swarm.expire_hosted_agent_contexts(integer);

DROP FUNCTION swarm.close_hosted_agent_context(uuid, text);

DROP FUNCTION swarm.record_hosted_context_activity(uuid);

DROP FUNCTION swarm.resolve_hosted_context(uuid, text, text, text);

DROP FUNCTION swarm.hosted_context_interval(text);

DROP FUNCTION swarm.hosted_legacy_handle_guard();

DROP INDEX swarm.hosted_mcp_check_batches_one_active;
DROP INDEX swarm.hosted_mcp_check_batches_legacy_active;
CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active ON swarm.hosted_mcp_check_batches(seat_id) WHERE acknowledged_at IS NULL;
COMMENT ON INDEX swarm.hosted_mcp_check_batches_one_active IS 'At most one unacknowledged hosted check batch per seat.';
DROP INDEX swarm.hosted_audit_context;
DROP INDEX swarm.hosted_outcomes_context;
ALTER TABLE swarm.audit_log DROP COLUMN context_id,DROP COLUMN context_details;
ALTER TABLE swarm.idempotency_keys DROP COLUMN context_id;
ALTER TABLE swarm.hosted_mcp_check_batches DROP CONSTRAINT hosted_batches_issued_grant,DROP CONSTRAINT hosted_batches_context,DROP CONSTRAINT hosted_batches_cancel,DROP CONSTRAINT hosted_batches_identity,DROP CONSTRAINT hosted_batches_cursor;
ALTER TABLE swarm.hosted_mcp_check_batches DROP COLUMN context_id,DROP COLUMN cancelled_at,DROP COLUMN cancel_reason;
ALTER TABLE swarm.hosted_agent_contexts DROP CONSTRAINT hosted_contexts_identity;
ALTER TABLE swarm.hosted_mcp_seat_handles DROP CONSTRAINT hosted_handles_identity,DROP CONSTRAINT hosted_handles_issued_grant;
ALTER TABLE swarm.hosted_mcp_check_cursors DROP CONSTRAINT hosted_cursors_identity,DROP CONSTRAINT hosted_cursors_issued_grant;
ALTER TABLE swarm.hosted_mcp_check_cursors DROP CONSTRAINT hosted_mcp_check_cursors_identity;
ALTER TABLE swarm.hosted_mcp_seats DROP CONSTRAINT hosted_mcp_seats_current_identity;
ALTER TABLE swarm.hosted_mcp_seat_handles ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_cursors ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_check_cursors(seat_id,grant_id,workspace_id,principal_id);
