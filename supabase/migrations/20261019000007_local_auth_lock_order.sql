-- LOCAL v4/v5 dependency closure: install only with 00008 and compatible callers.
-- Metadata is internal transaction planning data, never authentication or output.
CREATE FUNCTION swarm.discover_local_credential_ids(p_hash bytea)
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
  RETURN QUERY
  SELECT t.token_id,t.predecessor_token_id,t.renewal_grant_id,t.principal_id,
    t.run_id,r.device_id,p.owner_user_id,p.workspace_id,t.lineage_id,
    t.parent_admin_grant_id,p.parent_admin_grant_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
  JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
  WHERE t.token_hash=p_hash;
END
$fn$;

CREATE FUNCTION swarm.discover_local_target_ids(
  p_workspace_id uuid, p_target_user_id uuid, p_principal_ids uuid[],
  p_token_ids uuid[], p_all_workspace boolean
)
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
DECLARE
  bindings jsonb;
  cycle_found boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_principal_ids IS NULL OR p_token_ids IS NULL
    OR p_all_workspace IS NULL
    OR array_position(p_principal_ids,NULL) IS NOT NULL
    OR array_position(p_token_ids,NULL) IS NOT NULL
    OR cardinality(p_principal_ids)>64 OR cardinality(p_token_ids)>64
    OR cardinality(p_principal_ids)+cardinality(p_token_ids)>128
    OR NOT (
      (p_target_user_id IS NOT NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
      OR (p_target_user_id IS NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)>0)
      OR (p_target_user_id IS NULL AND p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
    ) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SELECTOR' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM swarm.agent_principals p
      WHERE p.principal_id=ANY(p_principal_ids) AND p.workspace_id<>p_workspace_id)
    OR EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.token_id=ANY(p_token_ids) AND p.workspace_id<>p_workspace_id) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SCOPE' USING ERRCODE='22023';
  END IF;
  -- UNION reaches a fixed point, including expired/revoked/hidden siblings.
  -- No LIMIT, depth shortcut or inactive filter may turn partial cleanup into success.
  WITH RECURSIVE seed_principals AS (
    SELECT p.principal_id FROM swarm.agent_principals p
    WHERE p.workspace_id=p_workspace_id AND
      (p_all_workspace OR p.owner_user_id=p_target_user_id OR p.principal_id=ANY(p_principal_ids))
  ), family_tokens(id) AS (
    SELECT t.token_id FROM swarm.agent_tokens t
    WHERE t.principal_id IN (SELECT s.principal_id FROM seed_principals s) OR t.token_id=ANY(p_token_ids)
    UNION
    SELECT t.token_id FROM family_tokens f JOIN swarm.agent_tokens base ON base.token_id=f.id
    JOIN swarm.agent_tokens t ON t.predecessor_token_id=base.token_id
      OR t.token_id=base.predecessor_token_id
      OR t.renewal_grant_id=base.renewal_grant_id OR t.lineage_id=base.lineage_id
  ), rows AS (
    SELECT t.token_id,t.predecessor_token_id,t.renewal_grant_id,t.principal_id,
      t.run_id,r.device_id,p.owner_user_id,p.workspace_id,t.lineage_id,
      t.parent_admin_grant_id AS token_parent_admin_grant_id,
      p.parent_admin_grant_id AS principal_parent_admin_grant_id
    FROM family_tokens f JOIN swarm.agent_tokens t ON t.token_id=f.id
    JOIN swarm.agent_principals p ON p.principal_id=t.principal_id
    JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
    UNION
    SELECT NULL::uuid,NULL::uuid,g.renewal_grant_id,p.principal_id,g.run_id,r.device_id,
      p.owner_user_id,p.workspace_id,NULL::uuid,NULL::uuid,p.parent_admin_grant_id
    FROM seed_principals sp JOIN swarm.agent_principals p ON p.principal_id=sp.principal_id
    LEFT JOIN swarm.renewal_grants g ON g.principal_id=p.principal_id
    LEFT JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
    WHERE g.renewal_grant_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM family_tokens f JOIN swarm.agent_tokens t ON t.token_id=f.id
       WHERE t.renewal_grant_id=g.renewal_grant_id)
  )
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.token_id,rows.principal_id,rows.renewal_grant_id),'[]'::jsonb)
  INTO bindings FROM rows;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
      WHERE b.workspace_id<>p_workspace_id) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(bindings) b(token_id uuid,renewal_grant_id uuid,principal_id uuid,
      run_id uuid,device_id uuid,workspace_id uuid,owner_user_id uuid)
    LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=b.renewal_grant_id
    LEFT JOIN swarm.devices d ON d.device_id=b.device_id
    WHERE (b.renewal_grant_id IS NOT NULL AND
      (g.renewal_grant_id IS NULL OR ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)
        IS DISTINCT FROM ROW(b.principal_id,b.run_id,b.workspace_id,b.owner_user_id)))
      OR (b.device_id IS NOT NULL AND (d.device_id IS NULL OR d.user_id<>b.owner_user_id))
  ) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(bindings)>4096 OR
    (SELECT count(DISTINCT b.owner_user_id)>256 OR count(DISTINCT b.principal_id)>256
      OR count(DISTINCT b.run_id)>256 OR count(DISTINCT b.device_id)>256
      OR count(DISTINCT b.renewal_grant_id)>256 OR count(DISTINCT b.token_id)>2048
     FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid))
    OR (SELECT count(*)>256 FROM (
      SELECT b.owner_user_id AS id FROM jsonb_to_recordset(bindings) b(owner_user_id uuid)
      UNION SELECT a.owner_user_id FROM swarm.admin_grants a
        WHERE a.grant_id IN (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(token_parent_admin_grant_id uuid)
          UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(principal_parent_admin_grant_id uuid))
    ) owners)
    OR (SELECT count(DISTINCT id)>256 FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
      CROSS JOIN LATERAL unnest(ARRAY[b.token_parent_admin_grant_id,b.principal_parent_admin_grant_id]) id)
    OR (SELECT count(*)>256 FROM swarm.agent_execution_sessions s
      WHERE s.principal_id IN (SELECT b.principal_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)))
    THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_CAP' USING ERRCODE='54000';
  END IF;
  -- Required R/E keys are enumerated and capped by the caller before row
  -- locks; unrelated workspace streams are not an auth work bound.
  -- Detect malformed directed predecessor cycles independently of fixed-point expansion.
  WITH RECURSIVE walk(id,pred,path,cycle) AS (
    SELECT t.token_id,t.predecessor_token_id,ARRAY[t.token_id],false
    FROM swarm.agent_tokens t WHERE t.token_id IN
      (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid))
    UNION ALL
    SELECT t.token_id,t.predecessor_token_id,w.path||t.token_id,t.token_id=ANY(w.path)
    FROM walk w JOIN swarm.agent_tokens t ON t.token_id=w.pred WHERE NOT w.cycle
  ) SELECT coalesce(bool_or(w.cycle),false) INTO cycle_found FROM walk w;
  IF cycle_found THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_CYCLE' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT b.token_id, b.predecessor_token_id, b.renewal_grant_id, b.principal_id, b.run_id, b.device_id, b.owner_user_id, b.workspace_id, b.lineage_id, b.token_parent_admin_grant_id, b.principal_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
    ORDER BY b.token_id,b.principal_id,b.renewal_grant_id;
END
$fn$;

CREATE FUNCTION swarm.discover_local_join_ids(p_hash bytea,p_attempt_id uuid)
RETURNS TABLE (
  join_credential_id uuid, attempt_id uuid, stream_id uuid,
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
DECLARE c swarm.agent_join_credentials%ROWTYPE; a swarm.agent_join_attempts%ROWTYPE;
  principal_ids uuid[]; target_tokens uuid[];
BEGIN
  IF p_hash IS NULL OR octet_length(p_hash)<>32 OR p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SELECTOR' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM swarm.agent_join_credentials j WHERE j.credential_hash=p_hash;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO a FROM swarm.agent_join_attempts j
    WHERE j.join_credential_id=c.id AND j.attempt_id=p_attempt_id;
  principal_ids:=ARRAY[c.registrar_principal_id];
  target_tokens:=CASE WHEN a.token_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[a.token_id] END;
  RETURN QUERY SELECT c.id,a.attempt_id,s.stream_id,b.token_id,b.predecessor_token_id,b.renewal_grant_id,b.principal_id,
      CASE WHEN b.principal_id=c.registrar_principal_id AND b.run_id IS NULL THEN c.registrar_run_id ELSE b.run_id END,
      CASE WHEN b.principal_id=c.registrar_principal_id AND b.device_id IS NULL THEN r.device_id ELSE b.device_id END,
      b.owner_user_id,b.workspace_id,b.lineage_id,b.token_parent_admin_grant_id,b.principal_parent_admin_grant_id
    FROM swarm.discover_local_target_ids(c.workspace_id,NULL,principal_ids,target_tokens,false) b
    JOIN swarm.streams s ON s.workspace_id=c.workspace_id AND s.kind='workspace'
    JOIN swarm.agent_runs r ON r.run_id=c.registrar_run_id AND r.principal_id=c.registrar_principal_id;
END
$fn$;

ALTER FUNCTION swarm.discover_local_credential_ids(bytea) OWNER TO swarm_admin;
ALTER FUNCTION swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.discover_local_join_ids(bytea,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.discover_local_credential_ids(bytea),
  swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean),
  swarm.discover_local_join_ids(bytea,uuid) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.discover_local_credential_ids(bytea),
  swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean),
  swarm.discover_local_join_ids(bytea,uuid) TO swarm_command;

-- Narrow v5 amendment: exact family binding, immutable after first assignment.
-- No late locks here. The supported writer must already hold the full plan.
CREATE FUNCTION swarm.household_local_family_binding_guard()
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
    OR g.revoked_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
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
ALTER FUNCTION swarm.household_local_family_binding_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.household_local_family_binding_guard()
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
CREATE TRIGGER aa_household_local_family_binding
  BEFORE INSERT OR UPDATE ON swarm.household_content_connections
  FOR EACH ROW EXECUTE FUNCTION swarm.household_local_family_binding_guard();
GRANT UPDATE(renewal_grant_id) ON swarm.household_content_connections TO swarm_command;
