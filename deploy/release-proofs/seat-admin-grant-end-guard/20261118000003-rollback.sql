-- Rollback for 20261118000003 (seat admin grant end guard): put swarm_read.my_seat_admin_grants back exactly as
-- 20261110000004_seat_admin_status.sql defines it (owner and grants carry over through CREATE OR REPLACE), then drop
-- the agent's ended-grants read, the two end functions, the admin_events creation stamp, the end guard, the end-actor
-- helper and ended_by_user_id, and give the command role back its direct end. swarm.agent_seat_admin_self was not
-- changed. Who ended each grant stays in the grantors' admin history.
-- Roll the edge back first: this release's end_seat_admin and lazy expiry call the end functions and its
-- seat_admin_self read calls swarm.agent_seat_admin_self_ended.
SET search_path = swarm, pg_catalog, public;
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
DROP FUNCTION IF EXISTS swarm.agent_seat_admin_self_ended(bytea, uuid);
DROP FUNCTION IF EXISTS swarm.end_seat_admin_grant(uuid, uuid, text, timestamptz);
DROP FUNCTION IF EXISTS swarm.expire_seat_admin_grant(uuid);
DROP TRIGGER IF EXISTS admin_events_stamp_creation_xact ON swarm.admin_events;
DROP FUNCTION IF EXISTS swarm.stamp_admin_event_creation_xact();
ALTER TABLE swarm.admin_events DROP COLUMN IF EXISTS creation_xact_id, DROP COLUMN IF EXISTS creation_system_identifier;
DROP TRIGGER IF EXISTS seat_admin_grants_owner_or_expiry_end ON swarm.seat_admin_grants;
DROP FUNCTION IF EXISTS swarm.seat_admin_grants_end_guard();
DROP FUNCTION IF EXISTS swarm.seat_admin_grant_end_actor(uuid, uuid);
ALTER TABLE swarm.seat_admin_grants DROP CONSTRAINT IF EXISTS seat_admin_grants_ended_by_check;
ALTER TABLE swarm.seat_admin_grants DROP COLUMN IF EXISTS ended_by_user_id;
-- The command role's direct end, exactly as 20261109000001 granted it, and no lock-only column.
REVOKE UPDATE (grant_id) ON swarm.seat_admin_grants FROM swarm_command;
GRANT UPDATE (state, ended_at, end_reason) ON swarm.seat_admin_grants TO swarm_command;
RESET search_path;
