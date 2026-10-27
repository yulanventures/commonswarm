-- Local credentials are account connections; workspace membership is separate authority.
-- No credential, run, family, parent, expiry, hash or hosted grant/seat is rewritten.
SET search_path=pg_catalog;
CREATE FUNCTION swarm.local_parent_connection_live(parent uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g swarm.admin_grants%ROWTYPE;
BEGIN
 IF parent IS NULL THEN RETURN true; END IF;
 SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=parent FOR SHARE;
 RETURN FOUND AND g.state='active' AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.refresh_deadline>clock_timestamp();
END $$;
ALTER FUNCTION swarm.local_parent_connection_live(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.local_parent_connection_live(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION swarm.local_parent_connection_live(uuid) TO swarm_command,swarm_read;

CREATE FUNCTION swarm.local_agent_workspace_live(p_principal uuid,p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am
 JOIN swarm.agent_principals p USING(principal_id,owner_user_id)
 JOIN swarm.memberships m ON m.workspace_id=am.workspace_id AND m.user_id=am.owner_user_id
 JOIN swarm.workspaces w ON w.workspace_id=am.workspace_id
 WHERE am.principal_id=p_principal AND am.workspace_id=p_workspace AND am.revoked_at IS NULL
 AND p.revoked_at IS NULL AND p.transport='local' AND NOT p.turn_only
 AND m.revoked_at IS NULL AND w.archived_at IS NULL)
$$;
ALTER FUNCTION swarm.local_agent_workspace_live(uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.local_agent_workspace_live(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION swarm.local_agent_workspace_live(uuid,uuid) TO swarm_command,swarm_read;
CREATE POLICY server_select ON swarm.agent_workspace_memberships FOR SELECT TO swarm_command,swarm_read USING(true);
GRANT SELECT ON swarm.agent_workspace_memberships TO swarm_command,swarm_read;
GRANT UPDATE(principal_id) ON swarm.agent_workspace_memberships TO swarm_command;
-- Session proof and turn state are keyed by target. The proof fence is never bypassed.
ALTER TABLE swarm.agent_execution_sessions DROP CONSTRAINT agent_execution_sessions_pkey;
ALTER TABLE swarm.agent_execution_sessions ADD PRIMARY KEY(principal_id,workspace_id);
-- Tenant-pinned content/delivery references now point at explicit memberships.
ALTER TABLE swarm.agent_workspace_memberships ADD UNIQUE(principal_id,workspace_id,owner_user_id);
DO $ddl$ DECLARE c record; BEGIN
 FOR c IN SELECT conrelid::regclass AS tbl,conname,pg_get_constraintdef(oid) AS def
 FROM pg_constraint WHERE confrelid='swarm.agent_principals'::regclass AND contype='f'
 AND conrelid IN ('swarm.signals'::regclass,'swarm.signal_deliveries'::regclass,
 'swarm.signal_recipients'::regclass,'swarm.signal_agent_receipts'::regclass,
 'swarm.agent_presence'::regclass,'swarm.agent_wake_leases'::regclass,
 'swarm.h0_poll_locks'::regclass,'swarm.h0_poll_batches'::regclass,
 'swarm.household_todos'::regclass,'swarm.household_agent_work_policies'::regclass,
 'swarm.household_content_connections'::regclass)
 AND pg_get_constraintdef(oid) LIKE '%workspace_id%' LOOP
 EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tbl,c.conname);
 EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',c.tbl,c.conname,
 replace(c.def,'REFERENCES swarm.agent_principals','REFERENCES swarm.agent_workspace_memberships'));
 END LOOP;
END $ddl$;
CREATE OR REPLACE VIEW swarm_read.agent_principals WITH(security_barrier=true) AS
 SELECT p.principal_id,am.workspace_id,p.owner_user_id,p.name,p.created_at,
 coalesce(p.revoked_at,am.revoked_at) AS revoked_at,p.model,p.managed_at,p.transport,p.turn_only
 FROM swarm.agent_principals p JOIN swarm.agent_workspace_memberships am USING(principal_id,owner_user_id)
 WHERE swarm.is_member(am.workspace_id,auth.uid())
 AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id);
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
    AND NOT EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=t.renewal_grant_id
      AND (g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants a WHERE a.grant_id IN
        (t.parent_admin_grant_id,p.parent_admin_grant_id)
      AND (a.state<>'active' OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp()
        OR a.refresh_deadline<=clock_timestamp() ))
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',r.device_id),
       ('renewal_grant',t.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',p.owner_user_id)))) THEN
    IF EXISTS(SELECT 1 FROM swarm.agent_tokens t
      LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
      WHERE t.token_hash=p_hash AND (t.revoked_at IS NOT NULL OR t.surrender_only
        OR g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=clock_timestamp())) THEN
      RAISE EXCEPTION 'LOCAL_CREDENTIAL_INVALID' USING ERRCODE='42501',DETAIL='LOCAL_CREDENTIAL_INVALID';
    END IF;
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
    AND NOT EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=t.renewal_grant_id
      AND (g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL
        OR g.connection_expires_at<=clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants a WHERE a.grant_id IN
        (t.parent_admin_grant_id,p.parent_admin_grant_id)
      AND (a.state<>'active' OR a.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp()
        OR a.refresh_deadline<=clock_timestamp() ))
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
      (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',r.device_id),
       ('renewal_grant',t.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',p.owner_user_id)));
END
$fn$;

CREATE OR REPLACE FUNCTION swarm.discover_local_target_ids(
  p_workspace_id uuid, p_target_user_id uuid, p_principal_ids uuid[],
  p_token_ids uuid[], p_all_workspace boolean, p_resume_family_id uuid, p_revoke_token boolean
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
    OR p_all_workspace IS NULL OR p_revoke_token IS NULL
    OR (p_revoke_token AND (p_resume_family_id IS NOT NULL OR p_target_user_id IS NOT NULL
      OR p_all_workspace OR cardinality(p_principal_ids)<>0 OR cardinality(p_token_ids)<>1))
    OR array_position(p_principal_ids,NULL) IS NOT NULL
    OR array_position(p_token_ids,NULL) IS NOT NULL
    OR cardinality(p_principal_ids)>64 OR cardinality(p_token_ids)>64
    OR cardinality(p_principal_ids)+cardinality(p_token_ids)>128
    OR NOT (
      (p_resume_family_id IS NOT NULL AND p_target_user_id IS NULL AND NOT p_all_workspace
        AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
      OR (p_resume_family_id IS NULL AND (
      (p_target_user_id IS NOT NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
      OR (p_target_user_id IS NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)>0)
      OR (p_target_user_id IS NULL AND p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
    ))) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SELECTOR' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM swarm.agent_principals p
      WHERE p.principal_id=ANY(p_principal_ids) AND p.workspace_id<>p_workspace_id AND p.transport<>'local')
    OR EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.token_id=ANY(p_token_ids) AND p.workspace_id<>p_workspace_id AND p.transport<>'local') THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SCOPE' USING ERRCODE='22023';
  END IF;
  -- Current operation closure: exact proof, its immediate predecessor and
  -- pending/replacement child. History is checked with indexed EXISTS at the
  -- authority gate; it is never recursively enlisted into every request.
  WITH seed_principals AS (
    SELECT p.principal_id FROM swarm.agent_principals p
    WHERE (p.workspace_id=p_workspace_id OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=p.principal_id AND am.workspace_id=p_workspace_id) OR (p.transport='local' AND p.principal_id=ANY(p_principal_ids))) AND
      (p_all_workspace OR p.owner_user_id=p_target_user_id OR p.principal_id=ANY(p_principal_ids)
       OR EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=p_resume_family_id
         AND g.principal_id=p.principal_id AND g.workspace_id=p_workspace_id))
  ), current_tokens AS (
    SELECT t.token_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(p_token_ids)
    UNION
    SELECT t.token_id FROM seed_principals sp JOIN swarm.agent_tokens t USING(principal_id)
    WHERE (p_all_workspace OR cardinality(p_principal_ids)>0 OR p_resume_family_id IS NOT NULL)
      AND (p_resume_family_id IS NULL OR t.renewal_grant_id=p_resume_family_id)
      AND t.revoked_at IS NULL AND (p_resume_family_id IS NULL OR NOT t.surrender_only)
      AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
        WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL
          AND child.first_used_at IS NOT NULL)
  ), family_tokens(id) AS (
    SELECT c.token_id FROM current_tokens c
    UNION SELECT t.predecessor_token_id FROM current_tokens c
      JOIN swarm.agent_tokens t ON t.token_id=c.token_id WHERE t.predecessor_token_id IS NOT NULL
    UNION SELECT child.token_id FROM current_tokens c JOIN swarm.agent_tokens child
      ON child.predecessor_token_id=c.token_id
      WHERE child.revoked_at IS NULL AND (child.first_used_at IS NULL OR p_revoke_token)
        AND (NOT p_revoke_token OR child.lineage_id=(SELECT t.lineage_id FROM swarm.agent_tokens t WHERE t.token_id=c.token_id))
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
    LEFT JOIN swarm.renewal_grants g ON g.principal_id=p.principal_id
      AND (g.revoked_at IS NULL OR p_resume_family_id IS NOT NULL)
      AND (p_resume_family_id IS NULL OR g.renewal_grant_id=p_resume_family_id)
    LEFT JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
    LEFT JOIN LATERAL (
      SELECT DISTINCT t.parent_admin_grant_id FROM swarm.agent_tokens t
      WHERE t.principal_id=p.principal_id AND t.renewal_grant_id IS NOT DISTINCT FROM g.renewal_grant_id
        AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
          WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)
    ) parents ON true
    WHERE (p_resume_family_id IS NULL OR g.renewal_grant_id=p_resume_family_id)
      AND (g.renewal_grant_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM family_tokens f JOIN swarm.agent_tokens t ON t.token_id=f.id
       WHERE t.renewal_grant_id=g.renewal_grant_id))
  )
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.token_id,rows.principal_id,rows.renewal_grant_id),'[]'::jsonb)
  INTO bindings FROM rows;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
      WHERE b.workspace_id<>p_workspace_id AND NOT EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=b.principal_id AND p.transport='local')) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
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
      OR (p_resume_family_id IS NOT NULL AND (g.renewal_grant_id IS DISTINCT FROM p_resume_family_id
        OR (g.bound_device_id IS NOT NULL AND g.bound_device_id IS DISTINCT FROM b.device_id)))
  ) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
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
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
  END IF;
  IF (p_all_workspace OR cardinality(p_token_ids)>0 OR p_resume_family_id IS NOT NULL) AND (jsonb_array_length(bindings)>4096 OR
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
  SELECT t.parent_admin_grant_id, t.scopes, p.workspace_id
  INTO v_parent_admin_grant_id, v_worker_scopes, v_parent_workspace_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING (principal_id)
  WHERE t.token_hash = p_token_hash;
  IF NOT FOUND OR NOT swarm.local_parent_connection_live(v_parent_admin_grant_id)
    OR NOT swarm.admin_child_live(v_parent_admin_grant_id,coalesce(p_workspace_id,v_parent_workspace_id))
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
      AND swarm.admin_child_live(p.parent_admin_grant_id,coalesce(p_workspace_id,p.workspace_id))
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

  IF NOT FOUND AND p_workspace_id IS NOT NULL THEN
    v_revoked := true;
  ELSIF (p_workspace_id IS NOT NULL AND (NOT swarm.local_agent_workspace_live(v_principal_id,p_workspace_id) OR v_membership_revoked_at IS NOT NULL))
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
  principal_workspace_id := p_workspace_id;
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
  -- Active suspension denies every kind; explicit owner resume remains effective.
  IF grant_row.suspension_active THEN
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
    JOIN swarm.devices d USING(device_id)
    WHERE p.principal_id=grant_row.principal_id AND r.run_id=grant_row.run_id AND d.device_id=p_device_id
      AND p.workspace_id=grant_row.workspace_id AND p.owner_user_id=grant_row.created_by
      AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL AND r.ended_at IS NULL
      AND d.revoked_at IS NULL AND d.user_id=p.owner_user_id 
      AND swarm.local_parent_connection_live(p.parent_admin_grant_id))
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
  IF NOT EXISTS(SELECT 1 FROM swarm.agent_principals p
    WHERE p.principal_id=pred.principal_id AND p.transport='local' AND NOT p.turn_only
      
      AND ROW(grant_row.workspace_id,grant_row.principal_id,grant_row.run_id,grant_row.created_by)
        =ROW(p.workspace_id,p.principal_id,pred.run_id,p.owner_user_id)
      AND swarm.local_parent_connection_live(pred.parent_admin_grant_id)
      AND swarm.local_parent_connection_live(p.parent_admin_grant_id)
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
  -- Active suspension denies every kind; explicit owner resume remains effective.
  IF grant_row.suspension_active THEN
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
    OR grant_row.revoked_at IS NOT NULL OR (grant_row.suspension_active)
    OR grant_row.connection_expired_at IS NOT NULL OR grant_row.connection_expires_at<=v_now
    OR NOT EXISTS(SELECT 1 FROM swarm.agent_principals p JOIN swarm.agent_runs r USING(principal_id)
      JOIN swarm.devices d USING(device_id)
      WHERE p.principal_id=token.principal_id AND r.run_id=token.run_id AND d.device_id=p_device_id
        AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL AND r.ended_at IS NULL
        AND d.revoked_at IS NULL AND d.user_id=p.owner_user_id 
        AND ROW(grant_row.principal_id,grant_row.run_id,grant_row.workspace_id,grant_row.created_by)
          =ROW(p.principal_id,r.run_id,p.workspace_id,p.owner_user_id)
        AND swarm.local_parent_connection_live(token.parent_admin_grant_id)
        AND swarm.local_parent_connection_live(p.parent_admin_grant_id)
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
    OR p.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR NOT swarm.local_agent_workspace_live(NEW.principal_id,NEW.workspace_id)
    OR p.transport<>'local' OR p.turn_only OR p.revoked_at IS NOT NULL
    OR r.principal_id<>p.principal_id OR r.ended_at IS NOT NULL OR d.revoked_at IS NOT NULL
    OR d.user_id<>p.owner_user_id
    OR ROW(g.workspace_id,g.principal_id,g.run_id,g.created_by)
      IS DISTINCT FROM ROW(p.workspace_id,NEW.principal_id,NEW.grant_id,NEW.owner_user_id)
    OR t.revoked_at IS NOT NULL OR t.surrender_only OR t.expires_at<=v_now
    OR g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL
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

-- Membership writers run only behind verified human command authentication and
-- the canonical U/parent/W/member/P/session/family/token plan. SQL repeats rights.
CREATE FUNCTION swarm.local_agent_membership_allowed(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM swarm.agent_principals p
 JOIN swarm.memberships actor ON actor.workspace_id=p_workspace AND actor.user_id=p_actor
 JOIN swarm.memberships owner ON owner.workspace_id=p_workspace AND owner.user_id=p.owner_user_id
 JOIN swarm.workspaces target ON target.workspace_id=p_workspace
 WHERE p.principal_id=p_principal AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL
 AND actor.revoked_at IS NULL AND owner.revoked_at IS NULL AND target.archived_at IS NULL
 AND (p.owner_user_id=p_actor OR actor.role IN ('owner','admin'))
 AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p_principal)
 AND (NOT p_add OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am
   JOIN swarm.workspaces origin ON origin.workspace_id=am.workspace_id
   JOIN swarm.memberships om ON om.workspace_id=am.workspace_id AND om.user_id=p.owner_user_id
   WHERE am.principal_id=p_principal AND origin.org_id=target.org_id AND am.revoked_at IS NULL
     AND om.revoked_at IS NULL AND origin.archived_at IS NULL)
   -- Explicitly restoring an existing membership works even when the connection is dormant.
   OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am JOIN swarm.workspaces origin ON origin.workspace_id=p.workspace_id
     WHERE am.principal_id=p_principal AND am.workspace_id=p_workspace AND origin.org_id=target.org_id)))
$$;
CREATE FUNCTION swarm.change_local_agent_membership(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed boolean;
BEGIN
 IF NOT swarm.local_agent_membership_allowed(p_workspace,p_principal,p_actor,p_add) THEN RETURN false; END IF;
 IF p_add THEN
   INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by)
   SELECT p_principal,p_workspace,p.owner_user_id,p_actor FROM swarm.agent_principals p WHERE p.principal_id=p_principal
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET revoked_at=NULL,added_by=p_actor,added_at=clock_timestamp()
   WHERE swarm.agent_workspace_memberships.revoked_at IS NOT NULL;
   PERFORM set_config('cswarm.membership_removal','true',true);
   INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,lifecycle_state,expired_at)
   SELECT principal_id,p_workspace,gen_random_uuid(),'enabled',clock_timestamp() FROM swarm.agent_principals
   WHERE principal_id=p_principal AND managed_at IS NOT NULL
   ON CONFLICT(principal_id,workspace_id) DO NOTHING;
   PERFORM set_config('cswarm.membership_removal','false',true);
 ELSE
   UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
   -- End only the removed target's proof, delivery, wake and content authority.
   PERFORM set_config('cswarm.membership_removal','true',true);
   UPDATE swarm.agent_execution_sessions SET key_hash=NULL,expired_at=clock_timestamp(),generation=generation+1
   WHERE principal_id=p_principal AND workspace_id=p_workspace;
   PERFORM set_config('cswarm.membership_removal','false',true);
   DELETE FROM swarm.agent_wake_leases WHERE principal_id=p_principal AND workspace_id=p_workspace;
   DELETE FROM swarm.h0_poll_locks WHERE principal_id=p_principal AND workspace_id=p_workspace;
   UPDATE swarm.signal_deliveries SET leased_until=NULL,leased_by=NULL,lease_id=NULL,session_id=NULL,session_generation=NULL
   WHERE recipient_agent_principal_id=p_principal AND workspace_id=p_workspace AND acked_at IS NULL;
   UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND hosted_grant_id IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN true;
END $$;
-- Approval pointers are target-specific; no approvals are copied on membership add.
CREATE TABLE swarm.local_content_approval_workspaces(
 renewal_grant_id uuid NOT NULL REFERENCES swarm.renewal_grants(renewal_grant_id),
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
 token_id uuid NOT NULL REFERENCES swarm.agent_tokens(token_id),
 PRIMARY KEY(renewal_grant_id,workspace_id));
ALTER TABLE swarm.local_content_approval_workspaces OWNER TO swarm_admin;
ALTER TABLE swarm.local_content_approval_workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_select ON swarm.local_content_approval_workspaces FOR SELECT TO swarm_command,swarm_read USING(true);
REVOKE ALL ON swarm.local_content_approval_workspaces FROM PUBLIC,anon,authenticated,swarm_command,swarm_read;
GRANT SELECT ON swarm.local_content_approval_workspaces TO swarm_command,swarm_read;
INSERT INTO swarm.local_content_approval_workspaces SELECT renewal_grant_id,workspace_id,local_content_approval_token_id
 FROM swarm.renewal_grants WHERE local_content_approval_token_id IS NOT NULL;
CREATE FUNCTION swarm.set_local_workspace_approval(p_family uuid,p_workspace uuid,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g swarm.renewal_grants%ROWTYPE;
BEGIN
 SELECT * INTO g FROM swarm.renewal_grants WHERE renewal_grant_id=p_family FOR UPDATE;
 IF NOT FOUND OR NOT swarm.local_agent_workspace_live(g.principal_id,p_workspace)
 OR nullif(current_setting('cswarm.household_actor',true),'')::uuid IS DISTINCT FROM g.created_by
 OR coalesce(current_setting('cswarm.household_command',true),'') NOT IN ('household_permissions','household_approve_connection')
 OR nullif(current_setting('cswarm.household_request',true),'') IS NULL
 OR coalesce(current_setting('cswarm.household_digest',true),'') !~ '^[0-9a-f]{64}$'
 OR g.revoked_at IS NOT NULL OR g.suspension_active OR g.connection_expired_at IS NOT NULL OR g.connection_expires_at<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM swarm.household_content_connections c JOIN swarm.agent_tokens t ON t.token_id=c.connection_id
  JOIN swarm.agent_principals p ON p.principal_id=t.principal_id
  JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=p.principal_id
  JOIN swarm.devices d USING(device_id)
  JOIN swarm.household_member_content_roles cr ON cr.workspace_id=c.workspace_id AND cr.user_id=c.owner_user_id
  JOIN swarm.household_workspace_boundaries b ON b.workspace_id=c.workspace_id
  WHERE c.connection_id=p_token AND c.renewal_grant_id=p_family AND c.workspace_id=p_workspace
  AND c.principal_id=g.principal_id AND c.grant_id=g.run_id AND c.owner_user_id=g.created_by AND c.hosted_grant_id IS NULL
  AND t.renewal_grant_id=p_family AND t.principal_id=g.principal_id AND t.run_id=g.run_id
  AND t.revoked_at IS NULL AND NOT t.surrender_only AND t.expires_at>clock_timestamp()
  AND r.ended_at IS NULL AND d.revoked_at IS NULL AND d.user_id=g.created_by AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id)
  AND c.revoked_at IS NULL AND c.expires_at IS NULL AND cr.revoked_at IS NULL AND cr.content_consent_id=c.consent_receipt_id
  AND c.purpose=b.purpose AND (b.purpose='shared' OR b.owner_user_id=g.created_by)
  AND (cr.content_role='editor' OR c.operations=ARRAY['read']::text[])
  AND swarm.admin_child_live(t.parent_admin_grant_id,p_workspace) AND swarm.admin_child_live(p.parent_admin_grant_id,p_workspace)
  AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes) AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,t.scopes)
  AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
    (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
    ('family',t.lineage_id),('lineage',t.lineage_id),('renewal_grant',g.renewal_grant_id),('membership',g.created_by))))
 THEN RAISE EXCEPTION 'LOCAL_ALLOW_BINDING_REFUSED' USING ERRCODE='23514'; END IF;
 INSERT INTO swarm.local_content_approval_workspaces VALUES(p_family,p_workspace,p_token)
 ON CONFLICT(renewal_grant_id,workspace_id) DO UPDATE SET token_id=EXCLUDED.token_id;
 -- Retain the compatibility pointer in its original workspace only.
 IF g.workspace_id=p_workspace THEN
 UPDATE swarm.renewal_grants SET local_content_approval_token_id=p_token WHERE renewal_grant_id=p_family;
 END IF;
END $$;
ALTER FUNCTION swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.change_local_agent_membership(uuid,uuid,uuid,boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.set_local_workspace_approval(uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean),
 swarm.change_local_agent_membership(uuid,uuid,uuid,boolean),swarm.set_local_workspace_approval(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean),
 swarm.change_local_agent_membership(uuid,uuid,uuid,boolean),swarm.set_local_workspace_approval(uuid,uuid,uuid) TO swarm_command;
RESET search_path;
CREATE FUNCTION swarm.remove_local_agents_for_member(p_workspace uuid,p_owner uuid,p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record;
BEGIN
 FOR p IN SELECT am.principal_id FROM swarm.agent_workspace_memberships am JOIN swarm.agent_principals a USING(principal_id)
 WHERE am.workspace_id=p_workspace AND am.owner_user_id=p_owner AND am.revoked_at IS NULL AND a.transport='local'
 ORDER BY am.principal_id LOOP
 IF NOT swarm.change_local_agent_membership(p_workspace,p.principal_id,p_actor,false) THEN
 RAISE EXCEPTION 'LOCAL_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;
ALTER FUNCTION swarm.remove_local_agents_for_member(uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.remove_local_agents_for_member(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,swarm_read;
GRANT EXECUTE ON FUNCTION swarm.remove_local_agents_for_member(uuid,uuid,uuid) TO swarm_command;
CREATE FUNCTION swarm.agent_reachable_workspaces(p_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx record; w record; result jsonb;
BEGIN
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(p_hash,NULL);
 IF NOT FOUND OR ctx.is_revoked THEN RAISE EXCEPTION 'LOCAL_CREDENTIAL_DENIED' USING ERRCODE='42501',DETAIL='LOCAL_CREDENTIAL_DENIED'; END IF;
 -- Owner user and credential closure are held. Lock every discovered target in
 -- UUID order, then owner/agent memberships, and query again after the waits.
 FOR w IN SELECT am.workspace_id FROM swarm.agent_workspace_memberships am WHERE am.principal_id=ctx.principal_id ORDER BY am.workspace_id LOOP
 PERFORM workspace_id FROM swarm.workspaces WHERE workspace_id=w.workspace_id FOR SHARE;
 PERFORM user_id FROM swarm.memberships WHERE workspace_id=w.workspace_id AND user_id=ctx.owner_user_id FOR SHARE;
 PERFORM principal_id FROM swarm.agent_workspace_memberships WHERE workspace_id=w.workspace_id AND principal_id=ctx.principal_id FOR SHARE;
 END LOOP;
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(p_hash,NULL);
 IF NOT FOUND OR ctx.is_revoked THEN RAISE EXCEPTION 'LOCAL_CREDENTIAL_DENIED' USING ERRCODE='42501',DETAIL='LOCAL_CREDENTIAL_DENIED'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('workspace_id',am.workspace_id,'name',ws.name,'org_id',ws.org_id,'org_name',o.display_name,
  'permissions',jsonb_build_object('scopes',t.scopes,'content_operations',coalesce(c.operations,ARRAY[]::text[]))) ORDER BY am.workspace_id),'[]'::jsonb)
 INTO result FROM swarm.agent_workspace_memberships am JOIN swarm.workspaces ws USING(workspace_id)
 JOIN swarm.organizations o ON o.id=ws.org_id JOIN swarm.agent_tokens t ON t.token_id=ctx.token_id
 LEFT JOIN swarm.local_content_approval_workspaces ap ON ap.renewal_grant_id=t.renewal_grant_id AND ap.workspace_id=am.workspace_id
 LEFT JOIN swarm.household_content_connections c ON c.connection_id=ap.token_id AND c.workspace_id=am.workspace_id
   AND c.principal_id=ctx.principal_id AND c.revoked_at IS NULL
 WHERE am.principal_id=ctx.principal_id AND swarm.local_agent_workspace_live(am.principal_id,am.workspace_id)
 AND swarm.admin_child_live(t.parent_admin_grant_id,am.workspace_id)
 AND EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=am.principal_id AND swarm.admin_child_live(p.parent_admin_grant_id,am.workspace_id));
 RETURN result;
END $$;
ALTER FUNCTION swarm.agent_reachable_workspaces(bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_reachable_workspaces(bytea) FROM PUBLIC,anon,authenticated,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.agent_reachable_workspaces(bytea) TO swarm_read;
-- Connection proof survives target-local session withdrawal. It grants renewal
-- only; ordinary mutations still require the target's execution session.
CREATE TABLE swarm.agent_connection_sessions AS SELECT principal_id,session_id,generation,key_hash,expired_at
 FROM swarm.agent_execution_sessions s WHERE workspace_id=(SELECT workspace_id FROM swarm.agent_principals p WHERE p.principal_id=s.principal_id);
ALTER TABLE swarm.agent_connection_sessions ADD PRIMARY KEY(principal_id);
ALTER TABLE swarm.agent_connection_sessions OWNER TO swarm_admin;
ALTER TABLE swarm.agent_connection_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_select ON swarm.agent_connection_sessions FOR SELECT TO swarm_command USING(true);
REVOKE ALL ON swarm.agent_connection_sessions FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT SELECT ON swarm.agent_connection_sessions TO swarm_command;
CREATE FUNCTION swarm.sync_agent_connection_session() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF coalesce(current_setting('cswarm.membership_removal',true),'')='true' THEN RETURN NEW; END IF;
 INSERT INTO swarm.agent_connection_sessions SELECT NEW.principal_id,NEW.session_id,NEW.generation,NEW.key_hash,NEW.expired_at
 ON CONFLICT(principal_id) DO UPDATE SET session_id=EXCLUDED.session_id,generation=EXCLUDED.generation,key_hash=EXCLUDED.key_hash,expired_at=EXCLUDED.expired_at;
 RETURN NEW;
END $$;
ALTER FUNCTION swarm.sync_agent_connection_session() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.sync_agent_connection_session() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
CREATE TRIGGER agent_execution_connection_proof AFTER INSERT OR UPDATE ON swarm.agent_execution_sessions
 FOR EACH ROW EXECUTE FUNCTION swarm.sync_agent_connection_session();

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
        JOIN swarm.memberships m ON m.workspace_id=p_workspace_id AND m.user_id=p.owner_user_id
        JOIN swarm.workspaces w ON w.workspace_id=p_workspace_id
        WHERE swarm.local_agent_workspace_live(p.principal_id,p_workspace_id) AND p.principal_id=p_principal_id
          AND p.owner_user_id=p_owner_user_id AND p.transport='local' AND p.revoked_at IS NULL AND NOT p.turn_only
          AND t.revoked_at IS NULL AND NOT t.surrender_only AND r.ended_at IS NULL AND d.revoked_at IS NULL
          AND d.user_id=p.owner_user_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
          AND (t.renewal_grant_id IS NULL OR g.renewal_grant_id IS NOT NULL AND g.revoked_at IS NULL
            AND NOT g.suspension_active
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
  WHERE swarm.local_agent_workspace_live(g.principal_id,p_workspace_id) AND g.principal_id=p_principal_id AND g.created_by=p_owner_user_id
  UNION ALL
  SELECT NULL,e.token_id,true,true,e.issued_at FROM eligible_tokens e WHERE e.renewal_grant_id IS NULL
 )
 SELECT c.renewal_grant_id,c.token_id,c.eligible FROM choices c
 ORDER BY c.eligible DESC,(c.renewal_grant_id IS NOT NULL) DESC,c.unrevoked DESC,
   c.created_at DESC,c.renewal_grant_id DESC,c.token_id DESC LIMIT 1
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
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
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
  WHERE (principal.workspace_id = p_workspace_id AND principal.transport='hosted_mcp' OR swarm.local_agent_workspace_live(principal.principal_id,p_workspace_id))
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
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
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
    AND swarm.local_agent_workspace_live(grant_row.principal_id,p_workspace_id)
    AND (principal.workspace_id = p_workspace_id AND principal.transport='hosted_mcp' OR swarm.local_agent_workspace_live(principal.principal_id,p_workspace_id))
    AND principal.revoked_at IS NULL;
$$;
-- One connection proof may seed separately scoped execution state on explicit add.
DROP INDEX swarm.agent_execution_sessions_session_id_idx;
CREATE INDEX agent_execution_sessions_session_id_idx ON swarm.agent_execution_sessions(session_id);
CREATE FUNCTION swarm.activate_local_workspace_session(p_principal uuid,p_workspace uuid,p_session uuid,p_generation bigint,p_key bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proof swarm.agent_connection_sessions%ROWTYPE;
BEGIN
 SELECT * INTO proof FROM swarm.agent_connection_sessions WHERE principal_id=p_principal FOR SHARE;
 IF NOT FOUND OR proof.session_id<>p_session OR proof.generation<>p_generation OR proof.key_hash IS DISTINCT FROM p_key
 OR proof.key_hash IS NULL OR proof.expired_at IS NULL OR proof.expired_at<=clock_timestamp()
 OR NOT swarm.local_agent_workspace_live(p_principal,p_workspace) THEN RETURN false; END IF;
 UPDATE swarm.agent_execution_sessions SET session_id=proof.session_id,generation=proof.generation,key_hash=proof.key_hash,
   expired_at=proof.expired_at,renewed_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE principal_id=p_principal AND workspace_id=p_workspace AND key_hash IS NULL AND lifecycle_state='enabled';
 RETURN FOUND;
END $$;
ALTER FUNCTION swarm.activate_local_workspace_session(uuid,uuid,uuid,bigint,bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.activate_local_workspace_session(uuid,uuid,uuid,bigint,bytea) FROM PUBLIC,anon,authenticated,swarm_read;
GRANT EXECUTE ON FUNCTION swarm.activate_local_workspace_session(uuid,uuid,uuid,bigint,bytea) TO swarm_command;

ALTER POLICY admin_parent_select ON swarm.agent_tokens USING (
 swarm.admin_child_scopes_live(parent_admin_grant_id,scopes) AND
 CASE WHEN EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=agent_tokens.principal_id AND p.transport='local')
 THEN swarm.local_parent_connection_live(parent_admin_grant_id)
 ELSE swarm.admin_child_live(parent_admin_grant_id,(SELECT workspace_id FROM swarm.agent_principals p WHERE p.principal_id=agent_tokens.principal_id)) END);

CREATE OR REPLACE FUNCTION swarm.admin_token_ancestry() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent uuid; workspace uuid; recipient uuid; owner_user uuid; g swarm.admin_grants%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.parent_admin_grant_id IS DISTINCT FROM OLD.parent_admin_grant_id OR NEW.recipient_connection_id IS DISTINCT FROM OLD.recipient_connection_id THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.parent_admin_grant_id,p.workspace_id,p.owner_user_id INTO parent,workspace,owner_user FROM swarm.agent_principals p WHERE p.principal_id=NEW.principal_id;
  IF NEW.predecessor_token_id IS NOT NULL THEN
    SELECT t.parent_admin_grant_id,t.recipient_connection_id INTO parent,recipient FROM swarm.agent_tokens t WHERE t.token_id=NEW.predecessor_token_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_PREDECESSOR_MISSING' USING ERRCODE='55000'; END IF;
    IF NEW.parent_admin_grant_id IS NOT NULL AND NEW.parent_admin_grant_id IS DISTINCT FROM parent THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_MISMATCH' USING ERRCODE='55000'; END IF;
    NEW.parent_admin_grant_id:=parent; NEW.recipient_connection_id:=recipient;
  ELSIF parent IS NOT NULL THEN
    IF NEW.parent_admin_grant_id IS NOT NULL AND NEW.parent_admin_grant_id IS DISTINCT FROM parent THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_MISMATCH' USING ERRCODE='55000'; END IF;
    NEW.parent_admin_grant_id:=parent;
  END IF;
  IF NEW.parent_admin_grant_id IS NOT NULL THEN
    SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=NEW.parent_admin_grant_id;
    IF NOT FOUND OR g.owner_user_id IS DISTINCT FROM owner_user OR NEW.recipient_connection_id IS NULL
      OR NOT NEW.recipient_connection_id=ANY(ARRAY(SELECT jsonb_array_elements_text(g.target_rules->'recipient_connection_ids')::uuid))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.scopes) scope WHERE NOT scope=ANY(g.worker_scope_ceiling))
    THEN RAISE EXCEPTION 'ADMIN_CHILD_BINDING_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  IF NOT (CASE WHEN NEW.predecessor_token_id IS NOT NULL THEN swarm.local_parent_connection_live(NEW.parent_admin_grant_id) ELSE swarm.admin_child_live(NEW.parent_admin_grant_id,workspace) END) THEN
    RAISE EXCEPTION 'ADMIN_PARENT_INACTIVE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
