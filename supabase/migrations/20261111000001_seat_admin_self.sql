-- Seat admin PR 4: an agent reads its own admin access (replaces the routine engine's admin_read_metadata for seat
-- grants). Only the presenting credential's own active, unexpired grants: nothing about the grantor's other agents,
-- no history, nothing about other people. The credential is authenticated for the workspace the read already admitted,
-- never with a NULL workspace: that would enlist every sibling workspace's locks after the read holds the principal,
-- family and token locks (workspace-before-principal order). Reading this principal's own grant rows needs no
-- workspace lock, so grants for other workspaces are still returned.
CREATE FUNCTION swarm.agent_seat_admin_self(p_hash bytea, p_workspace uuid) RETURNS jsonb
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
ALTER FUNCTION swarm.agent_seat_admin_self(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_seat_admin_self(bytea, uuid) FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.agent_seat_admin_self(bytea, uuid) TO swarm_read;
