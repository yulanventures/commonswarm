#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql diff
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR
start_log verify-counts

source_counts="$MIGRATION_ARTIFACT_DIR/source-counts.tsv"
if [[ ! -f "$source_counts" ]]; then
  log "source-counts.tsv is missing"
  exit 1
fi

query_file="$(make_temp_sql)"
target_counts="$(mktemp "${TMPDIR:-/tmp}/commonswarm-target-counts.XXXXXX.tsv")"
trap 'rm -f "$query_file" "$target_counts"' EXIT
chmod 0600 "$target_counts"
cat >"$query_file" <<'SQL'
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
SELECT format(
  'SELECT %L, count(*)::bigint FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = ANY (string_to_array('auth,public,realtime,storage,supabase_migrations,swarm,swarm_read', ','))
  AND NOT (schemaname = 'realtime' AND tablename = 'messages')
ORDER BY schemaname, tablename
\gexec
SQL

target_psql --file "$query_file" >"$target_counts" 2>>"$LOG_FILE"
if ! diff -u "$source_counts" "$target_counts" >>"$LOG_FILE" 2>&1; then
  log "row-count verification failed; see the protected log"
  exit 1
fi

table_count="$(wc -l <"$target_counts" | tr -d ' ')"
agent_tokens="$(awk -F'|' '$1 == "swarm.agent_tokens" { print $2 }' "$target_counts")"
auth_users="$(awk -F'|' '$1 == "auth.users" { print $2 }' "$target_counts")"
storage_objects="$(awk -F'|' '$1 == "storage.objects" { print $2 }' "$target_counts")"
log "all $table_count table counts match; auth users=$auth_users, agent token rows=$agent_tokens, storage objects=$storage_objects"
log "complete verify-counts"
