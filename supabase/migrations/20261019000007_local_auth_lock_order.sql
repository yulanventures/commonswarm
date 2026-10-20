-- Latest deliberate local Allow. NULL retains conservative legacy ceilings.
-- No FK: the private trigger validates binding under the caller's preheld G,
-- avoiding a late FK/RLS parent lock after canonical token acquisition.
ALTER TABLE swarm.renewal_grants ADD COLUMN local_content_approval_token_id uuid;

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
      AND (g.revoked_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
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
      AND (g.revoked_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
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
  -- Current operation closure: exact proof, its immediate predecessor and
  -- pending/replacement child. History is checked with indexed EXISTS at the
  -- authority gate; it is never recursively enlisted into every request.
  WITH seed_principals AS (
    SELECT p.principal_id FROM swarm.agent_principals p
    WHERE p.workspace_id=p_workspace_id AND
      (p_all_workspace OR p.owner_user_id=p_target_user_id OR p.principal_id=ANY(p_principal_ids))
  ), current_tokens AS (
    SELECT t.token_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(p_token_ids)
    UNION
    SELECT t.token_id FROM seed_principals sp JOIN swarm.agent_tokens t USING(principal_id)
    WHERE (p_all_workspace OR cardinality(p_principal_ids)>0) AND t.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
        WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL
          AND child.first_used_at IS NOT NULL)
  ), family_tokens(id) AS (
    SELECT c.token_id FROM current_tokens c
    UNION SELECT t.predecessor_token_id FROM current_tokens c
      JOIN swarm.agent_tokens t ON t.token_id=c.token_id WHERE t.predecessor_token_id IS NOT NULL
    UNION SELECT child.token_id FROM current_tokens c JOIN swarm.agent_tokens child
      ON child.predecessor_token_id=c.token_id
      WHERE child.revoked_at IS NULL AND child.first_used_at IS NULL
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
      p.owner_user_id,p.workspace_id,NULL::uuid,parents.parent_admin_grant_id,p.parent_admin_grant_id
    FROM seed_principals sp JOIN swarm.agent_principals p ON p.principal_id=sp.principal_id
    LEFT JOIN swarm.renewal_grants g ON g.principal_id=p.principal_id AND g.revoked_at IS NULL
    LEFT JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
    LEFT JOIN LATERAL (
      SELECT DISTINCT t.parent_admin_grant_id FROM swarm.agent_tokens t
      WHERE t.principal_id=p.principal_id AND t.renewal_grant_id IS NOT DISTINCT FROM g.renewal_grant_id
        AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
          WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)
    ) parents ON true
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
  IF EXISTS(SELECT 1 FROM swarm.agent_tokens child LEFT JOIN swarm.agent_tokens pred
      ON pred.token_id=child.predecessor_token_id
      WHERE child.token_id IN (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid))
        AND child.predecessor_token_id IS NOT NULL AND (pred.token_id IS NULL OR
          ROW(child.principal_id,child.run_id,child.task_id,child.epoch,child.lineage_id,child.renewal_grant_id)
          IS DISTINCT FROM ROW(pred.principal_id,pred.run_id,pred.task_id,pred.epoch,pred.lineage_id,pred.renewal_grant_id)))
    OR EXISTS(SELECT b.lineage_id FROM jsonb_to_recordset(bindings)
      b(lineage_id uuid,principal_id uuid,run_id uuid,renewal_grant_id uuid,owner_user_id uuid,workspace_id uuid)
      WHERE b.lineage_id IS NOT NULL GROUP BY b.lineage_id
      HAVING count(DISTINCT ROW(b.principal_id,b.run_id,b.renewal_grant_id,b.owner_user_id,b.workspace_id))>1) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023';
  END IF;
  IF (p_all_workspace OR cardinality(p_token_ids)>0) AND (jsonb_array_length(bindings)>4096 OR
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
    ) THEN
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
    FROM walk w JOIN swarm.agent_tokens t ON t.token_id=w.pred
    WHERE NOT w.cycle AND t.token_id IN
      (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid))
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
  principal_ids:=ARRAY[]::uuid[];
  target_tokens:=CASE WHEN a.token_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[a.token_id] END;
  RETURN QUERY SELECT c.id,a.attempt_id,s.stream_id,b.token_id,b.predecessor_token_id,b.renewal_grant_id,b.principal_id,
      CASE WHEN b.principal_id=c.registrar_principal_id AND b.run_id IS NULL THEN c.registrar_run_id ELSE b.run_id END,
      CASE WHEN b.principal_id=c.registrar_principal_id AND b.device_id IS NULL THEN r.device_id ELSE b.device_id END,
      b.owner_user_id,b.workspace_id,b.lineage_id,b.token_parent_admin_grant_id,b.principal_parent_admin_grant_id
    FROM (
      SELECT NULL::uuid AS token_id,NULL::uuid AS predecessor_token_id,g.renewal_grant_id,
        p.principal_id,r.run_id,r.device_id,p.owner_user_id,p.workspace_id,NULL::uuid AS lineage_id,
        p.parent_admin_grant_id AS token_parent_admin_grant_id,p.parent_admin_grant_id AS principal_parent_admin_grant_id
      FROM swarm.agent_principals p JOIN swarm.agent_runs r ON r.principal_id=p.principal_id
      LEFT JOIN swarm.renewal_grants g ON g.principal_id=p.principal_id AND g.run_id=r.run_id
      WHERE p.principal_id=c.registrar_principal_id AND r.run_id=c.registrar_run_id
      UNION
      SELECT x.* FROM (SELECT target_tokens AS ids WHERE cardinality(target_tokens)>0) selected
      CROSS JOIN LATERAL swarm.discover_local_target_ids(c.workspace_id,NULL,ARRAY[]::uuid[],selected.ids,false) x
    ) b
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


-- Five forward replacements: activate only with 00008 and matching callers.
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
      WHERE t.token_id=v_token_id AND (g.revoked_at IS NOT NULL OR g.connection_expired_at IS NOT NULL
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
  -- Historical idle suspension is technical, not an owner-selected expiry.
  -- Keep its history; live permanent standing families renew without resume.
  IF grant_row.suspension_active AND grant_row.kind<>'standing' THEN
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
    OR grant_row.revoked_at IS NOT NULL OR (grant_row.suspension_active AND grant_row.kind<>'standing')
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
  idle_since timestamptz;
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
  -- Historical idle suspension is technical, not an owner-selected expiry.
  -- Keep its history; live permanent standing families renew without resume.
  IF grant_row.suspension_active AND grant_row.kind<>'standing' THEN
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

CREATE OR REPLACE FUNCTION swarm.resume_renewal_grant(
  p_workspace_id uuid,
  p_renewal_grant_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
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

  grant_row swarm.renewal_grants%ROWTYPE;
  actor_role text;
  principal_owner uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_renewal_grant_id IS NULL OR p_user_id IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;


  SELECT g.principal_id,g.workspace_id,p.owner_user_id INTO local_seed FROM swarm.renewal_grants g JOIN swarm.agent_principals p USING(principal_id) WHERE g.renewal_grant_id=p_renewal_grant_id AND g.workspace_id=p_workspace_id;
  IF NOT FOUND THEN RETURN 'renewal_grant_not_found'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO local_before FROM (
      SELECT NULL::uuid AS token_id,NULL::uuid AS predecessor_token_id,
        g.renewal_grant_id,p.principal_id,g.run_id,r.device_id,p.owner_user_id,p.workspace_id,
        NULL::uuid AS lineage_id,NULL::uuid AS token_parent_admin_grant_id,
        p.parent_admin_grant_id AS principal_parent_admin_grant_id
      FROM swarm.renewal_grants g JOIN swarm.agent_principals p USING(principal_id)
      JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
      WHERE g.renewal_grant_id=p_renewal_grant_id AND g.workspace_id=p_workspace_id
    ) b;
  -- Revalidate complete key sets after EACH potentially blocking phase.
  SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(u.user_id ORDER BY u.user_id),'[]'::jsonb) FROM swarm.users u
      WHERE u.user_id=local_seed.owner_user_id OR u.user_id=p_user_id OR u.user_id IN
        (SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
          (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
           UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)))),
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE w.workspace_id=local_seed.workspace_id),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE m.workspace_id=local_seed.workspace_id AND (m.user_id=local_seed.owner_user_id OR m.user_id=p_user_id)),
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
    UNION SELECT p_user_id
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
    AND (m.user_id=local_seed.owner_user_id OR m.user_id=p_user_id) ORDER BY m.user_id FOR SHARE;
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
    INTO local_after FROM (
      SELECT NULL::uuid AS token_id,NULL::uuid AS predecessor_token_id,
        g.renewal_grant_id,p.principal_id,g.run_id,r.device_id,p.owner_user_id,p.workspace_id,
        NULL::uuid AS lineage_id,NULL::uuid AS token_parent_admin_grant_id,
        p.parent_admin_grant_id AS principal_parent_admin_grant_id
      FROM swarm.renewal_grants g JOIN swarm.agent_principals p USING(principal_id)
      JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
      WHERE g.renewal_grant_id=p_renewal_grant_id AND g.workspace_id=p_workspace_id
    ) b;
  IF local_after IS DISTINCT FROM local_before THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  SELECT jsonb_build_object(
    'users',(SELECT coalesce(jsonb_agg(u.user_id ORDER BY u.user_id),'[]'::jsonb) FROM swarm.users u
      WHERE u.user_id=local_seed.owner_user_id OR u.user_id=p_user_id OR u.user_id IN
        (SELECT a.owner_user_id FROM swarm.admin_grants a WHERE a.grant_id IN
          (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(token_parent_admin_grant_id uuid)
           UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(local_before) b(principal_parent_admin_grant_id uuid)))),
    'workspace',(SELECT coalesce(jsonb_agg(w.workspace_id),'[]'::jsonb) FROM swarm.workspaces w WHERE w.workspace_id=local_seed.workspace_id),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(m.workspace_id,m.user_id) ORDER BY m.workspace_id,m.user_id),'[]'::jsonb)
      FROM swarm.memberships m WHERE m.workspace_id=local_seed.workspace_id AND (m.user_id=local_seed.owner_user_id OR m.user_id=p_user_id)),
    'sessions',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.principal_id,e.workspace_id) ORDER BY e.principal_id,e.workspace_id),'[]'::jsonb)
      FROM swarm.agent_execution_sessions e WHERE e.principal_id IN
        (SELECT b.principal_id FROM jsonb_to_recordset(local_before) b(principal_id uuid)))
  ) INTO local_current_dependencies;
    IF local_current_dependencies IS DISTINCT FROM local_dependencies THEN
      RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
    END IF;
    local_now:=clock_timestamp();
  END LOOP;

  /* The workspace comes from the route, not from the grant, and both must
     agree. Without this a member of workspace A could name a grant id belonging
     to workspace B and be authorised by A's membership. */
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
    AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The closed-workspace gate is repeated here rather than left to the command
     edge's resolveRoute. This function is the whole authorization decision, and
     a second caller wired to it later must not be able to resume an agent in a
     workspace the owner has closed. */
  SELECT m.role INTO actor_role
  FROM swarm.memberships AS m
  JOIN swarm.workspaces AS w
    ON w.workspace_id = m.workspace_id
   AND w.archived_at IS NULL
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_user_id
    AND m.revoked_at IS NULL;
  IF actor_role IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  SELECT p.owner_user_id INTO principal_owner
  FROM swarm.agent_principals AS p
  WHERE p.principal_id = grant_row.principal_id
    AND p.workspace_id = p_workspace_id
    AND p.revoked_at IS NULL;
  IF principal_owner IS NULL THEN
    /* The principal is gone or revoked. Resuming its grant would restore
       renewal for an agent the workspace has already retired. */
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The same gate as revoke_agent_principal: owner/admin manage any agent in
     the workspace, a plain member manages only their own. Whoever may kill this
     grant may also bring it back; nobody else may do either. */
  IF actor_role NOT IN ('owner', 'admin') AND principal_owner <> p_user_id THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.agent_runs r USING(principal_id)
    JOIN swarm.devices d USING(device_id) WHERE p.principal_id=grant_row.principal_id AND r.run_id=grant_row.run_id
      AND p.workspace_id=p_workspace_id AND p.owner_user_id=grant_row.created_by AND p.transport='local' AND NOT p.turn_only
      AND p.revoked_at IS NULL AND r.ended_at IS NULL AND d.revoked_at IS NULL AND d.user_id=p.owner_user_id
      AND (grant_row.bound_device_id IS NULL OR grant_row.bound_device_id=d.device_id)
      AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id))
    OR EXISTS(SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.renewal_grant_id=grant_row.renewal_grant_id AND
        (NOT swarm.admin_child_live(t.parent_admin_grant_id,p.workspace_id)
         OR NOT swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
         OR NOT swarm.admin_child_scopes_live(p.parent_admin_grant_id,t.scopes))) THEN RETURN 'renewal_resume_forbidden'; END IF;
  IF grant_row.revoked_at IS NOT NULL OR grant_row.connection_expired_at IS NOT NULL
    OR grant_row.connection_expires_at<=local_now OR EXISTS(SELECT 1 FROM swarm.revocation_tombstones z
      WHERE z.kind='renewal_grant' AND z.target_id=grant_row.renewal_grant_id) THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF NOT grant_row.suspension_active THEN
    RETURN 'renewal_grant_not_suspended';
  END IF;

  UPDATE swarm.renewal_grants
  SET resumed_at = local_now,
      resumed_by = p_user_id,
      resume_count = resume_count + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea,uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.agent_tokens_successor_fence() OWNER TO swarm_admin;
ALTER FUNCTION swarm.record_renewal_grant_use(uuid,uuid,text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.prepare_renewal_grant(uuid,uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.resume_renewal_grant(uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea,uuid),swarm.agent_tokens_successor_fence(),
  swarm.record_renewal_grant_use(uuid,uuid,text),swarm.prepare_renewal_grant(uuid,uuid),swarm.resume_renewal_grant(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,swarm_command,swarm_read;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea,uuid) TO swarm_read;
GRANT EXECUTE ON FUNCTION swarm.record_renewal_grant_use(uuid,uuid,text) TO swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.prepare_renewal_grant(uuid,uuid),swarm.resume_renewal_grant(uuid,uuid,uuid) TO swarm_command;

-- Canonical connection policy on the two existing renewal read wires.
DROP FUNCTION swarm_read.renewal_grant_roster(uuid);
CREATE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
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
    CASE WHEN grant_row.suspension_active AND grant_row.kind<>'standing' THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at,
    grant_row.connection_expires_at,COALESCE(grant_row.connection_expired_at,
      CASE WHEN grant_row.connection_expires_at<=clock_timestamp() THEN grant_row.connection_expires_at END)
  FROM swarm.agent_principals AS principal
  JOIN LATERAL (
    SELECT candidate.*
    FROM swarm.renewal_grants AS candidate
    WHERE candidate.workspace_id = p_workspace_id
      AND candidate.principal_id = principal.principal_id
    ORDER BY
      (candidate.revoked_at IS NULL) DESC,
      candidate.created_at DESC,
      candidate.renewal_grant_id DESC
    LIMIT 1
  ) AS grant_row ON true
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS token ON true
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

ALTER FUNCTION swarm_read.renewal_grant_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_roster(uuid)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_roster(uuid) IS
  'One current grant row per live principal for a verified live workspace member. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Includes token ids and timestamps, never token hashes or bearer secrets.';

DROP FUNCTION swarm_read.renewal_grant_for_token(uuid,uuid);
CREATE FUNCTION swarm_read.renewal_grant_for_token(
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
    CASE WHEN grant_row.suspension_active AND grant_row.kind<>'standing' THEN grant_row.suspended_at END,
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

ALTER FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  TO swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) IS
  'The current renewal grant for one already-authenticated agent token. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Never returns another principal or workspace.';


-- No new EXECUTE authority. The existing trusted command role already has
-- table UPDATE; column binding is constrained independently of that ACL.
CREATE FUNCTION swarm.local_content_approval_pointer_guard()
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
    OR NEW.revoked_at IS NOT NULL OR NEW.connection_expired_at IS NOT NULL
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
ALTER FUNCTION swarm.local_content_approval_pointer_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.local_content_approval_pointer_guard()
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
CREATE TRIGGER aa_local_content_approval_pointer
  BEFORE INSERT OR UPDATE ON swarm.renewal_grants
  FOR EACH ROW EXECUTE FUNCTION swarm.local_content_approval_pointer_guard();

-- Conversion prerequisite only; no existing family is converted here.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_spend_or_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  resuming boolean;
  converting boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNDELETABLE' USING ERRCODE = '55000';
  END IF;

  -- Only the existing table owner can perform the separately reviewed exact-ID
  -- migration. Runtime command UPDATE cannot normalize bounded authority.
  -- Ordinary issuance provenance is mandatory in addition to absent parents.
  converting := current_user='swarm_admin' AND OLD.kind='timeboxed'
    AND NEW.kind='standing' AND NEW.max_successors IS NULL AND NEW.horizon_expires_at IS NULL
    AND (to_jsonb(NEW)-ARRAY['kind','max_successors','horizon_expires_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['kind','max_successors','horizon_expires_at'])
    AND OLD.revoked_at IS NULL AND OLD.connection_expired_at IS NULL
    AND (OLD.connection_expires_at IS NULL OR OLD.connection_expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.memberships m
        ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
      JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
      JOIN swarm.agent_runs r ON r.run_id=OLD.run_id AND r.principal_id=p.principal_id
      JOIN swarm.devices d ON d.device_id=r.device_id
      WHERE p.principal_id=OLD.principal_id AND p.workspace_id=OLD.workspace_id
        AND p.owner_user_id=OLD.created_by AND p.transport='local' AND NOT p.turn_only
        AND p.parent_admin_grant_id IS NULL AND p.revoked_at IS NULL AND m.revoked_at IS NULL
        AND w.archived_at IS NULL AND r.ended_at IS NULL AND d.revoked_at IS NULL
        AND d.user_id=OLD.created_by)
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens t WHERE t.renewal_grant_id=OLD.renewal_grant_id
      AND t.parent_admin_grant_id IS NOT NULL)
    AND EXISTS(SELECT 1 FROM swarm.events e JOIN swarm.agent_tokens t
      ON e.payload->>'token_id'=t.token_id::text
      WHERE t.renewal_grant_id=OLD.renewal_grant_id AND t.predecessor_token_id IS NULL
        AND e.workspace_id=OLD.workspace_id AND e.type='AgentTokenMinted'
        AND e.actor_user=OLD.created_by AND (e.actor_agent_principal IS NULL
          OR EXISTS(SELECT 1 FROM swarm.agent_join_attempts attempt
            JOIN swarm.agent_join_credentials credential ON credential.id=attempt.join_credential_id
            JOIN swarm.agent_principals registrar ON registrar.principal_id=credential.registrar_principal_id
            JOIN swarm.agent_runs registrar_run ON registrar_run.run_id=credential.registrar_run_id
              AND registrar_run.principal_id=registrar.principal_id
            WHERE attempt.principal_id=OLD.principal_id AND attempt.run_id=OLD.run_id
              AND attempt.token_id=t.token_id AND attempt.attempt_id=t.task_id
              AND credential.workspace_id=OLD.workspace_id AND credential.owner_user_id=OLD.created_by
              AND registrar.workspace_id=OLD.workspace_id AND registrar.owner_user_id=OLD.created_by
              AND registrar.parent_admin_grant_id IS NULL
              AND e.actor_agent_principal=credential.registrar_principal_id AND e.actor_run=credential.registrar_run_id)))
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE
      (z.kind,z.target_id) IN (('principal',OLD.principal_id),('run',OLD.run_id),
        ('renewal_grant',OLD.renewal_grant_id),('membership',OLD.created_by))
      OR z.kind IN ('lineage','family') AND z.target_id IN
        (SELECT t.lineage_id FROM swarm.agent_tokens t WHERE t.renewal_grant_id=OLD.renewal_grant_id));

  IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR (NOT coalesce(converting,false) AND (
      NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.max_successors IS DISTINCT FROM OLD.max_successors
      OR NEW.horizon_expires_at IS DISTINCT FROM OLD.horizon_expires_at))
    OR NEW.bound_device_id IS DISTINCT FROM OLD.bound_device_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.successors_used < OLD.successors_used THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_COUNTER_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.successors_stranded < OLD.successors_stranded THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_STRANDED_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.last_used_at IS NOT NULL
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LAST_USE_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.last_used_device_id IS DISTINCT FROM OLD.last_used_device_id
    OR NEW.last_used_from IS DISTINCT FROM OLD.last_used_from
  ) AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP' USING ERRCODE = '55000';
  END IF;
  IF OLD.new_host_at IS NOT NULL
     AND NEW.new_host_at IS DISTINCT FROM OLD.new_host_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_NEW_HOST_REWOUND' USING ERRCODE = '55000';
  END IF;

  -- The suspension RECORD is still one-way. Clearing suspended_at is refused as
  -- it always was, and it may not move backwards either: a resume is written to
  -- resumed_at, so the lapse that happened stays on the row forever.
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNSUSPEND' USING ERRCODE = '55000';
  END IF;
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at < OLD.suspended_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SUSPENSION_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNREVOKE' USING ERRCODE = '55000';
  END IF;

  resuming := NEW.resumed_at IS DISTINCT FROM OLD.resumed_at;

  IF OLD.resumed_at IS NOT NULL
     AND (NEW.resumed_at IS NULL OR NEW.resumed_at < OLD.resumed_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.resume_count < OLD.resume_count THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;

  IF resuming THEN
    -- REVOCATION IS FOREVER. This is the fence that keeps "suspended, a person
    -- can bring it back" and "revoked, dead" from ever being the same state.
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE'
        USING ERRCODE = '55000';
    END IF;
    -- A resume answers a suspension that already happened, in a statement that
    -- does not also suspend. Without the second clause a single UPDATE could
    -- suspend and resume at once and mean nothing.
    IF OLD.suspended_at IS NULL
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
       OR NEW.resumed_at <= OLD.suspended_at
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_WITHOUT_SUSPENSION'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.resumed_by IS NULL OR NEW.resume_count <> OLD.resume_count + 1 THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Attribution and the counter move only WITH a resume, so neither can be
    -- edited to imply a resume that did not occur.
    IF NEW.resumed_by IS DISTINCT FROM OLD.resumed_by
       OR NEW.resume_count <> OLD.resume_count
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_spend_or_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() FROM PUBLIC;
