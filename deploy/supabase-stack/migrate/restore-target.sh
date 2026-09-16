#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql pg_restore
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR
start_log restore-target

for file in roles.sql database.dump manifest.txt source-counts.tsv storage-objects.ndjson; do
  if [[ ! -f "$MIGRATION_ARTIFACT_DIR/$file" ]]; then
    log "required artifact is missing: $file"
    exit 1
  fi
done

target_psql --file "$MIGRATION_ARTIFACT_DIR/roles.sql" >>"$LOG_FILE" 2>&1
log "application roles restored without passwords"

service_file="${PGSERVICEFILE:-}"
remove_service=false
if [[ -z "$service_file" ]]; then
  require_commands node
  service_file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-pg-service.XXXXXX.conf")"
  chmod 0600 "$service_file"
  PG_SERVICE_OUTPUT="$service_file" node "$MIGRATE_DIR/make-pg-service.mjs" </dev/null
  remove_service=true
fi
cleanup() {
  if [[ "$remove_service" == true ]]; then rm -f "$service_file"; fi
}
trap cleanup EXIT

PGSERVICEFILE="$service_file" PGSERVICE=target pg_restore \
  --clean \
  --if-exists \
  --exit-on-error \
  --single-transaction \
  --dbname service=target \
  "$MIGRATION_ARTIFACT_DIR/database.dump" \
  >>"$LOG_FILE" 2>&1 </dev/null

log "selected schemas restored in one transaction"
log "complete restore-target; run prepare-target.sh, setup-realtime.sh, and verify-counts.sh"
