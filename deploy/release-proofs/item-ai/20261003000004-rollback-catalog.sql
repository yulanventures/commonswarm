-- Evidence-preserving reverse proof: the empty schema may predate this migration.
SELECT COALESCE((to_regclass('commonswarm_ops.migration_checksums') IS NULL
  AND to_regprocedure('commonswarm_ops.migration_checksum_failures()') IS NULL
  AND to_regprocedure('commonswarm_ops.migration_checksum_failures(jsonb)') IS NULL
  AND to_regprocedure('commonswarm_ops.migration_ledger_versions()') IS NULL
  AND to_regprocedure('commonswarm_ops.guard_migration_checksums()') IS NULL
  AND to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
  AND NOT has_schema_privilege('commonswarm_oauth_runtime','commonswarm_ops','USAGE')
  AND NOT has_schema_privilege('swarm_command','commonswarm_ops','USAGE')
  AND NOT has_schema_privilege('commonswarm_admin_release','commonswarm_ops','USAGE')
),false) AS rollback_ok
\gset
