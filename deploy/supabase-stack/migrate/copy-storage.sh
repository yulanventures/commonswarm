#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands node
require_vars MIGRATION_ARTIFACT_DIR SOURCE_STORAGE_URL SOURCE_SERVICE_ROLE_KEY \
  TARGET_STORAGE_URL TARGET_SERVICE_ROLE_KEY
start_log copy-storage

result="$(node "$MIGRATE_DIR/copy-storage.mjs" 2>>"$LOG_FILE")"
if [[ "$result" != \{"copied":* ]]; then
  log "storage copy did not return its summary"
  exit 1
fi
printf '%s\n' "$result" >>"$LOG_FILE"
copied="$(printf '%s' "$result" | sed -E 's/^\{"copied":([0-9]+).*/\1/')"
log "copied and SHA-256 verified $copied storage objects"
log "complete copy-storage"
