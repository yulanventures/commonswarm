-- Migration source mirrored in 20261001000003_admin_recovery_read.sql.
-- Human JWT claims are installed by the read edge; no caller-selected
-- account ID, no admin/worker credentials, and no direct private-table grants.
CREATE FUNCTION swarm_read.admin_recovery_page(
  p_resource text, p_workspace_id uuid, p_limit integer, p_before text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  viewer uuid := auth.uid();
  workspace_owner boolean := false;
  before_time timestamptz;
  before_id uuid;
  page jsonb;
  active_summary jsonb;
  cursor text;
BEGIN
  IF viewer IS NULL OR p_resource NOT IN ('admin_grants', 'admin_history')
     OR p_resource IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_before IS NOT NULL THEN
    IF p_before !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\|[0-9a-fA-F-]{36}$' THEN
      RETURN jsonb_build_object('error', 'forbidden');
    END IF;
    BEGIN
      before_time := split_part(p_before, '|', 1)::timestamptz;
      before_id := split_part(p_before, '|', 2)::uuid;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RETURN jsonb_build_object('error', 'forbidden');
    END;
  END IF;
  IF p_workspace_id IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM swarm.memberships m
      WHERE m.workspace_id = p_workspace_id AND m.user_id = viewer
        AND m.role = 'owner' AND m.revoked_at IS NULL) INTO workspace_owner;
    -- Grantors retain their own history/recovery after membership loss or archive.
    -- Other people need a current workspace-owner role. Unknown IDs disclose nothing.
    IF NOT workspace_owner AND NOT EXISTS (
      SELECT 1 FROM swarm.admin_grants g WHERE g.owner_user_id = viewer
        AND p_workspace_id = ANY(g.workspace_ids)
    ) AND NOT EXISTS (
      SELECT 1 FROM swarm.admin_created_workspaces c JOIN swarm.admin_grants g USING (grant_id)
      WHERE c.workspace_id = p_workspace_id AND g.owner_user_id = viewer
    ) AND NOT EXISTS (
      SELECT 1 FROM swarm.admin_events e WHERE e.owner_user_id = viewer
        AND e.event->>'type' = 'AdminActionRecorded'
        AND e.event->'payload'->>'workspace_id' = p_workspace_id::text
    ) THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  END IF;

  -- Aggregate all matching live grants, independently of the page/cursor.
  -- Workspace owners receive only this indicator and workspace action cards,
  -- never another person's grant manifest, other targets, or account-only audit.
  SELECT jsonb_build_object(
    'grant_count', count(*),
    'full_account_count', count(*) FILTER (WHERE g.mode = 'full_account' AND g.owner_user_id = viewer),
    'expires_at', to_char(min(g.expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'full_account_expires_at', to_char(min(g.expires_at) FILTER (WHERE g.mode = 'full_account' AND g.owner_user_id = viewer) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO active_summary
  FROM swarm.admin_grants g
  WHERE g.state = 'active' AND g.revoked_at IS NULL AND g.suspended_at IS NULL
    AND g.expires_at > statement_timestamp() AND g.refresh_deadline > statement_timestamp()
    AND (g.owner_user_id = viewer OR (p_workspace_id IS NOT NULL AND workspace_owner))
    AND (p_workspace_id IS NULL OR (
      NOT (p_workspace_id = ANY(g.withdrawn_workspace_ids)) AND (
        p_workspace_id = ANY(g.workspace_ids) OR (g.workspace_selector = 'owned_and_selected' AND EXISTS (
          SELECT 1 FROM swarm.memberships own WHERE own.workspace_id = p_workspace_id
            AND own.user_id = g.owner_user_id AND own.role = 'owner' AND own.revoked_at IS NULL
        )) OR EXISTS (
          SELECT 1 FROM swarm.admin_created_workspaces c
          WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
        )
      )
      -- Created-space permission is limited by both the original association
      -- and the current narrowed policy, even for a full-account grant.
      AND NOT EXISTS (
        SELECT 1 FROM swarm.admin_created_workspaces c
        WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(g.created_workspace_policy->'scope_names') AS s(scope)
            WHERE s.scope = ANY(c.scope_names) AND s.scope = ANY(g.scope_names)
          )
      )
    ));

  IF p_resource = 'admin_grants' THEN
    WITH candidates AS (
      SELECT g.* FROM swarm.admin_grants g
      WHERE g.owner_user_id = viewer AND (p_workspace_id IS NULL OR
        p_workspace_id = ANY(g.workspace_ids) OR (g.workspace_selector = 'owned_and_selected' AND EXISTS (
          SELECT 1 FROM swarm.memberships own WHERE own.workspace_id = p_workspace_id
            AND own.user_id = viewer AND own.role = 'owner' AND own.revoked_at IS NULL
        )) OR EXISTS (
          SELECT 1 FROM swarm.admin_created_workspaces c
          WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
        ))
        AND (p_before IS NULL OR (g.created_at, g.grant_id) < (before_time, before_id))
      ORDER BY g.created_at DESC, g.grant_id DESC LIMIT p_limit + 1
    ), numbered AS (
      SELECT g.*, row_number() OVER (ORDER BY created_at DESC, grant_id DESC) AS n FROM candidates g
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grant_id', grant_id, 'admin_identity_id', admin_identity_id, 'connection_id', connection_id,
      'client_id', client_id, 'mode', mode, 'scope_names', scope_names,
      'workspace_selector', workspace_selector, 'workspace_ids', workspace_ids,
      'withdrawn_workspace_ids', withdrawn_workspace_ids,
      'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expires_at', to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'state', CASE WHEN state = 'active' AND (expires_at <= statement_timestamp() OR refresh_deadline <= statement_timestamp()) THEN 'expired' ELSE state END,
      'reason_code', left(reason_code, 80)
    ) ORDER BY created_at DESC, grant_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
    CASE WHEN count(*) > p_limit THEN max(to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || grant_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
    INTO page, cursor FROM numbered;
    RETURN jsonb_build_object('grants', page, 'actions', '[]'::jsonb, 'next_before', cursor, 'active', active_summary);
  END IF;

  -- Lane C emits one AdminActionRecorded per routine attempt, including
  -- creation, provisioning, replacement, renewal, invitations and revocation.
  -- Linked domain event IDs retain provenance without duplicating cards or
  -- returning domain payloads (recipient data, names or credential metadata).
  WITH candidates AS (
    SELECT e.*, to_timestamp((e.event->>'occurred_at_server')::numeric / 1000) AS at
    FROM swarm.admin_events e
    WHERE e.event->>'type' = 'AdminActionRecorded'
      AND ((p_workspace_id IS NULL AND e.owner_user_id = viewer) OR
        (p_workspace_id IS NOT NULL AND e.event->'payload'->>'workspace_id' = p_workspace_id::text
          AND (e.owner_user_id = viewer OR workspace_owner)))
      AND (p_before IS NULL OR (to_timestamp((e.event->>'occurred_at_server')::numeric / 1000), e.event_id) < (before_time, before_id))
    ORDER BY at DESC, e.event_id DESC LIMIT p_limit + 1
  ), numbered AS (
    SELECT e.*, row_number() OVER (ORDER BY at DESC, event_id DESC) AS n FROM candidates e
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'seq', seq::text, 'event_id', event_id,
    'occurred_at_server', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grant_id', event->'grant_id', 'admin_identity_id', event->'admin_identity_id',
    'actor_user', event->'actor_user',
    'action', left(event->'payload'->>'action', 80),
    'target_kind', left(event->'payload'->>'target_kind', 80),
    'target_id', left(event->'payload'->>'target_id', 128),
    'workspace_id', event->'payload'->'workspace_id',
    'outcome', event->'payload'->'outcome', 'reason_code', left(event->'payload'->>'reason_code', 80),
    'next_action', left(event->'payload'->>'next_action', 2048),
    'recovery_kind', left(event->'payload'->>'recovery_kind', 80),
    'related_event_ids', coalesce((SELECT jsonb_agg(ref) FROM
      (SELECT ref FROM jsonb_array_elements(event->'payload'->'related_event_ids') AS ref LIMIT 100) bounded), '[]'::jsonb)
  ) ORDER BY at DESC, event_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
  CASE WHEN count(*) > p_limit THEN max(to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || event_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
  INTO page, cursor FROM numbered;
  RETURN jsonb_build_object('grants', '[]'::jsonb, 'actions', page, 'next_before', cursor, 'active', active_summary);
END
$fn$;
ALTER FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) TO swarm_read;

-- Reserve rollback (verbatim SQL retained in
-- admin-delegation-reserve/20261001000003-rollback.sql):
-- DROP FUNCTION IF EXISTS swarm_read.admin_recovery_page(text, uuid, integer, text);
