-- CommonSwarm Phase 0 Predicates & Guards
SET search_path = swarm, pg_catalog, public;

CREATE FUNCTION private_channels_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('cswarm.private_channels_enabled', true), ''), 'false') = 'true';
$$;

CREATE FUNCTION live_org_role(p_org uuid, p_kind text, p_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT m.role FROM org_memberships m JOIN organizations o ON o.id = m.org_id AND o.archived_at IS NULL
  WHERE (m.org_id, m.principal_kind, m.principal_id) = (p_org, p_kind, coalesce((SELECT agent_identity_id FROM agent_principals WHERE p_kind = 'agent' AND principal_id = p_id AND revoked_at IS NULL), p_id)) AND m.revoked_at IS NULL;
$$;

CREATE FUNCTION has_live_ws_grant(p_ws uuid, p_kind text, p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (p_ws, p_kind, coalesce((SELECT agent_identity_id FROM agent_principals WHERE p_kind = 'agent' AND principal_id = p_id AND revoked_at IS NULL), p_id)) AND revoked_at IS NULL);
$$;

CREATE FUNCTION guard_channel_visibility_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = swarm, pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'channels' THEN
    IF NEW.visibility = 'private' THEN
      IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
      IF NEW.join_policy = 'open' THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN'; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.visibility <> NEW.visibility THEN
      IF OLD.visibility = 'private' THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC'; END IF;
      IF NOT pg_try_advisory_xact_lock(20261021, hashtext(OLD.channel_id::text)) OR EXISTS (SELECT 1 FROM signals WHERE channel_id = OLD.channel_id) OR EXISTS (SELECT 1 FROM file_channel_bindings WHERE channel_id = OLD.channel_id) THEN RAISE EXCEPTION 'CHANNEL_HAS_PUBLIC_HISTORY'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME IN ('signals', 'file_channel_bindings') THEN
    IF TG_OP = 'UPDATE' AND OLD.channel_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock_shared(20261021, hashtext(OLD.channel_id::text));
      IF EXISTS (SELECT 1 FROM channels WHERE channel_id = OLD.channel_id AND visibility = 'private') THEN
        IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
        IF NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC'; END IF;
      END IF;
    END IF;
    IF NEW.channel_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock_shared(20261021, hashtext(NEW.channel_id::text));
      IF EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.channel_id AND visibility = 'private') AND NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.channel_id AND visibility = 'private') THEN
    IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.channel_id, NEW.principal_kind, NEW.principal_id) IS DISTINCT FROM (OLD.channel_id, OLD.principal_kind, OLD.principal_id) THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED'; END IF;
    IF NEW.revoked_at IS NULL THEN
      IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM channel_memberships WHERE channel_id = NEW.channel_id AND id IS DISTINCT FROM NEW.id) THEN
        IF NEW.role <> 'owner' OR (NEW.principal_kind, NEW.principal_id) IS DISTINCT FROM (NEW.added_by_kind, NEW.added_by) OR NOT EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = NEW.channel_id AND (c.created_by_principal IS NULL OR (c.created_by_kind, c.created_by_principal) = (NEW.principal_kind, NEW.principal_id))) THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED'; END IF;
      ELSIF NOT can_read_channel(NEW.channel_id, NEW.added_by_kind, NEW.added_by) OR NOT EXISTS (SELECT 1 FROM channel_memberships cm WHERE (cm.channel_id, cm.principal_kind, cm.principal_id, cm.role) = (NEW.channel_id, NEW.added_by_kind, NEW.added_by, 'owner') AND cm.revoked_at IS NULL AND (TG_OP = 'INSERT' OR cm.id <> OLD.id OR (OLD.role = 'owner' AND OLD.revoked_at IS NULL))) THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channels_visibility_transition_guard BEFORE INSERT OR UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION guard_channel_visibility_transition();
CREATE TRIGGER channel_memberships_write_guard BEFORE INSERT OR UPDATE ON channel_memberships FOR EACH ROW EXECUTE FUNCTION guard_channel_visibility_transition();
CREATE TRIGGER signals_private_channel_guard BEFORE INSERT OR UPDATE ON signals FOR EACH ROW EXECUTE FUNCTION guard_channel_visibility_transition();
CREATE TRIGGER file_channel_bindings_private_guard BEFORE INSERT OR UPDATE ON file_channel_bindings FOR EACH ROW EXECUTE FUNCTION guard_channel_visibility_transition();

CREATE FUNCTION can_read_org(p_org uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT (p_kind = 'user' AND live_org_role(p_org, 'user', p_id) IS NOT NULL)
    OR (p_kind = 'agent' AND EXISTS (
      SELECT 1 FROM agent_identities ai
      WHERE (ai.id = p_id OR EXISTS (SELECT 1 FROM agent_principals ap WHERE (ap.principal_id, ap.agent_identity_id) = (p_id, ai.id) AND ap.revoked_at IS NULL))
      AND ai.revoked_at IS NULL AND (p_owner IS NULL OR p_owner = ai.owner_user_id)
      AND (ai.standing_grant_id IS NULL OR EXISTS (SELECT 1 FROM hosted_mcp_grants g WHERE (g.grant_id, g.state) = (ai.standing_grant_id, 'active') AND g.revoked_at IS NULL))
      AND (ai.standing_renewal_grant_id IS NULL OR EXISTS (SELECT 1 FROM renewal_grants r WHERE r.renewal_grant_id = ai.standing_renewal_grant_id AND r.revoked_at IS NULL AND coalesce(r.horizon_expires_at > now(), true)))
      AND NOT EXISTS (SELECT 1 FROM org_memberships WHERE (org_id, principal_kind, principal_id) = (p_org, 'agent', ai.id) AND revoked_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM connection_org_policies WHERE connection_id = p_conn AND (revoked_at IS NOT NULL OR NOT (p_org = ANY(coalesce(allowed_org_ids, ARRAY[p_org])))))
      AND live_org_role(p_org, 'user', ai.owner_user_id) IS NOT NULL
      AND coalesce(live_org_role(p_org, 'agent', ai.id), nullif(live_org_role(p_org, 'user', ai.owner_user_id), 'guest')) IS NOT NULL
    ));
$$;

CREATE FUNCTION can_read_workspace(p_ws uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.workspace_id = p_ws AND w.archived_at IS NULL
    AND can_read_org(w.org_id, p_kind, p_id, p_owner, p_conn)
    AND ((p_kind = 'user' AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (p_ws, 'user', p_id) AND revoked_at IS NOT NULL)
      AND (has_live_ws_grant(p_ws, 'user', p_id)
      OR (live_org_role(w.org_id, 'user', p_id) IS DISTINCT FROM 'guest' AND EXISTS (SELECT 1 FROM memberships WHERE (workspace_id, user_id) = (p_ws, p_id) AND revoked_at IS NULL))))
      OR (p_kind = 'agent' AND EXISTS (
        SELECT 1 FROM agent_identities ai
        WHERE (ai.id = p_id OR EXISTS (SELECT 1 FROM agent_principals ap WHERE (ap.principal_id, ap.agent_identity_id) = (p_id, ai.id) AND ap.revoked_at IS NULL))
        AND can_read_workspace(p_ws, 'user', ai.owner_user_id)
        AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (p_ws, 'agent', ai.id) AND revoked_at IS NOT NULL)
        AND NOT (EXISTS (SELECT 1 FROM agent_principals WHERE (workspace_id, agent_identity_id) = (p_ws, ai.id) AND revoked_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM agent_principals WHERE (workspace_id, agent_identity_id) = (p_ws, ai.id) AND revoked_at IS NULL))
        AND (has_live_ws_grant(p_ws, 'agent', ai.id) OR (live_org_role(w.org_id, 'user', ai.owner_user_id) IS DISTINCT FROM 'guest' AND coalesce(live_org_role(w.org_id, 'agent', ai.id), live_org_role(w.org_id, 'user', ai.owner_user_id)) <> 'guest' AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id, role) = (p_ws, 'user', ai.owner_user_id, 'guest') AND revoked_at IS NULL)))
      )))
  );
$$;

CREATE FUNCTION can_read_channel(p_ch uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM channels c JOIN workspaces w ON w.workspace_id = c.workspace_id
    LEFT JOIN agent_identities ai ON p_kind = 'agent' AND ai.revoked_at IS NULL AND (p_owner IS NULL OR p_owner = ai.owner_user_id) AND (ai.id = p_id OR EXISTS (SELECT 1 FROM agent_principals ap WHERE (ap.principal_id, ap.agent_identity_id) = (p_id, ai.id) AND ap.revoked_at IS NULL))
    WHERE c.channel_id = p_ch AND (p_kind = 'user' OR ai.id IS NOT NULL)
    AND can_read_workspace(c.workspace_id, p_kind, coalesce(ai.id, p_id), p_owner, p_conn)
    AND ((c.visibility = 'workspace'
      AND ((live_org_role(w.org_id, p_kind, coalesce(ai.id, p_id)) IS DISTINCT FROM 'guest'
        AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id, role) = (c.workspace_id, p_kind, coalesce(ai.id, p_id), 'guest') AND revoked_at IS NULL))
        OR EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, p_kind, coalesce(ai.id, p_id)) AND revoked_at IS NULL))
      AND (p_kind = 'user'
        OR ((live_org_role(w.org_id, 'user', ai.owner_user_id) IS DISTINCT FROM 'guest'
          AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id, role) = (c.workspace_id, 'user', ai.owner_user_id, 'guest') AND revoked_at IS NULL))
          OR (EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, 'user', ai.owner_user_id) AND revoked_at IS NULL)
            AND EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, 'agent', ai.id) AND revoked_at IS NULL)))))
      OR (c.visibility = 'private' AND private_channels_enabled()
        AND EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, p_kind, coalesce(ai.id, p_id)) AND revoked_at IS NULL)
        AND (p_kind = 'user' OR EXISTS (
          SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, 'user', ai.owner_user_id) AND revoked_at IS NULL))))
  );
$$;

CREATE FUNCTION can_read_channel_bound_file(p_file uuid, p_ws uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT can_read_workspace(p_ws, p_kind, p_id, p_owner, p_conn)
  AND NOT EXISTS (SELECT 1 FROM file_channel_bindings fb WHERE (fb.file_id, fb.workspace_id) = (p_file, p_ws) AND NOT can_read_channel(fb.channel_id, p_kind, p_id, p_owner, p_conn));
$$;

CREATE FUNCTION org_move_workspace(p_ws uuid, p_dst uuid, p_actor uuid, p_mode text DEFAULT 'owners_only')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
DECLARE v_src uuid; v_now timestamptz := now();
BEGIN
  IF p_mode NOT IN ('all','owners_only') THEN RAISE EXCEPTION 'INVALID_TRANSFER_MEMBERS_MODE'; END IF;
  SELECT org_id INTO v_src FROM workspaces WHERE workspace_id = p_ws;
  IF v_src IS NULL THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND'; END IF;
  PERFORM 1 FROM organizations WHERE id IN (v_src, p_dst) ORDER BY id FOR UPDATE;
  SELECT org_id INTO v_src FROM workspaces WHERE workspace_id = p_ws AND org_id = v_src FOR UPDATE;
  IF v_src IS NULL THEN RAISE EXCEPTION 'CONCURRENT_WORKSPACE_MOVE'; END IF;
  PERFORM 1 FROM channels WHERE workspace_id = p_ws ORDER BY channel_id FOR UPDATE;
  PERFORM 1 FROM org_memberships WHERE org_id IN (v_src, p_dst) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM workspace_principal_grants WHERE workspace_id = p_ws ORDER BY id FOR UPDATE;
  PERFORM 1 FROM channel_memberships WHERE workspace_id = p_ws ORDER BY id FOR UPDATE;
  PERFORM 1 FROM agent_principals WHERE workspace_id = p_ws ORDER BY principal_id FOR UPDATE;
  PERFORM 1 FROM hosted_mcp_seats WHERE workspace_id = p_ws ORDER BY seat_id FOR UPDATE;
  IF live_org_role(v_src, 'user', p_actor) IS DISTINCT FROM 'owner' OR live_org_role(p_dst, 'user', p_actor) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'ORG_MOVE_REQUIRES_DUAL_OWNER';
  END IF;
  UPDATE workspaces SET org_id = p_dst WHERE workspace_id = p_ws;
  UPDATE workspace_principal_grants SET org_id = p_dst WHERE workspace_id = p_ws;
  INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at)
  SELECT p_ws, p_dst, 'agent', agent_identity_id, 'member', p_actor, v_now FROM agent_principals WHERE p_mode = 'all' AND workspace_id = p_ws AND revoked_at IS NULL
  UNION ALL
  SELECT p_ws, p_dst, principal_kind, principal_id, 'member', p_actor, v_now FROM channel_memberships WHERE p_mode = 'all' AND workspace_id = p_ws AND revoked_at IS NULL
  UNION ALL
  SELECT p_ws, p_dst, 'user', user_id, 'admin', p_actor, v_now FROM memberships WHERE p_mode = 'owners_only' AND workspace_id = p_ws AND revoked_at IS NULL AND 'owner' IN (live_org_role(v_src, 'user', user_id), live_org_role(p_dst, 'user', user_id))
  ON CONFLICT (workspace_id, principal_kind, principal_id) DO NOTHING;
  UPDATE workspace_principal_grants wg SET revoked_at = v_now
  WHERE wg.workspace_id = p_ws AND wg.revoked_at IS NULL
    AND (EXISTS (SELECT 1 FROM org_memberships om WHERE (om.org_id, om.principal_kind, om.principal_id) = (p_dst, wg.principal_kind, wg.principal_id) AND om.revoked_at IS NOT NULL)
      OR (p_mode = 'owners_only' AND wg.role <> 'owner' AND 'owner' NOT IN (coalesce(live_org_role(v_src, wg.principal_kind, wg.principal_id), ''), coalesce(live_org_role(p_dst, wg.principal_kind, wg.principal_id), ''))));
  INSERT INTO org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at)
  SELECT p_dst, principal_kind, principal_id, (CASE WHEN role = 'owner' THEN 'admin' ELSE role END), p_actor, v_now
  FROM workspace_principal_grants WHERE workspace_id = p_ws AND revoked_at IS NULL ON CONFLICT (org_id, principal_kind, principal_id) DO NOTHING;
  IF p_mode = 'owners_only' THEN
    INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    SELECT p_ws, p_dst, 'agent', id, 'member', p_actor, v_now, v_now FROM agent_identities WHERE revoked_at IS NULL AND live_org_role(p_dst, 'agent', id) IS DISTINCT FROM 'owner'
    UNION ALL
    SELECT p_ws, p_dst, principal_kind, principal_id, role, p_actor, v_now, v_now FROM org_memberships WHERE org_id = p_dst AND revoked_at IS NULL AND role <> 'owner'
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO NOTHING;
  END IF;
  UPDATE memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, 'user', user_id);
  UPDATE workspace_principal_grants wg SET revoked_at = v_now FROM agent_identities ai
  WHERE (wg.workspace_id, wg.principal_kind, wg.principal_id) = (p_ws, 'agent', ai.id) AND wg.revoked_at IS NULL
    AND (NOT has_live_ws_grant(p_ws, 'user', ai.owner_user_id) OR NOT can_read_workspace(p_ws, 'agent', ai.id));
  UPDATE channel_memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT can_read_workspace(p_ws, principal_kind, principal_id);
  UPDATE agent_principals SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT can_read_workspace(p_ws, 'agent', agent_identity_id);
  UPDATE hosted_mcp_seats s SET revoked_at = v_now FROM agent_principals a WHERE (s.workspace_id, s.principal_id) = (p_ws, a.principal_id) AND s.revoked_at IS NULL AND a.revoked_at IS NOT NULL;
  UPDATE hosted_mcp_seat_handles h SET revoked_at = v_now FROM hosted_mcp_seats s WHERE (h.seat_id, s.workspace_id) = (s.seat_id, p_ws) AND h.revoked_at IS NULL AND s.revoked_at IS NOT NULL;
  RETURN jsonb_build_object('workspace_id', p_ws, 'source_org_id', v_src, 'target_org_id', p_dst, 'transfer_members', p_mode);
END
$$;
ALTER FUNCTION private_channels_enabled OWNER TO swarm_admin;
ALTER FUNCTION live_org_role OWNER TO swarm_admin;
ALTER FUNCTION has_live_ws_grant OWNER TO swarm_admin;
ALTER FUNCTION guard_channel_visibility_transition OWNER TO swarm_admin;
ALTER FUNCTION can_read_org OWNER TO swarm_admin;
ALTER FUNCTION can_read_workspace OWNER TO swarm_admin;
ALTER FUNCTION can_read_channel OWNER TO swarm_admin;
ALTER FUNCTION can_read_channel_bound_file OWNER TO swarm_admin;
ALTER FUNCTION org_move_workspace OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION private_channels_enabled, live_org_role, has_live_ws_grant, guard_channel_visibility_transition, can_read_org, can_read_workspace, can_read_channel, can_read_channel_bound_file, org_move_workspace FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION private_channels_enabled, live_org_role, has_live_ws_grant, can_read_org, can_read_workspace, can_read_channel, can_read_channel_bound_file TO swarm_command, swarm_read;
GRANT EXECUTE ON FUNCTION guard_channel_visibility_transition, org_move_workspace TO swarm_command;
RESET search_path;
