-- Complete inverse of 20260928000003_hm_oauth_store.sql.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT release_proof_outer_transaction_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Refuse a drifted target before touching objects. The rollback only changes
-- an ordinary role that still has the exact constrained attributes installed
-- and proven by the forward migration.
DO $runtime_role_state$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'commonswarm_oauth_runtime'
      AND rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'OAuth rollback refuses an absent or unsafe runtime role';
  END IF;
END
$runtime_role_state$;

REVOKE USAGE ON SCHEMA commonswarm_oauth FROM swarm_read;
ALTER DEFAULT PRIVILEGES FOR ROLE swarm_admin
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
DROP FUNCTION commonswarm_oauth.provider_family_active(text);
DROP FUNCTION commonswarm_oauth.resolve_hosted_grant_status(text);
DROP FUNCTION commonswarm_oauth.hosted_grant_is_active(text, timestamptz, boolean, boolean);
DROP TABLE commonswarm_oauth.consent_orchestration;
DROP TABLE commonswarm_oauth.cimd_cache;
DROP TABLE commonswarm_oauth.interactions;
DROP TABLE commonswarm_oauth.browser_sessions;
DROP TABLE commonswarm_oauth.refresh_family_tombstones;
DROP TABLE commonswarm_oauth.provider_artifacts;
DROP SCHEMA commonswarm_oauth;

DO $database_privilege$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM commonswarm_oauth_runtime', current_database());
END
$database_privilege$;
ALTER ROLE commonswarm_oauth_runtime RESET search_path;

DO $role_dependency_proof$
DECLARE
  runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime';
  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'OAuth rollback expected commonswarm_oauth_runtime to exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = runtime_oid) THEN
    RAISE EXCEPTION 'OAuth rollback refuses role removal: unexpected ownership remains';
  END IF;
  -- DROP ROLE removes memberships itself. Refusing every membership here would
  -- reject the normalized admin-only creator membership installed by the
  -- forward migration, which is also what authorizes an ordinary creator
  -- to perform this rollback.
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
    WHERE refclassid = 'pg_authid'::regclass AND refobjid = runtime_oid
  ) THEN
    RAISE EXCEPTION 'OAuth rollback refuses role removal: grants or dependencies remain';
  END IF;
END
$role_dependency_proof$;

DROP ROLE commonswarm_oauth_runtime;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260928000003';

\ir 20260928000003-rollback-catalog.sql
\if :rollback_ok
  \if :{?release_proof_outer_transaction}
    RELEASE SAVEPOINT release_proof_outer_transaction_guard;
  \else
    COMMIT;
  \endif
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'HM OAuth rollback catalog proof FAILED'; END $fail$;
\endif
