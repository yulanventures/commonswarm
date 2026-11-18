-- Seat admin: only an owner's choice or a real expiry ends a grant, and who ended it is visible.
--
-- ended_by_user_id: the person who ended a grant with end_seat_admin; NULL for an expiry. Rows ended before this
-- column existed are not backfilled (the forward-only trigger forbids it); the reads derive their actor from the
-- grantor's admin history instead: the accepted end_seat_admin AdminActionRecorded event that names the grant.
--
-- seat_admin_grants_end_guard: a grant leaves 'active' only as
--   'downgraded' / 'owner_downgrade', ended by the grantor or a live owner of a workspace or organization it covers
--   (the command edge's ownsCovered rule), or
--   'expired' / 'expired', once its set end date has passed.
-- Anything else, including a cascade or a 'replaced' re-grant, is refused. The trigger is named to fire after
-- seat_admin_grants_forward_only, which still owns the shape of the change (active to one terminal state, once).
--
-- The agent's own read: agent_seat_admin_self is unchanged (the active list alone, so an edge released before this
-- keeps working); agent_seat_admin_self_ended lists at most 10 of the agent's own ended grants, newest first,
-- including grants whose end date has passed.
-- The person's read (my_seat_admin_grants) adds ended_by to each row.

ALTER TABLE swarm.seat_admin_grants ADD COLUMN ended_by_user_id uuid;
ALTER TABLE swarm.seat_admin_grants ADD CONSTRAINT seat_admin_grants_ended_by_check
  CHECK (ended_by_user_id IS NULL OR end_reason = 'owner_downgrade');
GRANT UPDATE (ended_by_user_id) ON swarm.seat_admin_grants TO swarm_command;

CREATE FUNCTION swarm.seat_admin_grants_end_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Every other change is the forward-only trigger's to refuse.
  IF OLD.state <> 'active' OR NEW.state = 'active' THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'expired' AND NEW.end_reason = 'expired' AND NEW.ended_by_user_id IS NULL
     AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp() THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'downgraded' AND NEW.end_reason = 'owner_downgrade' AND NEW.ended_by_user_id IS NOT NULL THEN
    -- The grantor first: their own end takes no further lock.
    IF NEW.ended_by_user_id = OLD.owner_user_id THEN
      RETURN NEW;
    END IF;
    IF OLD.level = 'organization' THEN
      IF coalesce((swarm.seat_admin_org_owner(OLD.organization_id, NEW.ended_by_user_id)->>'owner')::boolean, false) THEN
        RETURN NEW;
      END IF;
    ELSIF EXISTS(SELECT 1 FROM swarm.memberships m WHERE m.workspace_id = ANY(OLD.workspace_ids)
        AND m.user_id = NEW.ended_by_user_id AND m.role = 'owner' AND m.revoked_at IS NULL) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a seat admin grant only ends by an owner''s choice or at its end date'
    USING ERRCODE = '42501', DETAIL = 'seat_admin_end_refused';
END;
$$;
CREATE TRIGGER seat_admin_grants_owner_or_expiry_end BEFORE UPDATE ON swarm.seat_admin_grants
  FOR EACH ROW EXECUTE FUNCTION swarm.seat_admin_grants_end_guard();
ALTER FUNCTION swarm.seat_admin_grants_end_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_admin_grants_end_guard() FROM PUBLIC;

-- The person who ended a grant before ended_by_user_id existed, from the grantor's own admin history.
CREATE FUNCTION swarm.seat_admin_grant_end_actor(p_owner uuid, p_grant uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (e.event->>'actor_user')::uuid FROM swarm.admin_events e
  WHERE e.owner_user_id = p_owner AND e.event->>'type' = 'AdminActionRecorded'
    AND e.event->'payload'->>'action' = 'end_seat_admin' AND e.event->'payload'->>'outcome' = 'accepted'
    AND e.event->'payload'->>'target_id' = p_grant::text
    AND coalesce(e.event->>'actor_user', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY e.seq LIMIT 1
$$;
ALTER FUNCTION swarm.seat_admin_grant_end_actor(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_admin_grant_end_actor(uuid, uuid) FROM PUBLIC;

-- The agent's own ended grants, beside agent_seat_admin_self (unchanged: the active list alone), with the same
-- credential check. At most 10, newest first; a grant past its end date counts as expired before it is marked.
-- ended_by names a role, never another person: the agent's owner, or another owner of a covered target.
CREATE FUNCTION swarm.agent_seat_admin_self_ended(p_hash bytea, p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
 ctx record;
 result jsonb;
BEGIN
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(p_hash, p_workspace);
 IF NOT FOUND OR ctx.is_revoked THEN
  RAISE EXCEPTION 'LOCAL_CREDENTIAL_DENIED' USING ERRCODE = '42501', DETAIL = 'LOCAL_CREDENTIAL_DENIED';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'grant_id', e.grant_id, 'level', e.level, 'workspace_ids', to_jsonb(e.workspace_ids), 'organization_id', e.organization_id,
   'state', e.state, 'end_reason', e.end_reason, 'ended_at', e.ended_at,
   'ended_by', CASE WHEN e.actor IS NULL THEN NULL WHEN e.actor = e.owner_user_id THEN 'owner' ELSE 'another_owner' END)
   ORDER BY e.ended_at DESC, e.grant_id), '[]'::jsonb)
 INTO result
 FROM (SELECT r.*, coalesce(r.ended_by_user_id, CASE WHEN r.end_reason = 'owner_downgrade'
         THEN swarm.seat_admin_grant_end_actor(r.owner_user_id, r.grant_id) END) AS actor
   FROM (SELECT g.grant_id, g.level, g.workspace_ids, g.organization_id, g.owner_user_id, g.ended_by_user_id,
       CASE WHEN g.state = 'active' THEN 'expired' ELSE g.state END AS state,
       CASE WHEN g.state = 'active' THEN 'expired' ELSE g.end_reason END AS end_reason,
       CASE WHEN g.state = 'active' THEN g.expires_at ELSE g.ended_at END AS ended_at
     FROM swarm.seat_admin_grants g
     WHERE g.principal_id = ctx.principal_id AND g.owner_user_id = ctx.owner_user_id
       AND (g.state <> 'active' OR g.expires_at <= clock_timestamp())
     ORDER BY CASE WHEN g.state = 'active' THEN g.expires_at ELSE g.ended_at END DESC, g.grant_id LIMIT 10) r) e;
 RETURN result;
END;
$$;
ALTER FUNCTION swarm.agent_seat_admin_self_ended(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_seat_admin_self_ended(bytea, uuid) FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.agent_seat_admin_self_ended(bytea, uuid) TO swarm_read;

CREATE OR REPLACE FUNCTION swarm_read.my_seat_admin_grants()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 RETURN jsonb_build_object('grants', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grant_id', g.grant_id, 'principal_id', g.principal_id, 'level', g.level, 'organization_id', g.organization_id,
    'scope_names', to_jsonb(g.scope_names),
    'workspace_ids', to_jsonb(g.workspace_ids), 'registry_version', g.registry_version,
    'expires_at', g.expires_at, 'state', CASE WHEN g.state = 'active' AND g.expires_at <= statement_timestamp()
      THEN 'expired' ELSE g.state END,
    'created_at', g.created_at, 'ended_at', g.ended_at, 'end_reason', g.end_reason,
    -- The person who ended it: recorded on the row, or for an older end, in the grantor's history.
    'ended_by', coalesce(g.ended_by_user_id, CASE WHEN g.state <> 'active' AND g.end_reason = 'owner_downgrade'
      THEN swarm.seat_admin_grant_end_actor(g.owner_user_id, g.grant_id) END)) ORDER BY g.created_at DESC), '[]'::jsonb)
  -- The latest 100, plus every active grant however old: seat_admin_status's active_grant_ids always resolve here.
  FROM swarm.seat_admin_grants g WHERE g.owner_user_id = viewer AND (g.state = 'active' OR g.grant_id IN (
    SELECT r.grant_id FROM swarm.seat_admin_grants r WHERE r.owner_user_id = viewer ORDER BY r.created_at DESC LIMIT 100))));
END;
$$;
