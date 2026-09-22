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
# Order is the apply order: join credentials, join attempts, poll lock and
# batch, then the waiting column.
file1="/migrations/20260916000001_agent_join_credentials.sql"
file2="/migrations/20260916000002_agent_join_attempts.sql"
file3="/migrations/20260922000001_h0_poll_lock_and_batch.sql"
file4="/migrations/20260922000002_h0_poll_wait_admission.sql"
file5="/migrations/20260922000003_h0_poll_batch_retention.sql"
sha1="e3271bd3b8c0e8f7f80df0ec8cf5141f3dd4c3f09a07dd86418b0f45320b9f50"
sha2="fbd0a9bd76f651b2d11f2500485cc3f4f07fa24de780bb32e50b7ee17c20b801"
sha3="beb6bf0fc0a77e24b0a36f1defcb06819e05a6f6f6441cb026879bd64747df3e"
sha4="3d57cf0abc18dced874b8ac4ddd929a9a990c80286b35ff6612fc4a81c2b4992"
sha5="ba059d9d7b14950a89e90bad11ab907deab11a38797e21b54eb90931a78298ac"

if [[ ! -f "$file1" || ! -f "$file2" || ! -f "$file3" || ! -f "$file4" || ! -f "$file5" ]]; then
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
if ! echo "$sha3  $file3" | sha256sum -c >/dev/null; then
  echo "SHA256 mismatch for $file3" >&2
  exit 1
fi
if ! echo "$sha4  $file4" | sha256sum -c >/dev/null; then
  echo "SHA256 mismatch for $file4" >&2
  exit 1
fi
if ! echo "$sha5  $file5" | sha256sum -c >/dev/null; then
  echo "SHA256 mismatch for $file5" >&2
  exit 1
fi

start_log "apply-h0-upgrade"

join_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'swarm' AND c.relname IN ('agent_join_credentials', 'agent_join_attempts') AND c.relkind='r';")
poll_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'swarm' AND c.relname IN ('h0_poll_locks', 'h0_poll_batches') AND c.relkind='r';")
# With no H0 tables, leftover H0 guards still indicate a partial upgrade.
# Do not silently overwrite a damaged predecessor with CREATE OR REPLACE.
if [[ "$join_count" -eq 0 ]]; then
  guard_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='swarm' AND p.proname IN ('agent_join_credentials_guard','agent_join_attempts_guard');")
  if [[ "$guard_count" -ne 0 ]]; then
    echo "Corrupt/mixed state: H0 guards exist without H0 tables" >&2
    exit 1
  fi
fi
if [[ "$poll_count" -eq 0 ]]; then
  poll_guard_count=$(target_psql -t -A -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='swarm' AND p.proname IN ('h0_poll_locks_guard','h0_poll_batches_guard');")
  if [[ "$poll_guard_count" -ne 0 ]]; then
    echo "Corrupt/mixed state: H0 poll guards exist without H0 poll tables" >&2
    exit 1
  fi
fi


verify_sql="$(make_temp_sql)"
run_sql="$(make_temp_sql)"
trap 'rm -f "$verify_sql" "$run_sql"' EXIT
cp "$script_dir/verify-h0-catalog.sql" "$verify_sql"
cat "$script_dir/verify-h0-poll-catalog.sql" >>"$verify_sql"

cat >"$run_sql" <<EOF
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
EOF

if [[ "$join_count" -eq 2 && "$poll_count" -eq 2 ]]; then
  log "Tables already exist, verifying catalog state for idempotent skip"
elif [[ "$join_count" -eq 0 && "$poll_count" -eq 0 ]]; then
  log "Tables are absent, applying migrations"
  cat >>"$run_sql" <<< "\i $file1"$'\n'"\i $file2"$'\n'"\i $file3"$'\n'"\i $file4"$'\n'"\i $file5"
elif [[ "$join_count" -eq 2 && "$poll_count" -eq 0 ]]; then
  log "Join tables exist, applying poll migrations"
  cat >>"$run_sql" <<< "\i $file3"$'\n'"\i $file4"$'\n'"\i $file5"
else
  echo "Corrupt/mixed state: $join_count join tables and $poll_count poll tables exist" >&2
  exit 1
fi

cat >>"$run_sql" <<< "\i $verify_sql"$'\n'"COMMIT;"
target_psql -v ON_ERROR_STOP=1 --file "$run_sql" >>"$LOG_FILE" 2>&1
log "Catalog verified successfully."
rm -f "$verify_sql" "$run_sql"
