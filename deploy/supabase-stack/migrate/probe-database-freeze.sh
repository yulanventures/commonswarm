#!/usr/bin/env bash
# Proves the write freeze (or its removal) for each database service role, trying both bypasses a session could use:
# SET default_transaction_read_only = off, and BEGIN READ WRITE. An outcome counts only when its cause is known:
# success is "writable", SQLSTATE 25006 (read_only_sql_transaction, which the freeze trigger also raises) is "frozen",
# and any other error fails the probe. A role the connecting role cannot SET ROLE to is NOT probed (on hosted Supabase
# `postgres` cannot assume supabase_admin, supabase_auth_admin or supabase_storage_admin, measured 2026-09-17); the
# operator must acknowledge that exact list, because those roles are covered only by the triggers and the default.
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

expected="${1:-}"
database="${2:-source}"
if [[ ( "$expected" != frozen && "$expected" != writable ) || ( "$database" != source && "$database" != target ) ]]; then
  echo "usage: probe-database-freeze.sh frozen|writable [source|target]" >&2
  exit 64
fi
require_commands psql
require_vars MIGRATION_ARTIFACT_DIR
[[ "$database" == source ]] && require_vars SOURCE_DATABASE_URL || require_vars TARGET_DATABASE_URL
start_log "probe-database-$database-$expected"
assert_database_identity "$database" >>"$LOG_FILE" 2>&1

if [[ "$expected" == frozen ]]; then
  present="$(database_psql "$database" --quiet --tuples-only --no-align \
    --command "SELECT to_regclass('commonswarm_cutover_probe.entries') IS NOT NULL" 2>>"$LOG_FILE")"
  if [[ "$present" != t ]]; then
    log "the freeze probe table is missing; run source-read-only.sh enable first"
    exit 1
  fi
fi

service_roles="postgres,supabase_admin,supabase_auth_admin,supabase_storage_admin,authenticator,anon,authenticated,service_role,commonswarm_edge,swarm_command,swarm_read,swarm_capability"
rows="$(database_psql "$database" --quiet --tuples-only --no-align --field-separator='|' --command "
  SELECT r.rolname, pg_has_role(current_user, r.oid, 'MEMBER')
  FROM pg_roles r
  WHERE r.rolname = ANY (string_to_array('$service_roles', ','))
  ORDER BY r.rolname
" 2>>"$LOG_FILE")"

missing=()
IFS=',' read -r -a wanted <<<"$service_roles"
for role in "${wanted[@]}"; do
  if ! grep -qx "${role}|[tf]" <<<"$rows"; then missing+=("$role"); fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  log "required service roles are missing: ${missing[*]}"
  exit 1
fi

unprobed=()
probed=0
while IFS='|' read -r role member; do
  [[ -n "$role" ]] || continue
  if [[ "$member" != t ]]; then
    unprobed+=("$role")
    continue
  fi
  for bypass in set-default begin-read-write; do
    probe_sql="$(make_temp_sql)"
    errors="$(make_temp_sql)"
    {
      echo '\set VERBOSITY sqlstate'
      if [[ "$bypass" == set-default ]]; then
        echo 'SET default_transaction_read_only = off;'
        echo 'BEGIN;'
      else
        echo 'BEGIN READ WRITE;'
      fi
      echo 'SET LOCAL ROLE :"probe_role";'
      echo 'INSERT INTO commonswarm_cutover_probe.entries DEFAULT VALUES;'
      echo 'ROLLBACK;'
    } >"$probe_sql"
    if [[ "$expected" == writable ]]; then
      # After disable the probe table is gone; recreate it only for the writable probe, then drop it again.
      database_psql "$database" --quiet --command "CREATE SCHEMA IF NOT EXISTS commonswarm_cutover_probe; CREATE TABLE IF NOT EXISTS commonswarm_cutover_probe.entries (probe_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY); GRANT USAGE ON SCHEMA commonswarm_cutover_probe TO \"$role\"; GRANT INSERT ON commonswarm_cutover_probe.entries TO \"$role\"; GRANT USAGE, SELECT ON SEQUENCE commonswarm_cutover_probe.entries_probe_id_seq TO \"$role\"" >>"$LOG_FILE" 2>&1
    fi
    if database_psql "$database" --set="probe_role=$role" --file "$probe_sql" >>"$LOG_FILE" 2>"$errors"; then
      outcome=writable
    elif grep -Eq 'ERROR:[[:space:]]+25006' "$errors"; then
      outcome=frozen
    else
      cat "$errors" >>"$LOG_FILE"
      log "$role $bypass probe failed for a reason other than the freeze (see the SQLSTATE above); nothing was proved"
      rm -f "$probe_sql" "$errors"
      exit 1
    fi
    rm -f "$probe_sql" "$errors"
    if [[ "$outcome" != "$expected" ]]; then
      log "$role $bypass probe was $outcome; expected $expected"
      exit 1
    fi
  done
  probed=$((probed + 1))
done <<<"$rows"

if [[ "$expected" == writable ]]; then
  database_psql "$database" --quiet --command 'DROP SCHEMA IF EXISTS commonswarm_cutover_probe CASCADE' >>"$LOG_FILE" 2>&1
fi

unprobed_csv="$(IFS=','; echo "${unprobed[*]:-}")"
log "$probed service roles were $expected after SET default_transaction_read_only=off and BEGIN READ WRITE"
log "roles this connection cannot assume, so NOT probed: ${unprobed_csv:-none}"
if [[ "${FREEZE_UNPROBED_ROLES+set}" != set || "$FREEZE_UNPROBED_ROLES" != "$unprobed_csv" ]]; then
  log "refusing: set FREEZE_UNPROBED_ROLES to exactly '${unprobed_csv}' to acknowledge the roles this probe cannot prove"
  exit 65
fi
log "complete probe-database-$database-$expected"
