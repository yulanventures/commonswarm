#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands node
require_vars MIGRATION_ARTIFACT_DIR COMMONSWARM_MIGRATION_ENV_FILE
direction="${1:-}"
if [[ "$direction" == reverse ]]; then
  echo "refusing: the hosted project is a read-only reference copy after the window; nothing is restored into it (Strategist ruling 9084e3e1). Objects are copied forward only." >&2
  exit 64
fi
if [[ "$direction" != forward ]]; then
  echo "usage: copy-storage.sh forward" >&2
  exit 64
fi
if [[ "$COMMONSWARM_MIGRATION_ENV_FILE" != /* || ! -f "$COMMONSWARM_MIGRATION_ENV_FILE" ]]; then
  echo "COMMONSWARM_MIGRATION_ENV_FILE must name an existing absolute file" >&2
  exit 1
fi
start_log "copy-storage-$direction"

result="$(node "$MIGRATE_DIR/copy-storage.mjs" "$direction" 2>>"$LOG_FILE")"
if ! copied="$(STORAGE_COPY_SUMMARY="$result" node -e '
  const value = JSON.parse(process.env.STORAGE_COPY_SUMMARY);
  if (!Number.isSafeInteger(value.copied) || value.copied < 0 ||
      value.copied !== value.verified || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    process.exit(1);
  }
  process.stdout.write(String(value.copied));
' 2>>"$LOG_FILE")"; then
  log "storage copy did not return its summary"
  exit 1
fi
printf '%s\n' "$result" >>"$LOG_FILE"
log "copied and SHA-256 verified $copied storage objects"
log "storage.objects metadata must now be restored from database.dump"
log "complete copy-storage-$direction"
