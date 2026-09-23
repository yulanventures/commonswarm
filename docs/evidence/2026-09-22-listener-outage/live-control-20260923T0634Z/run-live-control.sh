#!/bin/bash
# Live control for lane/listener-outage: a detached listener built from the lane, on a temporary HOME,
# route main (no model starts), against production through a local proxy that injects one HTTP 500 and one
# HTTP 403 with no CommonSwarm code on the signal read path. Pass: the listener is still running after both.
# Prints no secret: the token file is passed by path; the anon key is public (site meta tag).
set -uo pipefail
SP=/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad
WT=$SP/wt-listener
SEAT=$HOME/.cswarm/connect-4989ea3b-af59-4c74-a9a6-eeaf51154b5d
OUT=$SP/live/out-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
T=$(mktemp -d /private/tmp/cswarm-live-XXXXXX)
mkdir -p "$T/bin"
cp "$WT/dist-release/cswarm" "$T/bin/cswarm"
chmod 700 "$T/bin/cswarm"
PROXY_LOG=$OUT/proxy.log; PORT_FILE=$OUT/port
node "$SP/live/fault-proxy.mjs" "$PROXY_LOG" "$PORT_FILE" &
PROXY_PID=$!
for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
PORT=$(cat "$PORT_FILE")
URL=http://127.0.0.1:$PORT
ANON=$(jq -r .anon_key "$SEAT/profile.json")
WS=$(jq -r .workspace_id "$SEAT/profile.json")
PID_=$(jq -r .principal_id "$SEAT/profile.json")
TOKEN_FILE=$(jq -r .credential_file "$SEAT/profile.json")
cleanup() {
  HOME="$T" "$T/bin/cswarm" listen stop --url "$URL" --anon-key "$ANON" --workspace-id "$WS" --principal-id "$PID_" --json > "$OUT/stop.json" 2>&1
  echo "stop exit $?" >> "$OUT/summary.txt"
  sleep 3
  kill "$PROXY_PID" 2>/dev/null
  pgrep -f "$T" >/dev/null && echo "LEFTOVER PROCESS under $T" >> "$OUT/summary.txt"
  rm -rf "$T"
}
trap cleanup EXIT
echo "version: $("$T/bin/cswarm" --version 2>&1 | head -1)" > "$OUT/summary.txt"
HOME="$T" "$T/bin/cswarm" listen start --agent-token-file "$TOKEN_FILE" --url "$URL" --anon-key "$ANON" \
  --workspace-id "$WS" --provider claude --route main --allow-unattended --poll-interval 5s --json \
  > "$OUT/start.json" 2> "$OUT/start.err"
echo "start exit $?" >> "$OUT/summary.txt"
sleep "${WAIT_SECONDS:-120}"
HOME="$T" "$T/bin/cswarm" listen status --url "$URL" --anon-key "$ANON" --workspace-id "$WS" --principal-id "$PID_" --json \
  > "$OUT/status.json" 2> "$OUT/status.err"
echo "status exit $?" >> "$OUT/summary.txt"
HOME="$T" "$T/bin/cswarm" listen status --url "$URL" --anon-key "$ANON" --workspace-id "$WS" --principal-id "$PID_" \
  > "$OUT/status.txt" 2>&1
jq '{state, lastErrorCode, nextAttemptAt, readHealth, restarts: .restartAttempts, cswarmVersion, pid}' "$OUT/status.json" >> "$OUT/summary.txt" 2>&1
grep -c "INJECT" "$PROXY_LOG" | sed 's/^/injected: /' >> "$OUT/summary.txt"
grep -c "PASS POST /functions/v1/read" "$PROXY_LOG" | sed 's/^/passed reads: /' >> "$OUT/summary.txt"
echo "OUT=$OUT"
