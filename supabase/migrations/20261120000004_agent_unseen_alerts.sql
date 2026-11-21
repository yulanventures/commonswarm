-- C1a: agent_unseen alerts — an ask, mention, or to-do notice that has not been shown to
-- the target seat after N minutes (including messages acknowledged only as 'queued') raises
-- one deduplicated alert per (seat, audience scope) visible to the authorized live lead and
-- sender, and clears automatically when the seat views its unseen messages in that scope.
--
-- Security & lock-order invariants (matching 20261119000001_lead_system_alerts.sql):
--   1. Audience-isolated partitioning: every qualifying unseen delivery is classified by its
--      canonical conversation placement and per-message audience ('conversation' vs 'addressed',
--      including inherited root audience on thread replies). Alerts are partitioned and deduped
--      per (workspace_id, affected_principal_id, scope_key) so every message contributing to an
--      alert's waiting_count shares the exact same authorized audience. A DM never becomes an
--      unscoped alert, and public activity never mixes with or rolls over into private activity.
--   2. Immutable scope binding: scope_key, channel_id, conversation_id, and source_audience are
--      immutable once opened. When public messages are viewed while private messages remain, the
--      public alert is retired/cleared rather than mutating its scope or revealing private senders.
--   3. Unified access gate: read (swarm_read.system_alerts), owner escalation inbox
--      (swarm_read.owner_alert_inbox), resolution (swarm.resolve_system_alert), lead routing, and
--      realtime wakes (insert, escalate, reroute) all enforce swarm.system_alert_scope_accessible
--      against live workspace membership, channel access, conversation_visible, and
--      conversation_signal_visible_to for addressed sources.
--   4. Sync batch follows Level 1 (conversations FOR SHARE in workspace_id, conversation_id ASC)
--      -> Level 2 (conversation-frames advisory lock shared) -> Level 3 (system_alert key lock
--      -> system_alerts FOR UPDATE). Zero parent-locking FK constraints (MVCC trigger validates).
--   5. Immediate auto-clear triggers on signal_deliveries / signal_agent_receipts use
--      FOR UPDATE SKIP LOCKED on swarm.system_alerts only (zero parent or conversation locks).

SET search_path = swarm, pg_catalog, public;

-- 1. Extend swarm.system_alerts for agent_unseen audience-bound scope & sender metadata.
ALTER TABLE swarm.system_alerts
  ADD COLUMN IF NOT EXISTS sender_kind text,
  ADD COLUMN IF NOT EXISTS sender_id uuid,
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS source_signal_id uuid,
  ADD COLUMN IF NOT EXISTS source_audience text;

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
  ),
  ADD CONSTRAINT system_alerts_unseen_scope_fields_check CHECK (
    (kind = 'agent_unseen') = (scope_key IS NOT NULL AND source_audience IS NOT NULL AND source_signal_id IS NOT NULL)
  ),
  ADD CONSTRAINT system_alerts_source_audience_check CHECK (
    source_audience IS NULL OR source_audience IN ('conversation', 'addressed')
  ),
  ADD CONSTRAINT system_alerts_conversation_scope_check CHECK (
    conversation_id IS NULL OR kind = 'agent_unseen'
  );

-- Update MVCC reference validator (zero parent row locks) to cover conversation_id and source_signal_id.
CREATE OR REPLACE FUNCTION swarm.system_alert_validate_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM swarm.workspaces AS w WHERE w.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown workspace_id %', NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM swarm.agent_principals AS p WHERE p.principal_id = NEW.affected_principal_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown affected_principal_id %', NEW.affected_principal_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.routed_lead_principal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.agent_principals AS p WHERE p.principal_id = NEW.routed_lead_principal_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown routed_lead_principal_id %', NEW.routed_lead_principal_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.channels AS c
    WHERE c.workspace_id = NEW.workspace_id AND c.channel_id = NEW.channel_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown channel_id % in workspace %', NEW.channel_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.conversations AS conv
    WHERE conv.workspace_id = NEW.workspace_id AND conv.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown conversation_id % in workspace %', NEW.conversation_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.source_signal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.signals AS s
    WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.source_signal_id
  ) THEN
    RAISE EXCEPTION 'system_alerts: unknown source_signal_id % in workspace %', NEW.source_signal_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS system_alerts_validate_refs ON swarm.system_alerts;
CREATE TRIGGER system_alerts_validate_refs
  BEFORE INSERT OR UPDATE OF workspace_id, channel_id, conversation_id, source_signal_id, affected_principal_id, routed_lead_principal_id
  ON swarm.system_alerts
  FOR EACH ROW
  EXECUTE FUNCTION swarm.system_alert_validate_refs();

-- Enforce scope immutability on update so an existing alert row can never cross audiences.
CREATE FUNCTION swarm.system_alert_scope_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.affected_principal_id IS DISTINCT FROM OLD.affected_principal_id
    OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.source_audience IS DISTINCT FROM OLD.source_audience
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key THEN
    RAISE EXCEPTION 'system_alerts scope is immutable; retire the old alert instead of changing audience'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_alerts_scope_immutable
  BEFORE UPDATE ON swarm.system_alerts
  FOR EACH ROW
  EXECUTE FUNCTION swarm.system_alert_scope_immutable();

-- Replace open-scope uniqueness so distinct DM / addressed scopes (channel_id NULL) do not collide
-- while non-agent_unseen alerts keep their exact (workspace, kind, affected, channel) uniqueness.
DROP INDEX IF EXISTS swarm.system_alerts_open_scope_unique;
CREATE UNIQUE INDEX system_alerts_open_scope_unique
  ON swarm.system_alerts (
    workspace_id,
    kind,
    affected_principal_id,
    COALESCE(channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_key, '')
  )
  WHERE resolved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS system_alerts_agent_unseen_open_scope_unique
  ON swarm.system_alerts (workspace_id, affected_principal_id, scope_key)
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

-- 3. Canonical lock helpers that lock either the exact conversation (including DMs) or channel/#general.
CREATE FUNCTION swarm.system_alert_lock_scope_v2(
  p_workspace uuid,
  p_channel uuid,
  p_conversation uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_workspace IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace
    AND CASE
      WHEN p_conversation IS NOT NULL THEN c.conversation_id = p_conversation
      WHEN p_channel IS NOT NULL THEN c.conversation_id = p_channel
      ELSE c.kind = 'general'
    END
  FOR SHARE;
  IF p_channel IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('conversation-frames:' || p_workspace::text || ':' || p_channel::text, 0)
    );
  END IF;
END;
$$;

CREATE FUNCTION swarm.system_alert_lock_scopes_v2(
  p_workspaces uuid[],
  p_channels uuid[],
  p_conversations uuid[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_rec record;
BEGIN
  IF p_workspaces IS NULL OR pg_catalog.array_length(p_workspaces, 1) IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM swarm.conversations AS c
  WHERE c.conversation_id IN (
    SELECT DISTINCT conv.conversation_id
    FROM unnest(p_workspaces, p_channels, p_conversations) AS s(ws_id, ch_id, conv_id)
    JOIN swarm.conversations AS conv
      ON conv.workspace_id = s.ws_id
     AND CASE
       WHEN s.conv_id IS NOT NULL THEN conv.conversation_id = s.conv_id
       WHEN s.ch_id IS NOT NULL THEN conv.conversation_id = s.ch_id
       ELSE conv.kind = 'general'
     END
    WHERE s.ws_id IS NOT NULL
  )
  ORDER BY c.workspace_id ASC, c.conversation_id ASC
  FOR SHARE;

  FOR v_rec IN
    SELECT DISTINCT s.ws_id, s.ch_id
    FROM unnest(p_workspaces, p_channels) AS s(ws_id, ch_id)
    WHERE s.ws_id IS NOT NULL
      AND s.ch_id IS NOT NULL
    ORDER BY s.ws_id ASC, s.ch_id ASC
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('conversation-frames:' || v_rec.ws_id::text || ':' || v_rec.ch_id::text, 0)
    );
  END LOOP;
END;
$$;

-- 4. Unified canonical audience classifier for one qualifying signal.
-- Returns the exact audience partition (scope_key) so every message grouped into the same alert
-- has the EXACT same authorized viewers (conversation + channel + addressed participant set +
-- inherited addressed thread-root participant set).
CREATE FUNCTION swarm.agent_unseen_signal_scope(
  p_workspace_id uuid,
  p_signal_id uuid,
  OUT scope_key text,
  OUT effective_channel_id uuid,
  OUT conversation_id uuid,
  OUT source_audience text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sig record;
  v_cs record;
  v_conv record;
  v_root record;
  v_rcs record;
  v_sig_addressed boolean := false;
  v_root_addressed boolean := false;
  v_sig_parts text := '';
  v_root_parts text := '';
  v_anchor text;
BEGIN
  SELECT
    s.id, s.channel_id, s.thread_root_id, s.from_kind, s.from_principal,
    s.to_user_id, s.to_agent_principal_id
  INTO v_sig
  FROM swarm.signals AS s
  WHERE s.workspace_id = p_workspace_id AND s.id = p_signal_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT cs.conversation_id, cs.audience
  INTO v_cs
  FROM swarm.conversation_signals AS cs
  WHERE cs.workspace_id = p_workspace_id AND cs.signal_id = p_signal_id;

  IF v_cs.conversation_id IS NOT NULL THEN
    IF v_cs.audience NOT IN ('conversation', 'addressed') THEN
      RETURN;
    END IF;
    SELECT c.conversation_id, c.kind, c.channel_id, c.archived_at
    INTO v_conv
    FROM swarm.conversations AS c
    WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_cs.conversation_id;
    IF NOT FOUND OR v_conv.archived_at IS NOT NULL THEN
      RETURN;
    END IF;
    conversation_id := v_conv.conversation_id;
    effective_channel_id := CASE
      WHEN v_conv.kind IN ('public_channel', 'private_channel') THEN v_conv.channel_id
      ELSE NULL
    END;
  ELSIF v_sig.thread_root_id IS NOT NULL THEN
    -- Fail closed: suppress unfiled thread replies (matching the canonical frame reader),
    -- so a reply without conversation placement can never fall back to a general alert.
    RETURN;
  ELSE
    conversation_id := NULL;
    effective_channel_id := v_sig.channel_id;
  END IF;

  IF effective_channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.channels AS ch
    WHERE ch.workspace_id = p_workspace_id
      AND ch.channel_id = effective_channel_id
      AND ch.archived_at IS NULL
  ) THEN
    conversation_id := NULL;
    effective_channel_id := NULL;
    RETURN;
  END IF;

  v_sig_addressed := (
    v_cs.audience = 'addressed'
    OR (
      v_cs.conversation_id IS NULL
      AND (
        v_sig.to_user_id IS NOT NULL
        OR v_sig.to_agent_principal_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM swarm.signal_recipients AS sr
          WHERE sr.workspace_id = p_workspace_id AND sr.signal_id = v_sig.id
        )
      )
    )
  );

  IF v_sig.thread_root_id IS NOT NULL THEN
    SELECT
      r.id, r.from_kind, r.from_principal, r.to_user_id, r.to_agent_principal_id
    INTO v_root
    FROM swarm.signals AS r
    WHERE r.workspace_id = p_workspace_id AND r.id = v_sig.thread_root_id;
    IF NOT FOUND THEN
      conversation_id := NULL;
      effective_channel_id := NULL;
      RETURN;
    END IF;
    SELECT rcs.conversation_id, rcs.audience INTO v_rcs
    FROM swarm.conversation_signals AS rcs
    WHERE rcs.workspace_id = p_workspace_id AND rcs.signal_id = v_root.id;
    IF v_rcs.conversation_id IS NULL
      OR v_rcs.conversation_id IS DISTINCT FROM v_cs.conversation_id
      OR v_rcs.audience NOT IN ('conversation', 'addressed') THEN
      -- Fail closed: exclude replies whose root lacks matching canonical placement/audience.
      conversation_id := NULL;
      effective_channel_id := NULL;
      RETURN;
    END IF;
    v_root_addressed := (v_rcs.audience = 'addressed');
  END IF;

  IF NOT v_sig_addressed AND NOT v_root_addressed THEN
    source_audience := 'conversation';
    IF conversation_id IS NOT NULL THEN
      scope_key := 'conv:' || conversation_id::text;
    ELSE
      scope_key := 'legacy-ch:' || COALESCE(effective_channel_id::text, 'general');
    END IF;
    RETURN;
  END IF;

  source_audience := 'addressed';
  IF v_sig_addressed THEN
    SELECT coalesce(string_agg(DISTINCT p.tag, ',' ORDER BY p.tag), '')
    INTO v_sig_parts
    FROM (
      SELECT CASE WHEN v_sig.from_kind = 'user' THEN 'u:' || v_sig.from_principal::text
                  ELSE 'a:' || v_sig.from_principal::text END AS tag
      UNION ALL
      SELECT 'u:' || v_sig.to_user_id::text WHERE v_sig.to_user_id IS NOT NULL
      UNION ALL
      SELECT 'a:' || v_sig.to_agent_principal_id::text WHERE v_sig.to_agent_principal_id IS NOT NULL
      UNION ALL
      SELECT CASE WHEN sr.recipient_user_id IS NOT NULL THEN 'u:' || sr.recipient_user_id::text
                  ELSE 'a:' || sr.recipient_agent_principal_id::text END
      FROM swarm.signal_recipients AS sr
      WHERE sr.workspace_id = p_workspace_id AND sr.signal_id = v_sig.id
    ) AS p
    WHERE p.tag IS NOT NULL;
  END IF;

  IF v_root_addressed THEN
    SELECT coalesce(string_agg(DISTINCT p.tag, ',' ORDER BY p.tag), '')
    INTO v_root_parts
    FROM (
      SELECT CASE WHEN v_root.from_kind = 'user' THEN 'u:' || v_root.from_principal::text
                  ELSE 'a:' || v_root.from_principal::text END AS tag
      UNION ALL
      SELECT 'u:' || v_root.to_user_id::text WHERE v_root.to_user_id IS NOT NULL
      UNION ALL
      SELECT 'a:' || v_root.to_agent_principal_id::text WHERE v_root.to_agent_principal_id IS NOT NULL
      UNION ALL
      SELECT CASE WHEN rr.recipient_user_id IS NOT NULL THEN 'u:' || rr.recipient_user_id::text
                  ELSE 'a:' || rr.recipient_agent_principal_id::text END
      FROM swarm.signal_recipients AS rr
      WHERE rr.workspace_id = p_workspace_id AND rr.signal_id = v_root.id
    ) AS p
    WHERE p.tag IS NOT NULL;
  END IF;

  v_anchor := COALESCE('conv:' || conversation_id::text, 'ch:' || COALESCE(effective_channel_id::text, 'general'));
  scope_key := 'addr:' || encode(
    sha256(convert_to(v_anchor || '|s:' || v_sig_parts || '|r:' || v_root_parts, 'UTF8')),
    'hex'
  );
END;
$$;

-- 5. Unified scope-access predicate enforced across reads, owner inbox, resolve, lead routing, and wakes.
CREATE FUNCTION swarm.system_alert_scope_accessible(
  p_workspace uuid,
  p_channel uuid,
  p_conversation uuid,
  p_source_signal uuid,
  p_source_audience text,
  p_actor_kind text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sig record;
  v_cs_conv uuid;
  v_cs_aud text;
  v_root record;
  v_rcs_conv uuid;
  v_rcs_aud text;
  v_sig_addressed boolean;
  v_root_addressed boolean;
BEGIN
  IF p_workspace IS NULL OR p_actor_kind NOT IN ('user', 'agent') OR p_actor_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT swarm.actor_can_access_channel(p_workspace, NULL, p_actor_kind, p_actor_id) THEN
    RETURN false;
  END IF;
  IF p_channel IS NOT NULL
    AND NOT swarm.actor_can_access_channel(p_workspace, p_channel, p_actor_kind, p_actor_id) THEN
    RETURN false;
  END IF;
  IF p_conversation IS NOT NULL
    AND NOT swarm.conversation_visible(p_workspace, p_actor_kind, p_actor_id, p_conversation) THEN
    RETURN false;
  END IF;

  IF p_source_audience = 'addressed' THEN
    IF p_source_signal IS NULL THEN
      RETURN false;
    END IF;
    SELECT
      s.id, s.thread_root_id, s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id
    INTO v_sig
    FROM swarm.signals AS s
    WHERE s.workspace_id = p_workspace AND s.id = p_source_signal;
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    SELECT cs.audience INTO v_cs_aud
    FROM swarm.conversation_signals AS cs
    WHERE cs.workspace_id = p_workspace AND cs.signal_id = v_sig.id;

    v_sig_addressed := (
      v_cs_aud = 'addressed'
      OR v_sig.to_user_id IS NOT NULL
      OR v_sig.to_agent_principal_id IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM swarm.signal_recipients AS sr
        WHERE sr.workspace_id = p_workspace AND sr.signal_id = v_sig.id
      )
    );
    IF v_sig_addressed AND NOT swarm.conversation_signal_visible_to(
      p_workspace, v_sig.id, 'addressed',
      v_sig.from_kind::text, v_sig.from_principal,
      v_sig.to_user_id, v_sig.to_agent_principal_id,
      p_actor_kind, p_actor_id
    ) THEN
      RETURN false;
    END IF;

    IF v_sig.thread_root_id IS NOT NULL THEN
      SELECT cs.conversation_id INTO v_cs_conv
      FROM swarm.conversation_signals AS cs
      WHERE cs.workspace_id = p_workspace AND cs.signal_id = v_sig.id;
      IF v_cs_conv IS NULL OR v_cs_aud NOT IN ('conversation', 'addressed') THEN
        RETURN false;
      END IF;
      SELECT
        r.id, r.from_kind, r.from_principal, r.to_user_id, r.to_agent_principal_id
      INTO v_root
      FROM swarm.signals AS r
      WHERE r.workspace_id = p_workspace AND r.id = v_sig.thread_root_id;
      IF NOT FOUND THEN
        RETURN false;
      END IF;
      SELECT rcs.conversation_id, rcs.audience INTO v_rcs_conv, v_rcs_aud
      FROM swarm.conversation_signals AS rcs
      WHERE rcs.workspace_id = p_workspace AND rcs.signal_id = v_root.id;
      IF v_rcs_conv IS NULL
        OR v_rcs_conv IS DISTINCT FROM v_cs_conv
        OR v_rcs_aud NOT IN ('conversation', 'addressed') THEN
        RETURN false;
      END IF;
      v_root_addressed := (v_rcs_aud = 'addressed');
      IF v_root_addressed AND NOT swarm.conversation_signal_visible_to(
        p_workspace, v_root.id, 'addressed',
        v_root.from_kind::text, v_root.from_principal,
        v_root.to_user_id, v_root.to_agent_principal_id,
        p_actor_kind, p_actor_id
      ) THEN
        RETURN false;
      END IF;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- Pick a live lead ONLY if that lead is ALSO authorized for the alert's conversation and audience.
CREATE FUNCTION swarm.system_alert_pick_lead_v2(
  p_workspace uuid,
  p_channel uuid,
  p_conversation uuid,
  p_source_signal uuid,
  p_source_audience text,
  p_affected uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_mode text;
  v_channel_lead uuid;
  v_archived timestamptz;
  v_workspace_lead uuid;
BEGIN
  IF p_workspace IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_channel IS NOT NULL THEN
    SELECT c.lead_mode, c.lead_agent_principal_id, c.archived_at
    INTO v_mode, v_channel_lead, v_archived
    FROM swarm.channels AS c
    WHERE c.workspace_id = p_workspace
      AND c.channel_id = p_channel;
    IF NOT FOUND OR v_archived IS NOT NULL THEN
      RETURN NULL;
    END IF;
    IF v_mode = 'agent' AND v_channel_lead IS NOT NULL
      AND swarm.system_alert_candidate_is_eligible(
        p_workspace, p_channel, v_channel_lead, p_affected, true
      )
      AND swarm.system_alert_scope_accessible(
        p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'agent', v_channel_lead
      ) THEN
      RETURN v_channel_lead;
    END IF;
  END IF;

  SELECT w.lead_agent_principal_id
  INTO v_workspace_lead
  FROM swarm.workspaces AS w
  WHERE w.workspace_id = p_workspace
    AND w.archived_at IS NULL;

  IF v_workspace_lead IS NOT NULL
    AND swarm.system_alert_candidate_is_eligible(
      p_workspace, p_channel, v_workspace_lead, p_affected, true
    )
    AND swarm.system_alert_scope_accessible(
      p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'agent', v_workspace_lead
    ) THEN
    RETURN v_workspace_lead;
  END IF;
  RETURN NULL;
END;
$$;

-- 6. Claims-bound read predicate: enforces conversation + message audience for agent_unseen.
CREATE OR REPLACE FUNCTION swarm.system_alert_claims_can_read_v2(
  p_workspace uuid,
  p_channel uuid,
  p_conversation uuid,
  p_source_signal uuid,
  p_source_audience text,
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
  IF p_kind IS DISTINCT FROM 'agent_unseen' THEN
    RETURN swarm.system_alert_claims_can_read(p_workspace, p_channel, p_affected);
  END IF;

  IF p_workspace IS NULL
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
    IF coalesce(v_claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_agent := (v_claims->>'agent_principal_id')::uuid;
    IF v_agent IS NOT DISTINCT FROM p_affected THEN
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
    IF NOT swarm.system_alert_scope_accessible(
      p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'agent', v_agent
    ) THEN
      RETURN false;
    END IF;
    RETURN (
      (p_sender_kind = 'agent' AND p_sender_id = v_agent)
      OR swarm.system_alert_agent_is_current_lead(p_workspace, p_channel, v_agent, p_affected)
    );
  END IF;

  IF NOT swarm.system_alert_scope_accessible(
    p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'user', v_user
  ) THEN
    RETURN false;
  END IF;

  IF p_sender_kind = 'user' AND p_sender_id = v_user THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace
      AND m.user_id = v_user
      AND m.revoked_at IS NULL
      AND m.role IN ('owner', 'admin')
  );
END;
$$;

-- 7. Update swarm_read.system_alerts and swarm_read.owner_alert_inbox to enforce audience scope.
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
    a.conversation_id,
    a.source_signal_id,
    a.source_audience,
    a.affected_principal_id,
    a.kind,
    a.sender_kind,
    a.sender_id
  );

CREATE OR REPLACE FUNCTION swarm_read.owner_alert_inbox(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_viewer uuid;
  v_read_at timestamptz := statement_timestamp();
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF p_workspace_id IS NULL OR v_claims IS NULL
    OR v_claims->>'role' IS DISTINCT FROM 'authenticated'
    OR v_claims ? 'agent_principal_id'
    OR coalesce(v_claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  v_viewer := (v_claims->>'sub')::uuid;

  IF NOT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    JOIN swarm.memberships AS m
      ON m.workspace_id = w.workspace_id
     AND m.user_id = v_viewer
     AND m.revoked_at IS NULL
     AND m.role = 'owner'
    WHERE w.workspace_id = p_workspace_id
      AND w.archived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  WITH escalated AS MATERIALIZED (
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
      a.opened_at,
      a.escalated_at
    FROM swarm.system_alerts AS a
    JOIN swarm.agent_principals AS p
      ON p.principal_id = a.affected_principal_id
    WHERE a.workspace_id = p_workspace_id
      AND a.resolved_at IS NULL
      AND a.escalated_at IS NOT NULL
      AND swarm.system_alert_scope_accessible(
        a.workspace_id,
        a.channel_id,
        a.conversation_id,
        a.source_signal_id,
        a.source_audience,
        'user',
        v_viewer
      )
  ), page AS (
    SELECT * FROM escalated ORDER BY escalated_at, alert_id LIMIT 100
  )
  SELECT
    (SELECT count(*)::integer FROM escalated),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'alert_id', p.alert_id,
          'workspace_id', p.workspace_id,
          'channel_id', p.channel_id,
          'kind', p.kind,
          'affected_principal_id', p.affected_principal_id,
          'affected_seat_name', p.affected_seat_name,
          'fix_hint', p.fix_hint,
          'waiting_count', p.waiting_count,
          'oldest_waiting_at', p.oldest_waiting_at,
          'routed_lead_principal_id', p.routed_lead_principal_id,
          'opened_at', p.opened_at,
          'escalated_at', p.escalated_at
        )
        ORDER BY p.escalated_at, p.alert_id
      ),
      '[]'::jsonb
    )
  INTO v_total, v_rows
  FROM page AS p;

  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id,
    'generated_at', v_read_at,
    'total', v_total,
    'truncated', v_total > 100,
    'alerts', v_rows
  );
END;
$$;

-- Update resolve_system_alert so resolving an agent_unseen alert also enforces conversation/audience scope.
CREATE OR REPLACE FUNCTION swarm.resolve_system_alert(
  p_workspace_id uuid,
  p_alert_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_actor_owner_user_id uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_peek record;
  v_row swarm.system_alerts%ROWTYPE;
  v_seat_name text;
  v_was_escalated boolean;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_workspace_id IS NULL OR p_alert_id IS NULL OR p_actor_id IS NULL
    OR p_actor_kind NOT IN ('agent', 'user')
    OR p_note IS NULL OR char_length(p_note) NOT BETWEEN 1 AND 500
    OR p_note <> btrim(p_note) OR p_note ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  -- Step 1: Read-only peek + authorization precheck BEFORE any lock wait.
  SELECT a.channel_id, a.conversation_id, a.source_signal_id, a.source_audience, a.affected_principal_id
  INTO v_peek
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.alert_id = p_alert_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  IF NOT swarm.system_alert_actor_can_resolve(
    p_workspace_id, v_peek.channel_id, v_peek.affected_principal_id, p_actor_kind, p_actor_id, p_actor_owner_user_id
  ) OR NOT swarm.system_alert_scope_accessible(
    p_workspace_id, v_peek.channel_id, v_peek.conversation_id, v_peek.source_signal_id, v_peek.source_audience, p_actor_kind, p_actor_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  -- Step 2: Acquire canonical Level 1/Level 2 scope lock, then Level 3 row lock FOR UPDATE.
  PERFORM swarm.system_alert_lock_scope_v2(p_workspace_id, v_peek.channel_id, v_peek.conversation_id);

  SELECT *
  INTO v_row
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.alert_id = p_alert_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  -- Step 3: Repeat authorization UNDER locks before returning already_resolved or writing.
  IF NOT swarm.system_alert_actor_can_resolve(
    p_workspace_id, v_row.channel_id, v_row.affected_principal_id, p_actor_kind, p_actor_id, p_actor_owner_user_id
  ) OR NOT swarm.system_alert_scope_accessible(
    p_workspace_id, v_row.channel_id, v_row.conversation_id, v_row.source_signal_id, v_row.source_audience, p_actor_kind, p_actor_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_resolved', 'channel_id', v_row.channel_id);
  END IF;

  v_was_escalated := (v_row.escalated_at IS NOT NULL);
  v_now := GREATEST(v_row.opened_at, clock_timestamp());

  UPDATE swarm.system_alerts
  SET resolved_at = v_now,
      resolved_by_kind = p_actor_kind,
      resolved_by_id = p_actor_id,
      resolution_note = p_note,
      updated_at = v_now
  WHERE alert_id = v_row.alert_id
  RETURNING * INTO v_row;

  SELECT p.name
  INTO v_seat_name
  FROM swarm.agent_principals AS p
  WHERE p.principal_id = v_row.affected_principal_id;

  RETURN jsonb_build_object(
    'outcome', 'resolved',
    'channel_id', v_row.channel_id,
    'alert', jsonb_build_object(
      'alert_id', v_row.alert_id,
      'workspace_id', v_row.workspace_id,
      'channel_id', v_row.channel_id,
      'kind', v_row.kind,
      'affected_principal_id', v_row.affected_principal_id,
      'affected_seat_name', v_seat_name,
      'fix_hint', v_row.fix_hint,
      'waiting_count', v_row.waiting_count,
      'oldest_waiting_at', v_row.oldest_waiting_at,
      'routed_lead_principal_id', v_row.routed_lead_principal_id,
      'opened_at', v_row.opened_at,
      'escalate_after', v_row.escalate_after,
      'escalated_at', v_row.escalated_at,
      'resolved_at', v_row.resolved_at,
      'resolved_by_kind', v_row.resolved_by_kind,
      'resolved_by_id', v_row.resolved_by_id,
      'resolution_note', v_row.resolution_note,
      'was_escalated', v_was_escalated
    )
  );
END;
$$;

-- 8. Wake targets v2: enforces conversation + message audience on lead, sender, and owners.
CREATE FUNCTION swarm.system_alert_wake_targets_v2(
  p_workspace uuid,
  p_channel uuid,
  p_conversation uuid,
  p_source_signal uuid,
  p_source_audience text,
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
  PERFORM swarm.system_alert_lock_scope_v2(p_workspace, p_channel, p_conversation);

  IF p_routed_lead IS NOT NULL
    AND swarm.system_alert_candidate_is_eligible(
      p_workspace, p_channel, p_routed_lead, p_affected, true
    )
    AND swarm.system_alert_agent_is_current_lead(
      p_workspace, p_channel, p_routed_lead, p_affected
    )
    AND swarm.system_alert_scope_accessible(
      p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'agent', p_routed_lead
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
    )
    AND swarm.system_alert_scope_accessible(
      p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'agent', p_sender_id
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
        AND swarm.system_alert_scope_accessible(
          p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'user', m.user_id
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
      AND swarm.system_alert_scope_accessible(
        p_workspace, p_channel, p_conversation, p_source_signal, p_source_audience, 'user', m.user_id
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
      NEW.conversation_id,
      NEW.source_signal_id,
      NEW.source_audience,
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

CREATE OR REPLACE FUNCTION swarm.notify_system_alert_escalate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_target record;
BEGIN
  IF NEW.resolved_at IS NOT NULL OR NEW.escalated_at IS NULL OR OLD.escalated_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  FOR v_target IN
    SELECT t.topic, t.event
    FROM swarm.system_alert_wake_targets_v2(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.conversation_id,
      NEW.source_signal_id,
      NEW.source_audience,
      NEW.affected_principal_id,
      NULL,
      true,
      NULL,
      NULL
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

CREATE OR REPLACE FUNCTION swarm.notify_system_alert_reroute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_target record;
BEGIN
  IF NEW.resolved_at IS NOT NULL OR NEW.routed_lead_principal_id IS NULL
    OR NEW.routed_lead_principal_id IS NOT DISTINCT FROM OLD.routed_lead_principal_id THEN
    RETURN NULL;
  END IF;
  FOR v_target IN
    SELECT t.topic, t.event
    FROM swarm.system_alert_wake_targets_v2(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.conversation_id,
      NEW.source_signal_id,
      NEW.source_audience,
      NEW.affected_principal_id,
      NEW.routed_lead_principal_id,
      false,
      NULL,
      NULL
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

-- 9. Server-only producer for one deduplicated agent_unseen alert per (seat, audience scope_key).
CREATE FUNCTION swarm.record_agent_unseen_alert(
  p_workspace_id uuid,
  p_affected_principal_id uuid,
  p_scope_key text,
  p_channel_id uuid,
  p_conversation_id uuid,
  p_source_signal_id uuid,
  p_source_audience text,
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
    OR p_scope_key IS NULL OR btrim(p_scope_key) = ''
    OR p_source_signal_id IS NULL
    OR p_source_audience NOT IN ('conversation', 'addressed')
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
  PERFORM swarm.system_alert_lock_scope_v2(p_workspace_id, p_channel_id, p_conversation_id);

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

  IF p_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM swarm.conversations AS conv
    WHERE conv.workspace_id = p_workspace_id
      AND conv.conversation_id = p_conversation_id
      AND conv.archived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- Per-(seat, scope_key) Level 3 advisory lock guarantees at most one open alert per audience scope.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'system_alert:' || p_workspace_id::text || ':agent_unseen:' || p_affected_principal_id::text || ':' || p_scope_key,
      0
    )
  );

  SELECT a.alert_id
  INTO v_existing_id
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.kind = 'agent_unseen'
    AND a.affected_principal_id = p_affected_principal_id
    AND a.scope_key = p_scope_key
    AND a.resolved_at IS NULL
  FOR UPDATE;

  v_opened := clock_timestamp();
  v_lead := swarm.system_alert_pick_lead_v2(
    p_workspace_id, p_channel_id, p_conversation_id, p_source_signal_id, p_source_audience, p_affected_principal_id
  );

  IF v_existing_id IS NOT NULL THEN
    UPDATE swarm.system_alerts AS a
    SET waiting_count = p_waiting_count,
        oldest_waiting_at = p_oldest_waiting_at,
        source_signal_id = p_source_signal_id,
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
            AND swarm.system_alert_scope_accessible(
              p_workspace_id, cur.channel_id, cur.conversation_id, p_source_signal_id, cur.source_audience,
              'agent', cur.routed_lead_principal_id
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
    conversation_id,
    source_signal_id,
    source_audience,
    scope_key,
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
    p_conversation_id,
    p_source_signal_id,
    p_source_audience,
    p_scope_key,
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

-- 10. Scope-specific predicate: does a seat still have ANY qualifying unseen ask, mention,
-- or to-do notice belonging to p_scope_key?
CREATE FUNCTION swarm.agent_has_unseen_ask_or_notice_in_scope(
  p_workspace_id uuid,
  p_principal_id uuid,
  p_scope_key text
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
    CROSS JOIN LATERAL swarm.agent_unseen_signal_scope(s.workspace_id, s.id) AS sc
    WHERE d.workspace_id = p_workspace_id
      AND d.recipient_agent_principal_id = p_principal_id
      AND (d.acked_at IS NULL OR d.ack_outcome = 'queued')
      AND NOT (s.from_kind = 'agent' AND s.from_principal = p_principal_id)
      AND sc.scope_key = p_scope_key
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

-- 11. Deadlock-free immediate per-scope auto-clear when the seat observes or views its unseen messages.
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
  v_open record;
  v_locked_id uuid;
  v_cleared integer := 0;
  v_now timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_principal_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_open IN
    SELECT a.alert_id, a.scope_key
    FROM swarm.system_alerts AS a
    WHERE a.workspace_id = p_workspace_id
      AND a.kind = 'agent_unseen'
      AND a.affected_principal_id = p_principal_id
      AND a.resolved_at IS NULL
    ORDER BY a.scope_key ASC, a.alert_id ASC
  LOOP
    IF v_open.scope_key IS NOT NULL
      AND swarm.agent_has_unseen_ask_or_notice_in_scope(p_workspace_id, p_principal_id, v_open.scope_key) THEN
      CONTINUE;
    END IF;

    SELECT a.alert_id
    INTO v_locked_id
    FROM swarm.system_alerts AS a
    WHERE a.alert_id = v_open.alert_id
      AND a.resolved_at IS NULL
    FOR UPDATE SKIP LOCKED;

    IF v_locked_id IS NULL THEN
      CONTINUE;
    END IF;

    v_now := clock_timestamp();
    UPDATE swarm.system_alerts
    SET resolved_at = GREATEST(opened_at, v_now),
        resolved_by_kind = 'agent',
        resolved_by_id = p_principal_id,
        resolution_note = 'Cleared automatically when the seat viewed its unseen messages.',
        updated_at = GREATEST(opened_at, v_now)
    WHERE alert_id = v_locked_id
      AND resolved_at IS NULL;

    v_cleared := v_cleared + 1;
  END LOOP;

  RETURN v_cleared;
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

-- 12. Periodic sync (swarm_admin only): raises 1 deduplicated agent_unseen alert per
-- (seat, canonical audience scope) for unseen asks, mentions, or to-do notices older than
-- p_unseen_after (including queued), and retires any open scope with no remaining unseen messages.
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
  v_conv uuid[];
  v_scope_key text[];
  v_source_signal uuid[];
  v_source_audience text[];
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

  -- Step 1: Collect qualifying unseen deliveries partitioned strictly by canonical audience scope.
  WITH unseen_rows AS (
    SELECT
      w.workspace_id,
      p.principal_id,
      sc.scope_key,
      sc.effective_channel_id,
      sc.conversation_id,
      sc.source_audience,
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
    CROSS JOIN LATERAL swarm.agent_unseen_signal_scope(s.workspace_id, s.id) AS sc
    WHERE (d.acked_at IS NULL OR d.ack_outcome = 'queued')
      AND d.enqueued_at <= v_now - p_unseen_after
      AND NOT (s.from_kind = 'agent' AND s.from_principal = p.principal_id)
      AND sc.scope_key IS NOT NULL
      AND sc.source_audience IS NOT NULL
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
  ), per_scope AS (
    SELECT
      u.workspace_id,
      u.principal_id,
      u.scope_key,
      count(*)::integer AS waiting_count,
      min(u.enqueued_at) AS oldest_waiting_at,
      (array_agg(u.effective_channel_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS channel_id,
      (array_agg(u.conversation_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS conversation_id,
      (array_agg(u.signal_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS source_signal_id,
      (array_agg(u.source_audience ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS source_audience,
      (array_agg(u.sender_kind ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS sender_kind,
      (array_agg(u.sender_id ORDER BY u.enqueued_at ASC, u.signal_id ASC))[1] AS sender_id
    FROM unseen_rows AS u
    GROUP BY u.workspace_id, u.principal_id, u.scope_key
  )
  SELECT
    array_agg(ps.workspace_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.channel_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.conversation_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.scope_key ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.source_signal_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.source_audience ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.principal_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.waiting_count ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.oldest_waiting_at ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.sender_kind ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC),
    array_agg(ps.sender_id ORDER BY ps.workspace_id ASC, COALESCE(ps.conversation_id, ps.channel_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC, ps.principal_id ASC, ps.scope_key ASC)
  INTO v_ws, v_ch, v_conv, v_scope_key, v_source_signal, v_source_audience, v_principal, v_waiting_count, v_oldest, v_sender_kind, v_sender_id
  FROM per_scope AS ps;

  IF v_ws IS NOT NULL AND pg_catalog.array_length(v_ws, 1) IS NOT NULL THEN
    PERFORM swarm.system_alert_lock_scopes_v2(v_ws, v_ch, v_conv);
    FOR v_idx IN 1..pg_catalog.array_length(v_ws, 1) LOOP
      v_alert_id := swarm.record_agent_unseen_alert(
        v_ws[v_idx],
        v_principal[v_idx],
        v_scope_key[v_idx],
        v_ch[v_idx],
        v_conv[v_idx],
        v_source_signal[v_idx],
        v_source_audience[v_idx],
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

  -- Step 2: Retire any open agent_unseen alert whose scope no longer has qualifying unseen messages.
  FOR v_open_rec IN
    SELECT DISTINCT a.workspace_id, a.affected_principal_id
    FROM swarm.system_alerts AS a
    WHERE a.kind = 'agent_unseen'
      AND a.resolved_at IS NULL
    ORDER BY a.workspace_id ASC, a.affected_principal_id ASC
  LOOP
    v_cleared := v_cleared + swarm.clear_agent_unseen_alert_if_seen(
      v_open_rec.workspace_id,
      v_open_rec.affected_principal_id
    );
  END LOOP;

  RETURN jsonb_build_object('synced', v_synced, 'cleared', v_cleared);
END;
$$;

-- 13. Ownership & least-privilege grants.
ALTER FUNCTION swarm.system_alert_validate_refs() OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_scope_immutable() OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_fix_hint(text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_scope_v2(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_scopes_v2(uuid[], uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.agent_unseen_signal_scope(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_scope_accessible(uuid, uuid, uuid, uuid, text, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_pick_lead_v2(uuid, uuid, uuid, uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_wake_targets_v2(uuid, uuid, uuid, uuid, text, uuid, uuid, boolean, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_agent_unseen_alert(uuid, uuid, text, uuid, uuid, uuid, text, integer, timestamptz, text, uuid, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.agent_has_unseen_ask_or_notice_in_scope(uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.clear_agent_unseen_alert_if_seen(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.trg_signal_deliveries_clear_agent_unseen() OWNER TO swarm_admin;
ALTER FUNCTION swarm.trg_signal_agent_receipts_clear_agent_unseen() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_agent_unseen_alerts(interval, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm_read.owner_alert_inbox(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.notify_system_alert_insert() OWNER TO postgres;
ALTER FUNCTION swarm.notify_system_alert_escalate() OWNER TO postgres;
ALTER FUNCTION swarm.notify_system_alert_reroute() OWNER TO postgres;

REVOKE ALL ON FUNCTION
  swarm.system_alert_validate_refs(),
  swarm.system_alert_scope_immutable(),
  swarm.system_alert_lock_scope_v2(uuid, uuid, uuid),
  swarm.system_alert_lock_scopes_v2(uuid[], uuid[], uuid[]),
  swarm.agent_unseen_signal_scope(uuid, uuid),
  swarm.system_alert_scope_accessible(uuid, uuid, uuid, uuid, text, text, uuid),
  swarm.system_alert_pick_lead_v2(uuid, uuid, uuid, uuid, text, uuid),
  swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid),
  swarm.system_alert_wake_targets_v2(uuid, uuid, uuid, uuid, text, uuid, uuid, boolean, text, uuid),
  swarm.record_agent_unseen_alert(uuid, uuid, text, uuid, uuid, uuid, text, integer, timestamptz, text, uuid, interval),
  swarm.agent_has_unseen_ask_or_notice_in_scope(uuid, uuid, text),
  swarm.clear_agent_unseen_alert_if_seen(uuid, uuid),
  swarm.trg_signal_deliveries_clear_agent_unseen(),
  swarm.trg_signal_agent_receipts_clear_agent_unseen(),
  swarm.sync_agent_unseen_alerts(interval, interval),
  swarm.notify_system_alert_insert(),
  swarm.notify_system_alert_escalate(),
  swarm.notify_system_alert_reroute()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION
  swarm.system_alert_claims_can_read_v2(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid)
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
