DROP TABLE IF EXISTS swarm.household_object_artifacts;
DROP FUNCTION IF EXISTS swarm.guard_household_artifact_settlement();
DROP TABLE IF EXISTS swarm.household_object_bindings;
ALTER TABLE swarm.files DROP COLUMN IF EXISTS household_managed;
ALTER TABLE swarm.file_versions DROP CONSTRAINT IF EXISTS household_version_tenant;
