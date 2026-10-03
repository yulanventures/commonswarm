-- Account-owner recovery fields; retain existing workspace indicators/history.
-- Current read projection: 20261003000005. Read-only; issuance remains OFF.
-- The read edge installs verified human claims; the definer needs no auth schema.
-- No caller-selected account ID, admin/worker credentials or private-table grants.
CREATE OR REPLACE FUNCTION swarm_read.admin_recovery_page(
  p_resource text, p_workspace_id uuid, p_limit integer, p_before text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  viewer uuid := NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
  workspace_owner boolean := false;
  before_time timestamptz;
  before_id uuid;
  page jsonb;
  active_summary jsonb;
  cursor text;
  live_grant_ids uuid[] := '{}';
BEGIN
  IF viewer IS NULL OR p_resource NOT IN ('admin_grants', 'admin_history', 'admin_clients', 'admin_workers', 'admin_coverage')
     OR p_resource IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_resource='admin_clients' AND p_workspace_id IS NOT NULL THEN RETURN jsonb_build_object('error','forbidden'); END IF;
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


  -- Reuse the durable family/verification/approval/key predicate. A grant
  -- without a committed issuance cannot provide effective coverage or workers.
  IF p_resource IN ('admin_grants','admin_workers','admin_coverage') THEN
    SELECT coalesce(array_agg(b.admin_grant_id),'{}'::uuid[]) INTO live_grant_ids
    FROM commonswarm_oauth.admin_grant_bindings b WHERE b.owner_user_id=viewer AND EXISTS(
      SELECT 1 FROM commonswarm_oauth.admin_access_issuances i
      CROSS JOIN LATERAL commonswarm_oauth.resolve_admin_grant_status(b.provider_grant_id,viewer,i.kid) status
      WHERE i.provider_grant_id=b.provider_grant_id AND status.active);
  END IF;

  IF p_resource IN ('admin_clients','admin_workers','admin_coverage') THEN
    WITH items AS (
      SELECT date_trunc('milliseconds',v.reviewed_at) AS at,
        md5(v.client_id || '|' || v.verification_version::text)::uuid AS id,
        jsonb_build_object('client_id',v.client_id,'publisher_identity',v.publisher_identity,
      'verification_version',v.verification_version,'active',v.active,'reviewed_at',v.reviewed_at,
      'withdrawn_at',v.withdrawn_at,'metadata_digest',v.metadata_digest,'approval',(SELECT jsonb_build_object('owner_user_id',a.owner_user_id,'verification_version',a.verification_version,
      'approved_at',a.approved_at,'approval_event_id',a.approval_event_id,'approval_command_id',a.approval_command_id,
      'withdrawn_at',a.withdrawn_at,'withdrawal_event_id',a.withdrawal_event_id,'withdrawal_reason',a.withdrawal_reason)
      FROM commonswarm_oauth.admin_client_owner_approvals a
      WHERE a.owner_user_id=viewer AND a.client_id=v.client_id AND a.verification_version=v.verification_version),
      'reapproval_required',v.active AND NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals a
        WHERE a.owner_user_id=viewer AND a.client_id=v.client_id AND a.verification_version=v.verification_version AND a.withdrawn_at IS NULL)) AS value
      FROM commonswarm_oauth.admin_verified_clients v
      WHERE p_resource='admin_clients' AND p_workspace_id IS NULL
      UNION ALL
      SELECT date_trunc('milliseconds',p.created_at),p.principal_id,
        jsonb_build_object('principal_id',p.principal_id,'grant_id',g.grant_id,'workspace_id',p.workspace_id,
          'created_at',p.created_at,'revoked_at',p.revoked_at,
          'state',CASE WHEN p.revoked_at IS NOT NULL OR NOT (g.grant_id=ANY(live_grant_ids) AND swarm.admin_child_live(g.grant_id,p.workspace_id)) THEN 'stopped' ELSE 'active' END)
      FROM swarm.agent_principals p JOIN swarm.admin_grants g ON g.grant_id=p.parent_admin_grant_id
      WHERE p_resource='admin_workers' AND g.owner_user_id=viewer
        AND (p_workspace_id IS NULL OR p.workspace_id=p_workspace_id)
      UNION ALL
      SELECT date_trunc('milliseconds',w.created_at),md5(g.grant_id::text||'|'||w.workspace_id::text)::uuid,
        jsonb_build_object('workspace_id',w.workspace_id,'grant_id',g.grant_id)
      FROM swarm.workspaces w CROSS JOIN swarm.admin_grants g
      WHERE p_resource='admin_coverage' AND w.archived_at IS NULL AND g.owner_user_id=viewer
        AND (p_workspace_id IS NULL OR w.workspace_id=p_workspace_id)
        AND g.grant_id=ANY(live_grant_ids) AND swarm.admin_child_live(g.grant_id,w.workspace_id)
    ), candidates AS (
      SELECT * FROM items WHERE p_before IS NULL OR (at,id)<(before_time,before_id)
      ORDER BY at DESC,id DESC LIMIT p_limit+1
    ), numbered AS (
      SELECT *,row_number() OVER(ORDER BY at DESC,id DESC) AS n FROM candidates
    ) SELECT coalesce(jsonb_agg(value ORDER BY at DESC,id DESC) FILTER(WHERE n<=p_limit),'[]'::jsonb),
      CASE WHEN count(*)>p_limit THEN max(to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||id::text) FILTER(WHERE n=p_limit) END
      INTO page,cursor FROM numbered;
    RETURN jsonb_build_object('grants','[]'::jsonb,'actions','[]'::jsonb,
      'clients',CASE WHEN p_resource='admin_clients' THEN page ELSE '[]'::jsonb END,
      'workers',CASE WHEN p_resource='admin_workers' THEN page ELSE '[]'::jsonb END,
      'coverage',CASE WHEN p_resource='admin_coverage' THEN page ELSE '[]'::jsonb END,
      'next_before',cursor,'active',active_summary,'renewal','client-initiated');
  END IF;

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
        AND (p_before IS NULL OR (date_trunc('milliseconds',g.created_at), g.grant_id) < (before_time, before_id))
      ORDER BY date_trunc('milliseconds',g.created_at) DESC, g.grant_id DESC LIMIT p_limit + 1
    ), numbered AS (
      SELECT g.*, row_number() OVER (ORDER BY date_trunc('milliseconds',created_at) DESC, grant_id DESC) AS n FROM candidates g
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grant_id', grant_id, 'admin_identity_id', admin_identity_id, 'connection_id', connection_id,
      'owner_user_id',owner_user_id,'refresh_deadline',refresh_deadline,
      'registry_version',registry_version,'capability_names',coalesce((SELECT b.capabilities FROM commonswarm_oauth.admin_grant_bindings b WHERE b.admin_grant_id=g.grant_id),ARRAY(SELECT jsonb_array_elements_text(c.manifest->'capability_names') FROM swarm.admin_consents c WHERE c.consent_receipt_id=g.consent_receipt_id AND c.owner_user_id=viewer)),
      'availability_digest',coalesce((SELECT b.availability_digest FROM commonswarm_oauth.admin_grant_bindings b WHERE b.admin_grant_id=g.grant_id),(SELECT c.manifest->>'availability_digest' FROM swarm.admin_consents c WHERE c.consent_receipt_id=g.consent_receipt_id AND c.owner_user_id=viewer)),
      'manifest_digest',manifest_digest,
      'created_workspace_policy',jsonb_build_object('scope_names',created_workspace_policy->'scope_names'),
      'target_rules',jsonb_build_object('seat_ids',target_rules->'seat_ids','own_seats',target_rules->'own_seats',
        'grant_created_seats',target_rules->'grant_created_seats','recipient_user_ids',target_rules->'recipient_user_ids',
        'recipient_connection_ids',target_rules->'recipient_connection_ids','transports',target_rules->'transports'),
      'worker_scope_ceiling',worker_scope_ceiling,'role_ceiling',role_ceiling,
      'renewal_limits',jsonb_build_object('grant_kinds',renewal_limits->'grant_kinds','principal_ids',renewal_limits->'principal_ids',
        'bearer_seconds',renewal_limits->'bearer_seconds','horizon_seconds',renewal_limits->'horizon_seconds',
        'successors_per_worker',renewal_limits->'successors_per_worker','successors_per_grant',renewal_limits->'successors_per_grant'),
      'issuance_limits',jsonb_build_object('workspaces',issuance_limits->'workspaces','live_seats',issuance_limits->'live_seats',
        'total_seats',issuance_limits->'total_seats','invitations',issuance_limits->'invitations',
        'live_agent_invitations',issuance_limits->'live_agent_invitations','worker_credentials',issuance_limits->'worker_credentials',
        'connection_attempts',issuance_limits->'connection_attempts'),
      'client',(SELECT jsonb_build_object('client_id',v.client_id,'publisher_identity',v.publisher_identity,
      'verification_version',v.verification_version,'active',v.active,'reviewed_at',v.reviewed_at,
      'withdrawn_at',v.withdrawn_at,'metadata_digest',v.metadata_digest,'approval',(SELECT jsonb_build_object('owner_user_id',a.owner_user_id,'verification_version',a.verification_version,
      'approved_at',a.approved_at,'approval_event_id',a.approval_event_id,'approval_command_id',a.approval_command_id,
      'withdrawn_at',a.withdrawn_at,'withdrawal_event_id',a.withdrawal_event_id,'withdrawal_reason',a.withdrawal_reason)
      FROM commonswarm_oauth.admin_client_owner_approvals a
      WHERE a.owner_user_id=viewer AND a.client_id=v.client_id AND a.verification_version=v.verification_version),
      'reapproval_required',v.active AND NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals a
        WHERE a.owner_user_id=viewer AND a.client_id=v.client_id AND a.verification_version=v.verification_version AND a.withdrawn_at IS NULL)) FROM commonswarm_oauth.admin_grant_bindings b JOIN commonswarm_oauth.admin_verified_clients v
        ON v.client_id=b.client_id AND v.verification_version=b.verification_version WHERE b.admin_grant_id=g.grant_id),
      'family',(SELECT jsonb_build_object('provider_grant_id',b.provider_grant_id,
        'state',CASE WHEN t.grant_id IS NOT NULL THEN 'revoked' WHEN b.expires_at<=statement_timestamp() OR b.refresh_deadline<=statement_timestamp() THEN 'expired' ELSE b.state END)
        FROM commonswarm_oauth.admin_grant_bindings b LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=b.provider_grant_id
        WHERE b.admin_grant_id=g.grant_id),
      'issuance_status',CASE WHEN EXISTS(SELECT 1 FROM commonswarm_oauth.admin_access_issuances i WHERE i.admin_grant_id=g.grant_id) THEN 'committed' ELSE 'unknown' END,
      'last_use_at',(SELECT max(a.occurred_at) FROM commonswarm_oauth.admin_oauth_audit a WHERE a.admin_grant_id=g.grant_id AND a.event_kind IN ('init','list','read','action') AND a.outcome='committed'),
      'replaces_grant_id',(SELECT (e.event->'payload'->>'replaces_grant_id')::uuid FROM swarm.admin_events e
        WHERE e.owner_user_id=viewer AND e.event->>'type'='AdminDelegationGranted' AND e.event->>'grant_id'=g.grant_id::text ORDER BY e.seq DESC LIMIT 1),
      'worker_count',(SELECT count(*) FROM swarm.agent_principals p WHERE p.parent_admin_grant_id=g.grant_id),
      'coverage_count',(SELECT count(*) FROM swarm.workspaces w WHERE w.archived_at IS NULL AND g.grant_id=ANY(live_grant_ids) AND swarm.admin_child_live(g.grant_id,w.workspace_id)),
      'client_id', client_id, 'mode', mode, 'scope_names', scope_names,
      'workspace_selector', workspace_selector, 'workspace_ids', workspace_ids,
      'withdrawn_workspace_ids', withdrawn_workspace_ids,
      'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expires_at', to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'state', CASE WHEN state = 'active' AND (expires_at <= statement_timestamp() OR refresh_deadline <= statement_timestamp()) THEN 'expired' ELSE state END,
      'reason_code', left(reason_code, 80)
    ) ORDER BY date_trunc('milliseconds',created_at) DESC, grant_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
    CASE WHEN count(*) > p_limit THEN max(to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || grant_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
    INTO page, cursor FROM numbered g;
    RETURN jsonb_build_object('grants', page, 'actions', '[]'::jsonb, 'next_before', cursor, 'active', active_summary, 'clients','[]'::jsonb,'workers','[]'::jsonb,'coverage','[]'::jsonb,'renewal','client-initiated');
  END IF;

  -- Lane C emits one AdminActionRecorded per routine attempt, including
  -- creation, provisioning, replacement, renewal, invitations and revocation.
  -- Linked domain event IDs retain provenance without duplicating cards or
  -- returning domain payloads (recipient data, names or credential metadata).
  WITH candidates AS (
    SELECT e.*, date_trunc('milliseconds',to_timestamp((e.event->>'occurred_at_server')::numeric / 1000)) AS at
    FROM swarm.admin_events e
    WHERE e.event->>'type' = 'AdminActionRecorded'
      AND ((p_workspace_id IS NULL AND e.owner_user_id = viewer) OR
        (p_workspace_id IS NOT NULL AND e.event->'payload'->>'workspace_id' = p_workspace_id::text
          AND (e.owner_user_id = viewer OR workspace_owner)))
      AND (p_before IS NULL OR (date_trunc('milliseconds',to_timestamp((e.event->>'occurred_at_server')::numeric / 1000)), e.event_id) < (before_time, before_id))
    ORDER BY at DESC, e.event_id DESC LIMIT p_limit + 1
  ), numbered AS (
    SELECT e.*, row_number() OVER (ORDER BY at DESC, event_id DESC) AS n FROM candidates e
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'seq', seq::text, 'event_id', event_id,
    'occurred_at_server', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grant_id', event->'grant_id', 'admin_identity_id', event->'admin_identity_id',
    'actor_user', event->'actor_user','owner_user_id',CASE WHEN owner_user_id=viewer THEN owner_user_id END,
    'provider_grant_id',(SELECT b.provider_grant_id FROM commonswarm_oauth.admin_grant_bindings b
      WHERE b.owner_user_id=viewer AND b.admin_grant_id=(event->>'grant_id')::uuid),
    'action', left(event->'payload'->>'action', 80),
    'target_kind', left(event->'payload'->>'target_kind', 80),
    'target_id', left(event->'payload'->>'target_id', 2048),
    'workspace_id', event->'payload'->'workspace_id',
    'outcome', event->'payload'->'outcome', 'reason_code', left(event->'payload'->>'reason_code', 80),
    'next_action', left(event->'payload'->>'next_action', 2048),
    'recovery_kind', left(event->'payload'->>'recovery_kind', 80),
    'related_event_ids', coalesce((SELECT jsonb_agg(ref) FROM
      (SELECT ref FROM jsonb_array_elements(event->'payload'->'related_event_ids') AS ref LIMIT 100) bounded), '[]'::jsonb)
  ) ORDER BY at DESC, event_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
  CASE WHEN count(*) > p_limit THEN max(to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || event_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
  INTO page, cursor FROM numbered;
  RETURN jsonb_build_object('grants', '[]'::jsonb, 'actions', page, 'next_before', cursor, 'active', active_summary, 'clients','[]'::jsonb,'workers','[]'::jsonb,'coverage','[]'::jsonb,'renewal','client-initiated');
END
$fn$;
ALTER FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) TO swarm_read;

-- Reserve rollback (verbatim sibling reserve; read-only, preserves all rows):
-- -- Read-only reserve: restore prior human projection; retain every historical row.
-- -- Migration source mirrored in 20261001000003_admin_recovery_read.sql.
-- -- The read edge installs verified human claims; the definer needs no auth schema.
-- -- No caller-selected account ID, admin/worker credentials or private-table grants.
-- CREATE OR REPLACE FUNCTION swarm_read.admin_recovery_page(
--   p_resource text, p_workspace_id uuid, p_limit integer, p_before text
-- ) RETURNS jsonb
-- LANGUAGE plpgsql STABLE SECURITY DEFINER
-- SET search_path = pg_catalog
-- AS $fn$
-- DECLARE
--   viewer uuid := NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
--   workspace_owner boolean := false;
--   before_time timestamptz;
--   before_id uuid;
--   page jsonb;
--   active_summary jsonb;
--   cursor text;
-- BEGIN
--   IF viewer IS NULL OR p_resource NOT IN ('admin_grants', 'admin_history')
--      OR p_resource IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
--     RETURN jsonb_build_object('error', 'forbidden');
--   END IF;
--   IF p_before IS NOT NULL THEN
--     IF p_before !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\|[0-9a-fA-F-]{36}$' THEN
--       RETURN jsonb_build_object('error', 'forbidden');
--     END IF;
--     BEGIN
--       before_time := split_part(p_before, '|', 1)::timestamptz;
--       before_id := split_part(p_before, '|', 2)::uuid;
--     EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
--       RETURN jsonb_build_object('error', 'forbidden');
--     END;
--   END IF;
--   IF p_workspace_id IS NOT NULL THEN
--     SELECT EXISTS(SELECT 1 FROM swarm.memberships m
--       WHERE m.workspace_id = p_workspace_id AND m.user_id = viewer
--         AND m.role = 'owner' AND m.revoked_at IS NULL) INTO workspace_owner;
--     -- Grantors retain their own history/recovery after membership loss or archive.
--     -- Other people need a current workspace-owner role. Unknown IDs disclose nothing.
--     IF NOT workspace_owner AND NOT EXISTS (
--       SELECT 1 FROM swarm.admin_grants g WHERE g.owner_user_id = viewer
--         AND p_workspace_id = ANY(g.workspace_ids)
--     ) AND NOT EXISTS (
--       SELECT 1 FROM swarm.admin_created_workspaces c JOIN swarm.admin_grants g USING (grant_id)
--       WHERE c.workspace_id = p_workspace_id AND g.owner_user_id = viewer
--     ) AND NOT EXISTS (
--       SELECT 1 FROM swarm.admin_events e WHERE e.owner_user_id = viewer
--         AND e.event->>'type' = 'AdminActionRecorded'
--         AND e.event->'payload'->>'workspace_id' = p_workspace_id::text
--     ) THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
--   END IF;
--
--   -- Aggregate all matching live grants, independently of the page/cursor.
--   -- Workspace owners receive only this indicator and workspace action cards,
--   -- never another person's grant manifest, other targets, or account-only audit.
--   SELECT jsonb_build_object(
--     'grant_count', count(*),
--     'full_account_count', count(*) FILTER (WHERE g.mode = 'full_account' AND g.owner_user_id = viewer),
--     'expires_at', to_char(min(g.expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--     'full_account_expires_at', to_char(min(g.expires_at) FILTER (WHERE g.mode = 'full_account' AND g.owner_user_id = viewer) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
--   ) INTO active_summary
--   FROM swarm.admin_grants g
--   WHERE g.state = 'active' AND g.revoked_at IS NULL AND g.suspended_at IS NULL
--     AND g.expires_at > statement_timestamp() AND g.refresh_deadline > statement_timestamp()
--     AND (g.owner_user_id = viewer OR (p_workspace_id IS NOT NULL AND workspace_owner))
--     AND (p_workspace_id IS NULL OR (
--       NOT (p_workspace_id = ANY(g.withdrawn_workspace_ids)) AND (
--         p_workspace_id = ANY(g.workspace_ids) OR (g.workspace_selector = 'owned_and_selected' AND EXISTS (
--           SELECT 1 FROM swarm.memberships own WHERE own.workspace_id = p_workspace_id
--             AND own.user_id = g.owner_user_id AND own.role = 'owner' AND own.revoked_at IS NULL
--         )) OR EXISTS (
--           SELECT 1 FROM swarm.admin_created_workspaces c
--           WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
--         )
--       )
--       -- Created-space permission is limited by both the original association
--       -- and the current narrowed policy, even for a full-account grant.
--       AND NOT EXISTS (
--         SELECT 1 FROM swarm.admin_created_workspaces c
--         WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
--           AND NOT EXISTS (
--             SELECT 1 FROM jsonb_array_elements_text(g.created_workspace_policy->'scope_names') AS s(scope)
--             WHERE s.scope = ANY(c.scope_names) AND s.scope = ANY(g.scope_names)
--           )
--       )
--     ));
--
--   IF p_resource = 'admin_grants' THEN
--     WITH candidates AS (
--       SELECT g.* FROM swarm.admin_grants g
--       WHERE g.owner_user_id = viewer AND (p_workspace_id IS NULL OR
--         p_workspace_id = ANY(g.workspace_ids) OR (g.workspace_selector = 'owned_and_selected' AND EXISTS (
--           SELECT 1 FROM swarm.memberships own WHERE own.workspace_id = p_workspace_id
--             AND own.user_id = viewer AND own.role = 'owner' AND own.revoked_at IS NULL
--         )) OR EXISTS (
--           SELECT 1 FROM swarm.admin_created_workspaces c
--           WHERE c.workspace_id = p_workspace_id AND c.grant_id = g.grant_id
--         ))
--         AND (p_before IS NULL OR (g.created_at, g.grant_id) < (before_time, before_id))
--       ORDER BY g.created_at DESC, g.grant_id DESC LIMIT p_limit + 1
--     ), numbered AS (
--       SELECT g.*, row_number() OVER (ORDER BY created_at DESC, grant_id DESC) AS n FROM candidates g
--     )
--     SELECT coalesce(jsonb_agg(jsonb_build_object(
--       'grant_id', grant_id, 'admin_identity_id', admin_identity_id, 'connection_id', connection_id,
--       'client_id', client_id, 'mode', mode, 'scope_names', scope_names,
--       'workspace_selector', workspace_selector, 'workspace_ids', workspace_ids,
--       'withdrawn_workspace_ids', withdrawn_workspace_ids,
--       'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--       'expires_at', to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--       'state', CASE WHEN state = 'active' AND (expires_at <= statement_timestamp() OR refresh_deadline <= statement_timestamp()) THEN 'expired' ELSE state END,
--       'reason_code', left(reason_code, 80)
--     ) ORDER BY created_at DESC, grant_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
--     CASE WHEN count(*) > p_limit THEN max(to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || grant_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
--     INTO page, cursor FROM numbered;
--     RETURN jsonb_build_object('grants', page, 'actions', '[]'::jsonb, 'next_before', cursor, 'active', active_summary);
--   END IF;
--
--   -- Lane C emits one AdminActionRecorded per routine attempt, including
--   -- creation, provisioning, replacement, renewal, invitations and revocation.
--   -- Linked domain event IDs retain provenance without duplicating cards or
--   -- returning domain payloads (recipient data, names or credential metadata).
--   WITH candidates AS (
--     SELECT e.*, to_timestamp((e.event->>'occurred_at_server')::numeric / 1000) AS at
--     FROM swarm.admin_events e
--     WHERE e.event->>'type' = 'AdminActionRecorded'
--       AND ((p_workspace_id IS NULL AND e.owner_user_id = viewer) OR
--         (p_workspace_id IS NOT NULL AND e.event->'payload'->>'workspace_id' = p_workspace_id::text
--           AND (e.owner_user_id = viewer OR workspace_owner)))
--       AND (p_before IS NULL OR (to_timestamp((e.event->>'occurred_at_server')::numeric / 1000), e.event_id) < (before_time, before_id))
--     ORDER BY at DESC, e.event_id DESC LIMIT p_limit + 1
--   ), numbered AS (
--     SELECT e.*, row_number() OVER (ORDER BY at DESC, event_id DESC) AS n FROM candidates e
--   )
--   SELECT coalesce(jsonb_agg(jsonb_build_object(
--     'seq', seq::text, 'event_id', event_id,
--     'occurred_at_server', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--     'grant_id', event->'grant_id', 'admin_identity_id', event->'admin_identity_id',
--     'actor_user', event->'actor_user',
--     'action', left(event->'payload'->>'action', 80),
--     'target_kind', left(event->'payload'->>'target_kind', 80),
--     'target_id', left(event->'payload'->>'target_id', 128),
--     'workspace_id', event->'payload'->'workspace_id',
--     'outcome', event->'payload'->'outcome', 'reason_code', left(event->'payload'->>'reason_code', 80),
--     'next_action', left(event->'payload'->>'next_action', 2048),
--     'recovery_kind', left(event->'payload'->>'recovery_kind', 80),
--     'related_event_ids', coalesce((SELECT jsonb_agg(ref) FROM
--       (SELECT ref FROM jsonb_array_elements(event->'payload'->'related_event_ids') AS ref LIMIT 100) bounded), '[]'::jsonb)
--   ) ORDER BY at DESC, event_id DESC) FILTER (WHERE n <= p_limit), '[]'::jsonb),
--   CASE WHEN count(*) > p_limit THEN max(to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || event_id::text) FILTER (WHERE n = p_limit) ELSE NULL END
--   INTO page, cursor FROM numbered;
--   RETURN jsonb_build_object('grants', '[]'::jsonb, 'actions', page, 'next_before', cursor, 'active', active_summary);
-- END
-- $fn$;
-- ALTER FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) OWNER TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) FROM PUBLIC, anon, authenticated, swarm_command;
-- GRANT EXECUTE ON FUNCTION swarm_read.admin_recovery_page(text, uuid, integer, text) TO swarm_read;
--
-- -- Reserve rollback (verbatim SQL retained in
-- -- admin-delegation-reserve/20261001000003-rollback.sql):
-- -- DROP FUNCTION IF EXISTS swarm_read.admin_recovery_page(text, uuid, integer, text);
