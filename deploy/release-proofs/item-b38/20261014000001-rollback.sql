-- RESERVE ONLY. Complete schema inverse of 20261014000001_oauth_session_binding.sql.
-- Use this reviewed file verbatim. Stop the dependent OAuth code first.
-- Order: 20261014000002-rollback.sql, this file, then any item-hm rollback.
-- RELEASE-TO-BOX.md:2214-2221 requires a reviewed down-migration and an
-- explicit HezLead decision; :1567 supplies ON_ERROR_STOP.
-- The forward UPDATE invalidated old logins. Do not revive those sessions:
-- their prior invalidated_at values cannot be recovered by a schema inverse.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT release_proof_outer_transaction_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

\ir 20261014000001-catalog.sql
\if :catalog_ok
\else
DO $fail$ BEGIN RAISE EXCEPTION 'B38 session rollback requires the complete forward catalog'; END $fail$;
\endif
DO $dependency$
BEGIN
  IF to_regclass('commonswarm_oauth.finish_records') IS NOT NULL THEN
    RAISE EXCEPTION 'run 20261014000002-rollback.sql before the session rollback';
  END IF;
END
$dependency$;

-- Remove the trigger before its function and its narrow auth/AS policies.
DROP TRIGGER commonswarm_oauth_session_revocation ON auth.sessions;
DROP FUNCTION commonswarm_oauth.invalidate_gotrue_session();
DROP FUNCTION commonswarm_oauth.live_gotrue_session(uuid, uuid);
DROP POLICY oauth_session_guard_read ON auth.sessions;
DROP POLICY oauth_session_guard_read ON auth.users;
DROP POLICY oauth_session_guard_read ON auth.mfa_amr_claims;
DROP POLICY oauth_guard_revoke ON commonswarm_oauth.browser_sessions;
DROP POLICY oauth_guard_read ON commonswarm_oauth.browser_sessions;

-- A REVOKE issued by an administrator can otherwise target the wrong ACL
-- grantor. Assume each recorded grantor, as in item-hm's database inverse.
-- The forward catalog above pins the exact USAGE and column-only grant set;
-- no DROP OWNED, CASCADE or unrelated auth ACL changes are permitted.
DO $guard_grants$
DECLARE
  applying_role name := current_user;
  guard_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_session_guard');
  item record;
BEGIN
  FOR item IN
    SELECT pg_get_userbyid(a.grantor) AS grantor, format(
      'REVOKE %s ON SCHEMA %I FROM commonswarm_oauth_session_guard', a.privilege_type, n.nspname
    ) AS command
    FROM pg_namespace AS n CROSS JOIN LATERAL aclexplode(n.nspacl) AS a
    WHERE a.grantee = guard_oid AND n.nspname IN ('auth', 'commonswarm_oauth')
    UNION ALL
    SELECT pg_get_userbyid(a.grantor), format(
      'REVOKE %s (%I) ON TABLE %I.%I FROM commonswarm_oauth_session_guard',
      a.privilege_type, col.attname, n.nspname, c.relname
    )
    FROM pg_attribute AS col JOIN pg_class AS c ON c.oid = col.attrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(col.attacl) AS a
    WHERE a.grantee = guard_oid AND col.attnum > 0 AND NOT col.attisdropped
      AND ((n.nspname = 'auth' AND c.relname IN ('sessions', 'users', 'mfa_amr_claims'))
        OR (n.nspname = 'commonswarm_oauth' AND c.relname = 'browser_sessions'))
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', item.grantor);
    EXECUTE item.command;
    EXECUTE format('SET LOCAL ROLE %I', applying_role);
  END LOOP;
END
$guard_grants$;

DROP INDEX commonswarm_oauth.browser_sessions_gotrue_idx;
ALTER TABLE commonswarm_oauth.browser_sessions DROP COLUMN gotrue_session_id;

DO $guard_memberships$
DECLARE
  applying_role name := current_user;
  item record;
BEGIN
  FOR item IN
    SELECT pg_get_userbyid(m.grantor) AS grantor
    FROM pg_auth_members AS m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_session_guard')
      AND m.member = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', item.grantor);
    EXECUTE 'REVOKE commonswarm_oauth_session_guard FROM swarm_admin';
    EXECUTE format('SET LOCAL ROLE %I', applying_role);
  END LOOP;
END
$guard_memberships$;
DO $role_dependency_proof$
DECLARE
  guard_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_session_guard');
BEGIN
  IF guard_oid IS NULL OR EXISTS (
    SELECT 1 FROM pg_shdepend
    WHERE refclassid = 'pg_authid'::regclass AND refobjid = guard_oid
  ) THEN
    RAISE EXCEPTION 'B38 session rollback refuses role removal: grants or dependencies remain';
  END IF;
END
$role_dependency_proof$;
-- DROP ROLE removes the remaining ADMIN-only creator memberships. Retain
-- those until this statement so an ordinary creator can still drop its role.
-- A role used by another database is refused by the dependency proof above.
DROP ROLE commonswarm_oauth_session_guard;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261014000001';

\ir 20261014000001-rollback-catalog.sql
\if :rollback_ok
  \if :{?release_proof_outer_transaction}
    RELEASE SAVEPOINT release_proof_outer_transaction_guard;
  \else
    COMMIT;
  \endif
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'B38 session rollback catalog proof FAILED'; END $fail$;
\endif
