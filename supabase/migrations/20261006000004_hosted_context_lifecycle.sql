-- Phase 3 lifecycle. Operator owns the transaction and ledger.
-- No backfill and no allocation activation in this migration.
SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
ALTER TABLE swarm.hosted_mcp_seats ADD CONSTRAINT hosted_mcp_seats_current_identity UNIQUE(seat_id, workspace_id, principal_id);
ALTER TABLE swarm.hosted_mcp_check_cursors ADD CONSTRAINT hosted_mcp_check_cursors_identity UNIQUE(seat_id, workspace_id, principal_id);
DO $legacy_fks$
DECLARE r record; n integer:=0;
BEGIN
  FOR r IN SELECT c.conrelid::regclass AS tab,c.conname FROM pg_catalog.pg_constraint c
    WHERE c.contype='f' AND cardinality(c.conkey)=4
      AND ((c.conrelid IN ('swarm.hosted_mcp_seat_handles'::regclass,'swarm.hosted_mcp_check_cursors'::regclass,'swarm.hosted_mcp_check_batches'::regclass) AND c.confrelid='swarm.hosted_mcp_seats'::regclass)
        OR (c.conrelid='swarm.hosted_mcp_check_batches'::regclass AND c.confrelid='swarm.hosted_mcp_check_cursors'::regclass))
  LOOP
    n:=n+1; EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tab,r.conname);
  END LOOP;
  IF n<>4 THEN RAISE EXCEPTION 'unexpected legacy identity FKs' USING ERRCODE='55000'; END IF;
END
$legacy_fks$;
ALTER TABLE swarm.hosted_mcp_seat_handles ADD CONSTRAINT hosted_handles_identity FOREIGN KEY(seat_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_cursors ADD CONSTRAINT hosted_cursors_identity FOREIGN KEY(seat_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD CONSTRAINT hosted_batches_identity FOREIGN KEY(seat_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD CONSTRAINT hosted_batches_cursor FOREIGN KEY(seat_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_check_cursors(seat_id,workspace_id,principal_id);
ALTER TABLE swarm.hosted_mcp_seat_handles ADD CONSTRAINT hosted_handles_issued_grant FOREIGN KEY(grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id);
ALTER TABLE swarm.hosted_mcp_check_cursors ADD CONSTRAINT hosted_cursors_issued_grant FOREIGN KEY(grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD CONSTRAINT hosted_batches_issued_grant FOREIGN KEY(grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id);
ALTER TABLE swarm.hosted_agent_contexts ADD CONSTRAINT hosted_contexts_identity UNIQUE(context_id,seat_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD COLUMN context_id uuid, ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancel_reason text;
ALTER TABLE swarm.hosted_mcp_check_batches ADD CONSTRAINT hosted_batches_context FOREIGN KEY(context_id,seat_id) REFERENCES swarm.hosted_agent_contexts(context_id,seat_id);
ALTER TABLE swarm.hosted_mcp_check_batches ADD CONSTRAINT hosted_batches_cancel CHECK((cancelled_at IS NULL AND cancel_reason IS NULL) OR (cancelled_at IS NOT NULL AND cancel_reason IN ('closed','expired') AND acknowledged_at IS NULL AND cancelled_at >= created_at));
DROP INDEX swarm.hosted_mcp_check_batches_one_active;
CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active ON swarm.hosted_mcp_check_batches(context_id) WHERE acknowledged_at IS NULL AND cancelled_at IS NULL AND context_id IS NOT NULL;
CREATE UNIQUE INDEX hosted_mcp_check_batches_legacy_active ON swarm.hosted_mcp_check_batches(seat_id) WHERE acknowledged_at IS NULL AND cancelled_at IS NULL AND context_id IS NULL;
ALTER TABLE swarm.audit_log ADD COLUMN context_id uuid REFERENCES swarm.hosted_agent_contexts(context_id), ADD COLUMN context_details jsonb;
ALTER TABLE swarm.idempotency_keys ADD COLUMN context_id uuid REFERENCES swarm.hosted_agent_contexts(context_id);
CREATE INDEX hosted_outcomes_context ON swarm.idempotency_keys(context_id) WHERE context_id IS NOT NULL;
CREATE INDEX hosted_audit_context ON swarm.audit_log(context_id,occurred_at) WHERE context_id IS NOT NULL;

CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_cursors_guard()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_INVALID' USING ERRCODE='23514'; END IF;
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
$sid$;

ALTER FUNCTION swarm.hosted_mcp_check_cursors_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_cursors_guard() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE='23514'; END IF;
    IF NEW.acknowledged_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
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
  IF OLD.context_id IS NULL AND NEW.context_id IS NOT NULL
    AND (to_jsonb(NEW)-'context_id')=(to_jsonb(OLD)-'context_id')
    AND EXISTS(SELECT 1 FROM swarm.hosted_agent_contexts c
      JOIN swarm.hosted_mcp_seat_handles h ON h.handle=c.handle AND h.seat_id=c.seat_id
      WHERE c.context_id=NEW.context_id AND c.origin='legacy' AND c.seat_id=OLD.seat_id
        AND h.grant_id=OLD.grant_id AND h.workspace_id=OLD.workspace_id AND h.principal_id=OLD.principal_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.context_id IS DISTINCT FROM OLD.context_id THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL
     AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NULL
     AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c
       WHERE c.context_id=NEW.context_id AND c.seat_id=NEW.seat_id
         AND c.closed_at=NEW.cancelled_at AND c.close_reason=NEW.cancel_reason)
     AND (to_jsonb(NEW)-ARRAY['cancelled_at','cancel_reason']) = (to_jsonb(OLD)-ARRAY['cancelled_at','cancel_reason']) THEN
    RETURN NEW;
  END IF;
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE='55000';
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
$sid$;

ALTER FUNCTION swarm.hosted_mcp_check_batches_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_batches_guard() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE OR REPLACE FUNCTION swarm.hosted_legacy_handle_guard()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION 'SWARM_HOSTED_HANDLE_INVALID' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_HOSTED_HANDLE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$sid$;

ALTER FUNCTION swarm.hosted_legacy_handle_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_legacy_handle_guard() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE TRIGGER hosted_legacy_handle_guard BEFORE INSERT OR UPDATE OR DELETE ON swarm.hosted_mcp_seat_handles FOR EACH ROW EXECUTE FUNCTION swarm.hosted_legacy_handle_guard();

CREATE OR REPLACE FUNCTION swarm.hosted_context_interval(p_kind text)
RETURNS interval
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT CASE p_kind WHEN 'chat' THEN interval '24 hours' WHEN 'task' THEN interval '12 hours' WHEN 'scheduled' THEN interval '30 minutes' WHEN 'subagent' THEN interval '15 minutes' END
$sid$;

ALTER FUNCTION swarm.hosted_context_interval(text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_context_interval(text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_context(p_grant_id uuid, p_handle text, p_tool text, p_use text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
DECLARE
  v_stream uuid;
  v_context uuid;
  v_now timestamptz;
  v_result jsonb;
BEGIN
  IF NOT ((p_use='command' AND p_tool IN ('ask','note','reply','working_on','check','close_session')) OR
          (p_use='read' AND p_tool IN ('whoami','members','check'))) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext('hosted-context-allocation'));
  SELECT st.stream_id,c.context_id INTO v_stream,v_context
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind='workspace'
    WHERE c.handle=p_handle AND hs.grant_id=p_grant_id;
  IF v_stream IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM swarm.streams WHERE stream_id=v_stream FOR UPDATE;
  PERFORM 1 FROM swarm.hosted_agent_contexts WHERE context_id=v_context FOR UPDATE;
  v_now := clock_timestamp();
  SELECT jsonb_build_object('grant_id',g.grant_id,'provider_grant_id',g.provider_grant_id,
    'client_id',g.client_id,'seat_id',hs.seat_id,'seat',c.handle,'handle',c.handle,
    'workspace_id',hs.workspace_id,'workspace',jsonb_build_object('id',w.workspace_id,'name',w.name),
    'stream_id',st.stream_id,'owner_user_id',g.owner_user_id,'principal_id',hs.principal_id,
    'context_id',c.context_id,'name',hs.name,'display_name',COALESCE(hs.display_name,hs.name),
    'disambiguator',hs.disambiguator,'lifetime',p.identity_lifetime,'kind',c.kind,'origin',c.origin,
    'assurance','portable','created_at',c.created_at,'last_business_at',c.last_business_at,
    'idle_expires_at',c.idle_expires_at,'absolute_expires_at',c.absolute_expires_at,
    'closed_at',c.closed_at,'close_reason',c.close_reason,'database_now',v_now,
    'context_error',CASE WHEN c.close_reason='expired' THEN 'context_expired' WHEN c.closed_at IS NOT NULL THEN 'context_closed'
      WHEN c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN 'context_expired' ELSE NULL END)
    INTO v_result
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=hs.grant_id
    JOIN swarm.hosted_mcp_grant_workspaces cw ON cw.grant_id=g.grant_id AND cw.workspace_id=hs.workspace_id
      AND cw.owner_user_id=g.owner_user_id AND cw.manifest_digest=g.manifest_digest AND cw.revoked_at IS NULL
    JOIN swarm.agent_principals p ON p.principal_id=hs.principal_id AND p.workspace_id=hs.workspace_id
      AND p.owner_user_id=hs.owner_user_id AND p.transport='hosted_mcp' AND p.turn_only
    JOIN swarm.workspaces w ON w.workspace_id=hs.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=hs.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    JOIN swarm.streams st ON st.stream_id=v_stream AND st.workspace_id=hs.workspace_id
    WHERE c.context_id=v_context AND c.handle=p_handle AND hs.grant_id=p_grant_id
      AND hs.owner_user_id=g.owner_user_id AND hs.workspace_id=ANY(g.selected_workspace_ids) AND g.state='active' AND g.revoked_at IS NULL
      AND (c.origin <> 'legacy' OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seat_handles h
        WHERE h.handle=c.handle AND h.seat_id=hs.seat_id AND h.workspace_id=hs.workspace_id
          AND h.principal_id=hs.principal_id AND h.revoked_at IS NULL))
      AND (hs.revoked_at IS NULL AND p.revoked_at IS NULL OR
        p.identity_lifetime='ephemeral' AND c.closed_at IS NOT NULL
        AND hs.revoked_at=c.closed_at AND p.revoked_at=c.closed_at)
      AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones t WHERE
        (t.kind='membership' AND t.target_id=g.owner_user_id) OR (t.kind='hosted_grant' AND t.target_id=g.grant_id)
        OR (t.kind='hosted_seat' AND t.target_id=hs.seat_id) OR (t.kind='principal' AND t.target_id=p.principal_id));
  RETURN v_result;
END
$sid$;

ALTER FUNCTION swarm.resolve_hosted_context(uuid, text, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_context(uuid, text, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_context(uuid, text, text, text) TO swarm_command, swarm_read;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(p_grant_id uuid, p_handle text, p_tool text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT (j->>'grant_id')::uuid,j->>'provider_grant_id',(j->>'seat_id')::uuid,j->>'handle',
      (j->>'workspace_id')::uuid,(j->>'stream_id')::uuid,(j->>'owner_user_id')::uuid,(j->>'principal_id')::uuid,j->>'name'
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,'command') AS j) context
    WHERE j IS NOT NULL AND j->>'context_error' IS NULL
$sid$;

ALTER FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(p_grant_id uuid, p_handle text, p_tool text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT (j->>'grant_id')::uuid,j->>'provider_grant_id',(j->>'seat_id')::uuid,j->>'handle',
      (j->>'workspace_id')::uuid,(j->>'stream_id')::uuid,(j->>'owner_user_id')::uuid,(j->>'principal_id')::uuid,j->>'name'
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,'read') AS j) context
    WHERE j IS NOT NULL AND j->>'context_error' IS NULL
$sid$;

ALTER FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) TO swarm_read;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_check_authorization(p_grant_id uuid, p_handle text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT (j->>'grant_id')::uuid,j->>'provider_grant_id',(j->>'seat_id')::uuid,j->>'handle',
      (j->>'workspace_id')::uuid,(j->>'stream_id')::uuid,(j->>'owner_user_id')::uuid,(j->>'principal_id')::uuid,j->>'name'
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,'check','command') AS j) context
    WHERE j IS NOT NULL AND j->>'context_error' IS NULL
$sid$;

ALTER FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.record_hosted_context_activity(p_context_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
DECLARE c swarm.hosted_agent_contexts; v_now timestamptz; hs swarm.hosted_mcp_seats; st swarm.streams;
BEGIN
  SELECT s.* INTO hs FROM swarm.hosted_mcp_seats s JOIN swarm.hosted_agent_contexts x USING(seat_id) WHERE x.context_id=p_context_id;
  SELECT * INTO st FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind='workspace' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF c.context_id IS NULL OR c.closed_at IS NOT NULL OR c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN
    RAISE EXCEPTION 'SWARM_CONTEXT_EXPIRED' USING ERRCODE='SC001';
  END IF;
  UPDATE swarm.hosted_agent_contexts SET last_business_at=v_now,
    idle_expires_at=CASE WHEN origin='legacy' THEN NULL ELSE v_now+swarm.hosted_context_interval(kind) END
    WHERE context_id=p_context_id RETURNING * INTO c;
  RETURN to_jsonb(c)-'handle';
END
$sid$;

ALTER FUNCTION swarm.record_hosted_context_activity(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.record_hosted_context_activity(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.record_hosted_context_activity(uuid) TO swarm_command, swarm_read;

CREATE OR REPLACE FUNCTION swarm.close_hosted_agent_context(p_context_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
DECLARE c swarm.hosted_agent_contexts; hs swarm.hosted_mcp_seats; p swarm.agent_principals;
  v_now timestamptz; v_stream swarm.streams; v_event uuid; v_command text;
BEGIN
  IF p_reason NOT IN ('closed','expired') THEN RAISE EXCEPTION 'invalid context close reason'; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext('hosted-context-allocation'));
  SELECT s.* INTO hs FROM swarm.hosted_agent_contexts x JOIN swarm.hosted_mcp_seats s USING(seat_id) WHERE x.context_id=p_context_id;
  IF hs.seat_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_stream FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind='workspace' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  SELECT * INTO hs FROM swarm.hosted_mcp_seats WHERE seat_id=c.seat_id FOR UPDATE;
  SELECT * INTO p FROM swarm.agent_principals WHERE principal_id=hs.principal_id FOR UPDATE;
  v_now:=date_trunc('milliseconds',clock_timestamp());
  IF c.closed_at IS NULL THEN
    IF p_reason='expired' AND (c.idle_expires_at IS NULL OR c.idle_expires_at>v_now)
      AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>v_now) THEN RETURN NULL; END IF;
    v_now:=GREATEST(v_now,c.created_at,date_trunc('milliseconds',v_now));
    UPDATE swarm.hosted_agent_contexts SET closed_at=v_now,close_reason=p_reason WHERE context_id=p_context_id;
    UPDATE swarm.hosted_mcp_check_batches SET cancelled_at=v_now,cancel_reason=p_reason
      WHERE context_id=p_context_id AND acknowledged_at IS NULL AND cancelled_at IS NULL;
    v_event:=gen_random_uuid(); v_command:='context_'||replace(p_context_id::text,'-','');
    IF p.identity_lifetime='ephemeral' THEN
      INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload)
      VALUES(hs.workspace_id,v_stream.stream_id,v_stream.head_seq+1,v_event,v_command,'HostedMcpSeatRevoked',1,hs.owner_user_id,hs.principal_id,NULL,v_now,
        jsonb_build_object('context_id',p_context_id,'seat_id',hs.seat_id,'principal_id',hs.principal_id,'grant_id',hs.grant_id,'revoked_at',extract(epoch FROM COALESCE(hs.revoked_at,v_now))*1000,'principal_revoked_at',extract(epoch FROM COALESCE(p.revoked_at,v_now))*1000));
      UPDATE swarm.streams SET head_seq=head_seq+1 WHERE stream_id=v_stream.stream_id;
    END IF;
    INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,'hosted_grant',hs.grant_id,'close_session',hs.workspace_id,v_stream.stream_id,'accepted',p_reason,p_context_id,
      jsonb_build_object('context_id',p_context_id,'grant_id',hs.grant_id,'client_id',g.client_id,'assurance','portable','lifetime',p.identity_lifetime,'kind',c.kind,'command_id',v_command)
      FROM swarm.hosted_mcp_grants g WHERE g.grant_id=hs.grant_id;
    c.closed_at:=v_now;
  END IF;
  RETURN jsonb_build_object('outcome','closed','context_id',p_context_id,'principal_state',CASE WHEN p.identity_lifetime='ephemeral' THEN 'retired' ELSE 'retained' END,'closed_at',c.closed_at);
END
$sid$;

ALTER FUNCTION swarm.close_hosted_agent_context(uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.close_hosted_agent_context(uuid, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.close_hosted_agent_context(uuid, text) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.expire_hosted_agent_contexts(p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
DECLARE v_count integer:=0; r record;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'expiry batch must be between 1 and 100'; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext('hosted-context-allocation'));
  IF NOT pg_try_advisory_xact_lock(1936142700,hashtext('hosted-context-expiry')) THEN RETURN 0; END IF;
  FOR r IN SELECT context_id FROM swarm.hosted_agent_contexts
    WHERE closed_at IS NULL AND (idle_expires_at<=clock_timestamp() OR absolute_expires_at<=clock_timestamp())
    ORDER BY LEAST(idle_expires_at,absolute_expires_at),context_id LIMIT p_limit
  LOOP
    IF swarm.close_hosted_agent_context(r.context_id,'expired') IS NOT NULL THEN v_count:=v_count+1; END IF;
  END LOOP;
  RETURN v_count;
END
$sid$;

ALTER FUNCTION swarm.expire_hosted_agent_contexts(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.expire_hosted_agent_contexts(integer) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE OR REPLACE FUNCTION swarm.sweep_hosted_agent_contexts()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
DECLARE v_count integer; v_batches integer:=0;
BEGIN
  LOOP
    v_count:=swarm.expire_hosted_agent_contexts(100); v_batches:=v_batches+1;
    EXIT WHEN v_count<100 OR v_batches>=10;
  END LOOP;
END
$sid$;

ALTER FUNCTION swarm.sweep_hosted_agent_contexts() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.sweep_hosted_agent_contexts() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

SELECT cron.schedule('hosted-agent-context-expiry','*/5 * * * *','SELECT swarm.sweep_hosted_agent_contexts()');

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_discovery(p_grant_id uuid, p_owner_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT jsonb_build_object('provider_grant_id',g.provider_grant_id,
  'grant',jsonb_build_object('id',g.grant_id,'owner_user_id',g.owner_user_id,'client_id',g.client_id,'home_workspace_id',g.home_workspace_id,'active',true),
  'subject',g.owner_user_id,'provider_active',true,'owner',jsonb_build_object('user_id',u.user_id,'display_name',u.display_name),
  'registered_app',CASE WHEN cache.client_id IS NULL THEN NULL ELSE jsonb_build_object('client_id',g.client_id,'display_name',COALESCE(cache.metadata->>'client_name','Agent'),'suggested_name',NULL) END,
  'workspaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.workspace_id,'name',w.name,'consented',true,'member',true,'live',true,'permitted',true) ORDER BY w.workspace_id)
    FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.workspaces w ON w.workspace_id=c.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=w.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    WHERE c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id AND c.manifest_digest=g.manifest_digest AND c.revoked_at IS NULL AND w.workspace_id=ANY(g.selected_workspace_ids)),'[]'::jsonb))
  FROM swarm.hosted_mcp_grants g JOIN swarm.users u ON u.user_id=g.owner_user_id
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE g.grant_id=p_grant_id AND g.owner_user_id=p_owner_user_id AND g.state='active' AND g.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE (t.kind='membership' AND t.target_id=g.owner_user_id) OR (t.kind='hosted_grant' AND t.target_id=g.grant_id))
$sid$;

ALTER FUNCTION swarm.resolve_hosted_discovery(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_discovery(uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_discovery(uuid, uuid) TO swarm_read, swarm_command;

CREATE OR REPLACE FUNCTION swarm.hosted_principal_context_summary(p_principal_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
SELECT jsonb_build_object('display_name',COALESCE(hs.display_name,p.name),'disambiguator',hs.disambiguator,
  'app',jsonb_build_object('client_id',g.client_id,'display_name',COALESCE(cache.metadata->>'client_name','Agent')),
  'last_business_at',(SELECT max(c.last_business_at) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id),
  'active_contexts',(SELECT count(*) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id AND c.closed_at IS NULL AND (c.idle_expires_at IS NULL OR c.idle_expires_at>statement_timestamp()) AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>statement_timestamp())))
  FROM swarm.agent_principals p JOIN swarm.hosted_mcp_seats hs USING(principal_id) JOIN swarm.hosted_mcp_grants g USING(grant_id)
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE p.principal_id=p_principal_id AND swarm.is_member(p.workspace_id,auth.uid())
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id)
$sid$;

ALTER FUNCTION swarm.hosted_principal_context_summary(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_principal_context_summary(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.hosted_principal_context_summary(uuid) TO authenticated, swarm_read;

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
    p.turn_only,
    p.identity_lifetime,
    COALESCE(swarm.hosted_principal_context_summary(p.principal_id)->>'display_name',p.name) AS display_name,
    swarm.hosted_principal_context_summary(p.principal_id)->>'disambiguator' AS disambiguator,
    swarm.hosted_principal_context_summary(p.principal_id)->'app' AS app,
    swarm.hosted_principal_context_summary(p.principal_id)-ARRAY['display_name','disambiguator','app'] AS context_activity
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS c
      WHERE c.registrar_principal_id = p.principal_id
    );

CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(batch_size integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
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
    FROM swarm.idempotency_keys k
    WHERE (k.context_id IS NULL AND ((
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
      )) OR (k.context_id IS NOT NULL AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c WHERE c.context_id=k.context_id AND c.closed_at IS NOT NULL AND c.closed_at < statement_timestamp()-interval '30 days'))
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$sid$;

ALTER FUNCTION swarm.purge_expired_idempotency_keys(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys(integer) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE OR REPLACE FUNCTION swarm.hosted_context_guard()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
BEGIN
  IF TG_OP='DELETE' OR OLD.closed_at IS NOT NULL
    OR (to_jsonb(NEW)-ARRAY['last_business_at','idle_expires_at','closed_at','close_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_business_at','idle_expires_at','closed_at','close_reason'])
    OR NEW.last_business_at<OLD.last_business_at
    OR (OLD.idle_expires_at IS NULL) IS DISTINCT FROM (NEW.idle_expires_at IS NULL)
    OR (NEW.idle_expires_at IS NOT NULL AND NEW.idle_expires_at<>NEW.last_business_at+swarm.hosted_context_interval(NEW.kind))
    OR (NEW.closed_at IS NOT NULL AND (NEW.last_business_at<>OLD.last_business_at OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at)) THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CONTEXT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$sid$;

ALTER FUNCTION swarm.hosted_context_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_context_guard() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE TRIGGER hosted_context_guard BEFORE UPDATE OR DELETE ON swarm.hosted_agent_contexts FOR EACH ROW EXECUTE FUNCTION swarm.hosted_context_guard();

CREATE OR REPLACE FUNCTION swarm.audit_hosted_context(p_context_id uuid, p_grant_id uuid, p_tool text, p_outcome text, p_reason text, p_request text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
BEGIN
  IF p_outcome NOT IN ('accepted','replayed','authz','domain','conflict') OR length(p_tool)>80
    OR (p_reason IS NOT NULL AND (p_reason !~ '^[a-z][a-z0-9_]{1,79}$' OR p_reason ~ '^seat_[A-Za-z0-9_-]{22,64}$'))
    OR (p_request IS NOT NULL AND p_request !~ '^[A-Za-z0-9_-]{8,72}$') THEN RAISE EXCEPTION 'invalid hosted audit metadata'; END IF;
  INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,'hosted_grant',g.grant_id,p_tool,hs.workspace_id,st.stream_id,p_outcome,
      p_reason,
      c.context_id,jsonb_build_object('context_id',c.context_id,'grant_id',g.grant_id,'client_id',g.client_id,'owner_user_id',hs.owner_user_id,'workspace_id',hs.workspace_id,'principal_id',hs.principal_id,'assurance','portable','lifetime',p.identity_lifetime,'kind',c.kind,'command_id',p_request,'created_at',c.created_at,'last_business_at',c.last_business_at,'idle_expires_at',c.idle_expires_at,'absolute_expires_at',c.absolute_expires_at)
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=p_grant_id AND g.owner_user_id=hs.owner_user_id
    JOIN swarm.agent_principals p USING(principal_id) JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind='workspace'
    WHERE c.context_id=p_context_id;
END
$sid$;

ALTER FUNCTION swarm.audit_hosted_context(uuid, uuid, text, text, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.audit_hosted_context(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.audit_hosted_context(uuid, uuid, text, text, text, text) TO swarm_command, swarm_read;

CREATE OR REPLACE FUNCTION swarm.hosted_outcome_context()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting('swarm.hosted_context_id',true),'')::uuid;
  IF TG_OP='UPDATE' AND NEW.context_id IS DISTINCT FROM OLD.context_id THEN RAISE EXCEPTION 'immutable outcome context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' AND v_context IS NOT NULL THEN NEW.context_id:=v_context; END IF;
  RETURN NEW;
END
$sid$;

ALTER FUNCTION swarm.hosted_outcome_context() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_outcome_context() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE TRIGGER hosted_outcome_context BEFORE INSERT OR UPDATE ON swarm.idempotency_keys FOR EACH ROW EXECUTE FUNCTION swarm.hosted_outcome_context();

-- Shared event projection for human revocation and context close/expiry.
-- The scheduler appends the same reducer-complete event as the command adapter;
-- projections derive only from that event and the prior terminal state.
CREATE OR REPLACE FUNCTION swarm.hosted_event_context()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
DECLARE v_context uuid; v_revoked timestamptz; v_principal_revoked timestamptz; v_seat swarm.hosted_mcp_seats;
BEGIN
  v_context:=NULLIF(current_setting('swarm.hosted_context_id',true),'')::uuid;
  IF v_context IS NOT NULL THEN NEW.payload:=NEW.payload||jsonb_build_object('context_id',v_context); END IF;
  IF NEW.type='HostedMcpSeatRevoked' THEN
    SELECT * INTO v_seat FROM swarm.hosted_mcp_seats
      WHERE seat_id=(NEW.payload->>'seat_id')::uuid AND workspace_id=NEW.workspace_id FOR UPDATE;
    IF v_seat.seat_id IS NULL OR v_seat.principal_id IS DISTINCT FROM (NEW.payload->>'principal_id')::uuid
      OR v_seat.grant_id IS DISTINCT FROM (NEW.payload->>'grant_id')::uuid
      OR jsonb_typeof(NEW.payload->'revoked_at') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid hosted retirement event' USING ERRCODE='23514';
    END IF;
    v_revoked:=to_timestamp((NEW.payload->>'revoked_at')::numeric/1000);
    v_principal_revoked:=to_timestamp(COALESCE(NEW.payload->>'principal_revoked_at',NEW.payload->>'revoked_at')::numeric/1000);
    UPDATE swarm.hosted_mcp_seats SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.agent_principals SET revoked_at=COALESCE(revoked_at,v_principal_revoked)
      WHERE principal_id=v_seat.principal_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END
$sid$;

ALTER FUNCTION swarm.hosted_event_context() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_event_context() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE TRIGGER hosted_event_context BEFORE INSERT ON swarm.events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_event_context();

CREATE OR REPLACE FUNCTION swarm.audit_hosted_authorization_denial(p_grant_id uuid, p_provider_id text, p_tool text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $sid$
BEGIN
  IF length(p_tool)>80 THEN RAISE EXCEPTION 'invalid hosted audit tool'; END IF;
  INSERT INTO swarm.audit_log(credential_kind,credential_id,command_kind,outcome,reason,context_details)
    SELECT 'hosted_grant',g.grant_id,p_tool,'authz','identity_resume_unavailable',
      jsonb_build_object('grant_id',g.grant_id,'owner_user_id',g.owner_user_id,'client_id',g.client_id,'tool',p_tool,'assurance','portable')
    FROM swarm.hosted_mcp_grants g WHERE g.grant_id=p_grant_id AND g.provider_grant_id=p_provider_id;
END
$sid$;

ALTER FUNCTION swarm.audit_hosted_authorization_denial(uuid, text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.audit_hosted_authorization_denial(uuid, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.audit_hosted_authorization_denial(uuid, text, text) TO swarm_command, swarm_read;

CREATE OR REPLACE FUNCTION swarm.hosted_household_event_context()
RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $sid$
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting('swarm.hosted_context_id',true),'')::uuid;
  IF v_context IS NOT NULL THEN NEW.event:=NEW.event||jsonb_build_object('context_id',v_context); END IF;
  RETURN NEW;
END
$sid$;

ALTER FUNCTION swarm.hosted_household_event_context() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_household_event_context() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;

CREATE TRIGGER hosted_household_event_context BEFORE INSERT ON swarm.household_object_events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_household_event_context();

CREATE TRIGGER hosted_household_event_context BEFORE INSERT ON swarm.household_todo_events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_household_event_context();

-- Canonical data-free reserve begins. Decode bare "--" as empty; otherwise strip exactly "-- ".
-- -- Data-free reserve only, in the operator-owned transaction.
-- SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'));
-- DO $reserve$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts)
--     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_check_batches WHERE context_id IS NOT NULL)
--     OR EXISTS (SELECT 1 FROM swarm.audit_log WHERE context_id IS NOT NULL OR context_details @? '$.**.context_id')
--     OR EXISTS (SELECT 1 FROM swarm.idempotency_keys WHERE context_id IS NOT NULL OR response @? '$.**.context_id')
--     OR EXISTS (SELECT 1 FROM swarm.events WHERE payload @? '$.**.context_id')
--     OR EXISTS (SELECT 1 FROM swarm.household_object_events WHERE event @? '$.**.context_id')
--     OR EXISTS (SELECT 1 FROM swarm.household_todo_events WHERE event @? '$.**.context_id')
--     OR EXISTS (SELECT 1 FROM swarm.household_object_streams WHERE projection @? '$.**.context_id') THEN
--     RAISE EXCEPTION 'reserve rollback refused: hosted context history' USING ERRCODE='55000';
--   END IF;
-- END
-- $reserve$;
-- -- Complete source-built inverse at prerequisite 539b5e83279ec856ea78b56995e583c5291d6852.
-- SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='hosted-agent-context-expiry' AND database=current_database() AND username=current_user;
--
-- DROP TRIGGER hosted_household_event_context ON swarm.household_object_events;
--
-- DROP TRIGGER hosted_household_event_context ON swarm.household_todo_events;
--
-- DROP TRIGGER hosted_event_context ON swarm.events;
--
-- DROP TRIGGER hosted_outcome_context ON swarm.idempotency_keys;
--
-- DROP TRIGGER hosted_legacy_handle_guard ON swarm.hosted_mcp_seat_handles;
--
-- DROP TRIGGER hosted_context_guard ON swarm.hosted_agent_contexts;
--
-- DROP VIEW swarm_read.agent_principals;
-- CREATE OR REPLACE VIEW swarm_read.agent_principals
-- WITH (security_barrier = true)
-- AS
--   SELECT
--     p.principal_id,
--     p.workspace_id,
--     p.owner_user_id,
--     p.name,
--     p.created_at,
--     p.revoked_at,
--     p.model,
--     p.managed_at,
--     p.transport,
--     p.turn_only
--   FROM swarm.agent_principals AS p
--   WHERE swarm.is_member(p.workspace_id, auth.uid())
--     AND NOT EXISTS (
--       SELECT 1
--       FROM swarm.agent_join_credentials AS c
--       WHERE c.registrar_principal_id = p.principal_id
--     );
-- ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
-- GRANT SELECT ON swarm_read.agent_principals TO authenticated,swarm_read;
-- REVOKE ALL ON swarm_read.agent_principals FROM anon;
--
-- CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(
--   p_grant_id uuid,
--   p_handle text,
--   p_tool text
-- )
-- RETURNS TABLE (
--   grant_id uuid,
--   provider_grant_id text,
--   seat_id uuid,
--   handle text,
--   workspace_id uuid,
--   stream_id uuid,
--   owner_user_id uuid,
--   principal_id uuid,
--   name text
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = swarm, pg_catalog
-- AS $fn$
--   SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
--          hs.workspace_id, st.stream_id, hs.owner_user_id,
--          hs.principal_id, hs.name
--   FROM swarm.hosted_mcp_grants AS g
--   JOIN swarm.hosted_mcp_grant_workspaces AS c
--     ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
--   JOIN swarm.hosted_mcp_seats AS hs
--     ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
--    AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
--   JOIN swarm.hosted_mcp_seat_handles AS h
--     ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
--    AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
--    AND h.revoked_at IS NULL
--   JOIN swarm.agent_principals AS p
--     ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
--    AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
--    AND p.transport = 'hosted_mcp' AND p.turn_only = true
--   JOIN swarm.workspaces AS w
--     ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
--   JOIN swarm.memberships AS m
--     ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
--    AND m.revoked_at IS NULL
--   JOIN swarm.streams AS st
--     ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
--   WHERE p_tool IN ('ask', 'note', 'reply', 'working_on')
--     AND g.grant_id = p_grant_id AND h.handle = p_handle
--     AND g.state = 'active' AND g.revoked_at IS NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM swarm.revocation_tombstones AS t
--       WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
--          OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
--          OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
--          OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
--     )
-- $fn$;
-- ALTER FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
-- GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_command_authorization(uuid, text, text) TO swarm_command;
--
-- CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(
--   p_grant_id uuid,
--   p_handle text,
--   p_tool text
-- )
-- RETURNS TABLE (
--   grant_id uuid,
--   provider_grant_id text,
--   seat_id uuid,
--   handle text,
--   workspace_id uuid,
--   stream_id uuid,
--   owner_user_id uuid,
--   principal_id uuid,
--   name text
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = swarm, pg_catalog
-- AS $fn$
--   SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
--          hs.workspace_id, st.stream_id, hs.owner_user_id,
--          hs.principal_id, hs.name
--   FROM swarm.hosted_mcp_grants AS g
--   JOIN swarm.hosted_mcp_grant_workspaces AS c
--     ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
--   JOIN swarm.hosted_mcp_seats AS hs
--     ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
--    AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
--   JOIN swarm.hosted_mcp_seat_handles AS h
--     ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
--    AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
--    AND h.revoked_at IS NULL
--   JOIN swarm.agent_principals AS p
--     ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
--    AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
--    AND p.transport = 'hosted_mcp' AND p.turn_only = true
--   JOIN swarm.workspaces AS w
--     ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
--   JOIN swarm.memberships AS m
--     ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
--    AND m.revoked_at IS NULL
--   JOIN swarm.streams AS st
--     ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
--   WHERE p_tool IN ('whoami', 'members', 'check')
--     AND g.grant_id = p_grant_id AND h.handle = p_handle
--     AND g.state = 'active' AND g.revoked_at IS NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM swarm.revocation_tombstones AS t
--       WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
--          OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
--          OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
--          OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
--     )
-- $fn$;
-- ALTER FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
-- GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_seat_read_authorization(uuid, text, text) TO swarm_read;
--
-- CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_check_authorization(
--   p_grant_id uuid,
--   p_handle text
-- )
-- RETURNS TABLE (
--   grant_id uuid,
--   provider_grant_id text,
--   seat_id uuid,
--   handle text,
--   workspace_id uuid,
--   stream_id uuid,
--   owner_user_id uuid,
--   principal_id uuid,
--   name text
-- )
-- LANGUAGE sql
-- STABLE
-- SECURITY DEFINER
-- SET search_path = swarm, pg_catalog
-- AS $fn$
--   SELECT *
--   FROM swarm.resolve_hosted_seat_read_authorization(p_grant_id, p_handle, 'check')
-- $fn$;
-- ALTER FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
-- GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) TO swarm_command;
--
-- CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_cursors_guard()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- SET search_path = pg_catalog
-- AS $fn$
-- BEGIN
--   IF TG_OP = 'DELETE' THEN
--     RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
--   END IF;
--   IF TG_OP = 'INSERT' THEN
--     IF NEW.cursor_created_at IS NOT NULL OR NEW.cursor_signal_id IS NOT NULL THEN
--       RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_INVALID' USING ERRCODE = '23514';
--     END IF;
--     RETURN NEW;
--   END IF;
--   IF NEW.seat_id IS DISTINCT FROM OLD.seat_id
--      OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
--      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
--      OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
--      OR (OLD.cursor_created_at IS NOT NULL AND NEW.cursor_created_at IS NULL)
--      OR (OLD.cursor_created_at IS NOT NULL AND
--        (NEW.cursor_created_at, NEW.cursor_signal_id) <=
--        (OLD.cursor_created_at, OLD.cursor_signal_id))
--      OR (NEW.cursor_created_at IS NOT NULL AND NOT EXISTS (
--        SELECT 1
--        FROM swarm.hosted_mcp_check_batches AS b
--        WHERE b.seat_id = NEW.seat_id
--          AND b.grant_id = NEW.grant_id
--          AND b.workspace_id = NEW.workspace_id
--          AND b.principal_id = NEW.principal_id
--          AND b.terminal_created_at = NEW.cursor_created_at
--          AND b.terminal_signal_id = NEW.cursor_signal_id
--          AND b.acknowledged_at IS NOT NULL
--      ))
--   THEN
--     RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
--   END IF;
--   RETURN NEW;
-- END
-- $fn$;
-- ALTER FUNCTION swarm.hosted_mcp_check_cursors_guard() OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_cursors_guard() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
--
-- CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- SET search_path = pg_catalog
-- AS $fn$
-- DECLARE
--   v_ordered_ids uuid[];
--   v_terminal_created_at timestamptz;
-- BEGIN
--   IF TG_OP = 'DELETE' THEN
--     RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
--   END IF;
--   IF TG_OP = 'INSERT' THEN
--     IF NEW.acknowledged_at IS NOT NULL THEN
--       RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
--     END IF;
--     SELECT array_agg(s.id ORDER BY date_trunc('milliseconds', s.created_at), s.id),
--            max(date_trunc('milliseconds', s.created_at)) FILTER (
--              WHERE s.id = NEW.terminal_signal_id
--            )
--     INTO v_ordered_ids, v_terminal_created_at
--     FROM unnest(NEW.signal_ids) AS requested(signal_id)
--     JOIN swarm.signals AS s ON s.id = requested.signal_id
--     WHERE s.workspace_id = NEW.workspace_id
--       AND (
--         s.to_agent_principal_id = NEW.principal_id
--         OR EXISTS (
--           SELECT 1
--           FROM swarm.signal_recipients AS recipient
--           WHERE recipient.workspace_id = s.workspace_id
--             AND recipient.signal_id = s.id
--             AND recipient.recipient_agent_principal_id = NEW.principal_id
--         )
--       );
--     IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
--        OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
--        OR (SELECT count(DISTINCT signal_id)
--            FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
--           cardinality(NEW.signal_ids)
--        OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
--     THEN
--       RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
--     END IF;
--     RETURN NEW;
--   END IF;
--   IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
--      OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
--      OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
--      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
--      OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
--      OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
--      OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
--      OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
--      OR NEW.created_at IS DISTINCT FROM OLD.created_at
--      OR OLD.acknowledged_at IS NOT NULL
--      OR NEW.acknowledged_at IS NULL
--   THEN
--     RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
--   END IF;
--   RETURN NEW;
-- END
-- $fn$;
-- ALTER FUNCTION swarm.hosted_mcp_check_batches_guard() OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_batches_guard() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
--
-- CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(
--   batch_size integer
-- )
-- RETURNS integer
-- LANGUAGE plpgsql
-- VOLATILE
-- SECURITY DEFINER
-- SET search_path = swarm, pg_catalog
-- AS $$
-- DECLARE
--   deleted integer;
--   retain_days integer;
--   claim_days integer;
--   claim_id_re text := '^claim_[0-9a-f]{32}_[0-9a-z]+$';
-- BEGIN
--   IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
--     RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
--   END IF;
--   retain_days := GREATEST(
--     1,
--     COALESCE(
--       (
--         SELECT (value #>> '{}')::integer
--         FROM swarm.config
--         WHERE key = 'idempotency_retention_days'
--       ),
--       1
--     )
--   );
--   claim_days := GREATEST(
--     2,
--     COALESCE(
--       (
--         SELECT (value #>> '{}')::integer
--         FROM swarm.config
--         WHERE key = 'claim_idempotency_retention_days'
--       ),
--       2
--     )
--   );
--   DELETE FROM swarm.idempotency_keys
--   WHERE (principal_kind, principal_id, command_id) IN (
--     SELECT principal_kind, principal_id, command_id
--     FROM swarm.idempotency_keys
--     WHERE (
--         command_id ~ claim_id_re
--         AND created_at < statement_timestamp() - make_interval(days => claim_days)
--       )
--       OR (
--         command_id !~ claim_id_re
--         AND created_at < statement_timestamp() - make_interval(days => retain_days)
--       )
--     ORDER BY created_at, principal_kind, principal_id, command_id
--     LIMIT batch_size
--   );
--   GET DIAGNOSTICS deleted = ROW_COUNT;
--   RETURN deleted;
-- END;
-- $$;
-- ALTER FUNCTION swarm.purge_expired_idempotency_keys(integer) OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys(integer) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
--
-- DROP FUNCTION swarm.hosted_household_event_context();
--
-- DROP FUNCTION swarm.audit_hosted_authorization_denial(uuid, text, text);
--
-- DROP FUNCTION swarm.hosted_event_context();
--
-- DROP FUNCTION swarm.hosted_outcome_context();
--
-- DROP FUNCTION swarm.audit_hosted_context(uuid, uuid, text, text, text, text);
--
-- DROP FUNCTION swarm.hosted_context_guard();
--
-- DROP FUNCTION swarm.hosted_principal_context_summary(uuid);
--
-- DROP FUNCTION swarm.resolve_hosted_discovery(uuid, uuid);
--
-- DROP FUNCTION swarm.sweep_hosted_agent_contexts();
--
-- DROP FUNCTION swarm.expire_hosted_agent_contexts(integer);
--
-- DROP FUNCTION swarm.close_hosted_agent_context(uuid, text);
--
-- DROP FUNCTION swarm.record_hosted_context_activity(uuid);
--
-- DROP FUNCTION swarm.resolve_hosted_context(uuid, text, text, text);
--
-- DROP FUNCTION swarm.hosted_context_interval(text);
--
-- DROP FUNCTION swarm.hosted_legacy_handle_guard();
--
-- DROP INDEX swarm.hosted_mcp_check_batches_one_active;
-- DROP INDEX swarm.hosted_mcp_check_batches_legacy_active;
-- CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active ON swarm.hosted_mcp_check_batches(seat_id) WHERE acknowledged_at IS NULL;
-- COMMENT ON INDEX swarm.hosted_mcp_check_batches_one_active IS 'At most one unacknowledged hosted check batch per seat.';
-- DROP INDEX swarm.hosted_audit_context;
-- DROP INDEX swarm.hosted_outcomes_context;
-- ALTER TABLE swarm.audit_log DROP COLUMN context_id,DROP COLUMN context_details;
-- ALTER TABLE swarm.idempotency_keys DROP COLUMN context_id;
-- ALTER TABLE swarm.hosted_mcp_check_batches DROP CONSTRAINT hosted_batches_issued_grant,DROP CONSTRAINT hosted_batches_context,DROP CONSTRAINT hosted_batches_cancel,DROP CONSTRAINT hosted_batches_identity,DROP CONSTRAINT hosted_batches_cursor;
-- ALTER TABLE swarm.hosted_mcp_check_batches DROP COLUMN context_id,DROP COLUMN cancelled_at,DROP COLUMN cancel_reason;
-- ALTER TABLE swarm.hosted_agent_contexts DROP CONSTRAINT hosted_contexts_identity;
-- ALTER TABLE swarm.hosted_mcp_seat_handles DROP CONSTRAINT hosted_handles_identity,DROP CONSTRAINT hosted_handles_issued_grant;
-- ALTER TABLE swarm.hosted_mcp_check_cursors DROP CONSTRAINT hosted_cursors_identity,DROP CONSTRAINT hosted_cursors_issued_grant;
-- ALTER TABLE swarm.hosted_mcp_check_cursors DROP CONSTRAINT hosted_mcp_check_cursors_identity;
-- ALTER TABLE swarm.hosted_mcp_seats DROP CONSTRAINT hosted_mcp_seats_current_identity;
-- ALTER TABLE swarm.hosted_mcp_seat_handles ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
-- ALTER TABLE swarm.hosted_mcp_check_cursors ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
-- ALTER TABLE swarm.hosted_mcp_check_batches ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id);
-- ALTER TABLE swarm.hosted_mcp_check_batches ADD FOREIGN KEY(seat_id,grant_id,workspace_id,principal_id) REFERENCES swarm.hosted_mcp_check_cursors(seat_id,grant_id,workspace_id,principal_id);
-- Canonical data-free reserve ends.
