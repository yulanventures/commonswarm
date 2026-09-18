#!/usr/bin/env bash
set -euo pipefail
exec </dev/null

usage="usage: run-db-tool.sh <script-name> <absolute-artifact-directory> [validated arguments]"
if [[ $# -lt 2 ]]; then
  echo "$usage" >&2
  exit 64
fi
script_name="$1"
artifact_dir="$2"
shift 2

case "$script_name" in
  dump-source.sh)
    [[ $# -le 1 && ( $# -eq 0 || "$1" == source || "$1" == target ) ]] || { echo "$usage" >&2; exit 64; }
    ;;
  restore-target.sh|verify-counts.sh|verify-post-upgrade-counts.sh|restore-storage-metadata.sh|restore-cron-jobs.sh|apply-h0-upgrade.sh)
    # Target only: the hosted project is never a restore destination (ruling 9084e3e1); the script refuses too.
    [[ $# -le 1 && ( $# -eq 0 || "$1" == target ) ]] || { echo "$usage" >&2; exit 64; }
    ;;
  prepare-target.sh|setup-realtime.sh)
    [[ $# -eq 0 ]] || { echo "$usage" >&2; exit 64; }
    ;;
  source-read-only.sh)
    [[ $# -ge 1 && $# -le 2 && ( "$1" == preflight || "$1" == enable || "$1" == disable ) && ( $# -eq 1 || "$2" == source || "$2" == target ) ]] || { echo "$usage" >&2; exit 64; }
    ;;
  probe-database-freeze.sh)
    [[ $# -ge 1 && $# -le 2 && ( "$1" == frozen || "$1" == writable ) && ( $# -eq 1 || "$2" == source || "$2" == target ) ]] || { echo "$usage" >&2; exit 64; }
    ;;
  list-client-sessions.sh)
    [[ $# -eq 1 && "$1" == source ]] || { echo "$usage" >&2; exit 64; }
    ;;
  assert-database-identity.sh)
    [[ $# -eq 1 && ( "$1" == source || "$1" == target ) ]] || { echo "$usage" >&2; exit 64; }
    ;;
  *) echo "unsupported database tool: $script_name" >&2; exit 64 ;;
esac

if [[ "$artifact_dir" != /* ]]; then
  echo "artifact directory must be absolute" >&2
  exit 64
fi
mkdir -p "$artifact_dir"
chmod 0700 "$artifact_dir"

stack_dir="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "required command is missing: node" >&2
  exit 1
fi

service_env="${COMMONSWARM_ENV_FILE:-/home/commonswarm/.env}"
migration_env="${COMMONSWARM_MIGRATION_ENV_FILE:-/home/commonswarm/migration.env}"
for env_file in "$service_env" "$migration_env"; do
  if [[ "$env_file" != /* || ! -f "$env_file" ]]; then
    echo "required 0600 environment file is missing: $env_file" >&2
    exit 1
  fi
  if ! ENV_FILE_TO_CHECK="$env_file" node -e '
    const { statSync } = require("node:fs");
    if ((statSync(process.env.ENV_FILE_TO_CHECK).mode & 0o077) !== 0) process.exit(1);
  ' </dev/null; then
    echo "environment file must have mode 0600: $env_file" >&2
    exit 1
  fi
done

service_file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-pg-service.XXXXXX")"
pass_file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-pg-pass.XXXXXX")"
trap 'rm -f "$service_file" "$pass_file"' EXIT
chmod 0600 "$service_file" "$pass_file"
PG_SERVICE_OUTPUT="$service_file" \
  PG_PASS_OUTPUT="$pass_file" \
  COMMONSWARM_ENV_FILE="$service_env" \
  COMMONSWARM_MIGRATION_ENV_FILE="$migration_env" \
  node "$stack_dir/migrate/make-pg-service.mjs" </dev/null

ca_file="${COMMONSWARM_CA_FILE:-/etc/ssl/yulan-internal-ca.pem}"
ca_mount=()
if [[ -f "$ca_file" ]]; then
  ca_mount=(--volume "$ca_file:/etc/ssl/yulan-internal-ca.pem:ro")
fi

# Window acknowledgements are decided at run time from the preflight output, and CUTOVER_CONFIRM is typed on the command
# that freezes or unfreezes, so all three come from the caller's environment by NAME (docker reads the value itself;
# nothing reaches argv). A name passed with --env overrides the same name in an --env-file.
ack_env=()
for name in CUTOVER_CONFIRM FREEZE_UNGUARDED_TABLES FREEZE_UNPROBED_ROLES; do
  if [[ -n "${!name+x}" ]]; then ack_env+=(--env "$name"); fi
done

migration_mount=()
if [[ "$script_name" == apply-h0-upgrade.sh ]]; then
  repo_dir="$(cd "$stack_dir/../.." && pwd)"
  for migration in 20260916000001_agent_join_credentials.sql 20260916000002_agent_join_attempts.sql; do
    [[ -f "$repo_dir/supabase/migrations/$migration" ]] || {
      echo "required pinned H0 migration missing from release: $migration" >&2
      exit 1
    }
  done
  migration_mount=(--volume "$repo_dir/supabase/migrations:/migrations:ro")
fi

docker run --rm \
  --network "${COMMONSWARM_MIGRATION_NETWORK:-commonswarm-net}" \
  --add-host db.commonswarm.internal:172.31.0.10 \
  --env-file "$service_env" \
  --env-file "$migration_env" \
  --env MIGRATION_ARTIFACT_DIR=/artifacts \
  --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
  --env PGPASSFILE=/run/commonswarm-pg-pass \
  --volume "$stack_dir:/work:ro" \
  --volume "$artifact_dir:/artifacts" \
  --volume "$service_file:/run/commonswarm-pg-service.conf:ro" \
  --volume "$pass_file:/run/commonswarm-pg-pass:ro" \
  ${migration_mount[@]+"${migration_mount[@]}"} \
  ${ack_env[@]+"${ack_env[@]}"} \
  ${ca_mount[@]+"${ca_mount[@]}"} \
  --entrypoint /bin/bash \
  public.ecr.aws/supabase/postgres:17.6.1.147 \
  "/work/migrate/$script_name" "$@"
