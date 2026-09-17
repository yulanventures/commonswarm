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
  echo "usage: restore-storage-metadata.sh [target]" >&2
  exit 64
fi
require_commands psql pg_restore
require_vars MIGRATION_ARTIFACT_DIR
require_vars TARGET_DATABASE_URL
start_log "restore-storage-metadata-$destination"

dump_file="$MIGRATION_ARTIFACT_DIR/database.dump"
if [[ ! -f "$dump_file" ]]; then
  log "database.dump is missing"
  exit 1
fi
assert_target_identity >>"$LOG_FILE" 2>&1
log "destination identity accepted before storage metadata replacement"

restore_sql="$(mktemp "${TMPDIR:-/tmp}/commonswarm-storage-restore.XXXXXX")"
staged_sql="$(mktemp "${TMPDIR:-/tmp}/commonswarm-storage-staged.XXXXXX")"
transaction_sql="$(make_temp_sql)"
trap 'rm -f "$restore_sql" "$staged_sql" "$transaction_sql"' EXIT
chmod 0600 "$restore_sql" "$staged_sql"
pg_restore \
  --data-only \
  --schema=storage \
  --table=objects \
  --exit-on-error \
  --no-owner \
  --file "$restore_sql" \
  "$dump_file" >>"$LOG_FILE" 2>&1 </dev/null
replaced=0
while IFS= read -r line; do
  if [[ "$line" == 'COPY storage.objects ('* ]]; then
    line="COPY commonswarm_storage_metadata (${line#*\(}"
    replaced=$((replaced + 1))
  fi
  printf '%s\n' "$line"
done <"$restore_sql" >"$staged_sql"
if [[ "$replaced" -ne 1 ]]; then
  log "storage.objects dump did not contain one COPY statement"
  exit 1
fi
cat >"$transaction_sql" <<SQL
BEGIN;
CREATE TEMP TABLE commonswarm_storage_metadata
  (LIKE storage.objects INCLUDING DEFAULTS) ON COMMIT DROP;
\i $staged_sql
UPDATE storage.objects AS destination
SET owner = source.owner,
    created_at = source.created_at,
    updated_at = source.updated_at,
    last_accessed_at = source.last_accessed_at,
    metadata = source.metadata,
    owner_id = source.owner_id,
    user_metadata = source.user_metadata
FROM commonswarm_storage_metadata AS source
WHERE destination.bucket_id = source.bucket_id
  AND destination.name = source.name;
COMMIT;
SQL
database_psql "$destination" --file "$transaction_sql" >>"$LOG_FILE" 2>&1

expected="$(awk -F'|' '$1 == "storage.objects" { print $2 }' "$MIGRATION_ARTIFACT_DIR/source-counts.tsv")"
actual="$(database_psql "$destination" --tuples-only --no-align --command 'SELECT count(*) FROM storage.objects' 2>>"$LOG_FILE")"
if [[ -z "$expected" || "$actual" != "$expected" ]]; then
  log "storage metadata count is $actual; expected $expected"
  exit 1
fi
log "restored storage ownership and metadata while preserving destination object ids and backend versions; rows=$actual"
log "complete restore-storage-metadata-$destination"
