# C+D edge-only follow-up with migrations already applied
Mac blocks must not call setuid/setgid tools.

**Prepared, not executed.** HezLead must independently review, land this lane,
provide exact-SHA gate evidence, and separately authorize a new live window.
Window 2 left migrations 20261001000001..05 applied and restored edge to
`65a6caf0f03066d60a18591fca3a370ecc59744d`. The retained report is the handoff,
not a worker measurement. OAuth `00e89738`, stack `ad964ed1`, site `603a206e`,
MCP ON and the live byte-equal 2 GiB override are required by the edge gates.

HezLead's read-only box probes confirmed that window 2 tested Cloudflare
Browser Integrity Check: Python-urllib/3.12 received 403, server=cloudflare,
body "error code: 1010", before Caddy. With curl/8.7.1 the same synthetic
request reached baseline edge 65a6caf0 and returned 400 invalid_request.
These are supplied measurements. RESULT-2's unresolved-responder diagnosis is
superseded. Content-type cannot distinguish Cloudflare from the edge.

The direct admin contract probe targets
`http://127.0.0.1:9000/functions/v1/read` with `Host: api.commonswarm.com`.
At RELEASE_SHA, deploy/edge-runtime/main/router.ts strips `/functions/v1/`
and dispatches read; deploy/supabase-stack/commonswarm-api.caddy proxies that
path unchanged and preserves Host (only X-Forwarded-For is overridden).
The public end-to-end probe sets `User-Agent: curl/8.7.1`. Both must return
403 with the exact JSON error `credential_kind_forbidden`; a Cloudflare server
header alone does not prove a block because successful edge traffic is proxied.
A Cloudflare response without that contract, or an "error code: NNNN" body,
fails as `cloudflare_block`. Preserve the credential-kind security boundary.

This is an edge release only: no DDL, migration apply/rollback, admin activation,
stack release directory/current, OAuth/site/image or persistent env change.
The tools/list params repair ships in this release; Claim-seat changes remain
excluded. Runtime inventory must match `810b44dc` except for the reviewed
`supabase/functions/mcp/protocol.ts` list-params repair. cd-archive enforces
that exact path exception and requires the hosted auth/protocol gate at the
landed RELEASE_SHA. Any other runtime delta requires a new review and plan.

Use the [generalized ON edge plan](../2026-10-02-edge-mcp-release/RELEASE.md)
verbatim, including every gate, override carry, rollback, failed-open cleanup,
external drift check, recycle timer recovery and measured 503 receipt. The marked
blocks below add only the read-only applied-schema session and admin smoke.
Do not reuse cd-preflight from the original C+D plan: it requires absence.
The schema source is extracted only under a fresh task-owned proof directory;
only its five forward catalogs are copied. The session exposes **only**
release_psql_ro, with default_transaction_read_only=on, and no migration writer.
Each required ledger count must be 1; every included catalog's
`SELECT :'catalog_ok'::boolean` must yield exactly `t`; STOP otherwise.
Ledger/file reconciliation refuses unrelated missing or unknown migrations.

Run only complete marked blocks extracted by ID from these two exact-release
plans. No operator-authored commands inside the approved live window. Keep one
Mac Bash 3.2 shell; box invocations use root Bash 5.2, Python 3.12 (tar filter),
Node, cached PostgreSQL 17 image and noninteractive ops/root SSH. No browser,
GUI, keychain, HOME change, Actions dispatch/push, image pull or package install.
Existing box credential files suffice; no 1Password operation is needed.
If credential recovery is separately assigned, use only the service-account
token file. Every secret stage is a fresh mode-0700
`mktemp -d /private/tmp/anvil-secret.XXXXXX`, mode-0600 secret files, removed at
close/abort. Never print secrets, raw headers/bodies/env/inspect/config/logs.
Mac cleanup uses guarded rm; box cleanup retains the inherited root exact-path
checks. A guard refusal stops cleanup and retains the exact path/message.

## Inputs and required evidence

| Input | Format/source | Use |
| --- | --- | --- |
| RELEASE_SHA | Full 40 lowercase hex, reviewed lane merge landed on origin/main; differs from baseline | Both archives, immutable runtime inventory and proofs. |
| BASELINE_EDGE_SHA | `65a6caf0f03066d60a18591fca3a370ecc59744d` | cd-edge-inputs sets it; all generalized baseline/rollback checks retain it. |
| CD_PLAN_FILE | Absolute exact-release path to this file | Schema session/admin marked extraction. |
| EDGE_PLAN_FILE | Absolute exact-release path to generalized edge plan | Sets PLAN_FILE; all existing edge steps use it. |
| GATE_EVIDENCE_FILE | Regular, nonsymlink, nonsecret lead file | Must contain SHA=RELEASE_SHA and all exact gate lines below. |
| PREFLIGHT_WINDOW_END_UTC | UTC YYYY-MM-DDTHH:MM:SSZ, future ≤30 minutes at cd-stage | Bounds applied-schema preflight and the handoff to edge. |
| WINDOW_END_UTC | Fresh future UTC ≤30 minutes at edge preflight | Generalized forward edge deadline; cleanup/rollback remain available later. |
| MAX_MCP_OUTAGE_SECONDS | **240** | Sets bounded outage approval; generic receipt covers rollback. |
| CD_ARCHIVE_DIR / CD_WINDOW_ID / CD_BOX_ARCHIVE_PATH / CD_ARCHIVE_SHA256 | Fresh /private/tmp/cd-release-archive.XXXXXX, six alphanumerics, /tmp/cd-release-SHA-ID.tar, SHA256 | Derived by cd-archive; preserve original inputs for session cleanup. |
| CD_BOX_STEP | Allowlisted schema/session/smoke step | cd-transport; argument 6 is current edge WINDOW_ID for admin smoke. |
| PLAN_FILE / ARCHIVE_DIR / WINDOW_ID / BOX_ARCHIVE_PATH / EDGE_ARCHIVE_SHA256 / BOX_STEP | Generalized edge inputs/state | Separate edge transport and cleanup; use edge-mcp-preflight-open for paired preflight/open. |
| SECRET_STAGE | Exact reported failed-session/open stage only | Argument 7 of cd-transport for cd-open-abort; argument 8 of edge transport for edge-mcp-open-abort. Never guess/glob. |
| Network/flags/override/timer | commonswarm-net, public flags 1, 2147483648 bytes, active six-hour timer | Every generalized edge live gate remains required. |

Required GATE_EVIDENCE_FILE lines, with SHA from the **landed release**, not a
preparation SHA (all repeated exactly from the original C+D gate plus boundary coverage):

```text
SHA=<RELEASE_SHA>
npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS
node supabase/functions/read/build-admin-recovery.mjs && git diff --exit-code supabase/functions/read/admin-recovery-contract.ts: PASS
npm run check:edge: PASS
node --import tsx --test tests/release-proof-format.test.ts: PASS
both release plans /bin/bash -n: PASS
node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts: PASS
node --import tsx --test tests/hosted-mcp-auth.test.ts tests/hosted-mcp-protocol.test.ts: PASS
```

"both release plans" means this follow-up and the generalized ON edge plan.
Evidence additionally includes git diff --check and identity/trailers for the
landed range. No offline check proves production PostgreSQL execution or the
external public ingress. HezLead owns cross-family review and authorization.

## Step order and stopping rules

1. cd-archive; via cd-transport run cd-stage, cd-session, cd-applied-preflight.
   This preflight is read-only against production and must PASS before any edge
   window opens. Missing ledger/catalog proof means STOP, with no schema repair.
2. cd-edge-inputs; generalized edge-mcp-archive; edge-mcp-preflight and
   edge-mcp-open in the same root invocation via edge-mcp-preflight-open;
   edge-mcp-stage; edge-mcp-transition-503; edge-mcp-apply;
   edge-mcp-restore-on; edge-mcp-probes. Carry the live override unchanged.
3. Via cd-transport run cd-admin-smoke (WINDOW_ID must still name the edge
   window), then edge-mcp-close, edge-mcp-mac-close; via cd-transport run
   cd-proof-close; cd-mac-close. Preserve both proof directories.

A failed block stops forward work. Do not retry a failed block without HezLead.
New attempts get fresh archive/window IDs and never reopen a closed window.
Pre-edge failures: cd-proof-close then cd-mac-close; if stage had no state use
cd-stage-abort; if session had no helper use persisted state cleanup, or the
exact-path cd-open-abort when state cannot be read. Keep incomplete proofs.
Once edge open completed, follow the generalized failure path: rollback,
edge-mcp-probes, edge-mcp-close, edge-mcp-mac-close, then cd-proof-close and
cd-mac-close. **cd-admin-smoke FAIL always requires edge-mcp-rollback** before
baseline probes and close. Leave all five migrations applied; no SQL rollback
block or approval input exists here. If edge rollback fails, use
edge-mcp-timer-recover, retain the start receipt/secret stage, report ongoing
outage and STOP; never close or claim ON without verification. Partial open
uses edge-mcp-open-abort exactly as the generalized plan specifies.

Smoke receipts in the **edge** proof directory retain only probe label, status,
normalized content type (known media only; others become "other"), server
(cloudflare/caddy, otherwise "other" or null), bounded sample size (131073 means
at least that many bytes), and the error field only when `^[a-z_]{1,64}$ matches.
They are written incrementally on PASS and FAIL; precondition failure has an
empty failure receipt. On FAIL, print these same redacted metadata plus a stable
failure name; never print raw headers/body, token or exception text. Loopback
health is the positive control. Direct read proves the new edge contract without
Cloudflare, and public read proves ingress with the explicit curl agent. The
fixture has no real credential and no apikey. Authenticated admin and MCP tools
success remain NOT PROVED; no tools/list smoke requiring a real bearer is added.
All schemas/catalogs/ledger and cron stay unchanged.

Retain exact-SHA gate inputs/checksums, five ledger/catalog=t receipts,
applied-before/closed-ledger, routine backfill, cron comparison, edge config/env
fingerprints, baseline identities/override checks, ON/public probes, redacted
admin-smoke.json, 503 duration/budget and cleanup/closed receipts. No secret
stage, raw body/header/log or database service/pass file enters copyback.

## Marked follow-up blocks

```sh
# step: cd-archive
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-archive: line $LINENO; STOP before window" >&2' ERR
: "${RELEASE_SHA:?}" "${CD_PLAN_FILE:?}" "${EDGE_PLAN_FILE:?}" "${GATE_EVIDENCE_FILE:?}"
case "$RELEASE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#RELEASE_SHA}" = 40
test "$RELEASE_SHA" != 65a6caf0f03066d60a18591fca3a370ecc59744d
test -z "$(git status --porcelain)"
git remote get-url origin | python3 -c 'import sys; assert sys.stdin.read().strip() in ("https://github.com/yulanventures/commonswarm.git","git@github.com:yulanventures/commonswarm.git")'
git fetch origin main
test "$(git rev-parse "${RELEASE_SHA}^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
git merge-base --is-ancestor 810b44dc71b89a2a02979eecc38c0dcbc24cf2a2 "$RELEASE_SHA"
git diff --quiet 810b44dc71b89a2a02979eecc38c0dcbc24cf2a2 "$RELEASE_SHA" -- supabase/functions supabase/migrations deploy/edge-runtime deploy/supabase-stack \
 ':(exclude)supabase/functions/mcp/protocol.ts'
python3 - "$CD_PLAN_FILE" "$EDGE_PLAN_FILE" "$GATE_EVIDENCE_FILE" "$RELEASE_SHA" <<'PYCODE'
import pathlib,subprocess,sys
for value,relative in zip(sys.argv[1:3],['docs/evidence/2026-10-02-cd-edge-release/RELEASE.md','docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md']):
 p=pathlib.Path(value); assert p.is_absolute() and not p.is_symlink() and p.is_file()
 assert p.read_bytes()==subprocess.check_output(['git','show',sys.argv[4]+':'+relative])
p=pathlib.Path(sys.argv[3]); assert p.is_file() and not p.is_symlink()
lines=p.read_text().splitlines(); assert 'SHA='+sys.argv[4] in lines
for gate in ['npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js',
 'node supabase/functions/read/build-admin-recovery.mjs && git diff --exit-code supabase/functions/read/admin-recovery-contract.ts',
 'npm run check:edge','node --import tsx --test tests/release-proof-format.test.ts','both release plans /bin/bash -n']:
 assert gate+': PASS' in lines, 'FAIL cd-archive: missing exact-SHA gate evidence'
assert 'node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts: PASS' in lines, 'FAIL cd-archive: missing router boundary evidence'
assert 'node --import tsx --test tests/hosted-mcp-auth.test.ts tests/hosted-mcp-protocol.test.ts: PASS' in lines, 'FAIL cd-archive: missing tools/list evidence'
PYCODE
CD_ARCHIVE_DIR=$(mktemp -d /private/tmp/cd-release-archive.XXXXXX)
chmod 0700 "$CD_ARCHIVE_DIR"
CD_WINDOW_ID=${CD_ARCHIVE_DIR##*.}
git archive --format=tar --output "$CD_ARCHIVE_DIR/release.tar" "$RELEASE_SHA"
test "$(git get-tar-commit-id <"$CD_ARCHIVE_DIR/release.tar")" = "$RELEASE_SHA"
chmod 0600 "$CD_ARCHIVE_DIR/release.tar"
CD_ARCHIVE_SHA256=$(shasum -a 256 "$CD_ARCHIVE_DIR/release.tar" | awk '{print $1}')
CD_BOX_ARCHIVE_PATH=/tmp/cd-release-${RELEASE_SHA}-${CD_WINDOW_ID}.tar
printf -v REMOTE_COMMAND 'test "$(stat -c %%a /tmp)" = 1777 && (set -C; umask 077; : > %q)' "$CD_BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
scp -p "$CD_ARCHIVE_DIR/release.tar" "ops@100.115.66.74:$CD_BOX_ARCHIVE_PATH"
printf 'CD_WINDOW_ID=%s\nCD_BOX_ARCHIVE_PATH=%s\nCD_ARCHIVE_SHA256=%s\n' "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256"
```

```sh
# step: cd-transport
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-transport: line $LINENO; STOP" >&2' ERR
: "${CD_PLAN_FILE:?}" "${CD_BOX_STEP:?}" "${RELEASE_SHA:?}" "${CD_WINDOW_ID:?}" "${CD_ARCHIVE_DIR:?}"
python3 - "$CD_ARCHIVE_DIR" "$CD_WINDOW_ID" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/cd-release-archive\.[A-Za-z0-9]{6}',str(p))
assert str(p).rsplit('.',1)[1]==sys.argv[2] and not p.is_symlink() and p.resolve(strict=True)==p
assert p.is_dir() and p.stat().st_mode & 0o777==0o700
PYCODE
case "$CD_BOX_STEP" in
 cd-stage|cd-session|cd-applied-preflight|cd-admin-smoke|cd-proof-close|cd-open-abort|cd-stage-abort) ;;
 *) echo 'FAIL cd-transport: unknown step; STOP' >&2; exit 1;;
esac
python3 - "$CD_PLAN_FILE" "$CD_BOX_STEP" >"$CD_ARCHIVE_DIR/box-step.sh" <<'PYCODE'
import pathlib,re,sys
blocks=re.findall(r'^```sh\n(.*?)^```$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1, 'FAIL cd-transport: duplicate/missing step'
print(found[0])
PYCODE
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -s -- %q %q %q %q %q %q %q' \
 "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" \
 "$PREFLIGHT_WINDOW_END_UTC" "${WINDOW_ID:-}" "${SECRET_STAGE:-}"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND" <"$CD_ARCHIVE_DIR/box-step.sh"
```

```sh
# step: cd-stage
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-stage: line $LINENO; no schema/service change; STOP" >&2' ERR
RELEASE_SHA=${1:?}; CD_WINDOW_ID=${2:?}; CD_BOX_ARCHIVE_PATH=${3:?}; CD_ARCHIVE_SHA256=${4:?}
PREFLIGHT_WINDOW_END_UTC=${5:?}
test "$(id -u)" = 0
python3 - "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" "$PREFLIGHT_WINDOW_END_UTC" <<'PYCODE'
import datetime,pathlib,re,sys
s,w,a,h,end=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and s!='65a6caf0f03066d60a18591fca3a370ecc59744d'
assert re.fullmatch('[A-Za-z0-9]{6}',w) and a==f'/tmp/cd-release-{s}-{w}.tar'
assert re.fullmatch('[0-9a-f]{64}',h)
assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',end)
until=datetime.datetime.strptime(end,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(until-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800
p=pathlib.Path(a); assert not p.is_symlink() and p.is_file() and p.stat().st_mode & 0o777==0o600
PYCODE
test "$(sha256sum "$CD_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$CD_ARCHIVE_SHA256"
BASELINE_EDGE_SHA=65a6caf0f03066d60a18591fca3a370ecc59744d
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA"
PROOF_DIR=/home/commonswarm/edge/schema-proofs/${RELEASE_SHA}-${CD_WINDOW_ID}
STACK_RELEASE=$PROOF_DIR/source
# Task-owned source staging only; no stack release/current or service changes.
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR"
install -d -m 0700 -o root -g root "$PROOF_DIR"
python3 - "$CD_BOX_ARCHIVE_PATH" "$PROOF_DIR" "$RELEASE_SHA" <<'PYCODE'
import hashlib,os,pathlib,shutil,sys,tarfile
archive,proof,sha=sys.argv[1:]; proof=pathlib.Path(proof); source=proof/'source'
source.mkdir(mode=0o700)
with tarfile.open(archive) as tar:
 names=set()
 for m in tar.getmembers():
  p=pathlib.PurePosixPath(m.name)
  assert not p.is_absolute() and '..' not in p.parts and m.name not in names and m.name!='RELEASE_SHA'
  names.add(m.name); assert m.isfile() or m.isdir() or m.issym()
  if m.issym():
   target=pathlib.PurePosixPath(m.linkname); assert not target.is_absolute() and '..' not in target.parts
 tar.extractall(source,filter='data')
(source/'RELEASE_SHA').write_text(sha+'\n')
for version in ['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005']:
 for suffix in ['catalog.sql']:
  p=source/'deploy/release-proofs/item-cd'/f'{version}-{suffix}'
  assert p.is_file() and not p.is_symlink()
  shutil.copyfile(p,proof/p.name); os.chmod(proof/p.name,0o600)
(proof/'proof-inputs.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(proof.glob('*.sql'))))
print('PASS cd-stage: exact archive and five forward catalogs; no release/service/schema mutation')
PYCODE
# Persist paths only; never persist credential contents in proof state.
{
 for name in RELEASE_SHA CD_WINDOW_ID CD_BOX_ARCHIVE_PATH CD_ARCHIVE_SHA256 PREFLIGHT_WINDOW_END_UTC BASELINE_EDGE_SHA PROOF_DIR STACK_RELEASE; do printf '%s=%q\n' "$name" "${!name}"; done
} >"$PROOF_DIR/state.sh"
chmod 0600 "$PROOF_DIR/state.sh"
```

```sh
# step: cd-session
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'printf "FAIL cd-session: line %s; no schema/service change; cd-open-abort SECRET_STAGE=%s\n" "$LINENO" "${SECRET_STAGE:-not-created}" >&2' ERR
. "/home/commonswarm/edge/schema-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt" && test ! -e "$PROOF_DIR/session-ready.txt"
umask 077
test -d /private/tmp && test ! -L /private/tmp
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
# Persist the exact cleanup path immediately, including failures before helper creation.
printf 'SECRET_STAGE=%q\n' "$SECRET_STAGE" >>"$PROOF_DIR/state.sh"
MIGRATE=$STACK_RELEASE/deploy/supabase-stack/migrate
PGSERVICE_FILE=$SECRET_STAGE/service.conf
PGPASS_FILE=$SECRET_STAGE/pass
APPLY_SQL=$PROOF_DIR/apply.sql
DB_SESSION=$SECRET_STAGE/session.sh
PSQL_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.147
PSQL_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$PSQL_IMAGE")
POSTGRES_CIDS=()
while IFS= read -r value; do test -z "$value" || POSTGRES_CIDS[${#POSTGRES_CIDS[@]}]=$value; done < <(docker ps -q --filter label=com.docker.compose.project=commonswarm-supabase-stack --filter label=com.docker.compose.service=postgres)
test "${#POSTGRES_CIDS[@]}" = 1
test "$(docker inspect --format '{{.Image}}' "${POSTGRES_CIDS[0]}")" = "$PSQL_IMAGE_ID"
for path in /home/commonswarm/.env /etc/commonswarm-release/target.env; do
 test -f "$path" && test ! -L "$path" && test "$(stat -c %a "$path")" = 600
done
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL
# make-pg-service reads the existing files; credentials never enter shell variables/argv.
PG_SERVICE_OUTPUT="$PGSERVICE_FILE" PG_PASS_OUTPUT="$PGPASS_FILE" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "$MIGRATE/make-pg-service.mjs" >/dev/null 2>&1
chmod 0600 "$PGSERVICE_FILE" "$PGPASS_FILE"
install -m 0600 /dev/null "$APPLY_SQL"
{
 for name in MIGRATE PGSERVICE_FILE PGPASS_FILE APPLY_SQL DB_SESSION PSQL_IMAGE; do printf '%s=%q\n' "$name" "${!name}"; done
} >>"$PROOF_DIR/state.sh"
cat >"$DB_SESSION" <<'HELPERS'
release_psql_ro() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$APPLY_SQL") CONTAINER_FILE=/run/commonswarm-release-apply.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql_ro: --file must name APPLY_SQL or a PROOF_DIR file' >&2; return 2 ;;
        esac
        PSQL_ARGS[${#PSQL_ARGS[@]}]=--file
        PSQL_ARGS[${#PSQL_ARGS[@]}]="$CONTAINER_FILE"
        shift 2
        ;;
      -f|-f?*|--file=*) printf '%s\n' 'release_psql_ro: use separate --file and host path arguments' >&2; return 2 ;;
      *) PSQL_ARGS[${#PSQL_ARGS[@]}]="$1"; shift ;;
    esac
  done
  docker run --rm \
    --network commonswarm-net \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --env PGSERVICE=target \
    --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
    --env PGPASSFILE=/run/commonswarm-pg-pass \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    --volume "$PGSERVICE_FILE:/run/commonswarm-pg-service.conf:ro" \
    --volume "$PGPASS_FILE:/run/commonswarm-pg-pass:ro" \
    --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
    --volume "$STACK_RELEASE/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$APPLY_SQL:/run/commonswarm-release-apply.sql:ro" \
    --entrypoint psql \
    "$PSQL_IMAGE" \
    -X --set=ON_ERROR_STOP=1 "${PSQL_ARGS[@]}"
}
HELPERS
chmod 0600 "$DB_SESSION"
. "$DB_SESSION"
# Reuse the repository's literal target identity SQL without running run-db-tool,
# which stages connection files outside the task's protected secret directory.
python3 - "$MIGRATE/lib.sh" "$PROOF_DIR/identity.sql" <<'PYCODE'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
part=source.split('assert_target_identity() {\n',1)[1].split('\nassert_backup_ro_identity()',1)[0]
sql=part.split("<<'SQL'\n",1)[1].split('\nSQL',1)[0]
assert "current_user <> 'supabase_admin'" in sql and 'rolsuper' in sql
pathlib.Path(sys.argv[2]).write_text(sql+'\n')
PYCODE
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
printf 'ready\n' >"$PROOF_DIR/session-ready.txt"
printf 'PASS cd-session: target-only read-only release psql helper; secret values withheld\n'
```

```sh
# step: cd-applied-preflight
# readonly: yes (database/services; writes nonsecret evidence)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-applied-preflight: line $LINENO; STOP before edge window" >&2' ERR
. "/home/commonswarm/edge/schema-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"
test "$(date -u +%s)" -le "$(date -u -d "$PREFLIGHT_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA"
release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/applied-before.txt"
python3 - "$STACK_RELEASE/supabase/migrations" "$PROOF_DIR/applied-before.txt" <<'PYCODE'
import pathlib,re,sys
versions=[p.name.split('_',1)[0] for p in pathlib.Path(sys.argv[1]).glob('*.sql')]
applied=pathlib.Path(sys.argv[2]).read_text().splitlines()
assert all(re.fullmatch('[0-9]{14}',v) for v in versions) and len(versions)==len(set(versions))
assert len(applied)==len(set(applied)) and set(applied)==set(versions), 'FAIL cd-applied-preflight: ledger/file mismatch; STOP'
assert set(['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005'])<=set(applied), 'FAIL cd-applied-preflight: missing applied admin migration; STOP'
PYCODE
for VERSION in 20261001000001 20261001000002 20261001000003 20261001000004 20261001000005; do
 test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$VERSION';")" = 1
 printf '\\i /proof/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$APPLY_SQL"
 release_psql_ro -Atq --file "$APPLY_SQL" >"$PROOF_DIR/${VERSION}-forward.txt"
 test "$(cat "$PROOF_DIR/${VERSION}-forward.txt")" = t
 printf 'PASS cd-applied-preflight: %s ledger=1 catalog=t\n' "$VERSION"
done
release_psql_ro -Atq --command "SELECT NOT EXISTS (SELECT 1 FROM swarm.admin_accounts WHERE NOT projection ? 'routine' OR jsonb_typeof(projection->'routine') IS DISTINCT FROM 'object');" >"$PROOF_DIR/routine-backfill.txt"
test "$(cat "$PROOF_DIR/routine-backfill.txt")" = t
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-before.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/schema-verified.txt"
printf 'PASS cd-applied-preflight: all five already applied; no SQL writes\n'
```

```sh
# step: cd-edge-inputs
# readonly: yes
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-edge-inputs: line $LINENO; STOP" >&2' ERR
: "${RELEASE_SHA:?}" "${CD_WINDOW_ID:?}" "${EDGE_PLAN_FILE:?}" "${WINDOW_END_UTC:?}" "${PREFLIGHT_WINDOW_END_UTC:?}"
# Prove the exact schema receipt before any edge archive/window opens.
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -c %q -- %q %q' \
 'set -euo pipefail; . "/home/commonswarm/edge/schema-proofs/${1}-${2}/state.sh"; test ! -e "$PROOF_DIR/closed.txt"; test -f "$PROOF_DIR/schema-verified.txt"; test "$(date -u +%s)" -le "$(date -u -d "$PREFLIGHT_WINDOW_END_UTC" +%s)"' "$RELEASE_SHA" "$CD_WINDOW_ID"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
BASELINE_EDGE_SHA=65a6caf0f03066d60a18591fca3a370ecc59744d
MAX_MCP_OUTAGE_SECONDS=240
PLAN_FILE=$EDGE_PLAN_FILE
printf 'PASS cd-edge-inputs: RELEASE_SHA=%s BASELINE_EDGE_SHA=%s outage-budget=240s\n' "$RELEASE_SHA" "$BASELINE_EDGE_SHA"
```

```sh
# step: cd-admin-smoke
# readonly: yes (services; writes redacted response receipts)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-admin-smoke: line $LINENO; run edge-mcp-rollback; STOP" >&2' ERR
CD_PROOF_DIR=/home/commonswarm/edge/schema-proofs/${1:?}-${2:?}
EDGE_WINDOW_ID=${6:?}
. "/home/commonswarm/edge/release-proofs/${1}-${EDGE_WINDOW_ID}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
# Write a failure receipt even if a local precondition fails before HTTP.
python3 - "$PROOF_DIR/admin-smoke.json" <<'PYCODE'
import pathlib,sys
pathlib.Path(sys.argv[1]).write_text('{"result":"FAIL","responses":[],"status":null,"content_type":null,"server":null,"size":null,"error":null}\n')
PYCODE
window_check
test -f "$CD_PROOF_DIR/schema-verified.txt" && test ! -e "$CD_PROOF_DIR/closed.txt"
test "$(readlink -f /home/commonswarm/edge/current)" = "$NEW_EDGE"
python3 - "$PROOF_DIR/admin-smoke.json" <<'PYCODE'
import json,pathlib,re,sys,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
fixture={'resource':'admin_grants','workspace_id':None,'limit':1,'before':None}
checks=[('health','http://127.0.0.1:9000/health','GET',None,{},200,'status','ok'),
 ('loopback_admin','http://127.0.0.1:9000/functions/v1/read','POST',fixture,{'Authorization':'Bearer swm_adm_release_probe_not_a_credential','Host':'api.commonswarm.com'},403,'error','credential_kind_forbidden'),
 ('public_admin','https://api.commonswarm.com/functions/v1/read','POST',fixture,{'Authorization':'Bearer swm_adm_release_probe_not_a_credential','User-Agent':'curl/8.7.1'},403,'error','credential_kind_forbidden')]
rows=[]; failed=False
for name,url,method,data,headers,status,key,expected in checks:
 row={'probe':name,'status':None,'content_type':None,'server':None,'size':None,'error':None}
 ok=False; failure='edge_contract'
 try:
  headers.update({'Content-Type':'application/json','Accept':'application/json'})
  req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),method=method,headers=headers)
  try: response=opener.open(req,timeout=15)
  except urllib.error.HTTPError as error: response=error
  with response:
   row['status']=response.code
   media=response.headers.get_content_type()
   row['content_type']=media if media in ('application/json','text/html','text/plain','application/octet-stream') else 'other'
   server=response.headers.get('Server')
   row['server']=None if server is None else server.lower() if server.lower() in ('cloudflare','caddy') else 'other'
   body=response.read(131073); row['size']=len(body)
   cloudflare_body=re.search(rb'\berror code:\s*[0-9]+\b',body,re.I) is not None
   try: value=json.loads(body) if len(body)<=131072 else None
   except (ValueError,UnicodeError): value=None
   field=value.get('error') if isinstance(value,dict) else None
   row['error']=field if isinstance(field,str) and re.fullmatch('[a-z_]{1,64}',field) else None
   contract=response.code==status and len(body)<=131072 and isinstance(value,dict) and value.get(key)==expected
   if cloudflare_body or (row['server']=='cloudflare' and not contract): failure='cloudflare_block'
   ok=contract and media=='application/json' and not cloudflare_body
 except Exception:
  # No exception, response body, header set or credential is logged/retained.
  ok=False
 rows.append(row); failed=failed or not ok
 pathlib.Path(sys.argv[1]).write_text(json.dumps({'result':'FAIL' if failed or len(rows)<len(checks) else 'PASS','responses':rows},sort_keys=True)+'\n')
 if ok: print('PASS cd-admin-smoke: '+name)
 else:
  print('FAIL cd-admin-smoke: '+name+' error='+str(row['error'] or '<absent_or_redacted>')+'; STOP',file=sys.stderr)
  print('FAIL '+failure+' '+json.dumps(row,sort_keys=True),file=sys.stderr)
if failed: raise SystemExit(1)
print('NOT PROVED: authenticated admin recovery/command and authenticated MCP tools')
PYCODE
touch "$PROOF_DIR/admin-boundary-probed.txt"
```

```sh
# step: cd-proof-close
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-proof-close: line $LINENO; report exact path/error; STOP" >&2' ERR
. "/home/commonswarm/edge/schema-proofs/${1:?}-${2:?}/state.sh"
test "$(id -u)" = 0
test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
if test -f "$PROOF_DIR/closed.txt"; then echo 'cd-proof-close: already closed'; exit 0; fi
CLOSE_READBACK_FAILED=0
if test -f "$PROOF_DIR/session-ready.txt"; then
 . "$DB_SESSION"
 if ! release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/closed-ledger.txt"; then
  CLOSE_READBACK_FAILED=1
  printf 'FAIL cd-proof-close: ledger readback failed; continue exact secret cleanup\n' >&2
 fi
 if test -f "$PROOF_DIR/applied-before.txt" && ! cmp -s "$PROOF_DIR/applied-before.txt" "$PROOF_DIR/closed-ledger.txt"; then
  CLOSE_READBACK_FAILED=1
  printf 'FAIL cd-proof-close: migration ledger drift; continue exact secret cleanup\n' >&2
 fi
 if test -f "$PROOF_DIR/cron-before.txt"; then
  if ! release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-after.txt" || ! cmp -s "$PROOF_DIR/cron-before.txt" "$PROOF_DIR/cron-after.txt"; then
  CLOSE_READBACK_FAILED=1
  printf 'FAIL cd-proof-close: cron readback/drift; continue exact secret cleanup\n' >&2
  fi
 fi
fi
if test -n "${SECRET_STAGE:-}" && test -d "$SECRET_STAGE"; then
 python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied), 'FAIL cd-proof-close: deletion boundary control'
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
 /usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cd-proof-close: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
 test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
fi
if test -n "${SECRET_STAGE:-}"; then test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"; fi
test "$CD_BOX_ARCHIVE_PATH" = /tmp/cd-release-${RELEASE_SHA}-${CD_WINDOW_ID}.tar
test ! -L "$CD_BOX_ARCHIVE_PATH"
/usr/bin/rm -f -- "$CD_BOX_ARCHIVE_PATH" || { printf 'FAIL cd-proof-close: cleanup refused %s; STOP\n' "$CD_BOX_ARCHIVE_PATH" >&2; exit 1; }
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/closed.txt"
printf 'Closed read-only schema proof session; retain nonsecret evidence %s\n' "$PROOF_DIR"
test "$CLOSE_READBACK_FAILED" = 0
```

```sh
# step: cd-open-abort
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-open-abort: retain exact path and guard error; STOP" >&2' ERR
SECRET_STAGE=${7:?exact failed-session path required}
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
/usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cd-open-abort: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
```

```sh
# step: cd-mac-close
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-mac-close: report exact guarded path/error; STOP" >&2' ERR
: "${CD_ARCHIVE_DIR:?}"
python3 - "$CD_ARCHIVE_DIR" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/cd-release-archive\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/cd-release-archive.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
PYCODE
rm -rf -- "$CD_ARCHIVE_DIR" || { printf 'FAIL cd-mac-close: guarded cleanup refused %s; STOP\n' "$CD_ARCHIVE_DIR" >&2; exit 1; }
```

```sh
# step: cd-stage-abort
# readonly: no
# host: box root /bin/bash 5.2; failed staging before state exists only
set -euo pipefail
trap 'echo "FAIL cd-stage-abort: report exact path/error; STOP" >&2' ERR
RELEASE_SHA=${1:?}; CD_WINDOW_ID=${2:?}; CD_BOX_ARCHIVE_PATH=${3:?}; CD_ARCHIVE_SHA256=${4:?}
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
python3 - "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" <<'PYCODE'
import pathlib,re,sys
s,w,a,h=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and re.fullmatch('[A-Za-z0-9]{6}',w)
assert a==f'/tmp/cd-release-{s}-{w}.tar' and re.fullmatch('[0-9a-f]{64}',h)
p=pathlib.Path(a); assert p.resolve(strict=True)==p and not p.is_symlink() and p.is_file() and p.stat().st_mode & 0o777==0o600
assert not pathlib.Path(f'/home/commonswarm/edge/schema-proofs/{s}-{w}/state.sh').exists()
PYCODE
test "$(sha256sum "$CD_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$CD_ARCHIVE_SHA256"
/usr/bin/rm -f -- "$CD_BOX_ARCHIVE_PATH" || { printf 'FAIL cd-stage-abort: cleanup refused %s; STOP\n' "$CD_BOX_ARCHIVE_PATH" >&2; exit 1; }
```
