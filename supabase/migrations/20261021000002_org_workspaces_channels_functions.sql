-- CommonSwarm Organizations > Workspaces > Channels (Phase 0 Predicates, Guards, Workspace Move & Permissions)
SET search_path = swarm, pg_catalog, public;

CREATE FUNCTION swarm.private_channels_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('cswarm.private_channels_enabled', true), ''), 'false') = 'true';
$$;

CREATE FUNCTION swarm.live_org_role(p_org uuid, p_kind text, p_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT role FROM org_memberships WHERE (org_id, principal_kind, principal_id) = (p_org, p_kind, p_id) AND revoked_at IS NULL;
$$;

CREATE FUNCTION swarm.has_live_ws_grant(p_ws uuid, p_kind text, p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (p_ws, p_kind, p_id) AND revoked_at IS NULL);
$$;

CREATE FUNCTION swarm.guard_channel_visibility_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = swarm, pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'channels' THEN
    IF NEW.visibility = 'private' THEN
      IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
      IF NEW.join_policy = 'open' THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN'; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.visibility <> NEW.visibility THEN
      IF OLD.visibility = 'private' THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC'; END IF;
      IF EXISTS (SELECT 1 FROM signals WHERE channel_id = OLD.channel_id) OR EXISTS (SELECT 1 FROM file_channel_bindings WHERE channel_id = OLD.channel_id) THEN
        RAISE EXCEPTION 'CHANNEL_HAS_PUBLIC_HISTORY';
      END IF;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.channel_id AND visibility = 'private') THEN
    IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.channel_id, NEW.principal_kind, NEW.principal_id) IS DISTINCT FROM (OLD.channel_id, OLD.principal_kind, OLD.principal_id) THEN
      RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED';
    END IF;
    IF NEW.revoked_at IS NULL THEN
      IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM channel_memberships WHERE channel_id = NEW.channel_id AND id IS DISTINCT FROM NEW.id) THEN
        IF NEW.role <> 'owner' OR (NEW.principal_kind, NEW.principal_id) IS DISTINCT FROM (NEW.added_by_kind, NEW.added_by)
           OR NOT EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = NEW.channel_id AND (c.created_by_principal IS NULL OR (c.created_by_kind, c.created_by_principal) = (NEW.principal_kind, NEW.principal_id))) THEN
          RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED';
        END IF;
      ELSIF NOT can_read_channel(NEW.channel_id, NEW.added_by_kind, NEW.added_by) OR NOT EXISTS (
        SELECT 1 FROM channel_memberships cm
        WHERE (cm.channel_id, cm.principal_kind, cm.principal_id, cm.role) = (NEW.channel_id, NEW.added_by_kind, NEW.added_by, 'owner')
          AND cm.revoked_at IS NULL
          AND (TG_OP = 'INSERT' OR cm.id <> OLD.id OR (OLD.role = 'owner' AND OLD.revoked_at IS NULL))
      ) THEN
        RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channels_visibility_transition_guard BEFORE INSERT OR UPDATE ON swarm.channels FOR EACH ROW EXECUTE FUNCTION swarm.guard_channel_visibility_transition();
CREATE TRIGGER channel_memberships_write_guard BEFORE INSERT OR UPDATE ON swarm.channel_memberships FOR EACH ROW EXECUTE FUNCTION swarm.guard_channel_visibility_transition();

CREATE FUNCTION swarm.can_read_org(p_org uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM organizations WHERE id = p_org AND archived_at IS NULL) AND (
    (p_kind = 'user' AND live_org_role(p_org, 'user', p_id) IS NOT NULL)
    OR (p_kind = 'agent' AND EXISTS (
      SELECT 1 FROM agent_identities ai WHERE ai.id = p_id AND ai.revoked_at IS NULL
      AND (ai.standing_grant_id IS NULL OR EXISTS (SELECT 1 FROM hosted_mcp_grants g WHERE g.grant_id = ai.standing_grant_id AND g.state = 'active' AND g.revoked_at IS NULL))
      AND (ai.standing_renewal_grant_id IS NULL OR EXISTS (SELECT 1 FROM renewal_grants rg WHERE rg.renewal_grant_id = ai.standing_renewal_grant_id AND rg.revoked_at IS NULL AND (rg.horizon_expires_at IS NULL OR rg.horizon_expires_at > now())))
      AND NOT EXISTS (
        SELECT 1 FROM org_memberships om
        LEFT JOIN agent_identities sib ON sib.id = om.principal_id
        WHERE om.org_id = p_org AND om.principal_kind = 'agent' AND om.revoked_at IS NOT NULL
          AND (om.principal_id = p_id OR (live_org_role(p_org, 'agent', p_id) IS NULL AND sib.owner_user_id = ai.owner_user_id AND lower(sib.display_name) = lower(ai.display_name)))
      )
      AND NOT EXISTS (SELECT 1 FROM connection_org_policies WHERE connection_id = p_conn AND (revoked_at IS NOT NULL OR NOT (p_org = ANY(coalesce(allowed_org_ids, ARRAY[p_org])))))
      AND live_org_role(p_org, 'user', coalesce(p_owner, ai.owner_user_id)) IS NOT NULL
      AND coalesce(live_org_role(p_org, 'agent', p_id), nullif(live_org_role(p_org, 'user', coalesce(p_owner, ai.owner_user_id)), 'guest')) IS NOT NULL
    ))
  );
$$;

CREATE FUNCTION swarm.can_read_workspace(p_ws uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.workspace_id = p_ws AND w.archived_at IS NULL
    AND can_read_org(w.org_id, p_kind, p_id, p_owner, p_conn)
    AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (p_ws, p_kind, p_id) AND revoked_at IS NOT NULL)
    AND ((p_kind = 'user' AND (has_live_ws_grant(p_ws, 'user', p_id)
      OR (live_org_role(w.org_id, 'user', p_id) IS DISTINCT FROM 'guest' AND EXISTS (SELECT 1 FROM memberships WHERE (workspace_id, user_id) = (p_ws, p_id) AND revoked_at IS NULL))))
      OR (p_kind = 'agent' AND EXISTS (
        SELECT 1 FROM agent_identities ai WHERE ai.id = p_id
        AND can_read_workspace(p_ws, 'user', coalesce(p_owner, ai.owner_user_id))
        AND NOT EXISTS (
          SELECT 1 FROM agent_principals ap
          LEFT JOIN agent_identities sib ON sib.id = ap.agent_identity_id
          WHERE ap.workspace_id = p_ws AND ap.revoked_at IS NOT NULL
            AND (ap.agent_identity_id = p_id OR (NOT has_live_ws_grant(p_ws, 'agent', p_id) AND sib.owner_user_id = ai.owner_user_id AND lower(sib.display_name) = lower(ai.display_name)))
        )
        AND NOT EXISTS (
          SELECT 1 FROM workspace_principal_grants wg
          JOIN agent_identities sib ON sib.id = wg.principal_id
          WHERE wg.workspace_id = p_ws AND wg.principal_kind = 'agent' AND wg.revoked_at IS NOT NULL
            AND NOT has_live_ws_grant(p_ws, 'agent', p_id) AND sib.owner_user_id = ai.owner_user_id AND lower(sib.display_name) = lower(ai.display_name)
        )
        AND (has_live_ws_grant(p_ws, 'agent', p_id) OR (live_org_role(w.org_id, 'user', coalesce(p_owner, ai.owner_user_id)) IS DISTINCT FROM 'guest' AND coalesce(live_org_role(w.org_id, 'agent', p_id), live_org_role(w.org_id, 'user', coalesce(p_owner, ai.owner_user_id))) <> 'guest'))
      )))
  );
$$;

CREATE FUNCTION swarm.can_read_channel(p_ch uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM channels c JOIN workspaces w ON w.workspace_id = c.workspace_id
    WHERE c.channel_id = p_ch AND c.archived_at IS NULL
    AND can_read_workspace(c.workspace_id, p_kind, p_id, p_owner, p_conn)
    AND (
      (c.visibility = 'workspace'
        AND (
          (live_org_role(w.org_id, p_kind, p_id) IS DISTINCT FROM 'guest'
           AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants wg WHERE (wg.workspace_id, wg.principal_kind, wg.principal_id) = (c.workspace_id, p_kind, p_id) AND wg.revoked_at IS NULL AND wg.role = 'guest'))
          OR EXISTS (SELECT 1 FROM channel_memberships cm WHERE (cm.channel_id, cm.principal_kind, cm.principal_id) = (p_ch, p_kind, p_id) AND cm.revoked_at IS NULL)
        )
        AND (
          p_kind = 'user' OR EXISTS (
            SELECT 1 FROM agent_identities ai WHERE ai.id = p_id AND ai.revoked_at IS NULL
            AND (
              (live_org_role(w.org_id, 'user', coalesce(p_owner, ai.owner_user_id)) IS DISTINCT FROM 'guest'
               AND NOT EXISTS (SELECT 1 FROM workspace_principal_grants wg WHERE (wg.workspace_id, wg.principal_kind, wg.principal_id) = (c.workspace_id, 'user', coalesce(p_owner, ai.owner_user_id)) AND wg.revoked_at IS NULL AND wg.role = 'guest'))
              OR (
                EXISTS (SELECT 1 FROM channel_memberships cm WHERE (cm.channel_id, cm.principal_kind, cm.principal_id) = (p_ch, 'user', coalesce(p_owner, ai.owner_user_id)) AND cm.revoked_at IS NULL)
                AND EXISTS (SELECT 1 FROM channel_memberships cm WHERE (cm.channel_id, cm.principal_kind, cm.principal_id) = (p_ch, 'agent', p_id) AND cm.revoked_at IS NULL)
              )
            )
          )
        )
      )
      OR (
        c.visibility = 'private' AND private_channels_enabled()
        AND EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, p_kind, p_id) AND revoked_at IS NULL)
        AND (p_kind = 'user' OR EXISTS (
          SELECT 1 FROM agent_identities ai JOIN channel_memberships cm ON (cm.channel_id, cm.principal_kind, cm.principal_id) = (p_ch, 'user', coalesce(p_owner, ai.owner_user_id))
          WHERE ai.id = p_id AND ai.revoked_at IS NULL AND cm.revoked_at IS NULL
        ))
      )
    )
  );
$$;

CREATE FUNCTION swarm.can_read_channel_bound_file(p_file uuid, p_ws uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT can_read_workspace(p_ws, p_kind, p_id, p_owner, p_conn)
  AND NOT EXISTS (
    SELECT 1 FROM file_channel_bindings fb
    WHERE fb.file_id = p_file AND fb.workspace_id = p_ws
    AND NOT can_read_channel(fb.channel_id, p_kind, p_id, p_owner, p_conn)
  );
$$;

CREATE FUNCTION swarm.org_move_workspace(p_ws uuid, p_dst uuid, p_actor uuid, p_mode text DEFAULT 'owners_only')
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
  IF p_mode = 'all' THEN
    INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    SELECT p_ws, p_dst, 'agent', ap.agent_identity_id, 'member', p_actor, v_now, NULL
    FROM agent_principals ap WHERE ap.workspace_id = p_ws AND ap.revoked_at IS NULL
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO NOTHING;
    INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    SELECT p_ws, p_dst, cm.principal_kind, cm.principal_id, 'member', p_actor, v_now, NULL
    FROM channel_memberships cm WHERE cm.workspace_id = p_ws AND cm.revoked_at IS NULL
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO NOTHING;
    UPDATE workspace_principal_grants wg SET revoked_at = v_now
    WHERE wg.workspace_id = p_ws AND wg.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM org_memberships om WHERE (om.org_id, om.principal_kind, om.principal_id) = (p_dst, wg.principal_kind, wg.principal_id) AND om.revoked_at IS NOT NULL);
    INSERT INTO org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at)
    SELECT p_dst, principal_kind, principal_id, (CASE WHEN role = 'owner' THEN 'admin' ELSE role END), p_actor, v_now
    FROM workspace_principal_grants WHERE workspace_id = p_ws AND revoked_at IS NULL ON CONFLICT (org_id, principal_kind, principal_id) DO NOTHING;
  ELSE
    UPDATE workspace_principal_grants SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND live_org_role(p_dst, principal_kind, principal_id) IS DISTINCT FROM 'owner';
    INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    SELECT p_ws, p_dst, 'agent', ai.id, 'member', p_actor, v_now, v_now
    FROM agent_identities ai WHERE ai.revoked_at IS NULL AND live_org_role(p_dst, 'agent', ai.id) IS DISTINCT FROM 'owner'
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, revoked_at = coalesce(workspace_principal_grants.revoked_at, EXCLUDED.revoked_at);
    INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    SELECT p_ws, p_dst, om.principal_kind, om.principal_id, om.role, p_actor, v_now, v_now
    FROM org_memberships om WHERE om.org_id = p_dst AND om.revoked_at IS NULL AND om.role <> 'owner'
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, revoked_at = coalesce(workspace_principal_grants.revoked_at, EXCLUDED.revoked_at);
  END IF;
  UPDATE memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, 'user', user_id);
  UPDATE channel_memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, principal_kind, principal_id);
  UPDATE agent_principals SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, 'agent', agent_identity_id);
  UPDATE hosted_mcp_seats s SET revoked_at = v_now FROM agent_principals a WHERE (s.workspace_id, s.principal_id) = (p_ws, a.principal_id) AND s.revoked_at IS NULL AND a.revoked_at IS NOT NULL;
  UPDATE hosted_mcp_seat_handles h SET revoked_at = v_now FROM hosted_mcp_seats s WHERE (h.seat_id, s.workspace_id) = (s.seat_id, p_ws) AND h.revoked_at IS NULL AND s.revoked_at IS NOT NULL;
  RETURN jsonb_build_object('workspace_id', p_ws, 'source_org_id', v_src, 'target_org_id', p_dst, 'transfer_members', p_mode);
END
$$;

ALTER FUNCTION swarm.private_channels_enabled() OWNER TO swarm_admin;
ALTER FUNCTION swarm.live_org_role(uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.has_live_ws_grant(uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.guard_channel_visibility_transition() OWNER TO swarm_admin;
ALTER FUNCTION swarm.can_read_org(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.can_read_workspace(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.can_read_channel(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.can_read_channel_bound_file(uuid, uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.org_move_workspace(uuid, uuid, uuid, text) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION
  swarm.private_channels_enabled(),
  swarm.live_org_role(uuid, text, uuid),
  swarm.has_live_ws_grant(uuid, text, uuid),
  swarm.guard_channel_visibility_transition(),
  swarm.can_read_org(uuid, text, uuid, uuid, uuid),
  swarm.can_read_workspace(uuid, text, uuid, uuid, uuid),
  swarm.can_read_channel(uuid, text, uuid, uuid, uuid),
  swarm.can_read_channel_bound_file(uuid, uuid, text, uuid, uuid, uuid),
  swarm.org_move_workspace(uuid, uuid, uuid, text)
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION
  swarm.private_channels_enabled(),
  swarm.live_org_role(uuid, text, uuid),
  swarm.has_live_ws_grant(uuid, text, uuid),
  swarm.can_read_org(uuid, text, uuid, uuid, uuid),
  swarm.can_read_workspace(uuid, text, uuid, uuid, uuid),
  swarm.can_read_channel(uuid, text, uuid, uuid, uuid),
  swarm.can_read_channel_bound_file(uuid, uuid, text, uuid, uuid, uuid)
TO swarm_command, swarm_read;

GRANT EXECUTE ON FUNCTION
  swarm.guard_channel_visibility_transition(),
  swarm.org_move_workspace(uuid, uuid, uuid, text)
TO swarm_command;

RESET search_path;
