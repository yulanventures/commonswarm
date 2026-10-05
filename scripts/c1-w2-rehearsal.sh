#!/bin/bash
# C1 W2 schema rehearsal on a disposable local PostgreSQL cluster. Bash 3.2-safe. No network, no docker.
#
#   scripts/c1-w2-rehearsal.sh [--live-dump] [--catalogs-from <git-sha>] [--reserve-control] <dump-dir>
#   scripts/c1-w2-rehearsal.sh [--live-dump] --issuer [--plan-from <git-sha>] <dump-dir>
#   scripts/c1-w2-rehearsal.sh [--live-dump] --w2b-preconditions <dump-dir>
#   scripts/c1-w2-rehearsal.sh [--live-dump] --from-post-w2 --w2-release-sha <sha> (--issuer | --w2b-preconditions) <post-W2-dump-dir>
#   scripts/c1-w2-rehearsal.sh [--live-dump] --from-post-w2 --w2-release-sha <sha> --issuer --w6 <post-W2-dump-dir>
#   scripts/c1-w2-rehearsal.sh [--live-dump] --dump-post-w2 <out-dir> <pre-W2-dump-dir>
#   scripts/c1-w2-rehearsal.sh --build-fixture <out-dir>
#   scripts/c1-w2-rehearsal.sh --cleanup-selftest <path> | --cleanup-run <path>   (test controls)
#
# Rehearsal: <dump-dir> holds roles.sql, schema.sql and ledger.sql of a pre-W2 database. The script makes a
# cluster in an absolute mktemp directory, listens only on a unix socket in that directory, restores the dump,
# and then runs the W2 SQL IN PLAN ORDER from the bytes of the release plan (never retyped):
#   ai-db-session ledger line, ai-w2-preflight (ledger/reserve check, before-apply catalogs, inventories),
#   ai-w2-measure, ai-w2-apply (per-migration transaction and ledger insert), ai-w2-reconcile, ai-w2-probes.
# The box's docker psql is emulated with local psql -X --set=ON_ERROR_STOP=1; /release and /proof inside SQL
# files map to the local release copy and proof directory. Steps that need the network are EMULATED and say
# so: ai-w2-backfill (backfill.json from the release files), ai-w2-between-probes and ai-w2-revoke-probes.
# Each step prints one PASS/FAIL/EMUL line with its label; the first FAIL exits nonzero. Row data is never
# printed: a FAIL prints only the first psql ERROR line or the plan's own FAIL/STOP line.
#
# --catalogs-from <sha> takes deploy/release-proofs/item-ai/ AND the plan's before-catalog slice of
# ai-w2-preflight from that commit (negative control). --reserve-control replaces the plan steps with a
# positive control of the reverse catalogs: on the restored dump it applies M1-M5 directly (no checksum
# evidence, so every data-free reserve is permitted), then the reviewed reserves 5..1, and requires each
# reverse catalog to be true after its reserve.
#
# --build-fixture makes the CI-able pre-W2 fixture from this repository: the test-only Supabase prelude
# (tests/fixtures/c1-w2-rehearsal-prelude.sql), every migration before 20261003000001 with its ledger row,
# then pg_dumpall -r --no-role-passwords, pg_dump -s and the ledger data. The prelude and the pg_cron line
# strip apply ONLY in this mode; a supplied dump is restored as given and fails loudly if it needs an
# extension the local PostgreSQL does not have.
#
# --live-dump restores the UNMODIFIED live dump files, read in place (never copied or moved), with exactly
# four statements replaced by the test-only models in scripts/c1-w2-extension-models.sql:
#   CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
#   CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
#   CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;
#   CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
# Each must occur exactly once. One MODEL line per replaced extension lists the modelled objects. Every
# rehearsal mode then proves isolation: no W2 migration, catalog, reserve or plan block the harness runs
# names a cron., net., graphql., graphql_public., vault. or pgsodium. object, so a model cannot change a
# W2 result.
#
# --issuer runs the W2 rehearsal, then the issuer credential as W2b runs it, with a REAL libpq login: the
# live W2 issuer rollback's ALTER ROLE (NOLOGIN, no password), the W2b database preconditions, a restart
# with ssl=on listening on 127.0.0.1 only (ephemeral port; pg_hba: hostssl 127.0.0.1/32 for the issuer
# role, everything else rejected; the unix-socket superuser line is the harness's own setup), a throwaway
# CA and server certificate for db.commonswarm.internal (hostaddr 127.0.0.1), service.conf and pass from the
# released make-pg-service.mjs, the plan's issuer preparation and ALTER ROLE from the RELEASE.md bytes,
# and psql with PGSERVICEFILE=issuer-service.conf, PGPASSFILE=issuer-pass and sslmode=verify-full running
# the plan's own measurement query. --plan-from <sha> takes only the issuer block from that commit
# (negative control: 5f64fab4 fails with "syntax error in service file"). --w2b-preconditions restores
# the dump and runs only the plan's W2b database preconditions. Every mode ends by stopping the
# cluster, deleting data, CA and secrets, and proving their absence. Passwords are generated fresh in
# the 0700 directory and never printed.
#
# --from-post-w2: the dump is POST-W2 (all five 20261003 versions in its ledger, issuer NOLOGIN after the
# W2 issuer rollback). The W2 apply and the rollback ALTER ROLE are skipped; --issuer and
# --w2b-preconditions run on the dump's own state. The harness refuses a post-W2 dump without the flag,
# and the flag on a dump whose ledger lacks any of the five. --w2-release-sha names the release W2 ran
# at (the W2b preconditions compare the five checksum rows, recorded at that release, with this
# release's migration files); without --from-post-w2 it is this checkout's HEAD, which the W2 apply used.
# --dump-post-w2 <dir> runs the W2 rehearsal, then the plan's own issuer rollback statement (the live
# W2 RGLqZX end state), and writes a post-W2 dump: roles.sql, schema.sql, ledger.sql (the ledger data) and
# ledger-extra.sql (data of commonswarm_ops.migration_checksums and commonswarm_oauth.admin_cutover_state).
# Every rehearsal restores <dump-dir>/ledger-extra.sql right after ledger.sql when it exists (SKIP line
# otherwise). The W2b checksum precondition needs the checksum rows.
#
# --w6 continues the --from-post-w2 --issuer run (W2b) on the same cluster with scripts/c1-w6-rehearsal-steps.sh: W4 SQL
# with the legacy fence, the recycle hook and edge receipt (stale-generation negative), W6 activation checks and G4,
# the C1 verification row through its trigger (negatives), activate.sql/readback, client-check, owner approval and
# withdrawal, smoke audit rows, G3 in both orders, fence readback, W6 finish on both keep_open paths, the W7 binding
# and proof SQL, recycles after keep-open (good reopens, bad stays closed) and the timer re-arm on the apply failure
# and emergency paths. That file's header lists what is emulated.
#
# The only delete is of the script's own mktemp directory, after a pattern check (--cleanup-selftest proves
# the refusal), and only once the postmaster recorded in that directory has stopped: a failed or timed-out
# stop, a recorded postmaster not verifiably gone 10 s after the stop (only "no such process", an unreaped zombie
# with the recorded start time, or a reused pid count as gone; unknown state does not), or any surviving process of
# that cluster, keeps the directory, prints RETAIN and exits nonzero
# (--cleanup-run proves it). HOME is never assigned.
set -u
set -o pipefail

REPO=$(cd -P "$(dirname "$0")/.." && pwd -P) || exit 1
PLAN_REL=docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md
PG_BIN=${PG_BIN:-}
if test -z "$PG_BIN"; then
  if command -v initdb >/dev/null 2>&1; then PG_BIN=$(dirname "$(command -v initdb)")
  else PG_BIN=/opt/homebrew/opt/postgresql@17/bin; fi
fi
T=

say() { printf '%s\n' "$*"; }
die() { say "FAIL $1: $2"; exit 1; }

own_dir_ok() {
  [[ "$1" =~ ^(/private)?/tmp/c1w2\.[A-Za-z0-9]{6}$ ]] || return 1
  test -d "$1" && ! test -L "$1"
}

# Process state for cleanup, from the kernel's own records (never a signal reply): prints "gone" (no such process),
# "<start-time> <state>" (state Z = exited, unreaped), or "unknown" (permission denied, sandbox, any other failure).
# Linux: /proc/<pid>/stat (state, starttime); macOS: libproc proc_pidinfo PROC_PIDTBSDINFO (status, start time).
PROC_PY='
import ctypes,errno,os,sys
pid=int(sys.argv[1])
try:
    if os.path.isdir("/proc/self"):
        try: raw=open("/proc/%d/stat"%pid).read()
        except FileNotFoundError: print("gone"); sys.exit(0)
        f=raw[raw.rindex(")")+2:].split()
        print(f[19]+" "+f[0]); sys.exit(0)
    lib=ctypes.CDLL("/usr/lib/libproc.dylib",use_errno=True)
    buf=ctypes.create_string_buffer(136)
    if lib.proc_pidinfo(pid,3,0,buf,136)!=136:
        print("gone" if ctypes.get_errno()==errno.ESRCH else "unknown"); sys.exit(0)
    status=int.from_bytes(buf.raw[4:8],"little")
    print("%d.%06d %s"%(int.from_bytes(buf.raw[120:128],"little"),int.from_bytes(buf.raw[128:136],"little"),"Z" if status==5 else "R"))
except Exception:
    print("unknown")
'
proc_state() { python3 -c "$PROC_PY" "$1" 2>/dev/null || printf 'unknown\n'; }
# Record the running postmaster's identity (pid and start time) beside its data directory, after every start.
record_identity() { # dir
  local pid state
  pid=$(head -1 "$1/data/postmaster.pid" 2>/dev/null)
  # Nothing is written when the identity cannot be read: an absent file means "unrecorded", never a malformed one.
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  state=$(proc_state "$pid")
  case "$state" in gone|unknown) ;; *) printf '%s %s\n' "$pid" "${state% *}" >"$1/postmaster.identity" ;; esac
}

cleanup_dir() {
  local dir=$1 pid= tenths=0 limit=${C1_W2_CLEANUP_WAIT_TENTHS:-100} ident state verdict left status_f status_g=1
  [[ "$limit" =~ ^[1-9][0-9]{0,2}$ ]] && test "$limit" -le 100 || limit=100
  if ! own_dir_ok "$dir"; then say "REFUSE cleanup: $dir is not this script's mktemp directory"; return 1; fi
  # The recorded postmaster identity (pid and start time, written after every start) governs cleanup whether or not
  # postmaster.pid still exists: a missing pid file never lets a possibly live cluster be deleted unchecked.
  # Three states: ABSENT (unrecorded); PRESENT and parsed ("<pid> <start-time>"); PRESENT but unreadable, empty or
  # malformed -> RETAIN, never delete.
  ident=
  if test -e "$dir/postmaster.identity" || test -L "$dir/postmaster.identity"; then
    if ! ident=$(cat "$dir/postmaster.identity" 2>/dev/null); then
      say "RETAIN cleanup: postmaster.identity present but unreadable; cluster directory $dir kept"; return 1
    fi
    if ! [[ "$ident" =~ ^[0-9]+\ [0-9]+(\.[0-9]+)?$ ]]; then
      say "RETAIN cleanup: postmaster.identity present but empty or malformed; cluster directory $dir kept"; return 1
    fi
  fi
  # ONE rule: delete only (a) a directory that was never initialised (no data directory), or (b) one with a PRESENT and
  # VALID identity after every exit and survivor check below passes. Anything else is kept.
  if test -z "$ident"; then
    if test -e "$dir/data" || test -L "$dir/data"; then
      say "RETAIN cleanup: postmaster.identity absent while a data directory exists (identity never recorded); cluster directory $dir kept"; return 1
    fi
    rm -rf -- "$dir"; return
  fi
  if test -e "$dir/data/postmaster.pid"; then
    # The owned postmaster is the pid recorded in this directory's own postmaster.pid.
    pid=$(head -1 "$dir/data/postmaster.pid" 2>/dev/null)
    if ! [[ "$pid" =~ ^[0-9]+$ ]]; then say "RETAIN cleanup: postmaster.pid unreadable; cluster directory $dir kept"; return 1; fi
    if ! "$PG_BIN/pg_ctl" -D "$dir/data" -m fast -w -t 60 stop >/dev/null 2>&1; then
      say "RETAIN cleanup: pg_ctl stop failed; postmaster $pid may still run; cluster directory $dir kept"; return 1
    fi
  else
    pid=${ident%% *}
    if ! [[ "$pid" =~ ^[0-9]+$ ]]; then say "RETAIN cleanup: postmaster.identity unreadable; cluster directory $dir kept"; return 1; fi
  fi
  # pg_ctl -w returns once postmaster.pid is gone; the process may still be exiting. Wait, bounded (default 10 s in
    # 100 ms steps), until the RECORDED postmaster is verifiably gone: no such process; or an unreaped zombie with the
    # recorded start time; or the pid now belongs to another process (a different start time). Unknown state waits.
    while :; do
      state=$(proc_state "$pid"); verdict=wait
      case "$state" in
        gone) verdict=gone ;;
        unknown) ;;
        *) if test -n "$ident" && test "${ident%% *}" = "$pid"; then
             if test "${ident#* }" = "${state% *}"; then case "${state#* }" in Z*) verdict=gone ;; esac
             else verdict=gone; fi
           fi ;;
      esac
      test "$verdict" = wait || break
      if test "$tenths" -ge "$limit"; then
        say "RETAIN cleanup: postmaster $pid still running or unverified $((limit / 10)).$((limit % 10)) s after stop; cluster directory $dir kept"; return 1
      fi
      sleep 0.1; tenths=$((tenths + 1))
    done
  # Nothing of the cluster may remain: no process naming its data directory and none in the process group of the
  # postmaster (pg_ctl starts it in its own session), for the recorded identity's pid and the pid file's pid. A check
  # that cannot run counts as a survivor.
  left=$(pgrep -f -- "$dir/data" 2>/dev/null); status_f=$?
  left="$left $(pgrep -g "$pid" 2>/dev/null)"; status_g=$?
  if test "$status_g" = 1 && test "${ident%% *}" != "$pid"; then left="$left $(pgrep -g "${ident%% *}" 2>/dev/null)"; status_g=$?; fi
  if test "$status_f" != 1 || test "$status_g" != 1; then
    say "RETAIN cleanup: processes of this cluster remain or cannot be checked after the postmaster exit; cluster directory $dir kept"; return 1
  fi
  rm -rf -- "$dir"
}

on_exit() {
  local status=$?
  trap - EXIT
  if test -n "$T"; then
    if cleanup_dir "$T" && test ! -e "$T" && test ! -L "$T"; then say "PASS cleanup: cluster stopped; data, CA and secrets deleted; $T absent"
    else status=1; fi
  fi
  exit "$status"
}

# Test controls only: record a directory's postmaster identity; run the real cleanup on a directory of this script's shape.
if test "${1:-}" = --record-identity; then
  test $# = 2 && own_dir_ok "$2" || die record-identity 'expected one directory of this script'"'"'s shape'
  record_identity "$2"; say "IDENTITY record-identity: $(cat "$2/postmaster.identity")"; exit 0
fi
if test "${1:-}" = --cleanup-run; then
  test $# = 2 || die cleanup-run 'expected one path'
  cleanup_dir "$2" || exit 4
  say "REMOVED cleanup-run: $2"; exit 0
fi
if test "${1:-}" = --cleanup-selftest; then
  test $# = 2 || die cleanup-selftest 'expected one path'
  if own_dir_ok "$2"; then say "ACCEPT cleanup-selftest: $2"; exit 0; fi
  say "REFUSE cleanup-selftest: $2"; exit 3
fi

W6=0 MODE=rehearse CATALOGS_FROM= RESERVE_CONTROL=0 LIVE_DUMP=0 ISSUER=0 PLAN_FROM= W2B_ONLY=0 POST_W2=0 W2_SHA= DUMP_POST= TARGET=
while test $# -gt 0; do
  case "$1" in
    --build-fixture) MODE=build; shift; TARGET=${1:-}; shift || true ;;
    --catalogs-from) shift; CATALOGS_FROM=${1:-}; shift || true ;;
    --reserve-control) RESERVE_CONTROL=1; shift ;;
    --live-dump) LIVE_DUMP=1; shift ;;
    --issuer) ISSUER=1; shift ;;
    --w6) W6=1; shift ;;
    --plan-from) shift; PLAN_FROM=${1:-}; shift || true ;;
    --w2b-preconditions) W2B_ONLY=1; shift ;;
    --from-post-w2) POST_W2=1; shift ;;
    --w2-release-sha) shift; W2_SHA=${1:-}; shift || true ;;
    --dump-post-w2) shift; DUMP_POST=${1:-}; shift || true ;;
    -*) die usage "unknown option $1" ;;
    *) test -z "$TARGET" || die usage 'one dump directory only'; TARGET=$1; shift ;;
  esac
done
test -n "$TARGET" || die usage 'scripts/c1-w2-rehearsal.sh [--catalogs-from <sha>] [--reserve-control] <dump-dir> | --build-fixture <out-dir>'
case "$TARGET" in /*) ;; *) TARGET=$(pwd -P)/$TARGET ;; esac
if test -n "$PLAN_FROM"; then
  test "$ISSUER" = 1 || die plan-from '--plan-from needs --issuer'
  [[ "$PLAN_FROM" =~ ^[0-9a-f]{7,40}$ ]] || die plan-from 'expected a hex commit id'
  git -C "$REPO" cat-file -e "$PLAN_FROM^{commit}" 2>/dev/null || die plan-from "commit $PLAN_FROM not found"
fi
if test "$ISSUER" = 1 && { test "$W2B_ONLY" = 1 || test "$RESERVE_CONTROL" = 1; }; then die usage '--issuer, --w2b-preconditions and --reserve-control are separate modes'; fi
if test "$POST_W2" = 1 && { test "$MODE" = build || { test "$ISSUER" = 0 && test "$W2B_ONLY" = 0; }; }; then die usage '--from-post-w2 needs --issuer or --w2b-preconditions'; fi
if test "$POST_W2" = 1; then [[ "$W2_SHA" =~ ^[0-9a-f]{40}$ ]] || die usage '--from-post-w2 needs --w2-release-sha <full 40-hex sha of the release W2 ran at>'; fi
if test "$W6" = 1 && { test "$POST_W2" != 1 || test "$ISSUER" != 1 || test -n "$PLAN_FROM"; }; then die usage '--w6 needs --from-post-w2 --issuer (and no --plan-from)'; fi
if test "$POST_W2" = 0 && test -n "$W2_SHA"; then die usage '--w2-release-sha is for --from-post-w2 (otherwise the W2 apply runs at HEAD)'; fi
if test -n "$DUMP_POST"; then
  { test "$MODE" = rehearse && test "$POST_W2$ISSUER$W2B_ONLY$RESERVE_CONTROL" = 0000 && test -z "$CATALOGS_FROM"; } || die usage '--dump-post-w2 is a plain W2 rehearsal of a pre-W2 dump'
  case "$DUMP_POST" in /*) ;; *) DUMP_POST=$(pwd -P)/$DUMP_POST ;; esac
  test ! -e "$DUMP_POST" || die dump-post-w2 "$DUMP_POST expected absent got present"
fi
if test "$POST_W2" = 1 && { test -n "$CATALOGS_FROM" || test "$RESERVE_CONTROL" = 1; }; then die usage '--from-post-w2 skips the W2 apply: no --catalogs-from or --reserve-control'; fi
if test "$W2B_ONLY" = 1 && test "$RESERVE_CONTROL" = 1; then die usage '--w2b-preconditions and --reserve-control are separate modes'; fi
if test "$ISSUER" = 1; then command -v openssl >/dev/null 2>&1 || die setup 'openssl expected got missing'; fi
umask 077
if test -n "$CATALOGS_FROM"; then
  [[ "$CATALOGS_FROM" =~ ^[0-9a-f]{7,40}$ ]] || die catalogs-from 'expected a hex commit id'
  git -C "$REPO" cat-file -e "$CATALOGS_FROM^{commit}" 2>/dev/null || die catalogs-from "commit $CATALOGS_FROM not found"
fi
for tool in initdb pg_ctl psql pg_dump pg_dumpall; do
  test -x "$PG_BIN/$tool" || die setup "PostgreSQL tool $tool expected in $PG_BIN got missing"
done
command -v python3 >/dev/null 2>&1 || die setup 'python3 expected got missing'
# The plan's W2 SQL sets transaction_timeout, which needs PostgreSQL 17 (production runs 17).
PG_MAJOR=$("$PG_BIN/psql" --version | awk '{print $3}' | cut -d. -f1)
[[ "$PG_MAJOR" =~ ^[0-9]+$ ]] && test "$PG_MAJOR" -ge 17 || die setup "PostgreSQL 17 or newer expected in $PG_BIN got ${PG_MAJOR:-unknown}"

T=$(mktemp -d /tmp/c1w2.XXXXXX) || die setup 'mktemp failed'
T=$(cd -P "$T" && pwd -P) || exit 1
own_dir_ok "$T" || { say "FAIL setup: mktemp directory $T does not match the cleanup pattern"; exit 1; }
trap on_exit EXIT
trap 'exit 130' INT TERM

"$PG_BIN/initdb" -U supabase_admin --auth=trust -E UTF8 --locale=C -D "$T/data" >"$T/initdb.log" 2>&1 || die cluster 'initdb failed'
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()') || die cluster 'no ephemeral port'
"$PG_BIN/pg_ctl" -D "$T/data" -o "-p $PORT -c listen_addresses='' -c unix_socket_directories='$T'" -l "$T/pg.log" -w start >/dev/null 2>&1 \
  || die cluster 'postgres did not start (see the server log in the temporary directory)'
record_identity "$T"
say "PASS cluster: disposable PostgreSQL $("$PG_BIN/psql" --version | awk '{print $3}') on a unix socket only"

PSQL_LOG=$T/psql-err.log
pgx() { "$PG_BIN/psql" -h "$T" -p "$PORT" -U supabase_admin -d postgres -X "$@"; }
first_error() {
  local line
  line=$(grep -m1 -E 'ERROR:|FATAL:|psql: error' "$1" 2>/dev/null | cut -c1-300)
  test -n "$line" || line=$(grep -E '^(FAIL|STOP)' "$1" 2>/dev/null | tail -1 | cut -c1-300)
  test -n "$line" || line=$(grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -1 | cut -c1-300)
  printf '%s' "${line:-no diagnostic}"
}
run_sql_file() { # label file
  if pgx -q -v ON_ERROR_STOP=1 -f "$2" >/dev/null 2>"$PSQL_LOG"; then say "PASS $1"; return 0; fi
  say "FAIL $1: $(first_error "$PSQL_LOG")"; exit 1
}

if test "$MODE" = build; then
  test ! -e "$TARGET" || die build-fixture "$TARGET expected absent got present"
  mkdir -p "$TARGET" || die build-fixture 'cannot create the output directory'
  run_sql_file fixture:prelude "$REPO/tests/fixtures/c1-w2-rehearsal-prelude.sql"
  COUNT=0
  for FILE in "$REPO"/supabase/migrations/*.sql; do
    NAME=$(basename "$FILE"); VERSION=${NAME%%_*}
    [[ "$VERSION" =~ ^[0-9]{14}$ ]] || die fixture:migrations "unexpected migration name $NAME"
    test "$VERSION" \< 20261003000001 || continue
    # Fixture only: pg_cron is not packaged with local PostgreSQL; the prelude models its schedule API.
    sed 's/^CREATE EXTENSION IF NOT EXISTS pg_cron;/-- pg_cron is modelled by the rehearsal prelude/' "$FILE" >"$T/migration.sql"
    printf "INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('%s','%s');\n" "$VERSION" "${NAME%.sql}" >>"$T/migration.sql"
    pgx -q -v ON_ERROR_STOP=1 -1 -f "$T/migration.sql" >/dev/null 2>"$PSQL_LOG" || die "fixture:migration-$VERSION" "$(first_error "$PSQL_LOG")"
    COUNT=$((COUNT+1))
  done
  say "PASS fixture:migrations: $COUNT pre-W2 migrations applied with their ledger rows"
  "$PG_BIN/pg_dumpall" -h "$T" -p "$PORT" -U supabase_admin -r --no-role-passwords >"$TARGET/roles.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -p "$PORT" -U supabase_admin -d postgres -s >"$TARGET/schema.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -p "$PORT" -U supabase_admin -d postgres -a -t supabase_migrations.schema_migrations >"$TARGET/ledger.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  say "PASS fixture:dump: roles.sql, schema.sql and ledger.sql written"
  exit 0
fi

# ---- rehearsal ----
for f in roles.sql schema.sql ledger.sql; do test -f "$TARGET/$f" || die restore "$TARGET/$f expected present got missing"; done
mkdir -p "$T/release" "$T/proof" "$T/stage" "$T/blocks" "$T/mapped" || exit 1
chmod 0700 "$T/stage"
RELEASE_ROOT=$T/release PROOF_DIR=$T/proof SECRET_STAGE=$T/stage
# Dump files are read in place and streamed to psql; nothing is copied. The bootstrap role exists in
# every cluster, so the dump's own "CREATE ROLE supabase_admin;" is the one roles statement dropped.
cat >"$T/dumpfilter.py" <<'PY'
import re,sys
kind,path,models=sys.argv[1],sys.argv[2],sys.argv[3]
text=open(path,encoding='utf-8').read()
if kind=='roles':
    sys.stdout.write('\n'.join(l for l in text.split('\n') if l.strip()!='CREATE ROLE supabase_admin;')); raise SystemExit(0)
REPLACED={'pg_cron':'CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;',
          'pg_net':'CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;',
          'pg_graphql':'CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;',
          'supabase_vault':'CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;'}
sections={}
for part in re.split(r'^(?=-- model: )',open(models,encoding='utf-8').read(),flags=re.M)[1:]:
    sections[part.split('\n',1)[0][len('-- model: '):].strip()]=part
if set(sections)!=set(REPLACED): raise SystemExit('FAIL restore-schema: model sections expected '+','.join(sorted(REPLACED))+' got '+','.join(sorted(sections)))
lines=text.split('\n')
for name,stmt in REPLACED.items():
    hits=[i for i,l in enumerate(lines) if l==stmt]
    if len(hits)!=1: raise SystemExit('FAIL restore-schema: "'+stmt+'" expected once got '+str(len(hits)))
    if kind=='models':
        objs=[l[len('-- object: '):] for l in sections[name].split('\n') if l.startswith('-- object: ')]
        print('MODEL '+name+': schema.sql line '+str(hits[0]+1)+' replaced by the test-only model; objects: '+', '.join(objs))
    lines[hits[0]]=sections[name]
if kind=='schema': sys.stdout.write('\n'.join(lines))
PY
MODELS=$REPO/scripts/c1-w2-extension-models.sql
restore_stream() { # label kind file
  if python3 "$T/dumpfilter.py" "$2" "$3" "$MODELS" 2>"$T/filter.err" | pgx -q -v ON_ERROR_STOP=1 -f - >/dev/null 2>"$PSQL_LOG"; then say "PASS $1"; return 0; fi
  if test -s "$T/filter.err"; then say "$(head -1 "$T/filter.err" | cut -c1-300)"; exit 1; fi
  say "FAIL $1: $(first_error "$PSQL_LOG")"; exit 1
}
restore_stream restore-roles roles "$TARGET/roles.sql"
if test "$LIVE_DUMP" = 1; then
  python3 "$T/dumpfilter.py" models "$TARGET/schema.sql" "$MODELS" 2>"$T/filter.err" || { say "$(head -1 "$T/filter.err" | cut -c1-300)"; exit 1; }
  restore_stream restore-schema schema "$TARGET/schema.sql"
else
  run_sql_file restore-schema "$TARGET/schema.sql"
fi
run_sql_file restore-ledger "$TARGET/ledger.sql"
# Optional data-only extra (HezLead's live split): migration checksums and, when supplied, the cutover state.
if test -f "$TARGET/ledger-extra.sql"; then run_sql_file restore-ledger-extra "$TARGET/ledger-extra.sql"
else say "SKIP restore-ledger-extra: $TARGET/ledger-extra.sql absent"; fi

# Release copy: the reviewed files the plan reads, from this checkout; item-ai proofs from --catalogs-from.
if test -n "$PLAN_FROM"; then
  git -C "$REPO" show "$PLAN_FROM:$PLAN_REL" >"$T/issuer-plan.md" 2>/dev/null || die release-copy "plan at $PLAN_FROM not readable"
fi
python3 - "$REPO" "$RELEASE_ROOT" "$CATALOGS_FROM" "$PLAN_REL" <<'PY' || die release-copy 'could not assemble the release copy'
import io,pathlib,shutil,subprocess,sys,tarfile
repo,root,sha,plan=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4]
for rel in ['supabase/migrations','supabase/admin-delegation-reserve','deploy/release-proofs','deploy/supabase-stack/migrate',str(pathlib.Path(plan).parent)]:
    ignore=shutil.ignore_patterns('item-ai') if (sha and rel=='deploy/release-proofs') else None
    shutil.copytree(repo/rel,root/rel,ignore=ignore)
if sha:
    data=subprocess.run(['git','-C',str(repo),'archive',sha,'deploy/release-proofs/item-ai'],check=True,capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            if m.isdir(): continue
            assert m.isfile() and m.name.startswith('deploy/release-proofs/item-ai/') and '..' not in m.name.split('/')
            if m.isfile(): (root/m.name).parent.mkdir(parents=True,exist_ok=True); (root/m.name).write_bytes(tar.extractfile(m).read())
    (root.parent/'catalog-plan.md').write_bytes(subprocess.run(['git','-C',str(repo),'show',sha+':'+plan],check=True,capture_output=True).stdout)
else:
    shutil.copyfile(root/plan,root.parent/'catalog-plan.md')
PY
RELEASE_SHA=$(git -C "$REPO" rev-parse HEAD) || die release-copy 'git rev-parse failed'
say "PASS release-copy: plan, migrations, reserves and proofs; item-ai catalogs from ${CATALOGS_FROM:-this checkout}"

# Extract plan slices from the RELEASE.md bytes; each anchor must occur exactly once.
cat >"$T/extract.py" <<'PY'
import re,sys
plan,step,kind=sys.argv[1:4]
blocks=[b for b in re.findall(r'^`{3}sh\n(.*?)^`{3}$',open(plan,'rb').read().decode(),re.M|re.S) if b.startswith('# step: '+step+'\n')]
if len(blocks)!=1: raise SystemExit('block '+step+' expected one got '+str(len(blocks)))
b=blocks[0]
def one(s,needle):
    if s.count(needle)!=1: raise SystemExit('anchor expected once in '+step+': '+needle)
    return s.index(needle)
if kind=='block': out=b
elif kind=='line':
    lines=[l for l in b.split('\n') if sys.argv[4] in l]
    if len(lines)!=1: raise SystemExit('line expected once in '+step+': '+sys.argv[4])
    out=lines[0]+'\n'
elif kind=='lines':
    rows=b.split('\n'); a=[i for i,l in enumerate(rows) if sys.argv[4] in l]
    if len(a)!=1: raise SystemExit('line expected once in '+step+': '+sys.argv[4])
    z=[i for i,l in enumerate(rows) if i>a[0] and sys.argv[5] in l]
    if not z: raise SystemExit('end line not found in '+step+': '+sys.argv[5])
    out='\n'.join(rows[a[0]:z[0]])+'\n'
elif kind=='command-sql':
    lines=[l for l in b.split('\n') if sys.argv[4] in l]
    if len(lines)!=1: raise SystemExit('line expected once in '+step+': '+sys.argv[4])
    m=re.search(r'--command "(.*)" \\$',lines[0])
    if not m: raise SystemExit('command SQL not found in '+step)
    out=m.group(1)
elif kind=='from':
    rows=b.split('\n'); a=[i for i,l in enumerate(rows) if sys.argv[4] in l]
    if len(a)!=1: raise SystemExit('line expected once in '+step+': '+sys.argv[4])
    out='\n'.join(rows[a[0]:])
elif kind=='slice':
    a=one(b,sys.argv[4]); z=b.index(sys.argv[5],a)
    out=b[a:z]
else: raise SystemExit('unknown kind')
sys.stdout.write(out)
PY
PLAN=$RELEASE_ROOT/$PLAN_REL
extract() { python3 "$T/extract.py" "$@" 2>"$T/extract.err" || die extract "$(cat "$T/extract.err")"; }
extract "$PLAN" ai-db-session line 'ai_ro() {' >"$T/blocks/ai_ro.sh"
extract "$PLAN" ai-db-session line '>"$PROOF_DIR/ledger-before.txt"' >"$T/blocks/ledger-before.sh"
extract "$PLAN" ai-w2-preflight slice 'python3 - "$RELEASE_ROOT" "$PROOF_DIR" <<' '# Current backup/restore evidence' >"$T/blocks/preflight-ledger.sh"
extract "$T/catalog-plan.md" ai-w2-preflight slice '# Before proofs:' 'ai_run ai-w2-measure' >"$T/blocks/preflight-before.sh"
for STEP in ai-w2-measure ai-w2-apply ai-w2-reconcile ai-w2-probes; do extract "$PLAN" "$STEP" block >"$T/blocks/$STEP.sh"; done
if test "${C1_W2_REHEARSAL_FAULT:-}" = preflight-inventory; then
  python3 - "$T/blocks/preflight-before.sh" <<'PY' || die fault 'functions-before inventory query expected once got other'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); s=p.read_text(); a='FROM pg_proc p JOIN pg_namespace n'
assert s.count(a)==1 and s.count('functions-before.txt')==1
p.write_text(s.replace(a,'FROM rehearsal_fault_missing_relation p JOIN pg_namespace n'))
PY
  say "FAULT injected: the functions-before inventory query in ai-w2-preflight names a missing relation (test control)"
fi
if test "$ISSUER" = 1 || test "$W2B_ONLY" = 1; then
  extract "$PLAN" ai-w2b-preflight lines 'item-ai/w2b-preconditions.sql' 'W2B_ISSUANCE_OFF=' >"$T/blocks/w2b-preconditions.sh"
fi
if test "$ISSUER" = 1 || test -n "$DUMP_POST"; then
  extract "$PLAN" ai-w2-issuer-rollback line 'NOLOGIN PASSWORD NULL' >"$T/blocks/issuer-rollback-role.sh"
fi
if test "$ISSUER" = 1; then
  ISSUER_PLAN=$PLAN; test -z "$PLAN_FROM" || ISSUER_PLAN=$T/issuer-plan.md
  if grep -qF 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' "$ISSUER_PLAN" && test "${C1_W2_REHEARSAL_FAULT:-}" != issuer-sql-on-stdin; then
    # The ALTER from a read-only mounted file, then the SCRAM readback (both from the plan bytes).
    extract "$ISSUER_PLAN" ai-w2-issuer-credential lines 'openssl rand -hex 32 >"$SECRET_STAGE/issuer-password"' 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' >"$T/blocks/issuer-prepare.sh"
    extract "$ISSUER_PLAN" ai-w2-issuer-credential lines 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' 'install -o root -g 986' >"$T/blocks/issuer-alter.sh"
  elif grep -qF 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' "$ISSUER_PLAN"; then
    # Test control: the current block with its ALTER sent on stdin again (as at release Z); the readback must catch it.
    extract "$ISSUER_PLAN" ai-w2-issuer-credential lines 'openssl rand -hex 32 >"$SECRET_STAGE/issuer-password"' 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' >"$T/blocks/issuer-prepare.sh"
    extract "$ISSUER_PLAN" ai-w2-issuer-credential lines 'ai_db_secret_file "$SECRET_STAGE/issuer.sql"' 'install -o root -g 986' \
      | sed 's#^ai_db_secret_file "$SECRET_STAGE/issuer.sql"#ai_db -q --file - <"$SECRET_STAGE/issuer.sql"#' >"$T/blocks/issuer-alter.sh"
    say "FAULT injected: the issuer ALTER ROLE sent on stdin to the docker-shaped psql (no -i), as at release Z (test control)"
  else
    # A --plan-from block before the mounted-file fix: its ALTER is fed on stdin.
    extract "$ISSUER_PLAN" ai-w2-issuer-credential lines 'openssl rand -hex 32 >"$SECRET_STAGE/issuer-password"' 'ai_db -q --file - <"$SECRET_STAGE/issuer.sql"' >"$T/blocks/issuer-prepare.sh"
    extract "$ISSUER_PLAN" ai-w2-issuer-credential line 'ai_db -q --file - <"$SECRET_STAGE/issuer.sql"' >"$T/blocks/issuer-alter.sh"
  fi
  if grep -qF 'ai_db_secret_file() { # file' "$PLAN"; then
    # Its one external command, docker run, goes to the stand-in below (renamed so no other docker use is shadowed).
    extract "$PLAN" ai-db-session lines 'ai_db_secret_file() { # file' 'python3 - "$MIGRATE/lib.sh"' | sed 's#^ docker run #rehearsal_docker run #' >"$T/blocks/ai_db_secret_file.sh"
    grep -q '^rehearsal_docker run ' "$T/blocks/ai_db_secret_file.sh" || die extract 'ai_db_secret_file docker run line expected once got none'
  fi
  # The block's own proof line (its docker login is replaced by the real libpq login below), then the plan's
  # post-credential forward catalogs block and the issuer rollback it runs on failure, all from this checkout.
  extract "$PLAN" ai-w2-issuer-credential line '>"$PROOF_DIR/issuer-credential.txt"' >"$T/blocks/issuer-credential-proof.sh"
  extract "$PLAN" ai-w2b-forward-catalogs block >"$T/blocks/ai-w2b-forward-catalogs.sh"
  extract "$PLAN" ai-w2-issuer-rollback block >"$T/blocks/ai-w2-issuer-rollback.sh"
  extract "$ISSUER_PLAN" ai-w2-issuer-credential command-sql "--command \"SELECT current_user='commonswarm_admin_issuer'" >"$T/blocks/issuer-query.sql"
  say "PASS extract: issuer block from ${PLAN_FROM:-this checkout}; W2b preconditions and rollback from this checkout"
fi
for f in "$T"/blocks/*.sh; do /bin/bash -n "$f" || die extract "$(basename "$f") is not valid bash"; done
# Isolation: nothing the W2 rehearsal runs names an object of a modelled (or other Supabase-only) extension.
python3 - "$RELEASE_ROOT" "$T/blocks" <<'PY' || exit 1
import pathlib,re,sys
root,blocks=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])
migrations=sorted((root/'supabase/migrations').glob('20261003*.sql'))
if len(migrations)!=5: raise SystemExit('FAIL isolation: W2 migrations expected 5 got '+str(len(migrations)))
files=migrations+sorted((root/'deploy/release-proofs/item-ai').glob('*.sql'))
files+=sorted((root/'supabase/admin-delegation-reserve').glob('20261003*.sql'))+sorted(blocks.glob('*.sh'))
pat=re.compile(r'\b(cron|net|graphql|graphql_public|vault|pgsodium)\.[A-Za-z_"]',re.I)
# Control: the pattern finds such references.
assert pat.search("SELECT cron.schedule('x','* * * * *','SELECT 1')") and pat.search('GRANT ALL ON TABLE vault.secrets TO x')
hits=[f.name for f in files if pat.search(f.read_text())]
if hits: raise SystemExit('FAIL isolation: W2 SQL names a modelled-extension object in '+','.join(hits))
print('PASS isolation: no cron., net., graphql., vault. or pgsodium. reference in '+str(len(files))+' W2 files (5 migrations, item-ai catalogs, W2 reserves, plan blocks)')
PY

# Box psql emulation: same flags; /release and /proof in --file paths and \i lines map to local copies.
cat >"$T/map.py" <<'PY'
import pathlib,re,sys
release,proof,out=sys.argv[1:4]; src=sys.argv[4]
n=[0]
def local(p):
    if p.startswith('/release/'): return release+p[len('/release'):]
    if p.startswith('/proof/'): return proof+p[len('/proof'):]
    return p
def mapped(p):
    text=pathlib.Path(local(p)).read_text()
    def sub(m): return m.group(1)+mapped(m.group(2))
    text=re.sub(r'^(\\i[r]? )(/(?:release|proof)/\S+)$',sub,text,flags=re.M)
    n[0]+=1; dest=pathlib.Path(out)/('m%04d.sql'%n[0])
    while dest.exists(): n[0]+=1; dest=pathlib.Path(out)/('m%04d.sql'%n[0])
    dest.write_text(text); return str(dest)
print(mapped(src))
PY
ai_db() {
  local args=() prev= a src
  : >"$T/last-sql.txt"
  for a in "$@"; do
    if test "$prev" = --file && test "$a" != -; then
      # Record which plan SQL file (and the files it includes) this call runs: paths only, never contents.
      case "$a" in /release/*) src=$RELEASE_ROOT${a#/release} ;; /proof/*) src=$PROOF_DIR${a#/proof} ;; *) src=$a ;; esac
      { printf '%s' "$a"; sed -n 's#^\\i \(/[^ ]*\)$# -> \1#p' "$src" | tr -d '\n'; } >"$T/last-sql.txt" 2>/dev/null
      a=$(python3 "$T/map.py" "$RELEASE_ROOT" "$PROOF_DIR" "$T/mapped" "$a") || return 1
    fi
    args+=("$a"); prev=$a
  done
  # The box runs psql through docker run WITHOUT -i: the container never sees stdin. Modelled exactly: stdin is
  # /dev/null for every call, so SQL fed on stdin is a silent no-op here as on the box.
  "$PG_BIN/psql" -h "$T" -p "$PORT" -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 "${args[@]}" </dev/null 2>"$SECRET_STAGE/psql.log"
}
# The plan's own ai_db_secret_file runs through this docker stand-in: file volumes map back to their host files and
# stdin is never attached (no -i on the box).
rehearsal_docker() {
  local vols= a v src dst args=()
  test "${1:-}" = run || return 64; shift
  while test $# -gt 0; do
    case "$1" in --rm) shift ;; --network|--add-host|--env) shift 2 ;; --volume) vols="$vols
$2"; shift 2 ;; --entrypoint) test "${2:-}" = psql || return 64; shift 3; break ;; *) return 64 ;; esac
  done
  for a in "$@"; do
    while IFS= read -r v; do
      test -n "$v" || continue
      src=${v%%:*}; dst=${v#*:}; dst=${dst%%:*}
      if test "$a" = "$dst"; then a=$src; fi
    done <<EOF_VOLUMES
$vols
EOF_VOLUMES
    args+=("$a")
  done
  "$PG_BIN/psql" -h "$T" -p "$PORT" -U supabase_admin -d postgres "${args[@]}" </dev/null
}
PGSERVICE_FILE=$SECRET_STAGE/service.conf PGPASS_FILE=$SECRET_STAGE/pass PSQL_IMAGE=rehearsal-local-psql
if test -f "$T/blocks/ai_db_secret_file.sh"; then
  eval "$(cat "$T/blocks/ai_db_secret_file.sh")"
  type ai_db_secret_file >/dev/null 2>&1 || die extract 'ai_db_secret_file definition not found in ai-db-session'
fi
eval "$(cat "$T/blocks/ai_ro.sh")"
type ai_ro >/dev/null 2>&1 || die extract 'ai_ro definition not found in ai-db-session'
ai_deadline() { :; }
emul_probe() { # label
  python3 - "$PROOF_DIR" "$1" "$RELEASE_SHA" <<'PY'
import datetime,json,pathlib,sys
p,label,sha=pathlib.Path(sys.argv[1]),sys.argv[2],sys.argv[3]
r=dict(version=label,release_sha=sha,at=datetime.datetime.now(datetime.timezone.utc).isoformat(),discovery=True,rotation=True,refreshed=True,token_health=True,human_read=True)
(p/('between-'+label+'.json')).write_text(json.dumps(r,sort_keys=True)+'\n')
PY
}
ai_run() {
  case "$1" in
    ai-w2-between-probes)
      emul_probe "${PROBE_POINT:-$VERSION}" || return 1
      if test -n "${PROBE_POINT:-}"; then say "EMUL ai-w2-between-probes:${PROBE_POINT}: network probe not run" >&3
      else say "PASS ai-w2-apply:$VERSION: migration and ledger row committed in one transaction" >&3; fi ;;
    ai-w2-revoke-probes)
      test -f "$PROOF_DIR/dcr-probe-revoked.json" || printf '{"client_id":"rehearsal","proof":"refresh rejected","revoked":true}\n' >"$PROOF_DIR/dcr-probe-revoked.json" ;;
    ai-w2-reconcile|ai-w2-measure|ai-w2-issuer-rollback)
      # As the plan's ai_run: plain eval, so the caller's errexit applies inside the block.
      eval "$(cat "$T/blocks/$1.sh")"
      say "PASS $1" >&3 ;;
    *) return 1 ;;
  esac
}
export WINDOW=W2
# INPUTS for the W2b preconditions slice: the release W2 ran at (HEAD when this run applies W2 itself).
W2B_INPUTS=$T/inputs-w2b.json
python3 -c 'import json,sys; open(sys.argv[1],"w").write(json.dumps({"window":"W2b","release_sha":sys.argv[2],"w2_release_sha":sys.argv[3]})+"\n")' "$W2B_INPUTS" "$RELEASE_SHA" "${W2_SHA:-$RELEASE_SHA}"
printf '{}\n' >"$SECRET_STAGE/ordinary-probes.json"; chmod 0600 "$SECRET_STAGE/ordinary-probes.json"

if test "$RESERVE_CONTROL" = 1; then
  for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
    MIGRATION=$(ls "$RELEASE_ROOT/supabase/migrations/${VERSION}_"*.sql) || die "control:apply-$VERSION" 'migration file missing'
    pgx -q -v ON_ERROR_STOP=1 -1 -f "$MIGRATION" >/dev/null 2>"$PSQL_LOG" || die "control:apply-$VERSION" "$(first_error "$PSQL_LOG")"
  done
  say "PASS control:apply: M1-M5 applied directly, no checksum evidence"
  for VERSION in 20261003000005 20261003000004 20261003000003 20261003000002 20261003000001; do
    printf '\\i %s\n' "$RELEASE_ROOT/supabase/admin-delegation-reserve/$VERSION-rollback.sql" >"$T/reserve.sql"
    pgx -q -v ON_ERROR_STOP=1 -f "$T/reserve.sql" >/dev/null 2>"$PSQL_LOG" || die "control:reserve-$VERSION" "$(first_error "$PSQL_LOG")"
    printf '\\i %s\nSELECT :%s::boolean;\n' "$RELEASE_ROOT/deploy/release-proofs/item-ai/$VERSION-rollback-catalog.sql" "'rollback_ok'" >"$T/rollback-catalog.sql"
    OK=$(pgx -Atq -v ON_ERROR_STOP=1 -f "$T/rollback-catalog.sql" 2>"$PSQL_LOG") || die "control:rollback-catalog-$VERSION" "$(first_error "$PSQL_LOG")"
    test "$OK" = t || die "control:rollback-catalog-$VERSION" "expected t got $(grep -m1 'failed checks' "$PSQL_LOG" | cut -c1-300)"
    say "PASS control:reserve-$VERSION: reserve applied and reverse catalog true"
  done
  say "PASS control: every reserve applied and every reverse catalog true"
  exit 0
fi

step() { # label script
  local label=$1 file=$2
  : >"$T/last-sql.txt"
  # Plain command, not an if/|| condition: there bash would suppress errexit inside the subshell.
  ( set -euo pipefail; eval "$(cat "$file")" ) 3>&1 >"$T/step.out" 2>"$T/step.err"
  local status=$?
  if test "$status" = 0; then say "PASS $label"; return 0; fi
  local why
  why=$(first_error "$T/step.err")
  case "$why" in
    *ERROR:*|*FATAL:*) ;;
    *) if test -s "$SECRET_STAGE/psql.log" && grep -q 'ERROR:' "$SECRET_STAGE/psql.log"; then
         if test "$why" = 'no diagnostic'; then why=$(first_error "$SECRET_STAGE/psql.log"); else why="$why; $(first_error "$SECRET_STAGE/psql.log")"; fi
       fi
       test "$why" != 'no diagnostic' || why="exit status $status" ;;
  esac
  if grep -q 'failed checks:' "$SECRET_STAGE/psql.log" 2>/dev/null; then why="$why; $(grep -m1 -o '[a-z0-9-]* failed checks: [a-z0-9,_-]*' "$SECRET_STAGE/psql.log" | cut -c1-300)"; fi
  if test -s "$T/last-sql.txt"; then why="$why (last SQL file: $(head -c 300 "$T/last-sql.txt"))"; fi
  say "FAIL $label: $why"; exit 1
}
# A step that handles secrets: its diagnostics stay in the 0700 stage and only a fixed message is printed.
secret_step() { # label script
  ( set -euo pipefail; eval "$(cat "$2")" ) >"$SECRET_STAGE/secret-step.out" 2>"$SECRET_STAGE/secret-step.err"
  local status=$?
  if test "$status" = 0; then say "PASS $1"; return 0; fi
  # Only plan FAIL lines known to carry no secret are printed; everything else stays in the stage.
  local known
  known=$(grep -m1 -E '^FAIL ai-w2-issuer-credential: issuer LOGIN with a SCRAM-SHA-256 verifier expected t got [a-z]+ \(ALTER ROLE not applied\); STOP$' "$SECRET_STAGE/secret-step.err")
  if test -n "$known"; then say "FAIL $1: $known"; exit 1; fi
  say "FAIL $1: exit status $status (diagnostics kept in the 0700 stage, not printed)"; exit 1
}



: >"$SECRET_STAGE/psql.log"
# Pre-W2 or post-W2 is read from the dump's own ledger, and it must agree with --from-post-w2.
W2_COUNT=$(pgx -Atq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20261003000001','20261003000002','20261003000003','20261003000004','20261003000005');" 2>"$PSQL_LOG") || die ledger "$(first_error "$PSQL_LOG")"
LATER_COUNT=$(pgx -Atq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version>'20261003000000';" 2>"$PSQL_LOG") || die ledger "$(first_error "$PSQL_LOG")"
if test "$POST_W2" = 1; then
  test "$W2_COUNT" = 5 || die post-w2-ledger "five 20261003 ledger versions expected got $W2_COUNT; not a post-W2 dump"
  say "PASS post-w2-ledger: all five 20261003 versions present ($LATER_COUNT versions from 20261003 on); W2 apply skipped"
else
  test "$LATER_COUNT" = 0 || die pre-w2-ledger "no 20261003-or-later ledger version expected got $LATER_COUNT; a post-W2 dump needs --from-post-w2"
fi
if test "$W2B_ONLY" = 1; then
  : >"$SECRET_STAGE/psql.log"
  INPUTS_FILE=$W2B_INPUTS step ai-w2b-preflight:preconditions "$T/blocks/w2b-preconditions.sh"
  say "PASS rehearsal: W2b database preconditions hold on the supplied dump"
  exit 0
fi

if test "$POST_W2" = 0; then
step ai-db-session:ledger-before "$T/blocks/ledger-before.sh"
# EMULATED ai-w2-backfill: every ledger version is recorded with the sha256 of its file in this release copy.
python3 - "$PROOF_DIR" "$RELEASE_ROOT" <<'PY' || die ai-w2-backfill 'every ledger version expected one migration file got other'
import hashlib,json,pathlib,sys
proof,root=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]); rows=[]
for v in (proof/'ledger-before.txt').read_text().split():
    files=sorted((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1, v
    rows.append(dict(version=v,evidence_kind='attested-baseline',file='supabase/migrations/'+files[0].name,sha256=hashlib.sha256(files[0].read_bytes()).hexdigest()))
(proof/'backfill.json').write_text(json.dumps(rows,sort_keys=True)+'\n')
PY
say "EMUL ai-w2-backfill: backfill.json from release file digests ($(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$PROOF_DIR/backfill.json") ledger versions)"
step ai-w2-preflight:ledger-and-reserves "$T/blocks/preflight-ledger.sh"
step ai-w2-preflight:before-catalogs "$T/blocks/preflight-before.sh"
step ai-w2-measure "$T/blocks/ai-w2-measure.sh"
step ai-w2-apply "$T/blocks/ai-w2-apply.sh"
step ai-w2-probes "$T/blocks/ai-w2-probes.sh"

say "PASS rehearsal: W2 SQL in plan order on the supplied pre-W2 dump"
fi

if test -n "$DUMP_POST"; then
  step ai-w2-issuer-rollback:role "$T/blocks/issuer-rollback-role.sh"
  mkdir -p "$DUMP_POST" || die dump-post-w2 'cannot create the output directory'
  "$PG_BIN/pg_dumpall" -h "$T" -p "$PORT" -U supabase_admin -r --no-role-passwords >"$DUMP_POST/roles.sql" 2>"$PSQL_LOG" || die dump-post-w2 "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -p "$PORT" -U supabase_admin -d postgres -s >"$DUMP_POST/schema.sql" 2>"$PSQL_LOG" || die dump-post-w2 "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -p "$PORT" -U supabase_admin -d postgres -a -t supabase_migrations.schema_migrations >"$DUMP_POST/ledger.sql" 2>"$PSQL_LOG" || die dump-post-w2 "$(first_error "$PSQL_LOG")"
  # The live split: data-only ledger-extra.sql with the checksums and the cutover state.
  "$PG_BIN/pg_dump" -h "$T" -p "$PORT" -U supabase_admin -d postgres -a --disable-triggers -t commonswarm_ops.migration_checksums \
    -t commonswarm_oauth.admin_cutover_state >"$DUMP_POST/ledger-extra.sql" 2>"$PSQL_LOG" || die dump-post-w2 "$(first_error "$PSQL_LOG")"
  say "PASS dump-post-w2: roles.sql, schema.sql, ledger.sql and ledger-extra.sql (checksums, cutover state) of the post-W2 database, issuer rolled back"
fi

# ---- --issuer: the issuer credential with a REAL libpq TLS login (W2 issuer block, as W2b runs it) ----
if test "$ISSUER" = 1; then
  # The live W2 RGLqZX state: its issuer rollback disabled LOGIN and cleared the password. A post-W2 dump
  # already carries that state, so the statement is not run again there.
  if test "$POST_W2" = 0; then step ai-w2-issuer-rollback:role "$T/blocks/issuer-rollback-role.sh"; fi
  INPUTS_FILE=$W2B_INPUTS step ai-w2b-preflight:preconditions "$T/blocks/w2b-preconditions.sh"
  # TLS on 127.0.0.1 only: a throwaway CA and server certificate for db.commonswarm.internal, all in the 0700 directory.
  TLS=$T/tls; mkdir -m 0700 "$TLS" || die tls 'cannot create the TLS directory'
  {
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=c1w2 rehearsal CA' -keyout "$TLS/ca.key" -out "$TLS/ca.crt" &&
    printf 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:db.commonswarm.internal\n' >"$TLS/server.ext" &&
    openssl req -newkey rsa:2048 -nodes -subj '/CN=db.commonswarm.internal' -keyout "$TLS/server.key" -out "$TLS/server.csr" &&
    openssl x509 -req -days 1 -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -set_serial "0x$(openssl rand -hex 8)" -extfile "$TLS/server.ext" -out "$TLS/server.crt"
  } >"$TLS/openssl.log" 2>&1 || die tls 'temporary CA or server certificate could not be made'
  # Nothing of the CA may land outside the 0700 directory (an automatic CA serial file would).
  test ! -e "${T%%.*}.srl" || die tls 'a CA serial file appeared outside the mktemp directory'
  chmod 0600 "$TLS/ca.key" "$TLS/server.key"
  # Only hostssl from 127.0.0.1/32 for the issuer role; every other TCP connection is rejected. The local line is the
  # harness's own superuser setup over the unix socket in the 0700 directory.
  printf '%s\n' 'local all supabase_admin trust' \
    'hostssl postgres commonswarm_admin_issuer 127.0.0.1/32 scram-sha-256' \
    'host all all 0.0.0.0/0 reject' 'host all all ::/0 reject' >"$TLS/pg_hba.conf"
  "$PG_BIN/pg_ctl" -D "$T/data" -m fast -w -t 60 stop >/dev/null 2>&1 || die tls 'cluster stop before the TLS restart failed'
  "$PG_BIN/pg_ctl" -D "$T/data" -o "-p $PORT -c listen_addresses='127.0.0.1' -c unix_socket_directories='$T' -c ssl=on -c ssl_cert_file='$TLS/server.crt' -c ssl_key_file='$TLS/server.key' -c hba_file='$TLS/pg_hba.conf'" \
    -l "$T/pg.log" -w start >/dev/null 2>&1 || die tls 'cluster did not start with TLS on 127.0.0.1'
  record_identity "$T"
  say "PASS tls: cluster restarted with ssl=on on 127.0.0.1:$PORT; hostssl 127.0.0.1/32 for the issuer only; temporary CA in the 0700 directory"
  # Listener proof from the postmaster itself and from the OS: nothing on a non-loopback address.
  LISTEN=$(pgx -Atq -c 'SHOW listen_addresses;' 2>"$PSQL_LOG") || die listener 'SHOW listen_addresses failed'
  test "$LISTEN" = 127.0.0.1 || die listener "listen_addresses expected 127.0.0.1 got other"
  PM_PID=$(head -1 "$T/data/postmaster.pid")
  command -v lsof >/dev/null 2>&1 || die listener 'lsof expected present got missing'
  lsof -nP -a -p "$PM_PID" -iTCP -sTCP:LISTEN >"$T/listen.txt" 2>/dev/null || die listener 'lsof found no TCP listener for the postmaster'
  python3 - "$T/listen.txt" "$PORT" <<'PY' || die listener 'postmaster TCP listener expected 127.0.0.1 only got other'
import sys
rows=[l.split() for l in open(sys.argv[1]).read().splitlines()[1:] if l.strip()]
names=[r[8] if len(r)>8 else '' for r in rows]
assert names and all(n=='127.0.0.1:'+sys.argv[2] for n in names), names
PY
  say "PASS listener: postmaster $PM_PID listens on TCP 127.0.0.1:$PORT only ($(($(wc -l <"$T/listen.txt")-1)) socket; lsof and listen_addresses)"
  # The box's service.conf and pass come from the released make-pg-service.mjs; a fresh rehearsal-only password.
  command -v node >/dev/null 2>&1 || die service-conf 'node expected present got missing'
  openssl rand -hex 24 >"$SECRET_STAGE/rehearsal-admin-password" || die service-conf 'password generation failed'
  python3 - "$SECRET_STAGE" "$PORT" "$TLS/ca.crt" <<'PY' || die service-conf 'target env file could not be written'
import pathlib,sys,urllib.parse
stage,port,ca=pathlib.Path(sys.argv[1]),sys.argv[2],sys.argv[3]
pw=(stage/'rehearsal-admin-password').read_text().strip()
url='postgresql://supabase_admin:'+pw+'@db.commonswarm.internal:'+port+'/postgres?'+urllib.parse.urlencode({'sslmode':'verify-full','sslrootcert':ca,'hostaddr':'127.0.0.1'})
(stage/'target.env').write_text('TARGET_DATABASE_URL='+url+'\n'); (stage/'target.env').chmod(0o600)
PY
  env -u SOURCE_DATABASE_URL -u TARGET_DATABASE_URL PG_SERVICE_OUTPUT="$SECRET_STAGE/service.conf" PG_PASS_OUTPUT="$SECRET_STAGE/pass" \
    COMMONSWARM_ENV_FILE="$SECRET_STAGE/target.env" node "$RELEASE_ROOT/deploy/supabase-stack/migrate/make-pg-service.mjs" >"$SECRET_STAGE/db-session.log" 2>&1 \
    || die service-conf 'make-pg-service.mjs failed (diagnostics kept in the 0700 stage)'
  chmod 0600 "$SECRET_STAGE/service.conf" "$SECRET_STAGE/pass"
  grep -qx 'sslmode=verify-full' "$SECRET_STAGE/service.conf" || die service-conf 'service.conf expected sslmode=verify-full got other'
  say "PASS service-conf: service.conf and pass from the released make-pg-service.mjs (host db.commonswarm.internal, hostaddr 127.0.0.1, sslmode verify-full)"
  # Issuer preparation and ALTER ROLE from the plan bytes (--plan-from selects the block's commit); secrets stay in the stage.
  secret_step ai-w2-issuer-credential:prepare "$T/blocks/issuer-prepare.sh"
  secret_step ai-w2-issuer-credential:alter-role "$T/blocks/issuer-alter.sh"
  ISSUER_QUERY=$(cat "$T/blocks/issuer-query.sql")
  issuer_psql() { env -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER -u PGDATABASE -u PGPASSWORD -u PGSSLMODE -u PGSERVICE \
    PGSERVICEFILE="$SECRET_STAGE/issuer-service.conf" PGPASSFILE="$SECRET_STAGE/issuer-pass" "$PG_BIN/psql" "$@"; }
  if issuer_psql "service=target" -X --set=ON_ERROR_STOP=1 -Atq --command "$ISSUER_QUERY" >"$SECRET_STAGE/issuer-login.result" 2>"$SECRET_STAGE/issuer-login.log"; then
    test "$(cat "$SECRET_STAGE/issuer-login.result")" = t || die ai-w2-issuer-credential:login 'dedicated-role measurement expected t got non-t'
  else
    WHY=$(grep -o -e 'syntax error in service file "[^"]*", line [0-9]*' -e 'password authentication failed for user "commonswarm_admin_issuer"' "$SECRET_STAGE/issuer-login.log" | head -1)
    die ai-w2-issuer-credential:login "libpq login exit status expected 0 got nonzero: ${WHY:-other libpq error (diagnostics kept in the 0700 stage)}"
  fi
  SSL_USED=$(issuer_psql "service=target" -X -Atq --command 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();' 2>/dev/null) || SSL_USED=
  test "$SSL_USED" = t || die ai-w2-issuer-credential:login 'session TLS expected on got other'
  say "PASS ai-w2-issuer-credential:login: real libpq sslmode=verify-full TLS login as commonswarm_admin_issuer via issuer-service.conf and issuer-pass; plan measurement query t"
  if issuer_psql "service=target sslmode=disable" -X -Atq --command 'SELECT 1;' >/dev/null 2>&1; then die issuer-plaintext 'plaintext TCP login expected refused got accepted'; fi
  say "PASS issuer-plaintext: a non-TLS TCP login as the issuer is refused by pg_hba"
  step ai-w2-issuer-credential:proof "$T/blocks/issuer-credential-proof.sh"
  if test "${C1_W2_REHEARSAL_FAULT:-}" = post-credential-catalog; then
    # Test control: make one forward catalog row false AFTER provisioning (0002-001 requires NOT rolinherit).
    pgx -q -v ON_ERROR_STOP=1 -c 'ALTER ROLE commonswarm_admin_issuer INHERIT;' >/dev/null 2>"$PSQL_LOG" || die fault "$(first_error "$PSQL_LOG")"
    say "FAULT injected: the issuer role made INHERIT after the credential (forward catalog 0002 row 001 false)"
    ( set -euo pipefail; export WINDOW=W2b; eval "$(cat "$T/blocks/ai-w2b-forward-catalogs.sh")" ) 3>&1 >"$T/step.out" 2>"$T/step.err"
    FWD_STATUS=$?
    test "$FWD_STATUS" != 0 || die ai-w2b-forward-catalogs 'a false forward catalog expected STOP got PASS'
    say "FAIL ai-w2b-forward-catalogs: $(grep -m1 '^FAIL ai-w2b-forward-catalogs' "$T/step.err" | cut -c1-300)"
    ROLLED=$(pgx -Atq -c "SELECT NOT rolcanlogin AND rolpassword IS NULL FROM pg_authid WHERE rolname='commonswarm_admin_issuer';" 2>"$PSQL_LOG") || ROLLED=
    if test "$ROLLED" = t && test -f "$PROOF_DIR/issuer-rollback.txt" && test ! -e "$PROOF_DIR/w2b-forward-catalogs.txt"; then
      say "PASS rollback-after-catalog-failure: ai-w2-issuer-rollback ran (issuer NOLOGIN without a password, issuer-rollback.txt); no w2b-forward-catalogs.txt"
    else die rollback-after-catalog-failure 'issuer rollback expected applied got other'; fi
    exit 1
  fi
  WINDOW=W2b step ai-w2b-forward-catalogs "$T/blocks/ai-w2b-forward-catalogs.sh"
  say "PASS rehearsal: issuer credential provisioned and verified on the post-W2 database"
fi
if test "$W6" = 1; then
  # shellcheck source=c1-w6-rehearsal-steps.sh
  . "$REPO/scripts/c1-w6-rehearsal-steps.sh"
fi
