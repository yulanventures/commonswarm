-- Synthetic, rollback-only functional rehearsal. No customer rows or content.
-- Every assertion runs in a subtransaction that is rolled back at the end.
-- Migration-time completeness: every issued handle retains its original clock
-- and null deadlines. Revoked handles remain revoked in their original ledger.
DO $legacy_backfill$
BEGIN
  IF EXISTS(SELECT 1 FROM swarm.hosted_mcp_seat_handles h
    LEFT JOIN swarm.hosted_agent_contexts c ON c.handle=h.handle AND c.seat_id=h.seat_id
    WHERE c.context_id IS NULL OR c.origin<>'legacy' OR c.kind<>'chat'
      OR c.created_at<>h.created_at OR c.last_business_at<h.created_at
      OR c.idle_expires_at IS NOT NULL OR c.absolute_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'sid7-functional-legacy-handle-missing-durable-context' USING ERRCODE='23514';
  END IF;
END
$legacy_backfill$;
DO $functional$
DECLARE
  u uuid:=gen_random_uuid(); w uuid:=gen_random_uuid(); st uuid:=gen_random_uuid(); g uuid:=gen_random_uuid();
  principal uuid:=gen_random_uuid(); seat uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  ephemeral_principal uuid:=gen_random_uuid(); ephemeral_seat uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
  todo uuid:=gen_random_uuid(); v_closed jsonb; v_identity jsonb; v_before timestamptz;
  v_at timestamptz:=date_trunc('milliseconds',clock_timestamp()); n integer;
  v_reserve text:=$reserve_sql$
-- Reserve in the operator-owned transaction; open legacy backfill is derived state.
SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
-- Keep the admission facts and history stable until the inverse completes.
LOCK TABLE swarm.hosted_agent_contexts, swarm.hosted_mcp_seat_handles,
  swarm.hosted_mcp_seats, swarm.hosted_mcp_check_batches, swarm.audit_log,
  swarm.idempotency_keys, swarm.events, swarm.household_object_events,
  swarm.household_todo_events, swarm.household_object_streams IN SHARE ROW EXCLUSIVE MODE;
DO $reserve$
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts
    WHERE origin<>'legacy' OR parent_context IS NOT NULL) THEN
    RAISE EXCEPTION 'reserve rollback refused: hosted context identity' USING ERRCODE='55000';
  END IF;
  -- A deadline is terminal before the sweep too. Seat or handle revocation survives
  -- the inverse; context closure/deadlines alone do not survive the old resolver.
  IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c
    JOIN swarm.hosted_mcp_seat_handles h ON h.handle=c.handle AND h.seat_id=c.seat_id
    JOIN swarm.hosted_mcp_seats s ON s.seat_id=c.seat_id
    WHERE (c.closed_at IS NOT NULL OR c.idle_expires_at<=clock_timestamp()
      OR c.absolute_expires_at<=clock_timestamp())
      AND h.revoked_at IS NULL AND s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'reserve rollback refused: hosted context access would reopen' USING ERRCODE='55000';
  END IF;
  -- Only open, parentless legacy rows backed by the original handle are derived.
  -- Closed rows remain history even when another revocation already denies access.
  IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c WHERE c.closed_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM swarm.hosted_mcp_seat_handles h
        WHERE h.handle=c.handle AND h.seat_id=c.seat_id))
    OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_check_batches
      WHERE context_id IS NOT NULL OR cancelled_at IS NOT NULL OR cancel_reason IS NOT NULL)
    OR EXISTS (SELECT 1 FROM swarm.audit_log WHERE context_id IS NOT NULL OR context_details IS NOT NULL)
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
DO $unschedule$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
      WHERE jobname='hosted-agent-context-expiry' AND database=current_database() AND username=current_user;
  END IF;
END
$unschedule$;

DROP TRIGGER hosted_household_event_context ON swarm.household_object_events;

DROP TRIGGER hosted_household_event_context ON swarm.household_todo_events;

DROP TRIGGER hosted_event_context ON swarm.events;

DROP TRIGGER hosted_outcome_context ON swarm.idempotency_keys;

DROP TRIGGER hosted_legacy_handle_guard ON swarm.hosted_mcp_seat_handles;

DROP TRIGGER hosted_context_guard ON swarm.hosted_agent_contexts;

-- The reserve has proved these open legacy rows are derived from the handle ledger.
DELETE FROM swarm.hosted_agent_contexts;

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
$reserve_sql$;
BEGIN
  BEGIN
    IF swarm.hosted_context_interval('chat')<>interval '24 hours' OR swarm.hosted_context_interval('task')<>interval '12 hours'
      OR swarm.hosted_context_interval('scheduled')<>interval '30 minutes' OR swarm.hosted_context_interval('subagent')<>interval '15 minutes' THEN
      RAISE EXCEPTION 'sid7-functional-functional-ttl-clocks-changed';
    END IF;
    INSERT INTO auth.users(id,aud,role,email) VALUES(u,'authenticated','authenticated',u::text||'@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES(u,'Lifecycle proof');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(w,'Lifecycle proof',u);
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(w,u,'owner');
    INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(st,w,'workspace');
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES(g,'functional-'||g,u,w,'functional-registered-client','https://mcp.commonswarm.com/mcp',ARRAY[w],decode(repeat('00',32),'hex'),'functional-proof','active',v_at,v_at);
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(g,w,u,decode(repeat('00',32),'hex'),gen_random_uuid(),v_at);
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only,identity_lifetime,created_at)
      VALUES(principal,w,u,'Lifecycle durable','hosted_mcp',true,'durable',v_at),
        (ephemeral_principal,w,u,'Lifecycle temporary-ABCD','hosted_mcp',true,'ephemeral',v_at);
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES(seat,g,w,u,principal,'Lifecycle durable',v_at),(ephemeral_seat,g,w,u,ephemeral_principal,'Lifecycle temporary-ABCD',v_at);
    INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
      VALUES(a,'seat_'||replace(a::text,'-',''),seat,'chat',v_at,v_at,v_at+interval '24 hours',v_at+interval '30 days','new'),
        (b,'seat_'||replace(b::text,'-',''),seat,'chat',v_at,v_at,v_at+interval '24 hours',v_at+interval '30 days','continue'),
        (e,'seat_'||replace(e::text,'-',''),ephemeral_seat,'chat',v_at-interval '3 days',v_at-interval '3 days',v_at-interval '2 days',v_at+interval '27 days','new');
    INSERT INTO swarm.household_todos(workspace_id,todo_id,version,title,state,created_by_user,created_at,assignee_principal,assigned_by_user,assigned_at,state_by_user,state_at,last_seq)
      VALUES(w,todo,1,'Synthetic retained assignment','open',u,v_at,ephemeral_principal,u,v_at,u,v_at,0);
    v_identity:=swarm.resolve_hosted_context(g,'seat_'||replace(a::text,'-',''),'whoami','read');
    IF v_identity IS NULL OR v_identity->>'context_error' IS NOT NULL THEN RAISE EXCEPTION 'sid7-functional-own-live-context-positive-control'; END IF;
    SELECT last_business_at INTO v_before FROM swarm.hosted_agent_contexts WHERE context_id=a;
    PERFORM swarm.resolve_hosted_context(g,'seat_'||replace(a::text,'-',''),'members','read');
    IF (SELECT last_business_at FROM swarm.hosted_agent_contexts WHERE context_id=a)<>v_before THEN RAISE EXCEPTION 'sid7-functional-read-only-members-renewed'; END IF;
    PERFORM swarm.record_hosted_context_activity(a);
    IF (SELECT idle_expires_at<>last_business_at+interval '24 hours' OR absolute_expires_at<>v_at+interval '30 days' FROM swarm.hosted_agent_contexts WHERE context_id=a) THEN RAISE EXCEPTION 'sid7-functional-activity-clocks-changed'; END IF;
    v_identity:=swarm.resolve_hosted_context(g,'seat_'||replace(e::text,'-',''),'whoami','read');
    IF v_identity->>'context_error'<>'context_expired' THEN RAISE EXCEPTION 'sid7-functional-stopped-sweep-prolonged-access'; END IF;
    BEGIN
      PERFORM swarm.record_hosted_context_activity(e);
      RAISE EXCEPTION 'sid7-functional-expired-activity-admitted' USING ERRCODE='ZX001';
    EXCEPTION WHEN SQLSTATE 'SC001' THEN NULL; END;
    INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response,created_at,context_id)
      VALUES('hosted_grant',g::text,'old_active_outcome',w,st,repeat('0',64),'{}',v_at-interval '40 days',a),
        ('hosted_grant',g::text,'old_expired_outcome',w,st,repeat('0',64),'{}',v_at-interval '40 days',e);
    PERFORM swarm.purge_expired_idempotency_keys(100);
    IF (SELECT count(*) FROM swarm.idempotency_keys WHERE context_id IN (a,e))<>2 THEN RAISE EXCEPTION 'sid7-functional-active-unswept-outcomes-purged'; END IF;
    n:=swarm.expire_hosted_agent_contexts(100);
    IF n<>1 OR (SELECT revoked_at IS NULL FROM swarm.agent_principals WHERE principal_id=ephemeral_principal) THEN RAISE EXCEPTION 'sid7-functional-expiry-failed-retirement'; END IF;
    IF NOT EXISTS(SELECT 1 FROM swarm.household_todos WHERE todo_id=todo AND assignee_principal=ephemeral_principal AND state='open') THEN RAISE EXCEPTION 'sid7-functional-retained-assignment-changed'; END IF;
    IF NOT EXISTS(SELECT 1 FROM swarm.events WHERE workspace_id=w AND type='HostedMcpSeatRevoked' AND payload->>'context_id'=e::text) THEN RAISE EXCEPTION 'sid7-functional-retirement-event-missing'; END IF;
    PERFORM swarm.purge_expired_idempotency_keys(100);
    IF NOT EXISTS(SELECT 1 FROM swarm.idempotency_keys WHERE context_id=e) THEN RAISE EXCEPTION 'sid7-functional-outcome-not-retained-30-days-after-closure'; END IF;
    v_closed:=swarm.close_hosted_agent_context(a,'closed');
    IF v_closed->>'principal_state'<>'retained' THEN RAISE EXCEPTION 'sid7-functional-durable-principal-retired'; END IF;
    IF swarm.close_hosted_agent_context(a,'closed')->>'closed_at'<>v_closed->>'closed_at' THEN RAISE EXCEPTION 'sid7-functional-close-time-changed'; END IF;
    IF swarm.resolve_hosted_context(g,'seat_'||replace(b::text,'-',''),'whoami','read')->>'context_error' IS NOT NULL THEN RAISE EXCEPTION 'sid7-functional-a-close-cancelled-b'; END IF;
    IF (SELECT count(*) FROM swarm.hosted_agent_contexts WHERE seat_id=seat AND closed_at IS NULL)<>1
      OR (SELECT count(*) FROM swarm.hosted_agent_contexts WHERE seat_id=seat AND created_at>v_at-interval '24 hours')<>2 THEN RAISE EXCEPTION 'sid7-functional-active-release-changed-rolling-creation-budget'; END IF;
    BEGIN
      EXECUTE v_reserve;
      RAISE EXCEPTION 'sid7-functional-occupied-reserve-admitted' USING ERRCODE='ZX001';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_agent_contexts WHERE context_id=a)
      OR to_regprocedure('swarm.sweep_hosted_agent_contexts()') IS NULL THEN RAISE EXCEPTION 'sid7-functional-refused-reserve-changed-data-or-catalog'; END IF;
    RAISE EXCEPTION 'sid7-functional-functional-fixture-rollback' USING ERRCODE='ZP003';
  EXCEPTION WHEN SQLSTATE 'ZP003' THEN NULL;
  END;
END
$functional$;
