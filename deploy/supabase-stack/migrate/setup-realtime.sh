#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR SELF_HOST_TENANT_NAME
start_log setup-realtime
assert_target_identity >>"$LOG_FILE" 2>&1
log "target identity accepted before Realtime changes"

sql_file="$(make_temp_sql)"
trap 'rm -f "$sql_file"' EXIT
cat >"$sql_file" <<'SQL'
\getenv tenant_name SELF_HOST_TENANT_NAME

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$do$;

SELECT set_config('commonswarm.realtime_tenant', :'tenant_name', false);

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM _realtime.tenants
    WHERE external_id = current_setting('commonswarm.realtime_tenant')
      AND jwt_secret IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Realtime application seed has not created the encrypted tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM _realtime.extensions
    WHERE tenant_external_id = current_setting('commonswarm.realtime_tenant')
      AND type = 'postgres_cdc_rls'
  ) THEN
    RAISE EXCEPTION 'Realtime application seed has not created the encrypted database extension';
  END IF;
END
$do$;

DO $do$
DECLARE
  affected integer;
BEGIN
  UPDATE _realtime.extensions
  SET settings = jsonb_set(settings, '{ssl_enforced}', 'true'::jsonb, true),
      updated_at = statement_timestamp()
  WHERE tenant_external_id = current_setting('commonswarm.realtime_tenant')
    AND type = 'postgres_cdc_rls';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'expected one Realtime database extension update, got %', affected;
  END IF;
END
$do$;

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
  IF NOT has_function_privilege('anon', 'swarm.wake_topic_authorized(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on swarm.wake_topic_authorized(text)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'swarm.is_member(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on swarm.is_member(uuid,uuid)';
  END IF;
END
$do$;
SQL

target_psql --file "$sql_file" >>"$LOG_FILE" 2>&1
log "application-seeded realtime tenant configured to require database TLS"
log "supabase_realtime publication exists and stays empty because clients use Broadcast only"
log "all three private Broadcast policies are present"
log "Realtime authorization function EXECUTE grants are present"
log "complete setup-realtime; restart realtime to clear its tenant cache"
