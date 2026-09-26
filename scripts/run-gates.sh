#!/bin/bash
# The ONE wrapper for every local gate run (HezLead ruling, 2026-09-26, after the 2026-09-25 home deletion).
#
#   scripts/run-gates.sh <worktree> <log-file> <base-ref> [gates|site|p1-cli|cli-file <path>|server]
#
# It refuses to run a test with the passwd home as HOME. It creates the test home itself
# (T under /tmp), runs every gate as `env HOME="$T" <cmd>`, and after the run it fails if anything
# appeared under the real ~/.cswarm or ~/.config/cswarm. It deletes only $T. HOME is never assigned.
#
# No docker on this host (HezLead ruling, 2026-09-26): any call to the docker CLI starts OrbStack, and the
# test files that need a container call `docker version` or `docker image inspect` first to decide whether to
# skip. Every gate runs with blocking stand-ins for docker, docker-compose, orb, orbctl and supabase first on
# PATH: each one logs its argv and exits 1, so those tests skip and are listed as NOT RUN. `gates` runs the static
# gates and `npm test` only; `site` runs the site build only. No browser on this host either: the site tests start a
# headless Chrome per case and each one raises a Keychain dialog on the operator's screen. The server suite and the
# site tests run in .github/workflows/server-suite.yml (suite server or site), and `server` mode is refused here.
# `p1-cli` runs `npm run test:p1-cli` here under HezLead's terms of 2026-09-26: memory pressure at level 1 (normal)
# before the run, OrbStack off before the run, no other run of this wrapper active, and the run is killed and fails
# the moment OrbStack appears.
set -uo pipefail
wt=${1:?worktree}; log=${2:?log file}; base=${3:?base ref}; mode=${4:-gates}; extra=${5:-}
real_home="$(eval printf '%s' "~$(id -un)")"
T=$(mktemp -d /tmp/lane-home.XXXXXX) || exit 1
case "$T" in /tmp/*|/private/tmp/*) ;; *) echo "refuse: temp home $T is not under /tmp" >&2; exit 3;; esac
[ "$T" != "$real_home" ] || { echo "refuse: temp home equals the passwd home" >&2; exit 3; }
[ -d "$wt" ] || { echo "refuse: no worktree at $wt" >&2; rm -rf -- "$T"; exit 3; }
wt=$(cd "$wt" && pwd -P) || { rm -rf -- "$T"; exit 3; }   # absolute, so the ancestor walk below ends at /
shims="$T/.gate-bin"; mkdir "$shims" || { rm -rf -- "$T"; exit 1; }
for b in docker docker-compose orb orbctl supabase; do
  printf '#!/bin/sh\nprintf "%%s %%s\\n" "${0##*/}" "$(printf "%%s" "$*" | tr "\\n" " ")" >> "%s/calls"\necho "run-gates.sh: ${0##*/} is blocked on this host (no docker)" >&2\nexit 1\n' "$shims" > "$shims/$b"
  chmod 755 "$shims/$b"
  # Positive control before any gate: the stand-in is what a gate finds, and no bin directory npm puts ahead of it
  # (node_modules/.bin of the site, the worktree and every ancestor) shadows it.
  [ "$(cd "$wt" && env PATH="$shims:$PATH" bash -c "command -v $b")" = "$shims/$b" ] || { echo "refuse: $b does not resolve to the blocking stand-in" >&2; rm -rf -- "$T"; exit 3; }
  d="$wt/site"; while :; do
    [ ! -e "$d/node_modules/.bin/$b" ] || { echo "refuse: $d/node_modules/.bin/$b would shadow the blocking stand-in" >&2; rm -rf -- "$T"; exit 3; }
    up=$(dirname "$d"); [ "$up" != "$d" ] || break; d=$up; done
done
# The controls may point the OrbStack probe at a dummy process; any other value is ignored.
case "${RUN_GATES_ORB_PATTERN:-}" in run-gates-control-orb-*) orb_pattern=$RUN_GATES_ORB_PATTERN ;; *) orb_pattern="OrbStack Helper" ;; esac
orb_running() { pgrep -f "$orb_pattern" >/dev/null 2>&1 && echo yes || echo no; }
other_runs() { # live runs of this wrapper other than this run: not an ancestor of it, not a descendant of it
  local anc=" $$ " a=$$ p q
  while [ "${a:-1}" -gt 1 ]; do a=$(ps -o ppid= -p "$a" 2>/dev/null | tr -d ' '); anc="$anc${a:-1} "; done
  for p in $(pgrep -f '^(/bin/)?bash [^ ]*run-gates[^ /]*\.sh ' 2>/dev/null); do  # a wrapper process, not a mention
    case "$anc" in *" $p "*) continue ;; esac
    q=$p; while [ "${q:-1}" -gt 1 ] && [ "$q" != "$$" ]; do q=$(ps -o ppid= -p "$q" 2>/dev/null | tr -d ' '); done
    [ "$q" = "$$" ] && continue          # a subshell of this run has the same command line
    kill -0 "$p" 2>/dev/null && printf '%s ' "$p"; done; }
orb_before=$(orb_running)
snapshot() { # every write class: the two cswarm trees in full, plus the top-level names under the home, .config and .claude
  for d in "$real_home/.cswarm" "$real_home/.config/cswarm"; do [ -e "$d" ] && find "$d" -mindepth 1 -print 2>/dev/null; done
  # Top levels by NAME only: on this shared host other agents change mtimes under their own directories every
  # few seconds (measured 2026-09-26: ~/.hermes and ~/.grokbot during a 20 s control run), so mtimes are noise here.
  for d in "$real_home" "$real_home/.config" "$real_home/.claude"; do [ -d "$d" ] && find "$d" -mindepth 1 -maxdepth 1 -print 2>/dev/null; done
  } 
before=$(snapshot | sort)
run() { # run one gate command under the temp home, in its own process group; kill what it leaves behind
  echo "== $1" >> "$log"
  ( cd "$wt" && exec env -u FORCE_COLOR HOME="$T" PATH="$shims:$PATH" perl -e 'setpgrp(0,0); exec @ARGV' bash -c "$1" ) >> "$log" 2>&1 &
  local pgid=$! watcher=
  if [ "${watch_orb:-0}" = 1 ]; then # HezLead's term: if OrbStack appears at any point, the run stops
    ( while kill -0 "$pgid" 2>/dev/null; do
        if [ "$(orb_running)" = yes ]; then
          echo "STOPPED: OrbStack appeared during the gate; the gate was killed" >> "$log"
          kill -TERM -- -"$pgid" 2>/dev/null; sleep 2; kill -9 -- -"$pgid" 2>/dev/null; break; fi
        sleep 3; done ) &
    watcher=$!
  fi
  wait "$pgid"; local rc=$?
  [ -z "$watcher" ] || { kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; }
  pkill -g "$pgid" 2>/dev/null; sleep 2
  if pgrep -g "$pgid" >/dev/null 2>&1; then
    echo "SURVIVORS after gate (killed with -9):" | tee -a "$log"; ps -o pid,command -g "$pgid" 2>/dev/null | tail -n +2 | tee -a "$log"
    kill -9 -- -"$pgid" 2>/dev/null; rc=1; fi
  echo "EXIT $rc :: $1" | tee -a "$log"; return $rc; }
: > "$log"; echo "home=$T (passwd home is not used)" >> "$log"
status=0
case "$mode" in
  gates)
    for c in "npm run build" "npm test" "npm run check:tests" "npm run check:edge" \
             "npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js" \
             "bash scripts/build-release.sh" "npm --prefix site run build" "git diff --check $base...HEAD"; do
      run "$c" || status=1; done ;;
  site)
    for c in "npm --prefix site run build" "git diff --check $base...HEAD"; do
      run "$c" || status=1; done ;;
  p1-cli)
    level=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null) || level=unknown
    others=$(other_runs)
    if [ "$level" != 1 ]; then echo "refuse: memory pressure level is ${level:-unknown}, not 1 (normal)" | tee -a "$log"; status=3
    elif [ "$orb_before" = yes ]; then echo "refuse: OrbStack is running; p1-cli needs it off before and during the run" | tee -a "$log"; status=3
    elif [ -n "$others" ]; then echo "refuse: another run of this wrapper is active:" | tee -a "$log"
      for p in $others; do ps -o pid=,command= -p "$p" 2>/dev/null | cut -c1-160 | sed 's/^/  /' | tee -a "$log"; done; status=3
    else echo "memory pressure level 1; OrbStack off; no other run of this wrapper" >> "$log"
      watch_orb=1; run "npm run test:p1-cli" || status=1; fi ;;
  server) echo "refuse: no docker on this host; dispatch .github/workflows/server-suite.yml with the exact SHA" | tee -a "$log"; status=3 ;;
  cli-file)
    case "$extra" in /*) f="$extra" ;; *) f="$wt/$extra" ;; esac
    [ ! -f "$f" ] || f=$(realpath "$f")   # every symlink resolved, like $wt, so an alias cannot hide a site file
    if [ ! -f "$f" ]; then echo "refuse: no test file at $f" | tee -a "$log"; status=3
    # No browser on this host: every browser test today is a site file or an *.observer.* file; they run in the
    # workflow (suite site).
    elif case "$f" in "$wt"/site/*|*.observer.*) true ;; *) false ;; esac; then
      echo "refuse: $extra is a site or browser test; dispatch .github/workflows/server-suite.yml (suite site)" | tee -a "$log"; status=3
    else run "npx tsx --test --test-timeout=600000 \"$f\"" || status=1; fi ;;
  *) echo "unknown mode $mode" >&2; status=3 ;;
esac
grep -E "^ℹ (tests|pass|fail)" "$log" | paste -sd' ' - ; grep "^✖" "$log" | grep -v failing | sed 's/ (.*//' | sort -u | head -12
[ "$mode" != gates ] || echo "NOT RUN in this mode: npm run test:p1-cli (run mode p1-cli) and npm run test:p1-server (dispatch .github/workflows/server-suite.yml, suite server, for the exact SHA)" | tee -a "$log"
[ "$mode" != site ] || echo "NOT RUN on this host by design: npm --prefix site test (it starts a browser); dispatch .github/workflows/server-suite.yml (suite site) for the exact SHA" | tee -a "$log"
if [ -s "$shims/calls" ]; then
  echo "NOT RUN on this host (docker blocked): $(wc -l < "$shims/calls" | tr -d ' ') blocked calls; skipped tests:" | tee -a "$log"
  sort -u "$shims/calls" | cut -c1-160 | sed 's/^/  blocked: /' | tee -a "$log"
  # node's spec reporter prints a skipped test as "﹣ <name> (<ms>) # <reason>"; TAP prints "# SKIP".
  grep -E "﹣ |# SKIP" "$log" | sed 's/^[[:space:]]*//; s/ ([0-9.]*ms)//' | sort -u | head -20 | sed 's/^/  skipped: /' | tee -a "$log"; fi
! grep -q "^STOPPED: OrbStack appeared" "$log" || status=1
orb_after=$(orb_running)
echo "orbstack running: before=$orb_before after=$orb_after" | tee -a "$log"
[ "$orb_before/$orb_after" != "no/yes" ] || echo "WARNING: OrbStack started during the run; the stand-ins block this run's gates, so check other sessions" | tee -a "$log"
after=$(snapshot | sort)
if [ "$before" != "$after" ]; then
  echo "GATE FAILED: the real home changed during the run:" | tee -a "$log"; diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tee -a "$log"; status=1; fi
rm -rf -- "$T"
echo "run-gates: status=$status log=$log"; exit $status
