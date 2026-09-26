#!/bin/bash
# The ONE wrapper for every local gate run (HezLead ruling, 2026-09-26, after the 2026-09-25 home deletion).
#
#   scripts/run-gates.sh <worktree> <log-file> <base-ref> [gates|server|cli-file <path>]
#
# It refuses to run a test with the passwd home as HOME. It creates the test home itself
# (T under /tmp), runs every gate as `env HOME="$T" <cmd>`, and after the run it fails if anything
# appeared under the real ~/.cswarm or ~/.config/cswarm. It deletes only $T. HOME is never assigned.
set -uo pipefail
wt=${1:?worktree}; log=${2:?log file}; base=${3:?base ref}; mode=${4:-gates}; extra=${5:-}
real_home="$(eval printf '%s' "~$(id -un)")"
T=$(mktemp -d /tmp/lane-home.XXXXXX) || exit 1
case "$T" in /tmp/*|/private/tmp/*) ;; *) echo "refuse: temp home $T is not under /tmp" >&2; exit 3;; esac
[ "$T" != "$real_home" ] || { echo "refuse: temp home equals the passwd home" >&2; exit 3; }
[ -d "$wt" ] || { echo "refuse: no worktree at $wt" >&2; exit 3; }
snapshot() { # every write class: the two cswarm trees in full, plus the top-level names under the home, .config and .claude
  for d in "$real_home/.cswarm" "$real_home/.config/cswarm"; do [ -e "$d" ] && find "$d" -mindepth 1 -print 2>/dev/null; done
  # Top levels by NAME only: on this shared host other agents change mtimes under their own directories every
  # few seconds (measured 2026-09-26: ~/.hermes and ~/.grokbot during a 20 s control run), so mtimes are noise here.
  for d in "$real_home" "$real_home/.config" "$real_home/.claude"; do [ -d "$d" ] && find "$d" -mindepth 1 -maxdepth 1 -print 2>/dev/null; done
  } 
before=$(snapshot | sort)
run() { # run one gate command under the temp home, in its own process group; kill what it leaves behind
  echo "== $1" >> "$log"
  ( cd "$wt" && exec env -u FORCE_COLOR HOME="$T" perl -e 'setpgrp(0,0); exec @ARGV' bash -c "$1" ) >> "$log" 2>&1 &
  local pgid=$!; wait "$pgid"; local rc=$?
  pkill -g "$pgid" 2>/dev/null; sleep 2
  if pgrep -g "$pgid" >/dev/null 2>&1; then
    echo "SURVIVORS after gate (killed with -9):" | tee -a "$log"; ps -o pid,command -g "$pgid" 2>/dev/null | tail -n +2 | tee -a "$log"
    kill -9 -- -"$pgid" 2>/dev/null; rc=1; fi
  echo "EXIT $rc :: $1" | tee -a "$log"; return $rc; }
: > "$log"; echo "home=$T (passwd home is not used)" >> "$log"
status=0
case "$mode" in
  gates)
    for c in "npm run build" "npm test" "npm run test:p1-cli" "npm run check:tests" "npm run check:edge" \
             "npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js" \
             "bash scripts/build-release.sh" "npm --prefix site run build" "git diff --check $base...HEAD"; do
      run "$c" || status=1; done ;;
  server)
    # The local stack: a fresh volume has no swarm_read schema yet, PostgREST fails its health check, so start
    # with --ignore-health-check and let db reset create the schemas.
    ( cd "$wt" && npx supabase stop; npx supabase start --ignore-health-check; npm run db:reset ) >> "$log" 2>&1 || { echo "stack reset FAILED (see $log)" | tee -a "$log"; status=1; }
    [ $status = 0 ] && { run "npm run build:command-core >/dev/null && npm run test:p1-server" || status=1; } ;;
  cli-file) run "npx tsx --test --test-timeout=600000 \"$extra\"" || status=1 ;;
  *) echo "unknown mode $mode" >&2; status=3 ;;
esac
grep -E "^ℹ (tests|pass|fail)" "$log" | paste -sd' ' - ; grep "^✖" "$log" | grep -v failing | sed 's/ (.*//' | sort -u | head -12
after=$(snapshot | sort)
if [ "$before" != "$after" ]; then
  echo "GATE FAILED: the real home changed during the run:" | tee -a "$log"; diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tee -a "$log"; status=1; fi
rm -rf -- "$T"
echo "run-gates: status=$status log=$log"; exit $status
