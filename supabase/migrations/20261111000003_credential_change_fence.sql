-- CS-E04 (option 3, a scoped partial): a person's credential change revokes every human session,
-- and every human surface checks that its session is still live.
--
-- A credential change is a committed auth.users UPDATE, for a confirmed account, where
-- encrypted_password or email changes. That covers a password change, a password set after
-- recovery, a first password, and the applied email change. Production GoTrue has DB encryption
-- off (GOTRUE_SECURITY_DB_ENCRYPTION_ENCRYPT is absent; HezOps attestation 2026-11-11), so
-- sign-in never re-encrypts a hash. If it is ever turned on, re-encryption at sign-in would also
-- sign everyone out (conservative, accepted).
--
-- On a change:
-- - BEFORE: the user row's pending verification hashes are cleared in NEW;
-- - AFTER (immediate): the per-user fence lock is taken exclusively, the change is recorded, and
--   the user's sessions (refresh tokens and AMR claims cascade), flow states and one-time tokens
--   are deleted;
-- - AFTER (deferred, at commit): the same deletes again, which catches a session GoTrue issues in
--   the same transaction (the email-change verify).
--
-- One liveness rule, from the verified request claims: role authenticated, a UUID sub and
-- session_id, an auth.sessions row with that id and user_id inside not_after, and a user that is
-- neither deleted nor banned. It gates PostgREST (db-pre-request), the two member Realtime
-- policies, and, through admit_human_session, command and OAuth transactions.
--
-- STILL OPEN (CS-E04): GoTrue verifies a password, flow state or OTP before the transaction that
-- issues the session, so an old proof verified just before a change can still mint a live
-- session just after it, and a provider flow not yet bound to the user is not deleted.

-- Cluster roles survive database resets; follow 20261014000001_oauth_session_binding.sql.
DO $role$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commonswarm_credential_fence') THEN
  SET LOCAL createrole_self_grant = '';
  CREATE ROLE commonswarm_credential_fence NOLOGIN NOINHERIT;
 END IF;
 IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
  EXECUTE format('GRANT commonswarm_credential_fence TO %I WITH INHERIT TRUE, SET TRUE', current_user);
 END IF;
END
$role$;
GRANT commonswarm_credential_fence TO swarm_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- Grants on GoTrue's and swarm's objects, issued as each owner.
DO $owner_grants$
DECLARE
 applying_role name := current_user;
 applying_superuser boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
 can_set_owner boolean;
 item record;
BEGIN
 FOR item IN
  SELECT pg_get_userbyid(n.nspowner) AS owner, format(
   'GRANT USAGE ON SCHEMA %I TO commonswarm_credential_fence', n.nspname
  ) AS command FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('auth', 'swarm')
  UNION ALL
  -- Owning the table and functions below requires CREATE in swarm; revoked again at the end.
  SELECT pg_get_userbyid(n.nspowner), 'GRANT CREATE ON SCHEMA swarm TO commonswarm_credential_fence'
   FROM pg_catalog.pg_namespace n WHERE n.nspname = 'swarm'
  UNION ALL
  SELECT pg_get_userbyid(c.relowner), format(
   'GRANT SELECT (%s) ON auth.%I TO commonswarm_credential_fence', required.grant_columns, c.relname
  ) FROM (VALUES
   ('sessions', 'id, user_id, not_after'),
   ('users', 'id, deleted_at, banned_until'),
   ('flow_state', 'id, user_id'),
   ('one_time_tokens', 'id, user_id')
  ) AS required(table_name, grant_columns)
  JOIN pg_catalog.pg_class c ON c.relname = required.table_name
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'auth'
  UNION ALL
  SELECT pg_get_userbyid(c.relowner), format('GRANT DELETE ON auth.%I TO commonswarm_credential_fence', c.relname)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'auth'
   WHERE c.relname IN ('sessions', 'flow_state', 'one_time_tokens')
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

CREATE POLICY credential_fence_read ON auth.sessions FOR SELECT TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_revoke ON auth.sessions FOR DELETE TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_read ON auth.users FOR SELECT TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_read ON auth.flow_state FOR SELECT TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_revoke ON auth.flow_state FOR DELETE TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_read ON auth.one_time_tokens FOR SELECT TO commonswarm_credential_fence USING (true);
CREATE POLICY credential_fence_revoke ON auth.one_time_tokens FOR DELETE TO commonswarm_credential_fence USING (true);

-- The durable record of each person's latest credential change. No FK to auth.users, so a write
-- here can never roll back GoTrue's change.
CREATE TABLE swarm.human_credential_changes (
  user_id uuid PRIMARY KEY,
  generation bigint NOT NULL,
  changed_at timestamptz NOT NULL
);
ALTER TABLE swarm.human_credential_changes OWNER TO commonswarm_credential_fence;
ALTER TABLE swarm.human_credential_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.human_credential_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_fence_all ON swarm.human_credential_changes
  FOR ALL TO commonswarm_credential_fence USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.human_credential_changes FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- BEFORE: clear the user row's pending verification state (GoTrue reads OTP hashes from it).
-- Empty strings, as GoTrue writes them; it does not scan NULL into these fields.
CREATE FUNCTION swarm.credential_change_clear_tokens() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 NEW.confirmation_token := '';
 NEW.recovery_token := '';
 NEW.email_change_token_new := '';
 NEW.email_change_token_current := '';
 NEW.reauthentication_token := '';
 NEW.phone_change_token := '';
 NEW.email_change := '';
 RETURN NEW;
END
$$;

-- Deletes the person's sessions, flow states and one-time tokens.
CREATE FUNCTION swarm.credential_change_revoke_for(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 DELETE FROM auth.sessions WHERE user_id = p_user;
 DELETE FROM auth.flow_state WHERE user_id = p_user;
 DELETE FROM auth.one_time_tokens WHERE user_id = p_user;
END
$$;

-- AFTER (immediate): the exclusive fence lock, held to commit, then the record and the deletes.
CREATE FUNCTION swarm.credential_change_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(1668441444, pg_catalog.hashtext(NEW.id::text));
 INSERT INTO swarm.human_credential_changes (user_id, generation, changed_at)
 VALUES (NEW.id, 1, pg_catalog.statement_timestamp())
 ON CONFLICT (user_id) DO UPDATE
  SET generation = swarm.human_credential_changes.generation + 1, changed_at = excluded.changed_at;
 PERFORM swarm.credential_change_revoke_for(NEW.id);
 RETURN NULL;
END
$$;

-- AFTER (deferred to commit): the same deletes, after everything GoTrue did in this transaction.
CREATE FUNCTION swarm.credential_change_sweep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 PERFORM swarm.credential_change_revoke_for(NEW.id);
 RETURN NULL;
END
$$;

-- The liveness rule, from claims. Owner-only: callers use the wrappers below.
CREATE FUNCTION swarm.human_session_live(p_claims jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT coalesce(p_claims->>'role', '') = 'authenticated'
  AND coalesce(p_claims->>'sub', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND coalesce(p_claims->>'session_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (
   SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
   WHERE s.id = (p_claims->>'session_id')::uuid AND s.user_id = (p_claims->>'sub')::uuid
    AND (s.not_after IS NULL OR s.not_after > pg_catalog.statement_timestamp())
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.statement_timestamp()))
$$;

-- The current request's own human session (Realtime policies). Reports only the caller's own state.
CREATE FUNCTION swarm.current_human_session_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT swarm.human_session_live(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb)
$$;

-- PostgREST db-pre-request, run after it switches to the request's role. anon and service_role
-- pass; every authenticated request needs a live human session, with no agent exemption (agents
-- never reach PostgREST: their reads go through the edge's private database roles).
CREATE FUNCTION swarm.require_live_human_session() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
BEGIN
 IF coalesce(claims->>'role', '') IS DISTINCT FROM 'authenticated' THEN RETURN; END IF;
 IF NOT swarm.human_session_live(claims) THEN
  RAISE SQLSTATE 'PGRST' USING
   MESSAGE = '{"code":"session_not_found","message":"This sign-in has ended. Sign in again."}',
   DETAIL = '{"status":401,"headers":{}}';
 END IF;
END
$$;

-- Command and OAuth transactions: the shared fence lock, held to commit, then a fresh liveness
-- read. A credential change either waits for this transaction or has already revoked the session.
CREATE FUNCTION swarm.admit_human_session(p_user uuid, p_session uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 IF p_user IS NULL OR p_session IS NULL THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(1668441444, pg_catalog.hashtext(p_user::text));
 RETURN swarm.human_session_live(jsonb_build_object('role', 'authenticated', 'sub', p_user, 'session_id', p_session));
END
$$;

ALTER FUNCTION swarm.credential_change_clear_tokens() OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.credential_change_revoke_for(uuid) OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.credential_change_revoke() OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.credential_change_sweep() OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.human_session_live(jsonb) OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.current_human_session_live() OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.require_live_human_session() OWNER TO commonswarm_credential_fence;
ALTER FUNCTION swarm.admit_human_session(uuid, uuid) OWNER TO commonswarm_credential_fence;

-- EXECUTE: nothing for PUBLIC; the wrappers only for the roles that run them.
DO $function_grants$
DECLARE
 applying_role name := current_user;
 applying_superuser boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
 can_set_owner boolean;
 item record;
BEGIN
 FOR item IN
  SELECT pg_get_userbyid(p.proowner) AS owner, format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', p.oid::regprocedure) AS command
   FROM pg_catalog.pg_proc p WHERE p.oid IN (
    'swarm.credential_change_clear_tokens()'::regprocedure,
    'swarm.credential_change_revoke_for(uuid)'::regprocedure,
    'swarm.credential_change_revoke()'::regprocedure,
    'swarm.credential_change_sweep()'::regprocedure,
    'swarm.human_session_live(jsonb)'::regprocedure,
    'swarm.current_human_session_live()'::regprocedure,
    'swarm.require_live_human_session()'::regprocedure,
    'swarm.admit_human_session(uuid,uuid)'::regprocedure)
  UNION ALL
  SELECT pg_get_userbyid(p.proowner), format('GRANT EXECUTE ON FUNCTION %s TO %s', p.oid::regprocedure, grantees.roles)
   FROM (VALUES
    ('swarm.require_live_human_session()', 'anon, authenticated, service_role'),
    ('swarm.current_human_session_live()', 'authenticated'),
    ('swarm.admit_human_session(uuid,uuid)', 'swarm_command, commonswarm_oauth_runtime')
   ) AS grantees(signature, roles)
   JOIN pg_catalog.pg_proc p ON p.oid = grantees.signature::regprocedure
  UNION ALL
  SELECT pg_get_userbyid(n.nspowner), 'REVOKE CREATE ON SCHEMA swarm FROM commonswarm_credential_fence'
   FROM pg_catalog.pg_namespace n WHERE n.nspname = 'swarm'
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

CREATE TRIGGER credential_change_clear_tokens
 BEFORE UPDATE OF encrypted_password, email ON auth.users
 FOR EACH ROW
 WHEN (OLD.email_confirmed_at IS NOT NULL AND (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password
  OR OLD.email IS DISTINCT FROM NEW.email))
 EXECUTE FUNCTION swarm.credential_change_clear_tokens();
CREATE TRIGGER credential_change_revoke
 AFTER UPDATE OF encrypted_password, email ON auth.users
 FOR EACH ROW
 WHEN (OLD.email_confirmed_at IS NOT NULL AND (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password
  OR OLD.email IS DISTINCT FROM NEW.email))
 EXECUTE FUNCTION swarm.credential_change_revoke();
CREATE CONSTRAINT TRIGGER credential_change_sweep
 AFTER UPDATE OF encrypted_password, email ON auth.users
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW
 WHEN (OLD.email_confirmed_at IS NOT NULL AND (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password
  OR OLD.email IS DISTINCT FROM NEW.email))
 EXECUTE FUNCTION swarm.credential_change_sweep();

-- Realtime: the two member topics also need a live human session. A joined socket still runs to
-- its JWT's exp (GOTRUE_JWT_EXP), which the server rechecks on a timer.
DROP POLICY "workspace members receive agent activity" ON realtime.messages;
CREATE POLICY "workspace members receive agent activity"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.is_member(
    substring(
      (SELECT realtime.topic())
      FROM '^cswarm-activity:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
    )::uuid,
    (SELECT auth.uid())
  )
  AND (SELECT swarm.current_human_session_live())
);
DROP POLICY "workspace members receive signals" ON realtime.messages;
CREATE POLICY "workspace members receive signals"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.is_member(
    substring(
      (SELECT realtime.topic())
      FROM '^cswarm-signals:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
    )::uuid,
    (SELECT auth.uid())
  )
  AND (SELECT swarm.current_human_session_live())
);

-- PostgREST reads its db-pre-request from the authenticator role (in-database configuration).
-- Rollback: ALTER ROLE authenticator RESET pgrst.db_pre_request; it reopens the window.
ALTER ROLE authenticator SET pgrst.db_pre_request TO 'swarm.require_live_human_session';
NOTIFY pgrst, 'reload config';

DO $role$
BEGIN
 IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
  EXECUTE format('REVOKE INHERIT OPTION FOR commonswarm_credential_fence FROM %I', current_user);
  EXECUTE format('REVOKE SET OPTION FOR commonswarm_credential_fence FROM %I', current_user);
 END IF;
END
$role$;

-- GRANT can warn and change nothing: verify the effective privileges; a gap aborts the apply.
DO $fence_privileges$
DECLARE item record;
BEGIN
 IF (SELECT rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
     FROM pg_catalog.pg_roles WHERE rolname = 'commonswarm_credential_fence') THEN
  RAISE EXCEPTION 'credential fence role has a login, inheritance or an elevated attribute' USING ERRCODE = '42501';
 END IF;
 IF has_schema_privilege('commonswarm_credential_fence', 'auth', 'USAGE') IS DISTINCT FROM true
   OR has_schema_privilege('commonswarm_credential_fence', 'swarm', 'USAGE') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'credential fence role needs USAGE on auth and swarm' USING ERRCODE = '42501';
 END IF;
 IF has_schema_privilege('commonswarm_credential_fence', 'swarm', 'CREATE') THEN
  RAISE EXCEPTION 'credential fence role still has temporary CREATE on swarm' USING ERRCODE = '42501';
 END IF;
 FOR item IN SELECT * FROM (VALUES
  ('auth.sessions', 'id'), ('auth.sessions', 'user_id'), ('auth.sessions', 'not_after'),
  ('auth.users', 'id'), ('auth.users', 'deleted_at'), ('auth.users', 'banned_until'),
  ('auth.flow_state', 'user_id'), ('auth.one_time_tokens', 'user_id')
 ) AS required(table_name, column_name) LOOP
  IF has_column_privilege('commonswarm_credential_fence', item.table_name, item.column_name, 'SELECT') IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'credential fence role needs SELECT on %.%', item.table_name, item.column_name USING ERRCODE = '42501';
  END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES ('auth.sessions'), ('auth.flow_state'), ('auth.one_time_tokens')) AS required(table_name) LOOP
  IF has_table_privilege('commonswarm_credential_fence', item.table_name, 'DELETE') IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'credential fence role needs DELETE on %', item.table_name USING ERRCODE = '42501';
  END IF;
 END LOOP;
 IF has_column_privilege('commonswarm_credential_fence', 'auth.users', 'encrypted_password', 'SELECT')
   OR has_table_privilege('commonswarm_credential_fence', 'auth.users', 'UPDATE') THEN
  RAISE EXCEPTION 'credential fence role must not read password hashes or update users' USING ERRCODE = '42501';
 END IF;
 FOR item IN SELECT * FROM (VALUES
  ('swarm.credential_change_clear_tokens()'), ('swarm.credential_change_revoke_for(uuid)'),
  ('swarm.credential_change_revoke()'), ('swarm.credential_change_sweep()'), ('swarm.human_session_live(jsonb)'),
  ('swarm.current_human_session_live()'), ('swarm.require_live_human_session()'), ('swarm.admit_human_session(uuid,uuid)')
 ) AS guarded(function_name) LOOP
  IF has_function_privilege('public', item.function_name, 'EXECUTE') THEN
   RAISE EXCEPTION 'credential fence function exposed to PUBLIC: %', item.function_name USING ERRCODE = '42501';
  END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES ('anon'), ('authenticated'), ('swarm_read'), ('swarm_command')) AS client(role_name) LOOP
  IF has_function_privilege(item.role_name, 'swarm.human_session_live(jsonb)', 'EXECUTE') THEN
   RAISE EXCEPTION 'the inner liveness checker is exposed to %', item.role_name USING ERRCODE = '42501';
  END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
   WHERE r.rolname = 'authenticator' AND s.setdatabase = 0
    AND 'pgrst.db_pre_request=swarm.require_live_human_session' = ANY (s.setconfig)) THEN
  RAISE EXCEPTION 'PostgREST db-pre-request is not set on authenticator' USING ERRCODE = '42501';
 END IF;
END
$fence_privileges$;
