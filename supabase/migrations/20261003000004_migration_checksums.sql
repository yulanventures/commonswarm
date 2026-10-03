-- D2: independent release checksum evidence, applied in the next schema window.
-- No backfill or activation occurs here. The release worker inserts each hash
-- in the SAME transaction as its supabase_migrations.schema_migrations insert.
-- Existing versions are backfilled from files at the actually released SHA,
-- with source='backfill'; expected activation hashes are never observed evidence.
CREATE SCHEMA IF NOT EXISTS commonswarm_ops AUTHORIZATION swarm_admin;
DO $schema$ BEGIN
  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='commonswarm_ops')<>'swarm_admin'::regrole THEN
    RAISE EXCEPTION 'commonswarm_ops has unexpected owner';
  END IF;
END $schema$;
REVOKE ALL ON SCHEMA commonswarm_ops FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
GRANT USAGE ON SCHEMA commonswarm_ops TO commonswarm_admin_release,commonswarm_oauth_runtime,swarm_command;
CREATE TABLE commonswarm_ops.migration_checksums (
  version text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('release','backfill')),
  released_sha text NOT NULL CHECK (released_sha ~ '^[0-9a-f]{40}$')
);
ALTER TABLE commonswarm_ops.migration_checksums OWNER TO swarm_admin;
ALTER TABLE commonswarm_ops.migration_checksums ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commonswarm_ops.migration_checksums FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
CREATE POLICY checksum_release_insert ON commonswarm_ops.migration_checksums FOR INSERT TO commonswarm_admin_release WITH CHECK(true);
CREATE POLICY checksum_runtime_read ON commonswarm_ops.migration_checksums FOR SELECT TO commonswarm_oauth_runtime,swarm_command USING(true);
GRANT INSERT ON commonswarm_ops.migration_checksums TO commonswarm_admin_release;
GRANT SELECT ON commonswarm_ops.migration_checksums TO commonswarm_oauth_runtime,swarm_command;

CREATE FUNCTION commonswarm_ops.guard_migration_checksums() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  -- Invoker security: even a mistaken non-owner UPDATE/DELETE grant cannot
  -- rewrite evidence. Only the table owner has the administrative exception.
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
    WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'migration checksums are append-only' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION commonswarm_ops.guard_migration_checksums() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_ops.guard_migration_checksums() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
CREATE TRIGGER migration_checksums_append_only BEFORE UPDATE OR DELETE ON commonswarm_ops.migration_checksums
  FOR EACH ROW EXECUTE FUNCTION commonswarm_ops.guard_migration_checksums();

-- Required identities are database-owned, never a caller-selected subset.
-- Expected reviewed hashes come from release-role-owned admin_cutover_state,
-- written with the activation measurement while issuance is closed. They are
-- distinct from the independently recorded release/backfill checksum evidence.
-- Include this gate migration itself: its installed function is insufficient
-- without proof that M4 was applied and recorded at the reviewed checksum.
-- The release session (deploy/RELEASE-TO-BOX.md, runbook-17/27) already
-- reads/writes the live ledger. It need not own it or hold GRANT OPTION.
-- Keep this narrow reader owned by that applying principal, rather than
-- granting ledger access to swarm_admin or any application runtime.
DO $ledger_reader$ BEGIN
  IF NOT has_schema_privilege(current_user,'supabase_migrations','USAGE')
    OR NOT has_table_privilege(current_user,'supabase_migrations.schema_migrations','SELECT') THEN
    RAISE EXCEPTION 'migration principal must be able to read the live ledger' USING ERRCODE='42501';
  END IF;
END $ledger_reader$;
CREATE FUNCTION commonswarm_ops.migration_ledger_versions() RETURNS TABLE(version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT l.version::text FROM supabase_migrations.schema_migrations l;
$fn$;
REVOKE ALL ON FUNCTION commonswarm_ops.migration_ledger_versions() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
GRANT EXECUTE ON FUNCTION commonswarm_ops.migration_ledger_versions() TO swarm_admin;
CREATE FUNCTION commonswarm_ops.migration_checksum_failures()
RETURNS TABLE(version text,required_sha256 text,recorded_sha256 text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  RETURN QUERY
    WITH required(version) AS (VALUES
      ('20261001000001'),('20261001000002'),('20261001000003'),('20261001000004'),('20261001000005'),
      ('20260928000003'),('20261002000001'),
      ('20261003000001'),('20261003000002'),('20261003000003'),('20261003000004')),
    expected AS (SELECT s.required_migrations FROM commonswarm_oauth.admin_cutover_state s WHERE s.singleton)
    SELECT r.version,e.required_migrations->>r.version,c.sha256,
      CASE WHEN l.version IS NULL THEN 'missing_ledger'
           WHEN c.version IS NULL THEN 'missing_checksum'
           WHEN e.required_migrations->>r.version IS NULL THEN 'missing_expected'
           ELSE 'checksum_mismatch' END
    FROM required r
    LEFT JOIN expected e ON true
    LEFT JOIN commonswarm_ops.migration_checksums c ON c.version=r.version
    LEFT JOIN commonswarm_ops.migration_ledger_versions() l ON l.version=r.version
    WHERE l.version IS NULL OR c.version IS NULL
      OR e.required_migrations->>r.version IS NULL
      OR c.sha256 IS DISTINCT FROM e.required_migrations->>r.version
    ORDER BY r.version;
END $fn$;
ALTER FUNCTION commonswarm_ops.migration_checksum_failures() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_ops.migration_checksum_failures() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
GRANT EXECUTE ON FUNCTION commonswarm_ops.migration_checksum_failures() TO commonswarm_oauth_runtime,swarm_command;

-- Reserve rollback (verbatim sibling reserve; data-free only):
-- -- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- -- Retain all release/backfill evidence; an occupied ledger forbids this inverse.
-- DO $reserve$ BEGIN
--   IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksums) THEN
--     RAISE EXCEPTION 'reserve rollback refused: migration checksum evidence' USING ERRCODE='55000';
--   END IF;
-- END $reserve$;
-- DROP TABLE commonswarm_ops.migration_checksums;
-- DROP FUNCTION commonswarm_ops.migration_checksum_failures();
-- DROP FUNCTION commonswarm_ops.migration_ledger_versions();
-- DROP FUNCTION commonswarm_ops.guard_migration_checksums();
-- REVOKE USAGE ON SCHEMA commonswarm_ops FROM commonswarm_admin_release,commonswarm_oauth_runtime,swarm_command;
-- -- Retain the possibly pre-existing schema and all pre-existing migration-ledger ACLs.
