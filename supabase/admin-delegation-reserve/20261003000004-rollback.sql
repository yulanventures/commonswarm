-- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- Retain all release/backfill evidence; an occupied ledger forbids this inverse.
DO $reserve$ BEGIN
  IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksums) THEN
    RAISE EXCEPTION 'reserve rollback refused: migration checksum evidence' USING ERRCODE='55000';
  END IF;
END $reserve$;
DROP TABLE commonswarm_ops.migration_checksums;
DROP FUNCTION commonswarm_ops.migration_checksum_failures();
DROP FUNCTION commonswarm_ops.guard_migration_checksums();
REVOKE USAGE ON SCHEMA commonswarm_ops FROM commonswarm_admin_release,commonswarm_oauth_runtime,swarm_command;
-- Retain the possibly pre-existing schema and owner's migration-ledger read ACL.
