-- Test-only models of the four Supabase extensions that local PostgreSQL does not package.
-- Used ONLY by scripts/c1-w2-rehearsal.sh --live-dump on a disposable cluster: each section
-- replaces exactly one "CREATE EXTENSION IF NOT EXISTS <name> WITH SCHEMA <schema>;" line of the
-- live schema dump and creates only what the dump's own statements name (schemas, tables,
-- sequences, functions with the same argument signatures). Every modelled function raises if
-- called. The pg_extension row exists only so the dump's own COMMENT ON EXTENSION succeeds.
-- The harness separately proves no W2 migration, catalog or plan SQL names these schemas.
-- Each section starts with "-- model: <extension>" and lists its objects in "-- object:" lines.

-- model: pg_cron
-- object: schema cron
-- object: table cron.job
-- object: table cron.job_run_details
-- object: function cron.alter_job(bigint,text,text,text,text,boolean)
-- object: function cron.job_cache_invalidate()
-- object: function cron.schedule(text,text)
-- object: function cron.schedule(text,text,text)
-- object: function cron.schedule_in_database(text,text,text,text,text,boolean)
-- object: function cron.unschedule(bigint)
-- object: function cron.unschedule(text)
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432, database text NOT NULL DEFAULT current_database(), username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true, jobname text);
CREATE TABLE cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid integer, database text, username text, command text,
  status text, return_message text, start_time timestamptz, end_time timestamptz);
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.job_cache_invalidate() RETURNS trigger LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.schedule(schedule text, command text) RETURNS bigint LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.schedule_in_database(job_name text, schedule text, command text, database text, username text DEFAULT NULL, active boolean DEFAULT true)
  RETURNS bigint LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_cron is not installed'; END $m$;
INSERT INTO pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
  SELECT (SELECT max(oid::text::bigint)+1 FROM pg_catalog.pg_extension)::text::oid,'pg_cron','supabase_admin'::regrole,'pg_catalog'::regnamespace,false,'rehearsal-model';

-- model: pg_net
-- object: schema net
-- object: function net.http_get(text,jsonb,jsonb,integer)
-- object: function net.http_post(text,jsonb,jsonb,jsonb,integer)
CREATE SCHEMA net;
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_net is not installed'; END $m$;
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{"Content-Type": "application/json"}', timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_net is not installed'; END $m$;
INSERT INTO pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
  SELECT (SELECT max(oid::text::bigint)+1 FROM pg_catalog.pg_extension)::text::oid,'pg_net','supabase_admin'::regrole,'extensions'::regnamespace,false,'rehearsal-model';

-- model: pg_graphql
-- object: sequence graphql.seq_schema_version
-- object: function graphql._internal_resolve(text,jsonb,text,jsonb)
-- object: function graphql.comment_directive(text)
-- object: function graphql.exception(text)
-- object: function graphql.get_schema_version()
-- object: function graphql.increment_schema_version()
-- object: function graphql.resolve(text,jsonb,text,jsonb)
CREATE SEQUENCE graphql.seq_schema_version;
CREATE FUNCTION graphql._internal_resolve(query text, variables jsonb DEFAULT '{}', "operationName" text DEFAULT NULL, extensions jsonb DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
CREATE FUNCTION graphql.comment_directive(comment_ text) RETURNS jsonb LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
CREATE FUNCTION graphql.exception(message text) RETURNS text LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
CREATE FUNCTION graphql.get_schema_version() RETURNS integer LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
CREATE FUNCTION graphql.increment_schema_version() RETURNS event_trigger LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
CREATE FUNCTION graphql.resolve(query text, variables jsonb DEFAULT '{}', "operationName" text DEFAULT NULL, extensions jsonb DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: pg_graphql is not installed'; END $m$;
INSERT INTO pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
  SELECT (SELECT max(oid::text::bigint)+1 FROM pg_catalog.pg_extension)::text::oid,'pg_graphql','supabase_admin'::regrole,'graphql'::regnamespace,false,'rehearsal-model';

-- model: supabase_vault
-- object: table vault.secrets
-- object: view vault.decrypted_secrets
-- object: function vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea)
-- object: function vault.create_secret(text,text,text,uuid)
-- object: function vault.update_secret(uuid,text,text,text,uuid)
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, description text NOT NULL DEFAULT '', secret text NOT NULL,
  key_id uuid, nonce bytea, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, description, secret, NULL::text AS decrypted_secret, key_id, nonce, created_at, updated_at FROM vault.secrets WHERE false;
CREATE FUNCTION vault._crypto_aead_det_decrypt(message bytea, additional bytea, key_id bigint, context bytea DEFAULT '\x7067736f6469756d', nonce bytea DEFAULT NULL)
  RETURNS bytea LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: supabase_vault is not installed'; END $m$;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: supabase_vault is not installed'; END $m$;
CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $m$ BEGIN RAISE EXCEPTION 'rehearsal model: supabase_vault is not installed'; END $m$;
INSERT INTO pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
  SELECT (SELECT max(oid::text::bigint)+1 FROM pg_catalog.pg_extension)::text::oid,'supabase_vault','supabase_admin'::regrole,'vault'::regnamespace,false,'rehearsal-model';
