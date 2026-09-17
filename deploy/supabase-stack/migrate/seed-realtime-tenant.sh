#!/usr/bin/env bash
set -euo pipefail
exec </dev/null

STACK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
require_var() {
  if [[ -z "${!1:-}" ]]; then
    echo "required environment variable is empty: $1" >&2
    exit 1
  fi
}
require_var MIGRATION_ARTIFACT_DIR
require_var COMMONSWARM_ENV_FILE
require_var COMMONSWARM_MIGRATION_ENV_FILE
if [[ "$MIGRATION_ARTIFACT_DIR" != /* || "$COMMONSWARM_ENV_FILE" != /* ]]; then
  echo "artifact and environment paths must be absolute" >&2
  exit 1
fi
if [[ ! -f "$COMMONSWARM_ENV_FILE" ]]; then
  echo "environment file does not exist" >&2
  exit 1
fi

"$STACK_DIR/migrate/run-db-tool.sh" assert-database-identity.sh \
  "$MIGRATION_ARTIFACT_DIR" target
mkdir -p "$MIGRATION_ARTIFACT_DIR/logs"
chmod 0700 "$MIGRATION_ARTIFACT_DIR" "$MIGRATION_ARTIFACT_DIR/logs"
log_file="$MIGRATION_ARTIFACT_DIR/logs/seed-realtime-tenant.log"
touch "$log_file"
chmod 0600 "$log_file"
log() {
  local line="$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$log_file"
}

project="${COMMONSWARM_COMPOSE_PROJECT:-commonswarm-supabase-stack}"
compose=(--env-file "$COMMONSWARM_ENV_FILE" -p "$project" -f "$STACK_DIR/compose.yaml")
if [[ -n "${COMMONSWARM_COMPOSE_OVERRIDE:-}" ]]; then
  compose+=(-f "$COMMONSWARM_COMPOSE_OVERRIDE")
fi

log "start seed-realtime-tenant"
docker compose "${compose[@]}" stop realtime >>"$log_file" 2>&1 </dev/null || true
docker compose "${compose[@]}" rm -f realtime >>"$log_file" 2>&1 </dev/null || true
docker compose "${compose[@]}" run --rm --no-deps \
  -e SEED_SELF_HOST=true \
  realtime /app/bin/migrate >>"$log_file" 2>&1 </dev/null
docker compose "${compose[@]}" up -d realtime >>"$log_file" 2>&1 </dev/null
log "Realtime application created the encrypted tenant and extension"
log "complete seed-realtime-tenant; now run setup-realtime.sh and restart realtime"
