-- seat_admin_status (for the site's admin switches) and the grant list it resolves against.
--
-- my_seat_admin_status(): the signed-in person's own live agents, with the ids the grant command would accept for
-- each level today (display guidance; the command edge stays authoritative) and the agent's active grant ids
-- (the same effective state as my_seat_admin_grants: expired grants are not active).
-- my_seat_admin_grants(): unchanged shape; it now always includes every active grant beyond the latest 100, so
-- an id in active_grant_ids never fails to resolve.

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
    'created_at', g.created_at, 'ended_at', g.ended_at, 'end_reason', g.end_reason) ORDER BY g.created_at DESC), '[]'::jsonb)
  -- The latest 100, plus every active grant however old: seat_admin_status's active_grant_ids always resolve here.
  FROM swarm.seat_admin_grants g WHERE g.owner_user_id = viewer AND (g.state = 'active' OR g.grant_id IN (
    SELECT r.grant_id FROM swarm.seat_admin_grants r WHERE r.owner_user_id = viewer ORDER BY r.created_at DESC LIMIT 100))));
END;
$$;

CREATE FUNCTION swarm_read.my_seat_admin_status()
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
 RETURN jsonb_build_object('agents', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'principal_id', p.principal_id, 'name', p.name,
    -- The grant command's own rules: workspaces the person owns where the agent is a live member; organizations the
    -- person owns. Hosted (turn-only) agents have no seat admin path, so nothing is eligible for them.
    'eligible', CASE WHEN p.transport = 'local' AND NOT p.turn_only THEN jsonb_build_object(
      'workspace', ws.ids, 'organization', orgs.ids, 'scoped', ws.ids)
      ELSE jsonb_build_object('workspace', '[]'::jsonb, 'organization', '[]'::jsonb, 'scoped', '[]'::jsonb) END,
    'active_grant_ids', (SELECT coalesce(jsonb_agg(g.grant_id ORDER BY g.grant_id), '[]'::jsonb) FROM swarm.seat_admin_grants g
      WHERE g.principal_id = p.principal_id AND g.owner_user_id = viewer AND g.state = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp()))
   ) ORDER BY p.name, p.principal_id), '[]'::jsonb)
  FROM swarm.agent_principals p
  CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(w.workspace_id ORDER BY w.workspace_id), '[]'::jsonb) AS ids
    FROM swarm.workspaces w
    JOIN swarm.memberships m ON m.workspace_id = w.workspace_id AND m.user_id = viewer AND m.role = 'owner' AND m.revoked_at IS NULL
    JOIN swarm.agent_workspace_memberships am ON am.workspace_id = w.workspace_id AND am.principal_id = p.principal_id
      AND am.revoked_at IS NULL
    WHERE w.archived_at IS NULL) ws
  CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(o.id ORDER BY o.id), '[]'::jsonb) AS ids
    FROM swarm.organizations o
    JOIN swarm.org_memberships om ON om.org_id = o.id AND om.principal_kind = 'user' AND om.principal_id = viewer
      AND om.role = 'owner' AND om.revoked_at IS NULL
    WHERE o.archived_at IS NULL) orgs
  WHERE p.owner_user_id = viewer AND p.revoked_at IS NULL));
END;
$$;
ALTER FUNCTION swarm_read.my_seat_admin_status() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.my_seat_admin_status() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.my_seat_admin_status() TO swarm_read;
