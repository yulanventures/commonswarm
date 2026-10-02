-- Data-free reverse catalog for 20261003000002. History is retained.
SELECT COALESCE((
  to_regclass('commonswarm_oauth.admin_verified_clients') IS NULL
  AND to_regclass('commonswarm_oauth.admin_client_owner_approvals') IS NULL
  AND to_regclass('commonswarm_oauth.dpop_proof_replays') IS NULL
  AND to_regclass('commonswarm_oauth.dpop_nonces') IS NULL
  AND to_regclass('commonswarm_oauth.issuer_key_denials') IS NULL
  AND to_regprocedure('commonswarm_oauth.register_dpop_nonce(bytea,text,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.resolve_provider_grant_status(text,uuid,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea)') IS NULL
  AND to_regprocedure('commonswarm_oauth.purge_expired_dpop(integer)') IS NULL
  AND to_regprocedure('commonswarm_oauth.issuer_key_allowed(text,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()') IS NULL
  AND to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)') IS NULL
  AND to_regprocedure('commonswarm_oauth.resolve_admin_grant_status(text,uuid,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.fence_admin_family(text,uuid,text,text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_verified_client()') IS NULL
  AND to_regprocedure('commonswarm_oauth.guard_owner_approval()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denials_append_only' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denial_lock' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND tgname='admin_verification_guard' AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND tgname='admin_owner_approval_guard' AND NOT tgisinternal)
  AND to_regclass('swarm.admin_events') IS NOT NULL
  AND to_regclass('swarm.admin_grants') IS NOT NULL
  AND to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NOT NULL
  -- The reserve keeps constrained operator roles and safe creator edges.
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))=3
  AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
    AND (rolsuper OR rolcanlogin OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    WHERE parent.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
      AND (NOT m.admin_option OR m.inherit_option OR m.set_option))
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))
),false) AS rollback_ok
\gset
