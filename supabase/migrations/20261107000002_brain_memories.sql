-- Brain Phase 1, M1: workspace memories that agents save directly (the owner's Q2) and people can
-- see, edit and delete. Saves are live; every save, edit, restore or forget adds a version.
--
-- Authority stays with the existing paths: only the command role writes these tables (the command
-- edge, after its normal membership, seat, grant, family, tombstone and session checks), and reads
-- go through the two definer functions below. Nothing here grants a permission: an `ownership`
-- memory is a statement, never a role, and memory text and evidence links are untrusted data.
--
-- The original author and sponsor never change, whoever edits later; the last editor is recorded
-- separately. Subjects are canonical and unique among active memories in a workspace.

CREATE TABLE swarm.memories (
  memory_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  subject_key text NOT NULL CHECK (subject_key ~ '^[a-z0-9][a-z0-9 ._/-]{0,119}$' AND subject_key !~ '  '),
  kind text NOT NULL CHECK (kind IN ('decision', 'convention', 'ownership', 'fact')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 1000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 5),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  revision integer NOT NULL CHECK (revision >= 1),
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_id uuid NOT NULL,
  sponsor_user_id uuid NOT NULL,
  last_editor_kind text NOT NULL CHECK (last_editor_kind IN ('user', 'agent')),
  last_editor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  review_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX memories_active_subject
  ON swarm.memories (workspace_id, subject_key) WHERE status = 'active';
CREATE INDEX memories_workspace_recent
  ON swarm.memories (workspace_id, updated_at DESC) WHERE status = 'active';

CREATE TABLE swarm.memory_versions (
  memory_id uuid NOT NULL REFERENCES swarm.memories (memory_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  revision integer NOT NULL CHECK (revision >= 1),
  action text NOT NULL CHECK (action IN ('save', 'edit', 'restore', 'forget')),
  kind text NOT NULL CHECK (kind IN ('decision', 'convention', 'ownership', 'fact')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 1000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 5),
  editor_kind text NOT NULL CHECK (editor_kind IN ('user', 'agent')),
  editor_id uuid NOT NULL,
  sponsor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (memory_id, revision)
);
-- Per-agent daily save counts and the per-workspace history cap read these.
CREATE INDEX memory_versions_editor_recent
  ON swarm.memory_versions (workspace_id, editor_kind, editor_id, created_at DESC);
CREATE INDEX memory_versions_workspace
  ON swarm.memory_versions (workspace_id);

-- The original author, sponsor, workspace and subject are fixed for the memory's life.
CREATE FUNCTION swarm.memories_fixed_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.subject_key IS DISTINCT FROM OLD.subject_key OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.sponsor_user_id IS DISTINCT FROM OLD.sponsor_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'memory identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'memory revision must increase' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION swarm.memories_fixed_identity() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.memories_fixed_identity() FROM PUBLIC;
CREATE TRIGGER memories_fixed_identity BEFORE UPDATE ON swarm.memories
  FOR EACH ROW EXECUTE FUNCTION swarm.memories_fixed_identity();

ALTER TABLE swarm.memories OWNER TO swarm_admin;
ALTER TABLE swarm.memory_versions OWNER TO swarm_admin;
ALTER TABLE swarm.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.memory_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY memories_command_all ON swarm.memories AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
CREATE POLICY memory_versions_command_all ON swarm.memory_versions AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.memories, swarm.memory_versions FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, UPDATE ON swarm.memories TO swarm_command;
GRANT SELECT, INSERT ON swarm.memory_versions TO swarm_command;

-- The caller's admission, as channel_messages: valid claims, a live member, and for an agent an
-- unrevoked principal bound to this workspace. Returns the caller or NULL.
CREATE FUNCTION swarm_read.memory_reader(p_workspace_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 caller := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, caller) THEN RETURN NULL; END IF;
 IF claims ? 'agent_principal_id' THEN
  IF coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RETURN NULL;
  END IF;
  caller_agent := (claims->>'agent_principal_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM swarm.agent_principals p
   JOIN swarm.agent_workspace_memberships am USING (principal_id, owner_user_id)
   WHERE am.workspace_id = p_workspace_id AND p.principal_id = caller_agent
     AND p.owner_user_id = caller AND p.revoked_at IS NULL AND am.revoked_at IS NULL) THEN
   RETURN NULL;
  END IF;
 END IF;
 RETURN caller;
END;
$$;
ALTER FUNCTION swarm_read.memory_reader(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.memory_reader(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Active memories in the workspace, newest first, at most 50, optionally filtered by a plain
-- substring of the subject or statement. Every row carries provenance and an untrusted marker.
CREATE FUNCTION swarm_read.memory_search(p_workspace_id uuid, p_query text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
 needle text := nullif(lower(btrim(coalesce(p_query, ''))), '');
BEGIN
 IF swarm_read.memory_reader(p_workspace_id) IS NULL THEN RETURN NULL; END IF;
 IF needle IS NOT NULL AND length(needle) > 200 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'untrusted_content', true, 'memories', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'memory_id', m.memory_id, 'subject', m.subject_key, 'kind', m.kind,
    'statement', m.statement, 'evidence', m.evidence, 'revision', m.revision,
    'author', jsonb_build_object('kind', m.author_kind, 'id', m.author_id),
    'sponsor_user_id', m.sponsor_user_id,
    'last_editor', jsonb_build_object('kind', m.last_editor_kind, 'id', m.last_editor_id),
    'created_at', m.created_at, 'updated_at', m.updated_at, 'review_at', m.review_at)
    ORDER BY m.updated_at DESC, m.memory_id), '[]'::jsonb)
  FROM (
   SELECT * FROM swarm.memories m
   WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
     AND (needle IS NULL
       OR strpos(m.subject_key, needle) > 0
       OR strpos(lower(m.statement), needle) > 0)
   ORDER BY m.updated_at DESC, m.memory_id
   LIMIT page_limit
  ) m));
END;
$$;
ALTER FUNCTION swarm_read.memory_search(uuid, text, integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.memory_search(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.memory_search(uuid, text, integer) TO swarm_read, authenticated;

-- One memory in the workspace (active, or deleted by an agent's forget and not yet purged), with
-- up to its 50 newest versions. Unknown, purged and other-workspace ids all return NULL.
CREATE FUNCTION swarm_read.memory_get(p_workspace_id uuid, p_memory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 found swarm.memories%ROWTYPE;
BEGIN
 IF swarm_read.memory_reader(p_workspace_id) IS NULL OR p_memory_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO found FROM swarm.memories m
 WHERE m.workspace_id = p_workspace_id AND m.memory_id = p_memory_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'untrusted_content', true,
  'memory', jsonb_build_object(
    'memory_id', found.memory_id, 'subject', found.subject_key, 'kind', found.kind,
    'statement', found.statement, 'evidence', found.evidence, 'status', found.status,
    'revision', found.revision,
    'author', jsonb_build_object('kind', found.author_kind, 'id', found.author_id),
    'sponsor_user_id', found.sponsor_user_id,
    'last_editor', jsonb_build_object('kind', found.last_editor_kind, 'id', found.last_editor_id),
    'created_at', found.created_at, 'updated_at', found.updated_at, 'review_at', found.review_at),
  'versions', (
   SELECT coalesce(jsonb_agg(jsonb_build_object(
     'revision', v.revision, 'action', v.action, 'kind', v.kind, 'statement', v.statement,
     'evidence', v.evidence, 'editor', jsonb_build_object('kind', v.editor_kind, 'id', v.editor_id),
     'created_at', v.created_at) ORDER BY v.revision DESC), '[]'::jsonb)
   FROM (SELECT * FROM swarm.memory_versions v
     WHERE v.memory_id = found.memory_id AND v.workspace_id = p_workspace_id
     ORDER BY v.revision DESC LIMIT 50) v));
END;
$$;
ALTER FUNCTION swarm_read.memory_get(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.memory_get(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.memory_get(uuid, uuid) TO swarm_read, authenticated;
