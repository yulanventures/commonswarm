-- Data-free reverse catalog for 20261003000003. History is retained.
SELECT COALESCE((
  to_regclass('commonswarm_oauth.admin_oauth_audit') IS NULL
  AND to_regclass('commonswarm_oauth.admin_access_issuances') IS NULL
  AND to_regclass('commonswarm_oauth.admin_cutover_state') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_cutover_state()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_oauth_audit()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_access_issuance()') IS NULL
  AND to_regprocedure('commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.admin_grant_family_fence()') IS NULL
  AND to_regprocedure('commonswarm_oauth.tombstone_admin_family()') IS NULL
  AND to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()') IS NULL
  AND to_regprocedure('commonswarm_oauth.apply_legacy_admin_fence(text)') IS NULL
  AND to_regprocedure('swarm_read.admin_oauth_recovery_page(integer)') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_append_only' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_issuances_append_only' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND tgname='admin_cutover_guard' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_binding' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_access_issuance_binding' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grant_oauth_fence' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstone_admin_fence' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_denial_admin_fence' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_credentials') AND tgname='admin_credentials_legacy_guard' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grants_legacy_guard' AND NOT tgisinternal)
  AND to_regclass('swarm.admin_events') IS NOT NULL
  AND to_regclass('swarm.admin_grants') IS NOT NULL
  AND to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstones_append_only')
  AND to_regprocedure('commonswarm_oauth.valid_admin_migration_requirements(jsonb)') IS NULL
  AND to_regprocedure('commonswarm_oauth.binding_terminal_fence()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_terminal_fence')
),false) AS rollback_ok
\gset
