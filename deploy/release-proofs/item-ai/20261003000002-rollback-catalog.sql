-- Data-free reverse catalog for 20261003000002. History is retained.
-- Stable labels only: no row values or credential data in diagnostics.
WITH checks(label,ok) AS (VALUES
  ('20261003000002-rollback-001-commonswarm_oauth-admin_verified_clients', COALESCE((
    to_regclass('commonswarm_oauth.admin_verified_clients') IS NULL
  ),false)),
  ('20261003000002-rollback-002-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    to_regclass('commonswarm_oauth.admin_client_owner_approvals') IS NULL
  ),false)),
  ('20261003000002-rollback-003-commonswarm_oauth-dpop_proof_replays', COALESCE((
    to_regclass('commonswarm_oauth.dpop_proof_replays') IS NULL
  ),false)),
  ('20261003000002-rollback-004-commonswarm_oauth-dpop_nonces', COALESCE((
    to_regclass('commonswarm_oauth.dpop_nonces') IS NULL
  ),false)),
  ('20261003000002-rollback-005-commonswarm_oauth-issuer_key_denials', COALESCE((
    to_regclass('commonswarm_oauth.issuer_key_denials') IS NULL
  ),false)),
  ('20261003000002-rollback-006-commonswarm_oauth-register_dpop_nonce-bytea-text-text', COALESCE((
    to_regprocedure('commonswarm_oauth.register_dpop_nonce(bytea,text,text)') IS NULL
  ),false)),
  ('20261003000002-rollback-007-commonswarm_oauth-resolve_provider_grant_status-text-uuid-text', COALESCE((
    to_regprocedure('commonswarm_oauth.resolve_provider_grant_status(text,uuid,text)') IS NULL
  ),false)),
  ('20261003000002-rollback-008-commonswarm_oauth-dpop_admission_status', COALESCE((
    to_regtype('commonswarm_oauth.dpop_admission_status') IS NULL
  ),false)),
  ('20261003000002-rollback-009-commonswarm_oauth-lock_admin_consent_policy-text-integer-uuid', COALESCE((
    to_regprocedure('commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid)') IS NULL
  ),false)),
  ('20261003000002-rollback-010-commonswarm_oauth-admit_dpop_proof-text-text-text-bigint-bytea', COALESCE((
    to_regprocedure('commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea)') IS NULL
  ),false)),
  ('20261003000002-rollback-011-commonswarm_oauth-purge_expired_dpop-integer', COALESCE((
    to_regprocedure('commonswarm_oauth.purge_expired_dpop(integer)') IS NULL
  ),false)),
  ('20261003000002-rollback-012-commonswarm_oauth-issuer_key_allowed-text-text', COALESCE((
    to_regprocedure('commonswarm_oauth.issuer_key_allowed(text,text)') IS NULL
  ),false)),
  ('20261003000002-rollback-013-commonswarm_oauth-lock_issuer_key_denial', COALESCE((
    to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()') IS NULL
  ),false)),
  ('20261003000002-rollback-014-commonswarm_oauth-lock_admin_client_verification-text-integer', COALESCE((
    to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)') IS NULL
  ),false)),
  ('20261003000002-rollback-015-commonswarm_oauth-resolve_admin_grant_status-text-uuid-text', COALESCE((
    to_regprocedure('commonswarm_oauth.resolve_admin_grant_status(text,uuid,text)') IS NULL
  ),false)),
  ('20261003000002-rollback-016-commonswarm_oauth-fence_admin_family-text-uuid-text-text', COALESCE((
    to_regprocedure('commonswarm_oauth.fence_admin_family(text,uuid,text,text)') IS NULL
  ),false)),
  ('20261003000002-rollback-017-commonswarm_oauth-guard_verified_client', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_verified_client()') IS NULL
  ),false)),
  ('20261003000002-rollback-018-commonswarm_oauth-guard_owner_approval', COALESCE((
    to_regprocedure('commonswarm_oauth.guard_owner_approval()') IS NULL
  ),false)),
  ('20261003000002-rollback-019-commonswarm_oauth-issuer_key_denials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denials_append_only' AND NOT tgisinternal)
  ),false)),
  ('20261003000002-rollback-020-commonswarm_oauth-issuer_key_denials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denial_lock' AND NOT tgisinternal)
  ),false)),
  ('20261003000002-rollback-021-commonswarm_oauth-admin_verified_clients', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND tgname='admin_verification_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000002-rollback-022-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND tgname='admin_owner_approval_guard' AND NOT tgisinternal)
  ),false)),
  ('20261003000002-rollback-023-swarm-admin_events', COALESCE((
    to_regclass('swarm.admin_events') IS NOT NULL
  ),false)),
  ('20261003000002-rollback-024-swarm-admin_grants', COALESCE((
    to_regclass('swarm.admin_grants') IS NOT NULL
  ),false)),
  ('20261003000002-rollback-025-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  -- The reserve keeps constrained operator roles and safe creator edges.
  ),false)),
  ('20261003000002-rollback-026-commonswarm_admin_issuer', COALESCE((
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_admin_issuer' AND rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  ),false)),
  ('20261003000002-rollback-027-issuer-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole)
  ),false)),
  ('20261003000002-rollback-028-issuer-direct-privileges-and-ownership', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
    AND refobjid='commonswarm_admin_issuer'::regrole AND deptype IN ('a','o'))
  ),false)),
  ('20261003000002-rollback-029-issuer-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='commonswarm_admin_issuer'::regrole
    AND (NOT admin_option OR inherit_option OR set_option))
  ),false)),
  ('20261003000002-rollback-030-catalog', COALESCE((
    (SELECT count(*) FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))=3
  ),false)),
  ('20261003000002-rollback-031-catalog', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
    AND (rolsuper OR rolcanlogin OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  ),false)),
  ('20261003000002-rollback-032-policy-role-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    WHERE parent.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
      AND (NOT m.admin_option OR m.inherit_option OR m.set_option))
  ),false)),
  ('20261003000002-rollback-033-policy-role-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS rollback_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS rollback_ok_checks_ok FROM checks
\gset
\if :rollback_ok_checks_ok
\else
\warn 20261003000002-rollback failed checks: :rollback_ok_failed_checks
\endif
SELECT :'rollback_ok_checks_ok'::boolean AS rollback_ok
\gset
