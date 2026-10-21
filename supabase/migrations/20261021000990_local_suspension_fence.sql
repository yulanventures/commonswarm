-- Security suspension fence for local connection families.
-- Prerequisite: reviewed ACTIVE local-auth catalog 20261019000007/8/9/10,
-- including when running the F edge source. Never replay older helper bodies
-- after this migration. Install the no-idle prepare routine before edge activation.
-- No data repair: preserve every suspended_at and resumed_at value.
-- CREATE OR REPLACE preserves routine OIDs, ownership, ACLs and signatures.
-- All dependency discovery, lock acquisition and post-wait clocks are retained.
BEGIN;

CREATE OR REPLACE FUNCTION swarm.prepare_renewal_grant(
  p_renewal_grant_id uuid,
  p_device_id uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
  v_now timestamptz;
BEGIN
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
  FOR UPDATE;

  v_now:=clock_timestamp();
  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  -- Suspension is a security fence, regardless of standing/date/resume metadata.
  IF grant_row.suspended_at IS NOT NULL THEN
    RETURN 'renewal_grant_suspended';
  END IF;

  IF grant_row.connection_expired_at IS NOT NULL OR grant_row.connection_expires_at<=v_now THEN
    -- Existing intentional prepare-refusal effects commit a terminal revoke.
    -- The cascade covers hidden-parent siblings under the caller's preheld G.
    UPDATE swarm.renewal_grants SET revoked_at=v_now,revoked_by=grant_row.created_by
      WHERE renewal_grant_id=grant_row.renewal_grant_id AND revoked_at IS NULL;
    RETURN 'renewal_grant_revoked';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.agent_runs r USING(principal_id)
    JOIN swarm.devices d USING(device_id) JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
    JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
    WHERE p.principal_id=grant_row.principal_id AND r.run_id=grant_row.run_id AND d.device_id=p_device_id
      AND p.workspace_id=grant_row.workspace_id AND p.owner_user_id=grant_row.created_by
      AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL AND r.ended_at IS NULL
      AND d.revoked_at IS NULL AND d.user_id=p.owner_user_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
      AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id))
    OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('renewal_grant',grant_row.renewal_grant_id),('principal',grant_row.principal_id),('run',grant_row.run_id),
       ('device',p_device_id),('membership',grant_row.created_by))) THEN RETURN 'renewal_grant_revoked'; END IF;
  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= v_now
  THEN
    RETURN 'renewal_horizon_reached';
  END IF;

  IF grant_row.bound_device_id IS NOT NULL AND p_device_id IS NULL THEN
    RETURN 'renewal_device_unavailable';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, v_now)
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
    RETURN 'renewal_device_mismatch';
  END IF;
  IF grant_row.last_used_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, v_now)
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION swarm.discover_local_credential_ids(p_hash bytea)
RETURNS TABLE (
  token_id uuid,
  predecessor_token_id uuid,
  renewal_grant_id uuid,
  principal_id uuid,
  run_id uuid,
  device_id uuid,
  owner_user_id uuid,
  workspace_id uuid,
  lineage_id uuid,
  token_parent_admin_grant_id uuid,
  principal_parent_admin_grant_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_hash IS NULL OR octet_length(p_hash) <> 32 THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SELECTOR' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM swarm.agent_tokens t WHERE t.token_hash=p_hash)
    AND NOT EXISTS(SELECT 1   FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
  JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
  WHERE t.token_hash=p_hash
    AND t.revoked_at IS NULL AND NOT t.surrender_only AND p.revoked_at IS NULL
    AND p.transport='local' AND NOT p.turn_only AND r.ended_at IS NULL
    AND EXISTS(SELECT 1 FROM swarm.devices d WHERE d.device_id=r.device_id
      AND d.user_id=p.owner_user_id AND d.revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
      WHERE m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
        AND m.revoked_at IS NULL AND w.archived_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=t.renewal_grant_id
      AND (g.revoked_at IS NOT NULL OR g.suspended_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants a WHERE a.grant_id IN
        (t.parent_admin_grant_id,p.parent_admin_grant_id)
      AND (a.state<>'active' OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp()
        OR a.refresh_deadline<=clock_timestamp() OR p.workspace_id=ANY(a.withdrawn_workspace_ids)))
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',r.device_id),
       ('renewal_grant',t.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',p.owner_user_id)))) THEN
    RAISE EXCEPTION 'LOCAL_CREDENTIAL_DENIED' USING ERRCODE='42501',DETAIL='LOCAL_CREDENTIAL_DENIED';
  END IF;
  RETURN QUERY
  SELECT t.token_id,t.predecessor_token_id,t.renewal_grant_id,t.principal_id,
    t.run_id,r.device_id,p.owner_user_id,p.workspace_id,t.lineage_id,
    t.parent_admin_grant_id,p.parent_admin_grant_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
  JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
  WHERE t.token_hash=p_hash
    AND t.revoked_at IS NULL AND NOT t.surrender_only AND p.revoked_at IS NULL
    AND p.transport='local' AND NOT p.turn_only AND r.ended_at IS NULL
    AND EXISTS(SELECT 1 FROM swarm.devices d WHERE d.device_id=r.device_id
      AND d.user_id=p.owner_user_id AND d.revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
      WHERE m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
        AND m.revoked_at IS NULL AND w.archived_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=t.renewal_grant_id
      AND (g.revoked_at IS NOT NULL OR g.suspended_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants a WHERE a.grant_id IN
        (t.parent_admin_grant_id,p.parent_admin_grant_id)
      AND (a.state<>'active' OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp()
        OR a.refresh_deadline<=clock_timestamp() OR p.workspace_id=ANY(a.withdrawn_workspace_ids)))
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',r.device_id),
       ('renewal_grant',t.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',p.owner_user_id)));
END
$fn$;

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
    IF local_denial='LOCAL_CREDENTIAL_DENIED' THEN RETURN; END IF;
    RAISE;
  END;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO local_before FROM swarm.discover_local_target_ids(local_seed.workspace_id,NULL,
      ARRAY[]::uuid[],ARRAY[local_seed.token_id],false) b;
  -- Revalidate complete key sets after EACH potentially blocking phase.
  SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(u.user_id ORDER BY u.user_id),'[]'::jsonb) FROM swarm.users u
      WHERE u.user_id=local_seed.owner_user_id OR u.user_id=NULL::uuid OR u.user_id IN
        (SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
          (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
           UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)))),
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE w.workspace_id=local_seed.workspace_id),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE m.workspace_id=local_seed.workspace_id AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid)),
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
  PERFORM w.workspace_id FROM swarm.workspaces w WHERE w.workspace_id=local_seed.workspace_id FOR SHARE;
  PERFORM m.user_id FROM swarm.memberships m WHERE m.workspace_id=local_seed.workspace_id
    AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid) ORDER BY m.user_id FOR SHARE;
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
    INTO local_after FROM swarm.discover_local_target_ids(local_seed.workspace_id,NULL,
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
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE w.workspace_id=local_seed.workspace_id),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE m.workspace_id=local_seed.workspace_id AND (m.user_id=local_seed.owner_user_id OR m.user_id=NULL::uuid)),
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
  SELECT t.parent_admin_grant_id, t.scopes, p.workspace_id
  INTO v_parent_admin_grant_id, v_worker_scopes, v_parent_workspace_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING (principal_id)
  WHERE t.token_hash = p_token_hash;
  IF NOT FOUND OR NOT swarm.admin_child_live(v_parent_admin_grant_id, v_parent_workspace_id)
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
      AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id)
      AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,v_worker_scopes))
    OR EXISTS(SELECT 1 FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
      WHERE t.token_id=v_token_id AND (g.revoked_at IS NOT NULL OR g.suspended_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=local_now OR g.workspace_id<>v_principal_workspace_id
        OR g.principal_id<>v_principal_id OR g.run_id<>v_run_id OR g.created_by<>v_owner_user_id
        OR g.bound_device_id IS NOT NULL AND g.bound_device_id<>v_device_id
        OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='renewal_grant' AND z.target_id=g.renewal_grant_id)))
  THEN RETURN; END IF;

  SELECT m.revoked_at
  INTO v_membership_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = v_principal_workspace_id
    AND m.user_id = v_owner_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    v_revoked := true;
  ELSIF NOT swarm.is_member(v_principal_workspace_id, v_owner_user_id)
     OR v_membership_revoked_at IS NOT NULL
     OR v_token_revoked_at IS NOT NULL
     OR v_principal_revoked_at IS NOT NULL
     OR v_run_ended_at IS NOT NULL
     OR v_device_revoked_at IS NOT NULL
     OR v_surrender_only
  THEN
    v_revoked := true;
  ELSE
    v_ids := ARRAY[
      v_token_id,
      v_principal_id,
      v_run_id,
      v_device_id,
      v_owner_user_id,
      v_lineage_id
    ];
    IF EXISTS (
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
    ) THEN
      v_revoked := true;
    END IF;
  END IF;

  -- No-row/denied authentication never stamps or supersedes anything.
  IF v_revoked THEN v_first_use:=false;
  ELSIF v_first_use THEN
    UPDATE swarm.agent_tokens t SET first_used_at=local_now WHERE t.token_id=v_token_id AND t.first_used_at IS NULL;
    UPDATE swarm.agent_tokens pred SET expires_at=local_now
      FROM swarm.agent_tokens child WHERE child.token_id=v_token_id AND pred.token_id=child.predecessor_token_id
        AND pred.revoked_at IS NULL AND pred.expires_at>local_now;
  END IF;

  IF NOT v_revoked
     AND p_workspace_id IS NOT NULL
     AND p_workspace_id = v_principal_workspace_id
  THEN
    SELECT count(*)::integer
    INTO v_pending
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.recipient_agent_principal_id = v_principal_id
      AND d.workspace_id = v_principal_workspace_id
      AND d.acked_at IS NULL
      AND s.until > local_now;
  END IF;

  token_id := v_token_id;
  principal_id := v_principal_id;
  owner_user_id := v_owner_user_id;
  principal_workspace_id := v_principal_workspace_id;
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

CREATE OR REPLACE FUNCTION swarm.agent_tokens_successor_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  pred swarm.agent_tokens%ROWTYPE;
  initial_pred swarm.agent_tokens%ROWTYPE;
  v_now timestamptz;
  grant_row swarm.renewal_grants%ROWTYPE;
  owner_user uuid;
  run_device uuid;
  run_ended timestamptz;
  principal_revoked timestamptz;
  device_revoked timestamptz;
BEGIN
  SELECT * INTO initial_pred FROM swarm.agent_tokens WHERE token_id=NEW.predecessor_token_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE='55000'; END IF;
  SELECT * INTO grant_row FROM swarm.renewal_grants WHERE renewal_grant_id=initial_pred.renewal_grant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISSING' USING ERRCODE='55000'; END IF;
  SELECT * INTO pred
  FROM swarm.agent_tokens
  WHERE token_id = NEW.predecessor_token_id
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE='55000'; END IF;
  IF ROW(pred.token_id,pred.principal_id,pred.run_id,pred.renewal_grant_id,pred.predecessor_token_id,pred.lineage_id,pred.parent_admin_grant_id)
    IS DISTINCT FROM ROW(initial_pred.token_id,initial_pred.principal_id,initial_pred.run_id,initial_pred.renewal_grant_id,initial_pred.predecessor_token_id,initial_pred.lineage_id,initial_pred.parent_admin_grant_id) THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  v_now:=clock_timestamp();
  NEW.issued_at:=v_now;
  IF grant_row.connection_expired_at IS NOT NULL OR grant_row.connection_expires_at<=v_now THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_REVOKED' USING ERRCODE='55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM pred.principal_id
    OR NEW.run_id IS DISTINCT FROM pred.run_id
    OR NEW.task_id IS DISTINCT FROM pred.task_id
    OR NEW.epoch IS DISTINCT FROM pred.epoch
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TARGET_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NEW.lineage_id IS DISTINCT FROM pred.lineage_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.renewal_grant_id IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_UNGRANTED_PREDECESSOR' USING ERRCODE = '55000';
  END IF;
  IF NEW.renewal_grant_id IS DISTINCT FROM pred.renewal_grant_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF pred.expires_at <= v_now AND NOT (grant_row.kind='standing' AND (grant_row.connection_expires_at IS NULL OR grant_row.connection_expires_at>clock_timestamp())
    AND grant_row.connection_expired_at IS NULL AND pred.first_used_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=pred.token_id
      AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pred.surrender_only THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_SURRENDERED' USING ERRCODE = '55000';
  END IF;

  SELECT p.owner_user_id, p.revoked_at, r.device_id, r.ended_at, d.revoked_at
    INTO owner_user, principal_revoked, run_device, run_ended, device_revoked
  FROM swarm.agent_principals AS p
  JOIN swarm.agent_runs AS r ON r.run_id = pred.run_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE p.principal_id = pred.principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BINDING_MISSING' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.workspaces w USING(workspace_id)
    JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
    WHERE p.principal_id=pred.principal_id AND p.transport='local' AND NOT p.turn_only
      AND w.archived_at IS NULL AND m.revoked_at IS NULL
      AND ROW(grant_row.workspace_id,grant_row.principal_id,grant_row.run_id,grant_row.created_by)
        =ROW(p.workspace_id,p.principal_id,pred.run_id,p.owner_user_id)
      AND swarm.admin_child_live(pred.parent_admin_grant_id,p.workspace_id)
      AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id)
      AND swarm.admin_child_scopes_live(pred.parent_admin_grant_id,pred.scopes)
      AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,pred.scopes)) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BINDING_MISSING' USING ERRCODE='55000';
  END IF;
  IF principal_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PRINCIPAL_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF run_ended IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RUN_ENDED' USING ERRCODE = '55000';
  END IF;
  IF device_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.revocation_tombstones AS tombstone
    WHERE (tombstone.kind, tombstone.target_id) IN (
      ('token', pred.token_id),
      ('lineage', pred.lineage_id),
      ('family', pred.lineage_id),
      ('principal', pred.principal_id),
      ('run', pred.run_id),
      ('device', run_device),
      ('membership', owner_user),
      ('renewal_grant', pred.renewal_grant_id)
    )
  ) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.scopes) <> 'array'
     OR jsonb_typeof(pred.scopes) <> 'array'
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPES_MALFORMED' USING ERRCODE = '55000';
  END IF;
  IF NOT (pred.scopes @> NEW.scopes) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPE_WIDENED' USING ERRCODE = '55000';
  END IF;

  IF grant_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_REVOKED' USING ERRCODE = '55000';
  END IF;
  -- Suspension is a security fence, regardless of standing/date/resume metadata.
  IF grant_row.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_SUSPENDED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= v_now
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_HORIZON_REACHED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND run_device IS DISTINCT FROM grant_row.bound_device_id
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF grant_row.max_successors IS NOT NULL
     AND grant_row.successors_used - grant_row.successors_stranded >= grant_row.max_successors
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_EXHAUSTED' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at <= NEW.issued_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > NEW.issued_at + interval '8 hours' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_EXCEEDED'
      USING ERRCODE = '55000', CONSTRAINT = 'renewal_ttl_exceeded';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND NEW.expires_at > grant_row.horizon_expires_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BEYOND_HORIZON' USING ERRCODE = '55000';
  END IF;

  -- A successor spends capacity even when its use timestamp became stale
  -- while waiting for the grant row. Do not skip this counter increment.
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  UPDATE swarm.renewal_grants
  SET last_used_at = v_now,
      last_used_device_id = run_device,
      new_host_at = CASE
        WHEN new_host_at IS NOT NULL THEN new_host_at
        WHEN last_used_device_id IS NOT NULL
             AND run_device IS DISTINCT FROM last_used_device_id
          THEN v_now
        ELSE NULL
      END
  WHERE renewal_grant_id = grant_row.renewal_grant_id
    AND (last_used_at IS NULL OR last_used_at <= v_now);

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION swarm.record_renewal_grant_use(
  p_token_id uuid,p_device_id uuid,p_last_used_from text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  initial swarm.agent_tokens%ROWTYPE;
  token swarm.agent_tokens%ROWTYPE;
  grant_row swarm.renewal_grants%ROWTYPE;
  v_now timestamptz;
BEGIN
  SELECT * INTO initial FROM swarm.agent_tokens t WHERE t.token_id=p_token_id;
  IF NOT FOUND OR initial.renewal_grant_id IS NULL THEN RETURN; END IF;
  -- Caller holds its complete outer closure. Never T then G.
  SELECT * INTO grant_row FROM swarm.renewal_grants g WHERE g.renewal_grant_id=initial.renewal_grant_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO token FROM swarm.agent_tokens t WHERE t.token_id=p_token_id FOR SHARE;
  IF NOT FOUND OR ROW(token.principal_id,token.run_id,token.renewal_grant_id,token.lineage_id,token.parent_admin_grant_id)
    IS DISTINCT FROM ROW(initial.principal_id,initial.run_id,initial.renewal_grant_id,initial.lineage_id,initial.parent_admin_grant_id) THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  v_now:=clock_timestamp();
  IF token.revoked_at IS NOT NULL OR token.surrender_only OR token.expires_at<=v_now
    OR grant_row.revoked_at IS NOT NULL OR (grant_row.suspended_at IS NOT NULL)
    OR grant_row.connection_expired_at IS NOT NULL OR grant_row.connection_expires_at<=v_now
    OR NOT EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.agent_runs r USING(principal_id)
      JOIN swarm.devices d USING(device_id) JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
      JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
      WHERE p.principal_id=token.principal_id AND r.run_id=token.run_id AND d.device_id=p_device_id
        AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL AND r.ended_at IS NULL
        AND d.revoked_at IS NULL AND d.user_id=p.owner_user_id AND w.archived_at IS NULL AND m.revoked_at IS NULL
        AND ROW(grant_row.principal_id,grant_row.run_id,grant_row.workspace_id,grant_row.created_by)
          =ROW(p.principal_id,r.run_id,p.workspace_id,p.owner_user_id)
        AND swarm.admin_child_live(token.parent_admin_grant_id,p.workspace_id)
        AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id)
        AND swarm.admin_child_scopes_live(token.parent_admin_grant_id,token.scopes)
        AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,token.scopes)
        AND (grant_row.bound_device_id IS NULL OR grant_row.bound_device_id=d.device_id))
    OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',token.token_id),('principal',token.principal_id),('run',token.run_id),('device',p_device_id),
       ('renewal_grant',grant_row.renewal_grant_id),('lineage',token.lineage_id),('family',token.lineage_id),('membership',grant_row.created_by)))
    THEN RETURN; END IF;
  UPDATE swarm.renewal_grants g SET last_used_at=v_now,last_used_device_id=p_device_id,
    last_used_from=coalesce(p_last_used_from,g.last_used_from),
    new_host_at=CASE WHEN g.new_host_at IS NOT NULL THEN g.new_host_at
      WHEN g.last_used_device_id IS NOT NULL AND g.last_used_device_id<>p_device_id THEN v_now ELSE NULL END
    WHERE g.renewal_grant_id=grant_row.renewal_grant_id AND (g.last_used_at IS NULL OR g.last_used_at<=v_now);
END
$fn$;

CREATE OR REPLACE FUNCTION swarm.household_local_family_binding_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE
  v_now timestamptz;
  t swarm.agent_tokens%ROWTYPE;
  p swarm.agent_principals%ROWTYPE;
  r swarm.agent_runs%ROWTYPE;
  d swarm.devices%ROWTYPE;
  g swarm.renewal_grants%ROWTYPE;
  parent swarm.admin_grants%ROWTYPE;
  parent_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.renewal_grant_id IS NOT NULL THEN
    IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
      OR ROW(NEW.connection_id,NEW.grant_id,NEW.workspace_id,NEW.principal_id,NEW.owner_user_id,NEW.hosted_grant_id)
        IS DISTINCT FROM ROW(OLD.connection_id,OLD.grant_id,OLD.workspace_id,OLD.principal_id,OLD.owner_user_id,OLD.hosted_grant_id) THEN
      RAISE EXCEPTION 'LOCAL_APPROVAL_FAMILY_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    -- Withdrawal/removal remains possible even after a family becomes terminal.
    -- Repeated same binding without reapproval does not confer authority.
    IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  IF NEW.renewal_grant_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.connection_id,NEW.grant_id,NEW.workspace_id,NEW.principal_id,NEW.owner_user_id,NEW.hosted_grant_id)
      IS DISTINCT FROM ROW(OLD.connection_id,OLD.grant_id,OLD.workspace_id,OLD.principal_id,OLD.owner_user_id,OLD.hosted_grant_id) THEN
    RAISE EXCEPTION 'LOCAL_APPROVAL_BINDING_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW.hosted_grant_id IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'LOCAL_APPROVAL_POLICY_BINDING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO t FROM swarm.agent_tokens x WHERE x.token_id=NEW.connection_id;
  SELECT * INTO p FROM swarm.agent_principals x WHERE x.principal_id=NEW.principal_id;
  SELECT * INTO r FROM swarm.agent_runs x WHERE x.run_id=NEW.grant_id;
  SELECT * INTO d FROM swarm.devices x WHERE x.device_id=r.device_id;
  SELECT * INTO g FROM swarm.renewal_grants x WHERE x.renewal_grant_id=NEW.renewal_grant_id;
  v_now:=clock_timestamp();
  IF t.token_id IS NULL OR p.principal_id IS NULL OR r.run_id IS NULL OR d.device_id IS NULL OR g.renewal_grant_id IS NULL
    OR ROW(t.principal_id,t.run_id,t.renewal_grant_id) IS DISTINCT FROM ROW(NEW.principal_id,NEW.grant_id,NEW.renewal_grant_id)
    OR ROW(p.workspace_id,p.owner_user_id) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.owner_user_id)
    OR p.transport<>'local' OR p.turn_only OR p.revoked_at IS NOT NULL
    OR r.principal_id<>p.principal_id OR r.ended_at IS NOT NULL OR d.revoked_at IS NOT NULL
    OR d.user_id<>p.owner_user_id
    OR ROW(g.workspace_id,g.principal_id,g.run_id,g.created_by)
      IS DISTINCT FROM ROW(NEW.workspace_id,NEW.principal_id,NEW.grant_id,NEW.owner_user_id)
    OR t.revoked_at IS NOT NULL OR t.surrender_only OR t.expires_at<=v_now
    OR g.revoked_at IS NOT NULL OR g.suspended_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
    OR (g.connection_expires_at IS NOT NULL AND g.connection_expires_at<=v_now)
    OR (g.bound_device_id IS NOT NULL AND g.bound_device_id<>d.device_id)
    OR NOT EXISTS (SELECT 1 FROM swarm.workspaces w JOIN swarm.memberships m USING(workspace_id)
      WHERE w.workspace_id=NEW.workspace_id AND w.archived_at IS NULL
        AND m.user_id=NEW.owner_user_id AND m.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
       ('renewal_grant',g.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',p.owner_user_id))) THEN
    RAISE EXCEPTION 'LOCAL_APPROVAL_BINDING_REFUSED' USING ERRCODE='23514';
  END IF;
  FOREACH parent_id IN ARRAY ARRAY[t.parent_admin_grant_id,p.parent_admin_grant_id] LOOP
    IF parent_id IS NULL THEN CONTINUE; END IF;
    SELECT * INTO parent FROM swarm.admin_grants a WHERE a.grant_id=parent_id;
    IF NOT FOUND OR parent.owner_user_id<>NEW.owner_user_id
      OR parent.state<>'active' OR parent.expires_at<=v_now OR parent.refresh_deadline<=v_now
      OR NEW.workspace_id=ANY(parent.withdrawn_workspace_ids)
      OR NOT (NEW.workspace_id=ANY(parent.workspace_ids)
        OR EXISTS (SELECT 1 FROM swarm.admin_created_workspaces c
          WHERE c.workspace_id=NEW.workspace_id AND c.grant_id=parent_id
            AND 'seats:create'=ANY(c.scope_names) AND parent.created_workspace_policy->'scope_names' ? 'seats:create')
        OR (parent.workspace_selector='owned_and_selected' AND EXISTS
          (SELECT 1 FROM swarm.memberships m WHERE m.workspace_id=NEW.workspace_id
           AND m.user_id=NEW.owner_user_id AND m.role='owner' AND m.revoked_at IS NULL)))
      OR EXISTS (SELECT 1 FROM swarm.admin_created_workspaces c
        WHERE c.workspace_id=NEW.workspace_id AND c.grant_id=parent_id
          AND NOT ('seats:create'=ANY(c.scope_names) AND parent.created_workspace_policy->'scope_names' ? 'seats:create'))
      OR NOT EXISTS (SELECT 1 FROM swarm.memberships m WHERE m.workspace_id=NEW.workspace_id
        AND m.user_id=NEW.owner_user_id AND m.role IN ('owner','admin') AND m.revoked_at IS NULL)
      OR NOT swarm.admin_child_scopes_live(parent_id,t.scopes) THEN
      RAISE EXCEPTION 'LOCAL_APPROVAL_PARENT_REFUSED' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION swarm.local_content_approval_pointer_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE c swarm.household_content_connections%ROWTYPE;
  t swarm.agent_tokens%ROWTYPE; p swarm.agent_principals%ROWTYPE;
  r swarm.agent_runs%ROWTYPE; d swarm.devices%ROWTYPE; v_now timestamptz;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.local_content_approval_token_id IS NOT NULL THEN
      RAISE EXCEPTION 'LOCAL_ALLOW_INSERT_REFUSED' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.local_content_approval_token_id IS NOT DISTINCT FROM OLD.local_content_approval_token_id THEN RETURN NEW; END IF;
  IF NEW.local_content_approval_token_id IS NULL
    OR ROW(NEW.renewal_grant_id,NEW.workspace_id,NEW.principal_id,NEW.run_id,NEW.created_by)
      IS DISTINCT FROM ROW(OLD.renewal_grant_id,OLD.workspace_id,OLD.principal_id,OLD.run_id,OLD.created_by)
    OR nullif(current_setting('cswarm.household_actor',true),'')::uuid IS DISTINCT FROM NEW.created_by
    OR coalesce(current_setting('cswarm.household_command',true),'') NOT IN ('household_permissions','household_approve_connection')
    OR nullif(current_setting('cswarm.household_request',true),'') IS NULL
    OR coalesce(current_setting('cswarm.household_digest',true),'') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'LOCAL_ALLOW_CONTEXT_REFUSED' USING ERRCODE='23514';
  END IF;
  SELECT * INTO c FROM swarm.household_content_connections x
    WHERE x.connection_id=NEW.local_content_approval_token_id AND x.grant_id=NEW.run_id
      AND x.workspace_id=NEW.workspace_id AND x.principal_id=NEW.principal_id
      AND x.owner_user_id=NEW.created_by AND x.renewal_grant_id=NEW.renewal_grant_id
      AND x.hosted_grant_id IS NULL;
  SELECT * INTO t FROM swarm.agent_tokens x WHERE x.token_id=NEW.local_content_approval_token_id;
  SELECT * INTO p FROM swarm.agent_principals x WHERE x.principal_id=NEW.principal_id;
  SELECT * INTO r FROM swarm.agent_runs x WHERE x.run_id=NEW.run_id;
  SELECT * INTO d FROM swarm.devices x WHERE x.device_id=r.device_id;
  v_now:=clock_timestamp();
  IF c.connection_id IS NULL OR c.revoked_at IS NOT NULL
    OR (c.expires_at IS NOT NULL AND c.expires_at<=v_now)
    OR NEW.revoked_at IS NOT NULL OR NEW.suspended_at IS NOT NULL OR NEW.connection_expired_at IS NOT NULL
    OR (NEW.connection_expires_at IS NOT NULL AND NEW.connection_expires_at<=v_now)
    OR p.principal_id IS NULL OR p.transport<>'local' OR p.turn_only OR p.revoked_at IS NOT NULL
    OR ROW(p.workspace_id,p.owner_user_id) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.created_by)
    OR t.token_id IS NULL OR t.revoked_at IS NOT NULL OR t.surrender_only OR t.expires_at<=v_now
    OR ROW(t.principal_id,t.run_id,t.renewal_grant_id) IS DISTINCT FROM ROW(NEW.principal_id,NEW.run_id,NEW.renewal_grant_id)
    OR r.run_id IS NULL OR r.principal_id<>p.principal_id OR r.ended_at IS NOT NULL
    OR d.device_id IS NULL OR d.user_id<>NEW.created_by OR d.revoked_at IS NOT NULL
    OR (NEW.bound_device_id IS NOT NULL AND NEW.bound_device_id<>d.device_id)
    OR NOT EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
      JOIN swarm.household_member_content_roles cr USING(workspace_id,user_id)
      JOIN swarm.household_workspace_boundaries b USING(workspace_id)
      WHERE m.workspace_id=NEW.workspace_id AND m.user_id=NEW.created_by
        AND m.revoked_at IS NULL AND w.archived_at IS NULL AND cr.revoked_at IS NULL
        AND cr.content_consent_id=c.consent_receipt_id AND b.purpose=c.purpose
        AND (b.purpose='shared' OR b.owner_user_id=NEW.created_by)
        AND (cr.content_role='editor' OR c.operations=ARRAY['read']::text[]))
    OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
       ('renewal_grant',NEW.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',NEW.created_by)))
    OR NOT swarm.admin_child_live(t.parent_admin_grant_id,NEW.workspace_id)
    OR NOT swarm.admin_child_live(p.parent_admin_grant_id,NEW.workspace_id)
    OR NOT swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
    OR NOT swarm.admin_child_scopes_live(p.parent_admin_grant_id,t.scopes) THEN
    RAISE EXCEPTION 'LOCAL_ALLOW_BINDING_REFUSED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION swarm_read.local_connection_selection(
 p_workspace_id uuid,p_principal_id uuid,p_owner_user_id uuid)
RETURNS TABLE(selected_renewal_grant_id uuid,selected_token_id uuid,is_live boolean)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH eligible_tokens AS MATERIALIZED (
       SELECT t.token_id,t.renewal_grant_id,t.issued_at FROM swarm.agent_tokens t
        JOIN swarm.agent_principals p ON p.principal_id=t.principal_id
        JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
        JOIN swarm.devices d ON d.device_id=r.device_id
        LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
        JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
        JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
        WHERE p.workspace_id=p_workspace_id AND p.principal_id=p_principal_id
          AND p.owner_user_id=p_owner_user_id AND p.transport='local' AND p.revoked_at IS NULL AND NOT p.turn_only
          AND t.revoked_at IS NULL AND NOT t.surrender_only AND r.ended_at IS NULL AND d.revoked_at IS NULL
          AND d.user_id=p.owner_user_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
          AND (t.renewal_grant_id IS NULL OR g.renewal_grant_id IS NOT NULL AND g.revoked_at IS NULL
            AND g.suspended_at IS NULL
            AND g.connection_expired_at IS NULL AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
            AND ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)=ROW(t.principal_id,t.run_id,p.workspace_id,p.owner_user_id)
            AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id))
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[t.parent_admin_grant_id,p.parent_admin_grant_id]) parent(id)
          WHERE parent.id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM swarm.admin_grants a
            JOIN swarm.memberships am ON am.workspace_id=p.workspace_id AND am.user_id=a.owner_user_id
            JOIN swarm.workspaces aw ON aw.workspace_id=am.workspace_id
            LEFT JOIN swarm.admin_created_workspaces ac ON ac.workspace_id=p.workspace_id
            WHERE a.grant_id=parent.id AND a.state='active' AND a.revoked_at IS NULL
              AND a.expires_at>clock_timestamp() AND a.refresh_deadline>clock_timestamp()
              AND am.revoked_at IS NULL AND am.role IN ('owner','admin') AND aw.archived_at IS NULL
              AND NOT p.workspace_id=ANY(a.withdrawn_workspace_ids)
              AND (p.workspace_id=ANY(a.workspace_ids) OR ac.grant_id=a.grant_id
                OR a.workspace_selector='owned_and_selected' AND am.role='owner')
              AND (ac.grant_id IS DISTINCT FROM a.grant_id OR
                'seats:create'=ANY(ac.scope_names) AND a.created_workspace_policy->'scope_names' ? 'seats:create')
              AND jsonb_typeof(t.scopes)='array' AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(t.scopes) s(scope) WHERE NOT s.scope=ANY(a.worker_scope_ceiling))))
          AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
            (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
             ('membership',p.owner_user_id),('lineage',t.lineage_id),('family',t.lineage_id),('renewal_grant',t.renewal_grant_id)))
          AND (t.expires_at>clock_timestamp() OR (g.kind='standing' AND (t.first_used_at IS NOT NULL
          OR (t.first_used_at IS NULL AND t.predecessor_token_id IS NULL
            AND g.horizon_expires_at IS NULL AND g.max_successors IS NULL)
          OR EXISTS (
          SELECT 1 FROM swarm.agent_tokens predecessor WHERE predecessor.token_id=t.predecessor_token_id
            AND predecessor.first_used_at IS NOT NULL AND predecessor.revoked_at IS NULL AND NOT predecessor.surrender_only
            AND ROW(predecessor.principal_id,predecessor.run_id,predecessor.renewal_grant_id,predecessor.lineage_id,predecessor.parent_admin_grant_id)
              IS NOT DISTINCT FROM ROW(t.principal_id,t.run_id,t.renewal_grant_id,t.lineage_id,t.parent_admin_grant_id)
            AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='token' AND z.target_id=predecessor.token_id)))
          AND NOT EXISTS (SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=t.token_id
            AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)))
 ), choices AS (
  SELECT g.renewal_grant_id,t.token_id,(e.token_id IS NOT NULL) AS eligible,
    (g.revoked_at IS NULL) AS unrevoked,g.created_at
  FROM swarm.renewal_grants g
  LEFT JOIN LATERAL (
   SELECT candidate.token_id FROM swarm.agent_tokens candidate
   LEFT JOIN eligible_tokens usable ON usable.token_id=candidate.token_id
   WHERE candidate.renewal_grant_id=g.renewal_grant_id
   ORDER BY (usable.token_id IS NOT NULL) DESC,candidate.issued_at DESC,candidate.token_id DESC LIMIT 1
  ) t ON true
  LEFT JOIN eligible_tokens e ON e.token_id=t.token_id
  WHERE g.workspace_id=p_workspace_id AND g.principal_id=p_principal_id AND g.created_by=p_owner_user_id
  UNION ALL
  SELECT NULL,e.token_id,true,true,e.issued_at FROM eligible_tokens e WHERE e.renewal_grant_id IS NULL
 )
 SELECT c.renewal_grant_id,c.token_id,c.eligible FROM choices c
 ORDER BY c.eligible DESC,(c.renewal_grant_id IS NOT NULL) DESC,c.unrevoked DESC,
   c.created_at DESC,c.renewal_grant_id DESC,c.token_id DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION swarm_read.home_overview() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 workspace record;
 can_read boolean;
 last_seen timestamptz;
 new_messages integer;
 content jsonb;
 people jsonb;
 asks jsonb;
 assigned jsonb;
 waiting jsonb;
 result jsonb := '[]'::jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR claims ? 'agent_principal_id' OR nullif(claims->>'sub', '') IS NULL THEN
  RETURN NULL;
 END IF;
 -- Malformed identity is refused rather than cast into a different identity.
 IF claims->>'sub' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 viewer := (claims->>'sub')::uuid;
 FOR workspace IN
  SELECT w.workspace_id, w.name, m.role
  FROM swarm.workspaces w JOIN swarm.memberships m USING (workspace_id)
  WHERE m.user_id = viewer AND m.revoked_at IS NULL AND w.archived_at IS NULL
  ORDER BY w.created_at, w.workspace_id LIMIT 50
 LOOP
  can_read := swarm.household_human_can_read(workspace.workspace_id, viewer);
  SELECT max(r.first_seen_at) INTO last_seen FROM swarm.signal_human_receipts r
   WHERE r.workspace_id = workspace.workspace_id AND r.user_id = viewer;
  SELECT count(*) INTO new_messages FROM (
   SELECT s.id FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id
    AND NOT (s.from_kind = 'user' AND s."from" = viewer)
    AND s.created_at > coalesce(last_seen, read_at - interval '7 days')
   LIMIT 99
  ) messages;
  SELECT coalesce(jsonb_agg(a.value ORDER BY a.created_at DESC, a.id), '[]'::jsonb) INTO asks FROM (
   SELECT s.id, s.created_at, jsonb_build_object('signal_id', s.id,
    'from', jsonb_build_object('kind', s.from_kind, 'id', s."from"),
    'created_at', s.created_at, 'until', s.until) AS value
   FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id AND s.kind = 'ask' AND s.until > read_at
    AND (s."to" = viewer OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r WHERE r.workspace_id = s.workspace_id
      AND r.signal_id = s.id AND r.recipient_user_id = viewer))
    AND NOT EXISTS (
     SELECT 1 FROM swarm.signals reply WHERE reply.workspace_id = s.workspace_id AND reply.in_reply_to = s.id
      AND ((reply.from_kind = 'user' AND reply.from_principal = viewer)
       OR (reply.from_kind = 'agent' AND EXISTS (
        SELECT 1 FROM swarm.agent_principals p WHERE p.workspace_id = reply.workspace_id
         AND p.principal_id = reply.from_principal AND p.owner_user_id = viewer))))
   ORDER BY s.created_at DESC, s.id LIMIT 10
  ) a;
  content := NULL;
  assigned := '[]'::jsonb;
  waiting := '[]'::jsonb;
  IF can_read THEN
   SELECT jsonb_build_object('open_todos', (
    SELECT count(*) FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing')),
    'lists', count(*) FILTER (WHERE o.value->>'kind' = 'list'),
    'docs', count(*) FILTER (WHERE o.value->>'kind' = 'doc'),
    'files', count(*) FILTER (WHERE o.value->>'kind' = 'file')) INTO content
   FROM swarm.household_object_streams os
   CROSS JOIN LATERAL jsonb_each(coalesce(os.projection->'objects', '{}'::jsonb)) o
   WHERE os.workspace_id = workspace.workspace_id;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id), '[]'::jsonb) INTO assigned FROM (
    SELECT t.todo_id, t.state_at, jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on) value
    FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
     AND t.assignee_user = viewer AND t.state IN ('open','doing')
    ORDER BY t.state_at DESC, t.todo_id LIMIT 20
   ) a;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id, a.reason), '[]'::jsonb) INTO waiting FROM (
    SELECT t.todo_id, t.state_at, reason.kind AS reason,
     jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on,
      'reason',reason.kind,'agent_id', CASE WHEN reason.kind = 'request' THEN t.offer_principal ELSE t.assignee_principal END) value
    FROM swarm.household_todos t
    LEFT JOIN swarm.agent_principals p ON p.workspace_id = t.workspace_id AND p.principal_id = t.assignee_principal
    -- Pick one reason per to-do before the 20-to-do bound: request, after, hold, agent_removed.
    CROSS JOIN LATERAL (
     SELECT CASE
     WHEN t.offer_id IS NOT NULL AND t.offer_decider = viewer THEN 'request'
     WHEN t.gate_kind = 'after' AND EXISTS (
      SELECT 1 FROM swarm.household_todos prerequisite WHERE prerequisite.workspace_id = t.workspace_id
       AND prerequisite.todo_id = t.gate_todo_id AND prerequisite.assignee_user = viewer AND prerequisite.state IN ('open','doing')) THEN 'after'
     WHEN t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL THEN 'hold'
     WHEN p.owner_user_id = viewer AND p.revoked_at IS NOT NULL THEN 'agent_removed'
     END AS kind
    ) reason
    WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing') AND reason.kind IS NOT NULL
    ORDER BY t.state_at DESC, t.todo_id, reason.kind LIMIT 20
   ) a;
  END IF;
  WITH members AS MATERIALIZED (
   SELECT m.user_id, m.role, u.display_name FROM swarm.memberships m JOIN swarm.users u USING (user_id)
   WHERE m.workspace_id = workspace.workspace_id AND m.revoked_at IS NULL
   ORDER BY (m.user_id = viewer) DESC, m.user_id LIMIT 25
  ), agents AS MATERIALIZED (
   -- Use the existing roster view: registration-only principals stay hidden.
   SELECT p.* FROM swarm_read.agent_principals p JOIN members m ON m.user_id = p.owner_user_id
   WHERE p.workspace_id = workspace.workspace_id
   ORDER BY (p.owner_user_id = viewer) DESC, p.owner_user_id, p.principal_id LIMIT 50
  ), todo_facts AS MATERIALIZED (
   SELECT t.*, CASE t.gate_kind
    WHEN 'none' THEN true WHEN 'hold' THEN false WHEN 'at' THEN t.gate_at <= read_at
    WHEN 'after' THEN EXISTS (SELECT 1 FROM swarm.household_todos predecessor
     WHERE predecessor.workspace_id = t.workspace_id AND predecessor.todo_id = t.gate_todo_id AND predecessor.state IN ('done','dropped'))
    ELSE false END AS gate_clear
   FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
  ), agent_facts AS (
   SELECT p.*, connection.kind AS connection,
    CASE WHEN p.transport='hosted_mcp' AND hosted_policy.grant_id IS NOT NULL THEN
      jsonb_build_object('connection_expires_at',hosted_policy.connection_expires_at,
        'connection_expired_at',coalesce(hosted_policy.connection_expired_at,
          CASE WHEN hosted_policy.connection_expires_at<=clock_timestamp() THEN hosted_policy.connection_expires_at END))
    WHEN p.transport='local' AND local_policy.renewal_grant_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',local_policy.renewal_grant_id,
        'connection_expires_at',local_policy.connection_expires_at,
        'connection_expired_at',coalesce(local_policy.connection_expired_at,
          CASE WHEN local_policy.connection_expires_at<=clock_timestamp() THEN local_policy.connection_expires_at END))
        || CASE WHEN selected.selected_token_id IS NOT NULL THEN jsonb_build_object('token_id',selected.selected_token_id) ELSE '{}'::jsonb END
    WHEN p.transport='local' AND selected.selected_token_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',NULL,'token_id',selected.selected_token_id)
    ELSE '{}'::jsonb END AS connection_policy,
    -- Raw signals are safe here: last_activity_at exposes only a time, no content or signal id.
    greatest(presence.last_command_at,
     (SELECT max(s.created_at) FROM swarm.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id),
     (SELECT max(greatest(b.created_at,b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b WHERE b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id),
     (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text),
     (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
      WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text)) AS last_activity_at,
    (SELECT min(d.enqueued_at) FROM swarm.signal_deliveries d JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
     WHERE d.workspace_id = p.workspace_id AND d.recipient_agent_principal_id = p.principal_id AND d.acked_at IS NULL AND s.until > read_at) AS messages_waiting_since,
    doing.value AS doing, working.value AS working_on,
    CASE WHEN can_read THEN jsonb_build_object(
     'working',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'),
     'up_next',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND t.gate_clear),
     'not_yet',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND NOT t.gate_clear),
     'requests',(SELECT count(*) FROM todo_facts t WHERE t.offer_principal = p.principal_id AND t.offer_id IS NOT NULL AND t.state IN ('open','doing'))) ELSE NULL END AS queue
   FROM agents p
   LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = p.workspace_id AND presence.principal_id = p.principal_id
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('todo_id',t.todo_id,'title',CASE WHEN can_read THEN t.title ELSE NULL END,'since',t.state_at) value
    FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'
    ORDER BY t.state_at DESC, t.todo_id LIMIT 1
   ) doing ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('signal_id',s.id,'at',s.created_at,'until',s.until) value
    FROM swarm_read.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s."from" = p.principal_id
     AND s.kind = 'working-on' AND s.until > read_at ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   LEFT JOIN LATERAL swarm_read.local_connection_selection(p.workspace_id,p.principal_id,p.owner_user_id)
    selected ON p.transport='local'
   LEFT JOIN swarm.renewal_grants local_policy
    ON local_policy.renewal_grant_id=selected.selected_renewal_grant_id
   -- principal_id is UNIQUE on seats: policy and status share this same grant.
   LEFT JOIN LATERAL (
    SELECT g.*,seat.revoked_at AS seat_revoked_at,binding.revoked_at AS binding_revoked_at
    FROM swarm.hosted_mcp_seats seat
    JOIN swarm.hosted_mcp_grant_workspaces binding ON binding.grant_id=seat.grant_id
      AND binding.workspace_id=seat.workspace_id AND binding.owner_user_id=seat.owner_user_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=binding.grant_id AND g.owner_user_id=binding.owner_user_id
    WHERE p.transport='hosted_mcp' AND seat.workspace_id=p.workspace_id
      AND seat.principal_id=p.principal_id AND seat.owner_user_id=p.owner_user_id
   ) hosted_policy ON true
   CROSS JOIN LATERAL (
    SELECT CASE
     WHEN p.revoked_at IS NOT NULL THEN 'removed'
     WHEN p.transport = 'hosted_mcp' THEN CASE
      WHEN hosted_policy.seat_revoked_at IS NULL AND hosted_policy.binding_revoked_at IS NULL
       AND hosted_policy.revoked_at IS NULL AND hosted_policy.state='active'
       AND hosted_policy.connection_expired_at IS NULL
       AND (hosted_policy.connection_expires_at IS NULL OR hosted_policy.connection_expires_at>clock_timestamp())
      THEN 'live' ELSE 'connection_off' END
     WHEN selected.is_live THEN 'live'
     WHEN local_policy.connection_expired_at IS NOT NULL OR local_policy.connection_expires_at<=clock_timestamp() THEN 'key_ended'
     WHEN local_policy.revoked_at IS NULL AND local_policy.suspended_at IS NOT NULL
      AND local_policy.connection_expired_at IS NULL
      AND (local_policy.connection_expires_at IS NULL OR local_policy.connection_expires_at>clock_timestamp()) THEN 'paused'
     WHEN local_policy.revoked_at IS NOT NULL THEN 'key_off'
     WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
      THEN 'key_ended' ELSE 'key_off' END AS kind
   ) connection
  ), rows AS (
   SELECT m.*, coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'name',a.name,
    'status',jsonb_build_object('work',CASE WHEN a.connection <> 'live' THEN 'disconnected'
     WHEN (a.doing IS NOT NULL OR a.working_on IS NOT NULL) AND a.last_activity_at >= read_at - interval '30 minutes' THEN 'working' ELSE 'idle' END,
     'facts',jsonb_build_object('transport',a.transport,'turn_only',a.turn_only,'connection',a.connection,
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,'doing',a.doing,'working_on',a.working_on) || a.connection_policy),
    'queue',a.queue) ORDER BY a.principal_id) FROM agent_facts a WHERE a.owner_user_id = m.user_id),'[]'::jsonb) AS agents
   FROM members m
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'display_name',r.display_name,'role',r.role,
   'is_viewer',r.user_id = viewer,'agents',r.agents) ORDER BY (r.user_id = viewer) DESC,r.user_id),'[]'::jsonb) INTO people FROM rows r;
  result := result || jsonb_build_array(jsonb_build_object('workspace_id',workspace.workspace_id,'name',workspace.name,'role',workspace.role,
   'last_seen_at',last_seen,'new_messages',new_messages,'content',content,'people',people,
   'needs_you',jsonb_build_object('asks',asks,'assigned',assigned,'waiting',waiting)));
 END LOOP;
 RETURN jsonb_build_object('viewer_user_id',viewer,'generated_at',read_at,'workspaces',result);
END;
$$;

CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz,
  connection_expires_at timestamptz,
  connection_expired_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    grant_row.suspended_at,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at,
    grant_row.connection_expires_at,COALESCE(grant_row.connection_expired_at,
      CASE WHEN grant_row.connection_expires_at<=clock_timestamp() THEN grant_row.connection_expires_at END)
  FROM swarm.agent_principals AS principal
  JOIN LATERAL swarm_read.local_connection_selection(
    p_workspace_id,principal.principal_id,principal.owner_user_id) selected ON true
  JOIN swarm.renewal_grants grant_row ON grant_row.renewal_grant_id=selected.selected_renewal_grant_id
  LEFT JOIN swarm.agent_tokens token ON token.token_id=selected.selected_token_id
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_for_token(
  p_workspace_id uuid,
  p_token_id uuid
)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz,
  connection_expires_at timestamptz,
  connection_expired_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    grant_row.suspended_at,
    grant_row.revoked_at,
    latest.token_id,
    latest.issued_at,
    latest.expires_at,
    latest.first_used_at,
    latest.revoked_at,
    grant_row.connection_expires_at,COALESCE(grant_row.connection_expired_at,
      CASE WHEN grant_row.connection_expires_at<=clock_timestamp() THEN grant_row.connection_expires_at END)
  FROM swarm.agent_tokens AS presenting
  JOIN swarm.renewal_grants AS grant_row
    ON grant_row.renewal_grant_id = presenting.renewal_grant_id
  JOIN swarm.agent_principals AS principal
    ON principal.principal_id = grant_row.principal_id
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS latest ON true
  WHERE presenting.token_id = p_token_id
    AND grant_row.workspace_id = p_workspace_id
    AND principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL;
$$;

COMMIT;
