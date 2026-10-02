-- Lane C: routine operations. No grant or worker boundary is widened.
ALTER TABLE swarm.events ADD COLUMN admin_identity_id uuid,
  ADD COLUMN grant_id uuid REFERENCES swarm.admin_grants(grant_id),
  ADD COLUMN grant_manifest_digest text;
ALTER TABLE swarm.events ADD CONSTRAINT delegated_event_actor CHECK (
  grant_id IS NULL OR (admin_identity_id IS NOT NULL AND grant_manifest_digest ~ '^[0-9a-f]{64}$'
    AND actor_user IS NULL AND actor_agent_principal IS NULL AND actor_run IS NULL));
CREATE TABLE swarm.admin_created_workspaces (
  workspace_id uuid PRIMARY KEY REFERENCES swarm.workspaces(workspace_id),
  grant_id uuid NOT NULL REFERENCES swarm.admin_grants(grant_id), scope_names text[] NOT NULL
);
CREATE TABLE swarm.admin_routine_invitations (
  invitation_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
  parent_admin_grant_id uuid NOT NULL REFERENCES swarm.admin_grants(grant_id),
  owner_user_id uuid NOT NULL REFERENCES swarm.users(user_id),
  recipient_user_id uuid NOT NULL REFERENCES swarm.users(user_id), recipient_connection_id uuid,
  invitation_kind text NOT NULL CHECK(invitation_kind IN ('member','agent')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
  revoked_at timestamptz, accepted_at timestamptz, projection jsonb NOT NULL,
  CHECK(expires_at > created_at), CHECK(jsonb_typeof(projection)='object'),
  CHECK(invitation_kind <> 'agent' OR recipient_connection_id IS NOT NULL)
);
CREATE INDEX admin_routine_invitations_owner_created ON swarm.admin_routine_invitations(owner_user_id,created_at);
ALTER TABLE swarm.agent_principals ADD COLUMN parent_admin_grant_id uuid REFERENCES swarm.admin_grants(grant_id);
ALTER TABLE swarm.agent_tokens ADD COLUMN parent_admin_grant_id uuid REFERENCES swarm.admin_grants(grant_id),
  ADD COLUMN recipient_connection_id uuid;

DO $permissions$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_created_workspaces','admin_routine_invitations'] LOOP
    EXECUTE format('ALTER TABLE swarm.%I OWNER TO swarm_admin',t);
    EXECUTE format('ALTER TABLE swarm.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY swarm_command_all ON swarm.%I FOR ALL TO swarm_command USING(true) WITH CHECK(true)',t);
    EXECUTE format('REVOKE ALL ON swarm.%I FROM PUBLIC,anon,authenticated,swarm_read,swarm_command',t);
    EXECUTE format('GRANT SELECT,INSERT ON swarm.%I TO swarm_command',t);
  END LOOP;
END
$permissions$;
GRANT UPDATE ON swarm.admin_routine_invitations TO swarm_command;

-- Parent checks apply to the existing worker read/command/renewal adapters,
-- without modifying read/ or teaching a worker any administration permission.
-- The share lock orders concurrent grant revocation against an authenticated call.
CREATE FUNCTION swarm.admin_child_live(parent uuid, workspace uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path=pg_catalog AS $$
DECLARE g swarm.admin_grants%ROWTYPE; created swarm.admin_created_workspaces%ROWTYPE;
BEGIN
  IF parent IS NULL THEN RETURN true; END IF;
  SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=parent FOR SHARE;
  IF NOT FOUND OR g.state <> 'active' OR g.expires_at <= clock_timestamp() OR g.refresh_deadline <= clock_timestamp()
    OR workspace=ANY(g.withdrawn_workspace_ids) THEN RETURN false; END IF;
  SELECT * INTO created FROM swarm.admin_created_workspaces WHERE workspace_id=workspace;
  IF NOT (workspace=ANY(g.workspace_ids) OR coalesce(created.grant_id=parent,false) OR
    (g.workspace_selector='owned_and_selected' AND EXISTS(SELECT 1 FROM swarm.memberships WHERE workspace_id=workspace AND user_id=g.owner_user_id AND role='owner' AND revoked_at IS NULL))) THEN RETURN false; END IF;
  IF created.grant_id=parent AND NOT ('seats:create'=ANY(created.scope_names) AND
    g.created_workspace_policy->'scope_names' ? 'seats:create') THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    WHERE m.workspace_id=workspace AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
      AND m.role IN ('owner','admin') AND w.archived_at IS NULL);
END $$;
ALTER FUNCTION swarm.admin_child_live(uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_child_live(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.admin_child_live(uuid,uuid) TO swarm_command,swarm_read;
CREATE FUNCTION swarm.admin_child_scopes_live(parent uuid, scopes jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
  SELECT parent IS NULL OR EXISTS(SELECT 1 FROM swarm.admin_grants g WHERE g.grant_id=parent
    AND jsonb_typeof(scopes)='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(scopes) AS s(scope) WHERE NOT s.scope=ANY(g.worker_scope_ceiling)))
$$;
ALTER FUNCTION swarm.admin_child_scopes_live(uuid,jsonb) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_child_scopes_live(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.admin_child_scopes_live(uuid,jsonb) TO swarm_command,swarm_read;
CREATE POLICY admin_parent_select ON swarm.agent_tokens AS RESTRICTIVE FOR SELECT TO swarm_command,swarm_read
  USING(swarm.admin_child_scopes_live(parent_admin_grant_id,scopes) AND swarm.admin_child_live(parent_admin_grant_id,(SELECT workspace_id FROM swarm.agent_principals p WHERE p.principal_id=agent_tokens.principal_id)));

-- Ancestry propagates through ordinary worker renewal too. Existing initial
-- human-created tokens have NULL ancestry and are unaffected.
CREATE FUNCTION swarm.admin_token_ancestry() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent uuid; workspace uuid; recipient uuid; owner_user uuid; g swarm.admin_grants%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.parent_admin_grant_id IS DISTINCT FROM OLD.parent_admin_grant_id OR NEW.recipient_connection_id IS DISTINCT FROM OLD.recipient_connection_id THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.parent_admin_grant_id,p.workspace_id,p.owner_user_id INTO parent,workspace,owner_user FROM swarm.agent_principals p WHERE p.principal_id=NEW.principal_id;
  IF NEW.predecessor_token_id IS NOT NULL THEN
    SELECT t.parent_admin_grant_id,t.recipient_connection_id INTO parent,recipient FROM swarm.agent_tokens t WHERE t.token_id=NEW.predecessor_token_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_PREDECESSOR_MISSING' USING ERRCODE='55000'; END IF;
    IF NEW.parent_admin_grant_id IS NOT NULL AND NEW.parent_admin_grant_id IS DISTINCT FROM parent THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_MISMATCH' USING ERRCODE='55000'; END IF;
    NEW.parent_admin_grant_id:=parent; NEW.recipient_connection_id:=recipient;
  ELSIF parent IS NOT NULL THEN
    IF NEW.parent_admin_grant_id IS NOT NULL AND NEW.parent_admin_grant_id IS DISTINCT FROM parent THEN
      RAISE EXCEPTION 'ADMIN_ANCESTRY_MISMATCH' USING ERRCODE='55000'; END IF;
    NEW.parent_admin_grant_id:=parent;
  END IF;
  IF NEW.parent_admin_grant_id IS NOT NULL THEN
    SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=NEW.parent_admin_grant_id;
    IF NOT FOUND OR g.owner_user_id IS DISTINCT FROM owner_user OR NEW.recipient_connection_id IS NULL
      OR NOT NEW.recipient_connection_id=ANY(ARRAY(SELECT jsonb_array_elements_text(g.target_rules->'recipient_connection_ids')::uuid))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.scopes) scope WHERE NOT scope=ANY(g.worker_scope_ceiling))
    THEN RAISE EXCEPTION 'ADMIN_CHILD_BINDING_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  IF NOT swarm.admin_child_live(NEW.parent_admin_grant_id,workspace) THEN
    RAISE EXCEPTION 'ADMIN_PARENT_INACTIVE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION swarm.admin_token_ancestry() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_token_ancestry() FROM PUBLIC;
CREATE TRIGGER aa_admin_token_ancestry BEFORE INSERT OR UPDATE ON swarm.agent_tokens FOR EACH ROW EXECUTE FUNCTION swarm.admin_token_ancestry();
CREATE FUNCTION swarm.admin_principal_ancestry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.parent_admin_grant_id IS DISTINCT FROM OLD.parent_admin_grant_id THEN RAISE EXCEPTION 'ADMIN_ANCESTRY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION swarm.admin_principal_ancestry() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_principal_ancestry() FROM PUBLIC;
CREATE TRIGGER admin_principal_ancestry BEFORE UPDATE ON swarm.agent_principals FOR EACH ROW EXECUTE FUNCTION swarm.admin_principal_ancestry();
CREATE FUNCTION swarm.admin_end_pending_invitations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state <> 'active' THEN
    UPDATE swarm.admin_routine_invitations SET revoked_at=coalesce(revoked_at,CASE NEW.state WHEN 'revoked' THEN NEW.revoked_at WHEN 'suspended' THEN NEW.suspended_at ELSE NEW.expires_at END) WHERE parent_admin_grant_id=NEW.grant_id AND accepted_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION swarm.admin_end_pending_invitations() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_end_pending_invitations() FROM PUBLIC;
CREATE TRIGGER admin_end_pending_invitations AFTER UPDATE OF state ON swarm.admin_grants FOR EACH ROW EXECUTE FUNCTION swarm.admin_end_pending_invitations();

-- Existing lane-B grants have accepted zero routine operations. Initialize
-- their zero counters once when enabling this new command family.
UPDATE swarm.admin_accounts a SET projection=jsonb_set(projection,'{routine}',
  jsonb_build_object('spend',coalesce((SELECT jsonb_object_agg(g.grant_id::text,
    jsonb_build_object('workspaces',0,'total_seats',0,'invitations',0,'worker_credentials',0,'successors',0))
    FROM swarm.admin_grants g WHERE g.owner_user_id=a.owner_user_id),'{}'::jsonb),
    'created_workspaces','{}'::jsonb,'seats','{}'::jsonb,'credentials','{}'::jsonb,'invitations','{}'::jsonb))
WHERE NOT projection ? 'routine';
