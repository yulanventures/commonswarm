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
  if [[ "$service" != source && "$service" != target && "$service" != backup ]]; then
    echo "database service must be source, target or backup" >&2
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
  -- setrole = 0 is the database value. current_setting() also returns a connection option.
  IF (
    SELECT count(*)
    FROM pg_db_role_setting AS setting
    CROSS JOIN LATERAL unnest(setting.setconfig) AS item
    WHERE setting.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND setting.setrole = 0
      AND item = 'commonswarm.stack_identity=n-db-target-v1'
  ) IS DISTINCT FROM 1 THEN
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

# Read-only backup identity is deliberately separate from every admin/write gate.
assert_backup_ro_identity() {
  database_psql backup --command "
DO \$backup\$
BEGIN
  IF inet_server_addr() IS DISTINCT FROM inet '172.31.0.10'
     OR inet_client_addr() IS DISTINCT FROM inet '172.31.0.1'
     OR current_database() <> 'postgres'
     OR current_setting('commonswarm.stack_identity', true) IS DISTINCT FROM 'n-db-target-v1'
     OR pg_is_in_recovery()
     OR current_setting('transaction_read_only') <> 'on'
     OR NOT EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl)
     OR current_user <> 'backup_ro'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND NOT rolsuper AND rolbypassrls)
     OR NOT pg_has_role(current_user, 'pg_read_all_data', 'USAGE')
  THEN
    RAISE EXCEPTION 'refusing backup: target, transport or read-role identity does not match';
  END IF;
END
\$backup\$;"
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
  if [[ "$service" == backup ]]; then
    assert_backup_ro_identity
    return
  fi
  assert_source_identity
}

# One row per pg_cron job, as JSON. dump-source.sh writes it from the source snapshot to cron-jobs.ndjson.
# restore-cron-jobs.sh and verify-counts.sh run the same query on the target. ORDER BY uses the database
# collation, so hosted Postgres and the box image can emit the same jobs in a different line order
# ('_' before '-' vs the reverse). Comparison is compare_cron_job_listings, a multiset of whole JSON
# records: every field counts, duplicate rows must appear as often, and the original artifact is not
# rewritten. The schedules live in the cron schema, which the selected-schema dump does not carry.
# `postgres` has BYPASSRLS on hosted Supabase and on the box image, so the source export and target
# query see every job regardless of owner.
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

# Compare two cron-jobs.ndjson listings as a multiset of JSON records. Each non-empty line is one
# record with every field; multiplicity is preserved (sort is not unique). Line order is ignored, so
# a collation difference cannot fail a match. expected and actual are not rewritten. Needs sort and
# diff, which the tool container already has; node is not assumed inside the Postgres image.
#
# Callers invoke this under `if ! compare_cron_job_listings`, which disables errexit for the whole
# function and its subshell. Every load-bearing mktemp, chmod, grep, and sort is checked; a failed
# sort must not leave empty temps for diff to treat as a match.
compare_cron_job_listings() {
  local expected="$1"
  local actual="$2"
  require_commands sort diff
  if [[ ! -f "$expected" || ! -f "$actual" ]]; then
    echo "cron job listing is missing" >&2
    return 1
  fi
  if [[ ! -r "$expected" || ! -r "$actual" ]]; then
    echo "cron job listing is unreadable" >&2
    return 1
  fi
  (
    expected_sorted=""
    actual_sorted=""
    cleanup_sorted() {
      [[ -n "$expected_sorted" ]] && rm -f -- "$expected_sorted"
      [[ -n "$actual_sorted" ]] && rm -f -- "$actual_sorted"
    }
    trap cleanup_sorted EXIT

    if ! expected_sorted="$(mktemp "${TMPDIR:-/tmp}/commonswarm-cron-expected.XXXXXX")"; then
      echo "failed to create expected cron sort file" >&2
      exit 1
    fi
    if ! actual_sorted="$(mktemp "${TMPDIR:-/tmp}/commonswarm-cron-actual.XXXXXX")"; then
      echo "failed to create actual cron sort file" >&2
      exit 1
    fi
    if ! chmod 0600 "$expected_sorted" "$actual_sorted"; then
      echo "failed to set mode on cron sort files" >&2
      exit 1
    fi

    expected_count=""
    actual_count=""
    expected_count="$(grep -c . "$expected")" && expected_grep_status=0 || expected_grep_status=$?
    if [[ "$expected_grep_status" -gt 1 ]]; then
      echo "failed to read expected cron job listing" >&2
      exit 1
    fi
    actual_count="$(grep -c . "$actual")" && actual_grep_status=0 || actual_grep_status=$?
    if [[ "$actual_grep_status" -gt 1 ]]; then
      echo "failed to read actual cron job listing" >&2
      exit 1
    fi
    expected_count="${expected_count:-0}"
    actual_count="${actual_count:-0}"

    if ! LC_ALL=C sort "$expected" >"$expected_sorted"; then
      echo "failed to sort expected cron job listing" >&2
      exit 1
    fi
    if ! LC_ALL=C sort "$actual" >"$actual_sorted"; then
      echo "failed to sort actual cron job listing" >&2
      exit 1
    fi
    if [[ "$expected_count" != "$actual_count" ]]; then
      printf 'cron job counts differ: expected %s, actual %s\n' "$expected_count" "$actual_count"
      diff -u "$expected_sorted" "$actual_sorted"
      exit 1
    fi
    diff -u "$expected_sorted" "$actual_sorted"
  )
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
