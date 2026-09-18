#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
script_dir="$(cd "$(dirname "$0")" && pwd)"

# 1. Refuse source/unknown args BEFORE env checks and BEFORE ANY target SQL.
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != target ) ]]; then
  echo "usage: apply-h0-upgrade.sh [target]" >&2
  exit 64
fi

source "$script_dir/lib.sh"
require_commands psql sha256sum
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR

# 2. assert_target_identity runs before ANY target SQL, including present-state branch.
assert_target_identity

# 3. Fixed literal SHA pins. No unverified paths.
file1="/migrations/20260916000001_agent_join_credentials.sql"
file2="/migrations/20260916000002_agent_join_attempts.sql"
sha1="e3271bd3b8c0e8f7f80df0ec8cf5141f3dd4c3f09a07dd86418b0f45320b9f50"
sha2="fbd0a9bd76f651b2d11f2500485cc3f4f07fa24de780bb32e50b7ee17c20b801"

if [[ ! -f "$file1" || ! -f "$file2" ]]; then
  echo "migration files missing in /migrations" >&2
  exit 1
fi

if ! echo "$sha1  $file1" | sha256sum -c >/dev/null; then
  echo "SHA256 mismatch for $file1" >&2
  exit 1
fi
if ! echo "$sha2  $file2" | sha256sum -c >/dev/null; then
  echo "SHA256 mismatch for $file2" >&2
  exit 1
fi

start_log "apply-h0-upgrade"

table_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'swarm' AND c.relname IN ('agent_join_credentials', 'agent_join_attempts') AND c.relkind='r';")
# With no H0 tables, leftover H0 guards still indicate a partial upgrade.
# Do not silently overwrite a damaged predecessor with CREATE OR REPLACE.
if [[ "$table_count" -eq 0 ]]; then
  guard_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='swarm' AND p.proname IN ('agent_join_credentials_guard','agent_join_attempts_guard');")
  if [[ "$guard_count" -ne 0 ]]; then
    echo "Corrupt/mixed state: H0 guards exist without H0 tables" >&2
    exit 1
  fi
fi


verify_sql="$(make_temp_sql)"
run_sql="$(make_temp_sql)"
trap 'rm -f "$verify_sql" "$run_sql"' EXIT
cp "$script_dir/verify-h0-catalog.sql" "$verify_sql"

cat >"$run_sql" <<EOF
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
EOF

if [[ "$table_count" -eq 2 ]]; then
  log "Tables already exist, verifying catalog state for idempotent skip"
elif [[ "$table_count" -eq 0 ]]; then
  log "Tables are absent, applying migrations"
  cat >>"$run_sql" <<< "\i $file1"$'\n'"\i $file2"
else
  echo "Corrupt/mixed state: $table_count tables exist" >&2
  exit 1
fi

cat >>"$run_sql" <<< "\i $verify_sql"$'\n'"COMMIT;"
target_psql -v ON_ERROR_STOP=1 --file "$run_sql" >>"$LOG_FILE" 2>&1
log "Catalog verified successfully."
rm -f "$verify_sql" "$run_sql"
