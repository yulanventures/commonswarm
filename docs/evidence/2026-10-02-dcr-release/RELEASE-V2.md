# DCR v2: read-only schema preflight, ON OAuth release, MCP Caddy, public probes
Mac blocks must not call setuid/setgid tools.

Box image-build rule: `nice -n 15` plus a hard three-CPU cap, using
`systemd-run --scope -p CPUQuota=300%` around the build workers or a supported
builder quota. Build once per `RELEASE_SHA`, look up a persistent SHA tag,
build only if absent, and verify the image's recorded source SHA before reuse;
unsupported caps or mismatched SHA labels are STOP. See the shared preamble in
[RELEASE-TO-BOX.md](../../../deploy/RELEASE-TO-BOX.md). This plan delegates its
OAuth image build to `hm37-oauth-build` in the referenced OAuth plan, which
uses `DOCKER_BUILDKIT=0 nice -n 15` and a three-CPU Docker quota with SHA reuse.

Prepared, **not executed**. This supersedes the execution order in
[RELEASE.md](RELEASE.md), which remains history. HezLead supplies the reviewed,
landed main SHA containing this plan and separately authorizes execution.
Preparation base 31ac05fa; DCR merge 5f9e9225, implementation fced3336.
HezLead's try-3 report says migration 20261002000001 is APPLIED and stays;
OAuth rolled back to the baseline below, MCP ON, Caddy unchanged. These are
handoff facts; this worker did not contact production. The marked preflight
must independently require the ledger row PRESENT, forward catalog **t**,
rollback catalog **f**, or STOP before any service transition.

Use [release procedure](../../../deploy/RELEASE-TO-BOX.md),
[OAuth runbook](../../../deploy/mcp-auth/RUNBOOK.md), and
[ON OAuth procedure](../2026-10-02-mcp-auth-release/RELEASE.md).
Execute whole marked blocks by ID. Never invent commands during the window.
Every failed gate stops forward work. No schema window, backup gate, migration
apply, schema rollback or schema-window close. All database access here uses
default_transaction_read_only=on; staging/cleanup only manages task files.
No Actions, browser/GUI, keychain, HOME assignment, site release, apex Caddy
edit, stack-container release or edge source release. Flags recreate the
existing edge release with its override. No Alloy.

Blocks parse with /bin/bash 3.2; box tools require root, Python 3.12 for tar
data filter, GNU timeout/date, Compose/Caddy. Keep one Mac shell for archive
values and one root shell for OAuth functions/state. Read-only preflight box
steps reload state using transport arguments. No heredoc inside $(...).
Secrets come from existing protected files; staged copies are 0600 in fresh
0700 mktemp -d /private/tmp/anvil-secret.XXXXXX directories removed at final
verified close or safe pre-transition cleanup. No op call is needed; separate
HezLead recovery uses only the service-account token file. Never print secrets,
bodies, raw env/inspect/cookies. Mac rm uses the installed guard; box cleanup
retains root-binary and exact-path checks. Never bypass a refusal; report its
exact path/message and leave the file.

## Inputs

| Input | Source / validation | Use |
| --- | --- | --- |
| RELEASE_SHA | HezLead; full reviewed landed main SHA including V2 and DCR | Exact archive/image source |
| DCR_REVIEWED_CODE_SHA | HezLead; 40 lowercase hex reviewed implementation commit | Archive requires ancestry and no unreviewed code delta in the existing scoped paths |
| EXPECTED_SCHEMA_MIGRATIONS | HezLead; nonempty comma-separated unique 14-digit applied versions | dcr-preflight reads the box migration catalog and compares the exact set |
| DCR_PLAN_FILE | Absolute exact-release RELEASE-V2.md path, byte-checked against git | Marked extraction |
| OAUTH_PLAN_FILE | Absolute exact-release 2026-10-02-mcp-auth-release/RELEASE.md | Unchanged reference extraction |
| GATE_EVIDENCE_FILE | Regular nonsecret JSON receipt: sha=RELEASE_SHA; gates contains PASS for DCR release shell/Python, release-proof-format and OAuth DCR tests | Parsed by dcr-archive before execution |
| WINDOW_END_UTC | Fresh HezLead future UTC timestamp, <=30 minutes | Preflight and OAuth forward deadline |
| EXPECTED_OAUTH_SHA | HezLead's latest measured live ON report; required full 40 lowercase hex | Checked running ON source/recovery |
| EXPECTED_OAUTH_IMAGE_DIGEST | Same measured report; required sha256 + 64 lowercase hex, no tag | Checked running image/recovery |
| EXPECTED_EDGE_SHA | HezLead; required 40 lowercase hex | Preflight/open compare running edge source label and canonical current target; preserve edge source |
| MAX_MCP_OUTAGE_SECONDS | **240**, fixed: 180 forward + 60 reserved recovery | Includes any second recovery interruption |
| CADDY_FORWARD_SECONDS | **30**, fixed share of 180s | Validate/reload/OFF route probes |
| TOM_ENABLE_APPROVAL | Named HezLead prompt input 2026-09-29 | Existing switch-on authorization |
| MCP_EXPECTED_MODE | off after transition/release-off; on after enable | Referenced route probes |
| HM37_STEP | dcr-oauth-reference allowlist ID | Unchanged OAuth reference |
| DCR_ARCHIVE_DIR, DCR_WINDOW_ID, DCR_BOX_ARCHIVE_PATH, DCR_ARCHIVE_SHA256 | dcr-archive exact retained values | Read-only proof staging/cleanup |
| DCR_BOX_STEP | dcr-transport allowlist ID | Box preflight/staging/cleanup |
| DCR_PROOF, DCR_SOURCE_DIR | Staged immutable proof/source paths | Catalog receipts, Caddy LIVE snapshot and helpers |
| OAUTH_RELEASE_SHA, ARCHIVE_DIR, BOX_ARCHIVE_PATH, OAUTH_ARCHIVE_SHA256 | OAuth inputs/archive exact printed paths/hash | OAuth window and close |
| SECRET_STAGE | Exact reported failed-session/open path | Abort cleanup; no globbing |

## Run order

1. **Read-only preflight:** dcr-plan-inputs then dcr-archive on Mac; dcr-transport invokes dcr-stage,
   dcr-session, dcr-preflight on root. Require migration 20261002000001 ledger=1,
   forward=t, rollback=f. Save full ledger and cron inventory. No DDL, backup,
   stack release, or schema mutation. STOP on any disagreement.
2. **OAuth ON baseline:** dcr-oauth-inputs on Mac/root; dcr-oauth-baseline-state
   on root; reference hm37-oauth-archive on Mac; transfer its printed archive
   path/hash to root; dcr-oauth-preflight; dcr-oauth-open; dcr-public-helper;
   reference hm37-mcp-transition-off; reference hm37-mcp-route-probes off;
   reference hm37-oauth-build; reference hm37-oauth-inputs;
   reference hm37-oauth-release-off; reference hm37-mcp-route-probes off.
   References run through dcr-oauth-reference/HM37_STEP. Keep both secret stages
   and baseline snapshots until every final gate passes or baseline ON recovery
   is independently verified.
3. **Caddy while OFF:** dcr-caddy-apply compares the rendered candidate against
   LIVE bytes saved by open, permits exactly three path-list changes, validates
   before reload, then invokes dcr-caddy-probes OFF. The 30s share is inside the
   shared 180s forward budget. Then dcr-oauth-enable;
   reference hm37-mcp-route-probes on; dcr-oauth-verify. Order is release-off ->
   probes off -> Caddy apply/OFF probes -> enable -> probes on. Apex stays unchanged.
4. **Public probes; close last:** dcr-public-probes; dcr-transport invokes
   dcr-final-readback (ledger unchanged, catalog=t, rollback=f, cron unchanged);
   dcr-oauth-close (gated reference hm37-oauth-close); dcr-transport invokes
   dcr-check-cleanup; reference hm37-oauth-mac-close on Mac; dcr-mac-close.
   Keep DCR_ARCHIVE_DIR until reference extraction finishes Mac cleanup.
   Retain safe receipts, exact saved LIVE Caddy and checksums. HezLead performs
   the Grok connector retest afterward.

## Failure paths

A slow build aborts forward work by design; recovery leaves the run failed,
with no retry inside the same window (180s forward + 60s reserved recovery).
Every failure after OFF restores Caddy first, then the OAuth baseline. Close
only after verified release ON with all final gates, or verified baseline ON.
The already-applied additive schema stays; it has no inverse execution here.

| Step / failure | Required marked path / end state |
| --- | --- |
| dcr-archive / dcr-transport before staging | No production change; dcr-mac-close if archive exists; report transport path |
| dcr-stage before state exists | dcr-stage-abort then dcr-mac-close; retain incomplete proof tree |
| dcr-session before helpers exist | dcr-secret-abort exact reported preflight path; dcr-check-cleanup then dcr-mac-close; services/schema untouched |
| dcr-preflight | No DDL/services; dcr-check-cleanup then dcr-mac-close; STOP on ledger/catalog conflict |
| dcr-oauth-inputs / dcr-oauth-baseline-state / hm37-oauth-archive / dcr-oauth-preflight | No service change; dcr-check-cleanup / hm37-oauth-mac-close if archive exists / dcr-mac-close; report measured conflict |
| dcr-oauth-open / dcr-public-helper before OFF | Baseline untouched; dcr-baseline-verify then dcr-oauth-close if open-ready exists; partial open uses dcr-secret-abort with baseline ON proved |
| dcr-oauth-reference extraction/provenance failure | Before OFF no service changes; afterward dcr-recover-baseline; never run unverified reference |
| hm37-mcp-transition-off / hm37-mcp-route-probes off / hm37-oauth-build / hm37-oauth-inputs / hm37-oauth-release-off | dcr-recover-baseline: exact Caddy rollback, hm37-oauth-rollback, dcr-baseline-verify, dcr-oauth-close; STOP failed |
| dcr-caddy-apply / dcr-caddy-probes, including 30s or shared-budget overrun | dcr-caddy-failure -> dcr-recover-baseline; exact byte rollback first, baseline ON next; STOP failed |
| dcr-oauth-enable / hm37-mcp-route-probes on / dcr-oauth-verify | OFF containment where provided, then dcr-recover-baseline; verified baseline ON, then close; STOP failed |
| dcr-public-probes / dcr-final-readback | dcr-public-failure -> dcr-recover-baseline; verified baseline ON before close; additive schema stays |
| hm37-mcp-disable / hm37-mcp-restore-on (reserve references) | Exact dcr-caddy-rollback first; dcr-recover-baseline restores/verifies ON before close |
| dcr-caddy-rollback / hm37-oauth-rollback / dcr-recover-baseline / dcr-baseline-verify failure | REQ 92 baseline OFF fallback or REQ 90/91 UNVERIFIED: retain stages/snapshots, report outage; no close; HezLead recovery |
| dcr-oauth-close / hm37-oauth-close / dcr-check-cleanup / hm37-oauth-mac-close / dcr-mac-close / dcr-stage-abort / dcr-secret-abort | Report exact path/error and verified state; stop refused cleanup; no bypass or forward retry |
| Receipt failure or outage >240s | Recover baseline if needed; verified ON permits cleanup but run stays failed; never kill recovery for budget; second interruption adds to 240s |

After marked recovery closes OAuth, run dcr-transport dcr-check-cleanup,
reference hm37-oauth-mac-close and dcr-mac-close. Keep both stages if recovery
is OFF or unverified. Preflight cleanup is a task-file cleanup, not a schema
window close. Historical baseline 00e89738 was compatible with the additive
table; the current baseline is supplied and checked, never inferred here.
server.js composes createPostgresRegistrationStore(pool) with the existing
createPool, database-credentials and CA: **no new registration secret, env
input name or 1Password item**. Schema presence is mandatory before new startup.

## 1. Read-only applied-schema preflight


## Shared preflight and closure decision

Run `dcr-release-shared-preflight` **first**, before every existing run-order entry.
Start in the reviewed repository with `DCR_PLAN_FILE` set to this absolute plan
and `RELEASE_INPUTS_JSON` set to a regular nonsecret INPUTS JSON file. The
shared checker validates the full input set together and exports the validated
values to the retained Bash shell. Generated archive hashes, window IDs and
secret-stage paths remain outputs; never guess them as inputs. Existing box
preflight/open blocks still remeasure declared reads and enforce freshness.
The inventory below is part of the reviewed plan: changing a marked block
requires reviewing its producer/consumer/cleanup/read inventory and digest.
A consumer may use only an input or an earlier producer on its selected route.
Optional absence/existence checks are observations, not file consumption.
Referenced OAuth steps in DCR are resolved from RELEASE_SHA in the Git object
database, and participate in the same run order, not an earlier release.

| Failure phase | Result and live state | Action |
| --- | --- | --- |
| Inputs/preflight, before mutation | STOP; baseline unchanged | Close only task staging already created. |
| Deploy or required verification fails | DEPLOY_FAILED; candidate unverified | Run the existing marked rollback/recovery and verify baseline. |
| Required deploy verification passes | DEPLOY_VERIFIED; selected source/image and mode verified | Proceed to evidence/closure. |
| Receipt write, copy-back, manifest, timer restoration or cleanup fails after verification | CLOSE_FAILED; report last verified source/image/mode, timer/lock and exact leftover paths/PIDs | Keep verified bytes live; no rollback. HezLead reconciles closure. |
| Outage budget exceeded after verified recovery/deploy | Run remains FAIL; verified live state retained | Record the measured interval; closure may proceed. No rollback solely for receipt/budget failure. |

CLOSE_FAILED is a terminal closure result, never a deploy-failure trigger.
The closure EXIT handler catches explicit exits and guarded cleanup refusals.
If a later read discovers actual source/health drift, it is a new verification
failure and follows the existing recovery path. Report uncertainty explicitly;
last verified state is not a new box measurement. Never reopen a closed window.
Only nonsecret evidence may be copied back; backups and freshness gates remain.

```sh
# step: dcr-release-shared-preflight
# readonly: yes
# host: Mac /bin/bash 3.2; FIRST, before archive, box contact or window
set -euo pipefail
: "${RELEASE_INPUTS_JSON:?absolute nonsecret INPUTS JSON required}"
RELEASE_PREFLIGHT_TOOL="$(pwd -P)/scripts/release-preflight.py"
export RELEASE_PREFLIGHT_TOOL
python3 "$RELEASE_PREFLIGHT_TOOL" "${DCR_PLAN_FILE:?absolute reviewed plan required}" "$RELEASE_INPUTS_JSON" "$(pwd -P)"
# Export exactly the validated nonsecret fields; shlex.quote prevents shell code.
RELEASE_PREFLIGHT_EXPORTS=$(python3 -c 'import json,re,shlex,sys; p=json.load(open(sys.argv[1])); c=json.loads(re.search(r"^```release-contract\n(.*?)^```$",open(sys.argv[2]).read(),re.M|re.S)[1]); print("\n".join("export "+k+"="+shlex.quote(p[k]) for k in c["inputs"]))' "$RELEASE_INPUTS_JSON" "$DCR_PLAN_FILE")
eval "$RELEASE_PREFLIGHT_EXPORTS"
unset RELEASE_PREFLIGHT_EXPORTS
```

```sh
# step: dcr-plan-inputs
# readonly: yes
# host: Mac /bin/bash 3.2 before archive; schema input forwarded by transport
set -euo pipefail
python3 - "${DCR_REVIEWED_CODE_SHA:-}" "${EXPECTED_SCHEMA_MIGRATIONS:-}" <<'PYINPUT'
import re,sys
if not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]): raise SystemExit('FAIL: invalid DCR_REVIEWED_CODE_SHA; STOP')
value=sys.argv[2]
if not re.fullmatch(r'[0-9]{14}(,[0-9]{14})*',value) or len(value.split(','))!=len(set(value.split(','))):
    raise SystemExit('FAIL: invalid EXPECTED_SCHEMA_MIGRATIONS; STOP')
PYINPUT
export DCR_REVIEWED_CODE_SHA EXPECTED_SCHEMA_MIGRATIONS
```

```sh
# step: dcr-archive
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL dcr-archive: line $LINENO; STOP before window" >&2' ERR
: "${RELEASE_SHA:?}" "${DCR_PLAN_FILE:?}" "${OAUTH_PLAN_FILE:?}" "${GATE_EVIDENCE_FILE:?}"
case "$RELEASE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#RELEASE_SHA}" = 40
test -z "$(git status --porcelain)"
git remote get-url origin | python3 -c 'import sys; assert sys.stdin.read().strip() in ("https://github.com/yulanventures/commonswarm.git","git@github.com:yulanventures/commonswarm.git")'
git fetch origin main
test "$(git rev-parse "${RELEASE_SHA}^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
python3 - "${DCR_REVIEWED_CODE_SHA:-}" <<'PYCODE'
import re,sys
assert re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]), 'FAIL: invalid DCR_REVIEWED_CODE_SHA; STOP'
PYCODE
git merge-base --is-ancestor "$DCR_REVIEWED_CODE_SHA" "$RELEASE_SHA"
git diff --quiet "$DCR_REVIEWED_CODE_SHA" "$RELEASE_SHA" -- services/mcp-auth deploy/mcp-auth supabase/functions src supabase/migrations deploy/release-proofs/oauth-dcr deploy/supabase-stack/commonswarm-mcp.caddy
python3 - "$DCR_PLAN_FILE" "$OAUTH_PLAN_FILE" "$GATE_EVIDENCE_FILE" "$RELEASE_SHA" <<'PYCODE'
import pathlib,subprocess,sys
for value,relative in zip(sys.argv[1:3],['docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md','docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md']):
 p=pathlib.Path(value); assert p.is_absolute() and not p.is_symlink() and p.is_file()
 assert p.read_bytes()==subprocess.check_output(['git','show',sys.argv[4]+':'+relative])
p=pathlib.Path(sys.argv[3]); assert p.is_file() and not p.is_symlink()
import os,runpy
runpy.run_path(os.environ['RELEASE_PREFLIGHT_TOOL'])['receipt'](str(p),sys.argv[4],['DCR release shell/Python','release-proof-format','OAuth DCR tests'])
PYCODE
DCR_ARCHIVE_DIR=$(mktemp -d /private/tmp/dcr-release-archive.XXXXXX)
chmod 0700 "$DCR_ARCHIVE_DIR"
DCR_WINDOW_ID=${DCR_ARCHIVE_DIR##*.}
git archive --format=tar --output "$DCR_ARCHIVE_DIR/release.tar" "$RELEASE_SHA"
test "$(git get-tar-commit-id <"$DCR_ARCHIVE_DIR/release.tar")" = "$RELEASE_SHA"
chmod 0600 "$DCR_ARCHIVE_DIR/release.tar"
DCR_ARCHIVE_SHA256=$(shasum -a 256 "$DCR_ARCHIVE_DIR/release.tar" | awk '{print $1}')
DCR_BOX_ARCHIVE_PATH=/tmp/dcr-release-${RELEASE_SHA}-${DCR_WINDOW_ID}.tar
printf -v REMOTE_COMMAND 'test "$(stat -c %%a /tmp)" = 1777 && (set -C; umask 077; : > %q)' "$DCR_BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
scp -p "$DCR_ARCHIVE_DIR/release.tar" "ops@100.115.66.74:$DCR_BOX_ARCHIVE_PATH"
printf 'DCR_WINDOW_ID=%s\nDCR_BOX_ARCHIVE_PATH=%s\nDCR_ARCHIVE_SHA256=%s\n' "$DCR_WINDOW_ID" "$DCR_BOX_ARCHIVE_PATH" "$DCR_ARCHIVE_SHA256"
```

```sh
# step: dcr-transport
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL dcr-transport: line $LINENO; STOP" >&2' ERR
: "${DCR_PLAN_FILE:?}" "${DCR_BOX_STEP:?}" "${RELEASE_SHA:?}" "${DCR_WINDOW_ID:?}" "${DCR_ARCHIVE_DIR:?}"
python3 - "$DCR_ARCHIVE_DIR" "$DCR_WINDOW_ID" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/dcr-release-archive\.[A-Za-z0-9]{6}',str(p))
assert str(p).rsplit('.',1)[1]==sys.argv[2] and not p.is_symlink() and p.resolve(strict=True)==p
assert p.is_dir() and p.stat().st_mode & 0o777==0o700
PYCODE
case "$DCR_BOX_STEP" in
 dcr-stage|dcr-session|dcr-preflight|dcr-final-readback|dcr-check-cleanup|dcr-stage-abort) ;;
 *) echo 'FAIL dcr-transport: unknown step; STOP' >&2; exit 1;;
esac
python3 - "$DCR_PLAN_FILE" "$DCR_BOX_STEP" >"$DCR_ARCHIVE_DIR/box-step.sh" <<'PYCODE'
import pathlib,re,sys
fence=chr(96)*3
blocks=re.findall(r'^'+fence+r'sh\n(.*?)^'+fence+'$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1, 'FAIL dcr-transport: duplicate/missing step'
print(found[0])
PYCODE
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -s -- %q %q %q %q %q %q' \
 "$RELEASE_SHA" "$DCR_WINDOW_ID" "$DCR_BOX_ARCHIVE_PATH" "$DCR_ARCHIVE_SHA256" "$WINDOW_END_UTC" "${EXPECTED_SCHEMA_MIGRATIONS:?FAIL: EXPECTED_SCHEMA_MIGRATIONS missing; STOP}"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND" <"$DCR_ARCHIVE_DIR/box-step.sh"
```


```sh
# step: dcr-stage
# readonly: no (immutable proof staging only)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL dcr-stage: line $LINENO; services/schema untouched; STOP" >&2' ERR
RELEASE_SHA=${1:?}; DCR_WINDOW_ID=${2:?}; DCR_BOX_ARCHIVE_PATH=${3:?}; DCR_ARCHIVE_SHA256=${4:?}; WINDOW_END_UTC=${5:?}
EXPECTED_SCHEMA_MIGRATIONS=${6:?FAIL: EXPECTED_SCHEMA_MIGRATIONS missing; STOP}
python3 - "$EXPECTED_SCHEMA_MIGRATIONS" <<'PYINPUT'
import re,sys
value=sys.argv[1]
assert re.fullmatch(r'[0-9]{14}(,[0-9]{14})*',value) and len(value.split(','))==len(set(value.split(','))), 'FAIL: invalid EXPECTED_SCHEMA_MIGRATIONS; STOP'
PYINPUT
test "$(id -u)" = 0
python3 - "$RELEASE_SHA" "$DCR_WINDOW_ID" "$DCR_BOX_ARCHIVE_PATH" "$DCR_ARCHIVE_SHA256" "$WINDOW_END_UTC" <<'PYCODE'
import datetime,pathlib,re,sys
s,w,a,h,end=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and re.fullmatch('[A-Za-z0-9]{6}',w)
assert a==f'/tmp/dcr-release-{s}-{w}.tar' and re.fullmatch('[0-9a-f]{64}',h)
until=datetime.datetime.strptime(end,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(until-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800
p=pathlib.Path(a); assert not p.is_symlink() and p.resolve(strict=True)==p and p.is_file() and p.stat().st_mode & 0o777==0o600
PYCODE
test "$(sha256sum "$DCR_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$DCR_ARCHIVE_SHA256"
PROOF_DIR=/home/commonswarm/oauth/dcr-preflights/${RELEASE_SHA}-${DCR_WINDOW_ID}
DCR_SOURCE_DIR=$PROOF_DIR/source
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR"
install -d -m 0700 -o root -g root "$PROOF_DIR"
python3 - "$DCR_BOX_ARCHIVE_PATH" "$PROOF_DIR" "$RELEASE_SHA" <<'PYCODE'
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
for suffix in ['catalog.sql','rollback-catalog.sql']:
 p=source/'deploy/release-proofs/oauth-dcr'/('20261002000001-'+suffix)
 assert p.is_file() and not p.is_symlink()
 shutil.copyfile(p,proof/p.name); os.chmod(proof/p.name,0o600)
(proof/'proof-inputs.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(proof.glob('*.sql'))))
print('PASS dcr-stage: exact archive and read-only catalog proofs; release symlinks untouched')
PYCODE
{
 for name in EXPECTED_SCHEMA_MIGRATIONS RELEASE_SHA DCR_WINDOW_ID DCR_BOX_ARCHIVE_PATH DCR_ARCHIVE_SHA256 WINDOW_END_UTC PROOF_DIR DCR_SOURCE_DIR; do printf '%s=%q\n' "$name" "${!name}"; done
} >"$PROOF_DIR/state.sh"
chmod 0600 "$PROOF_DIR/state.sh"
```


```sh
# step: dcr-session
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'printf "FAIL dcr-session: line %s; services/schema untouched; dcr-secret-abort SECRET_STAGE=%s\n" "$LINENO" "${SECRET_STAGE:-not-created}" >&2' ERR
. "/home/commonswarm/oauth/dcr-preflights/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt" && test ! -e "$PROOF_DIR/session-ready.txt"
umask 077
test -d /private/tmp && test ! -L /private/tmp
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
# Persist the exact cleanup path immediately, including failures before helper creation.
printf 'SECRET_STAGE=%q\n' "$SECRET_STAGE" >>"$PROOF_DIR/state.sh"
MIGRATE=$DCR_SOURCE_DIR/deploy/supabase-stack/migrate
PGSERVICE_FILE=$SECRET_STAGE/service.conf
PGPASS_FILE=$SECRET_STAGE/pass
READBACK_SQL=$PROOF_DIR/readback.sql
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
install -m 0600 /dev/null "$READBACK_SQL"
{
 for name in MIGRATE PGSERVICE_FILE PGPASS_FILE READBACK_SQL DB_SESSION PSQL_IMAGE; do printf '%s=%q\n' "$name" "${!name}"; done
} >>"$PROOF_DIR/state.sh"
cat >"$DB_SESSION" <<'HELPERS'
release_psql_ro() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$READBACK_SQL") CONTAINER_FILE=/run/commonswarm-release-readback.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql_ro: --file must name READBACK_SQL or a PROOF_DIR file' >&2; return 2 ;;
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
    --volume "$DCR_SOURCE_DIR/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$READBACK_SQL:/run/commonswarm-release-readback.sql:ro" \
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
printf 'PASS dcr-session: target-only standard release psql/ro helpers; secret values withheld\n'
```

```sh
# step: dcr-preflight
# readonly: yes
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL DCR read-only preflight line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/oauth/dcr-preflights/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt" && test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"

release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/applied-before.txt"
python3 - "${EXPECTED_SCHEMA_MIGRATIONS:-}" "$PROOF_DIR/applied-before.txt" <<'PYSCHEMA'
import pathlib,re,sys
value=sys.argv[1]
if not re.fullmatch(r'[0-9]{14}(,[0-9]{14})*',value) or len(value.split(','))!=len(set(value.split(','))):
    raise SystemExit('FAIL: invalid EXPECTED_SCHEMA_MIGRATIONS; STOP')
expected=set(value.split(',')); rows=pathlib.Path(sys.argv[2]).read_text().splitlines()
if any(not re.fullmatch(r'[0-9]{14}',row) for row in rows) or len(rows)!=len(set(rows)):
    raise SystemExit('FAIL: invalid observed EXPECTED_SCHEMA_MIGRATIONS catalog; STOP')
observed=set(rows)
if expected!=observed:
    raise SystemExit('FAIL: EXPECTED_SCHEMA_MIGRATIONS expected='+','.join(sorted(expected))+' observed='+','.join(sorted(observed))+'; STOP')
print('PASS: EXPECTED_SCHEMA_MIGRATIONS exact applied set matched')
PYSCHEMA
test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261002000001';")" = 1
printf '\\i /proof/20261002000001-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = t
printf '\\i /proof/20261002000001-rollback-catalog.sql\nSELECT :\x27rollback_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = f
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-before.txt"
printf '20261002000001 ledger=1 catalog=t rollback=f; read-only\n' >"$PROOF_DIR/preflight.txt"
```


## 2. OAUTH SERVICE RELEASE from ON

The adapted baseline/preflight/open/enable blocks retain the existing procedure:
require ON; check supplied edge identity (the historical template pinned eb2a87ac); use curl/8.7.1 only with
status-only JSON receipts; keep Caddy active and byte-identical while both
flags enforce OFF; Caddy routes are installed before enable; enforce the 240s
receipt. Other blocks are referenced
**unchanged** from RELEASE_SHA through dcr-oauth-reference. Never run original
baseline/preflight/open/enable alongside these. Snapshot recovery is preserved.

```sh
# step: dcr-oauth-inputs
# readonly: yes
# host: Mac /bin/bash; same inputs in retained box root shell
set -euo pipefail
: "${RELEASE_SHA:?}" "${DCR_WINDOW_ID:?}" "${WINDOW_END_UTC:?}"
OAUTH_RELEASE_SHA=$RELEASE_SHA
: "${EXPECTED_OAUTH_SHA:?FAIL: measured OAuth baseline SHA missing}"
: "${EXPECTED_OAUTH_IMAGE_DIGEST:?FAIL: measured OAuth baseline image missing}"
dcr_expected_baselines() {
python3 - "${1:-check}" "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "${EXPECTED_EDGE_SHA:-}" <<'PYBASELINE'
import json,pathlib,re,subprocess,sys
mode=sys.argv[1]
assert mode in ('validate','check'), 'FAIL: baseline check mode; STOP'
fields=['EXPECTED_OAUTH_SHA', 'EXPECTED_OAUTH_IMAGE_DIGEST', 'EXPECTED_EDGE_SHA']
values=dict(zip(fields,sys.argv[2:]))
for field,value in values.items():
    pattern=r'sha256:[0-9a-f]{64}' if field.endswith('_IMAGE_DIGEST') else r'[0-9a-f]{40}'
    if not re.fullmatch(pattern,value): raise SystemExit('FAIL: invalid '+field+'; STOP')
if mode=='validate': raise SystemExit(0)
def equal(field,observed):
    expected=values[field]
    if observed!=expected:
        raise SystemExit(f'FAIL: {field} expected={expected} observed={observed}; STOP')
def inspect(service):
    return json.loads(subprocess.check_output(['docker','inspect',service],stderr=subprocess.DEVNULL))[0]
def current(surface):
    p=pathlib.Path('/home/commonswarm/'+surface+'/current')
    field='EXPECTED_'+surface.upper()+'_SHA'
    try: release=p.resolve(strict=True)
    except OSError: equal(field,'missing current target')
    if not p.is_symlink() or release.parent!=pathlib.Path('/home/commonswarm/'+surface+'/releases'):
        equal(field,'invalid current release path')
    return release.name
if 'EXPECTED_EDGE_SHA' in values:
    data=inspect('commonswarm-edge-edge-runtime-1')
    work=data['Config']['Labels'].get('com.docker.compose.project.working_dir','')
    match=re.fullmatch(r'/home/commonswarm/edge/releases/([0-9a-f]{40})/deploy/edge-runtime',work)
    equal('EXPECTED_EDGE_SHA',match[1] if match else 'invalid edge source label')
    equal('EXPECTED_EDGE_SHA',current('edge'))
    equal('EXPECTED_EDGE_SHA',(pathlib.Path('/home/commonswarm/edge/releases')/values['EXPECTED_EDGE_SHA']/'RELEASE_SHA').read_text().strip())
if 'EXPECTED_OAUTH_SHA' in values:
    data=inspect('commonswarm-oauth-oauth-1')
    work=data['Config']['Labels'].get('com.docker.compose.project.working_dir','')
    match=re.fullmatch(r'/home/commonswarm/oauth/releases/([0-9a-f]{40})/deploy/mcp-auth',work)
    equal('EXPECTED_OAUTH_SHA',match[1] if match else 'invalid OAuth source label')
    equal('EXPECTED_OAUTH_SHA',current('oauth'))
    equal('EXPECTED_OAUTH_SHA',(pathlib.Path('/home/commonswarm/oauth/releases')/values['EXPECTED_OAUTH_SHA']/'RELEASE_SHA').read_text().strip())
    equal('EXPECTED_OAUTH_IMAGE_DIGEST',data['Image'])
print('PASS: expected live baseline identities matched')
PYBASELINE
}
dcr_expected_baselines validate
MAX_MCP_OUTAGE_SECONDS=240
export OAUTH_RELEASE_SHA EXPECTED_OAUTH_SHA EXPECTED_OAUTH_IMAGE_DIGEST EXPECTED_EDGE_SHA MAX_MCP_OUTAGE_SECONDS
python3 - "$WINDOW_END_UTC" <<'PYCODE'
import datetime,sys
end=datetime.datetime.strptime(sys.argv[1],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(end-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800
PYCODE
```

```sh
# step: dcr-oauth-baseline-state
set -euo pipefail
trap 'echo "FAIL hm37-mcp-baseline-state REQ 99: unexpected check failure; STOP" >&2' ERR
test "$(id -u)" = 0 || { echo 'FAIL hm37-mcp-baseline-state REQ 1: root required; STOP' >&2; exit 1; }
hm37_baseline_mode() {
python3 - <<'PY' || return 1
import json, pathlib, re, subprocess
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-mcp-baseline-state REQ {number}: {description}; STOP")
def inspect(name):
    return json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
def env_file(path):
    result={}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        name,sep,value=line.partition('=')
        require(sep and re.fullmatch(r'[A-Z][A-Z0-9_]*',name) and name not in result,2,'baseline env syntax and names are unique')
        if len(value)>=2 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
        result[name]=value
    return result
oauth=inspect('commonswarm-oauth-oauth-1'); edge=inspect('commonswarm-edge-edge-runtime-1')
oe=dict(x.split('=',1) for x in oauth['Config']['Env']); ee=dict(x.split('=',1) for x in edge['Config']['Env'])
flags=[oe.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED','0'),ee.get('SWARM_MCP_PUBLIC_ENABLED','0')]
require(flags in (['0','0'],['1','1']),3,'both effective public flags must agree and be 0 or 1')
mode='on' if flags[0]=='1' else 'off'
require(oauth['State']['Health']['Status']=='healthy' and edge['State']['Health']['Status']=='healthy',4,'both baseline services are healthy')
service=env_file('/etc/commonswarm-oauth/service.env'); edge_env=env_file('/home/commonswarm/.env')
require([service.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED','0'),edge_env.get('SWARM_MCP_PUBLIC_ENABLED','0')]==flags,5,'baseline env files match effective flags')
host=pathlib.Path('/etc/commonswarm-oauth/management-database-credentials')
destination='/run/commonswarm-oauth/management-database-credentials'
mounts=[m for m in oauth['Mounts'] if m['Destination']==destination]
work=pathlib.Path(oauth['Config']['Labels'].get('com.docker.compose.project.working_dir',''))
require(work.is_absolute(),6,'baseline Compose working directory is absolute')
files=str(work/'compose.yaml')
if mode=='on':
    files+=','+str(work/'compose.management.yaml')
    require((work/'compose.management.yaml').is_file(),7,'ON baseline management Compose exists')
    require(host.is_file() and not host.is_symlink() and host.resolve(strict=True)==host,8,'ON management host file is canonical and regular')
    stat=host.stat()
    require((stat.st_uid,stat.st_gid,stat.st_mode & 0o777)==(0,986,0o440),9,'ON management file is root:986 mode 0440')
    require(oe.get('MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE')==destination and len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('Source')==str(host) and mounts[0].get('RW') is False,10,'ON management env and read-only mount match the host file')
else:
    require(not host.exists() and not host.is_symlink() and not mounts and 'MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE' not in oe,11,'OFF baseline has no management host file, input or mount')
require(oauth['Config']['Labels'].get('com.docker.compose.project.config_files')==files,12,'baseline Compose selection agrees with MODE')
site=pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').read_text()
require(site.count('import mcp_oauth_active')==1 and '(mcp_resource_active)' in site and 'reverse_proxy 127.0.0.1:3490' in site,13,'baseline Caddy OAuth site and resource definition are present')
require(site.count('import mcp_resource_active')==1 and '@mcp_unavailable' not in site,14,'DCR preserves active baseline Caddy in both flag modes')
print(mode)
PY
}
mcp_route_probes() {
python3 - "$MCP_EXPECTED_MODE" "$DCR_PROOF" <<'PY' || return 1
import json, pathlib, re, sys, time, urllib.error, urllib.request
enabled=sys.argv[1]=='on'
proof=pathlib.Path(sys.argv[2]); rows=[]
receipt=proof/('oauth-routes-'+sys.argv[1]+'-'+str(time.time_ns())+'.json')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
for base in ['http://127.0.0.1:3490','https://mcp.commonswarm.com']:
    for ua in ['curl/8.7.1']:
        paths=[('/health','GET',200),('/.well-known/openid-configuration','GET',200),
            ('/.well-known/oauth-authorization-server','GET',200),('/jwks','GET',200),
            ('/authorize','GET',400 if enabled else 503),('/token','POST',None if enabled else 503)]
        if base.startswith('https:'):
            paths += [('/mcp','POST',401 if enabled else 503),
                ('/.well-known/oauth-protected-resource/mcp','GET',200 if enabled else 503)]
        for path,method,expected in paths:
            req=urllib.request.Request(base+path, data=b'' if method=='POST' else None, method=method,
                headers={'User-Agent':ua,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'})
            try: response=opener.open(req, timeout=5)
            except urllib.error.HTTPError as error: response=error
            with response:
                body=response.read(131073); code=response.code
                content_type=response.headers.get('Content-Type','')
                try: parsed=json.loads(body)
                except (ValueError, UnicodeError): parsed={}
                error=parsed.get('error') if isinstance(parsed,dict) else None
                error=error if isinstance(error,str) and re.fullmatch('[a-z_]{1,80}',error) else None
                rows.append({'probe':base+path,'status':code,'type':response.headers.get_content_type(),'size':len(body),'error_code':error})
                receipt.write_text(json.dumps({'mode':sys.argv[1],'responses':rows},indent=2)+'\n')
                facts=f'method={method} base={base} path={path} UA={ua} status={code} content-type={content_type!r}'
                assert len(body)<=131072, f'oversized response: {facts}'
                if path=='/jwks':
                    assert re.fullmatch(r'application/(?:jwk-set\+json|json)'+
                        r'(?:\s*;\s*charset=(?:[A-Za-z0-9._-]+|"[A-Za-z0-9._-]+"))?',
                        content_type.strip(), re.I), f'invalid JWKS content type: {facts}'
                else:
                    media_type='text/html' if enabled and path=='/authorize' else 'application/json'
                    assert re.fullmatch(re.escape(media_type)+
                        r'(?:\s*;\s*charset=(?:[A-Za-z0-9._-]+|"[A-Za-z0-9._-]+"))?',
                        content_type.strip(), re.I), f'unexpected content type: {facts}'
                if enabled and path=='/authorize':
                    assert b'    at ' not in body and b'node_modules' not in body, f'HTML stack trace marker: {facts}'
                    value=None
                else:
                    try: value=json.loads(body)
                    except (ValueError, UnicodeError):
                        raise AssertionError(f'invalid JSON: {facts}') from None
                    assert isinstance(value,dict), f'JSON response is not an object: {facts}'
                assert code==expected if expected is not None else code in (400,401), f'unexpected status: {facts}'
                if path=='/health': assert value.get('status')=='ok', f'unhealthy response: {facts}'
                if path.startswith('/.well-known/') and code==200:
                    if path.endswith('/mcp'):
                        assert value.get('resource')=='https://mcp.commonswarm.com/mcp', f'unexpected resource: {facts}'
                        assert 'https://mcp.commonswarm.com' in value.get('authorization_servers',[]), f'unexpected authorization servers: {facts}'
                    else: assert value.get('issuer')=='https://mcp.commonswarm.com', f'unexpected issuer: {facts}'
                if path=='/jwks': assert value.get('keys') and all('d' not in key for key in value['keys']), f'invalid public JWKS: {facts}'
                if code==503: assert value.get('error') in ('authorization_service_disabled','feature_disabled'), f'unexpected disabled error: {facts}'
                print(method,base+path,ua,code,'PASS')
PY
}
DCR_PROOF=/home/commonswarm/oauth/dcr-preflights/${RELEASE_SHA:?}-${DCR_WINDOW_ID:?}
. "$DCR_PROOF/state.sh"
test ! -e "$DCR_PROOF/closed.txt" && test -f "$DCR_PROOF/preflight.txt"
. "$DB_SESSION"
test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261002000001';")" = 1
printf '\\i /proof/20261002000001-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = t
dcr_expected_baselines check
export DCR_PROOF EXPECTED_EDGE_SHA
BASELINE_MCP_MODE=$(hm37_baseline_mode) || exit 1
test "$BASELINE_MCP_MODE" = on
MCP_EXPECTED_MODE=$BASELINE_MCP_MODE
mcp_route_probes || { echo 'FAIL hm37-mcp-baseline-state REQ 15: baseline route probes disagree with MODE; STOP' >&2; exit 1; }
printf 'MODE=%s baseline consistency and public probes PASS (read-only)\n' "$BASELINE_MCP_MODE"
```

```sh
# step: dcr-oauth-reference
# readonly: depends on referenced block
# host: retained Mac /bin/bash (archive/mac-close), box root /bin/bash (others)
set -euo pipefail
: "${HM37_STEP:?}" "${OAUTH_RELEASE_SHA:?}"
case "$HM37_STEP" in
 hm37-oauth-archive|hm37-oauth-mac-close)
  : "${OAUTH_PLAN_FILE:?}" "${DCR_ARCHIVE_DIR:?}"
  REFERENCE_FILE=$OAUTH_PLAN_FILE; STEP_FILE=$DCR_ARCHIVE_DIR/oauth-reference.sh
  python3 - "$REFERENCE_FILE" "$OAUTH_RELEASE_SHA" <<'PYCODE'
import pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
assert p.read_bytes()==subprocess.check_output(['git','show',sys.argv[2]+':docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md'])
PYCODE
  ;;
 hm37-mcp-transition-off|hm37-oauth-build|hm37-oauth-inputs|hm37-oauth-release-off|hm37-mcp-route-probes|hm37-mcp-disable|hm37-oauth-rollback|hm37-mcp-restore-on|hm37-oauth-close)
  test "$(id -u)" = 0
  : "${DCR_PROOF:?}"
  REFERENCE_FILE=$DCR_PROOF/source/docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md
  STEP_FILE=$DCR_PROOF/oauth-reference.sh
  ;;
 *) echo 'FAIL: unapproved reference ID; STOP' >&2; exit 1;;
esac
python3 - "$REFERENCE_FILE" "$HM37_STEP" "$STEP_FILE" <<'PYCODE'
import hashlib,os,pathlib,re,sys
fence=chr(96)*3
blocks=re.findall(fence+r'sh\n([\s\S]*?)'+fence,pathlib.Path(sys.argv[1]).read_text())
found=[b for b in blocks if b.startswith('# step: '+sys.argv[2]+'\n')]
assert len(found)==1
p=pathlib.Path(sys.argv[3]); assert not p.is_symlink()
p.write_text(found[0]); os.chmod(p,0o600)
print('reference='+sys.argv[2]+' sha256='+hashlib.sha256(p.read_bytes()).hexdigest())
PYCODE
/bin/bash -n "$STEP_FILE"
case "$HM37_STEP" in
 hm37-oauth-close)
  test "${DCR_CLOSE_VERIFIED:-}" = yes
  test -f "$DCR_PROOF/close-on-verified.txt"
  . "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"
  test "$(hm37_baseline_mode)" = on
  . "$STEP_FILE"
  touch "$DCR_PROOF/oauth-closed.txt"
  ;;
 hm37-oauth-build|hm37-oauth-inputs|hm37-oauth-release-off|hm37-mcp-route-probes)
  . "$DCR_PROOF/state.sh"; . "$DB_SESSION"
  test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261002000001';")" = 1
  printf '\\i /proof/20261002000001-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' >"$READBACK_SQL"
  test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = t
  . "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"
  REMAINING=$((180 - $(date -u +%s) + $(cat "$PROOF_DIR/mcp-503-start.epoch")))
  test "$REMAINING" -gt 0 && test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"
  export OAUTH_RELEASE_SHA MCP_EXPECTED_MODE DCR_PROOF
  timeout --signal=TERM --kill-after=5 "$REMAINING" /bin/bash -euo pipefail "$STEP_FILE"
  ;;
 *) . "$STEP_FILE" ;;
esac
```

```sh
# step: dcr-oauth-preflight
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-preflight line $LINENO" >&2' ERR
: "${BASELINE_MCP_MODE:?FAIL: run hm37-mcp-baseline-state first in this shell}"
dcr_expected_baselines check
MODE=$(hm37_baseline_mode) || exit 1
test "$MODE" = "$BASELINE_MCP_MODE" || { echo 'FAIL hm37-oauth-preflight REQ 20: baseline MODE changed; STOP' >&2; exit 1; }
MCP_EXPECTED_MODE=$MODE
mcp_route_probes || { echo 'FAIL hm37-oauth-preflight REQ 21: baseline route consistency failed; STOP' >&2; exit 1; }
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm &&
  test -x /usr/bin/rm && test ! -L /usr/bin/rm &&
  test ! -e /usr/local/bin/rm && test ! -L /usr/local/bin/rm &&
  test ! -e /usr/local/sbin/rm && test ! -L /usr/local/sbin/rm || {
  echo 'FAIL: box-rm-preflight; expected root /usr/bin/rm and no local wrapper' >&2; exit 1;
}
python3 - "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "$MODE" "$EXPECTED_EDGE_SHA" <<'PY'
import json, pathlib, posixpath, re, shlex, subprocess, sys
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-oauth-preflight REQ {number}: {description}; STOP")
baseline_sha,baseline_image,mode,edge_sha=sys.argv[1:]
assert re.fullmatch(r"[0-9a-f]{40}",edge_sha)
require(re.fullmatch(r"[0-9a-f]{40}",baseline_sha),1,"EXPECTED_OAUTH_SHA must be 40 lowercase hex")
require(re.fullmatch(r"sha256:[0-9a-f]{64}",baseline_image),2,"EXPECTED_OAUTH_IMAGE_DIGEST must be an immutable image ID")
def inspect(name):
    return json.loads(subprocess.check_output(['docker','inspect',name], text=True))[0]
for name, project, service, sha in [
    ('commonswarm-oauth-oauth-1','commonswarm-oauth','oauth',baseline_sha),
    ('commonswarm-edge-edge-runtime-1','commonswarm-edge','edge-runtime',edge_sha)]:
    data=inspect(name); labels=data['Config']['Labels']; env=dict(x.split('=',1) for x in data['Config']['Env'])
    ids=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project='+project,
        '--filter','label=com.docker.compose.service='+service], text=True).split()
    assert ids==[data['Id'][:12]], 'container count/identity conflict'
    assert labels['com.docker.compose.project']==project and labels['com.docker.compose.service']==service
    root=pathlib.Path('/home/commonswarm/'+('oauth' if service=='oauth' else 'edge'))
    if service=='oauth':
        # Discover from the running container; validate the path, never guess it.
        work=pathlib.Path(labels.get('com.docker.compose.project.working_dir',''))
        require(work.is_absolute() and work.parts[-2:]==('deploy','mcp-auth'),3,'baseline Compose working_dir is an OAuth release path')
        release=work.parent.parent
        require(release.parent==root/'releases' and release.is_dir() and release.resolve(strict=True)==release,4,'baseline release directory is canonical')
        require(release.name==sha and (release/'RELEASE_SHA').is_file() and (release/'RELEASE_SHA').read_text().strip()==sha,5,'running OAuth source equals EXPECTED_OAUTH_SHA')
        require((root/'current').is_symlink() and (root/'current').exists() and (root/'current').resolve(strict=True)==release,6,'OAuth current symlink equals measured release directory')
        require(labels.get('com.docker.compose.project.config_files')==str(work/'compose.yaml')+(','+str(work/'compose.management.yaml') if mode=='on' else '') and (work/'compose.yaml').is_file(),7,'baseline Compose label selects its existing base Compose file')
        require(data['Image']==baseline_image,8,'running OAuth image equals EXPECTED_OAUTH_IMAGE_DIGEST')
    else:
        release=(root/'current').resolve(strict=True)
        assert release==root/'releases'/sha and (release/'RELEASE_SHA').read_text().strip()==sha
    assert data['State']['Health']['Status']=='healthy'
    assert 'commonswarm-net' in (data['NetworkSettings'].get('Networks') or {})
    flag='MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED' if service=='oauth' else 'SWARM_MCP_PUBLIC_ENABLED'
    require(env.get(flag,'0')==('1' if mode=='on' else '0'),9,'effective public flag agrees with checked MODE')
    work=release/'deploy'/('mcp-auth' if service=='oauth' else 'edge-runtime')
    assert labels['com.docker.compose.project.working_dir']==str(work)
    files=str(work/'compose.yaml') + (','+str(work/'compose.override.yaml') if service=='edge-runtime' else ','+str(work/'compose.management.yaml') if mode=='on' else '')
    assert labels['com.docker.compose.project.config_files']==files, 'compose files differ'
    if service=='oauth':
        assert data['Config']['User']=='996:986', 'OAuth Compose runtime identity differs'
        ports=data['NetworkSettings']['Ports']['3490/tcp']
        assert len(ports)==1 and ports[0]['HostIp']=='127.0.0.1' and ports[0]['HostPort']=='3490'
    print(name, 'image='+data['Image'], 'release='+sha, 'health=healthy', 'compose='+files)
    print('environment names: '+','.join(sorted(env)))
for file in ['/etc/commonswarm-oauth/compose.env','/etc/commonswarm-oauth/service.env','/home/commonswarm/.env',
    '/etc/caddy/Caddyfile','/etc/caddy/sites/20-commonswarm-mcp.caddy','/etc/ssl/yulan-internal-ca.pem',
    '/etc/commonswarm-oauth/signing-keys.pem','/etc/commonswarm-oauth/cookie-keys',
    '/etc/commonswarm-oauth/database-credentials']:
    path=pathlib.Path(file); assert path.is_file() and not path.is_symlink()
    stat=path.stat(); print(file, 'uid='+str(stat.st_uid), 'mode='+oct(stat.st_mode & 0o777))
    if file.startswith('/etc/commonswarm-oauth/') and not file.endswith('.env'):
        assert stat.st_uid==0 and stat.st_mode & 0o007==0
    if file.endswith('.env'):
        assert stat.st_mode & 0o077==0
        print('file names: '+','.join(sorted(x.split('=',1)[0] for x in path.read_text().splitlines()
            if x and not x.startswith('#') and '=' in x)))
site=pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').read_text()
assert 'import mcp_oauth_active' in site and '(mcp_resource_active)' in site
assert ('import mcp_resource_active' in site and '@mcp_unavailable' not in site) if mode=='on' else ('@mcp_unavailable' in site and 'import mcp_resource_active' not in site)
assert 'reverse_proxy 127.0.0.1:3490' in site
imports=[]
for line in pathlib.Path('/etc/caddy/Caddyfile').read_text().splitlines():
    fields=shlex.split(line, comments=True)
    if len(fields)==2 and fields[0]=='import':
        imports.append(posixpath.normpath(posixpath.join('/etc/caddy', fields[1])))
assert '/etc/caddy/sites/*.caddy' in imports, 'Caddy sites import differs after resolving against /etc/caddy'
print('preflight baseline reconciled; no production mutation')
PY
```

```sh
# step: dcr-oauth-open
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-open line $LINENO" >&2' ERR
: "${BASELINE_MCP_MODE:?FAIL: run hm37-mcp-baseline-state first in this shell}"
dcr_expected_baselines check
MODE=$(hm37_baseline_mode) || exit 1
test "$MODE" = "$BASELINE_MCP_MODE" || { echo 'FAIL hm37-oauth-open REQ 20: baseline MODE changed; STOP' >&2; exit 1; }
MCP_EXPECTED_MODE=$MODE
mcp_route_probes || { echo 'FAIL hm37-oauth-open REQ 21: baseline route consistency failed; STOP' >&2; exit 1; }
: "${OAUTH_RELEASE_SHA:?FAIL: reviewed landed SHA missing}"
: "${OAUTH_ARCHIVE_SHA256:?FAIL: Mac archive hash missing}"
: "${BOX_ARCHIVE_PATH:?FAIL: Mac-chosen box transport path missing}"
case "$OAUTH_RELEASE_SHA" in ''|*[!0-9a-f]*) echo 'FAIL: SHA format' >&2; exit 1;; esac
test "${#OAUTH_RELEASE_SHA}" -eq 40 || exit 1
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm &&
  test -x /usr/bin/rm && test ! -L /usr/bin/rm &&
  test ! -e /usr/local/bin/rm && test ! -L /usr/local/bin/rm &&
  test ! -e /usr/local/sbin/rm && test ! -L /usr/local/sbin/rm || {
  echo 'FAIL: box-rm-preflight; expected root /usr/bin/rm and no local wrapper' >&2; exit 1;
}
python3 - "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "$OAUTH_RELEASE_SHA" "$MODE" <<'PY'
import json, pathlib, re, shlex, subprocess, sys
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-oauth-open REQ {number}: {description}; STOP")
sha,image,new_sha,mode=sys.argv[1:]
require(re.fullmatch(r'[0-9a-f]{40}',sha),1,'EXPECTED_OAUTH_SHA must be 40 lowercase hex')
require(re.fullmatch(r'sha256:[0-9a-f]{64}',image),2,'EXPECTED_OAUTH_IMAGE_DIGEST must be an immutable image ID')
require(new_sha!=sha,3,'OAUTH_RELEASE_SHA must differ from EXPECTED_OAUTH_SHA; preserve baseline proofs')
data=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1'],text=True))[0]
labels=data['Config']['Labels']
require(labels.get('com.docker.compose.project')=='commonswarm-oauth' and labels.get('com.docker.compose.service')=='oauth',4,'running container is the OAuth Compose service')
work=pathlib.Path(labels.get('com.docker.compose.project.working_dir',''))
require(work.is_absolute() and work.parts[-2:]==('deploy','mcp-auth'),5,'baseline Compose working_dir is an OAuth release path')
release=work.parent.parent
require(release.parent==pathlib.Path('/home/commonswarm/oauth/releases') and release.is_dir() and release.resolve(strict=True)==release,6,'baseline release directory is canonical')
require(release.name==sha and (release/'RELEASE_SHA').is_file() and (release/'RELEASE_SHA').read_text().strip()==sha,7,'running OAuth source equals EXPECTED_OAUTH_SHA')
current=pathlib.Path('/home/commonswarm/oauth/current')
require(current.is_symlink() and current.exists() and current.resolve(strict=True)==release,8,'OAuth current symlink equals measured release directory')
compose=work/'compose.yaml'
require(labels.get('com.docker.compose.project.config_files')==str(compose)+(','+str(work/'compose.management.yaml') if mode=='on' else '') and compose.is_file(),9,'baseline Compose label selects its existing base Compose file')
require(data['Image']==image,10,'running OAuth image equals EXPECTED_OAUTH_IMAGE_DIGEST')
env=dict(x.split('=',1) for x in data['Config']['Env'])
require(data['State']['Health']['Status']=='healthy' and env.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED','0')==('1' if mode=='on' else '0'),11,'baseline OAuth is healthy in checked MODE')
PY
BASELINE_OAUTH_DIR=$(readlink -f /home/commonswarm/oauth/current) || exit 1
BASELINE_OAUTH_COMPOSE=$BASELINE_OAUTH_DIR/deploy/mcp-auth/compose.yaml
OAUTH_RELEASE_DIR=/home/commonswarm/oauth/releases/$OAUTH_RELEASE_SHA
PROOF_DIR=/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA
test ! -e "$OAUTH_RELEASE_DIR" && test ! -L "$OAUTH_RELEASE_DIR" &&
  test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR" || { echo 'FAIL: window already exists; do not overwrite it' >&2; exit 1; }
python3 - "$BOX_ARCHIVE_PATH" "$OAUTH_RELEASE_SHA" <<'PY'
import pathlib, re, sys
path=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/tmp/hm37-oauth-'+re.escape(sys.argv[2])+r'-[A-Za-z0-9]{6}\.tar',str(path)), 'archive transport boundary'
assert path not in (pathlib.Path('/'), pathlib.Path.home())
assert path.is_file() and not path.is_symlink() and path.resolve(strict=True)==path
assert path.stat().st_mode & 0o777==0o600, 'archive transport mode must be 0600'
PY
ACTUAL=$(sha256sum "$BOX_ARCHIVE_PATH") || exit 1
test "${ACTUAL%% *}" = "$OAUTH_ARCHIVE_SHA256" || exit 1
sudo -n install -d -m 0700 "$PROOF_DIR" || exit 1
sudo -n install -o root -g root -m 0600 "$BOX_ARCHIVE_PATH" "$PROOF_DIR/release.tar" || exit 1
ACTUAL=$(sha256sum "$PROOF_DIR/release.tar") || exit 1
test "${ACTUAL%% *}" = "$OAUTH_ARCHIVE_SHA256" || exit 1
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm &&
  test -x /usr/bin/rm && test ! -L /usr/bin/rm &&
  test ! -e /usr/local/bin/rm && test ! -L /usr/local/bin/rm &&
  test ! -e /usr/local/sbin/rm && test ! -L /usr/local/sbin/rm || {
  echo 'FAIL: box-rm-preflight; expected root /usr/bin/rm and no local wrapper' >&2; exit 1;
}
test -f "$BOX_ARCHIVE_PATH" && test ! -L "$BOX_ARCHIVE_PATH" &&
  test "$(readlink -f "$BOX_ARCHIVE_PATH")" = "$BOX_ARCHIVE_PATH" || { echo 'FAIL: archive cleanup boundary' >&2; exit 1; }
/usr/bin/rm -- "$BOX_ARCHIVE_PATH" || { echo "FAIL: box archive cleanup failed $BOX_ARCHIVE_PATH; report exact error" >&2; exit 1; }
test ! -e "$BOX_ARCHIVE_PATH" && test ! -L "$BOX_ARCHIVE_PATH" || exit 1
install -d -m 0755 "$OAUTH_RELEASE_DIR" || exit 1
tar -xf "$PROOF_DIR/release.tar" -C "$OAUTH_RELEASE_DIR" || exit 1
printf '%s\n' "$OAUTH_RELEASE_SHA" >"$OAUTH_RELEASE_DIR/RELEASE_SHA"
install -d -m 0700 "$PROOF_DIR" || exit 1
install -d -m 1777 /private/tmp || exit 1
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX) || exit 1
printf 'OAuth SECRET_STAGE=%s\n' "$SECRET_STAGE"
printf '%s\n' "$SECRET_STAGE" >"$PROOF_DIR/secret-stage.path"
chmod 0700 "$SECRET_STAGE" || exit 1
python3 - "$SECRET_STAGE" <<'PY'
import pathlib, re, sys
path=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(path))
assert path not in (pathlib.Path('/'), pathlib.Path.home())
assert path.resolve(strict=True)==path and path.is_dir() and not path.is_symlink()
assert path.stat().st_mode & 0o777==0o700
PY
cp /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" || exit 1
cp /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env" || exit 1
cp /home/commonswarm/.env "$SECRET_STAGE/edge.env" || exit 1
cp /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || exit 1
if test "$BASELINE_MCP_MODE" = on; then
  cp /etc/commonswarm-oauth/management-database-credentials "$SECRET_STAGE/management.baseline" || exit 1
  cmp -s /etc/commonswarm-oauth/management-database-credentials "$SECRET_STAGE/management.baseline" || exit 1
fi
chmod 0600 "$SECRET_STAGE/"* || exit 1
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" &&
  cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env" &&
  cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env" || { echo 'FAIL hm37-oauth-open REQ 22: snapshot drift; STOP' >&2; exit 1; }
MODE=$(hm37_baseline_mode) || exit 1
test "$MODE" = "$BASELINE_MCP_MODE" || { echo 'FAIL hm37-oauth-open REQ 23: MODE drift during snapshot; STOP' >&2; exit 1; }
printf '%s\n' "$BASELINE_MCP_MODE" >"$PROOF_DIR/baseline-mcp-mode"
EDGE_DIR=$(readlink -f /home/commonswarm/edge/current) || exit 1
test "$EDGE_DIR" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA"
sha256sum /etc/caddy/Caddyfile >"$DCR_PROOF/apex-before.sha256"
cp "$SECRET_STAGE/mcp.caddy" "$DCR_PROOF/mcp-before.caddy"
chmod 0600 "$DCR_PROOF/mcp-before.caddy"
sha256sum "$DCR_PROOF/mcp-before.caddy" >"$DCR_PROOF/mcp-before.sha256"
STATE=$PROOF_DIR/hm37-window.sh
umask 077
printf 'OAUTH_RELEASE_DIR=%q\nPROOF_DIR=%q\nSECRET_STAGE=%q\nBASELINE_MCP_MODE=%q\nEXPECTED_OAUTH_SHA=%q\nEXPECTED_OAUTH_IMAGE_DIGEST=%q\nBASELINE_OAUTH_DIR=%q\nBASELINE_OAUTH_COMPOSE=%q\nEDGE_DIR=%q\n' \
  "$OAUTH_RELEASE_DIR" "$PROOF_DIR" "$SECRET_STAGE" "$BASELINE_MCP_MODE" "$EXPECTED_OAUTH_SHA" "$EXPECTED_OAUTH_IMAGE_DIGEST" \
  "$BASELINE_OAUTH_DIR" "$BASELINE_OAUTH_COMPOSE" "$EDGE_DIR" >"$STATE"
cat >>"$STATE" <<'SH'
dcr_run_step() {
  local step_file="$DCR_PROOF/marked-$1.sh"
  python3 - "$DCR_PROOF/source/docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md" "$1" "$step_file" <<'PYCODE'
import os,pathlib,re,sys
fence=chr(96)*3
blocks=re.findall(r'^'+fence+r'sh\n(.*?)^'+fence+'$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1
p=pathlib.Path(sys.argv[3]); assert not p.is_symlink()
p.write_text(found[0]); os.chmod(p,0o600)
PYCODE
  /bin/bash -n "$step_file"
  . "$step_file"
}
prepare_off_inputs() {
python3 - "$SECRET_STAGE" "$1" "$BASELINE_MCP_MODE" "$OAUTH_RELEASE_DIR" <<'PY' || return 1
import os, pathlib, re, sys
stage=pathlib.Path(sys.argv[1]); image=sys.argv[2]; mode=sys.argv[3]; release=pathlib.Path(sys.argv[4])
def env(path):
    result={}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        name, sep, value=line.partition('=')
        assert sep and re.fullmatch(r'[A-Z][A-Z0-9_]*',name) and name not in result, 'env syntax or duplicate'
        if len(value)>=2 and value[0]==value[-1] and value[0] in "'\"": value=value[1:-1]
        result[name]=value
    return result
def save(path, source, updates):
    text=source.read_text()
    for name,value in updates.items():
        text,count=re.subn(r'^'+name+r'=.*$',name+'='+value,text,flags=re.M)
        assert count<=1
        if count==0: text=text.rstrip('\n')+'\n'+name+'='+value+'\n'
    path.write_text(text); os.chmod(path,0o600)
edge=env(stage/'edge.env'); compose=env(stage/'compose.env'); service=env(stage/'service.env')
assert edge.get('SWARM_MCP_PUBLIC_ENABLED','0')==('1' if mode=='on' else '0') and service.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED','0')==('1' if mode=='on' else '0'), 'snapshot MODE conflict'
assert service.get('SUPABASE_URL') and service.get('SUPABASE_ANON_KEY')
save(stage/'compose.off.env',stage/'compose.env',{'MCP_OAUTH_IMAGE':image,'MCP_OAUTH_ENV_FILE':'/etc/commonswarm-oauth/service.env'})
for name,flag in [('service','MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED'),('edge','SWARM_MCP_PUBLIC_ENABLED')]:
    target=stage/(name+'.off.env')
    if mode=='off': target.write_bytes((stage/(name+'.env')).read_bytes()); os.chmod(target,0o600)
    else: save(target,stage/(name+'.env'),{flag:'0'})
site=(stage/'mcp.caddy').read_bytes()
if mode=='on':
    template=(release/'deploy/supabase-stack/commonswarm-mcp.caddy').read_bytes()
    pattern=rb'\t\t@mcp_unavailable path /mcp /\.well-known/oauth-protected-resource/mcp\n\t\thandle @mcp_unavailable \{\n(?:[^\n]*\n)*?\t\t\}'
    dark=re.search(pattern,template)
    assert dark and site.count(b'\t\timport mcp_resource_active')==1, 'Caddy snapshot differs'
    site=site.replace(b'\t\timport mcp_resource_active',dark[0])
(stage/'mcp.off.caddy').write_bytes(site); os.chmod(stage/'mcp.off.caddy',0o600)
print('input names validated; secret values retained only in protected files')
PY
}
box_rm_preflight() {
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm &&
  test -x /usr/bin/rm && test ! -L /usr/bin/rm &&
  test ! -e /usr/local/bin/rm && test ! -L /usr/local/bin/rm &&
  test ! -e /usr/local/sbin/rm && test ! -L /usr/local/sbin/rm || {
  echo 'FAIL: box-rm-preflight; expected root /usr/bin/rm and no local wrapper' >&2; return 1;
}
}
remove_management_credentials() {
  box_rm_preflight || return 1
  python3 - <<'PY' || { echo 'FAIL: management cleanup boundary' >&2; return 1; }
import pathlib
path=pathlib.Path('/etc/commonswarm-oauth/management-database-credentials')
assert path not in (pathlib.Path('/'), pathlib.Path.home())
assert not path.is_symlink() and path.resolve(strict=False)==path
assert not path.exists() or path.is_file()
PY
  /usr/bin/rm -f /etc/commonswarm-oauth/management-database-credentials || {
    echo 'FAIL: box removal failed /etc/commonswarm-oauth/management-database-credentials; report exact error' >&2; return 1;
  }
  test ! -e /etc/commonswarm-oauth/management-database-credentials && test ! -L /etc/commonswarm-oauth/management-database-credentials || return 1
}
caddy_sites_import() {
python3 - <<'PY' || return 1
import pathlib, posixpath, shlex
imports=[]
for line in pathlib.Path('/etc/caddy/Caddyfile').read_text().splitlines():
    fields=shlex.split(line, comments=True)
    if len(fields)==2 and fields[0]=='import':
        imports.append(posixpath.normpath(posixpath.join('/etc/caddy', fields[1])))
assert '/etc/caddy/sites/*.caddy' in imports, 'Caddy sites import differs after resolving against /etc/caddy'
PY
}
oauth_compose() {
  docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
    -f "$OAUTH_RELEASE_DIR/deploy/mcp-auth/compose.yaml" "$@"
}
oauth_management_compose() {
  docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
    -f "$OAUTH_RELEASE_DIR/deploy/mcp-auth/compose.yaml" \
    -f "$OAUTH_RELEASE_DIR/deploy/mcp-auth/compose.management.yaml" "$@"
}
edge_compose() {
  COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose --project-name commonswarm-edge \
    -f "$EDGE_DIR/deploy/edge-runtime/compose.yaml" \
    -f "$EDGE_DIR/deploy/edge-runtime/compose.override.yaml" "$@"
}
healthy() {
  for count in $(seq 1 30); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$1") || return 1
    test "$status" != unhealthy || return 1
    test "$status" != healthy || return 0
    sleep 2
  done
  echo "FAIL: unhealthy container $1" >&2; return 1
}
rollback_to_off() {
  local off_compose_input="${1:-compose.off.env}"
  caddy_sites_import || return 1
  { cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" ||
    cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy"; } || return 1
  install -o root -g root -m 0600 "$SECRET_STAGE/service.off.env" /etc/commonswarm-oauth/service.env || return 1
  install -o root -g root -m 0600 "$SECRET_STAGE/$off_compose_input" /etc/commonswarm-oauth/compose.env || return 1
  cat "$SECRET_STAGE/edge.off.env" >/home/commonswarm/.env || return 1
  cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.off.env" || return 1
  cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.off.env" || return 1
  oauth_compose config --quiet || return 1
  oauth_compose up -d --no-deps --force-recreate --pull never oauth || return 1
  remove_management_credentials || return 1
  edge_compose up -d --no-deps --force-recreate --pull never edge-runtime || return 1
  healthy commonswarm-oauth-oauth-1 && healthy commonswarm-edge-edge-runtime-1 || return 1
  MODE=$(hm37_baseline_mode) || return 1
  test "$MODE" = off || return 1
}
baseline_rollback_off() {
  local OAUTH_RELEASE_DIR="$BASELINE_OAUTH_DIR"
python3 - "$EXPECTED_OAUTH_SHA" "$EXPECTED_OAUTH_IMAGE_DIGEST" "$BASELINE_OAUTH_DIR" "$BASELINE_OAUTH_COMPOSE" <<'PY' || return 1
import pathlib, re, sys
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-oauth-rollback REQ {number}: {description}; STOP")
sha,image,directory,compose=sys.argv[1:]; release=pathlib.Path(directory); file=pathlib.Path(compose)
require(re.fullmatch(r'[0-9a-f]{40}',sha) and re.fullmatch(r'sha256:[0-9a-f]{64}',image),1,'saved baseline inputs have valid immutable identities')
require(release.is_dir() and release.resolve(strict=True)==release and release.name==sha and (release/'RELEASE_SHA').is_file() and (release/'RELEASE_SHA').read_text().strip()==sha,2,'saved measured release still contains EXPECTED_OAUTH_SHA')
require(file==release/'deploy/mcp-auth/compose.yaml' and file.is_file(),3,'saved measured baseline Compose file exists in that release')
PY
  docker image inspect "$EXPECTED_OAUTH_IMAGE_DIGEST" >/dev/null || return 1
  MCP_OAUTH_IMAGE="$EXPECTED_OAUTH_IMAGE_DIGEST" rollback_to_off compose.baseline.off.env || return 1
  test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$EXPECTED_OAUTH_IMAGE_DIGEST" || return 1
  test -L /home/commonswarm/oauth/current || return 1
  ln -sfn "$BASELINE_OAUTH_DIR" /home/commonswarm/oauth/current || return 1
  MCP_EXPECTED_MODE=off mcp_route_probes || return 1
}
restore_baseline_on() {
  local OAUTH_RELEASE_DIR="$BASELINE_OAUTH_DIR"
  test "$BASELINE_MCP_MODE" = on || return 1
  caddy_sites_import || return 1
  test -f "$SECRET_STAGE/management.baseline" && test ! -L "$SECRET_STAGE/management.baseline" || return 1
  install -o root -g 986 -m 0440 "$SECRET_STAGE/management.baseline" /etc/commonswarm-oauth/management-database-credentials || return 1
  install -o root -g root -m 0600 "$SECRET_STAGE/service.env" /etc/commonswarm-oauth/service.env || return 1
  install -o root -g root -m 0600 "$SECRET_STAGE/compose.env" /etc/commonswarm-oauth/compose.env || return 1
  cat "$SECRET_STAGE/edge.env" >/home/commonswarm/.env || return 1
  cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" &&
    cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env" &&
    cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env" &&
    cmp -s /etc/commonswarm-oauth/management-database-credentials "$SECRET_STAGE/management.baseline" || return 1
  test "$(stat -c '%u:%g:%a' /etc/commonswarm-oauth/management-database-credentials)" = 0:986:440 || return 1
  MCP_OAUTH_IMAGE="$EXPECTED_OAUTH_IMAGE_DIGEST" oauth_management_compose config --quiet || return 1
  MCP_OAUTH_IMAGE="$EXPECTED_OAUTH_IMAGE_DIGEST" oauth_management_compose up -d --no-deps --force-recreate --pull never oauth || return 1
  edge_compose up -d --no-deps --force-recreate --pull never edge-runtime || return 1
  healthy commonswarm-oauth-oauth-1 && healthy commonswarm-edge-edge-runtime-1 || return 1
  test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$EXPECTED_OAUTH_IMAGE_DIGEST" || return 1
  cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || return 1
  cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || return 1
  ln -sfn "$BASELINE_OAUTH_DIR" /home/commonswarm/oauth/current || return 1
  MODE=$(hm37_baseline_mode) || return 1
  test "$MODE" = on || return 1
  MCP_EXPECTED_MODE=on mcp_route_probes || return 1
  oauth_memory_gate || return 1
}
recover_baseline() {
  if ! baseline_rollback_off; then
    echo 'FAIL hm37-oauth-rollback REQ 90: baseline OFF recovery/probes failed; state UNVERIFIED; retain stage; STOP' >&2
    return 1
  fi
  if test "$BASELINE_MCP_MODE" = on; then
    if ! restore_baseline_on; then
      baseline_rollback_off || { echo 'FAIL hm37-mcp-restore-on REQ 91: OFF containment failed; state UNVERIFIED; retain stage; STOP' >&2; return 1; }
      echo 'FAIL hm37-mcp-restore-on REQ 92: baseline ON restore failed; end state baseline OFF, dark Caddy and 503 verified; STOP' >&2
      return 1
    fi
    outage_receipt || { echo 'FAIL hm37-oauth-rollback REQ 93: baseline ON verified but receipt failed; retain stage; STOP' >&2; return 1; }
    echo 'Baseline image and exact ON snapshots restored; ON probes PASS; stop forward release work'
  else
    echo 'Baseline image restored; end state OFF; OFF probes PASS; stop forward release work'
  fi
}
outage_receipt() {
  local prefix="${DCR_OUTAGE_PREFIX:-mcp-503}"
  test -f "$PROOF_DIR/$prefix-start.epoch" || return 0
  test ! -e "$PROOF_DIR/$prefix-receipt.txt" || return 0
  date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/$prefix-end.utc" || return 1
  date -u +%s >"$PROOF_DIR/$prefix-end.epoch" || return 1
  python3 - "$PROOF_DIR" "$prefix" <<'PY' || return 1
import pathlib, sys
proof=pathlib.Path(sys.argv[1]); prefix=sys.argv[2]; assert prefix in ('mcp-503','mcp-recovery-503')
start=int((proof/(prefix+'-start.epoch')).read_text()); end=int((proof/(prefix+'-end.epoch')).read_text())
assert end>=start, 'UTC clock moved backwards'
receipt='503 window start='+ (proof/(prefix+'-start.utc')).read_text().strip()+' end='+ (proof/(prefix+'-end.utc')).read_text().strip()+' duration_seconds='+str(end-start)+'\n'
(proof/(prefix+'-receipt.txt')).write_text(receipt)
total=end-start
if prefix=='mcp-recovery-503':
 forward_start=int((proof/'mcp-503-start.epoch').read_text()); forward_end=int((proof/'mcp-503-end.epoch').read_text())
 assert forward_start<=forward_end<=start
 total+=forward_end-forward_start
print(receipt+'total_outage_seconds='+str(total),end='\n')
assert total<=240, 'FAIL: MCP outage exceeded MAX_MCP_OUTAGE_SECONDS=240; STOP'
PY
}
oauth_memory_gate() {
  docker inspect --format '{{.HostConfig.Memory}}' commonswarm-oauth-oauth-1 >"$PROOF_DIR/oauth-memory-limit.bytes" || return 1
  docker stats --no-stream --format '{{json .}}' commonswarm-oauth-oauth-1 >"$PROOF_DIR/oauth-stats.json" || return 1
  python3 - "$PROOF_DIR" <<'PY' || return 1
import decimal, json, pathlib, re, sys
proof=pathlib.Path(sys.argv[1]); limit=int((proof/'oauth-memory-limit.bytes').read_text())
assert limit>0, 'OAuth container has no memory limit'
stats=json.loads((proof/'oauth-stats.json').read_text())
assert stats['Name']=='commonswarm-oauth-oauth-1', 'stats container identity mismatch'
match=re.fullmatch(r'\s*([0-9.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)\s*',stats['MemUsage'].split('/')[0])
assert match, 'unrecognized Docker memory units'
units={'B':1,'KiB':1024,'MiB':1024**2,'GiB':1024**3,'TiB':1024**4,'kB':1000,'MB':1000**2,'GB':1000**3,'TB':1000**4}
used=decimal.Decimal(match[1])*units[match[2]]
print('OAuth docker stats memory bytes='+str(used)+' inspected limit bytes='+str(limit))
assert used*5<limit*4, 'OAuth memory is at or above 80% of inspected limit; rollback required'
print('OAuth memory <80%: PASS')
PY
}
SH
printf 'DCR_PROOF=%q\nMAX_MCP_OUTAGE_SECONDS=240\nWINDOW_END_UTC=%q\n' "$DCR_PROOF" "$WINDOW_END_UTC" >>"$STATE"
declare -f hm37_baseline_mode mcp_route_probes >>"$STATE"
. "$STATE"
prepare_off_inputs "$EXPECTED_OAUTH_IMAGE_DIGEST" || { echo 'FAIL hm37-oauth-open REQ 24: OFF inputs could not be prepared; baseline unchanged; STOP' >&2; exit 1; }
cp "$SECRET_STAGE/compose.env" "$SECRET_STAGE/compose.baseline.off.env" || exit 1
caddy_sites_import || exit 1
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || { echo 'FAIL: Caddy snapshot changed; stop and report' >&2; exit 1; }
touch "$PROOF_DIR/open-ready.txt"
printf 'Window state (paths and code only): %s\n' "$STATE"
```

```sh
# step: dcr-oauth-enable
set -euo pipefail
test "${TOM_ENABLE_APPROVAL:-}" = 2026-09-29 || { echo 'FAIL: named HezLead switch-on approval missing' >&2; exit 1; }
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
caddy_sites_import || exit 1
DCR_OAUTH_PROOF=$PROOF_DIR
. "$DCR_PROOF/state.sh"; . "$DB_SESSION"
test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261002000001';")" = 1
printf '\\i /proof/20261002000001-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = t
. "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"
REMAINING=$((180 - $(date -u +%s) + $(cat "$PROOF_DIR/mcp-503-start.epoch")))
test "$REMAINING" -gt 0 && test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"

cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.off.env" || { echo 'FAIL: edge env changed since snapshot; stop and report' >&2; exit 1; }
test -f "$DCR_PROOF/caddy-applied.txt" && test -f "$DCR_PROOF/caddy-off-verified.txt"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy" || { echo 'FAIL: Caddy candidate changed; stop and report' >&2; exit 1; }
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.off.env" || { echo 'FAIL: OAuth env changed since OFF deploy; stop and report' >&2; exit 1; }
test ! -e /etc/commonswarm-oauth/management-database-credentials && test ! -L /etc/commonswarm-oauth/management-database-credentials || { echo 'FAIL: unexpected management file; stop and report' >&2; exit 1; }
switch_on() {
  OAUTH_USER=$(docker inspect --format '{{.Config.User}}' commonswarm-oauth-oauth-1) || return 1
  test "$OAUTH_USER" = 996:986 || { echo 'FAIL: OAuth runtime must be UID:GID 996:986; stop on drift' >&2; return 1; }
  IMAGE=$(cat "$PROOF_DIR/oauth-image.id") || return 1
  test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$IMAGE" || return 1
  docker exec commonswarm-oauth-oauth-1 node --input-type=module -e '
import dns from "node:dns/promises";
if(process.getuid()!==996 || process.getgid()!==986 ||
   process.env.MCP_OAUTH_DATABASE_HOST!=="db.commonswarm.internal" ||
   (await dns.lookup("db.commonswarm.internal")).address!=="172.31.0.10") process.exit(1);
' || return 1
  # The reviewed base Compose extra_hosts resolves this name to 172.31.0.10.
  # Root reads SWARM_DATABASE_URL only in memory; this transient producer uses
  # the same exact image/network/name mapping and emits no database values.
  docker run --rm -i --pull never --network commonswarm-net --user 0:0 \
    --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true --log-driver none \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --mount type=bind,src=/home/commonswarm/.env,dst=/home/commonswarm/.env,readonly \
    --mount "type=bind,src=$SECRET_STAGE,dst=/secret-stage" \
    --mount type=bind,src=/etc/ssl/yulan-internal-ca.pem,dst=/etc/ssl/yulan-internal-ca.pem,readonly \
    --entrypoint node "$IMAGE" --input-type=module <<'NODE' || return 1
import fs from "node:fs";
import postgres from "postgres";
let db;
let check = "root credential producer configuration";
function requireCheck(ok, number, description) {
  check = `REQ ${number}: ${description}`;
  if (!ok) throw new Error("gate");
}
function env(path, number, description) {
  const result = {};
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    requireCheck(match && !(match[1] in result), number, description);
    let value = match[2];
    if (value.length >= 2 && ["'", '\"'].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1,-1);
    result[match[1]] = value;
  }
  return result;
}
try {
  requireCheck(process.getuid() === 0, 1, "producer runs as root");
  requireCheck(fs.readFileSync("/home/commonswarm/.env", "utf8") === fs.readFileSync("/secret-stage/edge.off.env", "utf8"), 2, "edge env matches the window snapshot");
  const edge = env("/home/commonswarm/.env", 3, "edge env syntax is valid and names are unique");
  const compose = env("/secret-stage/compose.off.env", 4, "OFF compose env syntax is valid and names are unique");
  requireCheck(compose.MCP_OAUTH_UID === "996" && compose.MCP_OAUTH_GID === "986", 5, "OAuth runtime UID:GID matches the measured identity");
  requireCheck(compose.MCP_OAUTH_DATABASE_HOST === "db.commonswarm.internal" && compose.MCP_OAUTH_DATABASE_ADDRESS === "172.31.0.10", 6, "OAuth database hostname and address match the verified mapping");
  const url = new URL(edge.SWARM_DATABASE_URL);
  requireCheck(["postgres:", "postgresql:"].includes(url.protocol) && url.username && url.password && !url.hash, 7, "edge database URL uses PostgreSQL with login/password and no fragment");
  const query = [...url.searchParams];
  requireCheck(!url.search || (query.length === 1 && query[0][0] === "sslmode" && query[0][1] === "verify-full"), 8, "edge database URL query is absent or exactly one sslmode=verify-full pair");
  url.search = "";
  requireCheck(!url.port || url.port === "5432", 9, "edge database URL port is absent or 5432");
  // Preserve edge username/password/database; dial the OAuth network hostname.
  url.hostname = "db.commonswarm.internal";
  const ssl = { ca: fs.readFileSync("/etc/ssl/yulan-internal-ca.pem", "utf8").trim(), servername: "db.commonswarm.internal", rejectUnauthorized: true };
  requireCheck(ssl.ca.includes("-----BEGIN CERTIFICATE-----"), 10, "mounted TLS CA contains a certificate");
  // Grant numbers follow the fixed role/schema/table/behavior traversal below.
  let grantRequirement = 11;
  check = "edge login connection with verified CA/servername";
  db = postgres(url.href, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 3, ssl, onnotice() {} });
  await db.begin("read only", async tx => {
    await tx`SELECT set_config('statement_timeout', '10s', true), set_config('lock_timeout', '5s', true)`;
    for (const role of ["swarm_command", "swarm_read"]) {
      for (const privilege of ["MEMBER", "SET"]) {
        check = `${privilege} ON ROLE ${role} TO edge login`;
        const rows = await tx`SELECT pg_has_role(current_user, ${role}, ${privilege}) AS allowed`;
        requireCheck(rows[0]?.allowed === true, grantRequirement++, check);
      }
    }
  });
  // Check effective grants AFTER SET ROLE, as the real management path does.
  for (const role of ["swarm_command", "swarm_read"]) {
    await db.begin("read only", async tx => {
      await tx`SELECT set_config('statement_timeout', '10s', true), set_config('lock_timeout', '5s', true)`;
      check = `SET ROLE ${role} TO edge login`;
      await tx`SELECT set_config('role', ${role}, true)`;
      for (const schema of role === "swarm_command" ? ["swarm"] : ["swarm_read", "swarm"]) {
        check = `USAGE ON SCHEMA ${schema} TO ${role}`;
        const rows = await tx`SELECT has_schema_privilege(current_user, ${schema}, 'USAGE') AS allowed`;
        requireCheck(rows[0]?.allowed === true, grantRequirement++, check);
      }
      const tables = role === "swarm_command" ? [
        ["swarm.users", "SELECT,INSERT,UPDATE"],
        ["swarm.hosted_mcp_grants", "SELECT,INSERT,UPDATE"],
        ["swarm.hosted_mcp_grant_workspaces", "SELECT,INSERT"],
        ["swarm.hosted_mcp_seats", "SELECT,UPDATE"],
        ["swarm.hosted_mcp_seat_handles", "SELECT,UPDATE"],
        ["swarm.agent_principals", "SELECT,UPDATE"],
        ["swarm.workspaces", "SELECT"], ["swarm.memberships", "SELECT"],
        ["swarm.invitations", "SELECT"], ["swarm.agent_tokens", "SELECT"],
        ["swarm.streams", "SELECT,UPDATE"], ["swarm.idempotency_keys", "SELECT,INSERT"],
        ["swarm.events", "INSERT"], ["swarm.audit_log", "INSERT"],
      ] : [["swarm_read.workspaces", "SELECT"]];
      for (const [table, privileges] of tables) {
        for (const privilege of privileges.split(",")) {
          check = `${privilege} ON TABLE ${table} TO ${role}`;
          const rows = await tx`SELECT has_table_privilege(current_user, ${table}, ${privilege}) AS allowed`;
          requireCheck(rows[0]?.allowed === true, grantRequirement++, check);
        }
      }
      if (role === "swarm_read") {
        // The workspaces view is definer-rights, owned by swarm_admin:
        // 20260724000002_status_workspaces.sql:28 preserves ownership through
        // 20260820000001_hide_archived_workspaces.sql:6-15 (security_barrier only).
        // Check the view behavior under SET ROLE swarm_read; resolving auth.uid()
        // by text here would require unnecessary USAGE on the auth schema.
        check = "SELECT ON swarm_read.workspaces with verified-user claims (including view dependencies)";
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({sub: "00000000-0000-4000-8000-000000000000", role: "authenticated"})}, true)`;
        const rows = await tx`SELECT workspace_id, name FROM swarm_read.workspaces LIMIT 1`;
        requireCheck(rows.length === 0, grantRequirement++, check);
        check = "management workspace listing ON swarm_read.workspaces with verified-user claims under SET ROLE swarm_read";
        const listing = await tx`SELECT workspace_id AS id, name FROM swarm_read.workspaces ORDER BY name, workspace_id`;
        requireCheck(listing.length === 0, grantRequirement++, check);
      }
    });
  }
  // Close the checked login BEFORE creating the first credential file.
  check = "close read-only grant preflight";
  await db.end({timeout: 5}); db = undefined;
  check = "exclusive root-only credential staging";
  fs.writeFileSync("/secret-stage/management-database-credentials", JSON.stringify({databaseUrl: url.href})+"\n", {flag: "wx", mode: 0o600});
  console.log("edge login grants checked read-only; root-only management file staged: PASS");
} catch (error) {
  // Do not print error.message, query results, URLs, login names or objects.
  const code = /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? ` SQLSTATE=${error.code}` : "";
  console.error(`FAIL hm37-mcp-enable ${check}${code}; STOP; never widen grants`);
  process.exitCode = 1;
} finally {
  if (db) { try { await db.end({timeout: 5}); } catch { process.exitCode = 1; } }
}
NODE
  python3 - "$SECRET_STAGE" <<'PY' || return 1
import os, pathlib, re, sys
stage=pathlib.Path(sys.argv[1])
for source,target,flag in [('service.off.env','service.on.env','MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED'),
    ('edge.off.env','edge.on.env','SWARM_MCP_PUBLIC_ENABLED')]:
    text=(stage/source).read_text()
    text,count=re.subn(r'^'+flag+r'=.*$',flag+'=1',text,flags=re.M)
    assert count<=1, 'flag inventory conflict'
    if count==0: text=text.rstrip('\n')+'\n'+flag+'=1\n'
    (stage/target).write_text(text); os.chmod(stage/target,0o600)

PY
  test ! -e /etc/commonswarm-oauth/management-database-credentials && test ! -L /etc/commonswarm-oauth/management-database-credentials || return 1
  # Compose overrides the image default; measured Config.User is 996:986.
  # Read only for root and that runtime group; root retains ownership and nobody has write bits.
  install -o root -g 986 -m 0440 "$SECRET_STAGE/management-database-credentials" /etc/commonswarm-oauth/management-database-credentials || return 1
  test "$(stat -c '%u:%g:%a' /etc/commonswarm-oauth/management-database-credentials)" = 0:986:440 || return 1
  install -o root -g root -m 0600 "$SECRET_STAGE/service.on.env" /etc/commonswarm-oauth/service.env || return 1
  cat "$SECRET_STAGE/edge.on.env" >/home/commonswarm/.env || return 1
  oauth_management_compose config --quiet || return 1
  oauth_management_compose up -d --no-deps --force-recreate --pull never oauth || return 1
  edge_compose up -d --no-deps --force-recreate --pull never edge-runtime || return 1
  healthy commonswarm-oauth-oauth-1 && healthy commonswarm-edge-edge-runtime-1 || return 1
  docker exec commonswarm-oauth-oauth-1 node -e 'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1" ? 0 : 1)' || return 1
  docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c 'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" = 1' || return 1
  docker exec commonswarm-oauth-oauth-1 node --input-type=module -e '
import {loadConfig} from "./src/config.js";
import {createProductionManagementBindings} from "./src/management-bindings.js";
if(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED!=="1") process.exit(1);
const config=await loadConfig();
const bindings=await createProductionManagementBindings(config);
try {
  const fs=await import("node:fs");
  const file=process.env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE;
  const stat=fs.statSync(file);
  if(process.getuid()!==996 || process.getgid()!==986 || stat.uid!==0 || stat.gid!==986 || (stat.mode & 0o777)!==0o440) throw new Error("management file permissions");
  fs.accessSync(file, fs.constants.R_OK);
  const {db}=await import("./src/management-command.generated.js");
  const rows=await db`SELECT pg_has_role(current_user, '\''swarm_command'\'', '\''MEMBER'\'') AS command,
    pg_has_role(current_user, '\''swarm_read'\'', '\''MEMBER'\'') AS read`;
  if(rows[0]?.command!==true || rows[0]?.read!==true) throw new Error("management role readiness");
  await db.begin(async tx => { await tx`SELECT set_config('\''role'\'', '\''swarm_command'\'', true)`; });
  const workspaces=await bindings.managementWorkspaceReader({userId:crypto.randomUUID(),identityVerified:true});
  if(workspaces.length!==0) throw new Error("workspace identity scope");
  console.log("management command role and scoped workspace read: PASS");
} catch { console.error("FAIL: management binding readiness"); process.exitCode=1; }
finally { await bindings.closeManagement(); }
' || return 1
  cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy" || return 1
}
declare -f switch_on >"$PROOF_DIR/dcr-enable-helper.sh"
chmod 0600 "$PROOF_DIR/dcr-enable-helper.sh"
export OAUTH_RELEASE_SHA DCR_PROOF
if ! timeout --signal=TERM --kill-after=5 "$REMAINING" /bin/bash -euo pipefail -c \
 '. "$1/hm37-window.sh"; . "$1/dcr-enable-helper.sh"; switch_on' -- "$PROOF_DIR"; then
  echo 'FAIL: switch-on/readiness; rolling back to OFF' >&2
  rollback_to_off || { echo 'FAIL: rollback-to-OFF; stop and report' >&2; exit 1; }
  exit 1
fi
```

```sh
# step: dcr-oauth-verify
# readonly: yes
# host: box root /bin/bash
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(hm37_baseline_mode)" = on
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy"
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 mcp-before.sha256 >/dev/null)
python3 - "$PROOF_DIR" "$DCR_PROOF" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); evidence=pathlib.Path(sys.argv[2]); text=(p/'mcp-503-receipt.txt').read_text()
m=re.search(r'duration_seconds=([0-9]+)',text); assert m and int(m[1])<=240
(evidence/'oauth-verified.txt').write_text('ON; reviewed MCP candidate/apex unchanged; outage<=240\n')
PYCODE
```

## 3. MCP CADDY CHANGE

The rendered candidate differs from the saved LIVE snapshot on exactly three path lists: POST gains /reg, /me,
/session/end/confirm; GET/HEAD gains /me, /session/end, /session/end/success;
the wrong-method list gains all of those routes AND /authorize/* only there.
+The authorize matcher already contains /authorize/* in LIVE and must stay byte-identical. No /register route.
Only /etc/caddy/sites/20-commonswarm-mcp.caddy is replaced. Apex
/etc/caddy/Caddyfile is never written. Candidate comes from the archive, renders
five checked 3490 placeholders and replaces the dark template resource block
with the already-live ON import. Comparison to the window-saved LIVE bytes plus exactly these three
path-list substitutions refuses unrelated changes, including certificates/log filters.
Copy + SHA-256 and secret baseline snapshots remain available through part 4.

Offline verification against HezLead's read-only LIVE-20-commonswarm-mcp.caddy
copy (not a fresh production read) found exactly these changes at LIVE lines
59, 79 and 178. Commit 55de996e added /authorize/* to both the authorize matcher
and wrong-method list; LIVE has only the matcher addition. The V2 gate therefore
allows the missing wrong-method token alongside the DCR additions. It still
compares against the freshly saved window LIVE bytes, never a repo baseline.
LIVE SHA-256: 09f1a8b4c84d4024f6818df0c1c95d275e31b595b80f135adf1c14c344d4304c.
Repository template SHA-256: 30ca1b28f5fcb351f22ea3d2c791d67ab307377f2242772fe871c5bf8b4c14f2.
The rendered comparison is:

```diff
--- saved LIVE (ON)
+++ rendered repo (ON)
@@ -59 +59 @@
-		path /token /interaction/*
+		path /token /reg /me /session/end/confirm /interaction/*
@@ -79 +79 @@
-		path /interaction/* /oauth/callback/gotrue
+		path /me /session/end /session/end/success /interaction/* /oauth/callback/gotrue
@@ -178 +178 @@
-		@oauth_wrong_method path /health /.well-known/oauth-authorization-server /.well-known/openid-configuration /jwks /authorize /token /interaction/* /oauth/callback/gotrue
+		@oauth_wrong_method path /health /.well-known/oauth-authorization-server /.well-known/openid-configuration /jwks /authorize /authorize/* /token /reg /me /session/end /session/end/confirm /session/end/success /interaction/* /oauth/callback/gotrue
```


The candidate keeps the active resource import while flags enforce OFF.
Validation, reload and OFF probes together have a 30s share of the 180s forward
budget (TERM at the cap, at most 1s kill grace; no next forward step on timeout). Failure or overrun goes to dcr-caddy-failure; no forward retry.

```sh
# step: dcr-public-helper
# readonly: yes
# host: retained box root /bin/bash
set -euo pipefail
: "${DCR_PROOF:?}"
dcr_public_probe() {
python3 - "$DCR_PROOF" "$1" <<'PY'
import json,pathlib,re,sys,urllib.error,urllib.parse,urllib.request
proof=pathlib.Path(sys.argv[1]); phase=sys.argv[2]; rows=[]
receipt=proof/('public-'+phase+'.json'); issuer='https://mcp.commonswarm.com'
off=phase in ('caddy-off','rollback-off'); rollback=phase in ('rollback','rollback-off')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
def request(label,url,method='GET',payload=None,form=False):
 parsed=urllib.parse.urlsplit(url)
 assert ((parsed.scheme=='https' and parsed.netloc=='mcp.commonswarm.com') or
         (phase=='caddy-off' and parsed.scheme=='http' and parsed.netloc=='127.0.0.1:3490')) and not parsed.fragment
 headers={'User-Agent':'curl/8.7.1','Accept':'application/json','Content-Type':'application/x-www-form-urlencoded' if form else 'application/json'}
 data=payload if isinstance(payload,bytes) else json.dumps(payload).encode() if payload is not None else None
 try:
  try: response=opener.open(urllib.request.Request(url,data=data,method=method,headers=headers),timeout=10)
  except urllib.error.HTTPError as error: response=error
  with response:
   body=response.read(131073); status=response.code; media=response.headers.get_content_type()
   try: value=json.loads(body)
   except (ValueError,UnicodeError): value=None
   error=value.get('error') if isinstance(value,dict) else None
   error=error if isinstance(error,str) and re.fullmatch('[a-z_]{1,80}',error) else None
   rows.append({'probe':label,'status':status,'type':media,'size':len(body),'error_code':error})
   receipt.write_text(json.dumps({'phase':phase,'responses':rows},indent=2)+'\n')
   assert len(body)<=131072
   return status,media,value,body,response.headers
 except Exception:
  raise SystemExit('FAIL DCR public transport/size; see receipt; STOP') from None
try:
 s,t,v,_,_=request('health',issuer+'/health'); assert s==200 and t=='application/json' and v.get('status')=='ok'
 s,t,v,_,_=request('jwks',issuer+'/jwks'); assert s==200 and t in ('application/json','application/jwk-set+json')
 assert v.get('keys') and all('d' not in k for k in v['keys'])
 discovery=None
 for path in ['/.well-known/openid-configuration','/.well-known/oauth-authorization-server']:
  s,t,v,_,_=request(path,issuer+path); assert s==200 and t=='application/json' and v.get('issuer')==issuer
  if not rollback and not off:
   assert 'registration_endpoint' in v and 'pushed_authorization_request_endpoint' not in v
   assert v.get('userinfo_endpoint')==issuer+'/me' and v.get('end_session_endpoint')==issuer+'/session/end'
   assert v.get('registration_endpoint')==issuer+'/reg'
  if discovery is None: discovery=v
 if off:
  s,t,v,_,_=request('mcp-off',issuer+'/mcp','POST',{})
  assert s==503 and t=='application/json' and v.get('error')=='feature_disabled'
  s,t,v,_,_=request('resource-metadata-off',issuer+'/.well-known/oauth-protected-resource/mcp')
  assert s==503 and t=='application/json' and v.get('error')=='feature_disabled'
  if not rollback:
   routes=[('/reg','POST'),('/me','GET'),('/me','POST'),('/session/end','GET'),
           ('/session/end/confirm','POST'),('/session/end/success','GET')]
   for path,method in routes:
    for base in ['http://127.0.0.1:3490',issuer]:
     s,t,v,_,_=request(('local' if base.startswith('http:') else 'public')+path+'-'+method,base+path,method,b'' if method=='POST' else None,form=True)
     assert s==503 and t=='application/json' and v.get('error')=='authorization_service_disabled'
 else:
  s,t,v,_,h=request('mcp-anonymous',issuer+'/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})
  assert s==401 and t=='application/json'
  challenge=h.get('WWW-Authenticate','')
  assert re.search(r'\bBearer\b',challenge,re.I) and 'resource_metadata="https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp"' in challenge
  s,t,v,_,_=request('resource-metadata',issuer+'/.well-known/oauth-protected-resource/mcp')
  assert s==200 and t=='application/json' and v.get('resource')==issuer+'/mcp'
  if not rollback:
   for method in ['GET','POST']:
    s,t,v,_,_=request('userinfo-'+method,discovery['userinfo_endpoint'],method,b'' if method=='POST' else None,form=True)
    assert s==401 and t=='application/json' and v.get('error')=='invalid_token'
   s,t,v,body,_=request('end-session',discovery['end_session_endpoint']); assert s==200 and t=='text/html'
   assert b'/session/end/confirm' in body and b'node_modules' not in body
 if phase=='dcr':
  payload={'redirect_uris':['https://dcr-release-probe.invalid/callback'],'token_endpoint_auth_method':'none','grant_types':['authorization_code'],'response_types':['code']}
  # POST target comes from discovery, never hard-coded /register.
  s,t,v,_,_=request('registration',discovery['registration_endpoint'],'POST',payload)
  assert s==201 and t=='application/json' and isinstance(v.get('client_id'),str) and v['client_id']
  assert 'client_secret' not in v and 'registration_access_token' not in v
  s,t,_,body,_=request('registered-end-session',discovery['end_session_endpoint']+'?'+urllib.parse.urlencode({'client_id':v['client_id']}))
  assert s==200 and t=='text/html' and b'/session/end/confirm' in body
  (proof/'probe-registration-policy.txt').write_text('Unused public client; reserved .invalid redirect; no grant/token; idle expiry 30 days; hourly cleanup; client_id not retained.\n')
 print('PASS DCR public '+phase+'; status-only receipt '+receipt.name)
except Exception:
 raise SystemExit('FAIL DCR public status/media/contract; see receipt; STOP') from None
PY
}

declare -f dcr_public_probe >"$DCR_PROOF/public-helper.sh"
chmod 0600 "$DCR_PROOF/public-helper.sh"
```

```sh
# step: dcr-caddy-apply
# readonly: no
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL dcr-caddy-apply line $LINENO; run dcr-caddy-failure; STOP" >&2' ERR
: "${DCR_PROOF:?}"
test ! -e "$DCR_PROOF/closed.txt"
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(hm37_baseline_mode)" = off
REMAINING=$((180 - $(date -u +%s) + $(cat "$PROOF_DIR/mcp-503-start.epoch")))
test "$REMAINING" -gt 0 && test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"
CADDY_FORWARD_SECONDS=30
if test "$REMAINING" -lt "$CADDY_FORWARD_SECONDS"; then CADDY_FORWARD_SECONDS=$REMAINING; fi
dcr_caddy_forward() {
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 mcp-before.sha256 >/dev/null)
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-before.caddy"
test ! -L /etc/caddy/sites/20-commonswarm-mcp.caddy
python3 - "$DCR_PROOF" <<'PYCODE'
import os,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); old=(p/'mcp-before.caddy').read_bytes().decode('utf-8')
source=(p/'source/deploy/supabase-stack/commonswarm-mcp.caddy').read_bytes().decode('utf-8')
assert source.count('{$MCP_OAUTH_HOST_PORT}')==5
candidate=source.replace('{$MCP_OAUTH_HOST_PORT}','3490')
pattern=r'\t\t@mcp_unavailable path /mcp /\.well-known/oauth-protected-resource/mcp\n\t\thandle @mcp_unavailable \{\n(?:[^\n]*\n)*?\t\t\}'
candidate,n=re.subn(pattern,'\t\timport mcp_resource_active',candidate); assert n==1
# The allow-list is relative to the LIVE bytes saved by dcr-oauth-open.
# /authorize/* is permitted only on the wrong-method line; its matcher is unchanged.
changes=[
 ('\t\tpath /token /interaction/*',
  '\t\tpath /token /reg /me /session/end/confirm /interaction/*',
  {'/reg','/me','/session/end/confirm'}),
 ('\t\tpath /interaction/* /oauth/callback/gotrue',
  '\t\tpath /me /session/end /session/end/success /interaction/* /oauth/callback/gotrue',
  {'/me','/session/end','/session/end/success'}),
 ('\t\t@oauth_wrong_method path /health /.well-known/oauth-authorization-server /.well-known/openid-configuration /jwks /authorize /token /interaction/* /oauth/callback/gotrue',
  '\t\t@oauth_wrong_method path /health /.well-known/oauth-authorization-server /.well-known/openid-configuration /jwks /authorize /authorize/* /token /reg /me /session/end /session/end/confirm /session/end/success /interaction/* /oauth/callback/gotrue',
  {'/authorize/*','/reg','/me','/session/end','/session/end/confirm','/session/end/success'})]
allowed={'/reg','/me','/session/end','/session/end/confirm','/session/end/success','/authorize/*'}
expected=old
for before,after,added in changes:
 assert added<=allowed and set(after.split())-set(before.split())==added
 assert '/authorize/*' not in added or before.startswith('\t\t@oauth_wrong_method path ')
 assert expected.splitlines().count(before)==1, 'FAIL: LIVE path-list baseline differs; STOP'
 expected=expected.replace(before+'\n',after+'\n',1)
assert candidate==expected, 'FAIL: Caddy differs beyond exact three LIVE path-list lines; STOP'
assert len(old.splitlines())==len(candidate.splitlines())
assert sum(a!=b for a,b in zip(old.splitlines(),candidate.splitlines()))==3
assert candidate.count('import mcp_resource_active')==1 and '@mcp_unavailable' not in candidate
(p/'mcp-candidate.caddy').write_bytes(candidate.encode('utf-8')); os.chmod(p/'mcp-candidate.caddy',0o600)
PYCODE
install -o root -g root -m 0644 "$DCR_PROOF/mcp-candidate.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 >/dev/null)
systemctl reload caddy
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy"
sha256sum /etc/caddy/sites/20-commonswarm-mcp.caddy >"$DCR_PROOF/mcp-after.sha256"
touch "$DCR_PROOF/caddy-applied.txt"
. "$DCR_PROOF/public-helper.sh"
dcr_run_step dcr-caddy-probes
}
declare -f dcr_caddy_forward >"$DCR_PROOF/caddy-forward.sh"
chmod 0600 "$DCR_PROOF/caddy-forward.sh"
export DCR_PROOF OAUTH_RELEASE_SHA
# Includes validation/reload/probes, bounded by both the Caddy share and global budget.
timeout --signal=TERM --kill-after=1 "$CADDY_FORWARD_SECONDS" /bin/bash -euo pipefail -c \
 '. "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"; . "$DCR_PROOF/caddy-forward.sh"; dcr_caddy_forward'
test $(( $(date -u +%s) - $(cat "$PROOF_DIR/mcp-503-start.epoch") )) -lt 180
test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"
```

dcr-public-helper runs before OFF, so marked rollback extraction/probes are ready
even if candidate generation/installation/validation fails. dcr-caddy-probes
requires OFF and compares new routes with the service OFF response; it creates no client.
OFF provider disables registration discovery; registration metadata is asserted
only after enable in part 4.
All public requests use curl/8.7.1, bounded timeout/body, no redirects/bearer.
Part 4's single unused public client has a reserved .invalid redirect:
no authenticated user, consent, grant or token. It expires after **30 days**;
the hourly production cleanup removes expired rows. No invented public delete
route. Never retain client_id, metadata, cookies, Location or response body.



```sh
# step: dcr-caddy-probes
# readonly: yes
# host: box root /bin/bash
set -euo pipefail
: "${DCR_PROOF:?}"
. "$DCR_PROOF/public-helper.sh"
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(hm37_baseline_mode)" = off
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 >/dev/null)
dcr_public_probe caddy-off
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 >/dev/null)
touch "$DCR_PROOF/caddy-off-verified.txt"
```

```sh
# step: dcr-caddy-rollback
# readonly: no
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL dcr-caddy-rollback line $LINENO; retain bytes/evidence; STOP" >&2' ERR
: "${DCR_PROOF:?}"
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 mcp-before.sha256 >/dev/null)
test -f /etc/caddy/sites/20-commonswarm-mcp.caddy && test ! -L /etc/caddy/sites/20-commonswarm-mcp.caddy
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy" || cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-before.caddy"
install -o root -g root -m 0644 "$DCR_PROOF/mcp-before.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-before.caddy"
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 >/dev/null)
touch "$DCR_PROOF/caddy-rollback-reloaded.txt"
. "$DCR_PROOF/public-helper.sh"
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
MODE=$(hm37_baseline_mode)
case "$MODE" in on) dcr_public_probe rollback;; off) dcr_public_probe rollback-off;; *) exit 1;; esac
printf 'Exact previous MCP Caddy restored; outside probes PASS in mode %s\n' "$MODE"
```

## 4. PUBLIC PROBES

JSON receipts record every response: fixed probe label, status, media type,
byte size, sanitized error code only. Write before validation to retain failures
without bodies. Discovery/JWKS/health are positive controls. End-session proves
routing/provider confirmation HTML; userinfo proves anonymous 401/invalid_token.
Authenticated logout/userinfo and full connector sign-in remain HezLead's Grok
retest; these boundary probes do not claim them.

```sh
# step: dcr-public-probes
# readonly: no (one unused public registration)
# host: box root /bin/bash
set -euo pipefail
: "${DCR_PROOF:?}"
test -f "$DCR_PROOF/caddy-applied.txt" && test -f "$DCR_PROOF/oauth-verified.txt" && test ! -e "$DCR_PROOF/public-dcr.json"
. "$DCR_PROOF/public-helper.sh"
dcr_public_probe dcr
touch "$DCR_PROOF/public-verified.txt"
```

```sh
# step: dcr-final-readback
# readonly: yes
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL DCR read-only preflight line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/oauth/dcr-preflights/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt" && test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261002000001';")" = 1
printf '\\i /proof/20261002000001-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = t
printf '\\i /proof/20261002000001-rollback-catalog.sql\nSELECT :\x27rollback_ok\x27::boolean;\n' >"$READBACK_SQL"
test "$(release_psql_ro -Atq --file "$READBACK_SQL")" = f

test -f "$PROOF_DIR/public-verified.txt"
release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/closed-ledger.txt"
cmp -s "$PROOF_DIR/applied-before.txt" "$PROOF_DIR/closed-ledger.txt"
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-final.txt"
cmp -s "$PROOF_DIR/cron-before.txt" "$PROOF_DIR/cron-final.txt"
touch "$PROOF_DIR/final-readback-verified.txt"
```

Recovery and close use these marked blocks. dcr_run_step extracts only the
exact archived plan's marked block; the reference wrapper extracts the original
hm37-oauth-rollback unchanged. Both failure entries stop the forward run.
Caddy rollback alone can be used while diagnosing without changing OAuth;
these failed-run paths then return OAuth to baseline and close only verified ON.

```sh
# step: dcr-caddy-failure
# readonly: no
# host: box root /bin/bash; Caddy apply/probe failure only
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
dcr_run_step dcr-recover-baseline
```

```sh
# step: dcr-public-failure
# readonly: no
# host: box root /bin/bash; public/final-readback failure only
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
dcr_run_step dcr-recover-baseline
```

```sh
# step: dcr-recover-baseline
# readonly: no
# host: box root /bin/bash; any failed forward work, no retry
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
. "$DCR_PROOF/public-helper.sh"
export OAUTH_RELEASE_SHA DCR_PROOF
# Public checks may fail after an earlier ON receipt: measure the second OFF
# interruption too, and count it with the original outage against 240s.
if test -f "$PROOF_DIR/mcp-503-receipt.txt"; then
 DCR_OUTAGE_PREFIX=mcp-recovery-503
 test ! -e "$PROOF_DIR/$DCR_OUTAGE_PREFIX-start.epoch"
 date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/$DCR_OUTAGE_PREFIX-start.utc"
 date -u +%s >"$PROOF_DIR/$DCR_OUTAGE_PREFIX-start.epoch"
 export DCR_OUTAGE_PREFIX
fi
# Restore Caddy BEFORE OAuth helpers, which require exact baseline Caddy bytes.
# Probe failure in an unhealthy/mixed mode must not prevent baseline recovery.
test ! -e "$DCR_PROOF/caddy-rollback-reloaded.txt"
if /bin/bash -euo pipefail -c '. "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"; dcr_run_step dcr-caddy-rollback'; then
 printf 'Caddy rollback/reload/current-mode probes PASS\n'
else
 test -f "$DCR_PROOF/caddy-rollback-reloaded.txt"
 cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-before.caddy"
 (cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 mcp-before.sha256 >/dev/null)
 echo 'Caddy bytes restored/reloaded; current-mode probes failed; baseline ON probes remain mandatory' >&2
fi
HM37_STEP=hm37-oauth-rollback
export HM37_STEP OAUTH_RELEASE_SHA DCR_PROOF
# Receipt/budget failure may return nonzero after baseline ON was restored.
# Preserve that failure while allowing explicit ON verification and safe close.
if /bin/bash -euo pipefail -c '. "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/hm37-window.sh"; dcr_run_step dcr-oauth-reference'; then
 printf 'baseline rollback completed\n' >"$DCR_PROOF/recovery-result.txt"
else
 printf 'baseline rollback reported failure; explicit ON verification required\n' >"$DCR_PROOF/recovery-result.txt"
fi
dcr_run_step dcr-baseline-verify
dcr_run_step dcr-oauth-close
printf 'Recovered verified baseline ON and closed OAuth secrets; forward run FAILED\n'
exit 1
```

```sh
# step: dcr-baseline-verify
# readonly: yes
# host: box root /bin/bash
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(hm37_baseline_mode)" = on
test "$(readlink -f /home/commonswarm/oauth/current)" = "$BASELINE_OAUTH_DIR"
test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$EXPECTED_OAUTH_IMAGE_DIGEST"
for pair in 'service.env /etc/commonswarm-oauth/service.env' 'compose.env /etc/commonswarm-oauth/compose.env' 'edge.env /home/commonswarm/.env' 'mcp.caddy /etc/caddy/sites/20-commonswarm-mcp.caddy' 'management.baseline /etc/commonswarm-oauth/management-database-credentials'; do
 read -r saved live <<<"$pair"
 cmp -s "$SECRET_STAGE/$saved" "$live"
done
(cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 mcp-before.sha256 >/dev/null)
MCP_EXPECTED_MODE=on mcp_route_probes
oauth_memory_gate
printf 'Verified baseline source/image/ON snapshots and ON probes\n' >"$DCR_PROOF/baseline-on-verified.txt"
```

```sh
# step: dcr-oauth-close
# readonly: no
# host: box root /bin/bash; ONLY final success or verified baseline recovery
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      dcr-oauth-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_FAILURE_PHASE=DEPLOY_FAILED

. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(hm37_baseline_mode)" = on
if test "$(readlink -f /home/commonswarm/oauth/current)" = "$BASELINE_OAUTH_DIR"; then
 dcr_run_step dcr-baseline-verify
else
 test "$(readlink -f /home/commonswarm/oauth/current)" = "$OAUTH_RELEASE_DIR"
 test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$(cat "$PROOF_DIR/oauth-image.id")"
 test -f "$DCR_PROOF/oauth-verified.txt" && test -f "$DCR_PROOF/public-verified.txt"
 test -f "$DCR_PROOF/final-readback-verified.txt"
 cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$DCR_PROOF/mcp-candidate.caddy"
 (cd "$DCR_PROOF" && sha256sum -c apex-before.sha256 >/dev/null)
 MCP_EXPECTED_MODE=on mcp_route_probes
 oauth_memory_gate
fi
RELEASE_FAILURE_PHASE=CLOSE_FAILED
RELEASE_LIVE_STATE="ON source=$(readlink -f /home/commonswarm/oauth/current); verified-at-close"
printf 'ON source/image/probes verified immediately before snapshot close\n' >"$DCR_PROOF/close-on-verified.txt"
DCR_CLOSE_VERIFIED=yes
HM37_STEP=hm37-oauth-close
dcr_run_step dcr-oauth-reference
```

Cleanup is available beyond forward deadlines. Retain proofs, ledger/catalog
receipts, exact Caddy saved bytes/checksums, immutable source/images and
status-only JSON. Never remove a release directory.

```sh
# step: dcr-check-cleanup
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      dcr-check-cleanup "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_LIVE_STATE="last-verified-ON; see retained verification receipt"

trap 'echo "FAIL dcr-check-cleanup: line $LINENO; report exact path/error; STOP" >&2' ERR
. "/home/commonswarm/oauth/dcr-preflights/${1:?}-${2:?}/state.sh"
test "$(id -u)" = 0
test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
if test -f "$PROOF_DIR/closed.txt"; then echo 'dcr-check-cleanup: already closed'; exit 0; fi
# Before OAuth open no service was changed; afterward OAuth close must prove ON first.
if test -f "/home/commonswarm/oauth/release-proofs/$RELEASE_SHA/open-ready.txt"; then
 test -f "$PROOF_DIR/oauth-closed.txt" && test -f "$PROOF_DIR/close-on-verified.txt"
fi
CLOSE_READBACK_FAILED=0
if test -f "$PROOF_DIR/session-ready.txt"; then
 . "$DB_SESSION"
 if ! release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/closed-ledger.txt"; then
  CLOSE_READBACK_FAILED=1
  printf 'FAIL dcr-check-cleanup: ledger readback failed; continue exact secret cleanup\n' >&2
 fi
fi
if test -n "${SECRET_STAGE:-}" && test -d "$SECRET_STAGE"; then
 python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied), 'FAIL dcr-check-cleanup: deletion boundary control'
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
 rm -rf -- "$SECRET_STAGE" || { printf 'FAIL dcr-check-cleanup: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
 test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
fi
if test -n "${SECRET_STAGE:-}"; then test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"; fi
test "$DCR_BOX_ARCHIVE_PATH" = /tmp/dcr-release-${RELEASE_SHA}-${DCR_WINDOW_ID}.tar
test ! -L "$DCR_BOX_ARCHIVE_PATH"
rm -f -- "$DCR_BOX_ARCHIVE_PATH" || { printf 'FAIL dcr-check-cleanup: cleanup refused %s; STOP\n' "$DCR_BOX_ARCHIVE_PATH" >&2; exit 1; }
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/closed.txt"
printf 'Closed read-only preflight staging; retain nonsecret evidence %s\n' "$PROOF_DIR"
test "$CLOSE_READBACK_FAILED" = 0
```

```sh
# step: dcr-mac-close
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      dcr-mac-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_LIVE_STATE="last-verified-ON; see retained verification receipt"

trap 'echo "FAIL dcr-mac-close: report exact guarded path/error; STOP" >&2' ERR
: "${DCR_ARCHIVE_DIR:?}"
python3 - "$DCR_ARCHIVE_DIR" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/dcr-release-archive\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/dcr-release-archive.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
PYCODE
rm -rf -- "$DCR_ARCHIVE_DIR" || { printf 'FAIL dcr-mac-close: guarded cleanup refused %s; STOP\n' "$DCR_ARCHIVE_DIR" >&2; exit 1; }
```

```sh
# step: dcr-stage-abort
# readonly: no
# host: box root /bin/bash 5.2; failed staging before state exists only
set -euo pipefail
trap 'echo "FAIL dcr-stage-abort: report exact path/error; STOP" >&2' ERR
RELEASE_SHA=${1:?}; DCR_WINDOW_ID=${2:?}; DCR_BOX_ARCHIVE_PATH=${3:?}; DCR_ARCHIVE_SHA256=${4:?}
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
python3 - "$RELEASE_SHA" "$DCR_WINDOW_ID" "$DCR_BOX_ARCHIVE_PATH" "$DCR_ARCHIVE_SHA256" <<'PYCODE'
import pathlib,re,sys
s,w,a,h=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and re.fullmatch('[A-Za-z0-9]{6}',w)
assert a==f'/tmp/dcr-release-{s}-{w}.tar' and re.fullmatch('[0-9a-f]{64}',h)
p=pathlib.Path(a); assert p.resolve(strict=True)==p and not p.is_symlink() and p.is_file() and p.stat().st_mode & 0o777==0o600
assert not pathlib.Path(f'/home/commonswarm/oauth/dcr-preflights/{s}-{w}/state.sh').exists()
PYCODE
test "$(sha256sum "$DCR_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$DCR_ARCHIVE_SHA256"
rm -f -- "$DCR_BOX_ARCHIVE_PATH" || { printf 'FAIL dcr-stage-abort: cleanup refused %s; STOP\n' "$DCR_BOX_ARCHIVE_PATH" >&2; exit 1; }
```

```sh
# step: dcr-secret-abort
# readonly: no (exact failed-session/open path only)
# host: box root /bin/bash
set -euo pipefail
: "${SECRET_STAGE:?exact reported path required}"
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm &&
  test -x /usr/bin/rm && test ! -L /usr/bin/rm &&
  test ! -e /usr/local/bin/rm && test ! -L /usr/local/bin/rm &&
  test ! -e /usr/local/sbin/rm && test ! -L /usr/local/sbin/rm
# A completed OAuth open must use the gated close; partial open needs baseline ON proof.
if test -n "${OAUTH_RELEASE_SHA:-}" && test -n "${DCR_PROOF:-}"; then
 test ! -f "/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA/open-ready.txt"
 test "$(hm37_baseline_mode)" = on
 test "$(readlink -f /home/commonswarm/oauth/current)" = "/home/commonswarm/oauth/releases/$EXPECTED_OAUTH_SHA"
 test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$EXPECTED_OAUTH_IMAGE_DIGEST"
 MCP_EXPECTED_MODE=on mcp_route_probes
fi
python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
rm -rf -- "$SECRET_STAGE" || { printf 'FAIL: cleanup refused %s; retain/report exact message\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
```

## Static checks and acceptance limits

Use existing runbookShellBlocks extraction from tests/release-proof-format.test.ts
on every marked/referenced block; run /bin/bash -n. Compile and scan every
embedded Python program, including helper heredocs, with missing-import positive
control. Run release-proof-format. DCR tests live in test/authorize-state.test.js,
not registration*.test.js: filter DCR/discovery/routed userinfo. No site observers.

Offline checks cannot prove the applied ledger/catalog, live Caddy equality,
Cloudflare routes, health/memory or outage length. These remain live gates.
Build inside OFF can exceed 180s forward deadline (60s reserved for recovery).
Timeout stops forward work and requires baseline recovery; never kill recovery
to meet budget. >240s is recorded as failed even if ON returns. HezLead owns
independent family review, final exact-SHA evidence, production approval and retest.


Preparation checks on this V2 file: 27 marked + 11 referenced blocks passed
Bash 3.2 syntax; 32 embedded Python programs passed compile/global-name scan,
including indented helper heredocs and inline Python. The missing-sys-import
control was caught and its imported control passed. Marker/run-order/failure
reconciliation passed. The exact embedded Caddy renderer/gate passed against
LIVE + rendered repo; a copy with an extra /unexpected token STOPPED, and a
copy with /authorize/* added to POST also STOPPED. No Caddy installation or
reload was executed. release-proof-format passed 8/8; focused OAuth DCR,
discovery and routed-userinfo tests passed 14/14. These preparation results do
not replace the required GATE_EVIDENCE_FILE for the final landed RELEASE_SHA.

```release-contract
{
  "version": 1,
  "release_input": "RELEASE_SHA",
  "inputs": {"DCR_PLAN_FILE": {"format": "abs-file"}, "DCR_REVIEWED_CODE_SHA": {"format": "sha40"}, "EXPECTED_EDGE_SHA": {"format": "sha40"}, "EXPECTED_OAUTH_IMAGE_DIGEST": {"format": "digest"}, "EXPECTED_OAUTH_SHA": {"format": "sha40"}, "EXPECTED_SCHEMA_MIGRATIONS": {"format": "schema-set"}, "GATE_EVIDENCE_FILE": {"format": "abs-file"}, "OAUTH_PLAN_FILE": {"format": "abs-file"}, "RELEASE_SHA": {"format": "sha40"}, "TOM_ENABLE_APPROVAL": {"format": "literal:2026-09-29"}, "WINDOW_END_UTC": {"format": "utc-window"}},
  "repo_paths": ["deploy/edge-runtime/compose.override.yaml", "deploy/edge-runtime/compose.yaml", "deploy/mcp-auth", "deploy/mcp-auth/compose.management.yaml", "deploy/mcp-auth/compose.yaml", "deploy/release-proofs/oauth-dcr", "deploy/release-proofs/oauth-dcr/20261002000001-catalog.sql", "deploy/release-proofs/oauth-dcr/20261002000001-rollback-catalog.sql", "deploy/supabase-stack/commonswarm-mcp.caddy", "deploy/supabase-stack/migrate/lib.sh", "deploy/supabase-stack/migrate/make-pg-service.mjs", "docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md", "scripts/release-preflight.py", "services/mcp-auth", "services/mcp-auth/Dockerfile", "supabase/functions", "supabase/migrations"],
  "runtime_paths": ["services/schema", "src/management-command.generated.js"],
  "input_files": ["$DCR_PLAN_FILE", "$OAUTH_PLAN_FILE", "$GATE_EVIDENCE_FILE"],
  "routes": {"normal": ["dcr-release-shared-preflight", "dcr-plan-inputs", "dcr-archive", "dcr-stage", "dcr-session", "dcr-preflight", "dcr-oauth-inputs", "dcr-oauth-baseline-state", "oauth:hm37-oauth-archive", "dcr-oauth-preflight", "dcr-oauth-open", "dcr-public-helper", "oauth:hm37-mcp-transition-off", "oauth:hm37-mcp-route-probes", "oauth:hm37-oauth-build", "oauth:hm37-oauth-inputs", "oauth:hm37-oauth-release-off", "oauth:hm37-mcp-route-probes", "dcr-caddy-apply", "dcr-caddy-probes", "dcr-oauth-enable", "oauth:hm37-mcp-route-probes", "dcr-oauth-verify", "dcr-public-probes", "dcr-final-readback", "dcr-oauth-close", "dcr-check-cleanup", "oauth:hm37-oauth-mac-close", "dcr-mac-close"], "recovery": ["dcr-release-shared-preflight", "dcr-plan-inputs", "dcr-archive", "dcr-stage", "dcr-session", "dcr-preflight", "dcr-oauth-inputs", "dcr-oauth-baseline-state", "oauth:hm37-oauth-archive", "dcr-oauth-preflight", "dcr-oauth-open", "dcr-public-helper", "oauth:hm37-mcp-transition-off", "oauth:hm37-mcp-route-probes", "oauth:hm37-oauth-build", "oauth:hm37-oauth-inputs", "oauth:hm37-oauth-release-off", "oauth:hm37-mcp-route-probes", "dcr-caddy-apply", "dcr-caddy-probes", "dcr-oauth-enable", "oauth:hm37-mcp-route-probes", "dcr-oauth-verify", "dcr-public-probes", "dcr-final-readback", "dcr-caddy-rollback", "dcr-recover-baseline", "dcr-baseline-verify", "dcr-oauth-close", "dcr-check-cleanup", "oauth:hm37-oauth-mac-close", "dcr-mac-close"]},
  "steps": {
    "dcr-release-shared-preflight": {"reads": [], "sha256": "f1e88d8c9c27b0a6c6a1c98681df79ae9f5b0de01c3952fa47767eacfd7ed634"},
    "dcr-plan-inputs": {"reads": [], "sha256": "e138b9e56587149131f3f159c00eb3643ff41f4d9fa80c42926a816aa3392c0f"},
    "dcr-archive": {"creates": ["$DCR_ARCHIVE_DIR", "$DCR_ARCHIVE_DIR/release.tar", "$DCR_BOX_ARCHIVE_PATH", "DCR_ARCHIVE_DIR", "DCR_BOX_ARCHIVE_PATH"], "reads": ["endpoint:https://github.com/yulanventures/commonswarm.git"], "sha256": "9a1f9d32cfc3fef5ccae2919b727f80b4891d04e3554cb42e528531d0accfb90"},
    "dcr-transport": {"creates": ["$DCR_ARCHIVE_DIR/box-step.sh"], "reads": [], "sha256": "a38faa3b29ba4f9605bca48ba8cfa08d68cd34a9e01601373dd99740eff06d9a"},
    "dcr-stage": {"creates": ["$DCR_PROOF/source", "$DCR_PROOF/state.sh"], "reads": ["/home/commonswarm/oauth/dcr-preflights/"], "sha256": "6df530923a7f10448c41f16fa09555343817326e55fd54c7b544b4151dfc5f69"},
    "dcr-session": {"consumes": ["$DCR_PROOF/state.sh"], "creates": ["$DCR_PROOF/identity.sql", "$DCR_PROOF/readback.sql", "$DCR_PROOF/session-ready.txt", "$DCR_SECRET_STAGE/pass", "$DCR_SECRET_STAGE/service.conf", "$DCR_SECRET_STAGE/session.sh", "$SECRET_STAGE", "DCR_SECRET_STAGE"], "reads": ["/etc/commonswarm-release/target.env", "/etc/ssl/yulan-internal-ca.pem", "/home/commonswarm/.env", "/home/commonswarm/oauth/dcr-preflights/", "command:docker image inspect", "command:docker inspect", "command:release_psql_ro"], "sha256": "89491df62e7f7aeabb94314026cff56225c0783a937bb3dabdb28511fa619bed"},
    "dcr-preflight": {"consumes": ["$DCR_PROOF/identity.sql", "$DCR_PROOF/session-ready.txt"], "creates": ["$DCR_PROOF/applied-before.txt", "$DCR_PROOF/cron-before.txt", "$DCR_PROOF/preflight.txt"], "reads": ["/home/commonswarm/oauth/dcr-preflights/", "command:release_psql_ro"], "sha256": "a87b387382ea4f7fdef28b79277373c3607e1f4d18d9a1370c133bd9d6e33af1"},
    "dcr-oauth-inputs": {"reads": ["/home/commonswarm/edge/releases", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/releases", "/home/commonswarm/oauth/releases/", "command:docker inspect"], "sha256": "25d9b8fc7adc6911cafa656594e6a64e604aa17b9bf2283dc935b6831b58ff77"},
    "dcr-oauth-baseline-state": {"consumes": ["$DCR_PROOF/preflight.txt", "$DCR_PROOF/state.sh"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "/home/commonswarm/oauth/dcr-preflights/", "command:docker inspect", "command:release_psql_ro", "endpoint:http://127.0.0.1:3490", "endpoint:https://mcp.commonswarm.com", "endpoint:https://mcp.commonswarm.com/mcp"], "sha256": "a8b6b119a1f3c5663905254c08a6de0e8369417579a01de439c83513c201c596"},
    "dcr-oauth-reference": {"creates": ["$DCR_ARCHIVE_DIR/oauth-reference.sh", "$DCR_PROOF/oauth-reference.sh"], "reads": ["/home/commonswarm/oauth/release-proofs/", "command:release_psql_ro"], "sha256": "8de08a2ddb944efca4dfc636119aebb78eb0ce50c1ecc29a2ada916c9f6db61f"},
    "dcr-oauth-preflight": {"reads": ["/etc/caddy", "/etc/caddy/Caddyfile", "/etc/caddy/sites/*.caddy", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/cookie-keys", "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env", "/etc/commonswarm-oauth/signing-keys.pem", "/etc/ssl/yulan-internal-ca.pem", "/home/commonswarm/.env", "command:docker inspect"], "sha256": "11ff589d818f28b7ed942bb6194a9b7cd9e70abad8b9e403b2caac4423bd42cd"},
    "dcr-oauth-open": {"cleanup": ["BOX_ARCHIVE_PATH"], "cleanup_owners": {"$BOX_ARCHIVE_PATH": "oauth:hm37-oauth-archive", "/etc/commonswarm-oauth/management-database-credentials": "dcr-oauth-enable"}, "creates": ["$DCR_PROOF/apex-before.sha256", "$DCR_PROOF/marked-", "$DCR_PROOF/mcp-before.caddy", "$DCR_PROOF/mcp-before.sha256", "$DCR_PROOF/mcp-candidate.caddy", "$OAUTH_PROOF_DIR/baseline-mcp-mode", "$OAUTH_PROOF_DIR/dcr-enable-helper.sh", "$OAUTH_PROOF_DIR/hm37-window.sh", "$OAUTH_PROOF_DIR/oauth-base-references.txt", "$OAUTH_PROOF_DIR/oauth-memory-limit.bytes", "$OAUTH_PROOF_DIR/oauth-stats.json", "$OAUTH_PROOF_DIR/open-ready.txt", "$OAUTH_PROOF_DIR/release.tar", "$OAUTH_PROOF_DIR/secret-stage.path", "$OAUTH_SECRET_STAGE/compose.baseline.off.env", "$OAUTH_SECRET_STAGE/compose.env", "$OAUTH_SECRET_STAGE/edge.env", "$OAUTH_SECRET_STAGE/edge.off.env", "$OAUTH_SECRET_STAGE/management.baseline", "$OAUTH_SECRET_STAGE/mcp.caddy", "$OAUTH_SECRET_STAGE/service.env", "$OAUTH_SECRET_STAGE/service.off.env", "OAUTH_SECRET_STAGE"], "reads": ["/etc/caddy", "/etc/caddy/Caddyfile", "/etc/caddy/sites/*.caddy", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "/home/commonswarm/oauth/releases", "/home/commonswarm/oauth/releases/", "command:docker compose", "command:docker image inspect", "command:docker inspect", "command:docker stats", "command:readlink -f"], "sha256": "98342a7112833dfc40ac3f4cb5dec8135650d0a79b4df3396bf3a61799447571"},
    "dcr-oauth-enable": {"consumes": ["$DCR_PROOF/caddy-applied.txt", "$DCR_PROOF/caddy-off-verified.txt", "$DCR_PROOF/mcp-candidate.caddy", "$DCR_PROOF/state.sh", "$OAUTH_PROOF_DIR/dcr-enable-helper.sh", "$OAUTH_PROOF_DIR/mcp-503-start.epoch", "$OAUTH_PROOF_DIR/oauth-image.id", "$OAUTH_SECRET_STAGE/edge.off.env", "$OAUTH_SECRET_STAGE/service.off.env"], "creates": ["$OAUTH_SECRET_STAGE/edge.on.env", "$OAUTH_SECRET_STAGE/management-database-credentials", "$OAUTH_SECRET_STAGE/service.on.env", "/etc/commonswarm-oauth/management-database-credentials"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/etc/ssl/yulan-internal-ca.pem", "/home/commonswarm/.env", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect", "command:release_psql_ro"], "sha256": "3cb32074683e81caa9e664e45a2c5f65143fdc3214829cd746725c5ee794b4c1"},
    "dcr-oauth-verify": {"consumes": ["$DCR_PROOF/mcp-candidate.caddy"], "creates": ["$DCR_PROOF/oauth-verified.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/oauth/release-proofs/"], "sha256": "d1e5fc06065ff009c2b90b215ae1f0e5ee962cf77cc899268a2855c86f3fe70f"},
    "dcr-public-helper": {"creates": ["$DCR_PROOF/public-helper.sh"], "reads": ["endpoint:http://127.0.0.1:3490", "endpoint:https://dcr-release-probe.invalid/callback", "endpoint:https://mcp.commonswarm.com", "endpoint:https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp"], "sha256": "0a84d980fc315d1748bb9791a519af443f9de7b118f6d4d3e72ad7bb119793a6"},
    "dcr-caddy-apply": {"consumes": ["$DCR_PROOF/mcp-before.caddy", "$DCR_PROOF/mcp-candidate.caddy", "$DCR_PROOF/public-helper.sh", "$OAUTH_PROOF_DIR/mcp-503-start.epoch"], "creates": ["$DCR_PROOF/caddy-applied.txt", "$DCR_PROOF/caddy-forward.sh", "$DCR_PROOF/mcp-after.sha256"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/oauth/release-proofs/"], "sha256": "9ba0e58c5d870dbb2a8698c3f14b17e9bb0675f49d9911ad69392fb530858a3b"},
    "dcr-caddy-probes": {"consumes": ["$DCR_PROOF/public-helper.sh"], "creates": ["$DCR_PROOF/caddy-off-verified.txt"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "dfbadd5d36051e82936c9109f177d6e6c29d561bd444095de2a76ffc05dfd80a"},
    "dcr-caddy-rollback": {"creates": ["$DCR_PROOF/caddy-rollback-reloaded.txt"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/oauth/release-proofs/"], "sha256": "5bb4bb5bb33a4dd846891c7cc94eff509f2f69b3a5649137a9c7cc3d5bc7a04a"},
    "dcr-public-probes": {"consumes": ["$DCR_PROOF/caddy-applied.txt", "$DCR_PROOF/oauth-verified.txt", "$DCR_PROOF/public-helper.sh"], "creates": ["$DCR_PROOF/public-dcr.json", "$DCR_PROOF/public-verified.txt"], "reads": [], "sha256": "0cea9e69d01037a7a473f3e86f17469ba8a38163b1ce3edfb317e86fa6424c6f"},
    "dcr-final-readback": {"consumes": ["$DCR_PROOF/applied-before.txt", "$DCR_PROOF/cron-before.txt", "$DCR_PROOF/identity.sql", "$DCR_PROOF/public-verified.txt", "$DCR_PROOF/session-ready.txt"], "creates": ["$DCR_PROOF/closed-ledger.txt", "$DCR_PROOF/cron-final.txt", "$DCR_PROOF/final-readback-verified.txt"], "reads": ["/home/commonswarm/oauth/dcr-preflights/", "command:release_psql_ro"], "sha256": "8e38a3f64a8f22a9d85591af9bb3a419e05475705c9583f1b2439eed22254ce2"},
    "dcr-caddy-failure": {"reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "9e56f3a699901138c6da2abf69d889339837b391066a9bf5f03e02e85adfa8b3"},
    "dcr-public-failure": {"reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "57becf0a39c04933224d47d71e76f8e0ef611fae992999361038f3f1e34d7d0f"},
    "dcr-recover-baseline": {"creates": ["$DCR_PROOF/recovery-result.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/oauth/release-proofs/"], "sha256": "cc491ec9e70dd21e345fb3baa69c89454746f480bec3910020993af9d8ae9e9c"},
    "dcr-baseline-verify": {"creates": ["$DCR_PROOF/baseline-on-verified.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect", "command:readlink -f"], "sha256": "5e80f21cf14121252f15bf6b4d70d63d8c466943b5fc6354497d3a69fcf2c39e"},
    "dcr-oauth-close": {"cleanup": ["OAUTH_SECRET_STAGE"], "consumes": ["$DCR_PROOF/final-readback-verified.txt", "$DCR_PROOF/mcp-candidate.caddy", "$DCR_PROOF/oauth-verified.txt", "$DCR_PROOF/public-verified.txt", "$OAUTH_PROOF_DIR/oauth-image.id"], "creates": ["$DCR_PROOF/close-on-verified.txt", "$DCR_PROOF/oauth-closed.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect", "command:readlink -f"], "sha256": "adc36057a477f5c5af31bbba68c4bb1a3bf5dda1630542bd77aeef9facabb1ce"},
    "dcr-check-cleanup": {"cleanup": ["DCR_BOX_ARCHIVE_PATH", "DCR_SECRET_STAGE"], "cleanup_owners": {"$DCR_BOX_ARCHIVE_PATH": "dcr-archive", "$SECRET_STAGE": "dcr-session"}, "consumes": ["$DCR_PROOF/close-on-verified.txt", "$DCR_PROOF/closed-ledger.txt", "$DCR_PROOF/session-ready.txt"], "creates": ["$DCR_PROOF/closed.txt"], "reads": ["/home/commonswarm/oauth/dcr-preflights/", "/home/commonswarm/oauth/release-proofs/", "command:release_psql_ro"], "sha256": "82e245f8e181f3bddec76058889fa70cca0f96e04fc49990a3ee4407cf339d99"},
    "dcr-mac-close": {"cleanup": ["DCR_ARCHIVE_DIR"], "cleanup_owners": {"$DCR_ARCHIVE_DIR": "dcr-archive"}, "reads": [], "sha256": "57ca2675cfafa2b87001da15556d669c7da7a1607cc350c68c390e2485793568"},
    "dcr-stage-abort": {"cleanup_owners": {"$DCR_BOX_ARCHIVE_PATH": "dcr-archive"}, "reads": ["/home/commonswarm/oauth/dcr-preflights/"], "sha256": "a16d411c337c22407180de2b47f69fb3be1d3e06c2b9a2c69ab6750167e815fd"},
    "dcr-secret-abort": {"cleanup_owners": {"$SECRET_STAGE": "dcr-session"}, "reads": ["/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "/home/commonswarm/oauth/releases/", "command:docker inspect", "command:readlink -f"], "sha256": "5b27a86bb8b23375ab4d9c7809eda684b719df85411517058cd1ff87234e5c8c"},
    "oauth:hm37-mcp-route-probes": {"creates": ["$OAUTH_PROOF_DIR/mcp-503-receipt.txt"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "75d3a60a70bb245804e2524cd118dbf6e643cd4f4526fc0ea76f55cbe768f24f"},
    "oauth:hm37-mcp-transition-off": {"creates": ["$OAUTH_PROOF_DIR/mcp-503-start.epoch", "$OAUTH_PROOF_DIR/mcp-503-start.utc"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "01e4454c92e62f408991396aee4342bb8a93a7698c96665654bb6bdd258a320b"},
    "oauth:hm37-oauth-archive": {"creates": ["$ARCHIVE_DIR", "$BOX_ARCHIVE_PATH", "ARCHIVE_DIR", "BOX_ARCHIVE_PATH"], "reads": [], "sha256": "386c92f13c8cb795343d0731cf0e670f651e8ecda02a191f12e09425962486e9"},
    "oauth:hm37-oauth-build": {"consumes": ["$OAUTH_PROOF_DIR/oauth-base-references.txt"], "creates": ["$OAUTH_PROOF_DIR/oauth-image.id"], "reads": ["/home/commonswarm/oauth/release-proofs/", "command:docker image inspect"], "sha256": "96819761d3286f5f355afb527abf9f3b55d1d89569f47c61a4038b356a9f80f1"},
    "oauth:hm37-oauth-inputs": {"consumes": ["$OAUTH_PROOF_DIR/oauth-image.id", "$OAUTH_SECRET_STAGE/service.off.env"], "creates": ["$OAUTH_SECRET_STAGE/compose.off.env"], "reads": ["/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/oauth/release-proofs/"], "sha256": "bd6c1a75477f20170dbeba6191a8d63a8897bc6ef1242c9868ed18d73cf70f70"},
    "oauth:hm37-oauth-mac-close": {"cleanup": ["ARCHIVE_DIR"], "cleanup_owners": {"$ARCHIVE_DIR": "oauth:hm37-oauth-archive"}, "reads": [], "sha256": "ae9464ad1b84cb9430c3a2d1ce7f101804874a5a6428e1afc7a948404103187e"},
    "oauth:hm37-oauth-release-off": {"consumes": ["$OAUTH_PROOF_DIR/oauth-image.id"], "reads": ["/etc/commonswarm-oauth/management-database-credentials", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect"], "sha256": "a6b9e18ce3481d3c667cb6dc0d293d75a8c1e103421dc6222ec54ea3c7150e08"}
  },
  "references": {"oauth:hm37-mcp-route-probes": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-mcp-route-probes"}, "oauth:hm37-mcp-transition-off": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-mcp-transition-off"}, "oauth:hm37-oauth-archive": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-oauth-archive"}, "oauth:hm37-oauth-build": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-oauth-build"}, "oauth:hm37-oauth-inputs": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-oauth-inputs"}, "oauth:hm37-oauth-mac-close": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-oauth-mac-close"}, "oauth:hm37-oauth-release-off": {"plan": "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "step": "hm37-oauth-release-off"}},
  "gate_receipts": [{"gates": ["DCR release shell/Python", "release-proof-format", "OAuth DCR tests"], "input": "GATE_EVIDENCE_FILE"}],
  "plan_input": "DCR_PLAN_FILE"
}
```
