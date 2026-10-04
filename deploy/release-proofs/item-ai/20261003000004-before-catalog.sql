-- Before-apply catalog for 20261003000004: proves the W2 preflight state without invoking a reserve.
-- Derived from 20261003000004-rollback-catalog.sql: every reverse row holds before apply (privilege rows are NULL-safe joins).
-- Shared labels keep the reverse row text byte for byte; tests/admin-release-plan.test.ts checks it.
-- Every row is NULL-safe on a pre-W2 database: no name casts or name-based privilege calls on W2 objects.
WITH checks(label,ok) AS (VALUES
  ('20261003000004-rollback-001-commonswarm_ops-migration_checksums', COALESCE((
    to_regclass('commonswarm_ops.migration_checksums') IS NULL
  ),false)),
  ('20261003000004-rollback-002-commonswarm_ops-migration_checksum_failures', COALESCE((
    to_regprocedure('commonswarm_ops.migration_checksum_failures()') IS NULL
  ),false)),
  ('20261003000004-rollback-003-commonswarm_ops-migration_checksum_failures-jsonb', COALESCE((
    to_regprocedure('commonswarm_ops.migration_checksum_failures(jsonb)') IS NULL
  ),false)),
  ('20261003000004-rollback-004-commonswarm_ops-migration_ledger_versions', COALESCE((
    to_regprocedure('commonswarm_ops.migration_ledger_versions()') IS NULL
  ),false)),
  ('20261003000004-rollback-005-commonswarm_ops-guard_migration_checksums', COALESCE((
    to_regprocedure('commonswarm_ops.guard_migration_checksums()') IS NULL
  ),false)),
  ('20261003000004-rollback-006-supabase_migrations-schema_migrations', COALESCE((
    to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
  ),false)),
  ('20261003000004-rollback-007-catalog-USAGE', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.rolname='commonswarm_oauth_runtime' WHERE n.nspname='commonswarm_ops' AND has_schema_privilege(r.oid,n.oid,'USAGE'))
  ),false)),
  ('20261003000004-rollback-008-catalog-USAGE', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.rolname='swarm_command' WHERE n.nspname='commonswarm_ops' AND has_schema_privilege(r.oid,n.oid,'USAGE'))
  ),false)),
  ('20261003000004-rollback-009-catalog-USAGE', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.rolname='commonswarm_admin_release' WHERE n.nspname='commonswarm_ops' AND has_schema_privilege(r.oid,n.oid,'USAGE'))
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS before_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS before_ok_checks_ok FROM checks
\gset
\if :before_ok_checks_ok
\else
\warn 20261003000004-before failed checks: :before_ok_failed_checks
\endif
SELECT :'before_ok_checks_ok'::boolean AS before_ok
\gset
