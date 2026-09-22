#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

destination="${1:-target}"
if [[ "$destination" == source ]]; then
  echo "refusing: the hosted project is a read-only reference copy after the window; nothing is restored into it (Strategist ruling 9084e3e1). Restore into a box database only." >&2
  exit 64
fi
if [[ "$destination" != target ]]; then
  echo "usage: restore-target.sh [target]" >&2
  exit 64
fi
require_commands psql pg_restore
require_vars MIGRATION_ARTIFACT_DIR
require_vars TARGET_DATABASE_URL
start_log "restore-$destination"

for file in roles.sql database.dump manifest.txt source-counts.tsv storage-objects.ndjson; do
  if [[ ! -f "$MIGRATION_ARTIFACT_DIR/$file" ]]; then
    log "required artifact is missing: $file"
    exit 1
  fi
done

: "${PGSERVICEFILE:?run through run-db-tool.sh so database credentials stay in protected files}"

raw_list="$(mktemp "${TMPDIR:-/tmp}/commonswarm-restore-list.XXXXXX")"
restore_list="$(mktemp "${TMPDIR:-/tmp}/commonswarm-restore-filtered.XXXXXX")"
trap 'rm -f "$raw_list" "$restore_list"' EXIT
chmod 0600 "$raw_list" "$restore_list"
pg_restore --list "$MIGRATION_ARTIFACT_DIR/database.dump" >"$raw_list"
while IFS= read -r line; do
  case "$line" in
    *commonswarm_cutover_write_freeze*|*commonswarm_cutover_write_guard*) continue ;;
  esac
  printf '%s\n' "$line"
done <"$raw_list" >"$restore_list"
excluded_count=$(( $(wc -l <"$raw_list") - $(wc -l <"$restore_list") ))
log "$excluded_count temporary cutover trigger and guard entries excluded from restore"

assert_target_identity >>"$LOG_FILE" 2>&1
log "destination identity accepted before destructive restore"

database_psql "$destination" --file "$MIGRATION_ARTIFACT_DIR/roles.sql" >>"$LOG_FILE" 2>&1
log "application roles restored without passwords"

PGSERVICE="$destination" pg_restore \
  --clean \
  --if-exists \
  --exit-on-error \
  --single-transaction \
  --use-list "$restore_list" \
  --dbname "service=$destination" \
  "$MIGRATION_ARTIFACT_DIR/database.dump" \
  >>"$LOG_FILE" 2>&1 </dev/null

log "selected schemas restored in one transaction to $destination"
log "complete restore-$destination"
