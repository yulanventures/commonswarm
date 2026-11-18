-- Rollback for 20261118000003 (seat admin grant end guard): put swarm.agent_seat_admin_self back exactly as
-- 20261111000001_seat_admin_self.sql defines it and swarm_read.my_seat_admin_grants exactly as
-- 20261110000004_seat_admin_status.sql defines it (owners and grants carry over through CREATE OR REPLACE), then drop
-- the end guard, the end-actor helper and ended_by_user_id. Who ended each grant stays in the grantors' admin history.
-- Roll the edge back first: this release's end_seat_admin writes ended_by_user_id.
SET search_path = swarm, pg_catalog, public;
CREATE OR REPLACE FUNCTION swarm.agent_seat_admin_self(p_hash bytea, p_workspace uuid) RETURNS jsonb
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
   'grant_id', g.grant_id, 'level', g.level, 'scope_names', to_jsonb(g.scope_names), 'workspace_ids', to_jsonb(g.workspace_ids),
   'organization_id', g.organization_id, 'capability_names', coalesce(g.manifest -> 'capability_names', '[]'::jsonb),
   'expires_at', g.expires_at) ORDER BY g.grant_id), '[]'::jsonb)
 INTO result
 FROM swarm.seat_admin_grants g
 WHERE g.principal_id = ctx.principal_id AND g.owner_user_id = ctx.owner_user_id AND g.state = 'active'
   AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp());
 RETURN result;
END;
$$;
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
DROP TRIGGER IF EXISTS seat_admin_grants_owner_or_expiry_end ON swarm.seat_admin_grants;
DROP FUNCTION IF EXISTS swarm.seat_admin_grants_end_guard();
DROP FUNCTION IF EXISTS swarm.seat_admin_grant_end_actor(uuid, uuid);
ALTER TABLE swarm.seat_admin_grants DROP CONSTRAINT IF EXISTS seat_admin_grants_ended_by_check;
ALTER TABLE swarm.seat_admin_grants DROP COLUMN IF EXISTS ended_by_user_id;
RESET search_path;
