#!/usr/bin/env bash
# Recreates the source's pg_cron schedules on the box database. The selected-schema dump carries the purge functions
# but not the cron schema, so without this step the box runs none of the CommonSwarm purge jobs. Each job is scheduled
# as the role that owned it on the source, in ONE transaction, and the target's job list must then equal
# cron-jobs.ndjson byte for byte. Running it again changes nothing: pg_cron replaces a job with the same name and owner.
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

destination="${1:-target}"
if [[ "$destination" == source ]]; then
  echo "refusing: the hosted project is a read-only reference copy after the window; nothing is restored into it (Strategist ruling 9084e3e1). Restore into a box database only." >&2
  exit 64
fi
if [[ "$destination" != target ]]; then
  echo "usage: restore-cron-jobs.sh [target]" >&2
  exit 64
fi
require_commands psql diff
require_vars MIGRATION_ARTIFACT_DIR
require_vars TARGET_DATABASE_URL
start_log "restore-cron-jobs-$destination"

jobs_file="$MIGRATION_ARTIFACT_DIR/cron-jobs.ndjson"
if [[ ! -f "$jobs_file" ]]; then
  log "cron-jobs.ndjson is missing; take the dump with this version of dump-source.sh"
  exit 1
fi
assert_target_identity >>"$LOG_FILE" 2>&1
log "destination identity accepted before cron schedules change"

transaction_sql="$(make_temp_sql)"
listing_sql="$(make_temp_sql)"
target_jobs="$(mktemp "${TMPDIR:-/tmp}/commonswarm-target-cron.XXXXXX")"
trap 'rm -f "$transaction_sql" "$listing_sql" "$target_jobs"' EXIT
chmod 0600 "$target_jobs"

# \copy reads each line whole: CSV with quote and delimiter bytes that JSON text never contains, so the backslash
# escapes inside the JSON reach PostgreSQL unchanged.
cat >"$transaction_sql" <<SQL
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE TEMP TABLE commonswarm_cron_jobs (job json NOT NULL) ON COMMIT DROP;
\\copy commonswarm_cron_jobs (job) FROM '$jobs_file' WITH (FORMAT csv, QUOTE E'\\x01', DELIMITER E'\\x02')
DO \$cron\$
DECLARE
  entry json;
  scheduled bigint;
BEGIN
  FOR entry IN SELECT job FROM commonswarm_cron_jobs ORDER BY job->>'jobname' LOOP
    IF entry->>'database' IS DISTINCT FROM current_database() THEN
      RAISE EXCEPTION 'cron job % runs in database %, not %', entry->>'jobname', entry->>'database', current_database();
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', entry->>'username');
    scheduled := cron.schedule(entry->>'jobname', entry->>'schedule', entry->>'command');
    PERFORM cron.alter_job(job_id := scheduled, active := (entry->>'active')::boolean);
    RESET ROLE;
  END LOOP;
END
\$cron\$;
COMMIT;
SQL
database_psql "$destination" --quiet --file "$transaction_sql" >>"$LOG_FILE" 2>&1

cron_jobs_json_sql >"$listing_sql"
database_psql "$destination" --quiet --tuples-only --no-align --file "$listing_sql" >"$target_jobs" 2>>"$LOG_FILE"
if ! diff -u "$jobs_file" "$target_jobs" >>"$LOG_FILE" 2>&1; then
  log "the target cron jobs differ from cron-jobs.ndjson; see the protected log"
  exit 1
fi
log "$(grep -c . "$target_jobs" || true) cron jobs match cron-jobs.ndjson, each owned by its source role"
log "complete restore-cron-jobs-$destination"
