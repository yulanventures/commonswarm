-- Data-free reverse catalog for 20261003000001. History is retained.
SELECT COALESCE((
  to_regclass('commonswarm_oauth.provider_grant_resources') IS NULL
  AND to_regclass('commonswarm_oauth.admin_grant_bindings') IS NULL
  AND to_regclass('commonswarm_oauth.admin_interactions') IS NULL
  AND to_regclass('commonswarm_oauth.admin_consent_orchestration') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_provider_resource()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_admin_binding()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_admin_interaction()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_hosted_resource()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_match' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_immutable' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_guard' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_interactions') AND tgname='admin_interaction_guard' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_grants') AND tgname='hosted_resource_guard' AND NOT tgisinternal)
  AND to_regclass('swarm.admin_events') IS NOT NULL
  AND to_regclass('swarm.admin_grants') IS NOT NULL
  AND to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  AND to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_artifacts') AND tgname='provider_artifact_resource_guard')
  AND to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.interactions') AND tgname='admin_parent_interaction_guard')
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND tgname='admin_consent_orchestration_guard')
),false) AS rollback_ok
\gset
