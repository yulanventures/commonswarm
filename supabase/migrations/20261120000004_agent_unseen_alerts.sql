-- C1a: agent_unseen alerts — an ask, mention, or to-do notice that has not been shown to
-- the target seat after N minutes (including messages acknowledged only as 'queued') raises
-- one deduplicated alert per seat visible to both the live lead and the sender, and clears
-- automatically when the seat views its unseen messages.
--
-- Security & lock-order invariants (matching 20261119000001_lead_system_alerts.sql):
--   1. One open agent_unseen alert per (workspace_id, affected_principal_id), enforced by
--      partial unique index system_alerts_agent_unseen_open_seat_unique.
--   2. Scoped visibility: lead, owner/admin, and sender reads independently verify live
--      workspace membership, non-revocation, and channel scope access when channel_id IS NOT NULL.
--      Message bodies and titles are never copied into system_alerts.
--   3. Sync batch follows Level 1 (conversations FOR SHARE in workspace_id, conversation_id ASC)
--      -> Level 2 (conversation-frames advisory lock shared) -> Level 3 (system_alert key lock
--      -> system_alerts FOR UPDATE).
--   4. Immediate auto-clear triggers on signal_deliveries / signal_agent_receipts use
--      FOR UPDATE SKIP LOCKED on swarm.system_alerts only (zero parent or conversation locks,
--      eliminating any possibility of deadlock with served writers); the 2-minute sync catches
--      any row skipped under contention.

SET search_path = swarm, pg_catalog, public;

-- 1. Extend swarm.system_alerts for agent_unseen and optional sender routing metadata.
ALTER TABLE swarm.system_alerts
  ADD COLUMN IF NOT EXISTS sender_kind text,
  ADD COLUMN IF NOT EXISTS sender_id uuid;

DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname, pg_catalog.pg_get_constraintdef(oid) AS def
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'swarm.system_alerts'::regclass
      AND contype = 'c'
  LOOP
    IF v_con.def LIKE '%agent_quiet%' THEN
      EXECUTE format('ALTER TABLE swarm.system_alerts DROP CONSTRAINT %I', v_con.conname);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE swarm.system_alerts
  ADD CONSTRAINT system_alerts_kind_check CHECK (
    kind IN (
      'agent_quiet',
      'agent_unseen',
      'local_renewal_superseded',
      'local_credential_revoked',
      'hosted_seat_refused',
      'hosted_family_retired'
    )
  ),
  ADD CONSTRAINT system_alerts_waiting_fields_check CHECK (
    (kind IN ('agent_quiet', 'agent_unseen')) = (waiting_count IS NOT NULL AND oldest_waiting_at IS NOT NULL)
  ),
  ADD CONSTRAINT system_alerts_sender_kind_check CHECK (
    sender_kind IS NULL OR sender_kind IN ('user', 'agent')
  ),
  ADD CONSTRAINT system_alerts_sender_pair_check CHECK (
    (sender_kind IS NULL) = (sender_id IS NULL)
  ),
  ADD CONSTRAINT system_alerts_sender_kind_scope_check CHECK (
    sender_kind IS NULL OR kind = 'agent_unseen'
  );

-- Guarantee at most ONE open agent_unseen alert per seat per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS system_alerts_agent_unseen_open_seat_unique
  ON swarm.system_alerts (workspace_id, affected_principal_id)
  WHERE kind = 'agent_unseen' AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS system_alerts_agent_unseen_sender_open
  ON swarm.system_alerts (workspace_id, sender_kind, sender_id, opened_at, alert_id)
  WHERE kind = 'agent_unseen' AND resolved_at IS NULL AND sender_id IS NOT NULL;

-- 2. Update static fix hints to include agent_unseen.
CREATE OR REPLACE FUNCTION swarm.system_alert_fix_hint(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'agent_quiet' THEN
      'Restart its listener on its host (cswarm inbox --notify) or check the host is awake.'
    WHEN 'agent_unseen' THEN
      'Ask the agent seat to run cswarm check (or open its host session) to view unseen messages.'
    WHEN 'local_renewal_superseded' THEN
      'Reconnect this agent seat in People & agents and update its local credential.'
    WHEN 'local_credential_revoked' THEN
      'Reconnect this agent seat in People & agents to issue a fresh credential.'
    WHEN 'hosted_seat_refused' THEN
      'Reconnect the hosted MCP connection in its client and claim the seat again.'
    WHEN 'hosted_family_retired' THEN
      'Reconnect the hosted MCP connection in its client and claim the seat again.'
    ELSE NULL
  END;
$$;

-- 3. Claims-bound read predicate including the sender of an agent_unseen alert.
CREATE OR REPLACE FUNCTION swarm.system_alert_claims_can_read_v2(
  p_workspace uuid,
  p_channel uuid,
  p_affected uuid,
  p_kind text,
  p_sender_kind text,
  p_sender_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid;
  v_agent uuid;
BEGIN
  IF swarm.system_alert_claims_can_read(p_workspace, p_channel, p_affected) THEN
    RETURN true;
  END IF;

  IF p_kind IS DISTINCT FROM 'agent_unseen'
    OR p_sender_kind IS NULL
    OR p_sender_id IS NULL
    OR p_workspace IS NULL
    OR v_claims IS NULL
    OR v_claims->>'role' IS DISTINCT FROM 'authenticated'
    OR coalesce(v_claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  v_user := (v_claims->>'sub')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM swarm.workspaces AS w
    WHERE w.workspace_id = p_workspace AND w.archived_at IS NULL
  ) OR NOT swarm.is_member(p_workspace, v_user) THEN
    RETURN false;
  END IF;

  IF v_claims ? 'agent_principal_id' THEN
    IF p_sender_kind <> 'agent'
      OR coalesce(v_claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_agent := (v_claims->>'agent_principal_id')::uuid;
    IF v_agent IS DISTINCT FROM p_sender_id OR v_agent IS NOT DISTINCT FROM p_affected THEN
      RETURN false;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS p
      JOIN swarm.agent_workspace_memberships AS am
        ON am.principal_id = p.principal_id
       AND am.workspace_id = p_workspace
       AND am.revoked_at IS NULL
      WHERE p.principal_id = v_agent
        AND p.owner_user_id = v_user
        AND p.revoked_at IS NULL
    ) THEN
      RETURN false;
    END IF;
    IF p_channel IS NOT NULL
      AND NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_agent) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_sender_kind <> 'user' OR v_user IS DISTINCT FROM p_sender_id THEN
    RETURN false;
  END IF;
  IF p_channel IS NOT NULL
    AND NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'user', v_user) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- 4. Update swarm_read.system_alerts view to expose sender_kind/sender_id and use v2 read gate.
CREATE OR REPLACE VIEW swarm_read.system_alerts
WITH (security_barrier = true)
AS
  SELECT
    a.alert_id,
    a.workspace_id,
    a.channel_id,
    a.kind,
    a.affected_principal_id,
    p.name AS affected_seat_name,
    a.fix_hint,
    a.waiting_count,
    a.oldest_waiting_at,
    a.routed_lead_principal_id,
    a.routed_at,
    a.opened_at,
    a.escalate_after,
    a.escalated_at,
    a.resolved_at,
    a.resolved_by_kind,
    a.resolved_by_id,
    a.resolution_note,
    a.sender_kind,
    a.sender_id
  FROM swarm.system_alerts AS a
  JOIN swarm.agent_principals AS p
    ON p.principal_id = a.affected_principal_id
  WHERE swarm.system_alert_claims_can_read_v2(
    a.workspace_id,
    a.channel_id,
    a.affected_principal_id,
    a.kind,
    a.sender_kind,
    a.sender_id
  );

-- 5. Wake targets v2: wakes the live lead, owners (when escalated), and the sender of an agent_unseen alert.
CREATE FUNCTION swarm.system_alert_wake_targets_v2(
  p_workspace uuid,
  p_channel uuid,
  p_affected uuid,
  p_routed_lead uuid,
  p_include_owners boolean,
  p_sender_kind text DEFAULT NULL,
  p_sender_id uuid DEFAULT NULL
)
RETURNS TABLE (topic text, event text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wake_id text;
  v_sender_wake_id text;
BEGIN
  PERFORM swarm.system_alert_lock_scope(p_workspace, p_channel);

  IF p_routed_lead IS NOT NULL
    AND swarm.system_alert_candidate_is_eligible(
      p_workspace, p_channel, p_routed_lead, p_affected, true
    )
    AND swarm.system_alert_agent_is_current_lead(
      p_workspace, p_channel, p_routed_lead, p_affected
    ) THEN
    SELECT p.wake_id
    INTO v_wake_id
    FROM swarm.agent_principals AS p
    WHERE p.principal_id = p_routed_lead
      AND p.revoked_at IS NULL;
    IF v_wake_id IS NOT NULL THEN
      topic := 'cswarm-wake:' || v_wake_id;
      event := 'wake';
      RETURN NEXT;
    END IF;
  END IF;

  IF p_sender_kind = 'agent'
    AND p_sender_id IS NOT NULL
    AND p_sender_id IS DISTINCT FROM p_affected
    AND p_sender_id IS DISTINCT FROM p_routed_lead
    AND swarm.system_alert_candidate_is_eligible(
      p_workspace, p_channel, p_sender_id, p_affected, true
    ) THEN
    SELECT p.wake_id
    INTO v_sender_wake_id
    FROM swarm.agent_principals AS p
    WHERE p.principal_id = p_sender_id
      AND p.revoked_at IS NULL;
    IF v_sender_wake_id IS NOT NULL THEN
      topic := 'cswarm-wake:' || v_sender_wake_id;
      event := 'wake';
      RETURN NEXT;
    END IF;
  ELSIF p_sender_kind = 'user'
    AND p_sender_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM swarm.memberships AS m
      JOIN swarm.workspaces AS w
        ON w.workspace_id = m.workspace_id
       AND w.archived_at IS NULL
      WHERE m.workspace_id = p_workspace
        AND m.user_id = p_sender_id
        AND m.revoked_at IS NULL
        AND (NOT p_include_owners OR m.role <> 'owner')
        AND (
          p_channel IS NULL
          OR swarm.actor_can_access_channel(p_workspace, p_channel, 'user', m.user_id)
        )
    ) THEN
    topic := 'cswarm-member:' || p_workspace::text || ':' || p_sender_id::text;
    event := 'signal';
    RETURN NEXT;
  END IF;

  IF p_include_owners THEN
    RETURN QUERY
    SELECT
      'cswarm-member:' || p_workspace::text || ':' || m.user_id::text AS topic,
      'signal'::text AS event
    FROM swarm.memberships AS m
    JOIN swarm.workspaces AS w
      ON w.workspace_id = m.workspace_id
     AND w.archived_at IS NULL
    WHERE m.workspace_id = p_workspace
      AND m.revoked_at IS NULL
      AND m.role = 'owner'
      AND (
        p_channel IS NULL
        OR swarm.actor_can_access_channel(p_workspace, p_channel, 'user', m.user_id)
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION swarm.notify_system_alert_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_target record;
BEGIN
  IF NEW.resolved_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  FOR v_target IN
    SELECT t.topic, t.event
    FROM swarm.system_alert_wake_targets_v2(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.affected_principal_id,
      NEW.routed_lead_principal_id,
      NEW.escalated_at IS NOT NULL,
      NEW.sender_kind,
      NEW.sender_id
    ) AS t
  LOOP
    BEGIN
      PERFORM realtime.send(
        pg_catalog.jsonb_build_object('v', 1),
        v_target.event,
        v_target.topic,
        true
      );
    EXCEPTION
      WHEN OTHERS THEN
        RETURN NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$fn$;

-- 6. Server-only producer for one deduplicated agent_unseen alert per seat.
CREATE FUNCTION swarm.record_agent_unseen_alert(
  p_workspace_id uuid,
  p_affected_principal_id uuid,
  p_channel_id uuid,
  p_waiting_count integer,
  p_oldest_waiting_at timestamptz,
  p_sender_kind text,
  p_sender_id uuid,
  p_escalation_interval interval DEFAULT interval '30 minutes'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_fix_hint text := swarm.system_alert_fix_hint('agent_unseen');
  v_existing_id uuid;
  v_lead uuid;
  v_opened timestamptz;
  v_escalate_after timestamptz;
  v_escalated_at timestamptz;
  v_alert_id uuid;
BEGIN
  IF p_workspace_id IS NULL
    OR p_affected_principal_id IS NULL
    OR p_waiting_count IS NULL
    OR p_waiting_count <= 0
    OR p_oldest_waiting_at IS NULL
    OR (p_sender_kind IS NULL) <> (p_sender_id IS NULL)
    OR (p_sender_kind IS NOT NULL AND p_sender_kind NOT IN ('user', 'agent'))
    OR p_escalation_interval IS NULL
    OR p_escalation_interval < interval '0 seconds'
    OR p_escalation_interval > interval '24 hours' THEN
    RETURN NULL;
  END IF;

  -- Canonical Level 1 / Level 2 scope lock BEFORE checking channel/lead or locking alert row.
  PERFORM swarm.system_alert_lock_scope(p_workspace_id, p_channel_id);

  IF NOT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    JOIN swarm.agent_workspace_memberships AS am
      ON am.workspace_id = w.workspace_id
     AND am.principal_id = p_affected_principal_id
     AND am.revoked_at IS NULL
    JOIN swarm.agent_principals AS p
      ON p.principal_id = am.principal_id
     AND p.revoked_at IS NULL
    WHERE w.workspace_id = p_workspace_id
      AND w.archived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  IF p_channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM swarm.channels AS c
    WHERE c.workspace_id = p_workspace_id
      AND c.channel_id = p_channel_id
      AND c.archived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- Per-seat Level 3 advisory lock guarantees at most one open agent_unseen alert per seat.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'system_alert:' || p_workspace_id::text || ':agent_unseen:' || p_affected_principal_id::text,
      0
    )
  );

  SELECT a.alert_id
  INTO v_existing_id
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.kind = 'agent_unseen'
    AND a.affected_principal_id = p_affected_principal_id
    AND a.resolved_at IS NULL
  FOR UPDATE;

  v_opened := clock_timestamp();
  v_lead := swarm.system_alert_pick_lead(p_workspace_id, p_channel_id, p_affected_principal_id);

  IF v_existing_id IS NOT NULL THEN
    UPDATE swarm.system_alerts AS a
    SET waiting_count = p_waiting_count,
        oldest_waiting_at = p_oldest_waiting_at,
        sender_kind = p_sender_kind,
        sender_id = p_sender_id,
        routed_lead_principal_id = next_route.next_lead,
        routed_at = CASE
          WHEN next_route.next_lead IS DISTINCT FROM a.routed_lead_principal_id THEN
            CASE WHEN next_route.next_lead IS NOT NULL THEN GREATEST(a.opened_at, v_opened) ELSE NULL END
          ELSE a.routed_at
        END,
        updated_at = GREATEST(a.opened_at, v_opened)
    FROM (
      SELECT
        CASE
          WHEN cur.routed_lead_principal_id IS NOT NULL
            AND swarm.system_alert_candidate_is_eligible(
              p_workspace_id, cur.channel_id, cur.routed_lead_principal_id, p_affected_principal_id, true
            )
            AND swarm.system_alert_agent_is_current_lead(
              p_workspace_id, cur.channel_id, cur.routed_lead_principal_id, p_affected_principal_id
            )
          THEN cur.routed_lead_principal_id
          ELSE v_lead
        END AS next_lead
      FROM swarm.system_alerts AS cur
      WHERE cur.alert_id = v_existing_id
    ) AS next_route
    WHERE a.alert_id = v_existing_id;
    RETURN v_existing_id;
  END IF;

  IF v_lead IS NULL THEN
    v_escalate_after := v_opened;
    v_escalated_at := v_opened;
  ELSE
    v_escalate_after := v_opened + p_escalation_interval;
    v_escalated_at := NULL;
  END IF;

  INSERT INTO swarm.system_alerts (
    workspace_id,
    channel_id,
    kind,
    affected_principal_id,
    fix_hint,
    waiting_count,
    oldest_waiting_at,
    routed_lead_principal_id,
    routed_at,
    opened_at,
    escalate_after,
    escalated_at,
    updated_at,
    sender_kind,
    sender_id
  ) VALUES (
    p_workspace_id,
    p_channel_id,
    'agent_unseen',
    p_affected_principal_id,
    v_fix_hint,
    p_waiting_count,
    p_oldest_waiting_at,
    v_lead,
    CASE WHEN v_lead IS NOT NULL THEN v_opened ELSE NULL END,
    v_opened,
    v_escalate_after,
    v_escalated_at,
    v_opened,
    p_sender_kind,
    p_sender_id
  )
  RETURNING alert_id INTO v_alert_id;

  RETURN v_alert_id;
END;
$$;

-- 7. Reusable predicate: does a seat currently have ANY qualifying unseen ask, mention, or to-do notice?
CREATE FUNCTION swarm.agent_has_unseen_ask_or_notice(
  p_workspace_id uuid,
  p_principal_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.workspace_id = d.workspace_id
     AND s.id = d.signal_id
     AND s.until > statement_timestamp()
    WHERE d.workspace_id = p_workspace_id
      AND d.recipient_agent_principal_id = p_principal_id
      AND (d.acked_at IS NULL OR d.ack_outcome = 'queued')
      AND NOT (s.from_kind = 'agent' AND s.from_principal = p_principal_id)
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.signal_agent_receipts AS r
        WHERE r.workspace_id = d.workspace_id
          AND r.signal_id = d.signal_id
          AND r.principal_id = p_principal_id
      )
      AND (
        s.kind = 'ask'
        OR (
          s.kind = 'note'
          AND (
            s.about LIKE 'todo:%'
            OR s.about LIKE 'object:%'
            OR EXISTS (
              SELECT 1
              FROM swarm.signal_mentions AS sm
              WHERE sm.workspace_id = s.workspace_id
                AND sm.signal_id = s.id
                AND sm.mentioned_agent_principal_id = p_principal_id
            )
          )
        )
      )
  );
$$;

-- 8. Deadlock-free immediate auto-clear when the seat observes or views its unseen messages.
-- Uses FOR UPDATE SKIP LOCKED on swarm.system_alerts only (zero parent or conversation locks).
CREATE FUNCTION swarm.clear_agent_unseen_alert_if_seen(
  p_workspace_id uuid,
  p_principal_id uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_alert_id uuid;
  v_now timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_principal_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Fast read-only check so normal acks/receipts with no open alert take zero locks.
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.system_alerts AS a
    WHERE a.workspace_id = p_workspace_id
      AND a.kind = 'agent_unseen'
      AND a.affected_principal_id = p_principal_id
      AND a.resolved_at IS NULL
  ) THEN
    RETURN 0;
  END IF;

  IF swarm.agent_has_unseen_ask_or_notice(p_workspace_id, p_principal_id) THEN
    RETURN 0;
  END IF;

  SELECT a.alert_id
  INTO v_alert_id
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.kind = 'agent_unseen'
    AND a.affected_principal_id = p_principal_id
    AND a.resolved_at IS NULL
  FOR UPDATE SKIP LOCKED;

  IF v_alert_id IS NULL THEN
    RETURN 0;
  END IF;

  v_now := clock_timestamp();
  UPDATE swarm.system_alerts
  SET resolved_at = GREATEST(opened_at, v_now),
      resolved_by_kind = 'agent',
      resolved_by_id = p_principal_id,
      resolution_note = 'Cleared automatically when the seat viewed its unseen messages.',
      updated_at = GREATEST(opened_at, v_now)
  WHERE alert_id = v_alert_id
    AND resolved_at IS NULL;

  RETURN 1;
END;
$$;

CREATE FUNCTION swarm.trg_signal_deliveries_clear_agent_unseen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM swarm.clear_agent_unseen_alert_if_seen(
    NEW.workspace_id,
    NEW.recipient_agent_principal_id
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION swarm.trg_signal_agent_receipts_clear_agent_unseen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM swarm.clear_agent_unseen_alert_if_seen(
    NEW.workspace_id,
    NEW.principal_id
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER signal_deliveries_clear_agent_unseen
  AFTER UPDATE OF ack_outcome ON swarm.signal_deliveries
  FOR EACH ROW
  WHEN (
    NEW.ack_outcome IN ('observed', 'replied', 'expired', 'failed_terminal')
    AND OLD.ack_outcome IS DISTINCT FROM NEW.ack_outcome
  )
  EXECUTE FUNCTION swarm.trg_signal_deliveries_clear_agent_unseen();

CREATE TRIGGER signal_agent_receipts_clear_agent_unseen
  AFTER INSERT ON swarm.signal_agent_receipts
  FOR EACH ROW
  EXECUTE FUNCTION swarm.trg_signal_agent_receipts_clear_agent_unseen();

-- 9. Periodic sync (swarm_admin only): raises 1 deduplicated agent_unseen alert per seat
-- for unseen asks, mentions, or to-do notices older than p_unseen_after (including queued),
-- and clears any open agent_unseen alert whose seat no longer has qualifying unseen messages.
CREATE FUNCTION swarm.sync_agent_unseen_alerts(
  p_unseen_after interval DEFAULT interval '10 minutes',
  p_escalation_interval interval DEFAULT interval '30 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_ws uuid[];
  v_ch uuid[];
  v_principal uuid[];
  v_waiting_count integer[];
  v_oldest timestamptz[];
  v_sender_kind text[];
  v_sender_id uuid[];
  v_idx integer;
  v_synced integer := 0;
  v_cleared integer := 0;
  v_open_rec record;
  v_alert_id uuid;
BEGIN
  IF p_unseen_after IS NULL OR p_unseen_after < interval '0 seconds' THEN
    RETURN jsonb_build_object('synced', 0, 'cleared', 0);
  END IF;

  -- Step 1: Collect seats with qualifying unseen asks, mentions, or to-do notices aged past p_unseen_after.
  WITH unseen_rows AS (
    SELECT
      w.workspace_id,
      p.principal_id,
      CASE
        WHEN cs.signal_id IS NOT NULL AND conv.kind IN ('general', 'public_channel', 'private_channel')
          THEN conv.channel_id
        WHEN cs.signal_id IS NULL
          THEN s.channel_id
        ELSE NULL
      END AS effective_channel_id,
      d.enqueued_at,
      s.id AS signal_id,
      s.from_kind::text AS sender_kind,
      s.from_principal AS sender_id
    FROM swarm.signal_deliveries AS d
    JOIN swarm.agent_principals AS p
      ON p.principal_id = d.recipient_agent_principal_id
     AND p.revoked_at IS NULL
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id
     AND am.workspace_id = d.workspace_id
     AND am.revoked_at IS NULL
    JOIN swarm.workspaces AS w
      ON w.workspace_id = d.workspace_id
     AND w.archived_at IS NULL
    JOIN swarm.memberships AS owner_m
      ON owner_m.workspace_id = w.workspace_id
     AND owner_m.user_id = p.owner_user_id
     AND owner_m.revoked_at IS NULL
    JOIN swarm.signals AS s
      ON s.workspace_id = d.workspace_id
     AND s.id = d.signal_id
     AND s.until > v_now
    LEFT JOIN swarm.conversation_signals AS cs
      ON cs.workspace_id = s.workspace_id
     AND cs.signal_id = s.id
    LEFT JOIN swarm.conversations AS conv
      ON conv.conversation_id = cs.conversation_id
     AND conv.workspace_id = cs.workspace_id
    WHERE (d.acked_at IS NULL OR d.ack_outcome = 'queued')
      AND d.enqueued_at <= v_now - p_unseen_after
      AND NOT (s.from_kind = 'agent' AND s.from_principal = p.principal_id)
      AND (conv.conversation_id IS NULL OR conv.archived_at IS NULL)
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.signal_agent_receipts AS r
        WHERE r.workspace_id = d.workspace_id
          AND r.signal_id = d.signal_id
          AND r.principal_id = p.principal_id
      )
      AND (
        s.kind = 'ask'
        OR (
          s.kind = 'note'
          AND (
            s.about LIKE 'todo:%'
            OR s.about LIKE 'object:%'
            OR EXISTS (
              SELECT 1
              FROM swarm.signal_mentions AS sm
              WHERE sm.workspace_id = s.workspace_id
                AND sm.signal_id = s.id
                AND sm.mentioned_agent_principal_id = p.principal_id
            )
          )
        )
      )
  ), per_seat AS (
    SELECT
      u.workspace_id,
      u.principal_id,
      count(*)::integer AS waiting_count,
      min(u.enqueued_at) AS oldest_waiting_at,
      (array_agg(u.effective_channel_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS channel_id,
      (array_agg(u.sender_kind ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS sender_kind,
      (array_agg(u.sender_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS sender_id
    FROM unseen_rows AS u
    WHERE u.effective_channel_id IS NULL
       OR EXISTS (
         SELECT 1
         FROM swarm.channels AS ch
         WHERE ch.workspace_id = u.workspace_id
           AND ch.channel_id = u.effective_channel_id
           AND ch.archived_at IS NULL
       )
    GROUP BY u.workspace_id, u.principal_id
  )
  SELECT
    array_agg(ps.workspace_id ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.channel_id ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.principal_id ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.waiting_count ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.oldest_waiting_at ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.sender_kind ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC),
    array_agg(ps.sender_id ORDER BY ps.workspace_id ASC, COALESCE(ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC)
  INTO v_ws, v_ch, v_principal, v_waiting_count, v_oldest, v_sender_kind, v_sender_id
  FROM per_seat AS ps;

  IF v_ws IS NOT NULL AND pg_catalog.array_length(v_ws, 1) IS NOT NULL THEN
    PERFORM swarm.system_alert_lock_scopes(v_ws, v_ch);
    FOR v_idx IN 1..pg_catalog.array_length(v_ws, 1) LOOP
      v_alert_id := swarm.record_agent_unseen_alert(
        v_ws[v_idx],
        v_principal[v_idx],
        v_ch[v_idx],
        v_waiting_count[v_idx],
        v_oldest[v_idx],
        v_sender_kind[v_idx],
        v_sender_id[v_idx],
        p_escalation_interval
      );
      IF v_alert_id IS NOT NULL THEN
        v_synced := v_synced + 1;
      END IF;
    END LOOP;
  END IF;

  -- Step 2: Clear any open agent_unseen alerts whose seat has no remaining qualifying unseen messages.
  FOR v_open_rec IN
    SELECT a.alert_id, a.workspace_id, a.affected_principal_id
    FROM swarm.system_alerts AS a
    WHERE a.kind = 'agent_unseen'
      AND a.resolved_at IS NULL
    ORDER BY a.workspace_id ASC, a.affected_principal_id ASC, a.alert_id ASC
  LOOP
    IF NOT swarm.agent_has_unseen_ask_or_notice(v_open_rec.workspace_id, v_open_rec.affected_principal_id) THEN
      v_cleared := v_cleared + swarm.clear_agent_unseen_alert_if_seen(
        v_open_rec.workspace_id,
        v_open_rec.affected_principal_id
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('synced', v_synced, 'cleared', v_cleared);
END;
$$;

-- 10. Ownership & least-privilege grants.
ALTER FUNCTION swarm.system_alert_fix_hint(text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, text, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_wake_targets_v2(uuid, uuid, uuid, uuid, boolean, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_agent_unseen_alert(uuid, uuid, uuid, integer, timestamptz, text, uuid, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.agent_has_unseen_ask_or_notice(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.clear_agent_unseen_alert_if_seen(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.trg_signal_deliveries_clear_agent_unseen() OWNER TO swarm_admin;
ALTER FUNCTION swarm.trg_signal_agent_receipts_clear_agent_unseen() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_agent_unseen_alerts(interval, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.notify_system_alert_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION
  swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, text, text, uuid),
  swarm.system_alert_wake_targets_v2(uuid, uuid, uuid, uuid, boolean, text, uuid),
  swarm.record_agent_unseen_alert(uuid, uuid, uuid, integer, timestamptz, text, uuid, interval),
  swarm.agent_has_unseen_ask_or_notice(uuid, uuid),
  swarm.clear_agent_unseen_alert_if_seen(uuid, uuid),
  swarm.trg_signal_deliveries_clear_agent_unseen(),
  swarm.trg_signal_agent_receipts_clear_agent_unseen(),
  swarm.sync_agent_unseen_alerts(interval, interval),
  swarm.notify_system_alert_insert()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION
  swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, text, text, uuid)
TO authenticated, swarm_read;

ALTER VIEW swarm_read.system_alerts OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.system_alerts TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.system_alerts FROM PUBLIC, anon;

-- Schedule agent_unseen alert sync every 2 minutes alongside quiet-agent sync.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'swarm-sync-agent-unseen-alerts',
  '*/2 * * * *',
  $$SELECT swarm.sync_agent_unseen_alerts(interval '10 minutes', interval '30 minutes')$$
);

RESET search_path;
