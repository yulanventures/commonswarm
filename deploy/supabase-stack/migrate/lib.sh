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

make_temp_sql() {
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-n-db-sql.XXXXXX")"
  chmod 0600 "$file"
  printf '%s\n' "$file"
}

selected_schema_csv() {
  printf '%s' "auth,public,realtime,storage,supabase_migrations,swarm,swarm_read"
}
