-- Lead system alerts (CS fcb99658): route seat health alerts (agent_quiet and verified access_lost)
-- to the live channel lead, falling back to the live workspace lead, with explicit resolution and
-- time-gated escalation to authorized workspace owners' inboxes only.
--
-- Security invariants:
--   1. Source scope (channel_id) is preserved on every alert row and never stripped on fallback.
--      Quiet-agent evidence excludes DMs, group DMs, addressed messages and replies to addressed
--      messages, and partitions by (workspace_id, affected_principal_id, channel_id) before counting
--      and deduping so a private alert never hides a public alert or discloses private activity.
--   2. Every lead candidate independently passes workspace membership, live owner, scope access,
--      listener liveness (at routing/wake time) and distinct-from-affected checks. Read, inbox,
--      resolve and wake recheck live actor authority from verified claims; an agent claim never
--      exercises human owner authority, and stale/demoted leads are refused.
--   3. Resolve and escalation lock the same alert row FOR UPDATE so a resolved alert never escalates
--      and repeated escalation passes never enqueue twice.
--   4. Direct table writes are denied to all client and edge roles. Internal producers are pinned:
--      record_system_alert / record_hosted_seat_refused_alerts / resolve_system_alert execute as
--      swarm_admin via swarm_command; sync_quiet_agent_alerts / escalate_due_system_alerts execute
--      only as swarm_admin. Escalation targets authorized human role='owner' inbox reads only
--      (never role='admin', never email).
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
-- and lead agents must pass the alert's channel scope check.
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
-- Verifies authoritative workspace, seat membership and channel scope before recording.
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
        routed_lead_principal_id = CASE
          WHEN a.routed_lead_principal_id IS NOT NULL
            AND swarm.system_alert_candidate_is_eligible(
              p_workspace_id, p_channel_id, a.routed_lead_principal_id, p_affected_principal_id, true
            )
            AND swarm.system_alert_agent_is_current_lead(
              p_workspace_id, p_channel_id, a.routed_lead_principal_id, p_affected_principal_id
            )
          THEN a.routed_lead_principal_id
          ELSE v_lead
        END,
        updated_at = v_opened
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
-- Requires an exact, unambiguous (provider_grant_id, owner_user_id) match and active workspace seats.
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
  v_rec record;
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

  FOR v_rec IN
    SELECT DISTINCT am.workspace_id, p.principal_id
    FROM swarm.hosted_mcp_grant_agents AS b
    JOIN swarm.agent_principals AS p
      ON p.principal_id = b.principal_id
     AND p.owner_user_id = p_owner_user_id
     AND p.revoked_at IS NULL
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id
     AND am.revoked_at IS NULL
    JOIN swarm.workspaces AS w
      ON w.workspace_id = am.workspace_id
     AND w.archived_at IS NULL
    WHERE b.grant_id = v_grant_id
      AND b.owner_user_id = p_owner_user_id
    ORDER BY am.workspace_id, p.principal_id
  LOOP
    IF swarm.record_system_alert(v_rec.workspace_id, 'hosted_seat_refused', v_rec.principal_id) IS NOT NULL THEN
      v_recorded := v_recorded + 1;
    END IF;
  END LOOP;
  RETURN v_recorded;
END;
$$;

-- Escalate unresolved open alerts whose threshold has elapsed. Locks rows FOR UPDATE in alert_id
-- order so concurrent resolution wins cleanly and repeated passes never escalate a row twice.
CREATE FUNCTION swarm.escalate_due_system_alerts()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH due AS (
    SELECT a.alert_id
    FROM swarm.system_alerts AS a
    WHERE a.resolved_at IS NULL
      AND a.escalated_at IS NULL
      AND a.escalate_after <= statement_timestamp()
    ORDER BY a.alert_id
    FOR UPDATE
  ), updated AS (
    UPDATE swarm.system_alerts AS a
    SET escalated_at = statement_timestamp(),
        updated_at = statement_timestamp()
    FROM due
    WHERE a.alert_id = due.alert_id
      AND a.resolved_at IS NULL
      AND a.escalated_at IS NULL
    RETURNING a.alert_id
  )
  SELECT count(*)::integer INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

-- Server-only quiet-agent sync (swarm_admin only). Partitions eligible non-DM, non-addressed
-- waiting deliveries by (workspace_id, affected_principal_id, channel_id) before counting and
-- opening alerts, then runs due escalations.
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
  v_rec record;
  v_synced integer := 0;
  v_escalated integer := 0;
BEGIN
  FOR v_rec IN
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
    )
    SELECT
      w.workspace_id,
      p.principal_id,
      s.channel_id,
      count(*)::integer AS waiting_count,
      min(d.enqueued_at) AS oldest_waiting_at
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
    WHERE ar.route_at IS NOT NULL
      AND ar.route_at < v_now - interval '3 minutes'
      AND ar.route_at > v_now - interval '24 hours'
      AND (ar.last_command_at IS NULL OR ar.last_command_at <= v_now - interval '10 minutes')
      AND NOT swarm.agent_listener_is_live(p.principal_id)
      -- Exclude DM, group DM, addressed signals and replies to addressed signals.
      AND s.to_user_id IS NULL
      AND s.to_agent_principal_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.signal_recipients AS sr
        WHERE sr.workspace_id = s.workspace_id
          AND sr.signal_id = s.id
      )
      AND (
        s.in_reply_to IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM swarm.signals AS ps
          WHERE ps.workspace_id = s.workspace_id
            AND ps.id = s.in_reply_to
            AND (
              ps.to_user_id IS NOT NULL
              OR ps.to_agent_principal_id IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM swarm.signal_recipients AS psr
                WHERE psr.workspace_id = ps.workspace_id
                  AND psr.signal_id = ps.id
              )
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM swarm.conversation_signals AS cs
        JOIN swarm.conversations AS conv
          ON conv.conversation_id = cs.conversation_id
         AND conv.workspace_id = cs.workspace_id
        WHERE cs.workspace_id = s.workspace_id
          AND cs.signal_id = s.id
          AND (cs.audience <> 'conversation' OR conv.kind IN ('dm', 'group_dm'))
      )
      AND (
        s.channel_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM swarm.channels AS ch
          WHERE ch.workspace_id = w.workspace_id
            AND ch.channel_id = s.channel_id
            AND ch.archived_at IS NULL
        )
      )
    GROUP BY w.workspace_id, p.principal_id, s.channel_id
    ORDER BY min(d.enqueued_at), w.workspace_id, p.principal_id, s.channel_id NULLS FIRST
  LOOP
    IF swarm.record_system_alert(
      v_rec.workspace_id,
      'agent_quiet',
      v_rec.principal_id,
      v_rec.channel_id,
      v_rec.waiting_count,
      v_rec.oldest_waiting_at,
      p_escalation_interval
    ) IS NOT NULL THEN
      v_synced := v_synced + 1;
    END IF;
  END LOOP;

  v_escalated := swarm.escalate_due_system_alerts();
  RETURN jsonb_build_object(
    'synced', v_synced,
    'escalated', v_escalated
  );
END;
$$;

-- Command-edge resolution entry point (swarm_command + swarm_admin only).
-- Locks the row FOR UPDATE to serialize against escalation, rechecks live actor authority and scope
-- (agent authority strictly separate from human owner authority), and returns uniform 'not_found'
-- for unknown, cross-workspace or unauthorized alert IDs while preserving channel_id for private
-- audit gating.
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
  v_row swarm.system_alerts%ROWTYPE;
  v_seat_name text;
  v_authorized boolean := false;
  v_was_escalated boolean;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_workspace_id IS NULL OR p_alert_id IS NULL OR p_actor_id IS NULL
    OR p_actor_kind NOT IN ('agent', 'user')
    OR p_note IS NULL OR char_length(p_note) NOT BETWEEN 1 AND 500
    OR p_note <> btrim(p_note) OR p_note ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  SELECT *
  INTO v_row
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.alert_id = p_alert_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', NULL);
  END IF;

  IF p_actor_kind = 'agent' THEN
    IF p_actor_owner_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS p
        WHERE p.principal_id = p_actor_id
          AND p.owner_user_id = p_actor_owner_user_id
          AND p.revoked_at IS NULL
      )
      AND swarm.system_alert_agent_is_current_lead(
        p_workspace_id, v_row.channel_id, p_actor_id, v_row.affected_principal_id
      ) THEN
      v_authorized := true;
    END IF;
  ELSE
    IF EXISTS (
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
      v_row.channel_id IS NULL
      OR swarm.actor_can_access_channel(p_workspace_id, v_row.channel_id, 'user', p_actor_id)
    ) THEN
      v_authorized := true;
    END IF;
  END IF;

  IF NOT v_authorized THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'channel_id', v_row.channel_id);
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

-- Internal command-edge helper for tagging audit_log.channel_ids on resolve retries/conflicts.
CREATE FUNCTION swarm.system_alert_audit_channel_id(
  p_workspace_id uuid,
  p_alert_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.channel_id
  FROM swarm.system_alerts AS a
  WHERE a.workspace_id = p_workspace_id
    AND a.alert_id = p_alert_id
  LIMIT 1;
$$;

ALTER FUNCTION swarm.system_alert_fix_hint(text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_candidate_is_eligible(uuid, uuid, uuid, uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_pick_lead(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_agent_is_current_lead(uuid, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_claims_can_read(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_hosted_seat_refused_alerts(text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.escalate_due_system_alerts() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_quiet_agent_alerts(interval) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.system_alert_audit_channel_id(uuid, uuid) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION
  swarm.system_alert_fix_hint(text),
  swarm.system_alert_candidate_is_eligible(uuid, uuid, uuid, uuid, boolean),
  swarm.system_alert_pick_lead(uuid, uuid, uuid),
  swarm.system_alert_agent_is_current_lead(uuid, uuid, uuid, uuid),
  swarm.system_alert_claims_can_read(uuid, uuid, uuid),
  swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval),
  swarm.record_hosted_seat_refused_alerts(text, uuid),
  swarm.escalate_due_system_alerts(),
  swarm.sync_quiet_agent_alerts(interval),
  swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text),
  swarm.system_alert_audit_channel_id(uuid, uuid)
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Pin producer and command roles strictly: only swarm_command gets its narrow edge entry points.
-- sync_quiet_agent_alerts and escalate_due_system_alerts remain swarm_admin-only.
GRANT EXECUTE ON FUNCTION
  swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval),
  swarm.record_hosted_seat_refused_alerts(text, uuid),
  swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text),
  swarm.system_alert_audit_channel_id(uuid, uuid)
TO swarm_command;

-- Content-free realtime wake triggers (revalidating live eligibility and scope at emit time).
-- Never emit resolution notes or alert text; never broadcast on the workspace-wide signal topic.
CREATE FUNCTION swarm.notify_system_alert_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_wake_id text;
  v_owner_id uuid;
BEGIN
  IF NEW.resolved_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NEW.routed_lead_principal_id IS NOT NULL
      AND swarm.system_alert_candidate_is_eligible(
        NEW.workspace_id, NEW.channel_id, NEW.routed_lead_principal_id, NEW.affected_principal_id, true
      )
      AND swarm.system_alert_agent_is_current_lead(
        NEW.workspace_id, NEW.channel_id, NEW.routed_lead_principal_id, NEW.affected_principal_id
      ) THEN
      SELECT p.wake_id
      INTO v_wake_id
      FROM swarm.agent_principals AS p
      WHERE p.principal_id = NEW.routed_lead_principal_id
        AND p.revoked_at IS NULL;
      IF v_wake_id IS NOT NULL THEN
        PERFORM realtime.send(
          pg_catalog.jsonb_build_object(
            'v', 1,
            'alert_id', NEW.alert_id,
            'enqueued_at', NEW.opened_at
          ),
          'wake',
          'cswarm-wake:' || v_wake_id,
          true
        );
      END IF;
    END IF;

    IF NEW.escalated_at IS NOT NULL THEN
      FOR v_owner_id IN
        SELECT m.user_id
        FROM swarm.memberships AS m
        JOIN swarm.workspaces AS w
          ON w.workspace_id = m.workspace_id
         AND w.archived_at IS NULL
        WHERE m.workspace_id = NEW.workspace_id
          AND m.revoked_at IS NULL
          AND m.role = 'owner'
          AND (
            NEW.channel_id IS NULL
            OR swarm.actor_can_access_channel(NEW.workspace_id, NEW.channel_id, 'user', m.user_id)
          )
      LOOP
        PERFORM realtime.send(
          pg_catalog.jsonb_build_object('v', 1),
          'signal',
          'cswarm-member:' || NEW.workspace_id::text || ':' || v_owner_id::text,
          true
        );
      END LOOP;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
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
  v_owner_id uuid;
BEGIN
  IF NEW.resolved_at IS NOT NULL OR NEW.escalated_at IS NULL OR OLD.escalated_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    FOR v_owner_id IN
      SELECT m.user_id
      FROM swarm.memberships AS m
      JOIN swarm.workspaces AS w
        ON w.workspace_id = m.workspace_id
       AND w.archived_at IS NULL
      WHERE m.workspace_id = NEW.workspace_id
        AND m.revoked_at IS NULL
        AND m.role = 'owner'
        AND (
          NEW.channel_id IS NULL
          OR swarm.actor_can_access_channel(NEW.workspace_id, NEW.channel_id, 'user', m.user_id)
        )
    LOOP
      PERFORM realtime.send(
        pg_catalog.jsonb_build_object('v', 1),
        'signal',
        'cswarm-member:' || NEW.workspace_id::text || ':' || v_owner_id::text,
        true
      );
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
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
  v_wake_id text;
BEGIN
  IF NEW.resolved_at IS NOT NULL OR NEW.routed_lead_principal_id IS NULL
    OR NEW.routed_lead_principal_id IS NOT DISTINCT FROM OLD.routed_lead_principal_id THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF swarm.system_alert_candidate_is_eligible(
      NEW.workspace_id, NEW.channel_id, NEW.routed_lead_principal_id, NEW.affected_principal_id, true
    ) AND swarm.system_alert_agent_is_current_lead(
      NEW.workspace_id, NEW.channel_id, NEW.routed_lead_principal_id, NEW.affected_principal_id
    ) THEN
      SELECT p.wake_id
      INTO v_wake_id
      FROM swarm.agent_principals AS p
      WHERE p.principal_id = NEW.routed_lead_principal_id
        AND p.revoked_at IS NULL;
      IF v_wake_id IS NOT NULL THEN
        PERFORM realtime.send(
          pg_catalog.jsonb_build_object(
            'v', 1,
            'alert_id', NEW.alert_id,
            'enqueued_at', NEW.updated_at
          ),
          'wake',
          'cswarm-wake:' || v_wake_id,
          true
        );
      END IF;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
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

RESET search_path;
