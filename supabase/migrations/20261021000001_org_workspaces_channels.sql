-- CommonSwarm Organizations > Workspaces > Channels (Phase 0 Shared Schema & Predicates)
-- Canonical Lock Order: organizations -> workspaces -> channels -> org_memberships -> workspace_principal_grants -> channel_memberships -> agent_principals -> seats
SET search_path = swarm, pg_catalog, public;
CREATE TABLE swarm.agent_identities (
id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(user_id), standing_grant_id uuid UNIQUE REFERENCES hosted_mcp_grants(grant_id),
standing_renewal_grant_id uuid UNIQUE REFERENCES renewal_grants(renewal_grant_id), display_name text NOT NULL CHECK (btrim(display_name) <> ''),
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE swarm.organizations (
id uuid PRIMARY KEY, slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND char_length(slug) BETWEEN 1 AND 48),
display_name text NOT NULL CHECK (btrim(display_name) <> ''), logo_object_key text, logo_updated_at timestamptz,
created_by uuid NOT NULL REFERENCES users(user_id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_lower_key ON swarm.organizations(lower(slug));
CREATE TABLE swarm.org_memberships (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL,
role text NOT NULL CHECK (role IN ('owner','admin','member','guest')), invited_by uuid REFERENCES users(user_id),
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, UNIQUE (org_id, principal_kind, principal_id)
);
CREATE INDEX org_memberships_live_idx ON swarm.org_memberships(principal_kind, principal_id, org_id) WHERE revoked_at IS NULL;
CREATE TABLE swarm.org_invites (
invite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
email text, role text NOT NULL CHECK (role IN ('owner','admin','member','guest')), workspace_ids uuid[] NOT NULL DEFAULT '{}',
token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32), invited_by uuid NOT NULL REFERENCES users(user_id),
expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz, consumed_by uuid REFERENCES users(user_id), revoked_at timestamptz
);
CREATE TABLE swarm.workspace_principal_grants (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id), org_id uuid NOT NULL REFERENCES organizations(id),
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL,
role text NOT NULL CHECK (role IN ('owner','admin','member','guest')), granted_by uuid REFERENCES users(user_id),
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, UNIQUE (workspace_id, principal_kind, principal_id)
);
CREATE INDEX workspace_grants_live_idx ON swarm.workspace_principal_grants(principal_kind, principal_id, workspace_id) WHERE revoked_at IS NULL;
CREATE TABLE swarm.connection_org_policies (
connection_id uuid PRIMARY KEY, owner_user_id uuid REFERENCES users(user_id), agent_identity_id uuid REFERENCES agent_identities(id),
default_org_id uuid REFERENCES organizations(id), default_workspace_id uuid REFERENCES workspaces(workspace_id), allowed_org_ids uuid[],
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE swarm.channel_memberships (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL, workspace_id uuid NOT NULL,
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL, role text NOT NULL CHECK (role IN ('owner','member')),
notify_pref text NOT NULL DEFAULT 'all' CHECK (notify_pref IN ('all','mentions','mute')), added_by uuid, joined_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
UNIQUE (channel_id, principal_kind, principal_id), FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);
CREATE INDEX channel_memberships_live_idx ON swarm.channel_memberships(channel_id, principal_kind, principal_id) WHERE revoked_at IS NULL;
CREATE TABLE swarm.file_channel_bindings (
file_id uuid NOT NULL, workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
bound_by_kind text NOT NULL DEFAULT 'user' CHECK (bound_by_kind IN ('user','agent')), bound_by uuid,
created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (file_id, channel_id),
FOREIGN KEY (file_id, workspace_id) REFERENCES files(file_id, workspace_id), FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);
CREATE TABLE swarm.org_approval_requests (
approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
workspace_id uuid REFERENCES workspaces(workspace_id), channel_id uuid REFERENCES channels(channel_id),
requested_by_agent_identity_id uuid NOT NULL REFERENCES agent_identities(id), owner_user_id uuid NOT NULL REFERENCES users(user_id),
action_kind text NOT NULL CHECK (btrim(action_kind) <> ''), target_scope jsonb NOT NULL DEFAULT '{}', payload jsonb NOT NULL DEFAULT '{}',
state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
decided_by uuid REFERENCES users(user_id), decided_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE swarm.workspaces ADD COLUMN org_id uuid REFERENCES organizations(id), ADD COLUMN slug text;
ALTER TABLE swarm.agent_principals ADD COLUMN agent_identity_id uuid REFERENCES agent_identities(id);
ALTER TABLE swarm.channels
ADD COLUMN visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace','private')),
ADD COLUMN join_policy text NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','invite_only')),
ADD COLUMN topic text CHECK (topic IS NULL OR char_length(topic) <= 500),
ADD COLUMN IF NOT EXISTS archived_at timestamptz,
ADD CONSTRAINT channels_private_join_policy_check CHECK (NOT (visibility = 'private' AND join_policy = 'open'));
DO $$
DECLARE t text;
BEGIN
INSERT INTO organizations SELECT workspace_id, left(coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'org'), 39) || '-' || left(workspace_id::text, 8), name, NULL, NULL, created_by, created_at, created_at, archived_at FROM workspaces ON CONFLICT DO NOTHING;
UPDATE workspaces w SET org_id = o.id, slug = o.slug FROM organizations o WHERE o.id = w.workspace_id;
INSERT INTO agent_identities SELECT DISTINCT ON (1) coalesce(hs.grant_id, ap.principal_id), ap.owner_user_id, hs.grant_id, NULL, ap.name, ap.created_at, ap.revoked_at FROM agent_principals ap LEFT JOIN hosted_mcp_seats hs USING (principal_id) ORDER BY 1, ap.created_at ASC ON CONFLICT DO NOTHING;
UPDATE agent_principals ap SET agent_identity_id = coalesce((SELECT hs.grant_id FROM hosted_mcp_seats hs WHERE hs.principal_id = ap.principal_id LIMIT 1), ap.principal_id);
INSERT INTO workspace_principal_grants SELECT gen_random_uuid(), workspace_id, workspace_id, 'user', user_id, role, invited_by, joined_at, revoked_at FROM memberships
UNION ALL
SELECT DISTINCT ON (workspace_id, agent_identity_id) gen_random_uuid(), workspace_id, workspace_id, 'agent', agent_identity_id, 'member', owner_user_id, created_at, revoked_at FROM agent_principals ORDER BY 2, 5, 9 NULLS FIRST, 8 ASC ON CONFLICT DO NOTHING;
INSERT INTO org_memberships SELECT gen_random_uuid(), org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at FROM workspace_principal_grants ON CONFLICT DO NOTHING;
INSERT INTO channels (channel_id, workspace_id, slug, purpose, visibility, join_policy, created_by_principal, created_by_kind, created_at)
SELECT gen_random_uuid(), w.workspace_id, 'general', 'General coordination', 'workspace', 'open', w.created_by, 'user', w.created_at FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.workspace_id = w.workspace_id AND lower(c.slug) = 'general');
FOREACH t IN ARRAY ARRAY['agent_identities','organizations','org_memberships','org_invites','workspace_principal_grants','connection_org_policies','channel_memberships','file_channel_bindings','org_approval_requests'] LOOP
EXECUTE format('ALTER TABLE %1$I OWNER TO swarm_admin; ALTER TABLE %1$I ENABLE ROW LEVEL SECURITY; CREATE POLICY swarm_command_all ON %1$I FOR ALL TO swarm_command USING (true) WITH CHECK (true); REVOKE ALL ON %1$I FROM PUBLIC, anon, authenticated; GRANT SELECT, INSERT, UPDATE ON %1$I TO swarm_command', t);
END LOOP;
END
$$;
ALTER TABLE swarm.workspaces ALTER COLUMN org_id SET NOT NULL, ALTER COLUMN slug SET NOT NULL;
ALTER TABLE swarm.agent_principals ALTER COLUMN agent_identity_id SET NOT NULL, ADD CONSTRAINT agent_principals_workspace_identity_key UNIQUE (workspace_id, agent_identity_id);
CREATE UNIQUE INDEX workspaces_org_slug_lower_key ON swarm.workspaces(org_id, lower(slug));
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
ELSIF NEW.revoked_at IS NULL AND EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.channel_id AND visibility = 'private') THEN
IF NOT private_channels_enabled() THEN RAISE EXCEPTION 'PRIVATE_CHANNELS_DISABLED'; END IF;
IF EXISTS (SELECT 1 FROM channel_memberships WHERE channel_id = NEW.channel_id AND role = 'owner' AND revoked_at IS NULL AND id IS DISTINCT FROM NEW.id) THEN
IF NOT EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id, role) = (NEW.channel_id, 'user', NEW.added_by, 'owner') AND revoked_at IS NULL) THEN
RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED';
END IF;
ELSIF NEW.role <> 'owner' THEN RAISE EXCEPTION 'PRIVATE_CHANNEL_OWNER_REQUIRED';
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
AND NOT EXISTS (SELECT 1 FROM org_memberships WHERE (org_id, principal_kind, principal_id) = (p_org, 'agent', p_id) AND revoked_at IS NOT NULL)
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
AND NOT EXISTS (SELECT 1 FROM agent_principals WHERE (workspace_id, agent_identity_id) = (p_ws, p_id) AND revoked_at IS NOT NULL)
AND (has_live_ws_grant(p_ws, 'agent', p_id) OR coalesce(live_org_role(w.org_id, 'agent', p_id), live_org_role(w.org_id, 'user', coalesce(p_owner, ai.owner_user_id))) <> 'guest')
)))
);
$$;
CREATE FUNCTION swarm.can_read_channel(p_ch uuid, p_kind text, p_id uuid, p_owner uuid DEFAULT NULL, p_conn uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
SELECT EXISTS (
SELECT 1 FROM channels c WHERE c.channel_id = p_ch AND can_read_workspace(c.workspace_id, p_kind, p_id, p_owner, p_conn)
AND (c.visibility = 'workspace' OR (
private_channels_enabled()
AND EXISTS (SELECT 1 FROM channel_memberships WHERE (channel_id, principal_kind, principal_id) = (p_ch, p_kind, p_id) AND revoked_at IS NULL)
AND (p_kind = 'user' OR EXISTS (
SELECT 1 FROM agent_identities ai JOIN channel_memberships cm ON (cm.channel_id, cm.principal_kind, cm.principal_id) = (p_ch, 'user', coalesce(p_owner, ai.owner_user_id))
WHERE ai.id = p_id AND ai.revoked_at IS NULL AND cm.revoked_at IS NULL
))
))
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
PERFORM 1 FROM workspaces WHERE workspace_id = p_ws FOR UPDATE;
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
INSERT INTO org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at)
SELECT p_dst, principal_kind, principal_id, (CASE WHEN role = 'owner' THEN 'admin' ELSE role END), p_actor, v_now
FROM workspace_principal_grants WHERE workspace_id = p_ws AND revoked_at IS NULL ON CONFLICT DO NOTHING;
ELSE
UPDATE workspace_principal_grants SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND live_org_role(p_dst, principal_kind, principal_id) IS DISTINCT FROM 'owner';
UPDATE memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, 'user', user_id);
UPDATE channel_memberships SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, principal_kind, principal_id);
UPDATE agent_principals SET revoked_at = v_now WHERE workspace_id = p_ws AND revoked_at IS NULL AND NOT has_live_ws_grant(p_ws, 'agent', agent_identity_id);
UPDATE hosted_mcp_seats s SET revoked_at = v_now FROM agent_principals a WHERE (s.workspace_id, s.principal_id) = (p_ws, a.principal_id) AND s.revoked_at IS NULL AND a.revoked_at IS NOT NULL;
UPDATE hosted_mcp_seat_handles h SET revoked_at = v_now FROM hosted_mcp_seats s WHERE (h.seat_id, s.workspace_id) = (s.seat_id, p_ws) AND h.revoked_at IS NULL AND s.revoked_at IS NOT NULL;
END IF;
RETURN jsonb_build_object('workspace_id', p_ws, 'source_org_id', v_src, 'target_org_id', p_dst, 'transfer_members', p_mode);
END
$$;
RESET search_path;
