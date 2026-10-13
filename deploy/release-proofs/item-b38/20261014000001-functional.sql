-- Transactional functional proof for 20261014000001_oauth_session_binding.sql.
-- Synthetic rows only; never select customer content. Always rolls back.
-- RELEASE-TO-BOX.md:1907-1909 requires the functional proof; :2154-2162
-- normally uses release_psql_ro. This fixture WRITES: HezLead must name a
-- release_psql invocation (:1567 ON_ERROR_STOP), not the read-only helper
-- (:1472-1473). Do not change PGOPTIONS or disable a read-only guard.
-- Real GoTrue global-logout HTTP behavior remains the box-matched CI gate;
-- this proof tests its auth.sessions DELETE database boundary only.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT b38_functional_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
\ir 20261014000001-catalog.sql
\if :catalog_ok
\else
DO $fail$ BEGIN RAISE EXCEPTION 'B38 session functional proof requires the forward catalog'; END $fail$;
\endif

DO $runtime_membership$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT commonswarm_oauth_runtime TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  END IF;
END
$runtime_membership$;

DO $functional$
DECLARE
  applying_role name := current_user;
  owner_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  binding_id uuid := gen_random_uuid();
  control_id uuid := gen_random_uuid();
  noninteractive_id uuid := gen_random_uuid();
  original_auth timestamptz := statement_timestamp() - interval '10 minutes';
  prior_invalidation timestamptz := statement_timestamp() - interval '1 hour';
  bound_hash bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  control_hash bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  mismatch_hash bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  invalid_hash bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  item record;
BEGIN
  INSERT INTO auth.users(id, aud, role, email) VALUES
    (owner_id, 'authenticated', 'authenticated', owner_id::text || '@example.test'),
    (other_id, 'authenticated', 'authenticated', other_id::text || '@example.test');
  INSERT INTO auth.sessions(id, user_id) VALUES
    (binding_id, owner_id), (control_id, other_id), (noninteractive_id, owner_id);
  INSERT INTO auth.mfa_amr_claims(id, session_id, created_at, updated_at, authentication_method) VALUES
    (gen_random_uuid(), binding_id, original_auth, original_auth, 'oauth'),
    (gen_random_uuid(), binding_id, original_auth + interval '5 minutes', original_auth + interval '5 minutes', 'password'),
    (gen_random_uuid(), binding_id, original_auth - interval '5 minutes', original_auth - interval '5 minutes', 'totp'),
    (gen_random_uuid(), control_id, original_auth, original_auth, 'otp'),
    (gen_random_uuid(), noninteractive_id, original_auth, original_auth, 'totp');
  INSERT INTO commonswarm_oauth.browser_sessions(session_hash, user_id, gotrue_session_id, expires_at, invalidated_at) VALUES
    (bound_hash, owner_id, binding_id, statement_timestamp() + interval '1 hour', NULL),
    (control_hash, other_id, control_id, statement_timestamp() + interval '1 hour', NULL),
    (mismatch_hash, other_id, binding_id, statement_timestamp() + interval '1 hour', NULL),
    (invalid_hash, owner_id, binding_id, statement_timestamp() + interval '1 hour', prior_invalidation);

  EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
  IF (SELECT count(*) FROM commonswarm_oauth.live_gotrue_session(binding_id, owner_id)) <> 1
    OR NOT EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(binding_id, owner_id) AS live
      WHERE live.session_id = binding_id AND live.user_id = owner_id AND live.authenticated_at = original_auth)
    OR EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(binding_id, other_id))
    OR EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(gen_random_uuid(), owner_id))
    OR EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(noninteractive_id, owner_id))
    OR (SELECT count(*) FROM commonswarm_oauth.live_gotrue_session(control_id, other_id)) <> 1 THEN
    RAISE EXCEPTION 'B38 session live/mismatched/missing/noninteractive controls FAILED';
  END IF;
  BEGIN
    PERFORM id FROM auth.sessions LIMIT 1;
    RAISE EXCEPTION 'B38 runtime can read auth sessions directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE format('SET LOCAL ROLE %I', applying_role);

  -- A later AMR record and a future expiry must not replace original auth time.
  INSERT INTO auth.mfa_amr_claims(id, session_id, created_at, updated_at, authentication_method)
    VALUES (gen_random_uuid(), binding_id, statement_timestamp(), statement_timestamp(), 'otp');
  UPDATE auth.sessions SET not_after = statement_timestamp() + interval '1 day' WHERE id = binding_id;
  EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
  IF (SELECT authenticated_at FROM commonswarm_oauth.live_gotrue_session(binding_id, owner_id))
      IS DISTINCT FROM original_auth THEN
    RAISE EXCEPTION 'B38 session original authentication time changed';
  END IF;
  EXECUTE format('SET LOCAL ROLE %I', applying_role);

  -- Each negative state reaches the live checker with the independent live
  -- control in that same invocation. All mutations target synthetic UUIDs.
  FOR item IN SELECT kind FROM (VALUES ('expired'), ('banned'), ('deleted')) AS cases(kind) LOOP
    IF item.kind = 'expired' THEN
      UPDATE auth.sessions SET not_after = statement_timestamp() - interval '1 second' WHERE id = binding_id;
    ELSIF item.kind = 'banned' THEN
      UPDATE auth.users SET banned_until = statement_timestamp() + interval '1 hour' WHERE id = owner_id;
    ELSE
      UPDATE auth.users SET deleted_at = statement_timestamp() WHERE id = owner_id;
    END IF;
    EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
    IF EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(binding_id, owner_id))
      OR (SELECT count(*) FROM commonswarm_oauth.live_gotrue_session(control_id, other_id)) <> 1 THEN
      RAISE EXCEPTION 'B38 session % refusal or positive control FAILED', item.kind;
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', applying_role);
    UPDATE auth.sessions SET not_after = NULL WHERE id = binding_id;
    UPDATE auth.users SET banned_until = NULL, deleted_at = NULL WHERE id = owner_id;
  END LOOP;

  DELETE FROM auth.sessions WHERE id = binding_id;
  IF (SELECT invalidated_at FROM commonswarm_oauth.browser_sessions WHERE session_hash = bound_hash) IS NULL
    OR (SELECT invalidated_at FROM commonswarm_oauth.browser_sessions WHERE session_hash = control_hash) IS NOT NULL
    OR (SELECT invalidated_at FROM commonswarm_oauth.browser_sessions WHERE session_hash = mismatch_hash) IS NOT NULL
    OR (SELECT invalidated_at FROM commonswarm_oauth.browser_sessions WHERE session_hash = invalid_hash)
      IS DISTINCT FROM prior_invalidation THEN
    RAISE EXCEPTION 'B38 session DELETE invalidation or isolation FAILED';
  END IF;
  EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
  IF EXISTS (SELECT 1 FROM commonswarm_oauth.live_gotrue_session(binding_id, owner_id))
    OR (SELECT count(*) FROM commonswarm_oauth.live_gotrue_session(control_id, other_id)) <> 1 THEN
    RAISE EXCEPTION 'B38 deleted session refusal or live positive control FAILED';
  END IF;
  EXECUTE format('SET LOCAL ROLE %I', applying_role);
END
$functional$;

SELECT true AS functional_ok
\gset
\if :{?release_proof_outer_transaction}
ROLLBACK TO SAVEPOINT b38_functional_guard;
RELEASE SAVEPOINT b38_functional_guard;
\else
ROLLBACK;
\endif
\if :functional_ok
\echo t
\else
DO $fail$ BEGIN RAISE EXCEPTION 'B38 session functional proof FAILED'; END $fail$;
\endif
