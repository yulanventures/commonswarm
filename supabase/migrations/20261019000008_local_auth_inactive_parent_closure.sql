-- Inseparable from 00007 + the reviewed complete caller lock plan.
-- Table ownership supplies hidden-token visibility; no RLS/role widening.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_revoke_cascade()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE
  item record;
  v_now timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA<>'swarm' OR TG_TABLE_NAME<>'renewal_grants'
    OR TG_OP<>'UPDATE' OR pg_trigger_depth()<1
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'LOCAL_CASCADE_TRIGGER_ONLY' USING ERRCODE='42501';
  END IF;
  -- P and the complete sorted G union are preheld. The durable family fence
  -- ends every obsolete proof before cleanup, irrespective of history size.
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
    VALUES('renewal_grant',NEW.renewal_grant_id,NEW.revoked_by) ON CONFLICT DO NOTHING;
  -- Lock only the current proof/pending child, not the rotation history.
  FOR item IN SELECT t.token_id,t.predecessor_token_id
    FROM swarm.agent_tokens t WHERE t.renewal_grant_id=NEW.renewal_grant_id
      AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
        WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)
    ORDER BY (t.predecessor_token_id IS NOT NULL),t.issued_at,t.token_id
  LOOP
    PERFORM t.token_id FROM swarm.agent_tokens t WHERE t.token_id=item.token_id FOR UPDATE;
    v_now:=clock_timestamp();
    UPDATE swarm.agent_tokens t SET revoked_at=v_now
      WHERE t.token_id=item.token_id AND t.revoked_at IS NULL;
  END LOOP;
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
      WHERE t.token_id=p_target_id AND p.workspace_id=p_workspace_id AND p.transport='local';
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
    WHERE p.workspace_id=p_workspace_id AND t.principal_id=ANY(principal_ids)
      AND (p_kind<>'revoke_agent_token' OR t.lineage_id=target_lineage)
      ON CONFLICT DO NOTHING;
  FOR item IN SELECT t.token_id FROM swarm.agent_tokens t
    JOIN swarm.agent_principals p USING(principal_id)
    LEFT JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.principal_id=ANY(principal_ids) AND p.workspace_id=p_workspace_id
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
