-- Seat admin, PR 1 (schema only): an owner gives one of their own agents admin powers on the
-- seat it already holds, at one of three levels: chosen scopes in chosen workspaces ('scoped'),
-- the workspace admin role in one workspace ('workspace'), or the organization admin role in one
-- organization and its workspaces ('organization'). A role level pins one role bundle; the
-- registry version in the manifest defines exactly which commands it allows. The grant binds the agent principal, not a token: every valid credential
-- of that principal can use it, and bearer rotation keeps it. The command edge re-reads it live on
-- every action (a later PR, behind SWARM_SEAT_ADMIN, off). Nothing here grants anything by itself.
--
-- The confirmed manifest is pinned as written, and its scope, workspace and registry fields must
-- equal the columns the edge checks. A grant only moves forward: active, then exactly one terminal
-- state; a terminal grant never reactivates. One active grant per agent. Only the command role
-- writes; people read their own grants through one definer function.

CREATE FUNCTION swarm.seat_admin_text_set(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT array_position(p, NULL) IS NULL
    AND p = ARRAY(SELECT DISTINCT x FROM unnest(p) AS x ORDER BY x)
$$;
CREATE FUNCTION swarm.seat_admin_uuid_set(p uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT array_position(p, NULL) IS NULL
    AND p = ARRAY(SELECT DISTINCT x FROM unnest(p) AS x ORDER BY x)
$$;

CREATE TABLE swarm.seat_admin_grants (
  grant_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES swarm.users (user_id),
  principal_id uuid NOT NULL REFERENCES swarm.agent_principals (principal_id),
  level text NOT NULL CHECK (level IN ('scoped', 'workspace', 'organization')),
  organization_id uuid REFERENCES swarm.organizations (id),
  -- Registry v3: v2's available routine commands plus workspaces:rename. Seat grants start at v3.
  registry_version integer NOT NULL CHECK (registry_version = 3),
  scope_names text[] NOT NULL CHECK (cardinality(scope_names) BETWEEN 1 AND 8 AND swarm.seat_admin_text_set(scope_names)),
  -- 'organization' covers the organization's workspaces live, so it names none here.
  workspace_ids uuid[] NOT NULL CHECK (cardinality(workspace_ids) <= 10 AND swarm.seat_admin_uuid_set(workspace_ids)),
  -- IS NOT DISTINCT FROM, never '=': a CHECK passes on NULL, so a missing manifest key must fail.
  manifest jsonb NOT NULL CHECK (
    jsonb_typeof(manifest) = 'object' AND pg_column_size(manifest) <= 16384
    AND manifest->'registry_version' IS NOT DISTINCT FROM to_jsonb(registry_version)
    AND manifest->'level' IS NOT DISTINCT FROM to_jsonb(level)
    AND manifest->'scope_names' IS NOT DISTINCT FROM to_jsonb(scope_names)
    AND manifest->'workspace_ids' IS NOT DISTINCT FROM to_jsonb(workspace_ids)
    AND manifest->'organization_id' IS NOT DISTINCT FROM coalesce(to_jsonb(organization_id), 'null'::jsonb)
    AND manifest->'principal_id' IS NOT DISTINCT FROM to_jsonb(principal_id)
  ),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  -- NULL is "No end date" (the default the owner chose); a set end is at most 90 days out.
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'downgraded', 'expired', 'ended')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN (
    'owner_downgrade', 'seat_revoked', 'no_covered_workspace', 'owner_lost_role', 'expired', 'replaced')),
  -- Each level's shape. Scoped: the day-one scopes, admin:read always, 1 to 10 workspaces. A role
  -- level: exactly its one role bundle, and exactly one workspace or one organization.
  CHECK (CASE level
    WHEN 'scoped' THEN organization_id IS NULL AND cardinality(workspace_ids) >= 1
      AND 'admin:read' = ANY (scope_names)
      AND scope_names <@ ARRAY['admin:read', 'seats:create', 'seats:renew', 'seats:revoke',
        'invites:create', 'invites:revoke', 'onboarding:connect', 'workspaces:rename']::text[]
    WHEN 'workspace' THEN organization_id IS NULL AND cardinality(workspace_ids) = 1
      AND scope_names = ARRAY['role:workspace_admin']::text[]
    WHEN 'organization' THEN organization_id IS NOT NULL AND cardinality(workspace_ids) = 0
      AND scope_names = ARRAY['role:organization_admin']::text[]
    ELSE false
  END),
  CHECK (expires_at IS NULL OR (expires_at > created_at AND expires_at <= created_at + interval '90 days')),
  CHECK ((state = 'active') = (ended_at IS NULL AND end_reason IS NULL)),
  CHECK (state <> 'expired' OR end_reason = 'expired'),
  CHECK (state <> 'downgraded' OR end_reason IN ('owner_downgrade', 'replaced')),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);
-- One active grant per agent and target: one scoped grant, one per workspace, one per organization.
CREATE UNIQUE INDEX seat_admin_grants_one_active ON swarm.seat_admin_grants (principal_id)
  WHERE state = 'active' AND level = 'scoped';
CREATE UNIQUE INDEX seat_admin_grants_one_active_workspace ON swarm.seat_admin_grants (principal_id, (workspace_ids[1]))
  WHERE state = 'active' AND level = 'workspace';
CREATE UNIQUE INDEX seat_admin_grants_one_active_organization ON swarm.seat_admin_grants (principal_id, organization_id)
  WHERE state = 'active' AND level = 'organization';
CREATE INDEX seat_admin_grants_owner ON swarm.seat_admin_grants (owner_user_id, created_at DESC);

-- Forward-only: the only change is active -> one terminal state, stamping ended_at and end_reason.
CREATE FUNCTION swarm.seat_admin_grants_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seat admin grants are history and are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'active' OR NEW.state = 'active'
     OR (NEW.grant_id, NEW.owner_user_id, NEW.principal_id, NEW.level, NEW.organization_id, NEW.registry_version,
         NEW.scope_names, NEW.workspace_ids, NEW.manifest, NEW.manifest_digest, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.grant_id, OLD.owner_user_id, OLD.principal_id, OLD.level, OLD.organization_id, OLD.registry_version,
         OLD.scope_names, OLD.workspace_ids, OLD.manifest, OLD.manifest_digest, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a seat admin grant only ends, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER seat_admin_grants_forward_only BEFORE UPDATE OR DELETE ON swarm.seat_admin_grants
  FOR EACH ROW EXECUTE FUNCTION swarm.seat_admin_grants_forward_only();

ALTER FUNCTION swarm.seat_admin_text_set(text[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.seat_admin_uuid_set(uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.seat_admin_grants_forward_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_admin_grants_forward_only() FROM PUBLIC;
ALTER TABLE swarm.seat_admin_grants OWNER TO swarm_admin;
ALTER TABLE swarm.seat_admin_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY seat_admin_grants_command_all ON swarm.seat_admin_grants AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.seat_admin_grants FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT ON swarm.seat_admin_grants TO swarm_command;
-- Ending a grant is the only write after insert; the trigger keeps it forward-only.
GRANT UPDATE (state, ended_at, end_reason) ON swarm.seat_admin_grants TO swarm_command;

-- For the signed-in person: the seat admin grants they gave, newest first, at most 100. People
-- only; claims naming an agent get nothing. Agents learn their own grant through the command edge.
CREATE FUNCTION swarm_read.my_seat_admin_grants()
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
  FROM (SELECT * FROM swarm.seat_admin_grants WHERE owner_user_id = viewer ORDER BY created_at DESC LIMIT 100) g));
END;
$$;
ALTER FUNCTION swarm_read.my_seat_admin_grants() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.my_seat_admin_grants() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.my_seat_admin_grants() TO authenticated;
