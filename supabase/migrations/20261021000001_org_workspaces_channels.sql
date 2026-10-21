-- CommonSwarm Organizations > Workspaces > Channels (Phase 0 Schema, Backfill, Compatibility Triggers & RLS)
-- Canonical Lock Order: organizations -> workspaces -> channels -> org_memberships -> workspace_principal_grants -> channel_memberships -> agent_principals -> seats
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.agent_identities (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  standing_grant_id uuid REFERENCES hosted_mcp_grants(grant_id),
  standing_renewal_grant_id uuid UNIQUE REFERENCES renewal_grants(renewal_grant_id),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (standing_grant_id, display_name)
);

CREATE TABLE swarm.organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND char_length(slug) BETWEEN 1 AND 48),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  logo_object_key text,
  logo_updated_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_lower_key ON swarm.organizations(lower(slug));

CREATE TABLE swarm.org_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  invited_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (org_id, principal_kind, principal_id)
);
CREATE INDEX org_memberships_live_idx ON swarm.org_memberships(principal_kind, principal_id, org_id) WHERE revoked_at IS NULL;

CREATE TABLE swarm.org_invites (
  invite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text,
  role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  workspace_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by uuid NOT NULL REFERENCES users(user_id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by uuid REFERENCES users(user_id),
  revoked_at timestamptz
);

CREATE TABLE swarm.workspace_principal_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  granted_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, principal_kind, principal_id)
);
CREATE INDEX workspace_grants_live_idx ON swarm.workspace_principal_grants(principal_kind, principal_id, workspace_id) WHERE revoked_at IS NULL;

CREATE TABLE swarm.connection_org_policies (
  connection_id uuid PRIMARY KEY,
  owner_user_id uuid REFERENCES users(user_id),
  agent_identity_id uuid REFERENCES agent_identities(id),
  default_org_id uuid REFERENCES organizations(id),
  default_workspace_id uuid REFERENCES workspaces(workspace_id),
  allowed_org_ids uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE swarm.channel_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','member')),
  notify_pref text NOT NULL DEFAULT 'all' CHECK (notify_pref IN ('all','mentions','mute')),
  added_by_kind text NOT NULL DEFAULT 'user' CHECK (added_by_kind IN ('user','agent')),
  added_by uuid,
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (channel_id, principal_kind, principal_id),
  FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);
CREATE INDEX channel_memberships_live_idx ON swarm.channel_memberships(channel_id, principal_kind, principal_id) WHERE revoked_at IS NULL;

CREATE TABLE swarm.file_channel_bindings (
  file_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  bound_by_kind text NOT NULL DEFAULT 'user' CHECK (bound_by_kind IN ('user','agent')),
  bound_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, channel_id),
  FOREIGN KEY (file_id, workspace_id) REFERENCES files(file_id, workspace_id),
  FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(channel_id, workspace_id)
);

CREATE TABLE swarm.org_approval_requests (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid REFERENCES workspaces(workspace_id),
  channel_id uuid REFERENCES channels(channel_id),
  requested_by_agent_identity_id uuid NOT NULL REFERENCES agent_identities(id),
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  action_kind text NOT NULL CHECK (btrim(action_kind) <> ''),
  target_scope jsonb NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
  decided_by uuid REFERENCES users(user_id),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
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
  INSERT INTO organizations
  SELECT workspace_id,
    left(coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'org'), 39) || '-' || left(workspace_id::text, 8),
    name, NULL, NULL, created_by, created_at, created_at, archived_at
  FROM workspaces ON CONFLICT DO NOTHING;

  UPDATE workspaces w SET org_id = o.id, slug = o.slug FROM organizations o WHERE o.id = w.workspace_id;

  WITH ranked_principals AS (
    SELECT ap.*, hs.grant_id,
      CASE WHEN hs.grant_id IS NULL THEN 1
           ELSE row_number() OVER (PARTITION BY hs.grant_id, ap.name, ap.workspace_id ORDER BY ap.revoked_at NULLS FIRST, ap.created_at ASC, ap.principal_id ASC)
      END AS ws_dup_rn
    FROM agent_principals ap
    LEFT JOIN hosted_mcp_seats hs USING (principal_id)
  )
  INSERT INTO agent_identities (id, owner_user_id, standing_grant_id, standing_renewal_grant_id, display_name, created_at, revoked_at)
  SELECT DISTINCT ON (CASE WHEN grant_id IS NOT NULL AND ws_dup_rn = 1 THEN grant_id::text || ':' || name ELSE principal_id::text END)
    principal_id,
    owner_user_id,
    CASE WHEN ws_dup_rn = 1 THEN grant_id ELSE NULL END,
    (SELECT rg.renewal_grant_id FROM renewal_grants rg WHERE rg.principal_id = ranked_principals.principal_id ORDER BY rg.revoked_at NULLS FIRST, rg.horizon_expires_at DESC LIMIT 1),
    name,
    created_at,
    revoked_at
  FROM ranked_principals
  ORDER BY (CASE WHEN grant_id IS NOT NULL AND ws_dup_rn = 1 THEN grant_id::text || ':' || name ELSE principal_id::text END), revoked_at NULLS FIRST, created_at ASC
  ON CONFLICT DO NOTHING;

  WITH ranked_principals AS (
    SELECT ap.principal_id, ap.name, hs.grant_id,
      CASE WHEN hs.grant_id IS NULL THEN 1
           ELSE row_number() OVER (PARTITION BY hs.grant_id, ap.name, ap.workspace_id ORDER BY ap.revoked_at NULLS FIRST, ap.created_at ASC, ap.principal_id ASC)
      END AS ws_dup_rn
    FROM agent_principals ap
    LEFT JOIN hosted_mcp_seats hs USING (principal_id)
  )
  UPDATE agent_principals ap
  SET agent_identity_id = coalesce(
    (SELECT ai.id FROM ranked_principals rp JOIN agent_identities ai ON ai.standing_grant_id = rp.grant_id AND ai.display_name = rp.name WHERE rp.principal_id = ap.principal_id AND rp.grant_id IS NOT NULL AND rp.ws_dup_rn = 1 LIMIT 1),
    ap.principal_id
  );

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
END
$$;

ALTER TABLE swarm.workspaces ALTER COLUMN org_id SET NOT NULL, ALTER COLUMN slug SET NOT NULL;
ALTER TABLE swarm.agent_principals ALTER COLUMN agent_identity_id SET NOT NULL, ADD CONSTRAINT agent_principals_workspace_identity_key UNIQUE (workspace_id, agent_identity_id);
CREATE UNIQUE INDEX workspaces_org_slug_lower_key ON swarm.workspaces(org_id, lower(slug));

CREATE FUNCTION swarm.ensure_workspace_org_and_slug() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
BEGIN
  IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
    NEW.slug := left(coalesce(nullif(trim(both '-' from regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g')), ''), 'org'), 39) || '-' || left(NEW.workspace_id::text, 8);
  END IF;
  IF NEW.org_id IS NULL THEN
    INSERT INTO swarm.organizations (id, slug, display_name, created_by, created_at, updated_at, archived_at)
    VALUES (NEW.workspace_id, NEW.slug, NEW.name, NEW.created_by, coalesce(NEW.created_at, now()), coalesce(NEW.created_at, now()), NEW.archived_at)
    ON CONFLICT (id) DO NOTHING;
    NEW.org_id := NEW.workspace_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspaces_ensure_org_and_slug BEFORE INSERT ON swarm.workspaces FOR EACH ROW EXECUTE FUNCTION swarm.ensure_workspace_org_and_slug();

CREATE FUNCTION swarm.sync_legacy_membership_to_org_grants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
DECLARE v_org uuid; v_org_revoked boolean;
BEGIN
  SELECT org_id INTO v_org FROM swarm.workspaces WHERE workspace_id = NEW.workspace_id;
  IF v_org IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM swarm.org_memberships
      WHERE (org_id, principal_kind, principal_id) = (v_org, 'user', NEW.user_id)
        AND revoked_at IS NOT NULL
    ) INTO v_org_revoked;

    INSERT INTO swarm.workspace_principal_grants (workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at)
    VALUES (NEW.workspace_id, v_org, 'user', NEW.user_id, NEW.role, NEW.invited_by, coalesce(NEW.joined_at, now()), CASE WHEN v_org_revoked THEN coalesce(NEW.revoked_at, now()) ELSE NEW.revoked_at END)
    ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET
      org_id = EXCLUDED.org_id,
      role = EXCLUDED.role,
      revoked_at = CASE WHEN v_org_revoked THEN coalesce(EXCLUDED.revoked_at, workspace_principal_grants.revoked_at, now()) ELSE EXCLUDED.revoked_at END;

    IF NEW.revoked_at IS NULL AND NOT v_org_revoked THEN
      INSERT INTO swarm.org_memberships (org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at)
      VALUES (v_org, 'user', NEW.user_id, NEW.role, NEW.invited_by, coalesce(NEW.joined_at, now()), NULL)
      ON CONFLICT (org_id, principal_kind, principal_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_sync_org_grants AFTER INSERT OR UPDATE ON swarm.memberships FOR EACH ROW EXECUTE FUNCTION swarm.sync_legacy_membership_to_org_grants();

CREATE FUNCTION swarm.ensure_agent_principal_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
BEGIN
  IF NEW.agent_identity_id IS NULL THEN
    INSERT INTO swarm.agent_identities (id, owner_user_id, display_name, created_at, revoked_at)
    VALUES (NEW.principal_id, NEW.owner_user_id, NEW.name, coalesce(NEW.created_at, now()), NEW.revoked_at)
    ON CONFLICT (id) DO NOTHING;
    NEW.agent_identity_id := NEW.principal_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agent_principals_ensure_identity BEFORE INSERT ON swarm.agent_principals FOR EACH ROW EXECUTE FUNCTION swarm.ensure_agent_principal_identity();

ALTER FUNCTION swarm.ensure_workspace_org_and_slug() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_legacy_membership_to_org_grants() OWNER TO swarm_admin;
ALTER FUNCTION swarm.ensure_agent_principal_identity() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ensure_workspace_org_and_slug(), swarm.sync_legacy_membership_to_org_grants(), swarm.ensure_agent_principal_identity() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ensure_workspace_org_and_slug(), swarm.sync_legacy_membership_to_org_grants(), swarm.ensure_agent_principal_identity() TO swarm_command;

RESET search_path;
