#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

database="${1:-}"
if [[ "$database" != source && "$database" != target ]]; then
  echo "usage: assert-database-identity.sh source|target" >&2
  exit 64
fi
require_commands psql
require_vars MIGRATION_ARTIFACT_DIR
[[ "$database" == source ]] && require_vars SOURCE_DATABASE_URL || require_vars TARGET_DATABASE_URL
start_log "assert-database-identity-$database"
assert_database_identity "$database" >>"$LOG_FILE" 2>&1
log "$database database identity accepted"
log "complete assert-database-identity-$database"
