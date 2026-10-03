-- Existing files, version IDs, private bucket and workspace/file/version paths.
ALTER TABLE swarm.file_versions ADD CONSTRAINT household_version_tenant UNIQUE (version_id, file_id, workspace_id);
ALTER TABLE swarm.files ADD COLUMN household_managed boolean NOT NULL DEFAULT false;
CREATE TABLE swarm.household_object_bindings (
 workspace_id uuid NOT NULL REFERENCES swarm.household_object_streams(workspace_id),
 object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 255),
 file_id uuid NOT NULL UNIQUE,
 PRIMARY KEY (workspace_id, object_id),
 UNIQUE (workspace_id, object_id, file_id),
 FOREIGN KEY (file_id, workspace_id) REFERENCES swarm.files(file_id, workspace_id)
);
CREATE TABLE swarm.household_object_artifacts (
 workspace_id uuid NOT NULL,
 object_id text NOT NULL,
 version_id uuid PRIMARY KEY,
 file_id uuid NOT NULL,
 storage_path text NOT NULL UNIQUE,
 size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK (state IN ('reserved','committed','draft','released')),
 revision_token text,
 reservation_id text,
 draft_id text,
 FOREIGN KEY (workspace_id, object_id, file_id) REFERENCES swarm.household_object_bindings(workspace_id, object_id, file_id),
 FOREIGN KEY (version_id, file_id, workspace_id) REFERENCES swarm.file_versions(version_id, file_id, workspace_id),
 CHECK ((state = 'committed' AND revision_token IS NOT NULL AND draft_id IS NULL)
     OR (state = 'reserved' AND reservation_id IS NOT NULL AND revision_token IS NULL AND draft_id IS NULL)
     OR (state = 'draft' AND draft_id IS NOT NULL AND revision_token IS NULL)
     OR state = 'released'),
 UNIQUE (workspace_id, object_id, revision_token)
);
CREATE INDEX household_object_artifacts_reservation ON swarm.household_object_artifacts(workspace_id, reservation_id) WHERE state = 'reserved';
ALTER TABLE swarm.household_object_bindings OWNER TO swarm_admin;
ALTER TABLE swarm.household_object_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_object_bindings FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_object_bindings FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT ON swarm.household_object_bindings TO swarm_command;
ALTER TABLE swarm.household_object_artifacts OWNER TO swarm_admin;
ALTER TABLE swarm.household_object_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_object_artifacts FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_object_artifacts FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_object_artifacts TO swarm_command;

-- Terminal artifact metadata is immutable. Only a reservation may settle.
CREATE FUNCTION swarm.guard_household_artifact_settlement()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'reserved' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'household artifact is immutable';
  END IF;
  IF (NEW.workspace_id, NEW.object_id, NEW.version_id, NEW.file_id, NEW.storage_path, NEW.size_bytes, NEW.sha256, NEW.reservation_id)
     IS DISTINCT FROM (OLD.workspace_id, OLD.object_id, OLD.version_id, OLD.file_id, OLD.storage_path, OLD.size_bytes, OLD.sha256, OLD.reservation_id)
     OR NEW.state = 'reserved' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'household reservation may only settle';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION swarm.guard_household_artifact_settlement() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.guard_household_artifact_settlement() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
CREATE TRIGGER household_artifact_settlement BEFORE UPDATE OR DELETE ON swarm.household_object_artifacts
 FOR EACH ROW EXECUTE FUNCTION swarm.guard_household_artifact_settlement();

-- Reserve rollback (verbatim in supabase/household-storage-reserve/ and
-- deploy/release-proofs/household-storage/; approved release procedure only):
-- DROP TABLE IF EXISTS swarm.household_object_artifacts;
-- DROP FUNCTION IF EXISTS swarm.guard_household_artifact_settlement();
-- DROP TABLE IF EXISTS swarm.household_object_bindings;
-- ALTER TABLE swarm.files DROP COLUMN IF EXISTS household_managed;
-- ALTER TABLE swarm.file_versions DROP CONSTRAINT IF EXISTS household_version_tenant;
