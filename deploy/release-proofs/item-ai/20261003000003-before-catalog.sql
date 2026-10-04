-- Before-apply catalog for 20261003000003: proves the W2 preflight state without invoking a reserve.
-- Derived from 20261003000003-rollback-catalog.sql: every reverse row holds before apply.
-- Shared labels keep the reverse row text byte for byte; tests/admin-release-plan.test.ts checks it.
-- Every row is NULL-safe on a pre-W2 database: no name casts or name-based privilege calls on W2 objects.
WITH checks(label,ok) AS (VALUES
  ('20261003000003-rollback-001-commonswarm_oauth-admin_oauth_audit_daily', COALESCE((
    to_regclass('commonswarm_oauth.admin_oauth_audit_daily') IS NULL
  ),false)),
  ('20261003000003-rollback-002-commonswarm_oauth-admin_security_reason', COALESCE((
    to_regtype('commonswarm_oauth.admin_security_reason') IS NULL
  ),false)),
  ('20261003000003-rollback-003-commonswarm_oauth-guard_audit_daily', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_audit_daily()') IS NULL
  ),false)),
  ('20261003000003-rollback-004-commonswarm_oauth-guard_admin_request_audit', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_admin_request_audit()') IS NULL
  ),false)),
  ('20261003000003-rollback-005-commonswarm_oauth', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='commonswarm_oauth'
    AND p.proname IN ('record_admin_request_audit','record_admin_security_failure'))
  ),false)),
  ('20261003000003-rollback-006-commonswarm_oauth-admin_oauth_audit', COALESCE((
    to_regclass('commonswarm_oauth.admin_oauth_audit') IS NULL
  ),false)),
  ('20261003000003-rollback-007-commonswarm_oauth-admin_access_issuances', COALESCE((
    to_regclass('commonswarm_oauth.admin_access_issuances') IS NULL
  ),false)),
  ('20261003000003-rollback-008-commonswarm_oauth-admin_cutover_state', COALESCE((
    to_regclass('commonswarm_oauth.admin_cutover_state') IS NULL
  ),false)),
  ('20261003000003-rollback-009-commonswarm_oauth-guard_cutover_state', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_cutover_state()') IS NULL
  ),false)),
  ('20261003000003-rollback-010-commonswarm_oauth-guard_oauth_audit', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_oauth_audit()') IS NULL
  ),false)),
  ('20261003000003-rollback-011-commonswarm_oauth-guard_access_issuance', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_access_issuance()') IS NULL
  ),false)),
  ('20261003000003-rollback-012-commonswarm_oauth-admin_access_is_active-text-bytea-text-uuid-uuid-integer-text-text-text-text-timestamptz-timestamptz-text', COALESCE((
    to_regprocedure('commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)') IS NULL
  ),false)),
  ('20261003000003-rollback-013-commonswarm_oauth-admin_grant_family_fence', COALESCE((
    to_regprocedure('commonswarm_oauth.admin_grant_family_fence()') IS NULL
  ),false)),
  ('20261003000003-rollback-014-commonswarm_oauth-tombstone_admin_family', COALESCE((
    to_regprocedure('commonswarm_oauth.tombstone_admin_family()') IS NULL
  ),false)),
  ('20261003000003-rollback-015-commonswarm_oauth-deny_issuer_admin_families', COALESCE((
    to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()') IS NULL
  ),false)),
  ('20261003000003-rollback-016-commonswarm_oauth-guard_legacy_admin_write', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()') IS NULL
  ),false)),
  ('20261003000003-rollback-017-commonswarm_oauth-apply_legacy_admin_fence-text', COALESCE((
    to_regprocedure('commonswarm_oauth.apply_legacy_admin_fence(text)') IS NULL
  ),false)),
  ('20261003000003-rollback-018-swarm_read-admin_oauth_recovery_page-integer', COALESCE((
    to_regprocedure('swarm_read.admin_oauth_recovery_page(integer)') IS NULL
  ),false)),
  ('20261003000003-rollback-019-commonswarm_oauth-admin_oauth_audit', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_append_only' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-020-commonswarm_oauth-admin_access_issuances', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_issuances_append_only' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-021-commonswarm_oauth-admin_cutover_state', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND tgname='admin_cutover_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-022-commonswarm_oauth-admin_oauth_audit', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_binding' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-023-commonswarm_oauth-admin_access_issuances', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_access_issuance_binding' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-024-swarm-admin_grants', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grant_oauth_fence' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-025-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstone_admin_fence' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-026-commonswarm_oauth-issuer_key_denials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_denial_admin_fence' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-027-swarm-admin_credentials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_credentials') AND tgname='admin_credentials_legacy_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-028-swarm-admin_grants', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grants_legacy_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000003-rollback-029-swarm-admin_events', COALESCE((
    to_regclass('swarm.admin_events') IS NOT NULL
  ),false)),
  ('20261003000003-rollback-030-swarm-admin_grants', COALESCE((
    to_regclass('swarm.admin_grants') IS NOT NULL
  ),false)),
  ('20261003000003-rollback-031-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  ),false)),
  ('20261003000003-rollback-032-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstones_append_only')
  ),false)),
  ('20261003000003-rollback-033-commonswarm_oauth-valid_admin_migration_requirements-jsonb', COALESCE((
    to_regprocedure('commonswarm_oauth.valid_admin_migration_requirements(jsonb)') IS NULL
  ),false)),
  ('20261003000003-rollback-034-commonswarm_oauth-binding_terminal_fence', COALESCE((
    to_regprocedure('commonswarm_oauth.binding_terminal_fence()') IS NULL
  ),false)),
  ('20261003000003-rollback-035-commonswarm_oauth-admin_grant_bindings', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_terminal_fence')
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS before_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS before_ok_checks_ok FROM checks
\gset
\if :before_ok_checks_ok
\else
\warn 20261003000003-before failed checks: :before_ok_failed_checks
\endif
SELECT :'before_ok_checks_ok'::boolean AS before_ok
\gset
