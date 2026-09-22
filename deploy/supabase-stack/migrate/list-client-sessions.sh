#!/usr/bin/env bash
# Read-only detail for client sessions that remain after the cutover freeze tried to end older sessions.
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

database="${1:-source}"
if [[ "$database" != source ]]; then
  echo "usage: list-client-sessions.sh source" >&2
  exit 64
fi
require_commands psql tee
require_vars MIGRATION_ARTIFACT_DIR SOURCE_DATABASE_URL
start_log "list-client-sessions-source"
assert_database_identity source >>"$LOG_FILE" 2>&1

database_psql source --pset=pager=off --command '
  SELECT pid, usename, application_name, backend_start, state
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND backend_type = '\''client backend'\''
  ORDER BY backend_start, pid
' 2>>"$LOG_FILE" | tee -a "$LOG_FILE"

log "complete list-client-sessions-source"
