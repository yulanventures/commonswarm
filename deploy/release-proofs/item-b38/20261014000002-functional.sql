-- Transactional functional proof for 20261014000002_oauth_finish.sql.
-- Synthetic rows only; ends with ROLLBACK. Proves database storage and ACLs,
-- not the application's concurrent finish/resume or GoTrue HTTP flow.
-- RELEASE-TO-BOX.md:1907-1909 requires a functional proof. :2154-2162 normally
-- calls release_psql_ro; this WRITING fixture needs a separately named
-- release_psql invocation (:1567 ON_ERROR_STOP), not the read-only helper
-- (:1472-1473). Do not change PGOPTIONS or disable a read-only guard.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT b38_functional_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
\ir 20261014000002-catalog.sql
\if :catalog_ok
\else
DO $fail$ BEGIN RAISE EXCEPTION 'B38 finish functional proof requires the forward catalog'; END $fail$;
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
  grant_id uuid := gen_random_uuid();
  interaction_id text := 'b38-release-proof-' || gen_random_uuid()::text;
  session_digest bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  missing_digest bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  item record;
  updated_rows bigint;
BEGIN
  EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
  INSERT INTO commonswarm_oauth.browser_sessions(session_hash, expires_at)
    VALUES (session_digest, statement_timestamp() + interval '1 hour');
  INSERT INTO commonswarm_oauth.interactions(interaction_uid, session_hash, user_id,
    client_id, redirect_uri, resource, requested_scopes, pkce_challenge, expires_at)
    VALUES (interaction_id, session_digest, owner_id, 'https://client.example/oauth.json',
      'https://client.example/callback', 'https://mcp.commonswarm.com/mcp', ARRAY['openid','mcp'],
      repeat('a', 43), statement_timestamp() + interval '10 minutes');
  INSERT INTO commonswarm_oauth.finish_records(interaction_uid, session_hash, user_id,
    provider_grant_id, commonswarm_grant_id, validated_request, display_model, provider_result, expires_at)
    VALUES (interaction_id, session_digest, owner_id, 'B38-SYNTHETIC-GRANT', grant_id,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, statement_timestamp() + interval '1 minute');
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.finish_records
    WHERE interaction_uid = interaction_id AND state = 'prepared' AND resume_response IS NULL
      AND created_at = statement_timestamp() AND expires_at = created_at + interval '1 minute') THEN
    RAISE EXCEPTION 'B38 finish runtime insert/default/read positive control FAILED';
  END IF;
  BEGIN
    INSERT INTO commonswarm_oauth.finish_records(interaction_uid, session_hash, user_id,
      provider_grant_id, commonswarm_grant_id, validated_request, display_model, provider_result, expires_at)
      SELECT interaction_uid, session_hash, user_id, provider_grant_id, commonswarm_grant_id,
        validated_request, display_model, provider_result, expires_at
      FROM commonswarm_oauth.finish_records WHERE interaction_uid = interaction_id;
    RAISE EXCEPTION 'B38 finish duplicate primary key was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- No statement text derives from caller or customer input. These fixed
  -- probes execute against our valid row, so permission failures cannot be
  -- explained by a missing table, row, or broken positive insert.
  FOR item IN SELECT command FROM (VALUES
    ('UPDATE commonswarm_oauth.finish_records SET user_id = gen_random_uuid() WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET expires_at = expires_at + interval ''1 second'' WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET validated_request = ''{}''::jsonb WHERE interaction_uid = $1'),
    ('DELETE FROM commonswarm_oauth.finish_records WHERE interaction_uid = $1'),
    ('INSERT INTO commonswarm_oauth.finish_records(interaction_uid, session_hash, user_id, provider_grant_id,
      commonswarm_grant_id, validated_request, display_model, provider_result, expires_at, resume_response)
      SELECT interaction_uid, session_hash, user_id, provider_grant_id, commonswarm_grant_id,
        validated_request, display_model, provider_result, expires_at, ''{}''::jsonb
      FROM commonswarm_oauth.finish_records WHERE interaction_uid = $1')
  ) AS denied(command) LOOP
    BEGIN
      EXECUTE item.command USING interaction_id;
      RAISE EXCEPTION 'B38 finish immutable binding, deadline, DELETE or resume INSERT was allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  -- Exercise every CHECK family through an otherwise valid existing row.
  -- The applying owner can mutate fixture bindings to reach these checks.
  EXECUTE format('SET LOCAL ROLE %I', applying_role);
  FOR item IN SELECT command FROM (VALUES
    ('UPDATE commonswarm_oauth.finish_records SET validated_request = ''[]''::jsonb WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET display_model = ''[]''::jsonb WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET provider_result = ''[]''::jsonb WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET state = ''unknown'' WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET state = ''resume_ready'', resume_response = ''[]''::jsonb WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET expires_at = created_at WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET expires_at = created_at + interval ''2 minutes 1 second'' WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET state = ''resume_ready'' WHERE interaction_uid = $1'),
    ('UPDATE commonswarm_oauth.finish_records SET resume_response = ''{}''::jsonb WHERE interaction_uid = $1')
  ) AS denied(command) LOOP
    BEGIN
      EXECUTE item.command USING interaction_id;
      RAISE EXCEPTION 'B38 finish invalid shape/state/deadline was allowed';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE commonswarm_oauth.finish_records SET interaction_uid = 'b38-missing-' || gen_random_uuid()::text
      WHERE interaction_uid = interaction_id;
    RAISE EXCEPTION 'B38 finish missing interaction was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions WHERE session_hash = missing_digest) THEN
    RAISE EXCEPTION 'B38 missing-session fixture digest is not fresh';
  END IF;
  BEGIN
    UPDATE commonswarm_oauth.finish_records SET session_hash = missing_digest
      WHERE interaction_uid = interaction_id;
    RAISE EXCEPTION 'B38 finish missing browser session was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  EXECUTE 'SET LOCAL ROLE commonswarm_oauth_runtime';
  UPDATE commonswarm_oauth.finish_records SET state = 'preparing_resume' WHERE interaction_uid = interaction_id;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.finish_records
    WHERE interaction_uid = interaction_id AND state = 'preparing_resume' AND resume_response IS NULL) THEN
    RAISE EXCEPTION 'B38 finish preparing_resume positive control FAILED';
  END IF;
  UPDATE commonswarm_oauth.finish_records SET state = 'resume_ready', resume_response = '{"status":303}'::jsonb
    WHERE interaction_uid = interaction_id AND state = 'preparing_resume'
      AND expires_at > statement_timestamp();
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'B38 finish first resume must update exactly one row';
  END IF;
  -- Repeat the finish-store.js conditional write with a different response.
  UPDATE commonswarm_oauth.finish_records SET state = 'resume_ready', resume_response = '{"status":302}'::jsonb
    WHERE interaction_uid = interaction_id AND state = 'preparing_resume'
      AND expires_at > statement_timestamp();
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 0 THEN
    RAISE EXCEPTION 'B38 finish second resume must update no rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.finish_records
    WHERE interaction_uid = interaction_id AND state = 'resume_ready' AND resume_response = '{"status":303}'::jsonb
      AND user_id = owner_id AND commonswarm_grant_id = grant_id
      AND session_hash = session_digest AND expires_at = created_at + interval '1 minute') THEN
    RAISE EXCEPTION 'B38 finish resume update/read or binding preservation FAILED';
  END IF;
  DELETE FROM commonswarm_oauth.interactions WHERE interaction_uid = interaction_id;
  IF EXISTS (SELECT 1 FROM commonswarm_oauth.finish_records WHERE interaction_uid = interaction_id) THEN
    RAISE EXCEPTION 'B38 finish interaction-delete cascade FAILED';
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
DO $fail$ BEGIN RAISE EXCEPTION 'B38 finish functional proof FAILED'; END $fail$;
\endif
