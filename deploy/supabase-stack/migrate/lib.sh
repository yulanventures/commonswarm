#!/usr/bin/env bash
set -euo pipefail
exec </dev/null

MIGRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$MIGRATE_DIR/.." && pwd)"

require_commands() {
  local command
  for command in "$@"; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "required command is missing: $command" >&2
      exit 1
    fi
  done
}

require_vars() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "required environment variable is empty: $name" >&2
      exit 1
    fi
  done
}

prepare_artifact_dir() {
  require_vars MIGRATION_ARTIFACT_DIR
  if [[ "$MIGRATION_ARTIFACT_DIR" != /* ]]; then
    echo "MIGRATION_ARTIFACT_DIR must be absolute" >&2
    exit 1
  fi
  mkdir -p "$MIGRATION_ARTIFACT_DIR/logs"
  chmod 0700 "$MIGRATION_ARTIFACT_DIR" "$MIGRATION_ARTIFACT_DIR/logs"
}

start_log() {
  local name="$1"
  prepare_artifact_dir
  LOG_FILE="$MIGRATION_ARTIFACT_DIR/logs/${name}.log"
  touch "$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  log "start $name"
}

log() {
  local line
  line="$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$line"
  if [[ -n "${LOG_FILE:-}" ]]; then
    printf '%s\n' "$line" >>"$LOG_FILE"
  fi
}

source_psql() {
  : "${PGSERVICEFILE:?run through run-db-tool.sh so the database URL stays out of argv}"
  PGSERVICE=source psql -X --set=ON_ERROR_STOP=1 "$@" </dev/null
}

target_psql() {
  : "${PGSERVICEFILE:?run through run-db-tool.sh so the database URL stays out of argv}"
  PGSERVICE=target psql -X --set=ON_ERROR_STOP=1 "$@" </dev/null
}

database_psql() {
  local service="$1"
  shift
  if [[ "$service" != source && "$service" != target ]]; then
    echo "database service must be source or target" >&2
    exit 1
  fi
  : "${PGSERVICEFILE:?run through run-db-tool.sh so the database URL stays out of argv}"
  PGSERVICE="$service" psql -X --set=ON_ERROR_STOP=1 "$@" </dev/null
}

assert_target_identity() {
  local sql_file
  sql_file="$(make_temp_sql)"
  cat >"$sql_file" <<'SQL'

DO $do$
BEGIN
  IF inet_server_addr() IS DISTINCT FROM inet '172.31.0.10'
    AND NOT (
      current_setting('commonswarm.local_rehearsal', true) = '1'
      AND NULLIF(current_setting('commonswarm.local_target_address', true), '') IS NOT NULL
      AND inet_server_addr() = current_setting('commonswarm.local_target_address')::inet
    )
  THEN
    RAISE EXCEPTION 'refusing write: target server address is not 172.31.0.10';
  END IF;
  IF current_setting('commonswarm.stack_identity', true) IS DISTINCT FROM 'n-db-target-v1' THEN
    RAISE EXCEPTION 'refusing write: database is not a marked CommonSwarm N-db target';
  END IF;
  IF current_user <> 'supabase_admin' OR NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'refusing write: target connection must be the supabase_admin superuser';
  END IF;
END
$do$;
SQL
  target_psql --file "$sql_file"
  rm -f "$sql_file"
}

assert_database_identity() {
  local service="$1"
  if [[ "$service" == target ]]; then
    assert_target_identity
  elif [[ "$service" == source ]]; then
    assert_source_identity
  else
    echo "database service must be source or target" >&2
    exit 64
  fi
}

# The source is identified by its cluster system_identifier, pinned in the migration env file as
# SOURCE_SYSTEM_IDENTIFIER. Hosted Supabase lets its non-superuser `postgres` read pg_control_system()
# (pg_monitor member, measured 2026-09-17) but does not set app.settings.jwt_secret and does not let that
# role set custom database parameters, so neither can identify the source. Reading the identifier writes
# nothing. A restored box database has a different identifier, and it also carries the target marker.
# A physical standby or a point-in-time clone of the source has the SAME identifier. A standby is refused because it is
# in recovery; a clone promoted to a primary on another host is not distinguishable here, so SOURCE_DATABASE_URL must
# still name the production pooler host (the runbook reads it before the window).
source_identity_sql() {
  cat <<'SQL'
\getenv expected_system_identifier SOURCE_SYSTEM_IDENTIFIER
SELECT (
  (SELECT system_identifier::text FROM pg_control_system()) = :'expected_system_identifier'
  AND NOT pg_is_in_recovery()
  AND to_regnamespace('swarm') IS NOT NULL
  AND current_setting('commonswarm.stack_identity', true) IS DISTINCT FROM 'n-db-target-v1'
) AS source_identity_ok
\gset
\if :source_identity_ok
\else
  -- psql's \quit takes no exit status; an error under ON_ERROR_STOP is what makes psql exit non-zero.
  DO $refuse$ BEGIN RAISE EXCEPTION 'refusing: database is not the CommonSwarm source named by SOURCE_SYSTEM_IDENTIFIER'; END $refuse$;
\endif
SQL
}

assert_source_identity() {
  require_vars SOURCE_SYSTEM_IDENTIFIER
  local sql_file
  sql_file="$(make_temp_sql)"
  source_identity_sql >"$sql_file"
  source_psql --file "$sql_file"
  rm -f "$sql_file"
}

assert_dump_origin() {
  local service="$1"
  if [[ "$service" == target ]]; then
    assert_target_identity
    return
  fi
  assert_source_identity
}

# One row per pg_cron job, as JSON, in a fixed order. dump-source.sh writes it from the source snapshot to
# cron-jobs.ndjson; restore-cron-jobs.sh and verify-counts.sh run the same query on the target and require the same
# bytes. The schedules live in the cron schema, which the selected-schema dump does not carry. `postgres` has BYPASSRLS
# on hosted Supabase and on the box image, so the source export and target query see every job regardless of owner.
cron_jobs_json_sql() {
  cat <<'SQL'
SELECT json_build_object(
  'jobname', jobname,
  'schedule', schedule,
  'command', command,
  'database', database,
  'username', username,
  'active', active
)
FROM cron.job
ORDER BY jobname, jobid;
SQL
}

make_temp_sql() {
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-n-db-sql.XXXXXX")"
  chmod 0600 "$file"
  printf '%s\n' "$file"
}

selected_schema_csv() {
  printf '%s' "auth,public,realtime,storage,supabase_migrations,swarm,swarm_read"
}
