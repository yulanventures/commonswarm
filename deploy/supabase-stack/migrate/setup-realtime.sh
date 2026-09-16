#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR SELF_HOST_TENANT_NAME \
  API_JWT_SECRET DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME
start_log setup-realtime

sql_file="$(make_temp_sql)"
trap 'rm -f "$sql_file"' EXIT
cat >"$sql_file" <<'SQL'
\getenv tenant_name SELF_HOST_TENANT_NAME
\getenv jwt_secret API_JWT_SECRET
\getenv jwt_jwks API_JWT_JWKS
\getenv db_host DB_HOST
\getenv db_port DB_PORT
\getenv db_user DB_USER
\getenv db_password DB_PASSWORD
\getenv db_name DB_NAME

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$do$;

INSERT INTO _realtime.tenants (
  id, name, external_id, jwt_secret, jwt_jwks, inserted_at, updated_at,
  private_only, presence_enabled
)
VALUES (
  gen_random_uuid(), :'tenant_name', :'tenant_name', :'jwt_secret',
  NULLIF(:'jwt_jwks', '')::jsonb, statement_timestamp(), statement_timestamp(),
  false, false
)
ON CONFLICT (external_id) DO UPDATE
SET name = EXCLUDED.name,
    jwt_secret = EXCLUDED.jwt_secret,
    jwt_jwks = EXCLUDED.jwt_jwks,
    updated_at = statement_timestamp();

INSERT INTO _realtime.extensions (
  id, type, settings, tenant_external_id, inserted_at, updated_at
)
VALUES (
  gen_random_uuid(),
  'postgres_cdc_rls',
  jsonb_build_object(
    'db_name', :'db_name',
    'db_host', :'db_host',
    'db_user', :'db_user',
    'db_password', :'db_password',
    'db_port', :'db_port',
    'region', 'eu-central-1',
    'poll_interval_ms', 100,
    'poll_max_changes', 100,
    'poll_max_record_bytes', 1048576,
    'publication', 'supabase_realtime',
    'slot_name', 'supabase_realtime_rls_commonswarm',
    'ssl_enforced', true
  ),
  :'tenant_name',
  statement_timestamp(),
  statement_timestamp()
)
ON CONFLICT (tenant_external_id, type) DO UPDATE
SET settings = EXCLUDED.settings,
    updated_at = statement_timestamp();

DO $do$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(required.name ORDER BY required.name)
  INTO missing
  FROM (
    VALUES
      ('agent receives its own wake'),
      ('workspace members receive agent activity'),
      ('workspace members receive signals')
  ) AS required(name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies AS policy
    WHERE policy.schemaname = 'realtime'
      AND policy.tablename = 'messages'
      AND policy.policyname = required.name
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing CommonSwarm realtime policies: %', missing;
  END IF;
END
$do$;
SQL

target_psql --file "$sql_file" >>"$LOG_FILE" 2>&1
log "realtime tenant configured with TLS to db.commonswarm.internal"
log "supabase_realtime publication exists and stays empty because clients use Broadcast only"
log "all three private Broadcast policies are present"
log "complete setup-realtime; restart realtime to clear its tenant cache"
