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
  echo "usage: verify-counts.sh [target]" >&2
  exit 64
fi
require_commands psql diff
require_vars MIGRATION_ARTIFACT_DIR
require_vars TARGET_DATABASE_URL
start_log "verify-counts-$destination"
assert_target_identity >>"$LOG_FILE" 2>&1

source_counts="$MIGRATION_ARTIFACT_DIR/source-counts.tsv"
source_cron_jobs="$MIGRATION_ARTIFACT_DIR/cron-jobs.ndjson"
for file in "$source_counts" "$source_cron_jobs"; do
  if [[ ! -f "$file" ]]; then
    log "$(basename "$file") is missing"
    exit 1
  fi
done

query_file="$(make_temp_sql)"
cron_query="$(make_temp_sql)"
target_counts="$(mktemp "${TMPDIR:-/tmp}/commonswarm-target-counts.XXXXXX")"
target_cron_jobs="$(mktemp "${TMPDIR:-/tmp}/commonswarm-target-cron.XXXXXX")"
trap 'rm -f "$query_file" "$cron_query" "$target_counts" "$target_cron_jobs"' EXIT
chmod 0600 "$target_counts" "$target_cron_jobs"
cat >"$query_file" <<'SQL'
SELECT format(
  'SELECT %L, count(*)::bigint FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = ANY (string_to_array('auth,public,realtime,storage,supabase_migrations,swarm,swarm_read', ','))
  AND NOT (schemaname = 'realtime' AND (tablename = 'messages' OR tablename LIKE 'messages_%'))
  AND NOT (schemaname = 'public' AND tablename IN ('commonswarm_cutover_probe', 'commonswarm_cutover_state'))
ORDER BY schemaname, tablename
\gexec
SQL

database_psql "$destination" --tuples-only --no-align --field-separator '|' --file "$query_file" \
  >"$target_counts" 2>>"$LOG_FILE"
if ! diff -u "$source_counts" "$target_counts" >>"$LOG_FILE" 2>&1; then
  log "row-count verification failed; see the protected log"
  exit 1
fi

cron_jobs_json_sql >"$cron_query"
database_psql "$destination" --quiet --tuples-only --no-align --file "$cron_query" >"$target_cron_jobs" 2>>"$LOG_FILE"
if ! compare_cron_job_listings "$source_cron_jobs" "$target_cron_jobs" >>"$LOG_FILE" 2>&1; then
  log "cron job verification failed; run restore-cron-jobs.sh and see the protected log"
  exit 1
fi

table_count="$(wc -l <"$target_counts" | tr -d ' ')"
agent_tokens="$(awk -F'|' '$1 == "swarm.agent_tokens" { print $2 }' "$target_counts")"
auth_users="$(awk -F'|' '$1 == "auth.users" { print $2 }' "$target_counts")"
storage_objects="$(awk -F'|' '$1 == "storage.objects" { print $2 }' "$target_counts")"
cron_count="$(grep -c . "$target_cron_jobs" || true)"
log "all $table_count table counts match; auth users=$auth_users, agent token rows=$agent_tokens, storage objects=$storage_objects; $cron_count cron jobs match"
log "complete verify-counts-$destination"
