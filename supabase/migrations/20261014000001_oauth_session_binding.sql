-- Do not release P1 alone: sign-in fails closed until P8 passes runtimePool and P2 stores gotrue_session_id.
-- Bind AS logins to GoTrue sessions and original authentication evidence.
-- Inputs: verified session/user UUIDs and auth session removal events.
-- Outputs: narrow live status and durable AS invalidation; never expose tokens.
-- Logout event and auth-time stability MUST pass the box-matched CI gate.
ALTER TABLE commonswarm_oauth.browser_sessions ADD COLUMN gotrue_session_id uuid;
UPDATE commonswarm_oauth.browser_sessions SET invalidated_at = statement_timestamp()
 WHERE user_id IS NOT NULL AND invalidated_at IS NULL;
CREATE INDEX browser_sessions_gotrue_idx
 ON commonswarm_oauth.browser_sessions(gotrue_session_id) WHERE gotrue_session_id IS NOT NULL;

-- Cluster roles survive database resets; follow 20260928000003_hm_oauth_store.sql.
DO $role$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commonswarm_oauth_session_guard') THEN
  SET LOCAL createrole_self_grant = '';
  CREATE ROLE commonswarm_oauth_session_guard NOLOGIN NOINHERIT;
 END IF;
 -- Follow 20260723000001_p1_schema.sql:16 for non-superuser owner changes.
 IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
  EXECUTE format('GRANT commonswarm_oauth_session_guard TO %I WITH INHERIT TRUE, SET TRUE', current_user);
 END IF;
END
$role$;
-- DDL snapshots are restored as postgres, which can SET ROLE swarm_admin.
-- Keep that owner-role path usable after the applying principal's temporary
-- grant is removed; do not inherit the guard's narrow auth-table privileges.
GRANT commonswarm_oauth_session_guard TO swarm_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA auth, commonswarm_oauth TO commonswarm_oauth_session_guard;
-- ALTER FUNCTION OWNER requires the new owner to have CREATE in its schema.
GRANT CREATE ON SCHEMA commonswarm_oauth TO commonswarm_oauth_session_guard;
GRANT SELECT (id, user_id, not_after) ON auth.sessions TO commonswarm_oauth_session_guard;
GRANT SELECT (session_id, created_at, authentication_method) ON auth.mfa_amr_claims TO commonswarm_oauth_session_guard;
GRANT SELECT (id, deleted_at, banned_until) ON auth.users TO commonswarm_oauth_session_guard;
CREATE POLICY oauth_session_guard_read ON auth.sessions
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
CREATE POLICY oauth_session_guard_read ON auth.users
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
CREATE POLICY oauth_session_guard_read ON auth.mfa_amr_claims
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
GRANT SELECT (gotrue_session_id, user_id, invalidated_at), UPDATE (invalidated_at)
 ON commonswarm_oauth.browser_sessions TO commonswarm_oauth_session_guard;
CREATE POLICY oauth_guard_revoke ON commonswarm_oauth.browser_sessions
 FOR UPDATE TO commonswarm_oauth_session_guard USING (true) WITH CHECK (true);
-- UPDATE with a WHERE clause also requires a SELECT policy for the guard.
CREATE POLICY oauth_guard_read ON commonswarm_oauth.browser_sessions FOR SELECT TO commonswarm_oauth_session_guard USING (true);

CREATE FUNCTION commonswarm_oauth.live_gotrue_session(wanted_session uuid, wanted_user uuid)
RETURNS TABLE(session_id uuid, user_id uuid, authenticated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT s.id, s.user_id, min(a.created_at)::timestamptz
 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
 JOIN auth.mfa_amr_claims a ON a.session_id = s.id
 WHERE s.id = wanted_session AND s.user_id = wanted_user
   AND (s.not_after IS NULL OR s.not_after > statement_timestamp())
   AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= statement_timestamp())
   AND a.authentication_method IN ('oauth', 'password', 'otp')
 GROUP BY s.id, s.user_id
$$;
ALTER FUNCTION commonswarm_oauth.live_gotrue_session(uuid, uuid) OWNER TO commonswarm_oauth_session_guard;
REVOKE ALL ON FUNCTION commonswarm_oauth.live_gotrue_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.live_gotrue_session(uuid, uuid) TO commonswarm_oauth_runtime;

-- GoTrue v2.197.0 global logout must delete every affected auth.sessions row.
-- Future not_after updates stay live; expiry is checked by live_gotrue_session.
CREATE FUNCTION commonswarm_oauth.invalidate_gotrue_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 UPDATE commonswarm_oauth.browser_sessions SET invalidated_at = statement_timestamp()
 WHERE gotrue_session_id = OLD.id AND user_id = OLD.user_id AND invalidated_at IS NULL;
 RETURN NULL;
END
$$;
ALTER FUNCTION commonswarm_oauth.invalidate_gotrue_session() OWNER TO commonswarm_oauth_session_guard;
REVOKE CREATE ON SCHEMA commonswarm_oauth FROM commonswarm_oauth_session_guard;
REVOKE ALL ON FUNCTION commonswarm_oauth.invalidate_gotrue_session() FROM PUBLIC;
CREATE TRIGGER commonswarm_oauth_session_revocation
 AFTER DELETE ON auth.sessions
 FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.invalidate_gotrue_session();

-- Restore the creator's ADMIN-only membership (hm_oauth_store.sql:48-95).
-- Keeping ADMIN permits another database in this cluster to apply the migration.
DO $role$
BEGIN
 IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
  EXECUTE format('REVOKE INHERIT OPTION FOR commonswarm_oauth_session_guard FROM %I', current_user);
  EXECUTE format('REVOKE SET OPTION FOR commonswarm_oauth_session_guard FROM %I', current_user);
 END IF;
END
$role$;
