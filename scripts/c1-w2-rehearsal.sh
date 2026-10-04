#!/bin/bash
# C1 W2 schema rehearsal on a disposable local PostgreSQL cluster. Bash 3.2-safe. No network, no docker.
#
#   scripts/c1-w2-rehearsal.sh [--catalogs-from <git-sha>] [--reserve-control] <dump-dir>
#   scripts/c1-w2-rehearsal.sh --build-fixture <out-dir>
#   scripts/c1-w2-rehearsal.sh --cleanup-selftest <path>
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
# The only delete is of the script's own mktemp directory, after a pattern check (--cleanup-selftest proves
# the refusal). HOME is never assigned.
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

cleanup_dir() {
  local dir=$1
  if ! own_dir_ok "$dir"; then say "REFUSE cleanup: $dir is not this script's mktemp directory"; return 1; fi
  if test -f "$dir/data/postmaster.pid"; then "$PG_BIN/pg_ctl" -D "$dir/data" -m fast -w stop >/dev/null 2>&1; fi
  rm -rf -- "$dir"
}

on_exit() {
  local status=$?
  trap - EXIT
  if test -n "$T"; then cleanup_dir "$T" || status=1; fi
  exit "$status"
}

if test "${1:-}" = --cleanup-selftest; then
  test $# = 2 || die cleanup-selftest 'expected one path'
  if own_dir_ok "$2"; then say "ACCEPT cleanup-selftest: $2"; exit 0; fi
  say "REFUSE cleanup-selftest: $2"; exit 3
fi

MODE=rehearse CATALOGS_FROM= RESERVE_CONTROL=0 TARGET=
while test $# -gt 0; do
  case "$1" in
    --build-fixture) MODE=build; shift; TARGET=${1:-}; shift || true ;;
    --catalogs-from) shift; CATALOGS_FROM=${1:-}; shift || true ;;
    --reserve-control) RESERVE_CONTROL=1; shift ;;
    -*) die usage "unknown option $1" ;;
    *) test -z "$TARGET" || die usage 'one dump directory only'; TARGET=$1; shift ;;
  esac
done
test -n "$TARGET" || die usage 'scripts/c1-w2-rehearsal.sh [--catalogs-from <sha>] [--reserve-control] <dump-dir> | --build-fixture <out-dir>'
case "$TARGET" in /*) ;; *) TARGET=$(pwd -P)/$TARGET ;; esac
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
"$PG_BIN/pg_ctl" -D "$T/data" -o "-c listen_addresses='' -c unix_socket_directories='$T'" -l "$T/pg.log" -w start >/dev/null 2>&1 \
  || die cluster 'postgres did not start (see the server log in the temporary directory)'
say "PASS cluster: disposable PostgreSQL $("$PG_BIN/psql" --version | awk '{print $3}') on a unix socket only"

PSQL_LOG=$T/psql-err.log
pgx() { "$PG_BIN/psql" -h "$T" -U supabase_admin -d postgres -X "$@"; }
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
  "$PG_BIN/pg_dumpall" -h "$T" -U supabase_admin -r --no-role-passwords >"$TARGET/roles.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -U supabase_admin -d postgres -s >"$TARGET/schema.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  "$PG_BIN/pg_dump" -h "$T" -U supabase_admin -d postgres -a -t supabase_migrations.schema_migrations >"$TARGET/ledger.sql" 2>"$PSQL_LOG" || die fixture:dump "$(first_error "$PSQL_LOG")"
  say "PASS fixture:dump: roles.sql, schema.sql and ledger.sql written"
  exit 0
fi

# ---- rehearsal ----
for f in roles.sql schema.sql ledger.sql; do test -f "$TARGET/$f" || die restore "$TARGET/$f expected present got missing"; done
mkdir -p "$T/release" "$T/proof" "$T/stage" "$T/blocks" "$T/mapped" || exit 1
chmod 0700 "$T/stage"
RELEASE_ROOT=$T/release PROOF_DIR=$T/proof SECRET_STAGE=$T/stage
# The bootstrap role exists in every cluster; the dump's CREATE ROLE for it is the one statement dropped.
python3 - "$TARGET/roles.sql" "$T/roles.sql" <<'PY' || die restore-roles 'roles.sql could not be read'
import sys
lines=open(sys.argv[1],encoding='utf-8').read().split('\n')
open(sys.argv[2],'w',encoding='utf-8').write('\n'.join(l for l in lines if l.strip()!='CREATE ROLE supabase_admin;'))
PY
run_sql_file restore-roles "$T/roles.sql"
run_sql_file restore-schema "$TARGET/schema.sql"
run_sql_file restore-ledger "$TARGET/ledger.sql"

# Release copy: the reviewed files the plan reads, from this checkout; item-ai proofs from --catalogs-from.
python3 - "$REPO" "$RELEASE_ROOT" "$CATALOGS_FROM" "$PLAN_REL" <<'PY' || die release-copy 'could not assemble the release copy'
import io,pathlib,shutil,subprocess,sys,tarfile
repo,root,sha,plan=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4]
for rel in ['supabase/migrations','supabase/admin-delegation-reserve','deploy/release-proofs',str(pathlib.Path(plan).parent)]:
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
for f in "$T"/blocks/*.sh; do /bin/bash -n "$f" || die extract "$(basename "$f") is not valid bash"; done

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
  local args=() prev= a
  for a in "$@"; do
    if test "$prev" = --file && test "$a" != -; then
      a=$(python3 "$T/map.py" "$RELEASE_ROOT" "$PROOF_DIR" "$T/mapped" "$a") || return 1
    fi
    args+=("$a"); prev=$a
  done
  "$PG_BIN/psql" -h "$T" -U supabase_admin -d postgres -X --set=ON_ERROR_STOP=1 "${args[@]}" 2>"$SECRET_STAGE/psql.log"
}
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
    ai-w2-reconcile|ai-w2-measure)
      eval "$(cat "$T/blocks/$1.sh")" || return 1
      say "PASS $1" >&3 ;;
    *) return 1 ;;
  esac
}
export WINDOW=W2
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
  if ( eval "$(cat "$file")" ) 3>&1 >"$T/step.out" 2>"$T/step.err"; then say "PASS $label"; return 0; fi
  local why
  why=$(first_error "$T/step.err")
  case "$why" in *ERROR:*|*FATAL:*) ;; *) test -s "$SECRET_STAGE/psql.log" && grep -q 'ERROR:' "$SECRET_STAGE/psql.log" && why="$why; $(first_error "$SECRET_STAGE/psql.log")" ;; esac
  say "FAIL $label: $why"; exit 1
}

: >"$SECRET_STAGE/psql.log"
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
