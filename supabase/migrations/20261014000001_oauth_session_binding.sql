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
-- Use the owner-role path established in 20260723000001_p1_schema.sql:16.
-- Resolve each owner; the CLI's non-superuser postgres cannot select every
-- GoTrue owner. If SET is unavailable, try the applying role's grant option
-- and let the final effective-privilege check reject a warning-only grant.
DO $owner_grants$
DECLARE
 applying_role name := current_user;
 applying_superuser boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
 can_set_owner boolean;
 item record;
BEGIN
 FOR item IN
  SELECT pg_get_userbyid(n.nspowner) AS owner, format(
   'GRANT USAGE ON SCHEMA %I TO commonswarm_oauth_session_guard', n.nspname
  ) AS command FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('auth', 'commonswarm_oauth')
  UNION ALL
  -- ALTER FUNCTION OWNER requires the new owner to have CREATE in its schema.
  SELECT pg_get_userbyid(n.nspowner), 'GRANT CREATE ON SCHEMA commonswarm_oauth TO commonswarm_oauth_session_guard'
   FROM pg_catalog.pg_namespace n WHERE n.nspname = 'commonswarm_oauth'
  UNION ALL
  SELECT pg_get_userbyid(c.relowner), format(
   'GRANT SELECT (%s) ON auth.%I TO commonswarm_oauth_session_guard', grant_columns, c.relname
  ) FROM (VALUES
   ('sessions', 'id, user_id, not_after'),
   ('mfa_amr_claims', 'session_id, created_at, authentication_method'),
   ('users', 'id, deleted_at, banned_until')
  ) AS required(table_name, grant_columns)
  JOIN pg_catalog.pg_class c ON c.relname = required.table_name
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'auth'
  UNION ALL
  SELECT pg_get_userbyid(c.relowner),
   'GRANT SELECT (gotrue_session_id, user_id, invalidated_at), UPDATE (invalidated_at) ON commonswarm_oauth.browser_sessions TO commonswarm_oauth_session_guard'
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'commonswarm_oauth' AND c.relname = 'browser_sessions'
 LOOP
  can_set_owner := applying_superuser OR pg_has_role(session_user, item.owner, 'SET');
  IF can_set_owner THEN
   EXECUTE format('SET LOCAL ROLE %I', item.owner);
  END IF;
  EXECUTE item.command;
  IF can_set_owner THEN
   EXECUTE format('SET LOCAL ROLE %I', applying_role);
  END IF;
 END LOOP;
END
$owner_grants$;
CREATE POLICY oauth_session_guard_read ON auth.sessions
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
CREATE POLICY oauth_session_guard_read ON auth.users
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
CREATE POLICY oauth_session_guard_read ON auth.mfa_amr_claims
 FOR SELECT TO commonswarm_oauth_session_guard USING (true);
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
-- Apply ACLs as the owners, before removing the applying role's SET path.
DO $function_grants$
DECLARE
 applying_role name := current_user;
 applying_superuser boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
 can_set_owner boolean;
 item record;
BEGIN
 FOR item IN
  SELECT pg_get_userbyid(p.proowner) AS owner, format(
   'REVOKE ALL ON FUNCTION %s FROM PUBLIC', p.oid::regprocedure
  ) AS command FROM pg_catalog.pg_proc p WHERE p.oid IN (
   'commonswarm_oauth.live_gotrue_session(uuid,uuid)'::regprocedure,
   'commonswarm_oauth.invalidate_gotrue_session()'::regprocedure
  )
  UNION ALL
  SELECT pg_get_userbyid(p.proowner),
   'GRANT EXECUTE ON FUNCTION commonswarm_oauth.live_gotrue_session(uuid,uuid) TO commonswarm_oauth_runtime'
   FROM pg_catalog.pg_proc p WHERE p.oid = 'commonswarm_oauth.live_gotrue_session(uuid,uuid)'::regprocedure
  UNION ALL
  SELECT pg_get_userbyid(n.nspowner), 'REVOKE CREATE ON SCHEMA commonswarm_oauth FROM commonswarm_oauth_session_guard'
   FROM pg_catalog.pg_namespace n WHERE n.nspname = 'commonswarm_oauth'
 LOOP
  can_set_owner := applying_superuser OR pg_has_role(session_user, item.owner, 'SET');
  IF can_set_owner THEN
   EXECUTE format('SET LOCAL ROLE %I', item.owner);
  END IF;
  EXECUTE item.command;
  IF can_set_owner THEN
   EXECUTE format('SET LOCAL ROLE %I', applying_role);
  END IF;
 END LOOP;
END
$function_grants$;
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

-- GRANT can warn and change nothing. Verify effective access after all grants
-- and temporary membership/CREATE revocations; a missing privilege aborts apply.
DO $session_privileges$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('commonswarm_oauth_session_guard', 'auth'),
  ('commonswarm_oauth_session_guard', 'commonswarm_oauth'),
  ('commonswarm_oauth_runtime', 'commonswarm_oauth')
 ) AS required(role_name, schema_name) LOOP
  IF has_schema_privilege(item.role_name, item.schema_name, 'USAGE') IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'OAuth session privilege missing: % needs USAGE on schema %', item.role_name, item.schema_name
    USING ERRCODE = '42501';
  END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('auth.sessions', 'id', 'SELECT'),
  ('auth.sessions', 'user_id', 'SELECT'),
  ('auth.sessions', 'not_after', 'SELECT'),
  ('auth.mfa_amr_claims', 'session_id', 'SELECT'),
  ('auth.mfa_amr_claims', 'created_at', 'SELECT'),
  ('auth.mfa_amr_claims', 'authentication_method', 'SELECT'),
  ('auth.users', 'id', 'SELECT'),
  ('auth.users', 'deleted_at', 'SELECT'),
  ('auth.users', 'banned_until', 'SELECT'),
  ('commonswarm_oauth.browser_sessions', 'gotrue_session_id', 'SELECT'),
  ('commonswarm_oauth.browser_sessions', 'user_id', 'SELECT'),
  ('commonswarm_oauth.browser_sessions', 'invalidated_at', 'SELECT'),
  ('commonswarm_oauth.browser_sessions', 'invalidated_at', 'UPDATE')
 ) AS required(table_name, column_name, privilege) LOOP
  IF has_column_privilege('commonswarm_oauth_session_guard', item.table_name, item.column_name, item.privilege)
    IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'OAuth session privilege missing: guard needs % on %.%', item.privilege, item.table_name, item.column_name
    USING ERRCODE = '42501';
  END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('commonswarm_oauth.live_gotrue_session(uuid,uuid)'),
  ('commonswarm_oauth.invalidate_gotrue_session()')
 ) AS guarded(function_name) LOOP
  IF has_function_privilege('public', item.function_name, 'EXECUTE') THEN
   RAISE EXCEPTION 'OAuth session guard function exposed to PUBLIC: %', item.function_name
    USING ERRCODE = '42501';
  END IF;
 END LOOP;
 IF has_function_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth.live_gotrue_session(uuid,uuid)', 'EXECUTE')
   IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'OAuth session privilege missing: runtime needs EXECUTE on live_gotrue_session'
   USING ERRCODE = '42501';
 END IF;
 IF has_schema_privilege('commonswarm_oauth_session_guard', 'commonswarm_oauth', 'CREATE') THEN
  RAISE EXCEPTION 'OAuth session guard still has temporary CREATE privilege' USING ERRCODE = '42501';
 END IF;
END
$session_privileges$;
