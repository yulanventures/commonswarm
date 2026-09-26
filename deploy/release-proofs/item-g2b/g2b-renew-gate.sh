#!/bin/bash
# Item G lane 2b in-window renew gate. Run by the lead after the new edge is live.
# Usage: g2b-renew-gate.sh <release-checkout> <seed-dir> <url> <workspace-id> [--release]
set -uo pipefail

usage() {
  echo "usage: g2b-renew-gate.sh <release-checkout> <seed-dir> <url> <workspace-id> [--release]"
  exit 2
}

[ "$#" -eq 4 ] || { [ "$#" -eq 5 ] && [ "$5" = "--release" ]; } || usage

RELEASE_CHECKOUT=$1
SEED_DIR=$2
URL=$3
WORKSPACE_ID=$4
MODE=${5:-}

file_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

[ -d "$RELEASE_CHECKOUT" ] || { echo "input: release checkout is not a directory"; exit 2; }
[ -f "$RELEASE_CHECKOUT/dist/cloud/wake-lease.js" ] || {
  echo "input: release checkout has no built wake-lease client; run npm run build"
  exit 2
}
[ -f "$RELEASE_CHECKOUT/dist/cloud/agent-check.js" ] || {
  echo "input: release checkout has no built check client; run npm run build"
  exit 2
}
[ -d "$SEED_DIR" ] && [ "$(file_mode "$SEED_DIR")" = 700 ] || {
  echo "input: seed directory must exist with mode 0700"
  exit 2
}
SEED_DIR=$(CDPATH= cd -- "$SEED_DIR" && pwd) || {
  echo "input: seed directory cannot be resolved"
  exit 2
}
for name in credential.json principal.json anon-key.txt; do
  path="$SEED_DIR/$name"
  [ -f "$path" ] && [ "$(file_mode "$path")" = 600 ] || {
    echo "input: $name must exist with mode 0600"
    exit 2
  }
done

ROUNDS=${G2B_RENEW_GATE_ROUNDS:-50}
case "$ROUNDS" in
  ''|*[!0-9]*) echo "input: G2B_RENEW_GATE_ROUNDS must be an integer from 1 to 50"; exit 2 ;;
esac
[ "$ROUNDS" -ge 1 ] && [ "$ROUNDS" -le 50 ] || {
  echo "input: G2B_RENEW_GATE_ROUNDS must be an integer from 1 to 50"
  exit 2
}

umask 077
mkdir -p "$SEED_DIR/agent-state"
chmod 0700 "$SEED_DIR/agent-state"
export SWARM_AGENT_STATE_DIR="$SEED_DIR/agent-state"

HELPER="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/g2b-renew-gate.mjs"
exec node "$HELPER" "$RELEASE_CHECKOUT" "$SEED_DIR" "$URL" "$WORKSPACE_ID" "$ROUNDS" "$MODE"
