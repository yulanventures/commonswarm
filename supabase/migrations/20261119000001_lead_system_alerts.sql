-- Lead system alerts (CS fcb99658): route seat health alerts (agent_quiet and verified access_lost)
-- to the live channel lead, falling back to the live workspace lead, with explicit resolution and
-- time-gated escalation to authorized workspace owners' inboxes only.
--
-- Security invariants:
--   1. Source scope (channel_id) is preserved on every alert row and never stripped on fallback.
--      Quiet-agent sync resolves canonical placement from swarm.conversation_signals /
--      swarm.conversations, excludes DMs, group DMs, addressed messages, addressed thread roots
--      and chain/reply history, and partitions by (workspace_id, affected_principal_id, scope)
--      before counting and deduping so a private alert never hides a public alert or discloses
--      private activity.
--   2. Every lead candidate independently passes workspace membership, live owner, scope access,
--      listener liveness (at routing/wake time) and distinct-from-affected checks. Read, inbox,
--      resolve and wake recheck live actor authority from verified claims; an agent claim never
--      exercises human owner authority, and stale/demoted leads are refused.
--   3. Wake emission, alert writes, resolution and escalation acquire the canonical scope lock
--      order (conversations FOR SHARE -> channel-access shared -> conversation-frames shared ->
--      system_alerts FOR UPDATE) so concurrent membership removals and public-to-private
--      conversions serialize cleanly without late wakes or stale resolves, and resolve/escalation
--      serialize on the same alert row. Wake frames carry bare {"v": 1}.
--   4. Direct table writes are denied to all client and edge roles. Internal producers are pinned:
--      record_system_alert / record_hosted_seat_refused_alerts / resolve_system_alert execute as
--      swarm_admin via swarm_command; sync_quiet_agent_alerts / escalate_due_system_alerts execute
--      only as swarm_admin (scheduled via pg_cron). Only the claims-bound view predicate
--      system_alert_claims_can_read is granted to authenticated and swarm_read. Escalation targets
--      authorized human role='owner' inbox reads only (never role='admin', never email).
--   5. Hidden and unknown alerts return identical refusal metadata (channel_id NULL) so fresh
--      resolve probes produce identical HTTP 404 and identical audit_log visibility.
--
-- Rollback: deploy/release-proofs/lead-system-alerts/20261119000001-rollback.sql.
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.system_alerts (
  alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  channel_id uuid,
  kind text NOT NULL CHECK (
    kind IN (
      'agent_quiet',
      'local_renewal_superseded',
      'local_credential_revoked',
      'hosted_seat_refused',
      'hosted_family_retired'
    )
  ),
  affected_principal_id uuid NOT NULL REFERENCES swarm.agent_principals (principal_id),
  fix_hint text NOT NULL CHECK (char_length(fix_hint) BETWEEN 1 AND 300),
  waiting_count integer CHECK (waiting_count IS NULL OR waiting_count > 0),
  oldest_waiting_at timestamptz,
  routed_lead_principal_id uuid REFERENCES swarm.agent_principals (principal_id),
  routed_at timestamptz,
  opened_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  escalate_after timestamptz NOT NULL,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolved_by_kind text CHECK (resolved_by_kind IS NULL OR resolved_by_kind IN ('agent', 'user')),
  resolved_by_id uuid,
  resolution_note text CHECK (
    resolution_note IS NULL
    OR (
      char_length(resolution_note) BETWEEN 1 AND 500
      AND resolution_note = btrim(resolution_note)
      AND resolution_note !~ '[[:cntrl:]]'
    )
  ),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES swarm.channels (channel_id, workspace_id),
  CHECK (routed_lead_principal_id IS NULL OR routed_lead_principal_id <> affected_principal_id),
  CHECK (routed_at IS NULL OR routed_at >= opened_at),
  CHECK ((kind = 'agent_quiet') = (waiting_count IS NOT NULL AND oldest_waiting_at IS NOT NULL)),
  CHECK (escalate_after >= opened_at),
  CHECK (escalated_at IS NULL OR escalated_at >= opened_at),
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at),
  CHECK (
    (resolved_at IS NULL) = (resolved_by_kind IS NULL)
    AND (resolved_at IS NULL) = (resolved_by_id IS NULL)
    AND (resolved_at IS NULL) = (resolution_note IS NULL)
  )
);

-- Open-alert dedupe includes scope (channel_id vs workspace-general NULL), so a hidden private
-- alert never suppresses an otherwise visible alert in another scope.
CREATE UNIQUE INDEX system_alerts_open_scope_unique
  ON swarm.system_alerts (
    workspace_id,
    kind,
    affected_principal_id,
    COALESCE(channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE resolved_at IS NULL;

CREATE INDEX system_alerts_workspace_open
  ON swarm.system_alerts (workspace_id, opened_at, alert_id)
  WHERE resolved_at IS NULL;

CREATE INDEX system_alerts_escalation_due
  ON swarm.system_alerts (escalate_after, alert_id)
  WHERE resolved_at IS NULL AND escalated_at IS NULL;

CREATE INDEX system_alerts_routed_lead_open
  ON swarm.system_alerts (routed_lead_principal_id, workspace_id, opened_at, alert_id)
  WHERE resolved_at IS NULL AND routed_lead_principal_id IS NOT NULL;

ALTER TABLE swarm.system_alerts OWNER TO swarm_admin;
ALTER TABLE swarm.system_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.system_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_admin_all ON swarm.system_alerts
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.system_alerts
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Static server-authored fix hints per allowlisted kind.
CREATE FUNCTION swarm.system_alert_fix_hint(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'agent_quiet' THEN
      'Restart its listener on its host (cswarm inbox --notify) or check the host is awake.'
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

-- Canonical shared authorization fence matching swarm.signal_frame_readers and the served
-- channel/workspace writers (20261118000005_conversations_commands.sql):
--   Level 1: swarm.conversations FOR SHARE (ordered by conversation_id ASC for multi-scope)
--   Level 2: conversation-frames advisory lock shared (ordered by workspace_id, channel_id ASC)
--   Level 3: system_alerts per-alert advisory lock / FOR UPDATE row lock (ordered by alert_id ASC)
-- Never acquires channel-access (which served channel_update acquires BEFORE channels ->
-- conversations), eliminating any lock-order inversion deadlock with served channel updates.
CREATE FUNCTION swarm.system_alert_lock_scope(p_workspace uuid, p_channel uuid)
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
      WHEN p_channel IS NULL THEN c.kind = 'general'
      ELSE c.conversation_id = p_channel
    END
  FOR SHARE;
  IF p_channel IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('conversation-frames:' || p_workspace::text || ':' || p_channel::text, 0)
    );
  END IF;
END;
$$;

-- Multi-scope canonical pre-lock for batch timers and multi-workspace producers.
-- Acquires ALL Level 1 conversation locks in conversation_id ASC order (matching
-- swarm.conversation_lock_workspace) and then ALL Level 2 conversation-frames locks in
-- (workspace_id, channel_id) ASC order BEFORE any swarm.system_alerts row lock is taken.
CREATE FUNCTION swarm.system_alert_lock_scopes(p_workspaces uuid[], p_channels uuid[])
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
    FROM unnest(p_workspaces, p_channels) AS s(ws_id, ch_id)
    JOIN swarm.conversations AS conv
      ON conv.workspace_id = s.ws_id
     AND CASE
       WHEN s.ch_id IS NULL THEN conv.kind = 'general'
       ELSE conv.conversation_id = s.ch_id
     END
    WHERE s.ws_id IS NOT NULL
  )
  ORDER BY c.conversation_id ASC
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

-- Serialize private-channel agent removals and channel visibility/lead updates behind the same
-- Level 2 conversation-frames advisory lock as user removals (20261118000005:1090).
-- Trigger on swarm.channels is named alphabetically AFTER channels_sync_conversation so served
-- channel updates ALWAYS take Level 1 (conversations) before Level 2 (conversation-frames).
CREATE FUNCTION swarm.system_alert_lock_agent_member_frames()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('conversation-frames:' || OLD.workspace_id::text || ':' || OLD.channel_id::text, 0)
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION swarm.system_alert_lock_channel_frames()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('conversation-frames:' || NEW.workspace_id::text || ':' || NEW.channel_id::text, 0)
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER channel_members_lock_agent_frames
  AFTER DELETE ON swarm.channel_members
  FOR EACH ROW WHEN (OLD.member_kind = 'agent')
  EXECUTE FUNCTION swarm.system_alert_lock_agent_member_frames();

CREATE TRIGGER channels_sync_conversation_frames
  AFTER UPDATE OF visibility, archived_at, lead_mode, lead_agent_principal_id ON swarm.channels
  FOR EACH ROW
  EXECUTE FUNCTION swarm.system_alert_lock_channel_frames();

-- Independent eligibility check for one candidate lead on one alert scope.
CREATE FUNCTION swarm.system_alert_candidate_is_eligible(
  p_workspace uuid,
  p_channel uuid,
  p_candidate uuid,
  p_affected uuid,
  p_require_listener boolean
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF p_workspace IS NULL OR p_candidate IS NULL OR p_candidate IS NOT DISTINCT FROM p_affected THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM swarm.agent_principals AS p
    JOIN swarm.workspaces AS w
      ON w.workspace_id = p_workspace
     AND w.archived_at IS NULL
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id
     AND am.workspace_id = p_workspace
     AND am.revoked_at IS NULL
    JOIN swarm.memberships AS owner_m
      ON owner_m.workspace_id = p_workspace
     AND owner_m.user_id = p.owner_user_id
     AND owner_m.revoked_at IS NULL
    WHERE p.principal_id = p_candidate
      AND p.revoked_at IS NULL
      AND p.transport = 'local'
      AND NOT p.turn_only
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.agent_join_credentials AS j
        WHERE j.registrar_principal_id = p.principal_id
      )
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN false;
  END IF;
  IF p_channel IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM swarm.channels AS c
      WHERE c.workspace_id = p_workspace
        AND c.channel_id = p_channel
        AND c.archived_at IS NULL
    ) INTO v_ok;
    IF NOT v_ok OR NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', p_candidate) THEN
      RETURN false;
    END IF;
  END IF;
  IF p_require_listener AND NOT swarm.agent_listener_is_live(p_candidate) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Choose the live lead for an alert: channel lead (when configured as 'agent'), falling back to
-- workspace lead. Every candidate independently checks workspace membership, scope access,
-- listener liveness and distinct-from-affected. Never drops p_channel.
CREATE FUNCTION swarm.system_alert_pick_lead(
  p_workspace uuid,
  p_channel uuid,
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
    ) THEN
    RETURN v_workspace_lead;
  END IF;
  RETURN NULL;
END;
$$;

-- True only if p_agent is CURRENTLY a live, eligible lead for (p_workspace, p_channel) and not the
-- affected seat itself. Refuses stale, demoted, or removed leads immediately.
CREATE FUNCTION swarm.system_alert_agent_is_current_lead(
  p_workspace uuid,
  p_channel uuid,
  p_agent uuid,
  p_affected uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_is_lead boolean := false;
BEGIN
  IF NOT swarm.system_alert_candidate_is_eligible(
    p_workspace, p_channel, p_agent, p_affected, false
  ) THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    WHERE w.workspace_id = p_workspace
      AND w.archived_at IS NULL
      AND w.lead_agent_principal_id = p_agent
  ) OR (
    p_channel IS NOT NULL AND EXISTS (
      SELECT 1
      FROM swarm.channels AS c
      WHERE c.workspace_id = p_workspace
        AND c.channel_id = p_channel
        AND c.archived_at IS NULL
        AND c.lead_mode = 'agent'
        AND c.lead_agent_principal_id = p_agent
    )
  ) INTO v_is_lead;
  RETURN v_is_lead;
END;
$$;

-- Read gate for swarm_read.system_alerts: derives actor strictly from verified JWT claims.
-- Agent claims use agent authority ONLY (never human owner authority). Both humans (owners/admins)
-- and lead agents must pass the alert's channel scope check. Granted ONLY to authenticated and
-- swarm_read so selecting swarm_read.system_alerts works under both reader roles.
CREATE FUNCTION swarm.system_alert_claims_can_read(
  p_workspace uuid,
  p_channel uuid,
  p_affected uuid
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
  IF p_workspace IS NULL OR v_claims IS NULL
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
    IF NOT EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS p
      WHERE p.principal_id = v_agent
        AND p.owner_user_id = v_user
        AND p.revoked_at IS NULL
    ) THEN
      RETURN false;
    END IF;
    RETURN swarm.system_alert_agent_is_current_lead(p_workspace, p_channel, v_agent, p_affected);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace
      AND m.user_id = v_user
      AND m.revoked_at IS NULL
      AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN false;
  END IF;
  IF p_channel IS NOT NULL
    AND NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'user', v_user) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Trusted server-only producer entry point (swarm_command + swarm_admin only).
-- Acquires canonical scope lock before checking channel/lead eligibility and writing alert row.
CREATE FUNCTION swarm.record_system_alert(
  p_workspace_id uuid,
  p_kind text,
  p_affected_principal_id uuid,
  p_channel_id uuid DEFAULT NULL,
  p_waiting_count integer DEFAULT NULL,
  p_oldest_waiting_at timestamptz DEFAULT NULL,
  p_escalation_interval interval DEFAULT interval '30 minutes'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_fix_hint text;
  v_scope_key text;
  v_existing_id uuid;
  v_lead uuid;
  v_opened timestamptz := statement_timestamp();
  v_escalate_after timestamptz;
  v_escalated_at timestamptz;
  v_alert_id uuid;
BEGIN
  v_fix_hint := swarm.system_alert_fix_hint(p_kind);
  IF p_workspace_id IS NULL OR p_affected_principal_id IS NULL OR v_fix_hint IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_escalation_interval IS NULL
    OR p_escalation_interval < interval '0 seconds'
    OR p_escalation_interval > interval '24 hours' THEN
    RETURN NULL;
  END IF;
  IF p_kind = 'agent_quiet' THEN
    IF p_waiting_count IS NULL OR p_waiting_count <= 0 OR p_oldest_waiting_at IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    IF p_waiting_count IS NOT NULL OR p_oldest_waiting_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Acquire canonical scope lock BEFORE reading channel visibility/lead or locking alert row.
  PERFORM swarm.system_alert_lock_scope(p_workspace_id, p_channel_id);

  -- Require authoritative unarchived workspace and active seat membership in that workspace.
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    JOIN swarm.agent_workspace_memberships AS am
      ON am.workspace_id = w.workspace_id
     AND am.principal_id = p_affected_principal_id
     AND am.revoked_at IS NULL
    JOIN swarm.agent_principals AS p
      ON p.principal_id = am.principal_id
    WHERE w.workspace_id = p_workspace_id
      AND w.archived_at IS NULL
      AND (p_kind = 'local_credential_revoked' OR p.revoked_at IS NULL)
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

  v_scope_key := COALESCE(p_channel_id::text, '00000000-0000-0000-0000-000000000000');
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'system_alert:' || p_workspace_id::text || ':' || p_kind || ':' || p_affected_principal_id::text || ':' || v_scope_key,
      0
    )
  );

  SELECT a.alert_id
  INTO v_existing_id
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.kind = p_kind
    AND a.affected_principal_id = p_affected_principal_id
    AND a.channel_id IS NOT DISTINCT FROM p_channel_id
    AND a.resolved_at IS NULL
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    v_lead := swarm.system_alert_pick_lead(p_workspace_id, p_channel_id, p_affected_principal_id);
    UPDATE swarm.system_alerts AS a
    SET waiting_count = CASE WHEN p_kind = 'agent_quiet' THEN p_waiting_count ELSE a.waiting_count END,
        oldest_waiting_at = CASE WHEN p_kind = 'agent_quiet'
          THEN LEAST(a.oldest_waiting_at, p_oldest_waiting_at) ELSE a.oldest_waiting_at END,
        routed_lead_principal_id = next_route.next_lead,
        routed_at = CASE
          WHEN next_route.next_lead IS DISTINCT FROM a.routed_lead_principal_id THEN
            CASE WHEN next_route.next_lead IS NOT NULL THEN v_opened ELSE NULL END
          ELSE a.routed_at
        END,
        updated_at = v_opened
    FROM (
      SELECT
        CASE
          WHEN cur.routed_lead_principal_id IS NOT NULL
            AND swarm.system_alert_candidate_is_eligible(
              p_workspace_id, p_channel_id, cur.routed_lead_principal_id, p_affected_principal_id, true
            )
            AND swarm.system_alert_agent_is_current_lead(
              p_workspace_id, p_channel_id, cur.routed_lead_principal_id, p_affected_principal_id
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

  v_lead := swarm.system_alert_pick_lead(p_workspace_id, p_channel_id, p_affected_principal_id);
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
    updated_at
  ) VALUES (
    p_workspace_id,
    p_channel_id,
    p_kind,
    p_affected_principal_id,
    v_fix_hint,
    p_waiting_count,
    p_oldest_waiting_at,
    v_lead,
    CASE WHEN v_lead IS NOT NULL THEN v_opened ELSE NULL END,
    v_opened,
    v_escalate_after,
    v_escalated_at,
    v_opened
  )
  RETURNING alert_id INTO v_alert_id;

  RETURN v_alert_id;
END;
$$;

-- Exact-grant hosted refusal producer (swarm_command + swarm_admin only).
-- Tied strictly to live seats bound to THIS grant and THIS grant-approved workspace, excluding
-- seats already actively serving on a live replacement grant (requiring live hosted_mcp_seats
-- AND live hosted_mcp_seat_handles, matching swarm.resolve_hosted_seat_command_authorization).
CREATE FUNCTION swarm.record_hosted_seat_refused_alerts(
  p_provider_grant_id text,
  p_owner_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_grant_id uuid;
  v_match_count integer;
  v_ws_ids uuid[];
  v_principal_ids uuid[];
  v_null_channels uuid[];
  v_idx integer;
  v_recorded integer := 0;
BEGIN
  IF p_provider_grant_id IS NULL OR char_length(p_provider_grant_id) < 16 OR p_owner_user_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*)::integer, min(g.grant_id::text)::uuid
  INTO v_match_count, v_grant_id
  FROM swarm.hosted_mcp_grants AS g
  WHERE g.provider_grant_id = p_provider_grant_id
    AND g.owner_user_id = p_owner_user_id;
  IF v_match_count <> 1 OR v_grant_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT
    array_agg(t.workspace_id ORDER BY t.workspace_id, t.principal_id),
    array_agg(t.principal_id ORDER BY t.workspace_id, t.principal_id),
    array_agg(NULL::uuid ORDER BY t.workspace_id, t.principal_id)
  INTO v_ws_ids, v_principal_ids, v_null_channels
  FROM (
    SELECT DISTINCT hs.workspace_id, hs.principal_id
    FROM swarm.hosted_mcp_seats AS hs
    JOIN swarm.agent_principals AS p
      ON p.principal_id = hs.principal_id
     AND p.owner_user_id = p_owner_user_id
     AND p.revoked_at IS NULL
     AND p.transport = 'hosted_mcp'
    JOIN swarm.workspaces AS w
      ON w.workspace_id = hs.workspace_id
     AND w.archived_at IS NULL
    JOIN swarm.memberships AS m
      ON m.workspace_id = hs.workspace_id
     AND m.user_id = p_owner_user_id
     AND m.revoked_at IS NULL
    WHERE hs.grant_id = v_grant_id
      AND hs.owner_user_id = p_owner_user_id
      AND hs.revoked_at IS NULL
      AND swarm.hosted_binding_eligible(v_grant_id, hs.workspace_id, hs.principal_id)
      -- Exclude superseded bindings ONLY when the seat already has an actively serving replacement
      -- grant in this workspace (live grant + live seat + live handle + no tombstones).
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.hosted_mcp_grants AS lg
        JOIN swarm.hosted_mcp_seats AS ls
          ON ls.grant_id = lg.grant_id
         AND ls.owner_user_id = lg.owner_user_id
         AND ls.workspace_id = hs.workspace_id
         AND ls.principal_id = hs.principal_id
         AND ls.revoked_at IS NULL
        JOIN swarm.hosted_mcp_seat_handles AS lh
          ON lh.seat_id = ls.seat_id
         AND lh.grant_id = ls.grant_id
         AND lh.workspace_id = ls.workspace_id
         AND lh.principal_id = ls.principal_id
         AND lh.revoked_at IS NULL
        WHERE lg.owner_user_id = p_owner_user_id
          AND lg.grant_id <> v_grant_id
          AND lg.state = 'active'
          AND lg.revoked_at IS NULL
          AND lg.connection_expired_at IS NULL
          AND (lg.connection_expires_at IS NULL OR lg.connection_expires_at > clock_timestamp())
          AND swarm.hosted_binding_eligible(lg.grant_id, ls.workspace_id, ls.principal_id)
          AND NOT EXISTS (
            SELECT 1
            FROM commonswarm_oauth.refresh_family_tombstones AS rf
            WHERE rf.grant_id = lg.provider_grant_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM swarm.revocation_tombstones AS rt
            WHERE (rt.kind = 'membership' AND rt.target_id = ls.owner_user_id)
               OR (rt.kind = 'principal' AND rt.target_id = ls.principal_id)
               OR (rt.kind = 'hosted_grant' AND rt.target_id = ls.grant_id)
               OR (rt.kind = 'hosted_seat' AND rt.target_id = ls.seat_id)
          )
      )
  ) AS t;

  IF v_ws_ids IS NULL OR pg_catalog.array_length(v_ws_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- Pre-lock all affected workspace #general conversations in conversation_id ASC order
  -- BEFORE acquiring any system_alerts row locks.
  PERFORM swarm.system_alert_lock_scopes(v_ws_ids, v_null_channels);

  FOR v_idx IN 1..pg_catalog.array_length(v_ws_ids, 1) LOOP
    IF swarm.record_system_alert(v_ws_ids[v_idx], 'hosted_seat_refused', v_principal_ids[v_idx]) IS NOT NULL THEN
      v_recorded := v_recorded + 1;
    END IF;
  END LOOP;
  RETURN v_recorded;
END;
$$;

-- Escalate unresolved open alerts whose threshold has elapsed.
-- Pre-locks ALL affected scopes in canonical order (Level 1 conversations ASC -> Level 2
-- conversation-frames ASC) BEFORE acquiring ANY Level 3 system_alerts row locks (alert_id ASC),
-- preventing any multi-scope lock inversion with workspace removal or channel updates.
CREATE FUNCTION swarm.escalate_due_system_alerts()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_alert_ids uuid[];
  v_ws_ids uuid[];
  v_ch_ids uuid[];
  v_idx integer;
  v_count integer := 0;
  v_updated integer;
  v_now timestamptz := statement_timestamp();
BEGIN
  SELECT
    array_agg(a.alert_id ORDER BY a.alert_id),
    array_agg(a.workspace_id ORDER BY a.alert_id),
    array_agg(a.channel_id ORDER BY a.alert_id)
  INTO v_alert_ids, v_ws_ids, v_ch_ids
  FROM swarm.system_alerts AS a
  WHERE a.resolved_at IS NULL
    AND a.escalated_at IS NULL
    AND a.escalate_after <= v_now;

  IF v_alert_ids IS NULL OR pg_catalog.array_length(v_alert_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM swarm.system_alert_lock_scopes(v_ws_ids, v_ch_ids);

  FOR v_idx IN 1..pg_catalog.array_length(v_alert_ids, 1) LOOP
    UPDATE swarm.system_alerts AS a
    SET escalated_at = v_now,
        updated_at = v_now
    WHERE a.alert_id = v_alert_ids[v_idx]
      AND a.resolved_at IS NULL
      AND a.escalated_at IS NULL
      AND a.escalate_after <= v_now;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_count := v_count + v_updated;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Server-only quiet-agent sync (swarm_admin only). Derives canonical scope from conversation
-- placement (swarm.conversation_signals / swarm.conversations) so replies with inherited private
-- placement never bucket under workspace-general, excludes DMs, group DMs, addressed messages,
-- addressed roots and chain/legacy-thread history, then partitions by (workspace, principal, scope).
-- Pre-locks ALL scopes for BOTH quiet alerts AND due escalations in canonical global order
-- BEFORE acquiring ANY Level 3 system_alerts row lock.
CREATE FUNCTION swarm.sync_quiet_agent_alerts(
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
  v_q_ws uuid[];
  v_q_principal uuid[];
  v_q_ch uuid[];
  v_q_count integer[];
  v_q_oldest timestamptz[];
  v_due_ids uuid[];
  v_due_ws uuid[];
  v_due_ch uuid[];
  v_all_ws uuid[];
  v_all_ch uuid[];
  v_idx integer;
  v_synced integer := 0;
  v_escalated integer := 0;
  v_updated integer;
BEGIN
  WITH agent_route AS (
    SELECT
      am.principal_id,
      max(GREATEST(pr.watcher_at, pr.channel_at, pr.listener_at)) AS route_at,
      max(pr.last_command_at) AS last_command_at
    FROM swarm.agent_workspace_memberships AS am
    JOIN swarm.agent_presence AS pr
      ON pr.workspace_id = am.workspace_id
     AND pr.principal_id = am.principal_id
    GROUP BY am.principal_id
  ), eligible_evidence AS (
    SELECT
      w.workspace_id,
      p.principal_id,
      CASE
        WHEN cs.signal_id IS NOT NULL THEN conv.channel_id
        ELSE s.channel_id
      END AS effective_channel_id,
      d.enqueued_at
    FROM agent_route AS ar
    JOIN swarm.agent_principals AS p
      ON p.principal_id = ar.principal_id
     AND p.revoked_at IS NULL
     AND p.transport <> 'hosted_mcp'
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id
     AND am.revoked_at IS NULL
    JOIN swarm.workspaces AS w
      ON w.workspace_id = am.workspace_id
     AND w.archived_at IS NULL
    JOIN swarm.memberships AS owner_m
      ON owner_m.workspace_id = w.workspace_id
     AND owner_m.user_id = p.owner_user_id
     AND owner_m.revoked_at IS NULL
    JOIN swarm.signal_deliveries AS d
      ON d.recipient_agent_principal_id = p.principal_id
     AND d.workspace_id = w.workspace_id
     AND d.acked_at IS NULL
     AND d.enqueued_at <= v_now - interval '10 minutes'
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
    WHERE ar.route_at IS NOT NULL
      AND ar.route_at < v_now - interval '3 minutes'
      AND ar.route_at > v_now - interval '24 hours'
      AND (ar.last_command_at IS NULL OR ar.last_command_at <= v_now - interval '10 minutes')
      AND NOT swarm.agent_listener_is_live(p.principal_id)
      -- Signal itself must be unaddressed and outside private reply/chain predicates.
      AND s.to_user_id IS NULL
      AND s.to_agent_principal_id IS NULL
      AND s.in_reply_to IS NULL
      AND s.parent_signal_id IS NULL
      AND s.chain_root_id IS NULL
      AND s.chain_participants IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.signal_recipients AS sr
        WHERE sr.workspace_id = s.workspace_id
          AND sr.signal_id = s.id
      )
      -- Canonical conversation placement & audience rule:
      --   * Mapped: require conversation-wide audience in general/public_channel/private_channel.
      --   * Unmapped legacy history: exclude thread replies completely (only top-level unaddressed).
      AND (
        (
          cs.signal_id IS NOT NULL
          AND cs.audience = 'conversation'
          AND conv.kind IN ('general', 'public_channel', 'private_channel')
          AND conv.archived_at IS NULL
        )
        OR (
          cs.signal_id IS NULL
          AND s.thread_root_id IS NULL
        )
      )
      -- Thread replies must inherit from an unaddressed, non-chain, conversation-wide root.
      AND (
        s.thread_root_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM swarm.signals AS root
          LEFT JOIN swarm.conversation_signals AS rcs
            ON rcs.workspace_id = root.workspace_id
           AND rcs.signal_id = root.id
          LEFT JOIN swarm.conversations AS rconv
            ON rconv.conversation_id = rcs.conversation_id
           AND rconv.workspace_id = rcs.workspace_id
          WHERE root.workspace_id = s.workspace_id
            AND root.id = s.thread_root_id
            AND root.to_user_id IS NULL
            AND root.to_agent_principal_id IS NULL
            AND root.in_reply_to IS NULL
            AND root.parent_signal_id IS NULL
            AND root.chain_root_id IS NULL
            AND root.chain_participants IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM swarm.signal_recipients AS rr
              WHERE rr.workspace_id = root.workspace_id
                AND rr.signal_id = root.id
            )
            AND (
              rcs.signal_id IS NULL
              OR (
                rcs.audience = 'conversation'
                AND rconv.kind IN ('general', 'public_channel', 'private_channel')
              )
            )
        )
      )
  ), grouped AS (
    SELECT
      e.workspace_id,
      e.principal_id,
      e.effective_channel_id AS channel_id,
      count(*)::integer AS waiting_count,
      min(e.enqueued_at) AS oldest_waiting_at
    FROM eligible_evidence AS e
    WHERE e.effective_channel_id IS NULL
       OR EXISTS (
         SELECT 1
         FROM swarm.channels AS ch
         WHERE ch.workspace_id = e.workspace_id
           AND ch.channel_id = e.effective_channel_id
           AND ch.archived_at IS NULL
       )
    GROUP BY e.workspace_id, e.principal_id, e.effective_channel_id
  )
  SELECT
    array_agg(g.workspace_id ORDER BY g.workspace_id, g.channel_id NULLS FIRST, g.principal_id),
    array_agg(g.principal_id ORDER BY g.workspace_id, g.channel_id NULLS FIRST, g.principal_id),
    array_agg(g.channel_id ORDER BY g.workspace_id, g.channel_id NULLS FIRST, g.principal_id),
    array_agg(g.waiting_count ORDER BY g.workspace_id, g.channel_id NULLS FIRST, g.principal_id),
    array_agg(g.oldest_waiting_at ORDER BY g.workspace_id, g.channel_id NULLS FIRST, g.principal_id)
  INTO v_q_ws, v_q_principal, v_q_ch, v_q_count, v_q_oldest
  FROM grouped AS g;

  SELECT
    array_agg(a.alert_id ORDER BY a.alert_id),
    array_agg(a.workspace_id ORDER BY a.alert_id),
    array_agg(a.channel_id ORDER BY a.alert_id)
  INTO v_due_ids, v_due_ws, v_due_ch
  FROM swarm.system_alerts AS a
  WHERE a.resolved_at IS NULL
    AND a.escalated_at IS NULL
    AND a.escalate_after <= v_now;

  v_all_ws := COALESCE(v_q_ws, ARRAY[]::uuid[]) || COALESCE(v_due_ws, ARRAY[]::uuid[]);
  v_all_ch := COALESCE(v_q_ch, ARRAY[]::uuid[]) || COALESCE(v_due_ch, ARRAY[]::uuid[]);

  -- Lock ALL Level 1 conversations (ORDER BY conversation_id ASC) and Level 2 conversation-frames
  -- (ORDER BY workspace_id, channel_id ASC) BEFORE touching any swarm.system_alerts row.
  PERFORM swarm.system_alert_lock_scopes(v_all_ws, v_all_ch);

  IF v_q_ws IS NOT NULL AND pg_catalog.array_length(v_q_ws, 1) IS NOT NULL THEN
    FOR v_idx IN 1..pg_catalog.array_length(v_q_ws, 1) LOOP
      IF swarm.record_system_alert(
        v_q_ws[v_idx],
        'agent_quiet',
        v_q_principal[v_idx],
        v_q_ch[v_idx],
        v_q_count[v_idx],
        v_q_oldest[v_idx],
        p_escalation_interval
      ) IS NOT NULL THEN
        v_synced := v_synced + 1;
      END IF;
    END LOOP;
  END IF;

  -- Escalate pre-collected due alerts (and any newly opened 0-second alerts in the already-locked
  -- scopes) in strict alert_id ASC order without acquiring any new Level 1/Level 2 locks.
  IF v_due_ids IS NOT NULL AND pg_catalog.array_length(v_due_ids, 1) IS NOT NULL THEN
    FOR v_idx IN 1..pg_catalog.array_length(v_due_ids, 1) LOOP
      UPDATE swarm.system_alerts AS a
      SET escalated_at = v_now,
          updated_at = v_now
      WHERE a.alert_id = v_due_ids[v_idx]
        AND a.resolved_at IS NULL
        AND a.escalated_at IS NULL
        AND a.escalate_after <= v_now;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      v_escalated := v_escalated + v_updated;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'synced', v_synced,
    'escalated', v_escalated
  );
END;
$$;

-- Read-only authorization predicate for alert resolution, invoked both as a precheck BEFORE
-- taking any alert-specific or scope locks (preventing lock-contention oracles on hidden private
-- alerts) and again AFTER acquiring the canonical scope and alert row locks.
CREATE FUNCTION swarm.system_alert_actor_can_resolve(
  p_workspace_id uuid,
  p_channel_id uuid,
  p_affected_principal_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_actor_owner_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_actor_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_actor_kind = 'agent' THEN
    RETURN p_actor_owner_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS p
        WHERE p.principal_id = p_actor_id
          AND p.owner_user_id = p_actor_owner_user_id
          AND p.revoked_at IS NULL
      )
      AND swarm.system_alert_agent_is_current_lead(
        p_workspace_id, p_channel_id, p_actor_id, p_affected_principal_id
      );
  ELSIF p_actor_kind = 'user' THEN
    RETURN EXISTS (
      SELECT 1
      FROM swarm.workspaces AS w
      JOIN swarm.memberships AS m
        ON m.workspace_id = w.workspace_id
       AND m.user_id = p_actor_id
       AND m.revoked_at IS NULL
       AND m.role IN ('owner', 'admin')
      WHERE w.workspace_id = p_workspace_id
        AND w.archived_at IS NULL
    ) AND (
      p_channel_id IS NULL
      OR swarm.actor_can_access_channel(p_workspace_id, p_channel_id, 'user', p_actor_id)
    );
  END IF;
  RETURN false;
END;
$$;

-- Command-edge resolution entry point (swarm_command + swarm_admin only).
-- Performs a read-only actor and scope precheck BEFORE acquiring any scope or alert locks so
-- unauthorized probes against hidden private alerts never wait on contention or surface lock
-- timeouts, then acquires canonical scope + alert row locks and repeats authorization before
-- returning already_resolved or updating the alert. Returns uniform not_found with channel_id NULL.
CREATE FUNCTION swarm.resolve_system_alert(
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
  v_peek_channel uuid;
  v_peek_affected uuid;
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

  -- Step 1: Read-only peek (no locks) + read-only authorization precheck BEFORE any wait.
  SELECT a.channel_id, a.affected_principal_id
  INTO v_peek_channel, v_peek_affected
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.alert_id = p_alert_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  IF NOT swarm.system_alert_actor_can_resolve(
    p_workspace_id, v_peek_channel, v_peek_affected, p_actor_kind, p_actor_id, p_actor_owner_user_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  -- Step 2: Acquire canonical Level 1/Level 2 scope lock, then Level 3 row lock FOR UPDATE.
  PERFORM swarm.system_alert_lock_scope(p_workspace_id, v_peek_channel);

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
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_resolved', 'channel_id', v_row.channel_id);
  END IF;

  v_was_escalated := (v_row.escalated_at IS NOT NULL);

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

-- Compute authorized realtime wake targets under the canonical scope lock (swarm_admin-owned,
-- matching swarm.signal_frame_readers). Only the realtime.send() call itself is wrapped in a
-- failure-swallowing block inside the postgres-owned triggers.
CREATE FUNCTION swarm.system_alert_wake_targets(
  p_workspace uuid,
  p_channel uuid,
  p_affected uuid,
  p_routed_lead uuid,
  p_include_owners boolean
)
RETURNS TABLE (topic text, event text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wake_id text;
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

ALTER FUNCTION swarm.system_alert_fix_hint(text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_scope(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_scopes(uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_agent_member_frames() OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_lock_channel_frames() OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_candidate_is_eligible(uuid, uuid, uuid, uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_pick_lead(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_agent_is_current_lead(uuid, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_actor_can_resolve(uuid, uuid, uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_claims_can_read(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_wake_targets(uuid, uuid, uuid, uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_hosted_seat_refused_alerts(text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.escalate_due_system_alerts() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_quiet_agent_alerts(interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION
  swarm.system_alert_fix_hint(text),
  swarm.system_alert_lock_scope(uuid, uuid),
  swarm.system_alert_lock_scopes(uuid[], uuid[]),
  swarm.system_alert_lock_agent_member_frames(),
  swarm.system_alert_lock_channel_frames(),
  swarm.system_alert_candidate_is_eligible(uuid, uuid, uuid, uuid, boolean),
  swarm.system_alert_pick_lead(uuid, uuid, uuid),
  swarm.system_alert_agent_is_current_lead(uuid, uuid, uuid, uuid),
  swarm.system_alert_actor_can_resolve(uuid, uuid, uuid, text, uuid, uuid),
  swarm.system_alert_claims_can_read(uuid, uuid, uuid),
  swarm.system_alert_wake_targets(uuid, uuid, uuid, uuid, boolean),
  swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval),
  swarm.record_hosted_seat_refused_alerts(text, uuid),
  swarm.escalate_due_system_alerts(),
  swarm.sync_quiet_agent_alerts(interval),
  swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text)
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Narrow reader grant for swarm_read.system_alerts view predicate ONLY.
GRANT EXECUTE ON FUNCTION
  swarm.system_alert_claims_can_read(uuid, uuid, uuid)
TO authenticated, swarm_read;

-- Pin producer and command roles strictly: only swarm_command gets its narrow edge entry points.
-- sync_quiet_agent_alerts and escalate_due_system_alerts remain swarm_admin-only.
GRANT EXECUTE ON FUNCTION
  swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval),
  swarm.record_hosted_seat_refused_alerts(text, uuid),
  swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text)
TO swarm_command;

-- Minimal content-free realtime wake triggers ({"v": 1} only) serialized behind the canonical
-- scope lock so concurrent membership removals or public-to-private conversions never leave a
-- late wake frame. Targets are resolved OUTSIDE the swallow block so privilege errors surface.
CREATE FUNCTION swarm.notify_system_alert_insert()
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
    FROM swarm.system_alert_wake_targets(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.affected_principal_id,
      NEW.routed_lead_principal_id,
      NEW.escalated_at IS NOT NULL
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

CREATE FUNCTION swarm.notify_system_alert_escalate()
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
    FROM swarm.system_alert_wake_targets(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.affected_principal_id,
      NULL,
      true
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

CREATE FUNCTION swarm.notify_system_alert_reroute()
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
    FROM swarm.system_alert_wake_targets(
      NEW.workspace_id,
      NEW.channel_id,
      NEW.affected_principal_id,
      NEW.routed_lead_principal_id,
      false
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

ALTER FUNCTION swarm.notify_system_alert_insert() OWNER TO postgres;
ALTER FUNCTION swarm.notify_system_alert_escalate() OWNER TO postgres;
ALTER FUNCTION swarm.notify_system_alert_reroute() OWNER TO postgres;
REVOKE ALL ON FUNCTION
  swarm.notify_system_alert_insert(),
  swarm.notify_system_alert_escalate(),
  swarm.notify_system_alert_reroute()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE TRIGGER system_alerts_notify_insert
  AFTER INSERT ON swarm.system_alerts
  FOR EACH ROW EXECUTE FUNCTION swarm.notify_system_alert_insert();

CREATE TRIGGER system_alerts_notify_escalate
  AFTER UPDATE OF escalated_at ON swarm.system_alerts
  FOR EACH ROW
  WHEN (OLD.escalated_at IS NULL AND NEW.escalated_at IS NOT NULL AND NEW.resolved_at IS NULL)
  EXECUTE FUNCTION swarm.notify_system_alert_escalate();

CREATE TRIGGER system_alerts_notify_reroute
  AFTER UPDATE OF routed_lead_principal_id ON swarm.system_alerts
  FOR EACH ROW
  WHEN (OLD.routed_lead_principal_id IS DISTINCT FROM NEW.routed_lead_principal_id
    AND NEW.routed_lead_principal_id IS NOT NULL AND NEW.resolved_at IS NULL)
  EXECUTE FUNCTION swarm.notify_system_alert_reroute();

-- Authorized seat-health alerts view (owners/admins with scope access, or current live channel/workspace lead).
CREATE VIEW swarm_read.system_alerts
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
    a.resolution_note
  FROM swarm.system_alerts AS a
  JOIN swarm.agent_principals AS p
    ON p.principal_id = a.affected_principal_id
  WHERE swarm.system_alert_claims_can_read(a.workspace_id, a.channel_id, a.affected_principal_id);

ALTER VIEW swarm_read.system_alerts OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.system_alerts TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.system_alerts FROM PUBLIC, anon;

-- Sole owner escalation destination: authorized human workspace role='owner' inbox only.
-- Workspace admins, ordinary members, non-member owners of private channels, and agent tokens
-- are excluded (admins/non-owners/agents receive NULL; non-member owners never see private alerts).
-- Escalation previews intentionally omit resolution_note.
CREATE FUNCTION swarm_read.owner_alert_inbox(p_workspace_id uuid)
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
      AND (
        a.channel_id IS NULL
        OR swarm.actor_can_access_channel(a.workspace_id, a.channel_id, 'user', v_viewer)
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

ALTER FUNCTION swarm_read.owner_alert_inbox(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.owner_alert_inbox(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.owner_alert_inbox(uuid) TO authenticated, swarm_read;

-- Schedule quiet-agent sync and due-alert escalation every 2 minutes inside PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'swarm-sync-system-alerts',
  '*/2 * * * *',
  $$SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes')$$
);

RESET search_path;
