# Admin issuance release: W1–W7

Prepared, not executed. This plan releases one reviewed `RELEASE_SHA`, landed on
main, in seven separately authorized windows. The preparation worker has made
no box measurements. Neither this document nor a PASS receipt grants approval.
Admin issuance remains OFF until HezLead executes W5: the reviewed issuer
coordinator, activation-only overlay, exact `MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1`,
open DB cutover and independently measured release are all required.

Authority: the admin issuance specification's boundaries, lane 8, findings and
D1–D3 decisions; `deploy/RELEASE-TO-BOX.md`; the generalized October 2 OAuth,
edge, site and DCR plans. The implementation timestamps are M1–M3 =
20261003000001–03, D2 = 04, recovery = 05. D2 is sometimes called M4 in code;
it is **not** the deferred delegation migration.

Execute ONLY whole marked blocks by ID. Each block has a readonly marker; probe
means a bounded HTTP request can write admission/security bookkeeping. Use one
root Bash shell per box window and one Mac `/bin/bash` 3.2 shell for preparation.
Never author commands inside a release window. No automatic retries, Actions,
GUI apps, installed Chrome, real Chrome profiles, keychain, or HOME assignments.
W6's human consent is performed by HezLead's separately assigned browser worker;
this plan itself launches no browser. Credentials use existing protected files.
Any separately assigned 1Password recovery must load its service-account token
file for that command only and stage secrets in a new 0700
`mktemp -d /private/tmp/anvil-secret.XXXXXX` directory. No desktop op session.

Image builds: build once per RELEASE_SHA, reuse the persistent local SHA tag
only after checking the source label. `DOCKER_BUILDKIT=0 nice -n 15` plus
`--cpu-period=100000 --cpu-quota=300000` caps sequential build steps at three
CPUs. Unsupported caps or a mismatched tag STOP. Edge uses its measured pinned
runtime image; site builds on the Mac. Never rebuild for each window.

## Inputs, measurements, receipts and window order

`INPUTS_FILE` is an absolute regular nonsecret JSON file, supplied by HezLead.
Use a **new** file/measurement/window ID for each window. Required keys are
enforced by `ai-inputs`; extra/missing keys STOP. It contains:

| Input | Source and validation |
| --- | --- |
| release_sha, plan_sha256, archive_sha256 | Reviewed landed main commit; SHA-256 of this exact RELEASE.md and exact `git archive` tar; no abbreviated identities |
| window, window_id, window_end_utc | W1…W7, six alphanumeric characters, UTC end within 30 minutes on box clock |
| baseline_oauth_sha, baseline_oauth_image | Live OAuth `current`/RELEASE_SHA + container source/image measurement; full SHA/digest |
| baseline_edge_sha, baseline_edge_image | Live edge `current`/RELEASE_SHA, image and immutable bind mounts |
| baseline_stack_sha, baseline_postgres_image | Live stack `current`/RELEASE_SHA and PostgreSQL container image |
| baseline_site_sha, baseline_site_target | Exact source from box site release-name prefix resolved uniquely against repository history; canonical release target |
| baseline_mcp_caddy_sha256, baseline_api_caddy_sha256, baseline_caddyfile_sha256 | SHA-256 of the three live Caddy files; compare on box, never assume repository bytes are live |
| edge_recycle_service, edge_recycle_timer, edge_recycle_sha256 | Exact recycle units discovered from box timer/service inventory and systemctl cat byte digest, remeasured per window |
| baseline_ledger_sha256 | SHA-256 of sorted version lines from live migration ledger, including final newline |
| gate_receipt_sha256 | Independent checker's receipt digest; see GATES.json; exact combined build, no stale lane receipts |
| rollback_decision | `retain-additive` W1; `restore-service` W2–W4; `close-and-reconcile` W5–W7 |
| approval | `null` W1–W4; W5/W7 explicit Tom/HezLead approval object tied to window ID, release, plan digest, action and a nonempty prompt reference; W6 separate consent assignment object |
| legacy_fence_approval | `null` except W3, which requires separate explicit approval of irreversible legacy DB closure with the same release/window/plan binding |

`PLAN_FILE`, `INPUTS_FILE`, `GATE_RECEIPT_FILE` are absolute regular files;
`BOX_ARCHIVE_PATH=/tmp/admin-issuance-<release_sha>-<window_id>.tar` is an
uploaded 0600 tar, exact checksum, never overwritten. `RELEASE_ROOT` and
`PROOF_DIR` are derived at open, not caller-selected. `GATE_RECEIPT_FILE`
contains release_sha, gates, and evidence_root; each gate names a relative
evidence file, its SHA-256, PASS and the exact control set in GATES.json.
The checker supplies the receipt and retained evidence files. This plan checks
their identities and controls; it does not substitute static checks for live
database/provider/client proofs. The checker must refute the combined build.
W1 needs schema, reserve and ordinary-path controls; W5 needs **every** named
gate. W2/W3/W4 also require their build/route/site receipts.

`BACKFILL_FILE` W1 is an absolute regular nonsecret JSON list, one row per
already-applied version: version, released_sha, sha256, file. `file` is exactly
`supabase/migrations/<version>_<name>.sql`. Each row's released_sha is the SHA
actually released when that migration was applied, supported by HezLead's
historical release evidence. The worker reads that file from an immutable
archive of THAT SHA. Do not hash the current checkout for historical backfills,
or copy expected activation hashes into observed evidence. Expected activation
hashes are separately derived from RELEASE_SHA. A mismatch STOPs activation.

| Window | Preflight → open → apply → probes → close; rollback chosen before open |
| --- | --- |
| W1 SCHEMA | ai-inputs, ai-gates, ai-prepare, ai-box-preflight; ai-open, ai-db-session, ai-w1-preflight, ai-w1-apply, ai-w1-reconcile, ai-w1-probes, ai-w1-issuer-credential (HezLead), ai-close. One transaction applies 01→05, then inserts all five ledger/checksum pairs and historical backfills. Failure before COMMIT rolls back the whole transaction. After COMMIT retain additive schema; never drop evidence/history. |
| W2 OAUTH | common ai-inputs/ai-gates/preflight/open/session; ai-w2-preflight, ai-w2-build, ai-w2-apply, ai-w2-local-gate, ai-ordinary-probes, ai-close. On failure ai-w2-rollback, common ordinary controls, then close. Existing ordinary MCP stays ON; admin env is unset and overlay absent. |
| W3 EDGE/CADDY | common ai-inputs/ai-gates/preflight/open/session; ai-w3-preflight, ai-w3-caddy-candidate, ai-w3-apply (close/invalidate, edge switch, terminal legacy fence, measured record, both Caddy routes, validate/reload), ai-w3-probes, ai-w3-readback, ai-close. Failure ai-w3-rollback, ordinary controls, close; legacy fence is permanent. |
| W4 SITE | common preflight; ai-w4-preflight, ai-w4-reference for the generalized site plan's complete preflight/open/build/probe/rollback/close sequence. No browser step without separately assigned QA authorization. Site baseline is remeasured by that plan; admin gate remains closed. |
| W5 ACTIVATION | ai-w5-approval, common preflight/open/session, ai-w5-checks, ai-w5-apply, ai-w5-probes, ai-w5-readback, ordinary controls, ai-close. Activation adds issuer overlay + env 1 + SQL open. Rollback ai-w5-rollback/ai-emergency-close; preserve history, human grant/family reconciliation under separate approved plan. |
| W6 C1 ADMIN SMOKE | ai-w6-preflight (requires explicit path/scope rulings), common preflight/open/session, ai-w6-prepare/transfer, ai-w6-client-check, owner approve, ai-w6-start, audit, human revoke/verify-fenced, fence readback, owner withdrawal, secret close, report, ordinary controls, ai-close. Separate assigned browser consent; accepted workspace residue and W7/W4b site removal. |
| W7 RETIRE | ai-w7-approval, common preflight/open/session, ai-w7-preflight (refuse without C1), ai-w7-proof, ai-close. This build already removes the runtime mint; retirement is proof/attestation, not reintroducing it until W7. Failure ai-emergency-close; never restore opaque authentication. |

After any failure STOP forward work and record the step and fixed failure code in
LOG.md. Do not print exceptions, SQL result rows, docker inspect, resolved env,
token/proof/callback bodies, headers, cookies or request URLs. Private tool
diagnostics live only in SECRET_STAGE and are removed at close. Unknown COMMIT
or command outcome requires read-only reconciliation, never automatic retry.
A failing rollback is an ongoing incident: keep the window open, report it and
retain recovery inputs. Close requires successful probes/recovery and removes
only the exact validated task secret directory with the guarded `rm`; refusal
leaves it in place and reports the exact path/message. Immutable releases and
nonsecret proofs are retained. Closed windows cannot be reused.

## Marked common blocks

```sh
# step: ai-inputs
# readonly: yes
# host: Mac or box /bin/bash 3.2
set -euo pipefail
: "${INPUTS_FILE:?}" "${PLAN_FILE:?}" "${GATE_RECEIPT_FILE:?}"
python3 - "$INPUTS_FILE" "$PLAN_FILE" "$GATE_RECEIPT_FILE" <<'PY'
import datetime, hashlib, json, pathlib, re, sys
def need(ok, reason):
    if not ok: raise SystemExit('FAIL ai-inputs: '+reason+'; STOP')
def regular(name):
    p=pathlib.Path(name)
    need(p.is_absolute() and p.is_file() and not p.is_symlink(), 'regular absolute input file')
    return p
p,plan,receipt=map(regular,sys.argv[1:])
d=json.loads(p.read_text())
keys='release_sha plan_sha256 archive_sha256 window window_id window_end_utc baseline_oauth_sha baseline_oauth_image baseline_edge_sha baseline_edge_image baseline_stack_sha baseline_postgres_image baseline_site_sha baseline_site_target baseline_mcp_caddy_sha256 baseline_api_caddy_sha256 baseline_caddyfile_sha256 baseline_ledger_sha256 gate_receipt_sha256 rollback_decision approval legacy_fence_approval edge_recycle_service edge_recycle_timer edge_recycle_sha256'.split()
need(isinstance(d,dict) and set(d)==set(keys), 'required input keys')
for k in keys:
    if k.endswith('_sha'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{40}',d[k]), k)
    elif k.endswith('_sha256'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{64}',d[k]), k)
    elif k.endswith('_image'):
        need(isinstance(d[k],str) and re.fullmatch('sha256:[0-9a-f]{64}',d[k]), k)
for k,suffix in [('edge_recycle_service','.service'),('edge_recycle_timer','.timer')]:
    need(isinstance(d[k],str) and re.fullmatch(r'[A-Za-z0-9_-]+'+re.escape(suffix),d[k]), k)
need(d['window'] in ['W'+str(x) for x in range(1,8)], 'window')
need(isinstance(d['window_id'],str) and re.fullmatch('[A-Za-z0-9]{6}',d['window_id']), 'window_id')
need(isinstance(d['window_end_utc'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',d['window_end_utc']), 'window_end_utc')
end=datetime.datetime.strptime(d['window_end_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
need(0<(end-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800, 'fresh deadline')
need(re.fullmatch(r'/srv/commonswarm/site/releases/[A-Za-z0-9._-]+',d['baseline_site_target']) is not None, 'site target')
need(hashlib.sha256(plan.read_bytes()).hexdigest()==d['plan_sha256'], 'plan bytes')
need(hashlib.sha256(receipt.read_bytes()).hexdigest()==d['gate_receipt_sha256'], 'checker receipt bytes')
decision={'W1':'retain-additive','W2':'restore-service','W3':'restore-service','W4':'restore-service','W5':'close-and-reconcile','W6':'close-and-reconcile','W7':'close-and-reconcile'}
need(d['rollback_decision']==decision[d['window']], 'rollback decision')
def approval(v,action):
    need(isinstance(v,dict) and set(v)=={'approver','action','release_sha','window_id','plan_sha256','prompt_ref'}, action+' approval required')
    need(v['approver'] in ('Tom','HezLead') and v['action']==action and
         all(v[k]==d[k] for k in ('release_sha','window_id','plan_sha256')) and
         isinstance(v['prompt_ref'],str) and re.fullmatch('[A-Za-z0-9/_.:-]{1,200}',v['prompt_ref']), action+' approval binding')
action={'W5':'activate-admin-issuance','W6':'admin-smoke-human-consent','W7':'retire-legacy-admin-mint'}.get(d['window'])
if action: approval(d['approval'],action)
else: need(d['approval'] is None, 'no implicit activation approval')
if d['window']=='W3': approval(d['legacy_fence_approval'],'terminal-legacy-db-fence')
else: need(d['legacy_fence_approval'] is None, 'legacy fence approval scope')
print('PASS ai-inputs: exact identities, deadline, rollback and approval bindings')
PY
```

```sh
# step: ai-prepare
# readonly: no
# host: Mac /bin/bash 3.2, outside window
set -euo pipefail
# Run ai-inputs first. This step creates nonsecret archive/transport files only.
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
test -z "$(git status --porcelain)"
git fetch origin main
test "$(git rev-parse --verify "${RELEASE_SHA}^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
BASELINE_SITE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_site_sha"])' "$INPUTS_FILE")
test "$(git rev-parse --verify "${BASELINE_SITE_SHA:0:12}^{commit}")" = "$BASELINE_SITE_SHA"
test "$(git remote get-url origin)" = git@github.com:yulanventures/commonswarm.git
PREP_DIR=$(mktemp -d /private/tmp/admin-issuance-prep.XXXXXX)
chmod 0700 "$PREP_DIR"
git archive --format=tar "$RELEASE_SHA" >"$PREP_DIR/release.tar"
git show "${RELEASE_SHA}:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" >"$PREP_DIR/RELEASE.md"
cmp -s "$PLAN_FILE" "$PREP_DIR/RELEASE.md"
ARCHIVE_SHA256=$(shasum -a 256 "$PREP_DIR/release.tar" | awk '{print $1}')
test "$ARCHIVE_SHA256" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")"
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${RELEASE_SHA}-${WINDOW_ID}.tar
chmod 0600 "$PREP_DIR/release.tar"
printf -v REMOTE 'test ! -e %q && (set -C; umask 077; : > %q)' "$BOX_ARCHIVE_PATH" "$BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE"
scp -p "$PREP_DIR/release.tar" "ops@100.115.66.74:$BOX_ARCHIVE_PATH"
printf 'PASS ai-prepare: archive retained at %s; upload %s\n' "$PREP_DIR" "$BOX_ARCHIVE_PATH"
```

```sh
# step: ai-extract
# readonly: no
# host: Mac /bin/bash 3.2, outside window; no execution
set -euo pipefail
: "${PLAN_FILE:?}" "${STEP_ID:?}" "${PREP_DIR:?}"
python3 - "$PLAN_FILE" "$STEP_ID" "$PREP_DIR/step.sh" <<'PY'
import pathlib,re,sys
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1 and re.fullmatch('ai-[a-z0-9-]+',sys.argv[2]), 'FAIL extraction; STOP'
pathlib.Path(sys.argv[3]).write_text(found[0])
PY
/bin/bash -n "$PREP_DIR/step.sh"
```

```sh
# step: ai-recycle-inventory
# readonly: yes
# host: HezLead box root preflight, before window inputs are finalized
set -euo pipefail
python3 - <<'PY'
import hashlib,json,re,subprocess
rows=subprocess.check_output(['systemctl','list-unit-files','--type=timer','--no-legend','--no-pager'],text=True,stderr=subprocess.DEVNULL).splitlines()
found=[]
for row in rows:
    timer=row.split()[0]
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.timer',timer): continue
    services=subprocess.check_output(['systemctl','show','-p','Triggers','--value',timer],text=True,stderr=subprocess.DEVNULL).split()
    for service in services:
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.service',service): continue
        unit=subprocess.check_output(['systemctl','cat',service],text=True,stderr=subprocess.DEVNULL).strip()+'\n'
        if 'docker' in unit and 'restart' in unit and 'commonswarm-edge' in unit:
            found.append({'edge_recycle_timer':timer,'edge_recycle_service':service,'edge_recycle_sha256':hashlib.sha256(unit.encode()).hexdigest()})
assert len(found)==1, 'FAIL unique edge recycle unit discovery required; STOP'
print(json.dumps(found[0],sort_keys=True))
PY
```

```sh
# step: ai-box-preflight
# readonly: yes
# host: approved box root Bash shell; repeat immediately before open
set -euo pipefail
test "$(id -u)" = 0
# ai-inputs has run in this shell with box-local regular input/plan/receipt files.
python3 - "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,re,subprocess,sys
d=json.load(open(sys.argv[1]))
def need(ok,reason):
    if not ok: raise SystemExit('FAIL ai-box-preflight: '+reason+'; STOP')
def output(args): return subprocess.check_output(args,stderr=subprocess.DEVNULL,text=True).strip()
def inspect(name): return json.loads(output(['docker','inspect',name]))[0]
for part,container,service in [('oauth','commonswarm-oauth-oauth-1','oauth'),('edge','commonswarm-edge-edge-runtime-1','edge-runtime')]:
    target=pathlib.Path('/home/commonswarm/'+part+'/current').resolve(strict=True)
    need(str(target)=='/home/commonswarm/'+part+'/releases/'+d['baseline_'+part+'_sha'],part+' current')
    need((target/'RELEASE_SHA').read_text().strip()==d['baseline_'+part+'_sha'],part+' source')
    c=inspect(container); labels=c['Config']['Labels']
    need(c['State'].get('Health',{}).get('Status')=='healthy',part+' healthy')
    need(c['Image']==d['baseline_'+part+'_image'],part+' image')
    need(labels.get('com.docker.compose.project')=='commonswarm-'+part and labels.get('com.docker.compose.service')==service,part+' Compose labels')
    need(labels.get('com.docker.compose.project.working_dir')==str(target/'deploy'/('mcp-auth' if part=='oauth' else 'edge-runtime')),part+' live source mount/working directory')
    env=dict(x.split('=',1) for x in c['Config']['Env'])
    need(env.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED' if part=='oauth' else 'SWARM_MCP_PUBLIC_ENABLED')=='1',part+' ordinary MCP ON')
    need(not any(k.startswith(('SWARM_CMD_TEST_','MCP_OAUTH_TEST_')) for k in env),part+' test-hook absence')
    if part=='oauth':
        label=output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',c['Image']])
        need(label==d['baseline_oauth_sha'],'OAuth image source label')
    else:
        need(c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648,'edge network/memory')
        for destination,source in [('/home/deno/main',target/'deploy/edge-runtime/main'),('/home/deno/functions-source',target/'supabase/functions'),('/var/src',target/'src')]:
            rows=[m for m in c['Mounts'] if m['Destination']==destination]
            need(len(rows)==1 and rows[0]['Source']==str(source) and not rows[0]['RW'],'edge immutable mounts')
stack=pathlib.Path('/home/commonswarm/stack/current').resolve(strict=True)
need(str(stack)=='/home/commonswarm/stack/releases/'+d['baseline_stack_sha'],'stack current')
need((stack/'RELEASE_SHA').read_text().strip()==d['baseline_stack_sha'],'stack source')
need(inspect('commonswarm-postgres')['Image']==d['baseline_postgres_image'],'database image')
need(pathlib.Path('/srv/commonswarm/site/current').resolve(strict=True)==pathlib.Path(d['baseline_site_target']),'site target')
# Site release names encode a source prefix; ai-prepare/site plan resolves it against Git.
site_name=pathlib.Path(d['baseline_site_target']).name
match=re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}',site_name)
need(match is not None and match[1]==d['baseline_site_sha'][:12],'site recorded source prefix')
for name,path in [('mcp','/etc/caddy/sites/20-commonswarm-mcp.caddy'),('api','/etc/caddy/sites/10-commonswarm-api.caddy'),('caddyfile','/etc/caddy/Caddyfile')]:
    key='baseline_'+(name+'_caddy' if name!='caddyfile' else name)+'_sha256'
    p=pathlib.Path(path); need(p.is_file() and not p.is_symlink(),name+' Caddy regular file')
    need(hashlib.sha256(p.read_bytes()).hexdigest()==d[key],name+' Caddy bytes')
need(output(['systemctl','is-active',d['edge_recycle_timer']])=='active','recycle timer active')
need(output(['systemctl','show','-p','ActiveState','--value',d['edge_recycle_service']])=='inactive','recycle service inactive')
need(d['edge_recycle_service'] in output(['systemctl','show','-p','Triggers','--value',d['edge_recycle_timer']]).split(),'timer target')
unit=output(['systemctl','cat',d['edge_recycle_service']])+'\n'
need(hashlib.sha256(unit.encode()).hexdigest()==d['edge_recycle_sha256'],'recycle unit bytes')
need('docker' in unit and 'restart' in unit and 'commonswarm-edge' in unit,'measured edge recycle operation')
need(output(['systemctl','show','-p','User','--value',d['edge_recycle_service']]) in ('','root'),'root recycle unit')
print('PASS ai-box-preflight: baseline reconciled; paths/images/ON flags/Caddy exact')
PY
```

```sh
# step: ai-open
# readonly: no
# host: box root; after repeated inputs/baseline preflight
set -euo pipefail
umask 077
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
WINDOW=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window"])' "$INPUTS_FILE")
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${RELEASE_SHA}-${WINDOW_ID}.tar
PROOF_DIR=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-${WINDOW}-${WINDOW_ID}
RELEASE_ROOT=/home/commonswarm/admin-issuance/releases/$RELEASE_SHA
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR"
: "${LIVE_CONTROLS_FILE:?reviewed live authenticated before controls required}"
python3 - "$INPUTS_FILE" "$LIVE_CONTROLS_FILE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[2]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
d=json.load(open(sys.argv[1])); r=json.loads(p.read_text())
assert set(r)=={'release_sha','window_id','window','phase','controls'} and r['phase']=='before'
assert all(r[k]==d[k] for k in ('release_sha','window_id','window'))
assert set(r['controls'])=={'hosted_mcp_consent_refresh','dcr_registration_consent','cimd_consent','human_recovery','worker_command_read'} and all(v is True for v in r['controls'].values()), 'FAIL live before controls; STOP before open'
PY
test -f "$BOX_ARCHIVE_PATH" && test ! -L "$BOX_ARCHIVE_PATH"
test "$(stat -c %a "$BOX_ARCHIVE_PATH")" = 600
test "$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")"
mkdir -p "$PROOF_DIR"
chmod 0700 "$PROOF_DIR"
install -m 0600 "$LIVE_CONTROLS_FILE" "$PROOF_DIR/ordinary-before.json"
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
# Retain nonsecret cleanup pointer immediately; never guess it after failed open.
printf '%s\n' "$SECRET_STAGE" >"$PROOF_DIR/secret-stage.path"
install -m 0600 "$INPUTS_FILE" "$PROOF_DIR/inputs.json"
install -m 0600 "$GATE_RECEIPT_FILE" "$PROOF_DIR/gates.json"
if test ! -e "$RELEASE_ROOT"; then
 mkdir -p "$RELEASE_ROOT"
 python3 - "$BOX_ARCHIVE_PATH" "$RELEASE_ROOT" <<'PY'
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]); assert root.resolve(strict=True)==root
with tarfile.open(sys.argv[1]) as archive:
    for m in archive.getmembers():
        rel=pathlib.PurePosixPath(m.name)
        assert not rel.is_absolute() and '..' not in rel.parts and (m.isfile() or m.isdir() or m.issym())
    archive.extractall(root,filter='data')
PY
 printf '%s\n' "$RELEASE_SHA" >"$RELEASE_ROOT/RELEASE_SHA"
else
 test ! -L "$RELEASE_ROOT"
 test "$(cat "$RELEASE_ROOT/RELEASE_SHA")" = "$RELEASE_SHA"
fi
# Exact archive reconciliation of all tracked files, including on reuse.
python3 - "$BOX_ARCHIVE_PATH" "$RELEASE_ROOT" <<'PY'
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]); assert root.resolve(strict=True)==root
with tarfile.open(sys.argv[1]) as archive:
    for m in archive.getmembers():
        p=root/m.name
        assert not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts
        if m.isfile(): assert not p.is_symlink() and p.read_bytes()==archive.extractfile(m).read(), 'FAIL archive bytes; STOP'
        elif m.issym(): assert p.is_symlink() and p.readlink().as_posix()==m.linkname
        else: assert m.isdir() and p.is_dir()
PY
test "$(sha256sum "$RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plan_sha256"])' "$INPUTS_FILE")"
cp /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
cp /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
cp /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cp /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy"
cp /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.caddy"
chmod 0600 "$SECRET_STAGE/"*
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/open.txt"
printf 'PASS ai-open: %s; secret cleanup pointer retained\n' "$WINDOW"
```

```sh
# step: ai-db-session
# readonly: no
# host: box root; task files only, database queries read-only until apply
set -euo pipefail
test -f "$PROOF_DIR/open.txt" && test ! -e "$PROOF_DIR/closed.txt"
MIGRATE=$RELEASE_ROOT/deploy/supabase-stack/migrate
PGSERVICE_FILE=$SECRET_STAGE/service.conf
PGPASS_FILE=$SECRET_STAGE/pass
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL
PG_SERVICE_OUTPUT="$PGSERVICE_FILE" PG_PASS_OUTPUT="$PGPASS_FILE" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "$MIGRATE/make-pg-service.mjs" >"$SECRET_STAGE/db-session.log" 2>&1
chmod 0600 "$PGSERVICE_FILE" "$PGPASS_FILE"
EDGE_RECYCLE_SERVICE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_service"])' "$INPUTS_FILE")
EDGE_RECYCLE_TIMER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_timer"])' "$INPUTS_FILE")
PSQL_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_postgres_image"])' "$INPUTS_FILE")
ai_db() {
 docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
  --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$PGSERVICE_FILE:/run/service.conf:ro" --volume "$PGPASS_FILE:/run/pass:ro" \
  --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
  --volume "$RELEASE_ROOT:/release:ro" --volume "$PROOF_DIR:/proof:ro" \
  --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 "$@" 2>"$SECRET_STAGE/psql.log"
}
ai_ro() { ai_db --command 'SET default_transaction_read_only=on;' "$@"; }
python3 - "$MIGRATE/lib.sh" "$PROOF_DIR/identity.sql" <<'PY'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
part=source.split('assert_target_identity() {\n',1)[1].split('\nassert_backup_ro_identity()',1)[0]
sql=part.split("<<'SQL'\n",1)[1].split('\nSQL',1)[0]
assert "current_user <> 'supabase_admin'" in sql and 'rolsuper' in sql
pathlib.Path(sys.argv[2]).write_text(sql+'\n')
PY
ai_ro -q --file /proof/identity.sql >/dev/null
ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-before.txt"
test "$(sha256sum "$PROOF_DIR/ledger-before.txt" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_ledger_sha256"])' "$INPUTS_FILE")"
ai_run() {
 local STEP_NAME=$1
 case "$STEP_NAME" in ai-inputs|ai-gates|ai-w5-approval|ai-w7-approval|ai-w7-preflight|ai-recycle-install|ai-recycle-rollback|ai-w5-rollback|ai-emergency-close) ;; *) return 1;; esac
 python3 - "$RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" "$STEP_NAME" "$SECRET_STAGE/step-$STEP_NAME.sh" <<'PY'
import pathlib,re,sys
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: '+sys.argv[2]+'\n')]
assert len(found)==1
pathlib.Path(sys.argv[3]).write_text(found[0])
PY
 /bin/bash -n "$SECRET_STAGE/step-$STEP_NAME.sh"
 . "$SECRET_STAGE/step-$STEP_NAME.sh"
}
ai_deadline() {
 test ! -e "$PROOF_DIR/closed.txt"
 python3 - "$INPUTS_FILE" <<'PY'
import datetime,json,sys
end=datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))['window_end_utc'].replace('Z','+00:00'))
assert datetime.datetime.now(datetime.timezone.utc)<end, 'FAIL window expired; STOP'
PY
}
printf 'PASS ai-db-session: target identity and exact ledger baseline'
```

```sh
# step: ai-gates
# readonly: yes
# host: Mac or box; private evidence files are NOT accepted
set -euo pipefail
: "${INPUTS_FILE:?}" "${GATE_RECEIPT_FILE:?}" "${PLAN_FILE:?}"
python3 - "$INPUTS_FILE" "$GATE_RECEIPT_FILE" "$PLAN_FILE" <<'PY'
import hashlib,json,pathlib,sys
d=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
contract=json.loads((pathlib.Path(sys.argv[3]).parent/'GATES.json').read_text())
def need(ok,reason):
    if not ok: raise SystemExit('FAIL ai-gates: '+reason+'; STOP')
need(set(r)=={'release_sha','gates','evidence_root'} and r['release_sha']==d['release_sha'],'same-build receipt')
root=pathlib.Path(r['evidence_root']); need(root.is_absolute() and root.is_dir() and not root.is_symlink(),'evidence root')
required=contract['windows'][d['window']]
for name in required:
    g=r['gates'].get(name)
    need(isinstance(g,dict) and set(g)=={'status','controls','file','sha256'} and g['status']=='PASS',name+' PASS')
    need(g['controls']==contract['gates'][name],name+' positive/negative controls')
    rel=pathlib.PurePosixPath(g['file'])
    need(not rel.is_absolute() and '..' not in rel.parts and bool(rel.parts),name+' relative file')
    p=root/rel
    need(p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root.resolve()),name+' evidence file')
    need(hashlib.sha256(p.read_bytes()).hexdigest()==g['sha256'],name+' evidence digest')
print('PASS ai-gates: required same-build controls and retained evidence')
PY
```

```sh
# step: ai-ordinary-probes
# readonly: probe
# host: Mac outside ingress; run before open and after every window/recovery
set -euo pipefail
python3 - <<'PY'
import json,urllib.error,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
checks=[('https://mcp.commonswarm.com/health','GET',None,200),
 ('https://mcp.commonswarm.com/.well-known/oauth-authorization-server','GET',None,200),
 ('https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp','GET',None,200),
 ('https://mcp.commonswarm.com/mcp','POST',b'{}',401),
 ('https://api.commonswarm.com/auth/v1/health','GET',None,200),
 ('https://commonswarm.com/app/','GET',None,200)]
for index,(url,method,data,expected) in enumerate(checks):
    req=urllib.request.Request(url,method=method,data=data,headers={'User-Agent':'curl/8.7.1','Content-Type':'application/json'})
    try: response=opener.open(req,timeout=15)
    except urllib.error.HTTPError as error: response=error
    with response:
        body=response.read(1048577)
        assert len(body)<=1048576 and response.status==expected, 'FAIL ordinary route '+str(index)+'; STOP'
print('PASS ordinary route probes; authenticated path evidence is separately required')
PY
```

Authenticated ordinary hosted MCP consent/refresh, DCR registration/consent,
CIMD metadata/consent, fresh human recovery and worker command/read probes are
required in `ordinary-paths-unchanged` (GATES.json). Anonymous 401 alone proves
no authenticated behavior. W1/W2/W3/W4 forward close refuses without a fresh
window-bound live ordinary receipt via ai-live-controls. The worker uses the
already reviewed hosted ordinary client procedure, with only its explicitly
authorized browser seat performing consent, and retains redacted receipts.
If that procedure/credentials are not supplied, STOP before the window opens.

```sh
# step: ai-live-controls
# readonly: yes
# host: box; read independently produced, nonsecret window probes
set -euo pipefail
: "${LIVE_CONTROLS_FILE:?}"
python3 - "$INPUTS_FILE" "$LIVE_CONTROLS_FILE" "$PROOF_DIR" <<'PY'
import json,pathlib,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
r=json.loads(p.read_text())
assert set(r)=={'release_sha','window_id','window','phase','controls'}
assert all(r[k]==d[k] for k in ('release_sha','window_id','window'))
assert r['phase'] in ('before','after','recovery')
expected={'hosted_mcp_consent_refresh','dcr_registration_consent','cimd_consent','human_recovery','worker_command_read'}
assert set(r['controls'])==expected and all(r['controls'][k] is True for k in expected), 'FAIL live controls; STOP'
pathlib.Path(sys.argv[3],'ordinary-'+r['phase']+'.json').write_text(json.dumps(r,sort_keys=True)+'\n')
print('PASS live authenticated ordinary controls')
PY
```

HezLead supplies the independently generated live-controls receipt before
open and after each window. This plan only validates that external input; no
operator-authored probe is permitted during the release window.

## W1: one schema window before any code release

All five migrations share **one outer transaction**. This solves the ordering
constraint: the checksum table first exists after 04, so record the 01–05
ledger/checksum pairs after 05, before the same COMMIT. Do not preapply 04,
autocommit 01–03, or claim a ledger-only prefix is a successful D2 release.
The applying principal is the runbook's verified non-superuser `supabase_admin`
with CREATEROLE and narrow ledger access. Checksum inserts explicitly use
`SET LOCAL ROLE commonswarm_admin_release`, then RESET ROLE. No runtime writes.

Reserve files are the five exact `supabase/admin-delegation-reserve/*` siblings,
copied verbatim into this plan's `reserve/` directory. `ai-w1-preflight` checks
them against the source archive and requires independently executed empty
reverse/reapply catalog controls. They are data-free inverses, **not a production
post-COMMIT rollback**. 04 refuses any checksum evidence; 01 refuses existing
ordinary provider artifacts/bindings. This live box already hosts ordinary
OAuth, so deleting its rows to make a reserve pass is forbidden. On apply
failure PostgreSQL rolls back all DDL/ledger/checksums. On uncertain COMMIT use
ai-w1-reconcile. After a successful COMMIT retain additive schema, leave gates
closed, and stop code rollout if probes fail. No historical data is dropped.

`HISTORICAL_ARCHIVES_DIR` is a root-owned directory of immutable reviewed
`<released_sha>.tar` archives from the historical release inputs. The W1
backfill verifier checks every archive's migration bytes against BACKFILL_FILE.
It also checks the current files: if historical and reviewed hashes disagree,
STOP rather than changing observed evidence to fit a new build.

```sh
# step: ai-w1-preflight
# readonly: no
# host: box root; database read-only, writes proof files
set -euo pipefail
test "$WINDOW" = W1
ai_deadline
: "${BACKFILL_FILE:?}" "${HISTORICAL_ARCHIVES_DIR:?}"
test -f "$PROOF_DIR/ordinary-before.json"
python3 - "$RELEASE_ROOT" "$PROOF_DIR" "$BACKFILL_FILE" "$HISTORICAL_ARCHIVES_DIR" "$RELEASE_SHA" <<'PY'
import hashlib,json,pathlib,re,sys,tarfile
root,proof,backfill,archives=map(pathlib.Path,sys.argv[1:5]); sha=sys.argv[5]
assert backfill.is_absolute() and backfill.is_file() and not backfill.is_symlink()
assert archives.is_absolute() and archives.is_dir() and not archives.is_symlink()
rows=json.loads(backfill.read_text()); ledger=(proof/'ledger-before.txt').read_text().splitlines()
versions=['2026100300000'+str(i) for i in range(1,6)]
assert not any(v in ledger for v in versions), 'FAIL W1 unexpected applied prefix; STOP'
assert all(v in ledger for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']), 'FAIL prerequisites; STOP'
assert isinstance(rows,list) and len(rows)==len(ledger) and sorted(r['version'] for r in rows)==ledger
for r in rows:
    assert set(r)=={'version','released_sha','sha256','file'}
    assert re.fullmatch('[0-9]{14}',r['version']) and re.fullmatch('[0-9a-f]{40}',r['released_sha']) and re.fullmatch('[0-9a-f]{64}',r['sha256'])
    assert re.fullmatch('supabase/migrations/'+r['version']+'_[a-z0-9_]+.sql',r['file'])
    archive=archives/(r['released_sha']+'.tar')
    assert archive.is_file() and not archive.is_symlink()
    with tarfile.open(archive) as t:
        member=t.getmember(r['file']); assert member.isfile()
        original=t.extractfile(member).read()
    assert hashlib.sha256(original).hexdigest()==r['sha256'], 'FAIL historical backfill hash; STOP'
    assert (root/r['file']).read_bytes()==original, 'FAIL historical/current migration drift; STOP'
records=[]
for v in versions:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    reserve=root/'supabase/admin-delegation-reserve'/(v+'-rollback.sql')
    plan_reserve=root/'docs/evidence/2026-10-03-admin-issuance-release/reserve'/(v+'-rollback.sql')
    assert reserve.read_bytes()==plan_reserve.read_bytes(), 'FAIL reserve bytes; STOP'
    records.append({'version':v,'file':files[0].name,'sha256':hashlib.sha256(files[0].read_bytes()).hexdigest()})
(proof/'new-migrations.json').write_text(json.dumps(records,sort_keys=True)+'\n')
(proof/'backfill.json').write_text(json.dumps(rows,sort_keys=True)+'\n')
# Snapshot the reviewed expected set separately; never use this as historical evidence.
required=['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+versions
expected={}
for v in required:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    expected[v]=hashlib.sha256(files[0].read_bytes()).hexdigest()
(proof/'expected-migrations.json').write_text(json.dumps(expected,sort_keys=True)+'\n')
PY
# Current backup/restore evidence is read-only; neither starts an Actions run nor a drill.
python3 - /var/backups/commonswarm-postgres/status.json <<'PY'
import datetime,json,sys
r=json.load(open(sys.argv[1]))
assert all(r.get(k) is True for k in ('ok','database_bytes_verified','object_bytes_verified'))
age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(r['verified_at'].replace('Z','+00:00'))).total_seconds()
assert -300<=age<86400 and r['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/'), 'FAIL backup gate; STOP'
PY
# Before proofs: all reverse catalogs must be true, without invoking a reserve.
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-rollback-catalog.sql\nSELECT :\x27rollback_ok\x27::boolean;\n' "$VERSION" >"$PROOF_DIR/catalog.sql"
 test "$(ai_ro -Atq --file /proof/catalog.sql)" = t
done
ai_ro -Atq --command "SELECT n.nspname,p.proname,p.prosecdef,p.proconfig::text,pg_get_userbyid(p.proowner),p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2,p.oid;" >"$PROOF_DIR/functions-before.txt"
ai_ro -Atq --command "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2;" >"$PROOF_DIR/relations-before.txt"
ai_ro -Atq --command 'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles ORDER BY rolname;' >"$PROOF_DIR/roles-before.txt"
printf 'PASS W1 preflight: exact ledger/backfill/reserves/catalogs; backup fresh\n'
```

```sh
# step: ai-w1-apply
# readonly: no
# host: box root; one transaction; no code or gate change
set -euo pipefail
test "$WINDOW" = W1
ai_deadline
test -f "$PROOF_DIR/new-migrations.json" && test ! -e "$PROOF_DIR/schema-attempted.txt"
ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-now.txt"
cmp -s "$PROOF_DIR/ledger-before.txt" "$PROOF_DIR/ledger-now.txt"
python3 - "$PROOF_DIR" "$RELEASE_SHA" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); sha=sys.argv[2]
new=json.loads((p/'new-migrations.json').read_text()); old=json.loads((p/'backfill.json').read_text())
sql=["BEGIN;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='10min';",
 "LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;",
 "DO $shape$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='supabase_migrations' AND table_name='schema_migrations' AND column_name<>'version' AND is_nullable='NO' AND column_default IS NULL) THEN RAISE EXCEPTION 'ledger requires more than version'; END IF; END $shape$;"]
# Transaction starts before 01. The D2 table exists after 04. No ledger/checksum is committed early.
for r in new:
    sql.append('\\i /release/supabase/migrations/'+r['file'])
for r in new:
    sql+= ["INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('"+r['version']+"');",
        'SET LOCAL ROLE commonswarm_admin_release;',
        "INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES ('"+r['version']+"','"+r['sha256']+"','release','"+sha+"');", 'RESET ROLE;']
for r in old:
    sql+=['SET LOCAL ROLE commonswarm_admin_release;',
        "INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES ('"+r['version']+"','"+r['sha256']+"','backfill','"+r['released_sha']+"');", 'RESET ROLE;']
for r in new:
    sql+=['\\i /release/deploy/release-proofs/item-ai/'+r['version']+'-catalog.sql',
      "SELECT :'catalog_ok'::boolean AS ai_catalog_pass \\gset", '\\if :ai_catalog_pass', '\\else',
      "DO $$ BEGIN RAISE EXCEPTION 'admin catalog failed'; END $$;", '\\endif']
sql+= ["DO $$ BEGIN IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE admin_issuance_enabled OR legacy_closed OR measured_at IS NOT NULL) THEN RAISE EXCEPTION 'schema must remain dormant'; END IF; END $$;", 'COMMIT;']
(p/'apply.sql').write_text('\n'.join(sql)+'\n')
PY
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/schema-attempted.txt"
# No ERR trap retries this. Disconnect at COMMIT means unknown outcome.
ai_db -q --file /proof/apply.sql >"$SECRET_STAGE/apply.out"
printf 'PASS W1 transaction returned COMMIT; require independent readback\n'
```

```sh
# step: ai-w1-reconcile
# readonly: no
# host: box root; database read-only, available after timeout/unknown COMMIT
set -euo pipefail
ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-after.txt"
ai_ro -Atq --command 'SELECT version,sha256,source,released_sha FROM commonswarm_ops.migration_checksums ORDER BY version;' >"$PROOF_DIR/checksums-after.txt"
python3 - "$PROOF_DIR" "$RELEASE_SHA" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); new=json.loads((p/'new-migrations.json').read_text()); old=json.loads((p/'backfill.json').read_text())
expected=['|'.join([r['version'],r['sha256'],'release',sys.argv[2]]) for r in new]
expected+=['|'.join([r['version'],r['sha256'],'backfill',r['released_sha']]) for r in old]
assert (p/'ledger-after.txt').read_text().splitlines()==sorted(r['version'] for r in new+old)
assert (p/'checksums-after.txt').read_text().splitlines()==sorted(expected), 'FAIL D2 readback; STOP'
(p/'schema-committed.txt').write_text('all five ledger/checksum pairs and backfills exact\n')
PY
```

If the checksum relation is absent after an unknown COMMIT, reconciliation
STOPs; the window is not retried. HezLead compares the entire ledger and reverse
catalogs with the before receipt in a separate read-only diagnosis. No command
in this plan erases partially observed state.

```sh
# step: ai-w1-probes
# readonly: no
# host: box root; database read-only, proof files only
set -euo pipefail
test "$WINDOW" = W1
test -f "$PROOF_DIR/schema-committed.txt"
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$PROOF_DIR/catalog.sql"
 test "$(ai_ro -Atq --file /proof/catalog.sql)" = t
 printf '%s catalog=t\n' "$VERSION" >>"$PROOF_DIR/catalog-after.txt"
done
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND NOT legacy_closed AND measured_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
ai_ro -Atq --command "SELECT n.nspname,p.proname,p.prosecdef,p.proconfig::text,pg_get_userbyid(p.proowner),p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2,p.oid;" >"$PROOF_DIR/functions-after.txt"
ai_ro -Atq --command "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2;" >"$PROOF_DIR/relations-after.txt"
ai_ro -Atq --command 'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles ORDER BY rolname;' >"$PROOF_DIR/roles-after.txt"
printf 'PASS W1 catalogs, ACL/RLS/search-path/owner inventory; issuance OFF\n'
printf 'PASS\n' >"$PROOF_DIR/W1-probes.txt"
```

The schema receipt must independently prove positive status resolver/foreign
denial, FK/resource/unique binding, replay TTL/cleanup, append-only audit, issuer
grants/NOINHERIT/local-role isolation, tombstone/upsert, D2 ledger atomicity and
D3 cap/count/action/security-bucket controls. Catalogs alone are insufficient.
ai-gates enforces these named controls before any schema apply.

## HezLead box block: W1 issuer credential

Run after ai-w1-reconcile/ai-w1-probes, before W1 close. The password is
created on the box, never printed and never copied to the Mac or 1Password
this window (HezLead's ruling). The AS format is JSON `{user,password}`.
The fresh role has no existing credential; an existing file stops this initial
provisioning. Rotation is a separate credential window alongside management.
Rollback disables login and clears the new password; it retains additive schema.

```sh
# step: ai-w1-issuer-credential
# readonly: no
# host: HezLead ONLY, box root, W1 schema window
set -euo pipefail
test "$WINDOW" = W1
ai_deadline
test -f "$PROOF_DIR/schema-committed.txt"
test ! -e /etc/commonswarm-oauth/admin-issuer-database-credentials
test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials
openssl rand -hex 32 >"$SECRET_STAGE/issuer-password"
chmod 0600 "$SECRET_STAGE/issuer-password"
python3 - "$SECRET_STAGE" <<'PY'
import configparser,json,pathlib,re,sys
try:
    p=pathlib.Path(sys.argv[1]); value=(p/'issuer-password').read_text().strip()
    assert re.fullmatch('[0-9a-f]{64}',value)
    (p/'issuer.json').write_text(json.dumps({'user':'commonswarm_admin_issuer','password':value})+'\n')
    # Value is in a stdin SQL file only, never in argv, env or nonsecret proof.
    (p/'issuer.sql').write_text("SET password_encryption='scram-sha-256'; ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD '"+value+"';\n")
    c=configparser.ConfigParser(interpolation=None); c.read(p/'service.conf')
    assert c.has_section('target'); c['target']['user']='commonswarm_admin_issuer'
    with (p/'issuer-service.conf').open('w') as f: c.write(f)
    rows=(p/'pass').read_text().splitlines(); assert len(rows)==1
    parts=rows[0].split(':'); assert len(parts)==5
    (p/'issuer-pass').write_text(':'.join(parts[:3]+['commonswarm_admin_issuer',value])+'\n')
    for name in ['issuer.json','issuer.sql','issuer-service.conf','issuer-pass']: (p/name).chmod(0o600)
except Exception:
    raise SystemExit('FAIL issuer credential preparation; STOP') from None
PY
ai_db -q --file - <"$SECRET_STAGE/issuer.sql" >"$SECRET_STAGE/issuer-alter.log"
install -o root -g 986 -m 0440 "$SECRET_STAGE/issuer.json" /etc/commonswarm-oauth/admin-issuer-database-credentials
test "$(stat -c '%a %u %g' /etc/commonswarm-oauth/admin-issuer-database-credentials)" = '440 0 986'
docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
 --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
 --volume "$SECRET_STAGE/issuer-service.conf:/run/service.conf:ro" \
 --volume "$SECRET_STAGE/issuer-pass:/run/pass:ro" \
 --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
 --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 -Atq \
 --command "SELECT current_user='commonswarm_admin_issuer' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;" \
 >"$SECRET_STAGE/issuer-login.result" 2>"$SECRET_STAGE/issuer-login.log"
test "$(cat "$SECRET_STAGE/issuer-login.result")" = t
printf 'PASS issuer login; credential 0440 root:986; password stays on box\n' >"$PROOF_DIR/issuer-credential.txt"
```

```sh
# step: ai-w1-issuer-rollback
# readonly: no
# host: HezLead ONLY, box root; failed initial provisioning, not a rotation
set -euo pipefail
test "$WINDOW" = W1
ai_db -q --command 'ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;' >/dev/null
if test -e /etc/commonswarm-oauth/admin-issuer-database-credentials; then
 test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials
 rm -- /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL guarded issuer cleanup refused; STOP\n' >&2; exit 1; }
fi
test "$(ai_ro -Atq --command "SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='commonswarm_admin_issuer';")" = t
printf 'PASS issuer login disabled; additive roles/grants retained\n' >"$PROOF_DIR/issuer-rollback.txt"
```

## W2: OAuth code release, ordinary MCP ON, issuance admin activation OFF

W2 keeps ordinary MCP ON with the management overlay. It omits the
admin-issuer overlay and leaves the activation environment variable unset. All baseline Compose files must be exactly the two reviewed base and
management files. No unreviewed override is silently dropped. Store resolved
config and diagnostics only inside SECRET_STAGE. Source and image identity
are independently checked; local image ID is an immutable sha256 reference.

```sh
# step: ai-w2-preflight
# readonly: no
# host: box root; config snapshots only
set -euo pipefail
test "$WINDOW" = W2
ai_deadline
test -f "$PROOF_DIR/ordinary-before.json"
BASELINE_OAUTH_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_oauth_sha"])' "$INPUTS_FILE")
OLD_OAUTH=/home/commonswarm/oauth/releases/$BASELINE_OAUTH_SHA
NEW_OAUTH=/home/commonswarm/oauth/releases/$RELEASE_SHA
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' commonswarm-oauth-oauth-1)" = "$OLD_OAUTH/deploy/mcp-auth/compose.yaml,$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml"
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" "$RELEASE_ROOT/deploy/mcp-auth/compose.yaml"
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" "$RELEASE_ROOT/deploy/mcp-auth/compose.management.yaml"
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
python3 - /etc/commonswarm-oauth/service.env <<'PY'
import pathlib,sys
rows=pathlib.Path(sys.argv[1]).read_text().splitlines()
assert not any(r.split('=',1)[0] in ('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE') for r in rows), 'FAIL W2 admin env must be unset; STOP'
PY
test ! -e "$NEW_OAUTH" && test ! -L "$NEW_OAUTH"
mkdir -p "$NEW_OAUTH"
cp -a "$RELEASE_ROOT/." "$NEW_OAUTH/"
printf 'PASS W2 baseline Compose exact; schema present; admin activation OFF\n'
```

```sh
# step: ai-w2-build
# readonly: no
# host: box root; build once, CPU-capped
set -euo pipefail
test "$WINDOW" = W2
ai_deadline
IMAGE_TAG=commonswarm-oauth:release-$RELEASE_SHA
CACHED=$(docker image ls --no-trunc --quiet --filter "reference=$IMAGE_TAG")
if test -n "$CACHED"; then
 IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
 test "$IMAGE" = "$CACHED"
else
 test "$(docker info --format '{{.CPUCfsPeriod}} {{.CPUCfsQuota}}')" = 'true true'
 DOCKER_BUILDKIT=0 nice -n 15 docker build --pull=false \
  --cpu-period=100000 --cpu-quota=300000 --tag "$IMAGE_TAG" \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --file "$NEW_OAUTH/services/mcp-auth/Dockerfile" "$NEW_OAUTH" >"$SECRET_STAGE/build.log" 2>&1
 IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
fi
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$RELEASE_SHA"
printf '%s\n' "$IMAGE" >"$PROOF_DIR/oauth-image.id"
docker run --rm --network none --entrypoint node "$IMAGE" --input-type=module -e \
 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.dependencies["oidc-provider"]!=="9.12.2" || !fs.existsSync("src/admin-authority.generated.js")) process.exit(1)' >/dev/null 2>&1
printf 'PASS W2 CPU-capped image; immutable source label; admin activation OFF\n'
```

```sh
# step: ai-w2-apply
# readonly: no
# host: box root; existing ON configuration, one service recreation
set -euo pipefail
test "$WINDOW" = W2
ai_deadline
test ! -e "$PROOF_DIR/oauth-attempted.txt"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
python3 - "$SECRET_STAGE/compose.env" "$PROOF_DIR/oauth-image.id" "$SECRET_STAGE/compose.new.env" <<'PY'
import pathlib,re,sys
source=pathlib.Path(sys.argv[1]).read_text(); image=pathlib.Path(sys.argv[2]).read_text().strip()
assert re.fullmatch('sha256:[0-9a-f]{64}',image)
assert len(re.findall(r'^MCP_OAUTH_IMAGE=.*$',source,re.M))==1
target=re.sub(r'^MCP_OAUTH_IMAGE=.*$','MCP_OAUTH_IMAGE='+image,source,flags=re.M)
pathlib.Path(sys.argv[3]).write_text(target)
PY
chmod 0600 "$SECRET_STAGE/compose.new.env"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/oauth-attempted.txt"
install -o root -g root -m 0600 "$SECRET_STAGE/compose.new.env" /etc/commonswarm-oauth/compose.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" -f "$NEW_OAUTH/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/recreate.log" 2>&1
ln -s "$NEW_OAUTH" /home/commonswarm/oauth/current.admin-issuance
mv -Tf /home/commonswarm/oauth/current.admin-issuance /home/commonswarm/oauth/current
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$(cat "$PROOF_DIR/oauth-image.id")"
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
printf 'PASS W2 applied; require all probes before close\n'
```

```sh
# step: ai-w2-probes
# readonly: probe
# host: Mac outside ingress; protected values never printed
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
for base in ['https://mcp.commonswarm.com']:
    for method in ['GET','HEAD']:
        req=urllib.request.Request(base+'/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
        with urllib.request.urlopen(req,timeout=15) as r:
            body=r.read(4097)
            assert r.status==200 and len(body)<=4096
            assert json.loads(body)=={'state':'closed'} if method=='GET' else body==b''
print('PASS W2 GET/HEAD gate closed')
PY
```

Before W3, the live Caddy may not route `/admin/gate`. W2 must still probe the
new AS directly at loopback (ai-w2-local-gate); a public 404 is retained as
expected **unavailable ingress**, never treated as gate closed. Run public
ai-w2-probes only if baseline Caddy already serves that route; W3 makes it
mandatory with CORS. Baseline route availability is measured, never guessed.

```sh
# step: ai-w2-local-gate
# readonly: probe
# host: box root
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:3490/admin/gate',timeout=15) as r:
    assert r.status==200 and json.loads(r.read(4096))=={'state':'closed'}
print('PASS local AS /admin/gate closed')
PY
printf 'PASS\n' >"$PROOF_DIR/W2-probes.txt"
```

```sh
# step: ai-w2-rollback
# readonly: no
# host: box root; deadline does not prevent recovery
set -euo pipefail
test "$WINDOW" = W2
install -o root -g root -m 0600 "$SECRET_STAGE/compose.env" /etc/commonswarm-oauth/compose.env
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" -f "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/rollback.log" 2>&1
ln -s "$OLD_OAUTH" /home/commonswarm/oauth/current.admin-issuance
mv -Tf /home/commonswarm/oauth/current.admin-issuance /home/commonswarm/oauth/current
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_oauth_image"])' "$INPUTS_FILE")"
printf 'PASS W2 baseline image restored; verify ordinary controls before close\n'
```

## W3: edge, permanent legacy closure, operator measurement and Caddy

The canonical admin resource is **api.commonswarm.com/admin**, not an alias on
the MCP hostname. Define its snippet in the MCP Caddy fragment, import it in
the API site's routing before the API catchall, and put the credential-free
GET/HEAD `/admin/gate` on mcp.commonswarm.com where `/app` reads it. Preserve the
AS's `Access-Control-Allow-Origin: *`. Preflight compares LIVE bytes with the
expected baseline hashes. API/OAuth/MCP ingress must retain existing routes.
DPoP and DPoP-Nonce log fields are removed on both sites, alongside existing
query/cookie/auth redaction. Raw logs are never release evidence.

Before switching/recreating/rolling back edge, close DB issuance and invalidate
the measurement in a committed release-role transaction. The recycle timer is
paused only during this window and restored on success/failure. HezLead installs the marked recycle hooks before restoring the timer. They
invalidate before restart and remeasure afterward; failed measurement keeps
issuance closed. Other edge release paths must use the same marked hooks. Readiness JSON is diagnostic only.

```sh
# step: ai-w3-preflight
# readonly: no
# host: box root; files only, database read-only
set -euo pipefail
test "$WINDOW" = W3
ai_deadline
test -f "$PROOF_DIR/ordinary-before.json"
BASELINE_EDGE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_edge_sha"])' "$INPUTS_FILE")
OLD_EDGE=/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA
NEW_EDGE=/home/commonswarm/edge/releases/$RELEASE_SHA
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' commonswarm-edge-edge-runtime-1)" = "$OLD_EDGE/deploy/edge-runtime/compose.yaml,$OLD_EDGE/deploy/edge-runtime/compose.override.yaml"
test -f "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" && test ! -L "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml"
test ! -e "$NEW_EDGE" && test ! -L "$NEW_EDGE"
mkdir -p "$NEW_EDGE"
cp -a "$RELEASE_ROOT/." "$NEW_EDGE/"
cp "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml" -f "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" \
 config --format json >"$SECRET_STAGE/edge-render.json" 2>"$SECRET_STAGE/render.log"
python3 - "$SECRET_STAGE/edge-render.json" "$INPUTS_FILE" <<'PY'
import json,subprocess,sys
c=json.load(open(sys.argv[1]))['services']['edge-runtime']; d=json.load(open(sys.argv[2]))
assert c['network_mode']=='commonswarm-net' and c['mem_limit']==2147483648
assert c['environment']['SWARM_MCP_PUBLIC_ENABLED']=='1'
assert not any(k.startswith(('SWARM_CMD_TEST_','MCP_OAUTH_TEST_')) for k in c['environment'])
live=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
image=json.loads(subprocess.check_output(['docker','image','inspect',d['baseline_edge_image']],stderr=subprocess.DEVNULL))[0]
expected=dict(x.split('=',1) for x in image['Config'].get('Env',[])); expected.update(c['environment'])
assert expected==dict(x.split('=',1) for x in live['Config']['Env']), 'FAIL effective edge environment drift; STOP'
PY
printf 'PASS W3 source, reviewed override, network/memory and ON flags\n'
```

```sh
# step: ai-w3-caddy-candidate
# readonly: no
# host: box root; candidate files only; before edge mutation
set -euo pipefail
test "$WINDOW" = W3
python3 - "$SECRET_STAGE" <<'PY'
import pathlib
p=pathlib.Path(__import__('sys').argv[1]); mcp=(p/'mcp.caddy').read_text(); api=(p/'api.caddy').read_text()
assert mcp.count('mcp.commonswarm.com {')==1 and api.count('api.commonswarm.com {')==1
assert mcp.count('import mcp_oauth_active')==1 and mcp.count('import mcp_resource_active')==1
assert 'admin_resource_active' not in mcp and 'admin_gate_active' not in mcp and 'admin_resource_active' not in api, 'FAIL existing admin route requires new reviewed baseline; STOP'
snippet='''
(admin_gate_active) {
    @admin_gate {
        method GET HEAD
        path /admin/gate
    }
    handle @admin_gate {
        reverse_proxy 127.0.0.1:3490 {
            transport http {
                dial_timeout 5s
                response_header_timeout 5s
            }
        }
    }
}
(admin_resource_active) {
    @admin_resource {
        method POST OPTIONS
        path /admin
    }
    handle @admin_resource {
        request_body {
            max_size 128KB
        }
        rewrite * /functions/v1/admin
        reverse_proxy 127.0.0.1:9000 {
            transport http {
                response_header_timeout 165s
            }
        }
    }
    @admin_metadata {
        method GET HEAD
        path /.well-known/oauth-protected-resource/admin
    }
    handle @admin_metadata {
        rewrite * /functions/v1/admin/.well-known/oauth-protected-resource/admin
        reverse_proxy 127.0.0.1:9000
    }
    @admin_wrong_method path /admin /.well-known/oauth-protected-resource/admin
    handle @admin_wrong_method {
        header Content-Type application/json
        respond "{\\"error\\":\\"method_not_allowed\\"}" 405
    }
}
'''
mcp=snippet+mcp.replace('import mcp_oauth_active','import admin_gate_active\n\t\timport mcp_oauth_active',1)
anchor='\t@edge_functions path /functions/v1 /functions/v1/*'
assert api.count(anchor)==1
api=api.replace(anchor,'\timport admin_resource_active\n\n'+anchor,1)
for name,body in [('mcp.new.caddy',mcp),('api.new.caddy',api)]:
    for direction in ['request','resp_headers']:
        anchor=direction+'>Authorization delete'
        assert body.count(anchor)==1
        body=body.replace(anchor,anchor+'\n\t\t\t'+direction+'>DPoP delete\n\t\t\t'+direction+'>Dpop delete\n\t\t\t'+direction+'>DPoP-Nonce delete\n\t\t\t'+direction+'>Dpop-Nonce delete',1)
    (p/name).write_text(body)
PY
# Full config candidate with imports redirected to a task-owned directory;
# validate the identical bytes before installing either live file.
mkdir "$SECRET_STAGE/sites"
cp -a /etc/caddy/sites/. "$SECRET_STAGE/sites/"
cp "$SECRET_STAGE/mcp.new.caddy" "$SECRET_STAGE/sites/20-commonswarm-mcp.caddy"
cp "$SECRET_STAGE/api.new.caddy" "$SECRET_STAGE/sites/10-commonswarm-api.caddy"
python3 - "$SECRET_STAGE" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); c=pathlib.Path('/etc/caddy/Caddyfile').read_text()
assert c.count('import /etc/caddy/sites/*.caddy')==1, 'FAIL Caddy import form; STOP'
(p/'Caddyfile').write_text(c.replace('import /etc/caddy/sites/*.caddy','import '+str(p/'sites/*.caddy')))
PY
chmod -R go-rwx "$SECRET_STAGE"
caddy validate --config "$SECRET_STAGE/Caddyfile" --adapter caddyfile >"$SECRET_STAGE/caddy-validate.log" 2>&1
printf 'PASS W3 both Caddy candidate routes validated; CORS preserved\n'
```

```sh
# step: ai-w3-apply
# readonly: no
# host: box root; issuance close/invalidate precedes every source change
set -euo pipefail
test "$WINDOW" = W3
ai_deadline
test ! -e "$PROOF_DIR/edge-attempted.txt"
ai_run ai-inputs
ai_run ai-gates
test -f "$SECRET_STAGE/mcp.new.caddy" && test -f "$SECRET_STAGE/api.new.caddy"
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-attempted.txt"
systemctl stop "$EDGE_RECYCLE_TIMER"
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
ln -s "$NEW_EDGE" /home/commonswarm/edge/current.admin-issuance
mv -Tf /home/commonswarm/edge/current.admin-issuance /home/commonswarm/edge/current
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml" -f "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" \
 up -d --no-build --pull never --force-recreate edge-runtime >"$SECRET_STAGE/edge-apply.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
python3 - "$NEW_EDGE" "$INPUTS_FILE" "$PROOF_DIR/edge-measurement.json" <<'PY'
import hashlib,json,pathlib,subprocess,sys
target=pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True); d=json.load(open(sys.argv[2]))
assert str(target)==sys.argv[1]=='/home/commonswarm/edge/releases/'+d['release_sha']
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
assert c['Image']==d['baseline_edge_image'] and c['State']['Health']['Status']=='healthy'
assert c['Config']['Labels']['com.docker.compose.project.working_dir']==str(target/'deploy/edge-runtime')
assert c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648
for destination,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
    m=[m for m in c['Mounts'] if m['Destination']==destination]
    assert len(m)==1 and m[0]['Source']==str(target/rel) and m[0]['RW'] is False
archive=pathlib.Path('/tmp/admin-issuance-'+d['release_sha']+'-'+d['window_id']+'.tar')
assert hashlib.sha256(archive.read_bytes()).hexdigest()==d['archive_sha256']
# Exact deployed tracked-byte comparison, not readiness/self-attestation.
import tarfile
with tarfile.open(archive) as t:
    for member in t.getmembers():
        if member.isfile(): assert (target/member.name).read_bytes()==t.extractfile(member).read()
pathlib.Path(sys.argv[3]).write_text(json.dumps({'release_sha':d['release_sha'],'target':str(target),'mount':str(target),'image_digest':c['Image'],'artifact_digest':d['archive_sha256']},sort_keys=True)+'\n')
PY
# Separate terminal-fence approval was checked by ai-inputs, before open.
# Measurement + closure are written by the release role in this same marked switch.
python3 - "$PROOF_DIR" "$RELEASE_ROOT" "$RELEASE_SHA" "$WINDOW_ID" <<'PY'
import hashlib,json,pathlib,sys
p,root=map(pathlib.Path,sys.argv[1:3]); sha,wid=sys.argv[3:]; m=json.loads((p/'edge-measurement.json').read_text())
expected={}
for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+['2026100300000'+str(i) for i in range(1,6)]:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    expected[v]=hashlib.sha256(files[0].read_bytes()).hexdigest()
sql="BEGIN; SET LOCAL ROLE commonswarm_admin_release; SELECT commonswarm_oauth.apply_legacy_admin_fence('W3/"+wid+"/ai-w3-apply');\n"
sql+="UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,approved_edge_release_sha='"+sha+"',auth_contract_version=2,required_migrations='"+json.dumps(expected)+"'::jsonb,measured_edge_release_sha='"+sha+"',measured_edge_target='"+m['target']+"',measured_mount='"+m['mount']+"',measured_image_digest='"+m['image_digest']+"',measured_artifact_digest='"+m['artifact_digest']+"',release_generation=release_generation+1,measured_generation=release_generation+1,measured_at=statement_timestamp(),measurement_evidence_ref='W3/"+wid+"/ai-w3-apply',invalidated_at=NULL WHERE singleton; COMMIT;\n"
(p/'measure.sql').write_text(sql)
PY
ai_db -q --file /proof/measure.sql >/dev/null
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy"
cmp -s /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.caddy"
test "$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_caddyfile_sha256"])' "$INPUTS_FILE")"
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.new.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
install -o root -g root -m 0644 "$SECRET_STAGE/api.new.caddy" /etc/caddy/sites/10-commonswarm-api.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$SECRET_STAGE/caddy-live-validate.log" 2>&1
systemctl reload caddy
ai_run ai-recycle-install
systemctl start "$EDGE_RECYCLE_TIMER"
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"
printf 'PASS W3 switched and measured; legacy permanently fenced; issuance OFF\n'
```

```sh
# step: ai-w3-probes
# readonly: probe
# host: Mac outside ingress, Origin set; then box readback via ai-w3-readback
set -euo pipefail
python3 - <<'PY'
import json,urllib.error,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
for method in ['GET','HEAD']:
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with opener.open(req,timeout=15) as r:
        body=r.read(4097)
        assert r.status==200 and r.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in r.headers.get('Cache-Control','') and len(body)<=4096
        assert (json.loads(body)=={'state':'closed'}) if method=='GET' else body==b''
req=urllib.request.Request('https://api.commonswarm.com/admin',method='POST',data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',headers={'Origin':'https://commonswarm.com','Content-Type':'application/json','User-Agent':'curl/8.7.1'})
try: response=opener.open(req,timeout=15)
except urllib.error.HTTPError as error: response=error
with response: assert response.status==401 and len(response.read(4097))<=4096
print('PASS outside GET/HEAD gate closed + CORS; canonical /admin reaches verifier')
PY
```

```sh
# step: ai-w3-readback
# readonly: no
# host: box root; database read-only, redacted receipt
set -euo pipefail
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation AND measured_edge_release_sha=approved_edge_release_sha FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
test "$(ai_ro -Atq --command "SELECT NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='swarm.admin_credentials'::regclass);" )" = t
printf 'PASS closure/measurement/ledger+checksum gate; issuance OFF\n' >"$PROOF_DIR/W3-readback.txt"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.new.caddy"
cmp -s /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.new.caddy"
```

```sh
# step: ai-w3-rollback
# readonly: no
# host: box root; leave legacy closure permanent and issuance closed
set -euo pipefail
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
systemctl stop "$EDGE_RECYCLE_TIMER"
ai_run ai-recycle-rollback
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
install -o root -g root -m 0644 "$SECRET_STAGE/api.caddy" /etc/caddy/sites/10-commonswarm-api.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$SECRET_STAGE/caddy-rollback.log" 2>&1
systemctl reload caddy
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
ln -s "$OLD_EDGE" /home/commonswarm/edge/current.admin-issuance
mv -Tf /home/commonswarm/edge/current.admin-issuance /home/commonswarm/edge/current
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$OLD_EDGE/deploy/edge-runtime/compose.yaml" -f "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" \
 up -d --no-build --pull never --force-recreate edge-runtime >"$SECRET_STAGE/edge-rollback.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
test "$(docker inspect --format '{{.Image}}' commonswarm-edge-edge-runtime-1)" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_edge_image"])' "$INPUTS_FILE")"
test "$(readlink -f /home/commonswarm/edge/current)" = "$OLD_EDGE"
systemctl start "$EDGE_RECYCLE_TIMER"
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"
printf 'PASS W3 baseline source/Caddy restored; measurement invalid; legacy remains fenced\n'
```

```sh
# step: ai-w3-timer-recovery
# readonly: no
# host: box root; also available after a failed rollback; not a close receipt
set -euo pipefail
systemctl start "$EDGE_RECYCLE_TIMER"
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"
printf 'Timer restored; window remains open until service recovery is verified\n'
```

## HezLead box block: measured six-hour recycle

In preflight HezLead executes ai-recycle-inventory, which enumerates timers,
reads each timer's Triggers and matches the box's recycle service, then supplies the exact
unit names plus SHA-256 of `systemctl cat <service>` including its final newline
as `edge_recycle_timer`, `edge_recycle_service`, `edge_recycle_sha256`.
These are measured inputs, never presumed unit names. ai-box-preflight binds
and validates them. Each later window must remeasure the unit including the
drop-in. Install in W3 while the timer is stopped, before restoring it.
The hook closes issuance/increments generation in ExecStartPre, before the
existing restart, then remeasures target, image, health, immutable mounts and
all archive bytes in ExecStartPost. Only a previously open, still-approved
release can reopen. Failed restart/measurement stays closed. HezLead executes
these blocks; this preparation worker never installs or invokes a hook.

```sh
# step: ai-recycle-hook
# readonly: no
# host: box root, installed by HezLead; systemd invokes before/after
set -euo pipefail
: "${1:?before or after}"
case "$1" in before|after) ;; *) exit 1;; esac
umask 077
HOOK_SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$HOOK_SECRET_STAGE"
ai_hook_cleanup() {
 python3 - "$HOOK_SECRET_STAGE" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
PY
 rm -r -- "$HOOK_SECRET_STAGE" || { printf 'FAIL recycle secret cleanup refused %s; STOP\n' "$HOOK_SECRET_STAGE" >&2; return 1; }
}
trap ai_hook_cleanup EXIT
python3 - "$1" "$HOOK_SECRET_STAGE" <<'PY'
import hashlib,json,os,pathlib,re,subprocess,sys,tarfile,time
stage=pathlib.Path(sys.argv[2]); mode=sys.argv[1]
try:
    path=pathlib.Path('/etc/commonswarm-admin-release/recycle.json')
    assert path.is_file() and not path.is_symlink() and path.stat().st_uid==0 and path.stat().st_mode & 0o777==0o600
    r=json.loads(path.read_text()); sha=r['release_sha']; target='/home/commonswarm/edge/releases/'+sha
    assert re.fullmatch('[0-9a-f]{40}',sha) and r['target']==target
    assert re.fullmatch('sha256:[0-9a-f]{64}',r['image_digest']) and re.fullmatch('[0-9a-f]{64}',r['artifact_digest'])
    archive=pathlib.Path(r['archive']); assert archive.is_file() and not archive.is_symlink()
    assert re.fullmatch(r'/tmp/admin-issuance-'+sha+r'-[A-Za-z0-9]{6}\.tar',str(archive))
    root=pathlib.Path(r['release_root']); assert str(root)=='/home/commonswarm/admin-issuance/releases/'+sha and root.resolve()==root
    env=dict(os.environ); env.update(PG_SERVICE_OUTPUT=str(stage/'service.conf'),PG_PASS_OUTPUT=str(stage/'pass'),COMMONSWARM_ENV_FILE='/home/commonswarm/.env',COMMONSWARM_MIGRATION_ENV_FILE='/etc/commonswarm-release/target.env')
    with (stage/'session.log').open('w') as log:
        subprocess.run(['node',str(root/'deploy/supabase-stack/migrate/make-pg-service.mjs')],env=env,stdout=log,stderr=log,check=True)
    for name in ['service.conf','pass']: (stage/name).chmod(0o600)
    assert re.fullmatch('sha256:[0-9a-f]{64}',r['postgres_image'])
    args=['docker','run','--rm','--network','commonswarm-net','--add-host','db.commonswarm.internal:172.31.0.10','--env','PGSERVICE=target','--env','PGSERVICEFILE=/run/service.conf','--env','PGPASSFILE=/run/pass','--volume',str(stage/'service.conf')+':/run/service.conf:ro','--volume',str(stage/'pass')+':/run/pass:ro','--volume','/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro','--entrypoint','psql',r['postgres_image'],'-X','--set=ON_ERROR_STOP=1','-Atq','--file','-']
    def db(sql):
        with (stage/'db.log').open('w') as log:
            return subprocess.check_output(args,input=sql,text=True,stderr=log).strip()
    intent=pathlib.Path('/etc/commonswarm-admin-release/recycle-intent.json')
    if mode=='before':
        # Stale intent can never be used after a failed/unknown pre-hook.
        intent.write_text(json.dumps({'reopen':False,'generation':None})+'\n'); intent.chmod(0o600)
        result=db("BEGIN; SET LOCAL ROLE commonswarm_admin_release; SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton RETURNING release_generation; COMMIT;").splitlines()
        assert len(result)==2 and result[0] in ('t','f') and result[1].isdigit()
        intent.write_text(json.dumps({'reopen':result[0]=='t','generation':int(result[1])})+'\n')
    else:
        state=json.loads(intent.read_text()); assert isinstance(state['generation'],int) and type(state['reopen']) is bool
        live=pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True); assert str(live)==target
        for attempt in range(46):
            c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
            if c['State'].get('Health',{}).get('Status')=='healthy': break
            if attempt==45: raise ValueError('health timeout')
            time.sleep(2)
        assert c['Image']==r['image_digest'] and c['State']['Health']['Status']=='healthy'
        assert c['Config']['Labels']['com.docker.compose.project.working_dir']==target+'/deploy/edge-runtime'
        assert c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648
        for dst,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
            mounts=[m for m in c['Mounts'] if m['Destination']==dst]
            assert len(mounts)==1 and mounts[0]['Source']==target+'/'+rel and mounts[0]['RW'] is False
        assert hashlib.sha256(archive.read_bytes()).hexdigest()==r['artifact_digest']
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                dest=live/member.name
                assert not pathlib.PurePosixPath(member.name).is_absolute() and '..' not in pathlib.PurePosixPath(member.name).parts
                if member.isfile(): assert not dest.is_symlink() and dest.read_bytes()==tar.extractfile(member).read()
                elif member.issym(): assert dest.is_symlink() and dest.readlink().as_posix()==member.linkname
        gen=str(state['generation']); enabled='true' if state['reopen'] else 'false'
        sql="BEGIN; SET LOCAL ROLE commonswarm_admin_release; DO $$ BEGIN IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksum_failures()) OR NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND legacy_closed AND auth_contract_version=2 AND approved_edge_release_sha='"+sha+"' AND release_generation="+gen+" AND NOT admin_issuance_enabled AND invalidated_at IS NOT NULL) THEN RAISE EXCEPTION 'recycle measurement refused'; END IF; END $$; "
        sql+="UPDATE commonswarm_oauth.admin_cutover_state SET measured_edge_release_sha='"+sha+"',measured_edge_target='"+target+"',measured_mount='"+target+"',measured_image_digest='"+r['image_digest']+"',measured_artifact_digest='"+r['artifact_digest']+"',measured_generation=release_generation,measured_at=statement_timestamp(),measurement_evidence_ref='systemd/recycle/"+gen+"',invalidated_at=NULL,admin_issuance_enabled="+enabled+" WHERE singleton; COMMIT;"
        if state['reopen']: assert db('SELECT lane8_evidence_digest IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')=='t'
        db(sql)
except Exception:
    raise SystemExit('FAIL recycle hook; issuance stays closed; HezLead recovery required') from None
PY
```

```sh
# step: ai-recycle-install
# readonly: no
# host: HezLead ONLY, box root, W3 with timer stopped
set -euo pipefail
test "$WINDOW" = W3
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" && exit 1
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
RECYCLE_DROPIN=/etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
test ! -e "$RECYCLE_DROPIN" && test ! -L "$RECYCLE_DROPIN"
mkdir -p /etc/commonswarm-admin-release /usr/local/libexec "$(dirname "$RECYCLE_DROPIN")"
chmod 0700 /etc/commonswarm-admin-release
python3 - "$PLAN_FILE" "$SECRET_STAGE/recycle.sh" "$INPUTS_FILE" "$RELEASE_ROOT" <<'PY'
import json,pathlib,re,sys
plan=pathlib.Path(sys.argv[1]).read_text(); blocks=re.findall(r'^```sh\n(.*?)^```$',plan,re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-recycle-hook\n')]; assert len(found)==1
pathlib.Path(sys.argv[2]).write_text('#!/bin/bash\n'+found[0])
d=json.load(open(sys.argv[3])); r={'release_sha':d['release_sha'],'target':'/home/commonswarm/edge/releases/'+d['release_sha'],'image_digest':d['baseline_edge_image'],'artifact_digest':d['archive_sha256'],'archive':'/tmp/admin-issuance-'+d['release_sha']+'-'+d['window_id']+'.tar','postgres_image':d['baseline_postgres_image'],'release_root':sys.argv[4]}
p=pathlib.Path('/etc/commonswarm-admin-release/recycle.json'); p.write_text(json.dumps(r)+'\n'); p.chmod(0o600)
PY
/bin/bash -n "$SECRET_STAGE/recycle.sh"
install -o root -g root -m 0700 "$SECRET_STAGE/recycle.sh" /usr/local/libexec/commonswarm-admin-edge-recycle
printf '[Service]\nExecStartPre=/usr/local/libexec/commonswarm-admin-edge-recycle before\nExecStartPost=/usr/local/libexec/commonswarm-admin-edge-recycle after\n' >"$RECYCLE_DROPIN"
chmod 0644 "$RECYCLE_DROPIN"
systemctl daemon-reload
systemctl cat "$EDGE_RECYCLE_SERVICE" >"$PROOF_DIR/recycle-unit-after.txt"
printf 'PASS recycle pre-invalidation/post-measurement hooks installed; no restart performed\n'
```

```sh
# step: ai-recycle-rollback
# readonly: no
# host: HezLead ONLY, box root; close issuance before removing hook
set -euo pipefail
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
systemctl stop "$EDGE_RECYCLE_TIMER"
RECYCLE_DROPIN=/etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
test ! -L "$RECYCLE_DROPIN"
if test -e "$RECYCLE_DROPIN"; then
 rm -- "$RECYCLE_DROPIN" || { printf 'FAIL guarded drop-in removal refused %s; STOP\n' "$RECYCLE_DROPIN" >&2; exit 1; }
fi
systemctl daemon-reload
test ! -e "$RECYCLE_DROPIN"
printf 'PASS recycle drop-in removed; issuance closed; reenable timer only after recovery\n'
```

## W4: /app site release

Use the generalized site plan from the **same RELEASE_SHA**, without weakening
its source, main-ancestry, baseline, deletion, retention pin, GO, public byte,
human recovery, secret, rollback and manifest gates. Its exact named inputs are
additional W4 inputs, not fabricated values. SITE_BASE_SHA must equal this
window's measured baseline_site_sha. No borrowing a historical ON receipt.
The approved site plan includes headless view-only QA; before execution HezLead
must explicitly assign that QA to a worker. Our task authorizes no browser
launch. W6 consent authorization is not W4 browser authorization.

```sh
# step: ai-w4-preflight
# readonly: yes
# host: Mac /bin/bash 3.2
set -euo pipefail
: "${SITE_RELEASE_SHA:?}" "${SITE_BASE_SHA:?}" "${SITE_QA_AUTHORIZATION_FILE:?}"
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
test "$SITE_RELEASE_SHA" = "$RELEASE_SHA"
test "$SITE_BASE_SHA" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_site_sha"])' "$INPUTS_FILE")"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
python3 - "$SITE_QA_AUTHORIZATION_FILE" "$RELEASE_SHA" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
r=json.loads(p.read_text())
assert set(r)=={'approver','release_sha','task_ref','browser'} and r['approver'] in ('Tom','HezLead') and r['release_sha']==sys.argv[2]
assert r['browser']=='headless-bundled-chromium' and isinstance(r['task_ref'],str) and r['task_ref']
PY
```

```sh
# step: ai-w4-reference
# readonly: no
# host: Mac /bin/bash 3.2; invokes one complete reviewed generalized site block
set -euo pipefail
: "${SITE_STEP:?}" "${SITE_RELEASE_REPO:?}" "${PREP_DIR:?}"
case "$SITE_STEP" in
 site2-00-source-checkout|site2-01|site2-00-a-close-ingest|site2-00-build-env|site2-02|site2-03-browser-session-preflight|site2-03|site2-03-pin-previous|site2-03-go-record|site2-04|site2-04-reconcile-failure|site2-05|site2-05-browser-acceptance|site2-06|site2-07-pre-pin-manifest-close|site2-07-manifest-close) ;;
 *) echo 'FAIL W4 unknown site step; STOP' >&2; exit 1;;
esac
SITE_PLAN=$SITE_RELEASE_REPO/docs/evidence/2026-10-02-site-release/SITE-RELEASE.md
git show "${SITE_RELEASE_SHA}:docs/evidence/2026-10-02-site-release/SITE-RELEASE.md" >"$PREP_DIR/site-plan.md"
if test "$SITE_STEP" != site2-00-source-checkout; then cmp -s "$SITE_PLAN" "$PREP_DIR/site-plan.md"; fi
python3 - "$PREP_DIR/site-plan.md" "$SITE_STEP" "$PREP_DIR/site-step.sh" <<'PY'
import pathlib,re,sys
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if re.match(r'^# step: '+re.escape(sys.argv[2])+r'(?: —[^\n]*)?\n',b)]
assert len(found)==1, 'FAIL W4 missing/duplicate marked block; STOP'
pathlib.Path(sys.argv[3]).write_text(found[0])
PY
/bin/bash -n "$PREP_DIR/site-step.sh"
# Source in a subshell? NO: this plan's site blocks retain state in one Mac shell.
. "$PREP_DIR/site-step.sh"
```

Run the referenced plan's exact normal order from its Run order table, including
its error reconciliation and close blocks. Do not shortcut to deploy.sh. W4
requires `admin-site-lifecycle`/projection receipts plus the actual browser QA
receipt and outside GET/HEAD gate closed/CORS probes. Site's automatic rollback
is its explicit preselected failure path; it never retries deployment. Its
protected build env recovery uses the service-account token file. Any rm refusal
STOPs cleanup, with the exact path/message retained. The caller does not execute
the next W window until that referenced site's window is verified closed.

## W5: separate activation approval and executable preconditions

Every gate in GATES.json's W5 set is required against the exact combined build.
This includes every lane-8 gate in Composer/Grok findings, the lane-6a timeout
AbortSignal follow-up and the verified-client registry visibility decision.
The same-build integration `admin-activation-chain` is a preproduction receipt;
W6's production C1 receipt follows activation and is not substituted for it.

```sh
# step: ai-w5-approval
# readonly: yes
# host: Mac or box; execute before any W5 staging, network or mutation
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W5' and isinstance(a,dict), 'FAIL W5 explicit activation approval required; STOP'
assert a.get('action')=='activate-admin-issuance' and a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref'), 'FAIL W5 approval identity; STOP'
assert all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W5 approval binding; STOP'
print('W5 approval present; every named proof and measured production prerequisites remain required')
PY
```

```sh
# step: ai-w5-checks
# readonly: no
# host: box root; DB read-only; ai-gates must have passed for W5
set -euo pipefail
test "$WINDOW" = W5
ai_run ai-w5-approval
ai_run ai-gates
ai_deadline
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(readlink -f /home/commonswarm/oauth/current)" = "/home/commonswarm/oauth/releases/$RELEASE_SHA"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)")" = "$RELEASE_SHA"
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
ai_ro -Atq --command "SELECT l.version,c.sha256,s.required_migrations->>l.version FROM supabase_migrations.schema_migrations l JOIN commonswarm_ops.migration_checksums c USING(version) CROSS JOIN commonswarm_oauth.admin_cutover_state s WHERE s.singleton AND l.version IN ('20261001000001','20261001000002','20261001000003','20261001000004','20261001000005','20260928000003','20261002000001','20261003000001','20261003000002','20261003000003','20261003000004','20261003000005') ORDER BY l.version;" >"$PROOF_DIR/activation-migrations.txt"
python3 - "$RELEASE_ROOT" "$PROOF_DIR/activation-migrations.txt" "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); d=json.load(open(sys.argv[3])); expected=[]
for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+['2026100300000'+str(i) for i in range(1,6)]:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    h=hashlib.sha256(files[0].read_bytes()).hexdigest(); expected.append('|'.join([v,h,h]))
assert pathlib.Path(sys.argv[2]).read_text().splitlines()==sorted(expected), 'FAIL exact activation ledger/checksums including recovery 05; STOP'
assert d['baseline_site_sha']==d['release_sha'], 'FAIL site source not combined build; STOP'
PY
test "$(ai_ro -Atq --command "SELECT NOT admin_issuance_enabled AND legacy_closed AND legacy_fence_evidence_ref IS NOT NULL AND auth_contract_version=2 AND approved_edge_release_sha='$RELEASE_SHA' AND measured_edge_release_sha='$RELEASE_SHA' AND measured_generation=release_generation AND invalidated_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t
test "$(ai_ro -Atq --command "SELECT NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='swarm.admin_credentials'::regclass);")" = t
# Remeasure the live image/mount/artifact against the independently recorded row.
ai_ro -Atq --command "SELECT measured_edge_target,measured_artifact_digest,measured_image_digest,measured_mount FROM commonswarm_oauth.admin_cutover_state WHERE singleton;" >"$PROOF_DIR/measurement-before-activation.txt"
python3 - "$PROOF_DIR/measurement-before-activation.txt" "$RELEASE_SHA" "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,subprocess,sys,tarfile
target='/home/commonswarm/edge/releases/'+sys.argv[2]; d=json.load(open(sys.argv[3]))
parts=pathlib.Path(sys.argv[1]).read_text().strip().split('|'); assert len(parts)==4
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
archive=pathlib.Path('/tmp/admin-issuance-'+sys.argv[2]+'-'+d['window_id']+'.tar')
assert parts==[target,d['archive_sha256'],c['Image'],target]
assert hashlib.sha256(archive.read_bytes()).hexdigest()==parts[1]
assert c['Config']['Labels']['com.docker.compose.project.working_dir']==target+'/deploy/edge-runtime'
for dst,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
    m=[m for m in c['Mounts'] if m['Destination']==dst]
    assert len(m)==1 and m[0]['Source']==target+'/'+rel and m[0]['RW'] is False
with tarfile.open(archive) as t:
    for member in t.getmembers():
        if member.isfile(): assert (pathlib.Path(target)/member.name).read_bytes()==t.extractfile(member).read()
PY
printf 'PASS W5 DB release identity/checksum/legacy controls; activation prerequisites complete\n' >"$PROOF_DIR/W5-checks.txt"
```

```sh
# step: ai-w5-apply
# readonly: no
# host: HezLead, box root; approved activation only
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W5' and isinstance(a,dict) and a.get('action')=='activate-admin-issuance', 'FAIL W5 activation approval required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) for k in ('release_sha','window_id','plan_sha256')), 'FAIL W5 approval binding; STOP'
PY
test "$WINDOW" = W5
ai_run ai-inputs
ai_run ai-w5-approval
ai_run ai-gates
ai_deadline
test -f "$PROOF_DIR/W5-checks.txt"
test ! -e "$PROOF_DIR/activation-attempted.txt"
OAUTH_TARGET=/home/commonswarm/oauth/releases/$RELEASE_SHA
test "$(readlink -f /home/commonswarm/oauth/current)" = "$OAUTH_TARGET"
test "$(stat -c '%a %u %g' /etc/commonswarm-oauth/admin-issuer-database-credentials)" = '440 0 986'
test -f /etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
# Both hooks are marked complete blocks installed in W3; no generated operator script.
systemctl stop "$EDGE_RECYCLE_TIMER"
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
/usr/local/libexec/commonswarm-admin-edge-recycle before >"$SECRET_STAGE/measure-before.log" 2>&1
/usr/local/libexec/commonswarm-admin-edge-recycle after >"$SECRET_STAGE/measure-after.log" 2>&1
python3 - "$SECRET_STAGE/service.env" "$SECRET_STAGE/service.active.env" <<'PY'
import pathlib,sys
rows=pathlib.Path(sys.argv[1]).read_text().splitlines()
keys=('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE')
assert not any(r.split('=',1)[0] in keys for r in rows), 'FAIL activation baseline must be unset; STOP'
pathlib.Path(sys.argv[2]).write_text('\n'.join(rows+['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1'])+'\n')
pathlib.Path(sys.argv[2]).chmod(0o600)
PY
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/activation-attempted.txt"
install -o root -g root -m 0600 "$SECRET_STAGE/service.active.env" /etc/commonswarm-oauth/service.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.yaml" -f "$OAUTH_TARGET/deploy/mcp-auth/compose.management.yaml" \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.admin-issuer.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/activation.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
python3 - "$RELEASE_SHA" <<'PY'
import json,subprocess,sys
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1'],stderr=subprocess.DEVNULL))[0]
e=dict(x.split('=',1) for x in c['Config']['Env'])
assert e['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED']=='1'
assert e['MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE']=='/run/commonswarm-oauth/admin-issuer-database-credentials'
assert c['Config']['User']=='996:986'
m=[m for m in c['Mounts'] if m['Destination']=='/run/commonswarm-oauth/admin-issuer-database-credentials']
assert len(m)==1 and m[0]['Source']=='/etc/commonswarm-oauth/admin-issuer-database-credentials' and m[0]['RW'] is False
assert subprocess.check_output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',c['Image']],text=True).strip()==sys.argv[1]
PY
python3 - "$INPUTS_FILE" "$PROOF_DIR/activate.sql" <<'PY'
import json,pathlib,re,sys
d=json.load(open(sys.argv[1])); sha=d['release_sha']; h=d['gate_receipt_sha256']
assert re.fullmatch('[0-9a-f]{40}',sha) and re.fullmatch('[0-9a-f]{64}',h)
sql="BEGIN; SET LOCAL ROLE commonswarm_admin_release; DO $$ BEGIN IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksum_failures()) OR NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND NOT admin_issuance_enabled AND legacy_closed AND auth_contract_version=2 AND approved_edge_release_sha='"+sha+"' AND measured_edge_release_sha='"+sha+"' AND measured_generation=release_generation AND invalidated_at IS NULL AND measured_at IS NOT NULL) THEN RAISE EXCEPTION 'activation checks refused'; END IF; END $$; "
sql+="UPDATE commonswarm_oauth.admin_cutover_state SET lane8_evidence_digest='"+h+"',admin_issuance_enabled=true WHERE singleton; COMMIT;\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
ai_db -q --file /proof/activate.sql >/dev/null
systemctl start "$EDGE_RECYCLE_TIMER"
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"
printf 'PASS W5 overlay/env/cutover active; require outside gate probe before close\n'
```

```sh
# step: ai-w5-probes
# readonly: probe
# host: Mac outside ingress, then HezLead box receipt
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
for method in ['GET','HEAD']:
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with urllib.request.urlopen(req,timeout=15) as r:
        body=r.read(4097)
        assert r.status==200 and r.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in r.headers.get('Cache-Control','') and len(body)<=4096
        assert json.loads(body)=={'state':'open'} if method=='GET' else body==b''
print('PASS outside GET/HEAD gate open + CORS; exact approved combined release')
PY
```

```sh
# step: ai-w5-readback
# readonly: no
# host: HezLead box root; after outside ai-w5-probes PASS
set -euo pipefail
test "$WINDOW" = W5
test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND legacy_closed AND lane8_evidence_digest IS NOT NULL AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
printf 'PASS W5 measured release, overlay/env and public gate open\n' >"$PROOF_DIR/W5-probes.txt"
```

```sh
# step: ai-w5-rollback
# readonly: no
# host: HezLead box root; remove activation env/overlay and close cutover
set -euo pipefail
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
OAUTH_TARGET=$(readlink -f /home/commonswarm/oauth/current)
python3 - "$OAUTH_TARGET" "$SECRET_STAGE/service.closed.env" <<'PY'
import pathlib,re,sys
assert re.fullmatch(r'/home/commonswarm/oauth/releases/[0-9a-f]{40}',sys.argv[1])
p=pathlib.Path('/etc/commonswarm-oauth/service.env'); rows=p.read_text().splitlines()
keys=('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE')
out=pathlib.Path(sys.argv[2]); out.write_text('\n'.join(r for r in rows if r.split('=',1)[0] not in keys)+'\n'); out.chmod(0o600)
PY
install -o root -g root -m 0600 "$SECRET_STAGE/service.closed.env" /etc/commonswarm-oauth/service.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.yaml" -f "$OAUTH_TARGET/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/activation-rollback.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
python3 - <<'PY'
import json,subprocess,urllib.request
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1'],stderr=subprocess.DEVNULL))[0]
e=dict(x.split('=',1) for x in c['Config']['Env'])
assert 'MCP_OAUTH_ADMIN_ISSUANCE_ENABLED' not in e and 'MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE' not in e
assert not any(m['Destination']=='/run/commonswarm-oauth/admin-issuer-database-credentials' for m in c['Mounts'])
with urllib.request.urlopen('http://127.0.0.1:3490/admin/gate',timeout=15) as r: assert json.loads(r.read(4096))=={'state':'closed'}
PY
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
systemctl start "$EDGE_RECYCLE_TIMER"
printf 'PASS W5 env/overlay removed; DB closed; history and issuer credential retained\n' >"$PROOF_DIR/activation-rollback.txt"
```

```sh
# step: ai-emergency-close
# readonly: no
# host: HezLead box root; W5–W7 recovery, never reopens opaque authentication
set -euo pipefail
ai_run ai-w5-rollback
printf 'Issuance closed; existing grants require the W6 human revoke/approval withdrawal or separately approved incident reconciliation\n'
```

## W6: C1 hosted OAuth admin smoke

The delivered `scripts/admin-smoke.mjs` owns PKCE, DPoP proofs/nonces, code
exchange, init/list/read/actions, saved command IDs, workspace/seat creation,
seat revoke, refresh and access-fence verification. Keep the same process alive
through the human fence: its key/token state is in memory. No browser starts
from these blocks. HezLead's assigned browser worker performs fresh full-account
second confirmation only after `/Users/yulanbot/work/BROWSER-READY` exists.

Two observed contracts conflict with TASK-2 and require HezLead to settle
before W6 opens. The requested `/Users/yulanbot/work/dcr-rt/authorize.url` and
`/private/tmp/dcr-rt-callback.url` are refused by the runner's privatePath guard:
all private handoffs must be directly in a fresh secret directory, with no
symlink parent. The plan below uses `$C1_SECRET_STAGE/authorize.url` and
`$C1_SECRET_STAGE/callback.url`; the requested dcr-rt directory is only a
nonsecret pointer rendezvous. This correction needs an explicit path ruling.
Also `approve_admin_client` accepts only client_id/verification_version and
stores account-owner approval, with no workspace scope. Its account envelope
rejects workspace_id. The runner creates a workspace after full-account consent;
its grant can cover future owned workspaces. A smoke-only client ceiling and
prompt withdrawal reduce residue but do not make approval workspace-scoped.
Do not claim otherwise: a separate scope ruling is required. ai-w6-preflight
refuses absent rulings. No window runs the incompatible original paths/command.

`C1_INPUTS_FILE` is a regular absolute nonsecret JSON input supplied by HezLead:
release_sha/window_id/plan_sha256; owner_user_id and existing smoke_workspace_id;
verification_version, metadata_digest; a target_file (protected JSON url/anonKey),
owner file-store state_directory; and path_revision_approval plus
account_approval_revision, each a nonempty explicit HezLead prompt reference.
The verification row is an external reviewed input prepared by the release
role, not created by owner approval. PASS10 pins lowercase SHA-256 of
`canonicalAdminJson(fetched_document)` via the production `adminDigest`.
Never hash provider-normalized defaults or confuse the document's byte digest
with its canonical JSON digest. Approval uses the exact version after the
published document, reviewed digest and DB row are reconciled.

```sh
# step: ai-w6-preflight
# readonly: yes
# host: Mac Bash 3.2; no files/network/mutations before assignment checks
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W6' and isinstance(a,dict) and a.get('action')=='admin-smoke-human-consent', 'FAIL W6 human consent assignment required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W6 approval binding; STOP'
PY
: "${C1_INPUTS_FILE:?C1 approval inputs absent; STOP}"
python3 - "$INPUTS_FILE" "$C1_INPUTS_FILE" <<'PY'
import json,pathlib,re,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2])
assert p.is_absolute() and p.is_file() and not p.is_symlink(), 'FAIL C1 regular input required; STOP'
c=json.loads(p.read_text())
assert all(c.get(k)==d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL C1 window binding; STOP'
for k in ['owner_user_id','smoke_workspace_id']: assert re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',c.get(k,'')), 'FAIL C1 owner/workspace input; STOP'
assert type(c.get('verification_version')) is int and c['verification_version']>0
assert re.fullmatch('[0-9a-f]{64}',c.get('metadata_digest',''))
for k in ['path_revision_approval','account_approval_revision']:
    assert isinstance(c.get(k),str) and re.fullmatch('[A-Za-z0-9/_.:-]{1,200}',c[k]), 'FAIL C1 '+k+' required; STOP'
for k in ['target_file','state_directory']:
    path=pathlib.Path(c.get(k,'')); assert path.is_absolute() and path.exists() and not path.is_symlink(), 'FAIL C1 owner session input; STOP'
print('PASS C1 assignment, corrected-path/scope rulings and reviewed approval inputs')
PY
```

```sh
# step: ai-w6-prepare
# readonly: no
# host: HezLead Mac; only after ai-w6-preflight/ai-inputs/ai-gates PASS
set -euo pipefail
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
test "$(git rev-parse HEAD)" = "$RELEASE_SHA" && test -z "$(git status --porcelain)"
C1_PROOF_DIR=/Users/yulanbot/work/hm37-live-release/c1-${RELEASE_SHA}-${WINDOW_ID}
test ! -e "$C1_PROOF_DIR" && test ! -L "$C1_PROOF_DIR"
mkdir -p "$C1_PROOF_DIR" /Users/yulanbot/work/dcr-rt
chmod 0700 "$C1_PROOF_DIR"
install -m 0600 "$C1_INPUTS_FILE" "$C1_PROOF_DIR/C1-inputs.json"
```

```sh
# step: ai-w6-transfer
# readonly: no
# host: HezLead Mac; nonsecret receipts only, whole block per selected file
set -euo pipefail
: "${C1_TRANSFER_DIRECTION:?upload or download}" "${C1_TRANSFER_FILE:?}" "${C1_PROOF_DIR:?}"
C1_BOX_PROOF=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-W6-${WINDOW_ID}
case "$C1_TRANSFER_DIRECTION:$C1_TRANSFER_FILE" in
 upload:C1-inputs.json|upload:agent.json|upload:client-withdraw.json|upload:C1.json|upload:C1-cleanup.txt)
  C1_UPLOAD=/tmp/admin-c1-${WINDOW_ID}-${C1_TRANSFER_FILE}
  test -f "$C1_PROOF_DIR/$C1_TRANSFER_FILE" && test ! -L "$C1_PROOF_DIR/$C1_TRANSFER_FILE"
  printf -v C1_REMOTE 'test ! -e %q' "$C1_UPLOAD"
  ssh -o BatchMode=yes ops@100.115.66.74 "$C1_REMOTE"
  scp -p "$C1_PROOF_DIR/$C1_TRANSFER_FILE" "ops@100.115.66.74:$C1_UPLOAD"
  printf -v C1_REMOTE 'sudo -n install -o root -g root -m 0600 %q %q' "$C1_UPLOAD" "$C1_BOX_PROOF/$C1_TRANSFER_FILE"
  ssh -o BatchMode=yes ops@100.115.66.74 "$C1_REMOTE"
  ;;
 download:C1-client-check.txt|download:C1-audit.json|download:C1-fence.txt)
  test ! -e "$C1_PROOF_DIR/$C1_TRANSFER_FILE" && test ! -L "$C1_PROOF_DIR/$C1_TRANSFER_FILE"
  printf -v C1_REMOTE 'sudo -n cat %q' "$C1_BOX_PROOF/$C1_TRANSFER_FILE"
  ( set -C; umask 077; ssh -o BatchMode=yes ops@100.115.66.74 "$C1_REMOTE" >"$C1_PROOF_DIR/$C1_TRANSFER_FILE" )
  ;;
 *) printf 'FAIL nonsecret C1 transfer allowlist; STOP\n' >&2; exit 1;;
esac
```

Use this exact transfer block to upload C1-inputs.json (set the box's
C1_INPUTS_FILE to that derived proof path), download C1-client-check.txt before
owner approval, upload agent.json before SQL audit (C1_AGENT_RECEIPT on box),
download C1-audit.json before human revoke, and download C1-fence.txt before
reporting. After report/cleanup, upload C1.json and C1-cleanup.txt for W6 close.
The immutable C1.json and its measured digest become W7's C1_REPORT_FILE input.
This allowlist excludes private authorize/callback/key/token/session files.

```sh
# step: ai-w6-client-check
# readonly: no
# host: HezLead box root, W6 read-only SQL; before owner approval
set -euo pipefail
test "$WINDOW" = W6
: "${C1_INPUTS_FILE:?}"
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(readlink -f /home/commonswarm/oauth/current)" = "/home/commonswarm/oauth/releases/$RELEASE_SHA"
test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
python3 - "$C1_INPUTS_FILE" "$PROOF_DIR/client-check.sql" <<'PY'
import json,pathlib,re,sys
c=json.load(open(sys.argv[1])); v=c['verification_version']; h=c['metadata_digest']; owner=c['owner_user_id']; ws=c['smoke_workspace_id']
assert type(v) is int and v>0 and re.fullmatch('[0-9a-f]{64}',h)
for value in [owner,ws]: assert re.fullmatch(r'[0-9a-fA-F-]{36}',value)
sql="SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json' AND verification_version="+str(v)+" AND metadata_digest='"+h+"' AND active AND withdrawn_at IS NULL AND registration_source='cimd' AND application_type='web' AND redirect_uris=ARRAY['https://commonswarm.com/oauth/c1-smoke/callback']::text[] AND scope_ceiling=ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[] AND full_account_eligible AND NOT delegation_eligible AND pkce_s256_tested AND dpop_tested AND redirect_tested AND origin_control_verified) AND EXISTS(SELECT 1 FROM swarm.memberships WHERE user_id='"+owner+"'::uuid AND workspace_id='"+ws+"'::uuid AND role='owner' AND revoked_at IS NULL);\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
test "$(ai_ro -Atq --file /proof/client-check.sql)" = t
printf 'PASS exact C1 version/canonical digest/reviewed ceiling and smoke workspace owner\n' >"$PROOF_DIR/C1-client-check.txt"
```

```sh
# step: ai-w6-owner-client-command
# readonly: no
# host: HezLead Mac owner file-store CLI session; approve or withdraw only
set -euo pipefail
: "${INPUTS_FILE:?}" "${C1_INPUTS_FILE:?}" "${C1_PROOF_DIR:?}" "${C1_CLIENT_ACTION:?approve or withdraw}"
case "$C1_CLIENT_ACTION" in approve|withdraw) ;; *) exit 1;; esac
# Execute ai-w6-preflight and retain box C1-client-check.txt first.
test -f "$C1_PROOF_DIR/C1-client-check.txt"
node --import tsx --input-type=module - "$C1_INPUTS_FILE" "$C1_PROOF_DIR" "$C1_CLIENT_ACTION" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { credentialStore } from './src/cloud/storage.ts';
import { refreshedCredential } from './src/cloud/auth.ts';
import { cloudTarget, commandEndpoint, CLIENT_PROTOCOL_VERSION } from './src/cloud/config.ts';
import { withClientBuild } from './src/cloud/client-build.ts';
import { canonicalAdminJson } from './src/protocol/admin-policy.ts';
import { createHash } from 'node:crypto';
const [file,proof,action]=process.argv.slice(2);
try {
 const c=JSON.parse(await readFile(file,'utf8'));
 const t=JSON.parse(await readFile(c.target_file,'utf8')); if(t.url!=='https://api.commonswarm.com') throw Error();
 const target=cloudTarget(t.url,t.anonKey);
 const response=await fetch('https://commonswarm.com/oauth/c1-smoke/client.json',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok || response.headers.get('content-type')?.split(';')[0]!=='application/json') throw Error();
 const bytes=await response.text(); if(Buffer.byteLength(bytes)>4096) throw Error();
 const doc=JSON.parse(bytes);
 const digest=createHash('sha256').update(canonicalAdminJson(doc)).digest('hex');
 if(digest!==c.metadata_digest || doc.client_id!=='https://commonswarm.com/oauth/c1-smoke/client.json') throw Error();
 const store=await credentialStore({target,stateDirectory:c.state_directory,forceFile:true,warn:()=>{}});
 const human=await refreshedCredential(target,store); if(human.userId!==c.owner_user_id) throw Error();
 const commandId=randomUUID(); await writeFile(`${proof}/${action}-request-id`,commandId+'\n',{flag:'wx',mode:0o600});
 const command={kind:action==='approve'?'approve_admin_client':'withdraw_admin_client_approval',client_id:doc.client_id,verification_version:c.verification_version,...(action==='withdraw'?{reason_code:'smoke_cleanup'}:{})};
 const r=await fetch(commandEndpoint(target),{method:'POST',headers:{authorization:`Bearer ${human.accessToken}`,apikey:target.anonKey,'content-type':'application/json'},body:JSON.stringify(withClientBuild({command_id:commandId,client_version:CLIENT_PROTOCOL_VERSION,stream:{kind:'account'},resource:'https://api.commonswarm.com/admin',command})),signal:AbortSignal.timeout(15000)});
 const result=await r.json(); if(!r.ok || result.status!=='accepted') throw Error();
 await writeFile(`${proof}/client-${action}.json`,JSON.stringify({status:'PASS',command_id:commandId,client_id:doc.client_id,verification_version:c.verification_version,metadata_digest:digest})+'\n',{flag:'wx',mode:0o600});
 console.log('PASS owner client command; canonical document/version bound; no credentials emitted');
} catch { console.error('FAIL owner client command; outcome may be unknown; reconcile saved request ID; STOP'); process.exitCode=1; }
JS
```

```sh
# step: ai-w6-start
# readonly: no
# host: HezLead Mac, after preflight/client approve; no browser launch
set -euo pipefail
: "${C1_PROOF_DIR:?}"
test -f "$C1_PROOF_DIR/client-approve.json"
test -f /Users/yulanbot/work/BROWSER-READY
C1_SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$C1_SECRET_STAGE"
printf '%s\n' "$C1_SECRET_STAGE" >"$C1_PROOF_DIR/secret-stage.path"
# Nonsecret pointer only; never write the URL/code/key/tokens here.
C1_POINTER=/Users/yulanbot/work/dcr-rt/admin-c1-${WINDOW_ID}.pointer
( set -C; umask 077; printf '%s\n' "$C1_SECRET_STAGE" >"$C1_POINTER" )
node scripts/admin-smoke.mjs \
 --authorize-url-file "$C1_SECRET_STAGE/authorize.url" \
 --callback-file "$C1_SECRET_STAGE/callback.url" \
 --receipt-file "$C1_PROOF_DIR/agent.json" \
 --verify-fenced --fence-file "$C1_SECRET_STAGE/fenced" \
 >"$C1_PROOF_DIR/agent-status.log" 2>&1 &
C1_RUNNER_PID=$!
printf '%s\n' "$C1_RUNNER_PID" >"$C1_PROOF_DIR/runner.pid"
```

HezLead's browser worker reads the pointer, waits for the 0600 authorize file,
performs fresh consent with the exact smoke capabilities and full-account
second confirmation, then atomically writes the full callback URL as 0600 to
the secret callback path without logging it. This is a separate browser-worker
assignment; this plan never launches the installed Chrome app. HezLead starts
the following box steps as soon as the agent reports
`agent_steps_complete_awaiting_human_fence`; the access token must remain live.
The box locates the smoke grant by the saved run-specific command ID, not a
most-recent-grant guess. Copy only agent.json (redacted command IDs) to the box.

```sh
# step: ai-w6-audit
# readonly: no
# host: HezLead box root; READ-ONLY SQL, smoke grant/family only
set -euo pipefail
: "${C1_AGENT_RECEIPT:?}" "${C1_INPUTS_FILE:?}"
python3 - "$C1_AGENT_RECEIPT" "$C1_INPUTS_FILE" "$PROOF_DIR/c1-audit.sql" <<'PY'
import json,pathlib,re,sys
r=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); run=r['run_id']; owner=c['owner_user_id']
assert re.fullmatch('[0-9a-f]{16}',run) and re.fullmatch(r'[0-9a-fA-F-]{36}',owner)
assert r['steps']['read_metadata_after_refresh']['result']=='pass'
command='c1_'+run+'_create_workspace'
assert r['steps']['create_workspace']['command_id']==command
# Audit has no client_id column: bind client through the durable grant row.
base="SELECT DISTINCT a.admin_grant_id,a.provider_grant_id FROM commonswarm_oauth.admin_oauth_audit a JOIN commonswarm_oauth.admin_grant_bindings b USING(admin_grant_id,provider_grant_id) WHERE a.owner_user_id='"+owner+"'::uuid AND a.request_id='"+command+"' AND b.client_id='https://commonswarm.com/oauth/c1-smoke/client.json'"
sql="BEGIN READ ONLY; SELECT count(*)=1 AS c1_one FROM ("+base+") s \\gset\n\\if :c1_one\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'ambiguous smoke binding'; END $$;\n\\endif\n"
sql+="WITH smoke AS ("+base+") SELECT json_build_object('grant_id',s.admin_grant_id,'provider_grant_id',s.provider_grant_id,'audit_counts',(SELECT json_object_agg(k.kind,k.n) FROM (SELECT kinds.kind,count(a.audit_id) AS n FROM (VALUES ('init'),('list'),('read'),('action')) kinds(kind) LEFT JOIN commonswarm_oauth.admin_oauth_audit a ON a.admin_grant_id=s.admin_grant_id AND a.provider_grant_id=s.provider_grant_id AND a.event_kind=kinds.kind AND a.outcome='committed' GROUP BY kinds.kind) k)) FROM smoke s; COMMIT;\n"
pathlib.Path(sys.argv[3]).write_text(sql)
PY
ai_ro -Atq --file /proof/c1-audit.sql >"$PROOF_DIR/C1-audit.json"
python3 - "$PROOF_DIR/C1-audit.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); assert set(r['audit_counts'])=={'init','list','read','action'} and all(type(n) is int and n>0 for n in r['audit_counts'].values())
PY
```

```sh
# step: ai-w6-human-revoke
# readonly: no
# host: HezLead Mac, OWNER's file-store CLI session; human revoke verb D6
set -euo pipefail
: "${C1_PROOF_DIR:?}" "${C1_SECRET_STAGE:?}"
# Copy the nonsecret C1-audit.json from the box into C1_PROOF_DIR first.
C1_GRANT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["grant_id"])' "$C1_PROOF_DIR/C1-audit.json")
C1_REVOKE_REQUEST_ID=$(node -e 'console.log(require("node:crypto").randomUUID())')
( set -C; printf '%s\n' "$C1_REVOKE_REQUEST_ID" >"$C1_PROOF_DIR/revoke-request-id" )
# Saved default CLI target/session must be the owner and production API; preflight checks below.
node --import tsx --input-type=module - "$C1_INPUTS_FILE" <<'JS'
import { readFile } from 'node:fs/promises';
import { credentialStore,defaultCredentialStateDirectory } from './src/cloud/storage.ts';
import { cloudTarget } from './src/cloud/config.ts';
import { refreshedCredential } from './src/cloud/auth.ts';
import { readCurrentTarget } from './src/cloud/current-target.ts';
try {
 const c=JSON.parse(await readFile(process.argv[2],'utf8')); const t=await readCurrentTarget();
 if(t?.url!=='https://api.commonswarm.com' || c.state_directory!==defaultCredentialStateDirectory()) throw Error();
 const store=await credentialStore({target:t,forceFile:true,warn:()=>{}}); const human=await refreshedCredential(t,store);
 if(human.userId!==c.owner_user_id) throw Error();
} catch { console.error('FAIL owner CLI target/session mismatch; STOP'); process.exitCode=1; }
JS
node --import tsx src/cli.ts admin revoke --grant-id "$C1_GRANT_ID" \
 --request-id "$C1_REVOKE_REQUEST_ID" --force-file-store --json \
 >"$C1_PROOF_DIR/human-revoke.json" 2>"$C1_PROOF_DIR/human-revoke-status.log"
python3 - "$C1_PROOF_DIR/human-revoke.json" "$C1_PROOF_DIR/agent.json" "$C1_SECRET_STAGE/fenced" <<'PY'
import json,os,pathlib,sys
r=json.load(open(sys.argv[1])); assert r['state']=='revoked'
a=json.load(open(sys.argv[2])); p=pathlib.Path(sys.argv[3]); assert not p.exists() and not p.is_symlink()
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: f.write(a['run_id']+'\n')
PY
# Same runner performs --verify-fenced with a still-live token. Never restart it.
wait "$C1_RUNNER_PID"
```

```sh
# step: ai-w6-fence-readback
# readonly: no
# host: HezLead box root; read-only DB fence proof, grant/family from C1 audit only
set -euo pipefail
python3 - "$PROOF_DIR/C1-audit.json" "$PROOF_DIR/c1-fence.sql" <<'PY'
import json,pathlib,re,sys
r=json.load(open(sys.argv[1])); g=r['grant_id']; family=r['provider_grant_id']
assert re.fullmatch(r'[0-9a-fA-F-]{36}',g) and isinstance(family,str) and 0<len(family)<=2048
quoted="'"+family.replace("'","''")+"'"
sql="SELECT g.state='revoked' AND b.state='revoked' AND t.grant_id IS NOT NULL FROM swarm.admin_grants g JOIN commonswarm_oauth.admin_grant_bindings b ON b.admin_grant_id=g.grant_id LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=b.provider_grant_id WHERE g.grant_id='"+g+"'::uuid AND b.provider_grant_id="+quoted+";\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
test "$(ai_ro -Atq --file /proof/c1-fence.sql)" = t
printf 'PASS grant revoked and refresh family tombstoned; live follow-up refusal recorded by runner\n' >"$PROOF_DIR/C1-fence.txt"
```

After the fence, execute ai-w6-owner-client-command with
`C1_CLIENT_ACTION=withdraw`; copy its redacted receipt and C1-fence.txt to the
Mac proof directory. Do not edit the runner receipt to invent human results.
The receipt below combines independently observed audit, human and agent proof.
The workspace remains **`c1-smoke-<runid> (test, archive me)`**, accepted residue
(D4), with a 10-second `/app` archive step on Tom's morning list. No archive is
claimed. W7/W4b follow-up: a separately reviewed site release removes
`site/public/oauth/c1-smoke/client.json` (or returns 404); verify public absence
and keep the callback free of secrets. Never leave a long-lived approved client.

```sh
# step: ai-w6-report
# readonly: no
# host: HezLead Mac; redacted report and machine receipt
set -euo pipefail
node --input-type=module - "$C1_PROOF_DIR" "$INPUTS_FILE" <<'JS'
import { readFile,writeFile } from 'node:fs/promises';
const [root,input]=process.argv.slice(2);
try {
 if(!(await readFile(`${root}/C1-cleanup.txt`,'utf8')).startsWith('PASS')) throw Error();
 const d=JSON.parse(await readFile(input,'utf8'));
 const a=JSON.parse(await readFile(`${root}/agent.json`,'utf8'));
 const audit=JSON.parse(await readFile(`${root}/C1-audit.json`,'utf8'));
 const revoke=JSON.parse(await readFile(`${root}/human-revoke.json`,'utf8'));
 const withdrawal=JSON.parse(await readFile(`${root}/client-withdraw.json`,'utf8'));
 const fence=await readFile(`${root}/C1-fence.txt`,'utf8');
 if(!a.ok || a.refused_after_fence?.refusal_code==null || ![401,403].includes(a.refused_after_fence.http_status) || revoke.state!=='revoked' || withdrawal.status!=='PASS' || !fence.startsWith('PASS') || !a.workspace.accepted_residue || !Object.values(audit.audit_counts).every(n=>Number.isSafeInteger(n)&&n>0)) throw Error();
 const r={release_sha:d.release_sha,status:'PASS',cleanup:true,audit_kinds:['init','list','read','action'],audit_counts:audit.audit_counts,grant_revoked:true,refresh_family_tombstoned:true,live_access_refused:true,client_approval_withdrawn:true,accepted_residue:a.workspace.name,site_document_removal:'W7/W4b next reviewed site release'};
 await writeFile(`${root}/C1.json`,JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});
 const text=`# C1 smoke\n\nRelease: ${d.release_sha}\n\nPASS hosted consent, PKCE/DPoP, init/list/read/action, create workspace/seat, revoke seat, refresh, human revoke, live access refusal and approval withdrawal.\n\nAudit counts: ${JSON.stringify(audit.audit_counts)}\n\nAccepted residue: ${a.workspace.name}. Tom: archive in /app.\n\nRefresh family tombstone measured; no post-revoke refresh request was made.\n\nFollow-up W7/W4b: next site release removes oauth/c1-smoke/client.json and verifies 404.\n`;
 await writeFile('/Users/yulanbot/work/hm37-live-release/C1-SMOKE-REPORT.md',text,{flag:'wx',mode:0o600});
} catch { console.error('FAIL C1 report evidence incomplete; STOP'); process.exitCode=1; }
JS
```

```sh
# step: ai-w6-secret-close
# readonly: no
# host: HezLead Mac; success or stopped runner, guarded private cleanup
set -euo pipefail
: "${C1_SECRET_STAGE:?}" "${C1_POINTER:?}" "${C1_PROOF_DIR:?}" "${C1_RUNNER_PID:?}"
if kill -0 "$C1_RUNNER_PID" 2>/dev/null; then printf 'FAIL runner still active; STOP before cleanup\n' >&2; exit 1; fi
python3 - "$C1_SECRET_STAGE" "$C1_POINTER" "$C1_PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pointer=pathlib.Path(sys.argv[2]); saved=pathlib.Path(sys.argv[3])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) and p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
assert saved.read_text().strip()==str(p)
assert re.fullmatch(r'/Users/yulanbot/work/dcr-rt/admin-c1-[A-Za-z0-9]{6}\.pointer',str(pointer)) and not pointer.is_symlink() and pointer.read_text().strip()==str(p)
PY
rm -r -- "$C1_SECRET_STAGE" || { printf 'FAIL cleanup refused %s; STOP\n' "$C1_SECRET_STAGE" >&2; exit 1; }
rm -- "$C1_POINTER" || { printf 'FAIL cleanup refused %s; STOP\n' "$C1_POINTER" >&2; exit 1; }
printf 'PASS private handoffs removed; redacted receipts and accepted residue retained\n' >"$C1_PROOF_DIR/C1-cleanup.txt"
```

## W7: separately approved retirement proof

Lane 5 already removes runtime mint/admission/callback in the release build,
and W3 performs the separately approved terminal DB fence before W5. W7 must
never be interpreted as allowing legacy authentication until smoke is done.
Its job is final retirement attestation after C1; no DROP of history or reserve
rollback. Historical rows remain for human recovery. No optional v1 delegation.

```sh
# step: ai-w7-approval
# readonly: yes
# host: Mac or box; before any W7 operation
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W7' and isinstance(a,dict), 'FAIL W7 explicit retirement approval required; STOP'
assert a.get('action')=='retire-legacy-admin-mint' and a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref'), 'FAIL W7 approval identity; STOP'
assert all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W7 approval binding; STOP'
print('W7 retirement approval present; C1 and unreachable proof remain required')
PY
```

```sh
# step: ai-w7-preflight
# readonly: yes
# host: box root; no mutation
set -euo pipefail
: "${C1_REPORT_FILE:?}" "${C1_REPORT_SHA256:?}"
python3 - "$C1_REPORT_FILE" "$C1_REPORT_SHA256" "$RELEASE_SHA" <<'PY'
import hashlib,json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
assert re.fullmatch('[0-9a-f]{64}',sys.argv[2]) and hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[2]
r=json.loads(p.read_text())
assert r.get('release_sha')==sys.argv[3] and r.get('status')=='PASS' and r.get('cleanup') is True
assert r.get('audit_kinds')==['init','list','read','action'] and r.get('grant_revoked') is True and r.get('refresh_family_tombstoned') is True and r.get('live_access_refused') is True and r.get('client_approval_withdrawn') is True, 'FAIL W7 C1 incomplete; STOP'
PY
```

```sh
# step: ai-w7-proof
# readonly: no
# host: box root; database read-only; ai-gates required, including legacy proof
set -euo pipefail
test "$WINDOW" = W7
ai_run ai-w7-approval
ai_run ai-gates
ai_run ai-w7-preflight
ai_deadline
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(ai_ro -Atq --command "SELECT legacy_closed AND legacy_fence_evidence_ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t
# Runtime wrapper removal is a build proof, paired with actual OAuth positive
# controls in legacy-admin-unreachable. Do not call a private mint to test it.
python3 - "$RELEASE_ROOT/supabase/functions/command/index.ts" <<'PY'
import pathlib,re,sys
s=pathlib.Path(sys.argv[1]).read_text()
assert not re.search(r'export\s+(?:async\s+)?function\s+handleAdminRuntimeCommand\b',s), 'FAIL runtime export survives; STOP'
PY
printf 'PASS W7 legacy runtime and DB auth permanently unreachable; history retained\n' >"$PROOF_DIR/retirement.txt"
```

W7/W4b site cleanup follow-up: make a separately reviewed commit removing
`site/public/oauth/c1-smoke/client.json`, release the resulting landed SHA with
the W4 site procedure, then retain a public 404 probe receipt. This plan never
removes a tracked file inside an immutable release or rebuilds an old SHA.

## Close and abort cleanup

Before forward close run ai-ordinary-probes, the window's specific probes and
ai-live-controls phase after. Before recovered close use phase recovery. Supply
`CLOSE_RESULT=success|recovered` only after those proofs; it is an outcome input,
not permission to skip probes. Failed recovery cannot close. W6 creates nothing while its explicit rulings or approval inputs are absent.
Recovered close requires emergency env/overlay/DB close and ordinary controls.

```sh
# step: ai-close
# readonly: no
# host: box root; verified success/recovery only
set -euo pipefail
: "${CLOSE_RESULT:?}"
case "$CLOSE_RESULT" in success) test -f "$PROOF_DIR/ordinary-after.json";; recovered) test -f "$PROOF_DIR/ordinary-recovery.json";; *) exit 1;; esac
if test "$CLOSE_RESULT" = success; then
 case "$WINDOW" in
  W1) test -f "$PROOF_DIR/schema-committed.txt" && test -f "$PROOF_DIR/W1-probes.txt" && test -f "$PROOF_DIR/issuer-credential.txt";;
  W2) test -f "$PROOF_DIR/W2-probes.txt";;
  W3) test -f "$PROOF_DIR/W3-readback.txt";;
  W5) test -f "$PROOF_DIR/W5-probes.txt";;
  W6) test -f "$PROOF_DIR/C1.json" && test -f "$PROOF_DIR/C1-cleanup.txt";;
  W7) test -f "$PROOF_DIR/retirement.txt";;
  *) echo 'FAIL no implemented forward close for this window; STOP' >&2; exit 1;;
 esac
fi
test ! -e "$PROOF_DIR/closed.txt"
if test "$CLOSE_RESULT" = success && { test "$WINDOW" = W5 || test "$WINDOW" = W6 || test "$WINDOW" = W7; }; then
 test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND invalidated_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
else
 test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
fi
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"
python3 - "$SECRET_STAGE" "$PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert pathlib.Path(sys.argv[2]).read_text().strip()==str(p)
for denied in ['', '/', str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child']:
    assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',denied) is None
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) and p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p
assert p.stat().st_mode & 0o777==0o700
PY
# Use guarded PATH rm; a refusal stops cleanup.
rm -r -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; retain path and exact guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/closed.txt"
printf 'PASS window closed %s; nonsecret proofs retained\n' "$CLOSE_RESULT"
```

```sh
# step: ai-open-abort
# readonly: no
# host: box root; no production operation occurred before failed open
set -euo pipefail
: "${PROOF_DIR:?}"
SECRET_STAGE=$(cat "$PROOF_DIR/secret-stage.path")
python3 - "$SECRET_STAGE" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_mode & 0o777==0o700
PY
rm -r -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; report guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/aborted-before-mutation.txt"
```

```sh
# step: ai-mac-close
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
: "${PREP_DIR:?}"
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm
python3 - "$PREP_DIR" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/admin-issuance-prep\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_mode & 0o777==0o700
PY
rm -r -- "$PREP_DIR" || { printf 'FAIL cleanup refused %s; report exact guard message; STOP\n' "$PREP_DIR" >&2; exit 1; }
test ! -e "$PREP_DIR"
```

Archives on the box are nonsecret and retained for W5 remeasurement. Do not
remove immutable release/proof directories; future retention is a separate
assignment. Every close is recorded in the operator's LOG.md with actual
start/end, identities, gate/probe receipts, approved rollback decision and
secret cleanup outcome. This preparation LOG contains no execution claims.
