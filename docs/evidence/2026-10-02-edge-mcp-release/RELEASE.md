# Edge-only release from the MCP ON baseline
Mac blocks must not call setuid/setgid tools.

Box image-build rule: `nice -n 15` plus a hard three-CPU cap, using
`systemd-run --scope -p CPUQuota=300%` around the build workers or a supported
builder quota. Build once per `RELEASE_SHA`, look up a persistent SHA tag,
build only if absent, and verify the image's recorded source SHA before reuse;
unsupported caps or mismatched SHA labels are STOP. See the shared preamble in
[RELEASE-TO-BOX.md](../../../deploy/RELEASE-TO-BOX.md). This edge plan reuses its
pinned runtime image and contains no image-build step.

**Option (b): prepared, not executed.** HezLead supplies the reviewed, landed
edge SHA and separately authorizes execution. This worker has made no live
measurements. HezLead supplies `EXPECTED_EDGE_SHA` as the full running edge
identity. Historical handoff sources were OAuth `00e89738`, app/stack
`ad964ed1` and site `603a206e`; they are evidence only. HezLead supplies the
current full expected OAuth source/image, stack and site inputs. Preflight
requires those identities and MCP ON, then refuses drift throughout the window.

The generic procedure is insufficient as an ON-state plan: its env gate checks
`SWARM_SELF_SERVE` and reports optional names, but does not require effective
MCP ON (`deploy/RELEASE-TO-BOX.md:2246`); its probes require additional
lead-supplied commands (`deploy/RELEASE-TO-BOX.md:2381`). Window A explicitly
forbids enabling MCP (`docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md:40`),
and B requires A's DARK close
(`docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md:4`). They cannot be reused
unchanged for this release.

This plan uses a **recorded, temporary Caddy 503 boundary** during recreation.
Both public env flags remain 1 throughout. It restores the original MCP site
byte-for-byte before ON probes; it never changes OAuth, stack, site, schema,
credentials, image pins, or the main Caddyfile. This avoids claiming continuous
availability during a single-container replacement. The ON-baseline pattern
records start before mutation and end after ON verification
(`docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md:722`, `:869`, `:918`);
here only the resource ingress is temporarily dark, with discovery still ON.

Edge releases and current are under `/home/commonswarm/edge`
(`AGENTS.md:205`). The exact-release mounts, 2 GiB override and network must
survive recreation (`deploy/RELEASE-TO-BOX.md:2148`, `:2231`, `:2349`;
`AGENTS.md:209`). Compose loads the same canonical `/home/commonswarm/.env`
for the new release (`deploy/edge-runtime/compose.yaml:38`), rather than
creating a persistent second secret env file. A fresh protected snapshot is
byte-compared before every recreation and after verification. Compose's
resolved environment, including image defaults, is compared by per-key
digest against docker inspect; only differing key names are reported.
Preflight derives the project and network from live Compose labels/inspect,
and the service env_file from the baseline render with both label-listed
files. It captures safe fingerprints, then renders the archive with that
baseline override before open, using the existing live working_dir for the
in-memory preview. Stage verifies the actual relocated mount paths in the
new directory. Stage/apply/rollback use those same inputs. Every Compose
config/up receives `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`, derived
from live inspect; preflight stops if the live network differs. The `bridge`
default stays because `tests/p1-cli/edge-runtime-box.test.ts` pins it.
The repository now carries the recorded box override with `mem_limit: 2g`.
Older release trees (including `65a6caf0`) lack it: stage copies the live
bytes into them. If a release tree contains the override, preflight and stage
require a regular file byte-equal to live before accepting it; a mismatch
reports the path and differing SHA-256 digests and stops. Rollback retains
the baseline override without rewriting it.
Every rendered service field must match the captured baseline; live image
id, complete env key/value digests, networks, memory, restart policy, ports
and mounts must also match. Only release-prefixed bind sources and the
working_dir/config_files labels change. Compose-generated config-hash is a
derived label, verified through the normalized rendered fields rather than
compared literally across different release paths.

Run only the marked blocks extracted by step ID. Keep one Mac Bash 3.2 shell
for archive/transport/cleanup. Run preflight/open in the same approved box root
Bash invocation; later blocks reload state in fresh root invocations. Never put
a heredoc inside command substitution. Do not print raw env,
Compose config, docker inspect, response bodies or container logs. No op call
is needed: existing box inputs suffice. Any future credential recovery is a
separate assignment using the 1Password service-account token file and fresh
protected staging. Never use keychain, GUI apps, Actions, or change HOME.
Prerequisites: Mac Python 3 and Bash 3.2; box Python 3.12 or newer (tar data
filter), GNU coreutils, Docker Compose JSON config support and noninteractive
root access. HezLead supplies exact-SHA gate evidence before authorizing a
window; this preparation checks syntax only and is not a live rehearsal.

| Input | Format | Source / use |
| --- | --- | --- |
| `RELEASE_SHA` | Full 40 lowercase hex; differs from baseline | HezLead's independently reviewed fix already landed on origin/main, with exact-SHA edge gates from §1 (`deploy/RELEASE-TO-BOX.md:149`). |
| `EXPECTED_EDGE_SHA` | Full 40 lowercase hex | HezLead's running edge identity; preflight checks current, RELEASE_SHA and container mounts. |
| `EXPECTED_OAUTH_SHA` | Full 40 lowercase hex | HezLead measured baseline; exact preflight comparison, no defaults. |
| `EXPECTED_OAUTH_IMAGE_DIGEST` | sha256: plus 64 lowercase hex | HezLead measured baseline; exact preflight comparison, no defaults. |
| `EXPECTED_SITE_SHA` | Full 40 lowercase hex | HezLead measured baseline; exact preflight comparison, no defaults. |
| `EXPECTED_STACK_SHA` | Full 40 lowercase hex | HezLead measured baseline; exact preflight comparison, no defaults. |
| `WINDOW_END_UTC` | `YYYY-MM-DDTHH:MM:SSZ`, future and at most 30 minutes away at preflight | HezLead's approved window end, checked on box clock. |
| `MAX_MCP_OUTAGE_SECONDS` | Positive decimal, 1..600 | HezLead's approved maximum; checked in the final 503 receipt, including rollback. Exceeding it is FAIL even if ON was restored. |
| `PLAN_FILE` | Absolute file containing this independently reviewed plan | Mac operator; transport extracts exactly one marked sh block. |
| `ARCHIVE_DIR`, `WINDOW_ID` | Fresh `/private/tmp/hm37-edge-archive.XXXXXX`; six alphanumerics | Archive step derives them; retain for Mac cleanup. |
| `BOX_ARCHIVE_PATH` | `/tmp/hm37-edge-<RELEASE_SHA>-<WINDOW_ID>.tar` | Archive step creates/uploads mode 0600 with no overwrite. |
| `EDGE_ARCHIVE_SHA256` | 64 lowercase hex | Archive step's SHA-256 output, passed to box preflight. |
| `BOX_STEP` | One box step ID in the order below | Operator chooses the exact block for transport; no prose-generated commands. |
| `SECRET_STAGE` for open-abort only | Exact `/private/tmp/anvil-secret.XXXXXX` path reported by failed open | Pass as input 8 through transport; a path is nonsecret. If open failed before creation, there is no secret cleanup step. |
| `PREVIOUS_EDGE`, `NEW_EDGE`, `PROOF_DIR`, `SECRET_STAGE` | Validated canonical paths | Box derives previous from current and full baseline SHA; new from RELEASE_SHA; proofs per SHA/window; secret stage from mktemp. Never guessed or taken from an old window. |
| Network / flags / override / timer | `commonswarm-net`; both public flags `1`; 2 GiB; six-hour timer active | Measured by preflight; no flag input can turn MCP OFF. |

Normal order: `edge-mcp-plan-inputs`, `edge-mcp-archive`, `edge-mcp-preflight`, `edge-mcp-open`,
`edge-mcp-stage`, `edge-mcp-transition-503`, `edge-mcp-apply`,
`edge-mcp-restore-on`, `edge-mcp-probes`, `edge-mcp-close`,
`edge-mcp-mac-close`. Use `edge-mcp-transport` for each box block if needed.
Use transport for preflight/open: it resolves the box site prefix to the unique
full `MEASURED_SITE_SHA` (produced evidence, never a prompt input). The box
preflight requires exact full equality and rechecks the current release name.
The transport combines preflight/open and supplies positional inputs to each
fresh root invocation. There is no release execution in this documentation task.

Failures before transition: stop forward work, run `edge-mcp-rollback` if open
completed, then close only after baseline ON probes. Deploy or required verification failures from transition
onward: immediately run `edge-mcp-rollback`, then `edge-mcp-probes`,
`edge-mcp-close`, `edge-mcp-mac-close`. Rollback failure means ongoing outage:
retain the start receipt and secret stage, restore the recycle timer with
`edge-mcp-timer-recover`, report exact FAIL, and stop. Do not claim a bounded
outage or close without verified ON. A partially failed open without state is
handled by `edge-mcp-open-abort`; no production mutation occurs during open.
The open failure trap prints only the exact staging path, allowing the marked
abort cleanup in a fresh shell with that path as input 8. No forward retry
after a failure without a new HezLead instruction. A closed
window is never reopened; archive creates a fresh window for a later attempt.
Existing release directories are compared, never extracted over or repaired.


## Shared preflight and closure decision

Run `edge-release-shared-preflight` **first**, before every existing run-order entry.
Start in the reviewed repository with `PLAN_FILE` set to this absolute plan
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
# step: edge-release-shared-preflight
# readonly: yes
# host: Mac /bin/bash 3.2; FIRST, before archive, box contact or window
set -euo pipefail
: "${RELEASE_INPUTS_JSON:?absolute nonsecret INPUTS JSON required}"
RELEASE_PREFLIGHT_TOOL="$(pwd -P)/scripts/release-preflight.py"
export RELEASE_PREFLIGHT_TOOL
python3 "$RELEASE_PREFLIGHT_TOOL" "${PLAN_FILE:?absolute reviewed plan required}" "$RELEASE_INPUTS_JSON" "$(pwd -P)"
# Export exactly the validated nonsecret fields; shlex.quote prevents shell code.
RELEASE_PREFLIGHT_EXPORTS=$(python3 -c 'import json,re,shlex,sys; p=json.load(open(sys.argv[1])); c=json.loads(re.search(r"^```release-contract\n(.*?)^```$",open(sys.argv[2]).read(),re.M|re.S)[1]); print("\n".join("export "+k+"="+shlex.quote(p[k]) for k in c["inputs"]))' "$RELEASE_INPUTS_JSON" "$PLAN_FILE")
eval "$RELEASE_PREFLIGHT_EXPORTS"
unset RELEASE_PREFLIGHT_EXPORTS
```

```sh
# step: edge-mcp-plan-inputs
# host: Mac /bin/bash 3.2; also extracted into box preflight/open
set -euo pipefail
edge_expected_baselines() {
python3 - "${1:-check}" "${EXPECTED_EDGE_SHA:-}" "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "${EXPECTED_SITE_SHA:-}" "${EXPECTED_STACK_SHA:-}" "${MEASURED_SITE_SHA:-}" <<'PYBASELINE'
import json,pathlib,re,subprocess,sys
mode=sys.argv[1]
assert mode in ('validate','check'), 'FAIL: baseline check mode; STOP'
fields=['EXPECTED_EDGE_SHA', 'EXPECTED_OAUTH_SHA', 'EXPECTED_OAUTH_IMAGE_DIGEST', 'EXPECTED_SITE_SHA', 'EXPECTED_STACK_SHA']
values=dict(zip(fields,sys.argv[2:2+len(fields)]))
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
if 'EXPECTED_STACK_SHA' in values: equal('EXPECTED_STACK_SHA',current('stack'))
if 'EXPECTED_SITE_SHA' in values:
    equal('EXPECTED_SITE_SHA',sys.argv[-1])
    p=pathlib.Path('/srv/commonswarm/site/current'); release=p.resolve(strict=True)
    assert p.is_symlink() and release.parent==pathlib.Path('/srv/commonswarm/site/releases'), 'FAIL: site current release path; STOP'
    match=re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}',release.name)
    # deploy/site/deploy.sh records only 12 hex; resolve it uniquely against the
    # Mac Git object database before box preflight (transport).
    prefix=match[1] if match else 'invalid site release name'
    if prefix!=values['EXPECTED_SITE_SHA'][:12]:
        raise SystemExit(f"FAIL: EXPECTED_SITE_SHA expected={values['EXPECTED_SITE_SHA']} observed={prefix}; STOP")
print('PASS: expected live baseline identities matched')
PYBASELINE
}
edge_expected_baselines validate
export EXPECTED_EDGE_SHA EXPECTED_OAUTH_SHA EXPECTED_OAUTH_IMAGE_DIGEST EXPECTED_SITE_SHA EXPECTED_STACK_SHA
```

```sh
# step: edge-mcp-archive
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL edge-mcp-archive: line $LINENO; STOP" >&2' ERR
: "${RELEASE_SHA:?}" "${EXPECTED_EDGE_SHA:?}" "${PLAN_FILE:?}"
case "$RELEASE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#RELEASE_SHA}" = 40
case "$EXPECTED_EDGE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#EXPECTED_EDGE_SHA}" = 40
test "$RELEASE_SHA" != "$EXPECTED_EDGE_SHA"
PLAN_GUARD_VALUE_1="$(git status --porcelain)"
test -z "${PLAN_GUARD_VALUE_1}"
git fetch origin main
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
git remote get-url origin | python3 -c 'import sys; s=sys.stdin.read().strip(); assert s in ("git@github.com:yulanventures/commonswarm.git", "https://github.com/yulanventures/commonswarm.git")'
ARCHIVE_DIR=$(mktemp -d /private/tmp/hm37-edge-archive.XXXXXX)
chmod 0700 "$ARCHIVE_DIR"
WINDOW_ID=${ARCHIVE_DIR##*.}
git archive --format=tar "$RELEASE_SHA" >"$ARCHIVE_DIR/release.tar"
chmod 0600 "$ARCHIVE_DIR/release.tar"
EDGE_ARCHIVE_SHA256=$(shasum -a 256 "$ARCHIVE_DIR/release.tar" | awk '{print $1}')
BOX_ARCHIVE_PATH=/tmp/hm37-edge-${RELEASE_SHA}-${WINDOW_ID}.tar
printf -v REMOTE_COMMAND 'test "$(stat -c %%a /tmp)" = 1777 && (set -C; umask 077; : > %q)' "$BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
scp -p "$ARCHIVE_DIR/release.tar" "ops@100.115.66.74:$BOX_ARCHIVE_PATH"
printf 'WINDOW_ID=%s\nBOX_ARCHIVE_PATH=%s\nEDGE_ARCHIVE_SHA256=%s\n' "$WINDOW_ID" "$BOX_ARCHIVE_PATH" "$EDGE_ARCHIVE_SHA256"
```

Transport opens a separate root shell for each block, so preflight/open must
be sent together once. Other blocks load their saved helpers/state. This
transport is the complete marked extraction/SSH command, with `%q` for every
nonsecret input. Reject unknown step IDs; the Mac archive remains public.

```sh
# step: edge-mcp-transport
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL edge-mcp-transport: line $LINENO; STOP" >&2' ERR
: "${BOX_STEP:?}" "${PLAN_FILE:?}" "${RELEASE_SHA:?}" "${WINDOW_ID:?}" "${ARCHIVE_DIR:?}"
python3 - "$ARCHIVE_DIR" "$WINDOW_ID" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/hm37-edge-archive\.[A-Za-z0-9]{6}',str(p))
assert str(p).rsplit('.',1)[1]==sys.argv[2]
assert not p.is_symlink() and p.resolve(strict=True)==p and p.is_dir()
assert p.stat().st_mode & 0o777==0o700
PY
if test "$BOX_STEP" = edge-mcp-preflight-open; then
  edge_expected_baselines validate
  : "${EXPECTED_SITE_SHA:?FAIL: EXPECTED_SITE_SHA missing; STOP}"
  MEASURED_SITE_RELEASE=$(ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 'readlink -f /srv/commonswarm/site/current')
  python3 - "$MEASURED_SITE_RELEASE" >"$ARCHIVE_DIR/site-prefix.txt" <<'PYSITE'
import pathlib,re,sys
p=pathlib.PurePosixPath(sys.argv[1])
assert p.parent==pathlib.PurePosixPath('/srv/commonswarm/site/releases'), 'FAIL: EXPECTED_SITE_SHA invalid release path; STOP'
match=re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}',p.name)
assert match, 'FAIL: EXPECTED_SITE_SHA invalid release name; STOP'
print(match[1])
PYSITE
  MEASURED_SITE_PREFIX=$(cat "$ARCHIVE_DIR/site-prefix.txt")
  MEASURED_SITE_SHA=$(git rev-parse --verify "${MEASURED_SITE_PREFIX}^{commit}") || { echo 'FAIL: EXPECTED_SITE_SHA source missing/ambiguous; STOP' >&2; exit 1; }
  if test "$MEASURED_SITE_SHA" != "$EXPECTED_SITE_SHA"; then
    printf 'FAIL: EXPECTED_SITE_SHA expected=%s observed=%s; STOP\n' "$EXPECTED_SITE_SHA" "$MEASURED_SITE_SHA" >&2
    exit 1
  fi
fi
case "$BOX_STEP" in
  edge-mcp-preflight-open|edge-mcp-stage|edge-mcp-transition-503|edge-mcp-apply|edge-mcp-restore-on|edge-mcp-probes|edge-mcp-rollback|edge-mcp-close|edge-mcp-timer-recover|edge-mcp-open-abort) ;;
  *) echo 'FAIL edge-mcp-transport: unknown box step; STOP' >&2; exit 1;;
esac
python3 - "$PLAN_FILE" "$BOX_STEP" >"$ARCHIVE_DIR/box-step.sh" <<'PY'
import pathlib,re,sys
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
steps=['edge-mcp-plan-inputs','edge-mcp-preflight','edge-mcp-open'] if sys.argv[2]=='edge-mcp-preflight-open' else [sys.argv[2]]
if sys.argv[2]=='edge-mcp-preflight-open':
    print('EXPECTED_EDGE_SHA=${3:?}; EXPECTED_OAUTH_SHA=${9:?}; EXPECTED_OAUTH_IMAGE_DIGEST=${10:?}; EXPECTED_SITE_SHA=${11:?}; EXPECTED_STACK_SHA=${12:?}; MEASURED_SITE_SHA=${13:?}')
for step in steps:
    found=[b for b in blocks if re.search(r'^# step: '+re.escape(step)+r'$',b,re.M)]
    assert len(found)==1, 'FAIL edge-mcp-transport: step missing or duplicated'
    print(found[0])
PY
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -s -- %q %q %q %q %q %q %q %q %q %q %q %q %q' \
  "$RELEASE_SHA" "$WINDOW_ID" "$EXPECTED_EDGE_SHA" "$BOX_ARCHIVE_PATH" \
  "$EDGE_ARCHIVE_SHA256" "$WINDOW_END_UTC" "$MAX_MCP_OUTAGE_SECONDS" "${SECRET_STAGE:-}" \
  "$EXPECTED_OAUTH_SHA" "$EXPECTED_OAUTH_IMAGE_DIGEST" "$EXPECTED_SITE_SHA" "$EXPECTED_STACK_SHA" "${MEASURED_SITE_SHA:-}"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND" <"$ARCHIVE_DIR/box-step.sh"
```

Preflight defines the helpers; open saves their literal definitions, containing
no secret values. The timer unit is checked against §6's schedule and restart
command (`deploy/RELEASE-TO-BOX.md:2154`). Stop it for this short window and
restore it before close, including rollback. Preflight itself is read-only.

```sh
# step: edge-mcp-preflight
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-preflight: line $LINENO; STOP before mutation" >&2' ERR
RELEASE_SHA=${1:?}; WINDOW_ID=${2:?}; EXPECTED_EDGE_SHA=${3:?}
BOX_ARCHIVE_PATH=${4:?}; EDGE_ARCHIVE_SHA256=${5:?}
WINDOW_END_UTC=${6:?}; MAX_MCP_OUTAGE_SECONDS=${7:?}
PLAN_GUARD_VALUE_2="$(id -u)"
test "${PLAN_GUARD_VALUE_2}" = 0
edge_expected_baselines check
python3 - "$RELEASE_SHA" "$WINDOW_ID" "$EXPECTED_EDGE_SHA" "$BOX_ARCHIVE_PATH" "$EDGE_ARCHIVE_SHA256" "$WINDOW_END_UTC" "$MAX_MCP_OUTAGE_SECONDS" <<'PY'
import datetime,pathlib,re,sys
s,w,b,a,h,end,budget=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and s!=b
assert re.fullmatch('[0-9a-f]{40}',b)
assert re.fullmatch('[A-Za-z0-9]{6}',w) and a==f'/tmp/hm37-edge-{s}-{w}.tar'
assert re.fullmatch('[0-9a-f]{64}',h)
assert re.fullmatch('[1-9][0-9]*',budget) and int(budget)<=600
assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',end)
until=datetime.datetime.strptime(end,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(until-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800
p=pathlib.Path(a); assert p.is_file() and not p.is_symlink() and p.stat().st_mode & 0o777==0o600
PY
PREVIOUS_EDGE=/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA
NEW_EDGE=/home/commonswarm/edge/releases/$RELEASE_SHA
PROOF_DIR=/home/commonswarm/edge/release-proofs/$RELEASE_SHA-$WINDOW_ID
PLAN_GUARD_VALUE_3="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_3}" = "$PREVIOUS_EDGE"
PLAN_GUARD_VALUE_4="$(cat "$PREVIOUS_EDGE/RELEASE_SHA")"
test "${PLAN_GUARD_VALUE_4}" = "$EXPECTED_EDGE_SHA"
PLAN_GUARD_VALUE_5="$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')"
test "${PLAN_GUARD_VALUE_5}" = "$EDGE_ARCHIVE_SHA256"
PLAN_GUARD_VALUE_6="$(command -v rm)"
test "${PLAN_GUARD_VALUE_6}" = /usr/bin/rm
test -x /usr/bin/rm
test ! -L /usr/bin/rm
systemctl is-active --quiet caddy
systemctl is-active --quiet commonswarm-edge-recycle.timer
PLAN_GUARD_VALUE_7="$(systemctl show -p ActiveState --value commonswarm-edge-recycle.service)"
test "${PLAN_GUARD_VALUE_7}" = inactive
systemctl cat commonswarm-edge-recycle.timer | python3 -c 'import sys; s=sys.stdin.read(); assert "OnCalendar=*-*-* 03,09,15,21:30:00 UTC" in s and "Persistent=false" in s'
systemctl cat commonswarm-edge-recycle.service | python3 -c 'import sys; s=sys.stdin.read(); assert "docker restart --time 30 commonswarm-edge-edge-runtime-1" in s'
edge_context() {
python3 - "$PREVIOUS_EDGE" <<'PY'
import json,os,pathlib,shlex,subprocess,sys
try:
    root=pathlib.Path(sys.argv[1]); work=root/'deploy/edge-runtime'
    live=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
    labels=live['Config']['Labels']; project=labels['com.docker.compose.project']
    assert labels['com.docker.compose.project.working_dir']==str(work)
    assert labels['com.docker.compose.project.config_files']==str(work/'compose.yaml')+','+str(work/'compose.override.yaml')
    assert labels['com.docker.compose.service']=='edge-runtime' and project=='commonswarm-edge'
    network=live['HostConfig']['NetworkMode']
    assert network=='commonswarm-net' and sorted(live['NetworkSettings']['Networks'])==[network]
    project_env=labels.get('com.docker.compose.project.environment_file','')
    assert not project_env or (',' not in project_env and pathlib.Path(project_env).is_absolute() and pathlib.Path(project_env).is_file())
    # Without an explicit interpolation env label, require no implicit .env.
    assert project_env or not (work/'.env').exists()
    process_env={k:v for k,v in os.environ.items() if not k.startswith(('COMPOSE_','COMMONSWARM_EDGE_'))}
    process_env['COMMONSWARM_EDGE_NETWORK_MODE']=network
    args=['docker','compose','--project-directory',str(work),'-p',project]
    if project_env: args+=['--env-file',project_env]
    args+=['-f',str(work/'compose.yaml'),'-f',str(work/'compose.override.yaml')]
    raw=json.loads(subprocess.check_output(args+['config','--no-env-resolution','--format','json'],cwd=work,env=process_env,stderr=subprocess.DEVNULL))
    files=raw['services']['edge-runtime']['env_file']
    assert len(files)==1
    env_file=files[0]['path'] if isinstance(files[0],dict) else files[0]
    assert env_file=='/home/commonswarm/.env'
    for key,value in [('EDGE_PROJECT',project),('EDGE_NETWORK',network),('EDGE_ENV_FILE',env_file),('EDGE_PROJECT_ENV_FILE',project_env)]:
        print(key+'='+shlex.quote(value))
except Exception: raise SystemExit('FAIL edge-mcp-config: differing fields compose.labels/project/env_file/network; STOP') from None
PY
}
EDGE_CONTEXT=$(edge_context)
eval "$EDGE_CONTEXT"
edge_compose() {
  edge_config_check compose "$@"
}
edge_config_check() {
local mode=${1:-config}
if test "$#" -gt 0; then shift; fi
test "$EDGE_NETWORK" = commonswarm-net
export COMMONSWARM_EDGE_NETWORK_MODE="$EDGE_NETWORK"
python3 - "$mode" "$EDGE_DIR" "$PREVIOUS_EDGE" "$NEW_EDGE" "$EDGE_PROJECT" "$EDGE_NETWORK" "$EDGE_ENV_FILE" "$EDGE_PROJECT_ENV_FILE" "${EDGE_BASELINE_FACTS:-}" "$BOX_ARCHIVE_PATH" "$@" <<'PY'
import copy,hashlib,json,os,pathlib,subprocess,sys,tarfile
mode,selected,previous,new,project,network,env_file,project_env,saved,archive=sys.argv[1:11]
command=sys.argv[11:]
def compose_env():
    # Retain HOME unchanged; prevent inherited Compose overrides in every mode.
    env={k:v for k,v in os.environ.items() if not k.startswith(('COMPOSE_','COMMONSWARM_EDGE_'))}
    env.update(COMMONSWARM_EDGE_NETWORK_MODE=network,COMMONSWARM_EDGE_ENV_FILE=env_file)
    return env
def compose_args(root):
    work=root+'/deploy/edge-runtime'
    args=['docker','compose','--project-directory',work,'-p',project]
    if project_env: args+=['--env-file',project_env]
    return args+['-f',work+'/compose.yaml','-f',work+'/compose.override.yaml']
def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def run(args,**kwargs):
    return json.loads(subprocess.check_output(args,stderr=subprocess.DEVNULL,**kwargs))
def image(pin): return run(['docker','image','inspect',pin])[0]
def env_hash(values): return {k:digest(str(v)) for k,v in values.items()}
def env_map(values):
    pairs=[v.split('=',1) for v in values or []]
    assert len(pairs)==len({k for k,v in pairs})
    return dict(pairs)
def source_class(source,root):
    p=pathlib.Path(source); r=pathlib.Path(root)
    return 'release:'+str(p.relative_to(r)) if p.is_relative_to(r) else 'external:'+str(p)
def mount_label(m): return m['destination']+' ('+m['type']+':'+m['source']+', '+('rw' if m['rw'] else 'ro')+')'
def render(root,preview=False):
    # Preview uses the existing live working_dir; stage checks relocated paths.
    render_root=previous if preview else root
    work=render_root+'/deploy/edge-runtime'
    args=['docker','compose','--project-directory',work,'-p',project]
    if project_env: args+=['--env-file',project_env]
    process_env=compose_env()
    if preview:
        with tarfile.open(archive) as tar:
            members=[m for m in tar.getmembers() if m.name=='deploy/edge-runtime/compose.yaml']
            assert len(members)==1 and members[0].isfile()
            content=tar.extractfile(members[0]).read()
            override_path='deploy/edge-runtime/compose.override.yaml'
            overrides=[m for m in tar.getmembers() if m.name==override_path]
            if overrides:
                if len(overrides)!=1 or not overrides[0].isfile(): fail([override_path+' type/duplicate'])
                candidate=tar.extractfile(overrides[0]).read()
                live_override=pathlib.Path(previous+'/'+override_path).read_bytes()
                if candidate!=live_override:
                    fail([override_path+' bytes live.sha256='+hashlib.sha256(live_override).hexdigest()+' archive.sha256='+hashlib.sha256(candidate).hexdigest()])
        args+=['-f','-','-f',previous+'/deploy/edge-runtime/compose.override.yaml']
        options={'input':content,'cwd':work,'env':process_env}
        config=run(args+['config','--format','json'],**options)
    else:
        args+=['-f',work+'/compose.yaml','-f',work+'/compose.override.yaml']
        options={'cwd':work,'env':process_env}
        config=run(args+['config','--format','json'],**options)
    raw=run(args+['config','--no-env-resolution','--format','json'],**options)
    files=raw['services']['edge-runtime'].get('env_file',[])
    paths=[v['path'] if isinstance(v,dict) else v for v in files]
    if paths!=[env_file]: fail(['compose.env_file'])
    service=config['services']['edge-runtime']; img=image(service['image'])
    env=env_map(img['Config'].get('Env')); env.update({k:str(v) for k,v in service['environment'].items()})
    mounts=[]
    for v in service.get('volumes',[]):
        src=source_class(v['source'],render_root) if v['type']=='bind' else config['volumes'][v['source']]['name']
        mounts.append({'type':v['type'],'source':src,'destination':v['target'],'rw':not v.get('read_only',False)})
    ports=sorted([p.get('host_ip',''),str(p['published']),str(p['target']),p.get('protocol','tcp')] for p in service.get('ports',[]))
    restart=service.get('restart','no').split(':',1)
    normalized=copy.deepcopy(service)
    normalized['environment']=env_hash(service['environment'])
    normalized['env_file']=files
    for v in normalized.get('volumes',[]):
        if v['type']=='bind': v['source']=source_class(v['source'],render_root)
    # Hash every rendered field, so other Compose settings cannot drift either.
    return {'env':env_hash(env),'image_id':img['Id'],'network_mode':service['network_mode'],
      'networks':[service['network_mode']],'memory':int(service['mem_limit']),
      'restart_policy':{'Name':restart[0],'MaximumRetryCount':int(restart[1]) if len(restart)>1 else 0},
      'ports':ports,'mounts':sorted(mounts,key=lambda m:m['destination']),
      'compose':{k:digest(v) for k,v in normalized.items()}}
def live_facts(root):
    live=run(['docker','inspect','commonswarm-edge-edge-runtime-1'])[0]
    labels=live['Config']['Labels']; work=root+'/deploy/edge-runtime'
    differences=[]
    for key,value in [('com.docker.compose.project',project),('com.docker.compose.service','edge-runtime'),
      ('com.docker.compose.project.working_dir',work),('com.docker.compose.project.config_files',work+'/compose.yaml,'+work+'/compose.override.yaml'),
      ('com.docker.compose.project.environment_file',project_env)]:
        if labels.get(key,'')!=value: differences.append('labels.'+key)
    if differences: fail(differences)
    mounts=[{'type':m['Type'],'source':source_class(m['Source'],root) if m['Type']=='bind' else m['Name'],
      'destination':m['Destination'],'rw':m['RW']} for m in live['Mounts']]
    ports=sorted([p['HostIp'],str(p['HostPort']),target.split('/')[0],target.split('/')[1]]
      for target,bindings in (live['HostConfig'].get('PortBindings') or {}).items() for p in bindings or [])
    return {'env':env_hash(env_map(live['Config']['Env'])),'image_id':live['Image'],
      'network_mode':live['HostConfig']['NetworkMode'],'networks':sorted(live['NetworkSettings']['Networks']),
      'memory':live['HostConfig']['Memory'],'restart_policy':live['HostConfig']['RestartPolicy'],
      'ports':ports,'mounts':sorted(mounts,key=lambda m:m['destination'])}
def fail(fields):
    raise SystemExit('FAIL edge-mcp-config: differing fields '+', '.join(sorted(set(fields)))+'; STOP')
def compare(expected,actual,compose=True):
    differences=[]
    for k in sorted(set(expected['env'])|set(actual['env'])):
        if expected['env'].get(k)!=actual['env'].get(k): differences.append('env.'+k)
    for key in ('image_id','network_mode','networks','memory','restart_policy','ports'):
        if expected[key]!=actual[key]:
            # These names/ids are safe; environment values are never reported.
            differences.append(key+' '+json.dumps(expected[key],sort_keys=True)+' -> '+json.dumps(actual[key],sort_keys=True))
    before={m['destination']:m for m in expected['mounts']}; after={m['destination']:m for m in actual['mounts']}
    for dest in sorted(set(before)|set(after)):
        if before.get(dest)!=after.get(dest):
            differences.append('mounts.'+dest+' '+('missing' if dest not in before else mount_label(before[dest]))+' -> '+('missing' if dest not in after else mount_label(after[dest])))
    if compose:
        for key in sorted(set(expected['compose'])|set(actual['compose'])):
            if expected['compose'].get(key)!=actual['compose'].get(key): differences.append('compose.'+key)
    if differences: fail(differences)
try:
    assert mode in ('capture','archive','config','runtime','compose')
    if mode=='capture':
        baseline=render(previous); compare(baseline,live_facts(previous),compose=False)
        for key in ('SWARM_MCP_PUBLIC_ENABLED','SWARM_SELF_SERVE'):
            if baseline['env'].get(key)!=digest('1'): fail(['env.'+key])
        if baseline['memory']!=2*1024**3: fail(['memory'])
        if baseline['networks']!=['commonswarm-net']: fail(['networks'])
        forbidden=[k for k in baseline['env'] if k.startswith('SWARM_CMD_TEST_')]
        if forbidden: fail(['env.'+k for k in forbidden])
        baseline['override_sha256']=hashlib.sha256(pathlib.Path(previous+'/deploy/edge-runtime/compose.override.yaml').read_bytes()).hexdigest()
        print(json.dumps(baseline,sort_keys=True,separators=(',',':')))
    else:
        baseline=json.loads(saved)
        root=new if mode=='archive' else selected
        override=pathlib.Path((previous if mode=='archive' else root)+'/deploy/edge-runtime/compose.override.yaml')
        if hashlib.sha256(override.read_bytes()).hexdigest()!=baseline['override_sha256']: fail(['compose.override.sha256'])
        compare(baseline,render(root,preview=mode=='archive'))
        if mode=='runtime': compare(baseline,live_facts(root),compose=False)
        if mode=='compose':
            assert command==['up','-d','--no-deps','--force-recreate','--pull','never','edge-runtime']
            result=subprocess.run(compose_args(root)+command,cwd=root+'/deploy/edge-runtime',env=compose_env(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if result.returncode: fail(['compose.recreate'])
        print('PASS edge-mcp-config: complete live ON baseline matched; env digests only, image id, network, memory, restart, ports, mounts, Compose fields')
except SystemExit: raise
except Exception: raise SystemExit('FAIL edge-mcp-config: differing fields config.render/inspect/input (values withheld); STOP') from None
PY
}
edge_check() {
edge_config_check runtime
python3 - "$EDGE_DIR" "${1:-on}" "${2:-$EDGE_DIR}" "$PROOF_DIR" <<'PY'
import json,pathlib,subprocess,sys,os
def need(ok):
    if not ok: raise SystemExit('FAIL edge-mcp-runtime: baseline/ON/network/override/env mismatch; STOP')
def inspect(n): return json.loads(subprocess.check_output(['docker','inspect',n]))[0]
p=pathlib.Path(sys.argv[1]); need(p.resolve()==p and p.is_dir())
need((p/'RELEASE_SHA').read_text().strip()==p.name)
need(pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True)==pathlib.Path(sys.argv[3]))
env=pathlib.Path('/home/commonswarm/.env'); st=env.stat()
need(not env.is_symlink() and st.st_mode & 0o777==0o600 and st.st_uid in (0,p.stat().st_uid))
edge=inspect('commonswarm-edge-edge-runtime-1'); oauth=inspect('commonswarm-oauth-oauth-1')
need(edge['State']['Health']['Status']=='healthy' and oauth['State']['Health']['Status']=='healthy')
need(edge['HostConfig']['Memory']==2*1024**3 and edge['HostConfig']['NetworkMode']=='commonswarm-net')
labels=edge['Config']['Labels']; work=str(p/'deploy/edge-runtime')
need(labels.get('com.docker.compose.project.working_dir')==work)
need(labels.get('com.docker.compose.project.config_files')==work+'/compose.yaml,'+work+'/compose.override.yaml')
need(any(m['Source']==str(p/'supabase/functions') and m['Destination']=='/home/deno/functions-source' and not m['RW'] for m in edge['Mounts']))
need(dict(x.split('=',1) for x in oauth['Config']['Env']).get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED')=='1')
site=pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').read_text()
if sys.argv[2]=='dark':
    proof=pathlib.Path(sys.argv[4])
    need(pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').read_bytes()==(proof/'mcp.off.caddy').read_bytes())
    need((p/'deploy/edge-runtime/compose.override.yaml').read_bytes()==(proof/'compose.override.yaml').read_bytes())
else:
    need(sys.argv[2]=='on')
    need(site.count('import mcp_resource_active')==1 and '@mcp_unavailable' not in site)
need(site.count('import mcp_oauth_active')==1)
need(pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').stat().st_mode & 0o777==0o644)
print('PASS edge-mcp-runtime: env values withheld; both public flags 1, healthy, commonswarm-net, 2 GiB, exact mounts')
PY
}
edge_probes() {
python3 - "${1:-all}" <<'PY'
import json,sys,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
internal=[('http://127.0.0.1:9000/health','GET',200),('http://127.0.0.1:3490/health','GET',200),
 ('http://127.0.0.1:9000/functions/v1/mcp','POST',401),
 ('http://127.0.0.1:9000/functions/v1/mcp/.well-known/oauth-protected-resource/mcp','GET',200)]
public=[('https://mcp.commonswarm.com/health','GET',200),('https://mcp.commonswarm.com/mcp','POST',401),
 ('https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp','GET',200),
 ('https://mcp.commonswarm.com/.well-known/oauth-authorization-server','GET',200),
 ('https://mcp.commonswarm.com/.well-known/openid-configuration','GET',200)]
assert sys.argv[1] in ('all','internal','public'), 'FAIL edge-mcp-probes: unknown scope; STOP'
checks=internal if sys.argv[1]=='internal' else public if sys.argv[1]=='public' else internal+public
for url,method,status in checks:
    req=urllib.request.Request(url,data=b'{}' if method=='POST' else None,method=method,
        headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':'curl/8.7.1'})
    try: response=opener.open(req,timeout=15)
    except urllib.error.HTTPError as error: response=error
    except Exception: raise SystemExit('FAIL edge-mcp-probes: transport; STOP') from None
    with response:
        body=response.read(131073)
        if response.code!=status or len(body)>131072 or response.headers.get_content_type()!='application/json':
            raise SystemExit(f'FAIL edge-mcp-probes: {method} {url} expected {status}; STOP')
        try: value=json.loads(body)
        except Exception: raise SystemExit('FAIL edge-mcp-probes: JSON; STOP') from None
        if not isinstance(value,dict): raise SystemExit('FAIL edge-mcp-probes: JSON object; STOP')
        if url.endswith('/health'): assert value.get('status')=='ok'
        if url.endswith('/oauth-protected-resource/mcp'):
            assert value.get('resource')=='https://mcp.commonswarm.com/mcp'
            assert 'https://mcp.commonswarm.com' in value.get('authorization_servers',[])
        if url.endswith(('oauth-authorization-server','openid-configuration')): assert value.get('issuer')=='https://mcp.commonswarm.com'
        print(method,url,status,'PASS')
PY
}
external_check() {
if test "${1:-check}" = capture || test "${1:-check}" = preflight; then edge_expected_baselines check; fi
python3 - "$PROOF_DIR/external.json" "${1:-check}" <<'PY'
import hashlib,json,pathlib,posixpath,shlex,subprocess,sys
def digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
o=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1']))[0]
oauth_work=pathlib.Path(o['Config']['Labels']['com.docker.compose.project.working_dir'])
oauth_release=oauth_work.parent.parent
assert oauth_work.parts[-2:]==('deploy','mcp-auth') and oauth_release.resolve()==oauth_release
assert (oauth_release/'RELEASE_SHA').read_text().strip()==oauth_release.name
assert pathlib.Path('/home/commonswarm/oauth/current').resolve(strict=True)==oauth_release
facts={'oauth_id':o['Id'],'oauth_image':o['Image'],'oauth_env':digest('/etc/commonswarm-oauth/service.env'),
 'edge_env':digest('/home/commonswarm/.env'),
 'oauth_compose':digest('/etc/commonswarm-oauth/compose.env'),
 'stack':str(pathlib.Path('/home/commonswarm/stack/current').resolve(strict=True)),
 'site':str(pathlib.Path('/srv/commonswarm/site/current').resolve(strict=True)),
 'caddyfile':digest('/etc/caddy/Caddyfile'),'oauth_source':str(oauth_release)}
imports=[]
for line in pathlib.Path('/etc/caddy/Caddyfile').read_text().splitlines():
    fields=shlex.split(line,comments=True)
    if len(fields)==2 and fields[0]=='import': imports.append(posixpath.normpath(posixpath.join('/etc/caddy',fields[1])))
assert '/etc/caddy/sites/*.caddy' in imports, 'FAIL edge-mcp-external: main Caddy sites import differs; STOP'
if sys.argv[2] in ('capture','preflight'):
    if sys.argv[2]=='capture': pathlib.Path(sys.argv[1]).write_text(json.dumps(facts,sort_keys=True)+'\n')
elif facts!=json.loads(pathlib.Path(sys.argv[1]).read_text()): raise SystemExit('FAIL edge-mcp-external: OAuth/stack/site/main-Caddy drift; STOP')
PY
}
window_check() {
  test ! -e "$PROOF_DIR/closed.txt"
  PLAN_GUARD_VALUE_8="$(date -u +%s)"
  PLAN_GUARD_VALUE_9="$(date -u -d "$WINDOW_END_UTC" +%s)"
  test "${PLAN_GUARD_VALUE_8}" -le "${PLAN_GUARD_VALUE_9}"
  cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
  external_check
}
receipt() {
  if test -f "$PROOF_DIR/mcp-503-start.epoch"; then
    local start end elapsed
    start=$(cat "$PROOF_DIR/mcp-503-start.epoch"); end=$(date -u +%s)
    elapsed=$((end-start))
    printf 'mode=restored-on\nstart_utc=%s\nend_utc=%s\nduration_seconds=%s\nmaximum_seconds=%s\n' \
      "$(cat "$PROOF_DIR/mcp-503-start.utc")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed" "$MAX_MCP_OUTAGE_SECONDS" \
      >"$PROOF_DIR/mcp-503-receipt.txt"
    if test "$elapsed" -le "$MAX_MCP_OUTAGE_SECONDS"; then
      printf 'budget_met=yes\n' >>"$PROOF_DIR/mcp-503-receipt.txt"
    else
      printf 'budget_met=no\n' >>"$PROOF_DIR/mcp-503-receipt.txt"
    fi
    test "$elapsed" -le "$MAX_MCP_OUTAGE_SECONDS" || {
      echo 'FAIL edge-mcp-receipt: approved outage budget exceeded, ON restored; report receipt; STOP' >&2; return 1;
    }
  else
    printf 'mode=no-transition\n503_window=none\n' >"$PROOF_DIR/mcp-503-receipt.txt"
  fi
}
EDGE_DIR=$PREVIOUS_EDGE
EDGE_BASELINE_FACTS=$(edge_config_check capture)
# Render archive Compose with the live override before opening; write no files.
edge_config_check archive
edge_check
edge_probes
external_check preflight
printf 'PASS edge-mcp-preflight: baseline ON; no production mutation\n'
```

```sh
# step: edge-mcp-open
# host: box root /bin/bash; same invocation as preflight
set -euo pipefail
trap 'printf "FAIL edge-mcp-open: line %s; no service mutation; run edge-mcp-open-abort with SECRET_STAGE=%s\n" "$LINENO" "${SECRET_STAGE:-not-created}" >&2' ERR
umask 077
test ! -e "$PROOF_DIR"
test ! -L "$PROOF_DIR"
install -d -o root -g root -m 0700 "$PROOF_DIR"
# Match the existing OAuth window's protected Linux /private/tmp staging.
test -d /private/tmp
test ! -L /private/tmp
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
install -m 0600 /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cp -p /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
cp -p "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" "$PROOF_DIR/compose.override.yaml"
# Recheck live/config/override against preflight after capturing the inputs.
edge_config_check runtime
printf '%s\n' "$EDGE_BASELINE_FACTS" >"$PROOF_DIR/edge-baseline.json"
external_check capture
python3 - "$PROOF_DIR/mcp.on.caddy" "$PROOF_DIR/mcp.off.caddy" "$PREVIOUS_EDGE" <<'PY'
import pathlib,re,sys
on=pathlib.Path(sys.argv[1]).read_bytes()
template=(pathlib.Path(sys.argv[3])/'deploy/supabase-stack/commonswarm-mcp.caddy').read_bytes()
pattern=rb'\t\t@mcp_unavailable path /mcp /\.well-known/oauth-protected-resource/mcp\n\t\thandle @mcp_unavailable \{\n(?:[^\n]*\n)*?\t\t\}'
dark=re.search(pattern,template)
assert dark and on.count(b'\t\timport mcp_resource_active')==1
pathlib.Path(sys.argv[2]).write_bytes(on.replace(b'\t\timport mcp_resource_active',dark[0]))
PY
{
  for name in MEASURED_SITE_SHA EXPECTED_OAUTH_SHA EXPECTED_OAUTH_IMAGE_DIGEST EXPECTED_SITE_SHA EXPECTED_STACK_SHA RELEASE_SHA WINDOW_ID EXPECTED_EDGE_SHA BOX_ARCHIVE_PATH EDGE_ARCHIVE_SHA256 WINDOW_END_UTC MAX_MCP_OUTAGE_SECONDS PREVIOUS_EDGE NEW_EDGE PROOF_DIR SECRET_STAGE EDGE_PROJECT EDGE_NETWORK EDGE_ENV_FILE EDGE_PROJECT_ENV_FILE EDGE_BASELINE_FACTS; do
    printf '%s=%q\n' "$name" "${!name}"
  done
  declare -f edge_expected_baselines edge_compose edge_config_check edge_check edge_probes external_check window_check receipt
} >"$PROOF_DIR/state.sh"
chmod 0600 "$PROOF_DIR/state.sh"
printf 'open\n' >"$PROOF_DIR/open.txt"
printf 'PASS edge-mcp-open: protected env snapshot; no production mutation\n'
```

Stage copies the captured baseline override byte-for-byte and verifies its
SHA-256, after requiring any archive override to be byte-equal. Both renders
and recreation use the measured project, service env
file, interpolation env label (if present), network mode and both Compose
files, with working_dir set to the selected release. Stage verifies a fresh
archive tree and any reused destination, including the
complete path set, types, modes, symlink containment and file bytes. Extras
are limited to RELEASE_SHA and the exact copied override, as in §1's reuse
contract (`deploy/RELEASE-TO-BOX.md:593`). Staging does not move current.

```sh
# step: edge-mcp-stage
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-stage: line $LINENO; run rollback; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
window_check
PLAN_GUARD_VALUE_10="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_10}" = "$PREVIOUS_EDGE"
PLAN_GUARD_VALUE_11="$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')"
test "${PLAN_GUARD_VALUE_11}" = "$EDGE_ARCHIVE_SHA256"
python3 - "$BOX_ARCHIVE_PATH" "$PROOF_DIR/source" "$NEW_EDGE" "$RELEASE_SHA" "$PROOF_DIR/compose.override.yaml" <<'PY'
import hashlib,os,pathlib,pwd,shutil,stat,sys,tarfile
archive,source,new,sha,override=sys.argv[1:]; source=pathlib.Path(source); new=pathlib.Path(new)
override_path='deploy/edge-runtime/compose.override.yaml'
live_override=pathlib.Path(override).read_bytes()
try:
    if not source.exists():
        source.mkdir(mode=0o700)
        with tarfile.open(archive) as tar:
            names=set()
            for m in tar.getmembers():
                p=pathlib.PurePosixPath(m.name)
                assert not p.is_absolute() and '..' not in p.parts and m.name not in names
                names.add(m.name); assert m.isfile() or m.isdir() or m.issym()
                if m.issym():
                    target=pathlib.PurePosixPath(m.linkname)
                    assert not target.is_absolute() and '..' not in target.parts
                assert m.name!='RELEASE_SHA'
                if m.name==override_path:
                    if not m.isfile(): raise SystemExit('FAIL edge-mcp-stage: '+override_path+' type differs from live regular file; STOP')
                    candidate=tar.extractfile(m).read()
                    if candidate!=live_override:
                        raise SystemExit('FAIL edge-mcp-stage: '+override_path+' bytes differ: live.sha256='+hashlib.sha256(live_override).hexdigest()+' archive.sha256='+hashlib.sha256(candidate).hexdigest()+'; STOP')
            tar.extractall(source,filter='data')
        (source/'RELEASE_SHA').write_text(sha+'\n')
        shutil.copyfile(override,source/'deploy/edge-runtime/compose.override.yaml')
        os.chmod(source/'deploy/edge-runtime/compose.override.yaml',stat.S_IMODE(pathlib.Path(override).stat().st_mode))
        (source.parent/'source-ready.txt').write_text('ready\n')
    assert not source.is_symlink() and (source.parent/'source-ready.txt').read_text()=='ready\n'
    def entries(root):
        out={}
        for base,dirs,files in os.walk(root,followlinks=False):
            for name in dirs+files:
                p=pathlib.Path(base)/name; rel=str(p.relative_to(root)); s=p.lstat()
                kind=stat.S_IFMT(s.st_mode); mode=stat.S_IMODE(s.st_mode)
                assert kind in (stat.S_IFREG,stat.S_IFDIR,stat.S_IFLNK)
                value=os.readlink(p) if p.is_symlink() else p.read_bytes() if p.is_file() else None
                if p.is_symlink(): assert p.resolve().is_relative_to(root.resolve())
                out[rel]=(kind,mode,value)
        return out
    expected=entries(source)
    if not new.exists() and not new.is_symlink():
        shutil.copytree(source,new,symlinks=True); os.chmod(new,0o750)
        uid=pwd.getpwnam('commonswarm').pw_uid; gid=pwd.getpwnam('commonswarm').pw_gid
        os.chown(new,uid,gid)
        for base,dirs,files in os.walk(new,followlinks=False):
            for name in dirs+files: os.chown(pathlib.Path(base)/name,uid,gid,follow_symlinks=False)
    assert not new.is_symlink() and new.resolve()==new and new.stat().st_mode & 0o777==0o750
    assert entries(new)==expected
    def file_digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
    assert file_digest(new/'deploy/edge-runtime/compose.override.yaml')==file_digest(override)
    uid=pwd.getpwnam('commonswarm').pw_uid; gid=pwd.getpwnam('commonswarm').pw_gid
    assert (new.stat().st_uid,new.stat().st_gid)==(uid,gid)
    for base,dirs,files in os.walk(new,followlinks=False):
        for name in dirs+files:
            s=(pathlib.Path(base)/name).lstat(); assert (s.st_uid,s.st_gid)==(uid,gid)
    print('PASS edge-mcp-stage: compose.override.sha256='+file_digest(override))
    print('PASS edge-mcp-stage: exact archive path inventory, bytes, symlinks, modes, owner')
except Exception: raise SystemExit('FAIL edge-mcp-stage: immutable release mismatch or incomplete stage; STOP') from None
PY
EDGE_DIR=$NEW_EDGE
edge_config_check
touch "$PROOF_DIR/staged.txt"
```

```sh
# step: edge-mcp-transition-503
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-transition-503: line $LINENO; run rollback immediately; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
window_check
test -f "$PROOF_DIR/staged.txt"
test ! -e "$PROOF_DIR/mcp-503-start.epoch"
EDGE_DIR=$PREVIOUS_EDGE
edge_check
edge_probes
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
systemctl is-active --quiet commonswarm-edge-recycle.timer
touch "$PROOF_DIR/timer-restore-required.txt"
systemctl stop commonswarm-edge-recycle.timer
PLAN_GUARD_VALUE_12="$(systemctl show -p ActiveState --value commonswarm-edge-recycle.service)"
test "${PLAN_GUARD_VALUE_12}" = inactive
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/mcp-503-start.utc"
date -u +%s >"$PROOF_DIR/mcp-503-start.epoch"
install -o root -g root -m 0644 "$PROOF_DIR/mcp.off.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
for url in https://mcp.commonswarm.com/mcp https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp; do
  if test "$url" = https://mcp.commonswarm.com/mcp; then method=POST; else method=GET; fi
  status=$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' -X "$method" "$url")
  test "$status" = 503
  printf '%s %s 503 PASS\n' "$method" "$url" >>"$PROOF_DIR/503-probes.txt"
done
touch "$PROOF_DIR/dark-verified.txt"
```

```sh
# step: edge-mcp-apply
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-apply: line $LINENO; run rollback immediately; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
window_check
test -f "$PROOF_DIR/dark-verified.txt"
test ! -e "$PROOF_DIR/rollback.txt"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.off.caddy"
cmp -s "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" "$PROOF_DIR/compose.override.yaml"
EDGE_DIR=$NEW_EDGE
edge_config_check
edge_compose up -d --no-deps --force-recreate --pull never edge-runtime
deadline=$(( $(date -u +%s) + 180 ))
PLAN_GUARD_VALUE_23="$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)"
until test "${PLAN_GUARD_VALUE_23}" = healthy; do
  PLAN_GUARD_VALUE_13="$(date -u +%s)"
  test "${PLAN_GUARD_VALUE_13}" -lt "$deadline"
  sleep 2
  PLAN_GUARD_VALUE_23="$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)"
done
# Verify the live container before switching current; ingress remains dark.
edge_check dark "$PREVIOUS_EDGE"
ln -sfn "$NEW_EDGE" /home/commonswarm/edge/current
touch "$PROOF_DIR/applied.txt"
```

```sh
# step: edge-mcp-restore-on
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-restore-on: line $LINENO; run rollback immediately; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
window_check
test -f "$PROOF_DIR/applied.txt"
PLAN_GUARD_VALUE_14="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_14}" = "$NEW_EDGE"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.off.caddy"
EDGE_DIR=$NEW_EDGE
edge_check dark
edge_probes internal >"$PROOF_DIR/pre-on-probes.txt"
# Only verified runtime and internal probes permit public ingress restoration.
install -o root -g root -m 0644 "$PROOF_DIR/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
edge_check
edge_probes public >"$PROOF_DIR/on-probes.txt"
# Runtime and ON probes passed; receipt/timer failures are closure failures.
trap 'printf "CLOSE_FAILED edge-mcp-restore-on: LIVE_STATE=ON SOURCE=%s; receipt/timer closure failed; retain evidence; no rollback\n" "$RELEASE_SHA" >&2' ERR
receipt || { printf 'CLOSE_FAILED edge-mcp-restore-on: LIVE_STATE=ON SOURCE=%s; receipt write failed; retain evidence; no rollback\n' "$RELEASE_SHA" >&2; exit 1; }

```

Rollback recreates only the captured baseline release with its override and
unchanged ON env, then restores the original Caddy site. It works if the new
container was recreated but current never moved. It does not depend on a
successful apply marker or unexpired forward window. The runtime pattern is
§6 rollback (`deploy/RELEASE-TO-BOX.md:2648`), with added ON gates.
Baseline runtime and internal probes must pass while ingress is dark before
restoring ON. After baseline ON verification, rollback restores and verifies
the recycle timer itself; timer-recover remains the failed-rollback path.

```sh
# step: edge-mcp-rollback
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-rollback: line $LINENO; ON unverified, retain stage, run timer-recover, report ongoing outage; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
case "$EXPECTED_EDGE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#EXPECTED_EDGE_SHA}" = 40
test "$PREVIOUS_EDGE" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA"
PLAN_GUARD_VALUE_15="$(cat "$PREVIOUS_EDGE/RELEASE_SHA")"
test "${PLAN_GUARD_VALUE_15}" = "$EXPECTED_EDGE_SHA"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" "$PROOF_DIR/compose.override.yaml"
external_check
EDGE_DIR=$PREVIOUS_EDGE
edge_config_check
if test -f "$PROOF_DIR/mcp-503-start.epoch"; then
  # A failed ON probe may have reopened ingress: re-establish 503 before rollback.
  # Invalidate a previous end receipt until recovery's ON probes finish.
  : >"$PROOF_DIR/mcp-503-receipt.txt"
  install -o root -g root -m 0644 "$PROOF_DIR/mcp.off.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  systemctl reload caddy
  edge_compose up -d --no-deps --force-recreate --pull never edge-runtime
  deadline=$(( $(date -u +%s) + 180 ))
  PLAN_GUARD_VALUE_24="$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)"
  until test "${PLAN_GUARD_VALUE_24}" = healthy; do
    PLAN_GUARD_VALUE_16="$(date -u +%s)"
    test "${PLAN_GUARD_VALUE_16}" -lt "$deadline"
    sleep 2
    PLAN_GUARD_VALUE_24="$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)"
  done
  ln -sfn "$PREVIOUS_EDGE" /home/commonswarm/edge/current
  edge_check dark
  edge_probes internal >"$PROOF_DIR/rollback-pre-on-probes.txt"
  install -o root -g root -m 0644 "$PROOF_DIR/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  systemctl reload caddy
fi
PLAN_GUARD_VALUE_17="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_17}" = "$PREVIOUS_EDGE"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
edge_check
edge_probes >"$PROOF_DIR/rollback-probes.txt"
external_check
if test -f "$PROOF_DIR/timer-restore-required.txt"; then
  systemctl start commonswarm-edge-recycle.timer
  systemctl is-active --quiet commonswarm-edge-recycle.timer
  touch "$PROOF_DIR/timer-restored.txt"
fi
systemctl is-active --quiet commonswarm-edge-recycle.timer
touch "$PROOF_DIR/rollback.txt"
# Runtime and ON probes passed; receipt/timer failures are closure failures.
trap 'printf "CLOSE_FAILED edge-mcp-rollback: LIVE_STATE=ON SOURCE=%s; receipt/timer closure failed; retain evidence; no rollback\n" "$EXPECTED_EDGE_SHA" >&2' ERR
receipt || { printf 'CLOSE_FAILED edge-mcp-rollback: LIVE_STATE=ON SOURCE=%s; receipt write failed; retain evidence; no rollback\n' "$EXPECTED_EDGE_SHA" >&2; exit 1; }

```

```sh
# step: edge-mcp-probes
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-probes: line $LINENO; run rollback; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
if test -f "$PROOF_DIR/rollback.txt"; then EDGE_DIR=$PREVIOUS_EDGE; else EDGE_DIR=$NEW_EDGE; fi
PLAN_GUARD_VALUE_18="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_18}" = "$EDGE_DIR"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
external_check
edge_check
edge_probes >"$PROOF_DIR/final-probes.txt"
test -s "$PROOF_DIR/mcp-503-receipt.txt" || { printf 'CLOSE_FAILED edge-mcp-probes: LIVE_STATE=ON SOURCE=%s; missing outage receipt; retain evidence; no rollback\n' "${EDGE_DIR##*/}" >&2; exit 1; }
touch "$PROOF_DIR/verified-on.txt"
printf 'PASS edge-mcp-probes: selected release ON; retain status-only evidence\n'
```

Close removes only the exact secret directory this open created; no secret
snapshot enters copyback or a commit. `/usr/bin/rm` is box-only after checking
the measured binary and canonical deletion boundary. The Mac uses guarded rm.
Cleanup refusal is a STOP with the exact path/error; never try another tool.
If a receipt exceeds the budget but ON was verified, report FAIL to HezLead;
the marked close remains available for protected cleanup without reporting PASS.

```sh
# step: edge-mcp-timer-recover
# host: box root /bin/bash; also run after failed rollback
set -euo pipefail
trap 'echo "FAIL edge-mcp-timer-recover: line $LINENO; report and STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
if test -f "$PROOF_DIR/timer-restore-required.txt"; then
  systemctl start commonswarm-edge-recycle.timer
  systemctl is-active --quiet commonswarm-edge-recycle.timer
  touch "$PROOF_DIR/timer-restored.txt"
fi
```

```sh
# step: edge-mcp-close
# host: box root /bin/bash
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      edge-mcp-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_FAILURE_PHASE=DEPLOY_FAILED

trap 'echo "FAIL edge-mcp-close: line $LINENO; retain remaining stage and report exact error; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
if test -f "$PROOF_DIR/closed.txt"; then
  RELEASE_FAILURE_PHASE=CLOSE_FAILED
  echo 'edge-mcp-close: already closed'
  if grep -qFx 'budget_met=no' "$PROOF_DIR/mcp-503-receipt.txt"; then exit 1; fi
  exit 0
fi
if test -f "$PROOF_DIR/rollback.txt"; then EDGE_DIR=$PREVIOUS_EDGE; else EDGE_DIR=$NEW_EDGE; fi
PLAN_GUARD_VALUE_19="$(readlink -f /home/commonswarm/edge/current)"
test "${PLAN_GUARD_VALUE_19}" = "$EDGE_DIR"
edge_check
edge_probes >"$PROOF_DIR/close-probes.txt"
external_check
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
RELEASE_FAILURE_PHASE=CLOSE_FAILED
RELEASE_LIVE_STATE="ON source=${EDGE_DIR##*/}; timer=pending-closure-reconciliation; verified-at-close"
test -s "$PROOF_DIR/mcp-503-receipt.txt"
if test -f "$PROOF_DIR/timer-restore-required.txt"; then systemctl start commonswarm-edge-recycle.timer; fi
systemctl is-active --quiet commonswarm-edge-recycle.timer
RELEASE_LIVE_STATE="ON source=${EDGE_DIR##*/}; timer=active; verified-at-close"
PLAN_GUARD_VALUE_20="$(command -v rm)"
test "${PLAN_GUARD_VALUE_20}" = /usr/bin/rm
test -x /usr/bin/rm
test ! -L /usr/bin/rm
if test -d "$SECRET_STAGE"; then
  cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
  python3 - "$SECRET_STAGE" "$PROOF_DIR/state.sh" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); state=pathlib.Path(sys.argv[2])
pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('', '/', str(pathlib.Path.home()), '/private/tmp/other', '/private/tmp/anvil-secret.abcdef/child'):
    assert not re.fullmatch(pattern,denied), 'FAIL edge-mcp-close: deletion boundary control'
assert re.fullmatch(pattern,str(p))
assert p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
assert p not in (pathlib.Path('/'),pathlib.Path.home()) and state.stat().st_uid==0
PY
  /usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL edge-mcp-close: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
fi
test ! -e "$SECRET_STAGE"
test ! -L "$SECRET_STAGE"
test "$BOX_ARCHIVE_PATH" = /tmp/hm37-edge-${RELEASE_SHA}-${WINDOW_ID}.tar
test ! -L "$BOX_ARCHIVE_PATH"
/usr/bin/rm -f -- "$BOX_ARCHIVE_PATH" || { printf 'FAIL edge-mcp-close: cleanup refused %s; STOP\n' "$BOX_ARCHIVE_PATH" >&2; exit 1; }
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/closed.txt"
printf 'Closed ON. Retain status-only proof directory: %s\n' "$PROOF_DIR"
if grep -qFx 'budget_met=no' "$PROOF_DIR/mcp-503-receipt.txt"; then
  echo 'FAIL edge-mcp-close: outage budget exceeded; ON restored and cleanup complete; report FAIL' >&2
  exit 1
fi
```

Open-abort takes the exact reported failed-open path as positional input 8.
It does not guess a secret path from a glob, delete a release, or touch services.

```sh
# step: edge-mcp-open-abort
# host: box root /bin/bash; failed-open recovery only
set -euo pipefail
trap 'echo "FAIL edge-mcp-open-abort: retain exact path and report; STOP" >&2' ERR
SECRET_STAGE=${8:?exact failed-open path required}
PLAN_GUARD_VALUE_21="$(id -u)"
test "${PLAN_GUARD_VALUE_21}" = 0
PLAN_GUARD_VALUE_22="$(command -v rm)"
test "${PLAN_GUARD_VALUE_22}" = /usr/bin/rm
test ! -L /usr/bin/rm
python3 - "$SECRET_STAGE" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('', '/', str(pathlib.Path.home()), '/private/tmp/other', '/private/tmp/anvil-secret.abcdef/child'):
    assert not re.fullmatch(pattern,denied), 'FAIL edge-mcp-open-abort: deletion boundary control'
assert re.fullmatch(pattern,str(p))
assert p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
assert p not in (pathlib.Path('/'),pathlib.Path.home())
PY
/usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL edge-mcp-open-abort: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
```

```sh
# step: edge-mcp-mac-close
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
      edge-mcp-mac-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_LIVE_STATE="last-verified-ON; see retained verification receipt"

trap 'echo "FAIL edge-mcp-mac-close: report guard error and exact path; STOP" >&2' ERR
: "${ARCHIVE_DIR:?original archive directory required}"
python3 - "$ARCHIVE_DIR" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/hm37-edge-archive\.[A-Za-z0-9]{6}'
for denied in ('', '/', str(pathlib.Path.home()), '/private/tmp/other', '/private/tmp/hm37-edge-archive.abcdef/child'):
    assert not re.fullmatch(pattern,denied), 'FAIL edge-mcp-mac-close: deletion boundary control'
assert re.fullmatch(pattern,str(p))
assert not p.is_symlink() and p.resolve(strict=True)==p and p.is_dir()
assert p not in (pathlib.Path('/'),pathlib.Path.home())
PY
rm -rf -- "$ARCHIVE_DIR" || { printf 'FAIL edge-mcp-mac-close: guarded cleanup refused %s; STOP\n' "$ARCHIVE_DIR" >&2; exit 1; }
```

No raw logs or env are copied back. The retained proof directory contains the
archive-derived source, safe state paths/functions, Caddy/override inputs,
external identity digests, status-only probe results, 503 start/end/duration
and close timestamp. Copyback is outside this plan; HezLead can read these
receipts with a separately named read-only task. A 401 and metadata/discovery
200 prove the public anonymous boundary and advertised issuer/resource;
they do not prove an authenticated MCP tool call or the separate HM done-test.

```release-contract
{
  "version": 1,
  "release_input": "RELEASE_SHA",
  "inputs": {"EXPECTED_EDGE_SHA": {"format": "sha40"}, "EXPECTED_OAUTH_IMAGE_DIGEST": {"format": "digest"}, "EXPECTED_OAUTH_SHA": {"format": "sha40"}, "EXPECTED_SITE_SHA": {"format": "sha40"}, "EXPECTED_STACK_SHA": {"format": "sha40"}, "MAX_MCP_OUTAGE_SECONDS": {"format": "decimal-positive", "maximum": 600}, "PLAN_FILE": {"format": "abs-file"}, "RELEASE_SHA": {"format": "sha40"}, "WINDOW_END_UTC": {"format": "utc-window"}},
  "repo_paths": ["deploy/edge-runtime", "deploy/edge-runtime/compose.override.yaml", "deploy/edge-runtime/compose.yaml", "deploy/site/deploy.sh", "deploy/supabase-stack/commonswarm-mcp.caddy", "docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md", "scripts/release-preflight.py", "supabase/functions"],
  "runtime_paths": [],
  "input_files": ["$PLAN_FILE"],
  "routes": {"normal": ["edge-release-shared-preflight", "edge-mcp-plan-inputs", "edge-mcp-archive", "edge-mcp-preflight", "edge-mcp-open", "edge-mcp-stage", "edge-mcp-transition-503", "edge-mcp-apply", "edge-mcp-restore-on", "edge-mcp-probes", "edge-mcp-close", "edge-mcp-mac-close"], "recovery": ["edge-release-shared-preflight", "edge-mcp-plan-inputs", "edge-mcp-archive", "edge-mcp-preflight", "edge-mcp-open", "edge-mcp-stage", "edge-mcp-transition-503", "edge-mcp-apply", "edge-mcp-restore-on", "edge-mcp-probes", "edge-mcp-rollback", "edge-mcp-probes", "edge-mcp-close", "edge-mcp-mac-close"]},
  "steps": {
    "edge-release-shared-preflight": {"reads": [], "sha256": "e1b3e816d530adcd9da81e30339f5b0fafeba00fa6e8b667a1baab99cdaf91fc"},
    "edge-mcp-plan-inputs": {"reads": ["/home/commonswarm/edge/releases", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/releases", "/home/commonswarm/oauth/releases/", "/srv/commonswarm/site/current", "/srv/commonswarm/site/releases", "command:docker inspect"], "sha256": "d941ebeefbe4fb14f1bc8b722f3b9b765cefff3a4488ce1adad448622c5a1783"},
    "edge-mcp-archive": {"creates": ["$ARCHIVE_DIR", "$ARCHIVE_DIR/release.tar", "$BOX_ARCHIVE_PATH", "ARCHIVE_DIR", "BOX_ARCHIVE_PATH"], "reads": ["endpoint:https://github.com/yulanventures/commonswarm.git"], "sha256": "d98be857aca235ebf5717abcb9ace68bf861c2866ebc026610eb42ff38e12b13"},
    "edge-mcp-transport": {"creates": ["$ARCHIVE_DIR/box-step.sh", "$ARCHIVE_DIR/site-prefix.txt"], "reads": ["/srv/commonswarm/site/current", "/srv/commonswarm/site/releases", "command:readlink -f"], "sha256": "35599d0a142c811d2ff7e92d343800e90dfee3ad0c72e946fbf15755b5f9e849"},
    "edge-mcp-preflight": {"reads": ["/etc/caddy", "/etc/caddy/Caddyfile", "/etc/caddy/sites/*.caddy", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/current", "/home/commonswarm/stack/current", "/srv/commonswarm/site/current", "command:docker compose", "command:docker image inspect", "command:docker inspect", "command:readlink -f", "command:systemctl is-active", "endpoint:http://127.0.0.1:3490/health", "endpoint:http://127.0.0.1:9000/functions/v1/mcp", "endpoint:http://127.0.0.1:9000/functions/v1/mcp/.well-known/oauth-protected-resource/mcp", "endpoint:http://127.0.0.1:9000/health", "endpoint:https://mcp.commonswarm.com", "endpoint:https://mcp.commonswarm.com/.well-known/oauth-authorization-server", "endpoint:https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp", "endpoint:https://mcp.commonswarm.com/.well-known/openid-configuration", "endpoint:https://mcp.commonswarm.com/health", "endpoint:https://mcp.commonswarm.com/mcp"], "sha256": "0ca8aa3ac7733a6c0573d9bae6863d7cce95d6b9b9cff7268d7d8bdc1f761aab"},
    "edge-mcp-open": {"creates": ["$PROOF_DIR/compose.override.yaml", "$PROOF_DIR/edge-baseline.json", "$PROOF_DIR/external.json", "$PROOF_DIR/mcp.off.caddy", "$PROOF_DIR/mcp.on.caddy", "$PROOF_DIR/open.txt", "$PROOF_DIR/state.sh", "$SECRET_STAGE", "$SECRET_STAGE/edge.env", "SECRET_STAGE"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/.env"], "sha256": "7481a9c1711be5bc69490dad80631f5a0aead18d0062cdcf08458719fd233cf4"},
    "edge-mcp-stage": {"consumes": ["$PROOF_DIR/compose.override.yaml"], "creates": ["$PROOF_DIR/source", "$PROOF_DIR/staged.txt"], "reads": ["/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "command:readlink -f"], "sha256": "aae21ee94fc2e9509ff725514ce4ad861ec8a28a481b6e09c474bbbe12b09ed7"},
    "edge-mcp-transition-503": {"consumes": ["$PROOF_DIR/mcp.off.caddy", "$PROOF_DIR/mcp.on.caddy", "$PROOF_DIR/staged.txt"], "creates": ["$PROOF_DIR/503-probes.txt", "$PROOF_DIR/dark-verified.txt", "$PROOF_DIR/mcp-503-start.epoch", "$PROOF_DIR/mcp-503-start.utc", "$PROOF_DIR/timer-restore-required.txt"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/edge/release-proofs/", "command:systemctl is-active", "endpoint:https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp;", "endpoint:https://mcp.commonswarm.com/mcp", "endpoint:https://mcp.commonswarm.com/mcp;"], "sha256": "c8840ea16c8a5760131159f4c3bc4cdc2ce9f8c90ea84b2041d44edf7f5efe70"},
    "edge-mcp-apply": {"consumes": ["$PROOF_DIR/compose.override.yaml", "$PROOF_DIR/dark-verified.txt", "$PROOF_DIR/mcp.off.caddy"], "creates": ["$PROOF_DIR/applied.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "command:docker inspect"], "sha256": "5d7638adbd57215167785fedf28f4e7935a2c8b902ff0e4b63c3afe59316c016"},
    "edge-mcp-restore-on": {"consumes": ["$PROOF_DIR/applied.txt", "$PROOF_DIR/mcp.off.caddy", "$PROOF_DIR/mcp.on.caddy"], "creates": ["$PROOF_DIR/mcp-503-receipt.txt", "$PROOF_DIR/on-probes.txt", "$PROOF_DIR/pre-on-probes.txt"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "command:readlink -f"], "sha256": "5db3030e9197ecf2aff1e2320bcb1f41ba172a929664d8d2f4eea6a4007fc3d6"},
    "edge-mcp-rollback": {"creates": ["$PROOF_DIR/rollback-pre-on-probes.txt", "$PROOF_DIR/rollback-probes.txt", "$PROOF_DIR/rollback.txt", "$PROOF_DIR/timer-restored.txt"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "/home/commonswarm/edge/releases/", "command:docker inspect", "command:readlink -f", "command:systemctl is-active"], "sha256": "80020923e21c6428bcee67415546fb6c679f057d80418851bec9b796e8dda486"},
    "edge-mcp-probes": {"consumes": ["$PROOF_DIR/mcp-503-receipt.txt", "$PROOF_DIR/mcp.on.caddy", "$SECRET_STAGE/edge.env"], "creates": ["$PROOF_DIR/final-probes.txt", "$PROOF_DIR/verified-on.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "command:readlink -f"], "sha256": "bd782d64ab50f0e8cbf2612f1af68e7eaed404d89651efa1c6f33b13bad62215"},
    "edge-mcp-timer-recover": {"reads": ["/home/commonswarm/edge/release-proofs/", "command:systemctl is-active"], "sha256": "16d4f3f85955208003af291cbc7f09aef57af49649ffae94aeaeb87dfab9239c"},
    "edge-mcp-close": {"cleanup": ["BOX_ARCHIVE_PATH", "SECRET_STAGE"], "cleanup_owners": {"$BOX_ARCHIVE_PATH": "edge-mcp-archive", "$SECRET_STAGE": "edge-mcp-open"}, "consumes": ["$PROOF_DIR/mcp-503-receipt.txt", "$PROOF_DIR/mcp.on.caddy", "$PROOF_DIR/state.sh", "$SECRET_STAGE/edge.env"], "creates": ["$PROOF_DIR/close-probes.txt", "$PROOF_DIR/closed.txt"], "reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/release-proofs/", "command:readlink -f", "command:systemctl is-active"], "sha256": "1cb3fc0a5bba8709d0788fba33bff1342f55948041e10bc95a42b69d5bbca087"},
    "edge-mcp-open-abort": {"cleanup_owners": {"$SECRET_STAGE": "edge-mcp-open"}, "reads": [], "sha256": "95122e17dce3ca20174b4e66a320295d9427812aa44550cc00fd88ab782103f3"},
    "edge-mcp-mac-close": {"cleanup": ["ARCHIVE_DIR"], "cleanup_owners": {"$ARCHIVE_DIR": "edge-mcp-archive"}, "reads": [], "sha256": "6a060fdf7f170b2e52b624b20ce8a40c1be2ba47f117e67c64807aa00ffdb037"}
  },
  "different": [["RELEASE_SHA", "EXPECTED_EDGE_SHA"]],
  "plan_input": "PLAN_FILE"
}
```
