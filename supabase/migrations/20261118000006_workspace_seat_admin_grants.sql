-- 20261118000006: an owner of a workspace reads every agent admin grant that covers it.
--
-- People & agents, the Admins tab (design in docs/design/2026-11-18-PEOPLE-AND-AGENTS-DIALOG.md; the owner's
-- decision 3 on 2026-11-18): an owner sees all admin access in the workspace, not only the grants they gave. Until
-- now a person could read only their own grants (swarm_read.my_seat_admin_grants). This adds one read and changes
-- nothing else: no table, no column, no existing function.
--
-- Who may read: a person signed in as themselves who is a live owner of the live workspace. Anyone else (an admin, a
-- member, a stranger, an agent credential) and any unknown or archived workspace get NULL, so the read never says
-- whether a workspace exists.
--
-- What it lists: grants still in force (active, end date not passed) that cover the workspace. A scoped or workspace
-- grant covers the workspaces it names; an organization grant covers every workspace of its organization and names
-- none. A grant's row state says nothing about whether its grantor is still an owner; the command re-checks that at
-- use. The list is of grants on record, so an owner can see and end one that no longer has effect.
--
-- may_end repeats end_seat_admin's own rule, so the page offers Remove only where the command would accept it: the
-- grantor; for a scoped or workspace grant a live owner of a covered workspace, which the viewer is; for an
-- organization grant a live owner of that organization. The command still decides.
--
-- Disclosure, beyond what the viewer could already read: the grant's level and end date, the agent's name, and the
-- display name of the person who gave it. No manifest, digest, scope list of other workspaces, or organization id.
CREATE FUNCTION swarm_read.workspace_seat_admin_grants(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 org uuid;
 org_owner boolean;
BEGIN
 IF p_workspace_id IS NULL OR claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 SELECT w.org_id INTO org FROM swarm.workspaces w
  JOIN swarm.memberships m ON m.workspace_id = w.workspace_id AND m.user_id = viewer AND m.role = 'owner' AND m.revoked_at IS NULL
  WHERE w.workspace_id = p_workspace_id AND w.archived_at IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 org_owner := EXISTS (SELECT 1 FROM swarm.org_memberships o WHERE o.org_id = org AND o.principal_kind = 'user'
  AND o.principal_id = viewer AND o.role = 'owner' AND o.revoked_at IS NULL);
 RETURN jsonb_build_object('grants', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grant_id', g.grant_id, 'principal_id', g.principal_id, 'agent_name', p.name,
    'owner_user_id', g.owner_user_id, 'owner_display', u.display_name,
    'level', g.level, 'expires_at', g.expires_at, 'created_at', g.created_at,
    'may_end', g.owner_user_id = viewer OR g.level <> 'organization' OR org_owner)
    ORDER BY g.created_at DESC, g.grant_id), '[]'::jsonb)
  FROM swarm.seat_admin_grants g
  JOIN swarm.agent_principals p ON p.principal_id = g.principal_id
  LEFT JOIN swarm.users u ON u.user_id = g.owner_user_id
  WHERE g.state = 'active' AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())
   AND ((g.level <> 'organization' AND p_workspace_id = ANY(g.workspace_ids))
     OR (g.level = 'organization' AND g.organization_id = org))));
END;
$$;
ALTER FUNCTION swarm_read.workspace_seat_admin_grants(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.workspace_seat_admin_grants(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.workspace_seat_admin_grants(uuid) TO authenticated;

-- Rollback (verbatim in deploy/release-proofs/workspace-admin-access-read/20261118000006-rollback.sql):
-- DROP FUNCTION IF EXISTS swarm_read.workspace_seat_admin_grants(uuid);
