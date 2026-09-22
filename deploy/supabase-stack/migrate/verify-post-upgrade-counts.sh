#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != target ) ]]; then
  echo 'usage: verify-post-upgrade-counts.sh [target]' >&2
  exit 64
fi
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/lib.sh"
require_commands psql awk cp mktemp
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR
start_log verify-post-upgrade-counts
assert_target_identity >>"$LOG_FILE" 2>&1
for name in source-counts.tsv cron-jobs.ndjson; do
  [[ -f "$MIGRATION_ARTIFACT_DIR/$name" ]] || { log "missing baseline $name"; exit 1; }
done
# Keep the original baseline unchanged. Derived evidence and verifier logs remain
# in this private directory, separately from the source snapshot.
derived="$(mktemp -d "$MIGRATION_ARTIFACT_DIR/h0-expected.XXXXXX")"
chmod 0700 "$derived"
cp "$MIGRATION_ARTIFACT_DIR/cron-jobs.ndjson" "$derived/cron-jobs.ndjson"
existing_purge_count=$(python3 - "$MIGRATION_ARTIFACT_DIR/cron-jobs.ndjson" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as source:
    jobs = [json.loads(line) for line in source if line.strip()]
print(sum(job.get('jobname') == 'swarm-purge-h0-poll-batches' for job in jobs))
PY
)
if [[ "$existing_purge_count" -eq 0 ]]; then
  target_psql --quiet --tuples-only --no-align -c "
  SELECT json_build_object(
    'jobname', 'swarm-purge-h0-poll-batches',
    'schedule', '29 4 * * *',
    'command', 'SELECT swarm.purge_expired_h0_poll_batches()',
    'database', current_database(),
    'username', current_user,
    'active', true
  )
" >>"$derived/cron-jobs.ndjson" 2>>"$LOG_FILE"
fi
cat >"$derived/table-names.sql" <<'SQL'
SELECT schemaname || '.' || tablename
FROM pg_tables
WHERE schemaname = ANY (string_to_array('auth,public,realtime,storage,supabase_migrations,swarm,swarm_read', ','))
  AND NOT (schemaname = 'realtime' AND (tablename = 'messages' OR tablename LIKE 'messages_%'))
  AND NOT (schemaname = 'public' AND tablename IN ('commonswarm_cutover_probe', 'commonswarm_cutover_state'))
ORDER BY schemaname, tablename;
SQL
target_psql --quiet --tuples-only --no-align --file "$derived/table-names.sql" >"$derived/target-table-names.txt" 2>>"$LOG_FILE"
# The DB's order is used only after exact set comparison. It cannot add an
# unexpected table or hide a missing table. Existing counts never change.
awk -F'|' '
  function fail() { bad=1; exit 1 }
  FILENAME==ARGV[1] {
    if (NF!=2 || $1=="" || $2!~/^[0-9]+$/ || ($1 in expected)) fail()
    expected[$1]=$2; total++; next
  }
  FILENAME==ARGV[2] {
    if (!initialized) {
      a=("swarm.agent_join_credentials" in expected)
      b=("swarm.agent_join_attempts" in expected)
      if (a!=b || total==0) fail()
      if (!a) {
        expected["swarm.agent_join_credentials"]=0
        expected["swarm.agent_join_attempts"]=0
        total+=2
      }
      c=("swarm.h0_poll_locks" in expected)
      d=("swarm.h0_poll_batches" in expected)
      if (c!=d) fail()
      if (!c) {
        expected["swarm.h0_poll_locks"]=0
        expected["swarm.h0_poll_batches"]=0
        total+=2
      }
      initialized=1
    }
    if (NF!=1 || !($1 in expected) || ($1 in seen)) fail()
    seen[$1]=1; found++
    print $1 "|" expected[$1]
  }
  END { if (bad || !initialized || found!=total) exit 1 }
' "$MIGRATION_ARTIFACT_DIR/source-counts.tsv" "$derived/target-table-names.txt" >"$derived/source-counts.tsv" || {
  log "invalid baseline or unexpected post-upgrade table set; see $derived"; exit 1;
}
MIGRATION_ARTIFACT_DIR="$derived" bash "$script_dir/verify-counts.sh" target >>"$LOG_FILE" 2>&1
log "all baseline row counts and cron jobs match after H0; expected counts and logs: $derived"
