SET search_path = swarm, pg_catalog, public;
CREATE TABLE agent_identities (
id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(user_id),
standing_grant_id uuid REFERENCES hosted_mcp_grants(grant_id),
standing_renewal_grant_id uuid UNIQUE REFERENCES renewal_grants(renewal_grant_id),
display_name text NOT NULL CHECK (btrim(display_name) <> ''),
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE organizations (
id uuid PRIMARY KEY,
slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND char_length(slug) BETWEEN 1 AND 48),
display_name text NOT NULL CHECK (btrim(display_name) <> ''), logo_object_key text, logo_updated_at timestamptz,
created_by uuid NOT NULL REFERENCES users(user_id),
created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_lower_key ON organizations(lower(slug));
CREATE TABLE org_memberships (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL,
role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
invited_by uuid REFERENCES users(user_id), created_at timestamptz NOT NULL DEFAULT now(),
revoked_at timestamptz, UNIQUE (org_id, principal_kind, principal_id)
);
CREATE INDEX org_memberships_live_idx ON org_memberships(principal_kind, principal_id, org_id) WHERE revoked_at IS NULL;
CREATE TABLE org_invites (
invite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
email text, role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
workspace_ids uuid[] NOT NULL DEFAULT '{}', token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
invited_by uuid NOT NULL REFERENCES users(user_id), expires_at timestamptz NOT NULL,
created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz,
consumed_by uuid REFERENCES users(user_id), revoked_at timestamptz
);
CREATE TABLE workspace_principal_grants (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
org_id uuid NOT NULL REFERENCES organizations(id),
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL,
role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
granted_by uuid REFERENCES users(user_id), created_at timestamptz NOT NULL DEFAULT now(),
revoked_at timestamptz, UNIQUE (workspace_id, principal_kind, principal_id)
);
CREATE INDEX workspace_grants_live_idx ON workspace_principal_grants(principal_kind, principal_id, workspace_id) WHERE revoked_at IS NULL;
CREATE TABLE connection_org_policies (
connection_id uuid PRIMARY KEY, owner_user_id uuid REFERENCES users(user_id),
agent_identity_id uuid REFERENCES agent_identities(id), default_org_id uuid REFERENCES organizations(id),
default_workspace_id uuid REFERENCES workspaces(workspace_id), allowed_org_ids uuid[],
created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE channel_memberships (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL, workspace_id uuid NOT NULL,
principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')), principal_id uuid NOT NULL,
role text NOT NULL CHECK (role IN ('owner','member')),
notify_pref text NOT NULL DEFAULT 'all' CHECK (notify_pref IN ('all','mentions','mute')),
added_by_kind text NOT NULL DEFAULT 'user' CHECK (added_by_kind IN ('user','agent')), added_by uuid,
joined_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
UNIQUE (channel_id, principal_kind, principal_id),
FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);
CREATE INDEX channel_memberships_live_idx ON channel_memberships(channel_id, principal_kind, principal_id) WHERE revoked_at IS NULL;
CREATE TABLE file_channel_bindings (
file_id uuid NOT NULL, workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
bound_by_kind text NOT NULL DEFAULT 'user' CHECK (bound_by_kind IN ('user','agent')), bound_by uuid,
created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (file_id, channel_id),
FOREIGN KEY (file_id, workspace_id) REFERENCES files(file_id, workspace_id),
FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);
CREATE TABLE org_approval_requests (
approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
workspace_id uuid REFERENCES workspaces(workspace_id), channel_id uuid REFERENCES channels(channel_id),
requested_by_agent_identity_id uuid NOT NULL REFERENCES agent_identities(id),
owner_user_id uuid NOT NULL REFERENCES users(user_id), action_kind text NOT NULL CHECK (btrim(action_kind) <> ''),
target_scope jsonb NOT NULL DEFAULT '{}', payload jsonb NOT NULL DEFAULT '{}',
state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
decided_by uuid REFERENCES users(user_id), decided_at timestamptz, expires_at timestamptz,
created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspaces ADD COLUMN org_id uuid REFERENCES organizations(id), ADD COLUMN slug text;
ALTER TABLE agent_principals ADD COLUMN agent_identity_id uuid REFERENCES agent_identities(id);
ALTER TABLE channels
ADD COLUMN visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace','private')),
ADD COLUMN join_policy text NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','invite_only')),
ADD COLUMN topic text CHECK (topic IS NULL OR char_length(topic) <= 500),
ADD COLUMN IF NOT EXISTS archived_at timestamptz,
ADD CONSTRAINT channels_private_join_policy_check CHECK (NOT (visibility = 'private' AND join_policy = 'open'));
DO $$
DECLARE t text;
BEGIN
INSERT INTO organizations
SELECT workspace_id, left(coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'org'), 39) || '-' || left(workspace_id::text, 8), name, NULL, NULL, created_by, created_at, created_at, archived_at
FROM workspaces ON CONFLICT DO NOTHING;
UPDATE workspaces w SET org_id = o.id, slug = o.slug FROM organizations o WHERE o.id = w.workspace_id;
WITH rp AS (
SELECT ap.*, g.grant_id, CASE WHEN g.grant_id IS NULL THEN 0 ELSE row_number() OVER (PARTITION BY ap.workspace_id, g.grant_id, ap.name ORDER BY ap.revoked_at NULLS FIRST, ap.created_at, ap.principal_id) END AS rn
FROM agent_principals ap LEFT JOIN LATERAL (SELECT grant_id FROM hosted_mcp_seats WHERE principal_id = ap.principal_id ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 1) g ON true
), ins AS (
INSERT INTO agent_identities
SELECT DISTINCT ON (CASE WHEN rn = 1 THEN grant_id::text || ':' || name ELSE principal_id::text END)
principal_id, owner_user_id, CASE WHEN rn = 1 THEN grant_id END,
(SELECT renewal_grant_id FROM renewal_grants WHERE principal_id = rp.principal_id ORDER BY revoked_at NULLS FIRST, horizon_expires_at DESC LIMIT 1),
name, created_at, revoked_at
FROM rp ORDER BY (CASE WHEN rn = 1 THEN grant_id::text || ':' || name ELSE principal_id::text END), revoked_at NULLS FIRST, created_at ON CONFLICT DO NOTHING
RETURNING id, standing_grant_id, display_name
)
UPDATE agent_principals ap SET agent_identity_id = coalesce((SELECT id FROM ins WHERE rp.rn = 1 AND (standing_grant_id, display_name) = (rp.grant_id, rp.name) LIMIT 1), (SELECT id FROM agent_identities WHERE rp.rn = 1 AND (standing_grant_id, display_name) = (rp.grant_id, rp.name) LIMIT 1), ap.principal_id) FROM rp WHERE rp.principal_id = ap.principal_id;
INSERT INTO workspace_principal_grants
SELECT gen_random_uuid(), workspace_id, workspace_id, 'user', user_id, role, invited_by, joined_at, revoked_at FROM memberships
UNION ALL
SELECT DISTINCT ON (workspace_id, agent_identity_id) gen_random_uuid(), workspace_id, workspace_id, 'agent', agent_identity_id, 'member', owner_user_id, created_at, revoked_at
FROM agent_principals ORDER BY 2, 5, 9 NULLS FIRST, 8 ASC ON CONFLICT DO NOTHING;
INSERT INTO org_memberships
SELECT gen_random_uuid(), org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at
FROM workspace_principal_grants ON CONFLICT DO NOTHING;
INSERT INTO channels (channel_id, workspace_id, slug, purpose, visibility, join_policy, created_by_principal, created_by_kind, created_at)
SELECT gen_random_uuid(), w.workspace_id, 'general', 'General coordination', 'workspace', 'open', w.created_by, 'user', w.created_at
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.workspace_id = w.workspace_id AND lower(c.slug) = 'general');
FOREACH t IN ARRAY ARRAY['agent_identities','organizations','org_memberships','org_invites','workspace_principal_grants','connection_org_policies','channel_memberships','file_channel_bindings','org_approval_requests'] LOOP
EXECUTE format('ALTER TABLE %1$I OWNER TO swarm_admin; ALTER TABLE %1$I ENABLE ROW LEVEL SECURITY; CREATE POLICY swarm_command_all ON %1$I FOR ALL TO swarm_command USING (true) WITH CHECK (true); REVOKE ALL ON %1$I FROM PUBLIC, anon, authenticated; GRANT SELECT, INSERT, UPDATE ON %1$I TO swarm_command', t);
END LOOP;
END $$;
ALTER TABLE workspaces ALTER COLUMN org_id SET NOT NULL, ALTER COLUMN slug SET NOT NULL;
ALTER TABLE agent_principals ALTER COLUMN agent_identity_id SET NOT NULL;
CREATE UNIQUE INDEX agent_principals_workspace_identity_key ON agent_principals(workspace_id, agent_identity_id);
CREATE UNIQUE INDEX workspaces_org_slug_lower_key ON workspaces(org_id, lower(slug));
CREATE FUNCTION ensure_workspace_org_and_slug() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
BEGIN
IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
NEW.slug := left(coalesce(nullif(trim(both '-' from regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g')), ''), 'org'), 39) || '-' || left(NEW.workspace_id::text, 8);
END IF;
IF NEW.org_id IS NULL THEN
INSERT INTO organizations VALUES (NEW.workspace_id, NEW.slug, NEW.name, NULL, NULL, NEW.created_by, coalesce(NEW.created_at, now()), coalesce(NEW.created_at, now()), NEW.archived_at) ON CONFLICT (id) DO NOTHING;
NEW.org_id := NEW.workspace_id;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER workspaces_ensure_org_and_slug BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION ensure_workspace_org_and_slug();
CREATE FUNCTION sync_legacy_membership_to_org_grants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
DECLARE v_org uuid; v_rev boolean;
BEGIN
SELECT org_id INTO v_org FROM workspaces WHERE workspace_id = NEW.workspace_id;
IF v_org IS NOT NULL THEN
SELECT EXISTS (SELECT 1 FROM org_memberships WHERE (org_id, principal_kind, principal_id) = (v_org, 'user', NEW.user_id) AND revoked_at IS NOT NULL) INTO v_rev;
INSERT INTO workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
VALUES (NEW.workspace_id, v_org, 'user', NEW.user_id, NEW.role, NEW.invited_by, coalesce(NEW.joined_at, now()), CASE WHEN v_rev THEN coalesce(NEW.revoked_at, now()) ELSE NEW.revoked_at END)
ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role,
revoked_at = CASE WHEN v_rev THEN coalesce(EXCLUDED.revoked_at, workspace_principal_grants.revoked_at, now()) WHEN TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN NULL ELSE coalesce(EXCLUDED.revoked_at, workspace_principal_grants.revoked_at) END;
IF NEW.revoked_at IS NULL AND NOT v_rev THEN
INSERT INTO org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at)
VALUES (v_org, 'user', NEW.user_id, NEW.role, NEW.invited_by, coalesce(NEW.joined_at, now())) ON CONFLICT (org_id, principal_kind, principal_id) DO NOTHING;
END IF;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER memberships_sync_org_grants AFTER INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION sync_legacy_membership_to_org_grants();
CREATE FUNCTION ensure_agent_principal_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
BEGIN
IF NEW.agent_identity_id IS NULL THEN
INSERT INTO agent_identities (id, owner_user_id, display_name, created_at, revoked_at)
VALUES (NEW.principal_id, NEW.owner_user_id, NEW.name, coalesce(NEW.created_at, now()), NEW.revoked_at) ON CONFLICT (id) DO NOTHING;
NEW.agent_identity_id := NEW.principal_id;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER agent_principals_ensure_identity BEFORE INSERT ON agent_principals FOR EACH ROW EXECUTE FUNCTION ensure_agent_principal_identity();
CREATE FUNCTION sync_standing_grant_to_agent_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
DECLARE v_ap RECORD; v_ai uuid; v_old uuid; v_ws uuid; v_ret uuid := gen_random_uuid(); v_j jsonb := to_jsonb(NEW); v_gid uuid := (v_j->>'grant_id')::uuid; v_rgid uuid := (v_j->>'renewal_grant_id')::uuid; v_rg uuid;
BEGIN
IF v_gid IS NOT NULL OR v_rgid IS NOT NULL THEN
SELECT principal_id, workspace_id, agent_identity_id, owner_user_id, name, created_at, revoked_at INTO v_ap FROM agent_principals WHERE principal_id = NEW.principal_id;
IF v_ap.principal_id IS NOT NULL THEN
v_old := v_ap.agent_identity_id; v_ws := v_ap.workspace_id;
IF v_rgid IS NOT NULL THEN
SELECT renewal_grant_id INTO v_rg FROM renewal_grants WHERE principal_id = v_ap.principal_id ORDER BY revoked_at NULLS FIRST, horizon_expires_at DESC LIMIT 1;
UPDATE agent_identities SET standing_renewal_grant_id = coalesce(v_rg, v_rgid) WHERE id = v_old;
END IF;
IF v_gid IS NOT NULL THEN
SELECT id INTO v_ai FROM agent_identities WHERE standing_grant_id = v_gid AND display_name = v_ap.name ORDER BY revoked_at NULLS FIRST, created_at LIMIT 1;
IF v_ai IS NOT NULL AND v_ai <> v_old AND (v_ap.revoked_at IS NULL OR NOT EXISTS (SELECT 1 FROM agent_principals WHERE (workspace_id, agent_identity_id) = (v_ws, v_ai) AND principal_id <> v_ap.principal_id)) THEN
INSERT INTO agent_identities (id, owner_user_id, display_name, created_at, revoked_at) SELECT CASE WHEN principal_id = v_ai THEN v_ret ELSE principal_id END, owner_user_id, name, created_at, coalesce(revoked_at, now()) FROM agent_principals WHERE (workspace_id, agent_identity_id) = (v_ws, v_ai) AND principal_id <> v_ap.principal_id ON CONFLICT (id) DO NOTHING;
UPDATE agent_principals SET agent_identity_id = CASE WHEN principal_id = v_ai THEN v_ret ELSE principal_id END, revoked_at = coalesce(revoked_at, now()) WHERE (workspace_id, agent_identity_id) = (v_ws, v_ai) AND principal_id <> v_ap.principal_id;
UPDATE agent_principals SET agent_identity_id = v_ai WHERE principal_id = v_ap.principal_id;
WITH d AS (DELETE FROM workspace_principal_grants WHERE (workspace_id, principal_kind, principal_id) = (v_ws, 'agent', v_old) RETURNING *)
INSERT INTO workspace_principal_grants SELECT gen_random_uuid(), workspace_id, org_id, 'agent', v_ai, role, granted_by, created_at, coalesce(revoked_at, v_ap.revoked_at) FROM d
ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET revoked_at = coalesce(workspace_principal_grants.revoked_at, EXCLUDED.revoked_at);
INSERT INTO org_memberships SELECT gen_random_uuid(), org_id, 'agent', v_ai, role, invited_by, created_at, revoked_at FROM org_memberships WHERE (principal_kind, principal_id) = ('agent', v_old)
ON CONFLICT (org_id, principal_kind, principal_id) DO UPDATE SET revoked_at = coalesce(org_memberships.revoked_at, EXCLUDED.revoked_at);
DELETE FROM org_memberships WHERE (principal_kind, principal_id) = ('agent', v_old) AND NOT EXISTS (SELECT 1 FROM agent_principals WHERE agent_identity_id = v_old);
WITH d AS (DELETE FROM channel_memberships WHERE (workspace_id, principal_kind, principal_id) = (v_ws, 'agent', v_old) RETURNING *)
INSERT INTO channel_memberships SELECT gen_random_uuid(), channel_id, workspace_id, 'agent', v_ai, role, notify_pref, added_by_kind, added_by, joined_at, revoked_at FROM d
ON CONFLICT (channel_id, principal_kind, principal_id) DO UPDATE SET role = CASE WHEN 'owner' IN (channel_memberships.role, EXCLUDED.role) THEN 'owner' ELSE channel_memberships.role END, revoked_at = coalesce(channel_memberships.revoked_at, EXCLUDED.revoked_at);
DELETE FROM agent_identities WHERE id = v_old AND NOT EXISTS (SELECT 1 FROM agent_principals WHERE agent_identity_id = v_old);
ELSIF v_ai IS NULL THEN
UPDATE agent_identities SET standing_grant_id = v_gid WHERE id = v_old AND (standing_grant_id IS NULL OR standing_grant_id = v_gid);
IF NOT FOUND THEN
INSERT INTO agent_identities VALUES (v_ap.principal_id, v_ap.owner_user_id, v_gid, v_rg, v_ap.name, coalesce(v_ap.created_at, now()), v_ap.revoked_at)
ON CONFLICT (id) DO UPDATE SET standing_grant_id = coalesce(EXCLUDED.standing_grant_id, agent_identities.standing_grant_id), standing_renewal_grant_id = coalesce(agent_identities.standing_renewal_grant_id, EXCLUDED.standing_renewal_grant_id);
UPDATE agent_principals SET agent_identity_id = v_ap.principal_id WHERE principal_id = v_ap.principal_id;
END IF;
END IF;
END IF;
END IF;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER hosted_mcp_seats_sync_identity AFTER INSERT OR UPDATE ON hosted_mcp_seats FOR EACH ROW EXECUTE FUNCTION sync_standing_grant_to_agent_identity();
CREATE TRIGGER renewal_grants_sync_identity AFTER INSERT OR UPDATE ON renewal_grants FOR EACH ROW EXECUTE FUNCTION sync_standing_grant_to_agent_identity();
DO $$
DECLARE f text;
BEGIN
FOREACH f IN ARRAY ARRAY['ensure_workspace_org_and_slug','sync_legacy_membership_to_org_grants','ensure_agent_principal_identity','sync_standing_grant_to_agent_identity'] LOOP
EXECUTE format('ALTER FUNCTION %1$I OWNER TO swarm_admin; REVOKE ALL ON FUNCTION %1$I FROM PUBLIC, anon, authenticated, swarm_read, swarm_command; GRANT EXECUTE ON FUNCTION %1$I TO swarm_command', f);
END LOOP;
END $$;
RESET search_path;
