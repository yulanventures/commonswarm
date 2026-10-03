-- Evidence-preserving reverse proof: the empty schema may predate this migration.
-- Stable labels only: no row values or credential data in diagnostics.
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
    NOT has_schema_privilege('commonswarm_oauth_runtime','commonswarm_ops','USAGE')
  ),false)),
  ('20261003000004-rollback-008-catalog-USAGE', COALESCE((
    NOT has_schema_privilege('swarm_command','commonswarm_ops','USAGE')
  ),false)),
  ('20261003000004-rollback-009-catalog-USAGE', COALESCE((
    NOT has_schema_privilege('commonswarm_admin_release','commonswarm_ops','USAGE')
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS rollback_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS rollback_ok_checks_ok FROM checks
\gset
\if :rollback_ok_checks_ok
\else
\warn 20261003000004-rollback failed checks: :rollback_ok_failed_checks
\endif
SELECT :'rollback_ok_checks_ok'::boolean AS rollback_ok
\gset
