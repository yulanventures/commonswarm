-- Forward migration for local agent workspace token validation, residual token revocation, and hosted seat grant-agent seeding.

CREATE OR REPLACE FUNCTION swarm.agent_delivery_read_context(
  p_token_hash bytea,
  p_workspace_id uuid
)
RETURNS TABLE (
  token_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  principal_workspace_id uuid,
  run_id uuid,
  device_id uuid,
  first_use boolean,
  membership_revoked_at timestamptz,
  is_revoked boolean,
  pending_delivery_count integer,
  wake_id text,
  managed_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  local_phase integer;
  local_dependencies jsonb;
  local_current_dependencies jsonb;
  local_seed record;
  local_row record;
  local_before jsonb;
  local_after jsonb;
  local_ids uuid[];
  local_done uuid[] := ARRAY[]::uuid[];
  local_next uuid[];
  local_now timestamptz;
  local_denial text;

  v_token_id uuid;
  v_first_use boolean;
  v_principal_id uuid;
  v_owner_user_id uuid;
  v_principal_workspace_id uuid;
  v_run_id uuid;
  v_device_id uuid;
  v_lineage_id uuid;
  v_token_revoked_at timestamptz;
  v_principal_revoked_at timestamptz;
  v_run_ended_at timestamptz;
  v_device_revoked_at timestamptz;
  v_surrender_only boolean;
  v_unexpired boolean;
  v_membership_revoked_at timestamptz;
  v_revoked boolean := false;
  v_pending integer := 0;
  v_ids uuid[];
  v_wake_id text;
  v_managed_at timestamptz;
  v_parent_admin_grant_id uuid;
  v_worker_scopes jsonb;
  v_parent_workspace_id uuid;
BEGIN

  BEGIN
    SELECT b.* INTO local_seed FROM swarm.discover_local_credential_ids(p_token_hash) b;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS local_denial=PG_EXCEPTION_DETAIL;
    RAISE;
  END;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO local_before FROM swarm.discover_local_target_ids(coalesce(p_workspace_id,local_seed.workspace_id),NULL,
      ARRAY[]::uuid[],ARRAY[local_seed.token_id],false) b;
  -- Revalidate complete key sets after EACH potentially blocking phase.
  SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(u.user_id ORDER BY u.user_id),'[]'::jsonb) FROM swarm.users u
      WHERE u.user_id=local_seed.owner_user_id OR u.user_id=NULL::uuid OR u.user_id IN
        (SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
          (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
           UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)))),
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id ORDER BY w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE (w.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=w.workspace_id))),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE (m.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=m.workspace_id)) AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid)),
    'sessions',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.principal_id,e.workspace_id) ORDER BY e.principal_id,e.workspace_id),'[]'::jsonb)
      FROM swarm.agent_execution_sessions e WHERE e.principal_id IN
        (SELECT b.principal_id FROM jsonb_to_recordset(local_before) b(principal_id uuid)))
  ) INTO local_dependencies;
  FOR local_phase IN 1..8 LOOP
    IF local_phase=1 THEN
  FOR local_row IN SELECT DISTINCT u.id FROM (
    SELECT b.owner_user_id AS id FROM jsonb_to_recordset(local_before) b(owner_user_id uuid)
    UNION SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
      (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
       UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid))
    UNION SELECT NULL::uuid
  ) u WHERE u.id IS NOT NULL ORDER BY u.id LOOP
    PERFORM u.user_id FROM swarm.users u WHERE u.user_id=local_row.id FOR KEY SHARE;
  END LOOP;
    ELSIF local_phase=2 THEN
  FOR local_row IN SELECT id FROM (
    SELECT b.token_parent_admin_grant_id AS id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
    UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)
  ) a WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM a.grant_id FROM swarm.admin_grants a WHERE a.grant_id=local_row.id FOR SHARE;
  END LOOP;
    ELSIF local_phase=3 THEN
  PERFORM w.workspace_id FROM swarm.workspaces w WHERE (w.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=w.workspace_id)) ORDER BY w.workspace_id FOR SHARE;
  PERFORM m.user_id FROM swarm.memberships m WHERE (m.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=m.workspace_id))
    AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid) ORDER BY m.workspace_id,m.user_id FOR SHARE;
  PERFORM am.principal_id FROM swarm.agent_workspace_memberships am WHERE (am.workspace_id=p_workspace_id OR p_workspace_id IS NULL) AND am.principal_id=local_seed.principal_id ORDER BY am.workspace_id FOR SHARE;
    ELSIF local_phase=4 THEN
  FOR local_row IN SELECT DISTINCT b.principal_id AS id FROM jsonb_to_recordset(local_before) b(principal_id uuid) ORDER BY id LOOP
    PERFORM p.principal_id FROM swarm.agent_principals p WHERE p.principal_id=local_row.id FOR SHARE;
  END LOOP;
    ELSIF local_phase=5 THEN
  PERFORM e.principal_id FROM swarm.agent_execution_sessions e WHERE e.principal_id IN
    (SELECT b.principal_id FROM jsonb_to_recordset(local_before) b(principal_id uuid)) ORDER BY e.principal_id,e.workspace_id FOR SHARE;
    ELSIF local_phase=6 THEN
  PERFORM r.run_id FROM swarm.agent_runs r WHERE r.run_id IN
    (SELECT b.run_id FROM jsonb_to_recordset(local_before) b(run_id uuid)) ORDER BY r.run_id FOR SHARE;
  PERFORM d.device_id FROM swarm.devices d WHERE d.device_id IN
    (SELECT b.device_id FROM jsonb_to_recordset(local_before) b(device_id uuid)) ORDER BY d.device_id FOR SHARE;
    ELSIF local_phase=7 THEN
  PERFORM g.renewal_grant_id FROM swarm.renewal_grants g WHERE g.renewal_grant_id IN
    (SELECT b.renewal_grant_id FROM jsonb_to_recordset(local_before) b(renewal_grant_id uuid)) ORDER BY g.renewal_grant_id FOR UPDATE;
    ELSIF local_phase=8 THEN
  SELECT coalesce(array_agg(DISTINCT b.token_id ORDER BY b.token_id),ARRAY[]::uuid[]) INTO local_ids
    FROM jsonb_to_recordset(local_before) b(token_id uuid) WHERE b.token_id IS NOT NULL;
  WHILE cardinality(local_done)<cardinality(local_ids) LOOP
    SELECT array_agg(b.token_id ORDER BY b.token_id) INTO local_next
      FROM jsonb_to_recordset(local_before) b(token_id uuid,predecessor_token_id uuid)
      WHERE b.token_id=ANY(local_ids) AND NOT b.token_id=ANY(local_done)
        AND (b.predecessor_token_id IS NULL OR NOT b.predecessor_token_id=ANY(local_ids)
          OR b.predecessor_token_id=ANY(local_done));
    IF coalesce(cardinality(local_next),0)=0 THEN RAISE EXCEPTION 'LOCAL_DISCOVERY_CYCLE' USING ERRCODE='22023'; END IF;
    PERFORM t.token_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(local_next) ORDER BY t.token_id FOR UPDATE;
    local_done:=local_done||local_next;
  END LOOP;
    END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO local_after FROM swarm.discover_local_target_ids(coalesce(p_workspace_id,local_seed.workspace_id),NULL,
      ARRAY[]::uuid[],ARRAY[local_seed.token_id],false) b;
  IF local_after IS DISTINCT FROM local_before THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(u.user_id ORDER BY u.user_id),'[]'::jsonb) FROM swarm.users u
      WHERE u.user_id=local_seed.owner_user_id OR u.user_id=NULL::uuid OR u.user_id IN
        (SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
          (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
           UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)))),
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id ORDER BY w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE (w.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=w.workspace_id))),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE (m.workspace_id=coalesce(p_workspace_id,local_seed.workspace_id) OR p_workspace_id IS NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=local_seed.principal_id AND am.workspace_id=m.workspace_id)) AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid)),
    'sessions',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.principal_id,e.workspace_id) ORDER BY e.principal_id,e.workspace_id),'[]'::jsonb)
      FROM swarm.agent_execution_sessions e WHERE e.principal_id IN
        (SELECT b.principal_id FROM jsonb_to_recordset(local_before) b(principal_id uuid)))
  ) INTO local_current_dependencies;
    IF local_current_dependencies IS DISTINCT FROM local_dependencies THEN
      RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
    END IF;
    local_now:=clock_timestamp();
  END LOOP;

  -- This definer owns agent_tokens and bypasses its RLS policies. Check the
  -- parent directly before first-use stamping, supersession or private reads.
  -- admin_child_live locks the grant so a committed revoke/narrow wins.
  SELECT t.parent_admin_grant_id, t.scopes, p.workspace_id, p.principal_id
  INTO v_parent_admin_grant_id, v_worker_scopes, v_parent_workspace_id, v_principal_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING (principal_id)
  WHERE t.token_hash = p_token_hash;
  IF NOT FOUND OR NOT swarm.local_parent_connection_live(v_parent_admin_grant_id)
    OR NOT swarm.admin_child_live(v_parent_admin_grant_id,CASE WHEN p_workspace_id IS NOT NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=v_principal_id AND am.workspace_id=p_workspace_id) THEN p_workspace_id ELSE v_parent_workspace_id END)
    OR NOT swarm.admin_child_scopes_live(v_parent_admin_grant_id, v_worker_scopes) THEN
    RETURN;
  END IF;

  SELECT t.token_id,t.first_used_at IS NULL INTO v_token_id,v_first_use
    FROM swarm.agent_tokens t WHERE t.token_hash=p_token_hash;
  IF v_token_id IS NULL THEN RETURN; END IF;

  SELECT
    t.token_id,
    t.principal_id,
    p.owner_user_id,
    p.workspace_id,
    t.run_id,
    r.device_id,
    t.lineage_id,
    t.revoked_at,
    p.revoked_at,
    r.ended_at,
    d.revoked_at,
    t.surrender_only,
    t.expires_at > local_now,
    p.wake_id,
    p.managed_at
  INTO
    v_token_id,
    v_principal_id,
    v_owner_user_id,
    v_principal_workspace_id,
    v_run_id,
    v_device_id,
    v_lineage_id,
    v_token_revoked_at,
    v_principal_revoked_at,
    v_run_ended_at,
    v_device_revoked_at,
    v_surrender_only,
    v_unexpired,
    v_wake_id,
    v_managed_at
  FROM swarm.agent_tokens AS t
  JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
  JOIN swarm.agent_runs AS r
    ON r.run_id = t.run_id AND r.principal_id = t.principal_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE t.token_id = v_token_id;

  IF NOT COALESCE(v_unexpired, false) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=v_principal_id
      AND p.transport='local' AND NOT p.turn_only
      AND swarm.local_parent_connection_live(p.parent_admin_grant_id)
      AND swarm.admin_child_live(p.parent_admin_grant_id,CASE WHEN p_workspace_id IS NOT NULL AND EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=p.principal_id AND am.workspace_id=p_workspace_id) THEN p_workspace_id ELSE p.workspace_id END)
      AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,v_worker_scopes))
    OR EXISTS(SELECT 1 FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
      WHERE t.token_id=v_token_id AND (g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=local_now OR g.workspace_id<>v_principal_workspace_id
        OR g.principal_id<>v_principal_id OR g.run_id<>v_run_id OR g.created_by<>v_owner_user_id
        OR g.bound_device_id IS NOT NULL AND g.bound_device_id<>v_device_id
        OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='renewal_grant' AND z.target_id=g.renewal_grant_id)))
  THEN RETURN; END IF;

  SELECT m.revoked_at
  INTO v_membership_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = v_owner_user_id
  LIMIT 1;

  v_ids := ARRAY[
    v_token_id,
    v_principal_id,
    v_run_id,
    v_device_id,
    v_owner_user_id,
    v_lineage_id
  ];
  IF v_token_revoked_at IS NOT NULL
     OR v_principal_revoked_at IS NOT NULL
     OR v_run_ended_at IS NOT NULL
     OR v_device_revoked_at IS NOT NULL
     OR v_surrender_only
     OR EXISTS (
       SELECT 1
       FROM swarm.revocation_tombstones AS rt
       WHERE rt.target_id = ANY (v_ids)
         AND (
           (rt.kind = 'token' AND rt.target_id = v_token_id)
           OR (rt.kind = 'principal' AND rt.target_id = v_principal_id)
           OR (rt.kind = 'run' AND rt.target_id = v_run_id)
           OR (rt.kind = 'device' AND rt.target_id = v_device_id)
           OR (rt.kind = 'membership' AND rt.target_id = v_owner_user_id)
           OR (rt.kind = 'lineage' AND rt.target_id = v_lineage_id)
           OR (rt.kind = 'family' AND rt.target_id = v_lineage_id)
         )
     )
  THEN
    v_revoked := true;
    principal_workspace_id := p_workspace_id;
  ELSIF p_workspace_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=v_principal_id AND am.workspace_id=p_workspace_id)
    AND swarm.local_agent_workspace_live(v_principal_id,v_principal_workspace_id)
  THEN
    v_revoked := true;
    principal_workspace_id := v_principal_workspace_id;
  ELSIF p_workspace_id IS NOT NULL
    AND (NOT swarm.local_agent_workspace_live(v_principal_id,p_workspace_id) OR v_membership_revoked_at IS NOT NULL)
  THEN
    v_revoked := true;
    principal_workspace_id := p_workspace_id;
  ELSE
    principal_workspace_id := p_workspace_id;
  END IF;

  -- No-row/denied authentication never stamps or supersedes anything.
  IF v_revoked AND principal_workspace_id IS NOT DISTINCT FROM p_workspace_id THEN v_first_use:=false;
  ELSIF v_first_use THEN
    UPDATE swarm.agent_tokens t SET first_used_at=local_now WHERE t.token_id=v_token_id AND t.first_used_at IS NULL;
    UPDATE swarm.agent_tokens pred SET expires_at=local_now
      FROM swarm.agent_tokens child WHERE child.token_id=v_token_id AND pred.token_id=child.predecessor_token_id
        AND pred.revoked_at IS NULL AND pred.expires_at>local_now;
  END IF;

  IF NOT v_revoked
     AND p_workspace_id IS NOT NULL
     AND swarm.local_agent_workspace_live(v_principal_id,p_workspace_id)
  THEN
    SELECT count(*)::integer
    INTO v_pending
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.recipient_agent_principal_id = v_principal_id
      AND d.workspace_id = p_workspace_id
      AND d.acked_at IS NULL
      AND s.until > local_now;
  END IF;

  token_id := v_token_id;
  principal_id := v_principal_id;
  owner_user_id := v_owner_user_id;
  run_id := v_run_id;
  device_id := v_device_id;
  first_use := v_first_use;
  membership_revoked_at := v_membership_revoked_at;
  is_revoked := v_revoked;
  pending_delivery_count := COALESCE(v_pending, 0);
  wake_id := v_wake_id;
  managed_at := v_managed_at;
  RETURN NEXT;
END;
$fn$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea,uuid)
  FROM PUBLIC,anon,authenticated,swarm_command,swarm_read;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea,uuid) TO swarm_read;

CREATE OR REPLACE FUNCTION swarm.revoke_local_residual_tokens(
  p_workspace_id uuid,p_actor_id uuid,p_kind text,p_target_id uuid
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE
  actor_role text;
  target_owner uuid;
  target_role text;
  target_lineage uuid;
  target_principal uuid;
  principal_ids uuid[];
  item record;
  v_now timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_actor_id IS NULL OR p_target_id IS NULL
    OR p_kind IS NULL OR p_kind NOT IN ('remove_member','revoke_agent_principal','revoke_agent_token') THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_SELECTOR' USING ERRCODE='22023';
  END IF;
  -- Reacquisitions of phase W; the caller must not discover these locks here.
  PERFORM w.workspace_id FROM swarm.workspaces w WHERE w.workspace_id=p_workspace_id FOR SHARE;
  SELECT m.role INTO actor_role FROM swarm.memberships m WHERE m.workspace_id=p_workspace_id
    AND m.user_id=p_actor_id AND m.revoked_at IS NULL FOR SHARE;
  IF actor_role IS NULL OR NOT EXISTS (SELECT 1 FROM swarm.workspaces w
    WHERE w.workspace_id=p_workspace_id AND w.archived_at IS NULL) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_kind='remove_member' THEN
    target_owner:=p_target_id;
    SELECT m.role INTO target_role FROM swarm.memberships m WHERE m.workspace_id=p_workspace_id AND m.user_id=p_target_id;
    IF target_role IS NULL OR actor_role NOT IN ('owner','admin') OR
      (actor_role='admin' AND target_role='owner') OR p_actor_id=p_target_id THEN
      RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    SELECT coalesce(array_agg(p.principal_id ORDER BY p.principal_id),ARRAY[]::uuid[]) INTO principal_ids
      FROM swarm.agent_principals p WHERE p.workspace_id=p_workspace_id AND p.owner_user_id=target_owner AND p.transport='local';
  ELSIF p_kind='revoke_agent_principal' THEN
    SELECT p.owner_user_id INTO target_owner FROM swarm.agent_principals p
      WHERE p.principal_id=p_target_id AND p.workspace_id=p_workspace_id AND p.transport='local';
    principal_ids:=ARRAY[p_target_id];
  ELSE
    SELECT p.owner_user_id,t.lineage_id,t.principal_id INTO target_owner,target_lineage,target_principal
      FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.token_id=p_target_id AND (p.workspace_id=p_workspace_id OR swarm.local_agent_workspace_live(p.principal_id,p_workspace_id)) AND p.transport='local'
        AND (p.workspace_id=p_workspace_id OR p.owner_user_id=p_actor_id);
    principal_ids:=ARRAY[target_principal];
  END IF;
  IF target_owner IS NULL OR (actor_role NOT IN ('owner','admin') AND target_owner<>p_actor_id) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  -- Live-bound tokens must go through grant revocation, never this shortcut.
  IF EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_LIVE_GRANT' USING ERRCODE='42501';
  END IF;
  -- Parent fences, not child counts, define revocation. Current child keys are
  -- streamed deterministically; no capped history array or partial commit.
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    SELECT DISTINCT 'lineage',t.lineage_id,p_actor_id
    FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    WHERE (p.workspace_id=p_workspace_id OR p_kind='revoke_agent_token') AND t.principal_id=ANY(principal_ids)
      AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      ON CONFLICT DO NOTHING;
  FOR item IN SELECT t.token_id FROM swarm.agent_tokens t
    JOIN swarm.agent_principals p USING(principal_id)
    LEFT JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND (p.workspace_id=p_workspace_id OR p_kind='revoke_agent_token')
      AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      AND (g.revoked_at IS NOT NULL OR t.renewal_grant_id IS NULL)
      AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
        WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)
    ORDER BY (t.predecessor_token_id IS NOT NULL),t.issued_at,t.token_id
  LOOP
    PERFORM t.token_id FROM swarm.agent_tokens t WHERE t.token_id=item.token_id FOR UPDATE;
    v_now:=clock_timestamp();
    INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
      VALUES('token',item.token_id,p_actor_id) ON CONFLICT DO NOTHING;
    UPDATE swarm.agent_tokens t SET revoked_at=v_now WHERE t.token_id=item.token_id AND t.revoked_at IS NULL;
  END LOOP;
  v_now:=clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    WHERE m.workspace_id=p_workspace_id AND m.user_id=p_actor_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
      AND (m.role IN ('owner','admin') OR target_owner=p_actor_id)) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;

END
$fn$;

ALTER FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid) TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.ensure_hosted_grant_agent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF to_regclass('swarm.hosted_mcp_grant_agents') IS NOT NULL
   AND EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=NEW.principal_id AND p.workspace_id=NEW.workspace_id AND p.owner_user_id=NEW.owner_user_id AND p.transport='hosted_mcp')
   AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_grants g WHERE g.grant_id=NEW.grant_id AND g.owner_user_id=NEW.owner_user_id) THEN
  INSERT INTO swarm.hosted_mcp_grant_agents(grant_id,principal_id,owner_user_id) VALUES(NEW.grant_id,NEW.principal_id,NEW.owner_user_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION swarm.ensure_hosted_grant_agent() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_hosted_grant_agent() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
DROP TRIGGER IF EXISTS hosted_mcp_seats_seed_grant_agent ON swarm.hosted_mcp_seats;
CREATE TRIGGER hosted_mcp_seats_seed_grant_agent BEFORE INSERT ON swarm.hosted_mcp_seats FOR EACH ROW EXECUTE FUNCTION swarm.ensure_hosted_grant_agent();
