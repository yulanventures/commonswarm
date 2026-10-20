-- Inseparable from 00007 + the reviewed complete caller lock plan.
-- Table ownership supplies hidden-token visibility; no RLS/role widening.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_revoke_cascade()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE
  ids uuid[];
  current_ids uuid[];
  initial_bindings jsonb;
  current_bindings jsonb;
  item record;
  n integer;
  v_now timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA<>'swarm' OR TG_TABLE_NAME<>'renewal_grants'
    OR TG_OP<>'UPDATE' OR pg_trigger_depth()<1
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'LOCAL_CASCADE_TRIGGER_ONLY' USING ERRCODE='42501';
  END IF;
  -- Caller holds P and the entire sorted G union before this trigger runs.
  -- Full metadata discovery refuses malformed/capped closures before token locks.
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO initial_bindings FROM swarm.discover_local_target_ids(NEW.workspace_id,NULL,
      ARRAY[NEW.principal_id],ARRAY[]::uuid[],false) b;
  SELECT coalesce(array_agg(t.token_id ORDER BY t.token_id),ARRAY[]::uuid[]) INTO ids
    FROM swarm.agent_tokens t WHERE t.renewal_grant_id=NEW.renewal_grant_id;
  n:=0;
  FOR item IN
    WITH RECURSIVE tree(token_id,depth) AS (
      SELECT t.token_id,0 FROM swarm.agent_tokens t
      WHERE t.token_id=ANY(ids) AND NOT coalesce(t.predecessor_token_id=ANY(ids),false)
      UNION ALL
      SELECT t.token_id,tree.depth+1 FROM tree JOIN swarm.agent_tokens t
        ON t.predecessor_token_id=tree.token_id WHERE t.token_id=ANY(ids)
    ) SELECT tree.token_id FROM tree ORDER BY depth,tree.token_id
  LOOP
    PERFORM t.token_id FROM swarm.agent_tokens t WHERE t.token_id=item.token_id FOR UPDATE;
    n:=n+1;
  END LOOP;
  IF n<>cardinality(ids) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_CYCLE' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(t.token_id ORDER BY t.token_id),ARRAY[]::uuid[]) INTO current_ids
    FROM swarm.agent_tokens t WHERE t.renewal_grant_id=NEW.renewal_grant_id;
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.token_id,b.principal_id,b.renewal_grant_id),'[]'::jsonb)
    INTO current_bindings FROM swarm.discover_local_target_ids(NEW.workspace_id,NULL,
      ARRAY[NEW.principal_id],ARRAY[]::uuid[],false) b;
  IF current_ids IS DISTINCT FROM ids OR current_bindings IS DISTINCT FROM initial_bindings THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  v_now:=clock_timestamp();
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    VALUES('renewal_grant',NEW.renewal_grant_id,NEW.revoked_by) ON CONFLICT DO NOTHING;
  UPDATE swarm.agent_tokens t SET revoked_at=v_now
    WHERE t.token_id=ANY(ids) AND t.revoked_at IS NULL;
  RETURN NULL;
END
$fn$;
ALTER FUNCTION swarm.renewal_grants_revoke_cascade() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_revoke_cascade()
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

-- Trusted command-service API. HTTP admission supplies the human identity.
-- Actor UUID alone is never treated as externally authenticated identity.
CREATE FUNCTION swarm.revoke_local_residual_tokens(
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
  ids uuid[];
  before_bindings jsonb;
  after_bindings jsonb;
  item record;
  n integer;
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
      WHERE t.token_id=p_target_id AND p.workspace_id=p_workspace_id AND p.transport='local';
    principal_ids:=ARRAY[target_principal];
  END IF;
  IF target_owner IS NULL OR (actor_role NOT IN ('owner','admin') AND target_owner<>p_actor_id) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  -- Discovery is bounded independently of the narrower mutation target.
  IF p_kind='remove_member' THEN
    PERFORM * FROM swarm.discover_local_target_ids(p_workspace_id,p_target_id,ARRAY[]::uuid[],ARRAY[]::uuid[],false);
  ELSE
    PERFORM * FROM swarm.discover_local_target_ids(p_workspace_id,NULL,principal_ids,ARRAY[]::uuid[],false);
  END IF;
  -- Live-bound tokens must go through grant revocation, never this shortcut.
  IF EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_LIVE_GRANT' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(t.token_id,t.principal_id,t.run_id,t.lineage_id,t.predecessor_token_id,
      t.renewal_grant_id,p.owner_user_id,p.workspace_id,t.parent_admin_grant_id,p.parent_admin_grant_id)
      ORDER BY t.token_id),'[]'::jsonb),
    coalesce(array_agg(t.token_id ORDER BY t.token_id),ARRAY[]::uuid[])
    INTO before_bindings,ids
    FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    LEFT JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND p.workspace_id=p_workspace_id
      AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      AND (t.renewal_grant_id IS NULL OR g.revoked_at IS NOT NULL);
  n:=0;
  FOR item IN
    WITH RECURSIVE tree(token_id,depth) AS (
      SELECT t.token_id,0 FROM swarm.agent_tokens t WHERE t.token_id=ANY(ids)
        AND NOT coalesce(t.predecessor_token_id=ANY(ids),false)
      UNION ALL SELECT t.token_id,tree.depth+1 FROM tree JOIN swarm.agent_tokens t
        ON t.predecessor_token_id=tree.token_id WHERE t.token_id=ANY(ids)
    ) SELECT tree.token_id FROM tree ORDER BY depth,tree.token_id
  LOOP
    PERFORM t.token_id FROM swarm.agent_tokens t WHERE t.token_id=item.token_id FOR UPDATE;
    n:=n+1;
  END LOOP;
  IF n<>cardinality(ids) THEN RAISE EXCEPTION 'LOCAL_DISCOVERY_CYCLE' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(t.token_id,t.principal_id,t.run_id,t.lineage_id,t.predecessor_token_id,
      t.renewal_grant_id,p.owner_user_id,p.workspace_id,t.parent_admin_grant_id,p.parent_admin_grant_id)
      ORDER BY t.token_id),'[]'::jsonb) INTO after_bindings
    FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    LEFT JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND p.workspace_id=p_workspace_id
      AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      AND (t.renewal_grant_id IS NULL OR g.revoked_at IS NOT NULL);
  IF after_bindings IS DISTINCT FROM before_bindings THEN
    RAISE EXCEPTION 'LOCAL_AUTH_DISCOVERY_CHANGED' USING ERRCODE='40001',DETAIL='LOCAL_AUTH_DISCOVERY_CHANGED';
  END IF;
  v_now:=clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    WHERE m.workspace_id=p_workspace_id AND m.user_id=p_actor_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
      AND (m.role IN ('owner','admin') OR target_owner=p_actor_id)) THEN
    RAISE EXCEPTION 'LOCAL_RESIDUAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    SELECT 'renewal_grant',t.renewal_grant_id,p_actor_id FROM swarm.agent_tokens t
      WHERE t.token_id=ANY(ids) AND t.renewal_grant_id IS NOT NULL ON CONFLICT DO NOTHING;
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    SELECT 'token',t.token_id,p_actor_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(ids) ON CONFLICT DO NOTHING;
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    SELECT 'lineage',t.lineage_id,p_actor_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(ids) ON CONFLICT DO NOTHING;
  UPDATE swarm.agent_tokens t SET revoked_at=v_now WHERE t.token_id=ANY(ids) AND t.revoked_at IS NULL;
END
$fn$;
ALTER FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid) TO swarm_command;
