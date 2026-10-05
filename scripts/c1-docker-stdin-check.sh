#!/bin/bash
# C1 docker stdin check (CI, Ubuntu with docker; never on the Mac mini). Bash 3.2-safe. No secrets, no network beyond
# the local docker daemon and the image pull.
#
#   PG_BIN=/usr/lib/postgresql/17/bin C1_DOCKER_PSQL_IMAGE=postgres:17 scripts/c1-docker-stdin-check.sh
#
# Starts a disposable PostgreSQL 17 cluster on 127.0.0.1 (trust, mktemp directory), then runs the plan's OWN ai_db and
# ai_db_secret_file (extracted from the ai-db-session block of RELEASE.md) through REAL docker with the psql image.
# Only the box-only network flags (--network commonswarm-net --add-host ...) become --network host and the box CA
# path becomes a local empty file; every other argument is the plan's. It proves:
#   1. docker run WITHOUT -i never gives the container stdin: psql --file - on the release-Z shape exits 0 and runs
#      nothing (the W2b 67aAId failure);
#   2. the plan's ai_db refuses --file - (fails closed, exit 2) and runs nothing;
#   3. the plan's ai_db_secret_file runs the SQL from a read-only mounted file;
#   4. the plan's ai_db runs a /proof file through its read-only proof mount.
# Each prints one PASS/FAIL line; the first FAIL exits nonzero. The cluster directory is deleted only after a verified
# stop and only when it is this script's own mktemp directory.
set -u
set -o pipefail

REPO=$(cd -P "$(dirname "$0")/.." && pwd -P) || exit 1
PLAN=$REPO/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md
PG_BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
IMAGE=${C1_DOCKER_PSQL_IMAGE:-postgres:17}
D=
say() { printf '%s\n' "$*"; }
die() { say "FAIL $1: $2"; exit 1; }
own_dir_ok() { [[ "$1" =~ ^(/private)?/tmp/c1dk\.[A-Za-z0-9]{6}$ ]] && test -d "$1" && ! test -L "$1"; }
on_exit() {
  local status=$?
  trap - EXIT
  if test -n "$D" && own_dir_ok "$D"; then
    if test -e "$D/data/postmaster.pid"; then
      if "$PG_BIN/pg_ctl" -D "$D/data" -m fast -w -t 60 stop >/dev/null 2>&1; then rm -rf -- "$D"; say "PASS cleanup: cluster stopped; $D absent"
      else say "RETAIN cleanup: pg_ctl stop failed; $D kept"; status=1; fi
    else rm -rf -- "$D"; say "PASS cleanup: $D absent"; fi
  fi
  exit "$status"
}

if test "${C1_DOCKER_STAND_IN:-0}" = 1; then
  # Test control only (no docker on the Mac): a local stand-in with the box's semantics, stdin NEVER attached (no -i),
  # --env and read-only volumes honoured, psql from PG_BIN. It proves this script's logic; CI runs the real docker.
  docker() {
    local vols= envs=() args=() a v src dst
    case "${1:-}" in image) return 0 ;; pull) return 0 ;; run) shift ;; *) return 64 ;; esac
    while test $# -gt 0; do
      case "$1" in --rm) shift ;; --network) shift 2 ;; --env) envs+=("$2"); shift 2 ;; --volume) vols="$vols
$2"; shift 2 ;; --entrypoint) test "${2:-}" = psql || return 64; shift 3; break ;; *) return 64 ;; esac
    done
    map() { local x=$1; while IFS= read -r v; do test -n "$v" || continue; src=${v%%:*}; dst=${v#*:}; dst=${dst%%:*}
      case "$x" in "$dst") x=$src ;; "$dst"/*) x=$src${x#"$dst"} ;; *=*) test "${x#*=}" != "$dst" || x=${x%%=*}=$src ;; esac; done <<EOF_VOLUMES
$vols
EOF_VOLUMES
      printf '%s' "$x"; }
    for a in "${envs[@]}"; do args+=("$(map "$a")"); done
    local cmd=(); for a in "$@"; do cmd+=("$(map "$a")"); done
    env "${args[@]}" "$PG_BIN/psql" "${cmd[@]}" </dev/null
  }
  say "EMUL docker: local stand-in (stdin never attached), C1_DOCKER_STAND_IN=1 test control"
else
  command -v docker >/dev/null 2>&1 || die setup 'docker expected present got missing (this check runs in CI only)'
fi
for tool in initdb pg_ctl psql; do test -x "$PG_BIN/$tool" || die setup "$tool expected in $PG_BIN got missing"; done
D=$(mktemp -d /tmp/c1dk.XXXXXX) || die setup 'mktemp failed'
D=$(cd -P "$D" && pwd -P) || exit 1
own_dir_ok "$D" || { say "FAIL setup: $D does not match the cleanup pattern"; exit 1; }
trap on_exit EXIT
trap 'exit 130' INT TERM

"$PG_BIN/initdb" -U supabase_admin --auth=trust -E UTF8 --locale=C -D "$D/data" >"$D/initdb.log" 2>&1 || die cluster 'initdb failed'
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()') || die cluster 'no port'
"$PG_BIN/pg_ctl" -D "$D/data" -o "-p $PORT -c listen_addresses='127.0.0.1' -c unix_socket_directories='$D'" -l "$D/pg.log" -w start >/dev/null 2>&1 \
  || die cluster 'postgres did not start'
local_sql() { "$PG_BIN/psql" -h "$D" -p "$PORT" -U supabase_admin -d postgres -X -Atq --set=ON_ERROR_STOP=1 "$@" </dev/null; }
local_sql --command 'CREATE TABLE c1_stdin_probe(n int);' >/dev/null || die cluster 'probe table'
count() { local_sql --command 'SELECT count(*) FROM c1_stdin_probe;'; }
say "PASS cluster: PostgreSQL on 127.0.0.1:$PORT (trust, disposable)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null || die image "docker pull $IMAGE failed"
say "PASS image: $IMAGE"

# The plan's own functions, extracted from the verified block text; only the box-only network flags and CA path change.
python3 - "$PLAN" "$D/ai_db.sh" "$D/ca.pem" <<'PY' || die extract 'ai_db and ai_db_secret_file expected in ai-db-session got other'
import re,sys
plan,out,ca=sys.argv[1:4]
block=[b for b in re.findall(r'^```sh\n(.*?)^```$',open(plan).read(),re.M|re.S) if b.startswith('# step: ai-db-session\n')]
assert len(block)==1
b=block[0]
start=b.index('ai_db_grammar() {'); end=b.index('\npython3 - "$MIGRATE/lib.sh"',start)
src=b[start:end]+'\n'
assert src.count('ai_db_secret_file() {')==1 and src.count('docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 ')==2
src=src.replace('docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 ','docker run --rm --network host ')
assert src.count('/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro')==2
src=src.replace('/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro',ca+':/etc/ssl/yulan-internal-ca.pem:ro')
open(out,'w').write(src)
PY
: >"$D/ca.pem"
mkdir -m 0700 "$D/stage" "$D/release" "$D/proof" || exit 1
SECRET_STAGE=$D/stage RELEASE_ROOT=$D/release PROOF_DIR=$D/proof PSQL_IMAGE=$IMAGE
PGSERVICE_FILE=$SECRET_STAGE/service.conf PGPASS_FILE=$SECRET_STAGE/pass
printf '[target]\nhost=127.0.0.1\nport=%s\ndbname=postgres\nuser=supabase_admin\nsslmode=disable\n' "$PORT" >"$PGSERVICE_FILE"
printf '127.0.0.1:%s:postgres:supabase_admin:unused\n' "$PORT" >"$PGPASS_FILE"
chmod 0644 "$PGSERVICE_FILE" "$D/ca.pem"; chmod 0600 "$PGPASS_FILE"
# Test files only (no secret): readable by whatever user the image runs psql as, through the read-only mounts.
chmod 0755 "$SECRET_STAGE" "$PROOF_DIR"
eval "$(cat "$D/ai_db.sh")"
type ai_db >/dev/null 2>&1 && type ai_ro >/dev/null 2>&1 && type ai_db_secret_file >/dev/null 2>&1 || die extract 'functions not defined'
printf 'INSERT INTO c1_stdin_probe VALUES (1);\n' >"$SECRET_STAGE/statement.sql"; chmod 0600 "$SECRET_STAGE/statement.sql"

# 1. The release-Z shape: docker run WITHOUT -i, SQL on stdin. psql sees no stdin, runs nothing, exits 0.
docker run --rm --network host --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$PGSERVICE_FILE:/run/service.conf:ro" --volume "$PGPASS_FILE:/run/pass:ro" \
  --entrypoint psql "$IMAGE" -X --set=ON_ERROR_STOP=1 -q --file - <"$SECRET_STAGE/statement.sql" >"$D/stdin.out" 2>"$D/stdin.err"
STDIN_STATUS=$?
test "$STDIN_STATUS" = 0 && test "$(count)" = 0 || die docker-stdin "release-Z shape expected exit 0 and no row (silent no-op) got status $STDIN_STATUS rows $(count)"
say "PASS docker-stdin-no-op: docker run without -i, psql --file - <file: exit 0 and nothing ran (rows 0), the W2b 67aAId failure reproduced"
# 2. The plan's ai_db and ai_ro refuse every form outside their grammar before any docker call: stdin in all its
#    spellings, clustered short options, abbreviations, = forms, files outside the /proof and /release mounts.
REFUSED=0
for form in "ai_db -q --file -" "ai_db -q -f -" "ai_db -qf -" "ai_db -q --file /dev/stdin" "ai_db -q --file /dev/fd/0" "ai_db -q --file /proc/self/fd/0" \
  "ai_db -q --file=-" "ai_db -q --fil -" "ai_db -q -c SELECT\ 1" "ai_db -q --file /tmp/x.sql" "ai_db -q --file /proof/../x.sql" "ai_db -q" "ai_ro -qf -" "ai_ro -Atq"; do
  eval "$form" <"$SECRET_STAGE/statement.sql" >/dev/null 2>"$D/refuse.err"; REFUSE_STATUS=$?
  test "$REFUSE_STATUS" = 2 && grep -qE '^FAIL ai_(db|ro): arguments expected the plan grammar' "$D/refuse.err" && test "$(count)" = 0 \
    || die ai_db-grammar "$form: status 2 and the grammar FAIL line expected got status $REFUSE_STATUS"
  REFUSED=$((REFUSED + 1))
done
say "PASS ai_db-grammar: the plan's ai_db/ai_ro refused $REFUSED forms outside the grammar (stdin, /dev/stdin, /dev/fd, clustered -qf, abbreviations, = forms, foreign files) with exit 2; nothing ran"
# 3. The plan's ai_db_secret_file: a read-only mounted file, never stdin.
ai_db_secret_file "$SECRET_STAGE/statement.sql" >/dev/null || die ai_db_secret_file "exit status expected 0 got $? ($(head -c 300 "$SECRET_STAGE/psql.log"))"
test "$(count)" = 1 || die ai_db_secret_file "one row expected got $(count)"
say "PASS ai_db_secret_file: the plan's helper ran the SQL from a read-only mounted file (rows 1)"
# 4. The plan's ai_db with a /proof file through its read-only proof mount.
printf 'INSERT INTO c1_stdin_probe VALUES (2);\n' >"$PROOF_DIR/probe.sql"; chmod 0644 "$PROOF_DIR/probe.sql"
ai_db -q --file /proof/probe.sql >/dev/null || die ai_db-proof-file "exit status expected 0 got $?"
test "$(count)" = 2 || die ai_db-proof-file "two rows expected got $(count)"
say "PASS ai_db-proof-file: the plan's ai_db ran /proof/probe.sql from the read-only proof mount (rows 2)"
# 5. A failing secret statement through the plan's helper never reaches the server log; the control (same failing
#    statement, without the helper's session settings) shows the server WOULD log it.
MARK_A=c1-log-control-$$ MARK_B=c1-log-secret-$$
printf "ALTER ROLE c1_no_such_role PASSWORD '%s';\n" "$MARK_A" >"$SECRET_STAGE/log-control.sql"
printf "ALTER ROLE c1_no_such_role PASSWORD '%s';\n" "$MARK_B" >"$SECRET_STAGE/log-secret.sql"
chmod 0600 "$SECRET_STAGE/log-control.sql" "$SECRET_STAGE/log-secret.sql"
docker run --rm --network host --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$PGSERVICE_FILE:/run/service.conf:ro" --volume "$PGPASS_FILE:/run/pass:ro" --volume "$SECRET_STAGE/log-control.sql:/run/secret.sql:ro" \
  --entrypoint psql "$IMAGE" -X --set=ON_ERROR_STOP=1 -q --file /run/secret.sql >/dev/null 2>&1 && die secret-log 'control statement expected to fail got success'
ai_db_secret_file "$SECRET_STAGE/log-secret.sql" >/dev/null 2>&1 && die secret-log 'helper statement expected to fail got success'
sleep 1
grep -q "$MARK_A" "$D/pg.log" || die secret-log 'control: the server log expected the failing statement got none'
if grep -q "$MARK_B" "$D/pg.log"; then die secret-log "the helper's failing statement expected absent from the server log got present"; fi
say "PASS secret-sql-not-logged: the plan helper's failing statement is absent from the server log; the control is logged"
say "PASS docker-stdin-check: $IMAGE"
