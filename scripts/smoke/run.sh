#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329
# Single-quoted bash -c scripts expand in the child; cleanup functions run via trap.
# Linux-only smoke workflow entry.
set -eu
set +x
# Builtins only: no child may inherit the still-exported OP ingress token.
if [ ! -r /proc/sys/kernel/ostype ] || ! IFS= read -r CS_KERNEL < /proc/sys/kernel/ostype || [ "$CS_KERNEL" != Linux ]; then
  printf '%s\n' 'Linux runner required.' >&2
  exit 1
fi
unset CS_KERNEL
umask 077
# Linux Bash clock uses a builtin before any credential access or child.
# Whole seconds make the deadline conservative by less than one second.
printf -v CS_START_SECONDS '%(%s)T' -1
CS_START_MS=$((CS_START_SECONDS * 1000))
# Copy ingress with shell builtins, then unset before the FIRST child (even date).
unset CS_OP_INGRESS
CS_OP_INGRESS=${OP_SERVICE_ACCOUNT_TOKEN:-}
unset OP_SERVICE_ACCOUNT_TOKEN
CS_OWNER=$$
CS_CHILD=
CS_WATCHDOG=
CS_SECRET_DIR=
CS_CLEANUP=REMOVED
CS_ROTATION=none
CS_EXIT=0
CS_EVIDENCE_DIR=${CS_EVIDENCE_DIR:?set an absolute evidence directory}
# Watchdog starts before setup/credential commands. It reserves 20 s for cleanup.
# Every owned child group is separately bounded. The watchdog is joined on exit.
setsid bash -c 'sleep 280; kill -TERM "$1" 2>/dev/null || exit 0; sleep 20; kill -KILL "$1" 2>/dev/null || true' cs-watchdog "$CS_OWNER" &
CS_WATCHDOG=$!
stop_group() {
  [ -n "$CS_CHILD" ] || return 0
  # Chromium can start a detached process group. Enumerate verified descendants
  # BEFORE their Node owner dies, not merely the timeout leader's process group.
  CS_TREE_FILE="$CS_EVIDENCE_DIR/owned-processes.private"
  timeout --signal=TERM --kill-after=0.5s 1s bash -c '
    collect() {
      for pid in $(pgrep -P "$1" || true); do
        collect "$pid"
        if [ -r "/proc/$pid/stat" ]; then
          IFS= read -r stat < "/proc/$pid/stat" || continue
          read -ra fields <<< "${stat##*) }"
          printf "%s %s\n" "$pid" "${fields[19]}"
        fi
      done
    }
    collect "$1"
  ' cs-owned "$CS_CHILD" > "$CS_TREE_FILE" 2>/dev/null || CS_CLEANUP=CHILD_STOP_TIMEOUT
  for CS_SIGNAL in TERM KILL; do
    while read -r CS_PID CS_BORN; do
      case "$CS_PID:$CS_BORN" in *[!0-9:]*|:*) continue ;; esac
      [ -r "/proc/$CS_PID/stat" ] || continue
      IFS= read -r CS_STAT < "/proc/$CS_PID/stat" || continue
      read -ra CS_FIELDS <<< "${CS_STAT##*) }"
      # PID plus kernel start-time prevents signaling a reused PID.
      if [ "${CS_FIELDS[19]}" = "$CS_BORN" ]; then kill -"$CS_SIGNAL" "$CS_PID" 2>/dev/null || true; fi
    done < "$CS_TREE_FILE"
    kill -"$CS_SIGNAL" -- "-$CS_CHILD" 2>/dev/null || true
    if [ "$CS_SIGNAL" = TERM ]; then sleep 0.5; fi
  done
  CS_JOIN=0
  while kill -0 "$CS_CHILD" 2>/dev/null && [ "$CS_JOIN" -lt 5 ]; do
    sleep 0.1; CS_JOIN=$((CS_JOIN + 1))
  done
  if kill -0 "$CS_CHILD" 2>/dev/null; then CS_CLEANUP=CHILD_JOIN_TIMEOUT
  else wait "$CS_CHILD" 2>/dev/null || true; fi
  CS_CHILD=
  # This private status-only scratch file is excluded from artifacts. Do not use
  # a deletion API if the installed guard refuses even this path.
  if ! timeout --signal=TERM --kill-after=0.5s 1s rm -f "$CS_TREE_FILE" 2>/dev/null; then
    CS_CLEANUP=DELETE_REFUSED
    printf '%s\n' 'BLOCKED by rm guard: "owned-process capture removal refused (details redacted)". To resolve: HezLead must inspect the ephemeral runner before disposal.' > "$CS_EVIDENCE_DIR/refusal.txt"
  fi
}
cleanup() {
  trap - EXIT INT TERM
  unset CS_OP_INGRESS
  # Successors are staged synchronously before OP is spawned. Join/kill the group
  # before encryption; rotation.inflight covers loss before a successor was staged.
  stop_group
  if [ -n "$CS_SECRET_DIR" ] && [ -d "$CS_SECRET_DIR" ]; then
    if [ -f "$CS_SECRET_DIR/rotation.saved" ]; then CS_ROTATION=saved
    elif [ -f "$CS_SECRET_DIR/rotation.pending" ]; then
      CS_ROTATION=pending
      if timeout --signal=TERM --kill-after=0.5s 5s age -r "${CS_RECOVERY_RECIPIENT:-}" \
        -o "$CS_SECRET_DIR/refresh-recovery.age" "$CS_SECRET_DIR/item-next.json" \
        > "$CS_SECRET_DIR/age.out" 2> "$CS_SECRET_DIR/age.err" && \
        [ -s "$CS_SECRET_DIR/refresh-recovery.age" ] && \
        timeout --signal=TERM --kill-after=0.5s 1s mv "$CS_SECRET_DIR/refresh-recovery.age" "$CS_EVIDENCE_DIR/refresh-recovery.age"; then
        CS_ROTATION=recovery_encrypted
      else CS_ROTATION=recovery_lost; fi
    elif [ -f "$CS_SECRET_DIR/rotation.inflight" ]; then CS_ROTATION=successor_unknown
    elif [ -f "$CS_SECRET_DIR/fixture.armed" ]; then CS_ROTATION=arm_unknown
    fi
    # Ephemeral-container policy: no plaintext hold promise. Encryption loss blocks the
    # fixture and requires a fresh grant. Never bypass a PATH-based rm refusal.
    CS_DELETE_OK=false
    case "$CS_SECRET_DIR" in /tmp/anvil-secret.*) CS_DELETE_OK=true ;; esac
    if [ "$CS_DELETE_OK" = true ] && [ "$CS_SECRET_DIR" != / ] && \
      [ "$CS_SECRET_DIR" != "$HOME" ] && [ ! -L "$CS_SECRET_DIR" ] && \
      [ "$(cd "$CS_SECRET_DIR" && pwd -P)" = "$CS_SECRET_DIR" ]; then
      # Capture refusal outside the directory being deleted. This file stays
      # private and is never an artifact. Redact it before report finalization.
      CS_RM_ERROR=$(mktemp /tmp/cs-smoke-rm.XXXXXX)
      if ! timeout --signal=TERM --kill-after=0.5s 1s rm -rf "$CS_SECRET_DIR" 2> "$CS_RM_ERROR"; then
        CS_CLEANUP=DELETE_REFUSED
        printf '%s\n' "BLOCKED by rm guard: \"[refusal text redacted pending bounded sanitizer]\". To resolve: HezLead must review $CS_SECRET_DIR on this ephemeral runner before disposal." > "$CS_EVIDENCE_DIR/refusal.txt"
        timeout --signal=TERM --kill-after=0.5s 1s node "$CS_PROBE_ROOT/smoke.mjs" refusal \
          "$CS_RM_ERROR" "$CS_EVIDENCE_DIR/refusal.txt" "$CS_SECRET_DIR" || true
      fi
      # Remove only the checked file created above, through the same PATH guard.
      case "$CS_RM_ERROR" in /tmp/cs-smoke-rm.*)
        if ! timeout --signal=TERM --kill-after=0.5s 1s rm -f "$CS_RM_ERROR" 2> "$CS_EVIDENCE_DIR/capture-refusal.private"; then
          printf '%s\n' 'BLOCKED by rm guard: "refusal capture removal refused (details redacted)". To resolve: HezLead must inspect the ephemeral runner before disposal.' > "$CS_EVIDENCE_DIR/refusal.txt"
          CS_CLEANUP=DELETE_REFUSED
          timeout --signal=TERM --kill-after=0.5s 0.5s node "$CS_PROBE_ROOT/smoke.mjs" refusal \
            "$CS_EVIDENCE_DIR/capture-refusal.private" "$CS_EVIDENCE_DIR/refusal.txt" "$CS_SECRET_DIR" || true
        fi ;;
      esac
    else
      CS_CLEANUP=PATH_REFUSED
      printf '%s\n' 'BLOCKED by path guard: "secret directory path check refused". To resolve: HezLead must review the path before cleanup.' > "$CS_EVIDENCE_DIR/refusal.txt"
    fi
  fi
  timeout --signal=TERM --kill-after=0.5s 2s node "$CS_PROBE_ROOT/smoke.mjs" finalize \
    "$CS_EVIDENCE_DIR" "$CS_CLEANUP" "$CS_START_MS" "$CS_EVIDENCE_DIR/refusal.txt" "$CS_ROTATION" "$CS_EXIT" || true
  # Final result.json/report.md must exist and be finalized. Absent evidence fails
  # the workflow. It must block fixture use if rotation cannot be proven.
  if [ -n "$CS_WATCHDOG" ]; then
    kill -KILL -- "-$CS_WATCHDOG" 2>/dev/null || true
    if ! kill -0 "$CS_WATCHDOG" 2>/dev/null; then wait "$CS_WATCHDOG" 2>/dev/null || true; fi
  fi
}
# Traps precede reading the fixture or staging ingress to disk.
trap cleanup EXIT
trap 'exit 130' INT
trap 'CS_EXIT=124; exit 124' TERM
CS_PROBE_ROOT=$(cd "$(dirname "$0")" && pwd -P)
: "${CS_TOOL_ROOT:?absolute preinstalled tool directory}"
: "${CS_RECOVERY_RECIPIENT:?age public recipient}"
case "$CS_EVIDENCE_DIR" in /*) ;; *) exit 1 ;; esac
mkdir -p "$CS_EVIDENCE_DIR"
CS_SECRET_DIR=$(mktemp -d /tmp/anvil-secret.XXXXXX)
chmod 0700 "$CS_SECRET_DIR"
printf '%s' "$CS_OP_INGRESS" > "$CS_SECRET_DIR/op-token.txt"
unset CS_OP_INGRESS
[ -s "$CS_SECRET_DIR/op-token.txt" ]
command -v timeout >/dev/null
command -v setsid >/dev/null
command -v op >/dev/null
command -v age >/dev/null
# Bounded setup and probe descendants share a fresh process group. No OP ingress
# token is inherited. Only explicitly authorized op children read the staged file.
setsid bash -eu -c '
  secret=$1; evidence=$2; probe=$3; start=$4
  timeout --foreground --signal=TERM --kill-after=1s 2s node "$probe/smoke.mjs" init "$evidence" "$start" \
    "${RELEASE_KIND:-}" "${RELEASE_SHA:-}" "${RELEASE_UTC:-}" "${SITE_SHA:-}" "${PROBE_SHA:-}" "${WORKFLOW_REF:-}" "${WORKFLOW_SHA:-}" "${CS_ACTUAL_PROBE_SHA:-}" "${CS_ACTUAL_WORKFLOW_SHA:-}"
  printf "%s" "CommonSwarm smoke recovery control" > "$secret/recovery-control.txt"
  timeout --foreground --signal=TERM --kill-after=1s 2s age -r "$CS_RECOVERY_RECIPIENT" -o "$secret/control.age" \
    "$secret/recovery-control.txt" > "$secret/age.out" 2> "$secret/age.err"
  timeout --foreground --signal=TERM --kill-after=1s 12s bash -c '\''OP_SERVICE_ACCOUNT_TOKEN="$(cat "$1/op-token.txt")" exec op item get "CommonSwarm smoke test account" --vault "Yulan Ventures Infra" --format=json'\'' cs-op "$secret" > "$secret/item.json" 2> "$secret/op-get.err"
  node "$probe/smoke.mjs" run "$secret" "$evidence" "$CS_TOOL_ROOT" "$start"
' cs-smoke "$CS_SECRET_DIR" "$CS_EVIDENCE_DIR" "$CS_PROBE_ROOT" "$CS_START_MS" \
  > "$CS_SECRET_DIR/probe.out" 2> "$CS_SECRET_DIR/probe.err" &
CS_CHILD=$!
CS_EXIT=0
wait "$CS_CHILD" || CS_EXIT=$?
# The entry watchdog bounds wait; it signals this wrapper before the worker, so
# cleanup can enumerate detached children while their owner is still alive.
# Preserve the group ID for cleanup even when its leader has exited. Chromium or
# abandoned OP descendants must not outlive this invocation.
exit "$CS_EXIT"
