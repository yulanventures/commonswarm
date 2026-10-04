-- Before-apply catalog for 20261003000001: proves the W2 preflight state without invoking a reserve.
-- Derived from 20261003000001-rollback-catalog.sql: every reverse row holds before apply.
-- Shared labels keep the reverse row text byte for byte; tests/admin-release-plan.test.ts checks it.
-- Every row is NULL-safe on a pre-W2 database: no name casts or name-based privilege calls on W2 objects.
WITH checks(label,ok) AS (VALUES
  ('20261003000001-rollback-001-commonswarm_oauth-provider_grant_resources', COALESCE((
    to_regclass('commonswarm_oauth.provider_grant_resources') IS NULL
  ),false)),
  ('20261003000001-rollback-002-commonswarm_oauth-admin_grant_bindings', COALESCE((
    to_regclass('commonswarm_oauth.admin_grant_bindings') IS NULL
  ),false)),
  ('20261003000001-rollback-003-commonswarm_oauth-admin_interactions', COALESCE((
    to_regclass('commonswarm_oauth.admin_interactions') IS NULL
  ),false)),
  ('20261003000001-rollback-004-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    to_regclass('commonswarm_oauth.admin_consent_orchestration') IS NULL
  ),false)),
  ('20261003000001-rollback-005-commonswarm_oauth-guard_provider_resource', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_provider_resource()') IS NULL
  ),false)),
  ('20261003000001-rollback-006-commonswarm_oauth-guard_admin_binding', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_admin_binding()') IS NULL
  ),false)),
  ('20261003000001-rollback-007-commonswarm_oauth-guard_admin_interaction', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_admin_interaction()') IS NULL
  ),false)),
  ('20261003000001-rollback-008-commonswarm_oauth-guard_hosted_resource', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_hosted_resource()') IS NULL
  ),false)),
  ('20261003000001-rollback-009-commonswarm_oauth-provider_grant_resources', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_match' AND NOT tgisinternal)
  ),false)),
  ('20261003000001-rollback-010-commonswarm_oauth-provider_grant_resources', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_immutable' AND NOT tgisinternal)
  ),false)),
  ('20261003000001-rollback-011-commonswarm_oauth-admin_grant_bindings', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000001-rollback-012-commonswarm_oauth-admin_interactions', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_interactions') AND tgname='admin_interaction_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000001-rollback-013-swarm-hosted_mcp_grants', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_grants') AND tgname='hosted_resource_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000001-rollback-014-swarm-admin_events', COALESCE((
    to_regclass('swarm.admin_events') IS NOT NULL
  ),false)),
  ('20261003000001-rollback-015-swarm-admin_grants', COALESCE((
    to_regclass('swarm.admin_grants') IS NOT NULL
  ),false)),
  ('20261003000001-rollback-016-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  ),false)),
  ('20261003000001-rollback-017-commonswarm_oauth-guard_provider_artifact_resource', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()') IS NULL
  ),false)),
  ('20261003000001-rollback-018-commonswarm_oauth-provider_artifacts', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_artifacts') AND tgname='provider_artifact_resource_guard')
  ),false)),
  ('20261003000001-rollback-019-commonswarm_oauth-guard_admin_parent_interaction', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()') IS NULL
  ),false)),
  ('20261003000001-rollback-020-commonswarm_oauth-guard_admin_consent_orchestration', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()') IS NULL
  ),false)),
  ('20261003000001-rollback-021-commonswarm_oauth-interactions', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.interactions') AND tgname='admin_parent_interaction_guard')
  ),false)),
  ('20261003000001-rollback-022-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND tgname='admin_consent_orchestration_guard')
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS before_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS before_ok_checks_ok FROM checks
\gset
\if :before_ok_checks_ok
\else
\warn 20261003000001-before failed checks: :before_ok_failed_checks
\endif
SELECT :'before_ok_checks_ok'::boolean AS before_ok
\gset
