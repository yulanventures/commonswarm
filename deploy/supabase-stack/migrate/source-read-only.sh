#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql
require_vars SOURCE_DATABASE_URL MIGRATION_ARTIFACT_DIR CUTOVER_CONFIRM
if [[ "$CUTOVER_CONFIRM" != "COMMONSWARM_N_DB_WINDOW" ]]; then
  echo "CUTOVER_CONFIRM must be COMMONSWARM_N_DB_WINDOW" >&2
  exit 1
fi
mode="${1:-}"
if [[ "$mode" != "enable" && "$mode" != "disable" ]]; then
  echo "usage: source-read-only.sh enable|disable" >&2
  exit 1
fi
start_log "source-read-only-$mode"

sql_file="$(make_temp_sql)"
trap 'rm -f "$sql_file"' EXIT
if [[ "$mode" == "enable" ]]; then
  cat >"$sql_file" <<'SQL'
SELECT format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database())
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid();
SQL
else
  cat >"$sql_file" <<'SQL'
SET default_transaction_read_only = off;
SELECT format('ALTER DATABASE %I SET default_transaction_read_only = off', current_database())
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid();
SQL
fi

source_psql --file "$sql_file" >>"$LOG_FILE" 2>&1
state="$(source_psql --tuples-only --no-align --command 'SHOW transaction_read_only' 2>>"$LOG_FILE")"
expected="off"
[[ "$mode" == "enable" ]] && expected="on"
if [[ "$state" != "$expected" ]]; then
  log "source read-only state is $state; expected $expected"
  exit 1
fi
log "source transaction_read_only is $state for new sessions; old sessions were terminated"
log "complete source-read-only-$mode"
