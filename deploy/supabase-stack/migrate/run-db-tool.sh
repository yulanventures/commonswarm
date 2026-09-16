#!/usr/bin/env bash
set -euo pipefail
exec </dev/null

if [[ $# -ne 2 ]]; then
  echo "usage: run-db-tool.sh <script-name> <absolute-artifact-directory>" >&2
  exit 1
fi
script_name="$1"
artifact_dir="$2"
case "$script_name" in
  dump-source.sh|restore-target.sh|prepare-target.sh|verify-counts.sh|setup-realtime.sh|source-read-only.sh) ;;
  *) echo "unsupported database tool: $script_name" >&2; exit 1 ;;
esac
if [[ "$artifact_dir" != /* ]]; then
  echo "artifact directory must be absolute" >&2
  exit 1
fi
mkdir -p "$artifact_dir"
chmod 0700 "$artifact_dir"

stack_dir="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "required command is missing: node" >&2
  exit 1
fi
service_file="$(mktemp "${TMPDIR:-/tmp}/commonswarm-pg-service.XXXXXX")"
trap 'rm -f "$service_file"' EXIT
chmod 0600 "$service_file"
PG_SERVICE_OUTPUT="$service_file" node "$stack_dir/migrate/make-pg-service.mjs" </dev/null
ca_file="${COMMONSWARM_CA_FILE:-/etc/ssl/yulan-internal-ca.pem}"
ca_mount=()
if [[ -f "$ca_file" ]]; then
  ca_mount=(--volume "$ca_file:/etc/ssl/yulan-internal-ca.pem:ro")
fi
env_names=(
  SOURCE_DATABASE_URL TARGET_DATABASE_URL POSTGRES_PASSWORD BACKUP_RO_PASSWORD
  COMMONSWARM_EDGE_DB_PASSWORD JWT_SECRET JWT_EXP CUTOVER_CONFIRM
  SELF_HOST_TENANT_NAME API_JWT_SECRET API_JWT_JWKS DB_HOST DB_PORT DB_USER
  DB_PASSWORD DB_NAME
)
docker_env=()
for name in "${env_names[@]}"; do
  if [[ -n "${!name:-}" ]]; then docker_env+=(--env "$name"); fi
done

docker run --rm \
  --network commonswarm-net \
  --add-host db.commonswarm.internal:172.31.0.10 \
  "${docker_env[@]}" \
  --env MIGRATION_ARTIFACT_DIR=/artifacts \
  --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
  --volume "$stack_dir:/work:ro" \
  --volume "$artifact_dir:/artifacts" \
  --volume "$service_file:/run/commonswarm-pg-service.conf:ro" \
  "${ca_mount[@]}" \
  --entrypoint /bin/bash \
  public.ecr.aws/supabase/postgres:17.6.1.106 \
  "/work/migrate/$script_name"
