# Admin issuance release: W1–W7

Prepared, not executed. This plan releases one reviewed `RELEASE_SHA`, landed on
main, in seven separately authorized windows. The preparation worker has made
no box measurements. Neither this document nor a PASS receipt grants approval.
Admin issuance remains OFF. **W5 and W6 deliberately STOP on this source tree**:
`ADMIN_AS_ISSUANCE_ENABLED` is a compile-time false pin. Do not replace the pin,
patch a running image, or invent an environment switch during a window.

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
| W1 SCHEMA | ai-inputs, ai-gates, ai-prepare, ai-box-preflight; ai-open, ai-db-session, ai-w1-preflight, ai-w1-apply, ai-w1-reconcile, ai-w1-probes, ai-close. One transaction applies 01→05, then inserts all five ledger/checksum pairs and historical backfills. Failure before COMMIT rolls back the whole transaction. After COMMIT retain additive schema; never drop evidence/history. |
| W2 OAUTH | common ai-inputs/ai-gates/preflight/open/session; ai-w2-preflight, ai-w2-build, ai-w2-apply, ai-w2-local-gate, ai-ordinary-probes, ai-close. On failure ai-w2-rollback, common ordinary controls, then close. Existing ordinary MCP stays ON; admin pin remains OFF. |
| W3 EDGE/CADDY | common ai-inputs/ai-gates/preflight/open/session; ai-w3-preflight, ai-w3-caddy-candidate, ai-w3-apply (close/invalidate, edge switch, terminal legacy fence, measured record, both Caddy routes, validate/reload), ai-w3-probes, ai-w3-readback, ai-close. Failure ai-w3-rollback, ordinary controls, close; legacy fence is permanent. |
| W4 SITE | common preflight; ai-w4-preflight, ai-w4-reference for the generalized site plan's complete preflight/open/build/probe/rollback/close sequence. No browser step without separately assigned QA authorization. Site baseline is remeasured by that plan; admin gate remains closed. |
| W5 ACTIVATION | ai-w5-approval, common preflight/open/session, ai-w5-checks, ai-w5-apply **STOP**. Approval never overrides a missing implementation. No open-gate receipt on this tree. Rollback ai-emergency-close; preserve history, human grant/family reconciliation under separate approved plan. |
| W6 C1 ADMIN SMOKE | ai-w6-preflight **STOP before open/consent/mutations on this tree**. Future hosted consent and callback-file contract is below; no surrogate human bearer or direct SQL admin grant. |
| W7 RETIRE | ai-w7-approval, common preflight/open/session, ai-w7-preflight **STOP without C1**, ai-w7-proof, ai-close. This build already removes the runtime mint; retirement is proof/attestation, not reintroducing it until W7. Failure ai-emergency-close; never restore opaque authentication. |

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
keys='release_sha plan_sha256 archive_sha256 window window_id window_end_utc baseline_oauth_sha baseline_oauth_image baseline_edge_sha baseline_edge_image baseline_stack_sha baseline_postgres_image baseline_site_sha baseline_site_target baseline_mcp_caddy_sha256 baseline_api_caddy_sha256 baseline_caddyfile_sha256 baseline_ledger_sha256 gate_receipt_sha256 rollback_decision approval legacy_fence_approval'.split()
need(isinstance(d,dict) and set(d)==set(keys), 'required input keys')
for k in keys:
    if k.endswith('_sha'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{40}',d[k]), k)
    elif k.endswith('_sha256'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{64}',d[k]), k)
    elif k.endswith('_image'):
        need(isinstance(d[k],str) and re.fullmatch('sha256:[0-9a-f]{64}',d[k]), k)
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
need(output(['systemctl','is-active','commonswarm-edge-recycle.timer'])=='active','recycle timer active')
need(output(['systemctl','show','-p','ActiveState','--value','commonswarm-edge-recycle.service'])=='inactive','recycle service inactive')
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
 case "$STEP_NAME" in ai-inputs|ai-gates|ai-w5-approval|ai-w7-approval|ai-w7-preflight) ;; *) return 1;; esac
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

The receipt is an input, not an invented smoke runner. Its missing public-path
execution blocks are listed in LIMITS.md; W1–W4 cannot open until HezLead
supplies and reviews them. Do not execute prose as a command or treat offline
tests as a live unchanged-path proof.

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

## W2: OAuth code release, ordinary MCP ON, issuance pin OFF

W2 uses the existing ON service configuration and management credential. It
does not install the missing dedicated admin-issuer mount; it remains a W5
blocker. All baseline Compose files must be exactly the two reviewed base and
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
python3 - "$RELEASE_ROOT/services/mcp-auth/src/admin-consent.js" <<'PY'
import pathlib,re,sys
assert re.search(r'^export const ADMIN_AS_ISSUANCE_ENABLED = false;$',pathlib.Path(sys.argv[1]).read_text(),re.M), 'FAIL OFF pin changed; STOP'
PY
test ! -e "$NEW_OAUTH" && test ! -L "$NEW_OAUTH"
mkdir -p "$NEW_OAUTH"
cp -a "$RELEASE_ROOT/." "$NEW_OAUTH/"
printf 'PASS W2 baseline Compose exact; schema present; pin OFF\n'
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
 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.dependencies["oidc-provider"]!=="9.12.2" || !fs.readFileSync("src/admin-consent.js","utf8").includes("export const ADMIN_AS_ISSUANCE_ENABLED = false;") || !fs.existsSync("src/admin-authority.generated.js")) process.exit(1)' >/dev/null 2>&1
printf 'PASS W2 CPU-capped image; immutable source label; pin OFF\n'
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
paused only during this window and restored on success/failure. Before activation
its restart path still needs reviewed invalidation/remeasurement wiring: W5 STOPs
until all authorized edge paths implement it. Readiness JSON is diagnostic only.

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
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp() WHERE singleton; COMMIT;" >/dev/null
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-attempted.txt"
systemctl stop commonswarm-edge-recycle.timer
test "$(systemctl show -p ActiveState --value commonswarm-edge-recycle.service)" = inactive
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
systemctl start commonswarm-edge-recycle.timer
systemctl is-active --quiet commonswarm-edge-recycle.timer
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
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp() WHERE singleton; COMMIT;" >/dev/null
systemctl stop commonswarm-edge-recycle.timer
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
systemctl start commonswarm-edge-recycle.timer
systemctl is-active --quiet commonswarm-edge-recycle.timer
printf 'PASS W3 baseline source/Caddy restored; measurement invalid; legacy remains fenced\n'
```

```sh
# step: ai-w3-timer-recovery
# readonly: no
# host: box root; also available after a failed rollback; not a close receipt
set -euo pipefail
systemctl start commonswarm-edge-recycle.timer
systemctl is-active --quiet commonswarm-edge-recycle.timer
printf 'Timer restored; window remains open until service recovery is verified\n'
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
print('W5 approval present; implementation and every named proof remain required')
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
printf 'PASS W5 DB release identity/checksum/legacy controls; implementation still required\n'
```

```sh
# step: ai-w5-apply
# readonly: yes
# host: box root; intentional implementation STOP; approval cannot bypass
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W5' and isinstance(a,dict) and a.get('action')=='activate-admin-issuance', 'FAIL W5 activation approval required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) for k in ('release_sha','window_id','plan_sha256')), 'FAIL W5 approval binding; STOP'
raise SystemExit('FAIL W5 activation-switch-unavailable: ADMIN_AS_ISSUANCE_ENABLED is hard false; issuer mount/rotation, gate cancellation and all edge restart measurement paths need reviewed implementation; STOP without mutation')
PY
```

There is intentionally no DB flag flip pretending to open the AS. A future
reviewed plan revision must (1) implement and check the real switch, (2) stage
the NOINHERIT issuer credential/mount and prove production grants/rotation,
(3) reconcile all GATES.json controls, (4) invalidate/remeasure edge immediately
before activation, (5) write lane8_evidence_digest and expected migration hashes
while DB issuance is closed, (6) confirm zero checksum failures, (7) flip the
DB and AS gates through that implemented control, (8) probe actual GET/HEAD
`/admin/gate` open with CORS, and (9) execute W6. This checklist is **not runnable**
and grants no authority to invent SQL or restart commands.

```sh
# step: ai-emergency-close
# readonly: no
# host: box root; approved recovery only; never reopens opaque authentication
set -euo pipefail
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp() WHERE singleton; COMMIT;" >/dev/null
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
printf 'DB issuance closed, measurement invalidated; existing grants require explicit human revoke/family reconciliation\n'
```

## W6: C1 hosted OAuth admin smoke, blocked until real activation

The task asks for an agent to obtain a hosted-consented admin grant, create a
test workspace, add a seat, revoke it, read D3 audit and clean up. The current
tree cannot execute that chain. **This plan retains the FAIL gates**, rather
than accepting a supplied token, self-signed JWT, direct database grant or
the retired private delivery callback. W6 cannot write an authorize URL or
create any workspace until W5 has genuinely opened and the revised client
smoke runner exists. Required runner work is spelled out in LIMITS.md.

```sh
# step: ai-w6-preflight
# readonly: yes
# host: Mac /bin/bash 3.2; before consent, files, network or mutations
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W6' and isinstance(a,dict) and a.get('action')=='admin-smoke-human-consent', 'FAIL W6 human consent assignment required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) for k in ('release_sha','window_id','plan_sha256')), 'FAIL W6 approval binding; STOP'
raise SystemExit('FAIL W6 smoke-runtime-path-unavailable / smoke-runtime-delivery-unavailable: hard-false AS pin and no reviewed admin PKCE/DPoP callback-file smoke runner; STOP before consent or mutation')
PY
```

The future W6 callback protocol must use `/Users/yulanbot/work/dcr-rt/` only
as a **nonsecret rendezvous pointer**: a newly allocated task-named manifest
file points to the fresh `/private/tmp/anvil-secret.XXXXXX` directory. The
authorize URL file, state, verifier, private DPoP key, callback URL/code and
token store all live in that secret directory, mode 0600. HezLead's assigned
browser worker reads the URL file and writes the complete callback URL to the
callback file in that same directory, atomically, without logging either.
Wait at most ten minutes, poll without starting a browser, require exact
redirect URI/state/optional issuer and one code, reject OAuth errors/duplicates,
and never send secrets to the `.invalid` redirect host. Keep the URL out of
stdout and public evidence. `scripts/dcr-roundtrip.mjs` currently uses hidden
stdin, not files; the task's claimed same protocol is a **contract gap**, not
permission to retrofit that script in this docs-only lane.

Future C1 runner contract (all mandatory, exact build; no code here can pass it):

1. Verify AS/edge/site live identities, checksum gate, closure, gate open,
   pinned hosted HTTPS CIMD/static client verification, fresh account-owner
   `/app` approval and PKCE/DPoP compatibility. Reject DCR/native/loopback.
   Use full-account consent with an explicit reviewed routine capability list
   if creating the test workspace after the grant; granular consent cannot
   silently select a workspace that does not exist. No dormant scopes/delegation.
2. Hosted consent is a fresh human action: display exact client, manifest,
   expiry and full-account second confirmation. Require one
   AdminDelegationGranted from human recovery, receipt/digests/binding IDs only.
3. Exchange the code using S256 verifier, explicit admin resource and ES256
   same-key DPoP at canonical issuer `/token`, including nonce challenge/fresh
   jti protocol. Consume HTTP 200 directly to a 0600 protected runtime store;
   require token_type DPoP, exact granted scopes, bound key and deadline-clipped
   TTL <=300, one committed AdminCredentialIssued audit. Never dump claims/body.
4. Through the actual admin MCP transport initialize, list, read and act with
   fresh proofs; pair wrong-key/no-proof refusal with live valid-key control.
   Save command IDs **before** send. Create the test workspace through the
   supported admin routine, add a seat, revoke it. Require linked domain events,
   account cards and bounded D3 init/list/read/action audit tied to grant/family.
5. Refresh once with same client/resource/key, unchanged consent deadline and
   no scope/budget reset. Any replay-kill test needs a second separately approved
   grant; it must not kill the grant used for the positive smoke.
6. Fresh human owner revokes the smoke grant/family, proves previously valid
   access and refresh both refused, archives the workspace through the human
   command path, and verifies history survives. Unknown outcomes STOP using
   saved command IDs; separately reviewed reconciliation only, no automatic retry.
7. Redacted `C1.json` contains exact release_sha, manifest digest, safe generated
   IDs/event IDs, bounded request statuses, deadline/TTL PASS booleans, each
   audit kind PASS, cleanup/revoke/refresh refusal PASS and overall PASS. Exclude
   URLs, callback, headers, tokens, proofs, key material, session bindings and
   raw remote payloads. Close removes secret files with guarded rm and leaves
   only allowlisted receipts plus nonsecret rendezvous pointer removal.

The following two complete file-handshake blocks are prepared for the revised
W6 runner. **They are unreachable in this revision**: ai-w6-preflight STOPs,
and the URL producer independently requires an actually open gate before it
writes any secret. `ADMIN_REVIEW_CLIENT_FILE` is a reviewed nonsecret JSON
file containing only client_id and redirect_uri; both are pinned hosted HTTPS
URIs, never a DCR/native/loopback client. The W5 verification/owner-approval
receipt binds these exact values. No .invalid redirect callback is fetched.

```sh
# step: ai-w6-consent-url
# readonly: probe
# host: future authorized Mac worker; no browser launch
set -euo pipefail
: "${INPUTS_FILE:?}" "${SECRET_STAGE:?}" "${ADMIN_REVIEW_CLIENT_FILE:?}"
node --input-type=module - "$INPUTS_FILE" "$SECRET_STAGE" "$ADMIN_REVIEW_CLIENT_FILE" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
const [inputFile, stage, clientFile] = process.argv.slice(2);
const need = (ok) => { if (!ok) throw new Error('contract'); };
try {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const a = input.approval;
  need(input.window === 'W6' && a?.action === 'admin-smoke-human-consent' &&
    ['Tom', 'HezLead'].includes(a.approver) && a.prompt_ref &&
    ['release_sha', 'window_id', 'plan_sha256'].every(k => a[k] === input[k]));
  const r = await fetch('https://mcp.commonswarm.com/admin/gate', {
    headers: { Origin: 'https://commonswarm.com', 'User-Agent': 'curl/8.7.1' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  need(r.status === 200 && r.headers.get('access-control-allow-origin') === '*');
  const gate = await r.text(); need(gate.length <= 4096 && JSON.parse(gate).state === 'open');
  need(/^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]{6}$/.test(stage) &&
    fs.realpathSync(stage) === stage && !fs.lstatSync(stage).isSymbolicLink() &&
    (fs.statSync(stage).mode & 0o777) === 0o700);
  need(path.isAbsolute(clientFile) && !fs.lstatSync(clientFile).isSymbolicLink());
  const client = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
  need(Object.keys(client).sort().join(',') === 'client_id,redirect_uri');
  for (const value of [client.client_id, client.redirect_uri]) {
    const u = new URL(value);
    need(u.protocol === 'https:' && !u.username && !u.password && !u.hash &&
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const jkt = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
  const uri = new URL('https://mcp.commonswarm.com/authorize');
  uri.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uri,
    response_type: 'code', resource: 'https://api.commonswarm.com/admin',
    scope: 'openid offline_access admin:read workspaces:create seats:create seats:revoke',
    code_challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    code_challenge_method: 'S256', dpop_jkt: jkt, state }).toString();
  const save = (name, value) => fs.writeFileSync(path.join(stage, name), value, { mode: 0o600, flag: 'wx' });
  save('pkce-state.json', JSON.stringify({ verifier, state, jkt, client, created_at: Date.now() }));
  save('dpop-private.pem', privateKey.export({ format: 'pem', type: 'pkcs8' }));
  save('authorize.url', uri.href + '\n');
  const rendezvous = '/Users/yulanbot/work/dcr-rt';
  fs.mkdirSync(rendezvous, { recursive: true, mode: 0o700 });
  need(fs.realpathSync(rendezvous) === rendezvous && !fs.lstatSync(rendezvous).isSymbolicLink());
  const pointer = path.join(rendezvous, `admin-${input.window_id}.json`);
  fs.writeFileSync(pointer, JSON.stringify({ release_sha: input.release_sha,
    authorize_file: path.join(stage, 'authorize.url'), callback_file: path.join(stage, 'callback.url') }) + '\n',
    { mode: 0o600, flag: 'wx' });
  console.log('PASS W6 URL written privately; assigned consent worker may read the rendezvous pointer');
} catch { console.error('FAIL W6 consent-url contract or gate closed; STOP'); process.exitCode = 1; }
JS
```

```sh
# step: ai-w6-wait-callback
# readonly: no
# host: future authorized Mac worker; only protected file I/O, no token exchange
set -euo pipefail
: "${SECRET_STAGE:?}"
node --input-type=module - "$SECRET_STAGE" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const stage = process.argv[2], callback = path.join(stage, 'callback.url');
const need = ok => { if (!ok) throw new Error('contract'); };
try {
  need(/^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]{6}$/.test(stage) && fs.realpathSync(stage) === stage &&
    !fs.lstatSync(stage).isSymbolicLink() && (fs.statSync(stage).mode & 0o777) === 0o700);
  const saved = JSON.parse(fs.readFileSync(path.join(stage, 'pkce-state.json'), 'utf8'));
  need(Number.isSafeInteger(saved.created_at));
  const end = saved.created_at + 600_000;
  while (!fs.existsSync(callback) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  need(Date.now() < end && fs.existsSync(callback) && !fs.lstatSync(callback).isSymbolicLink() &&
    fs.statSync(callback).isFile() && fs.statSync(callback).size <= 16384 && (fs.statSync(callback).mode & 0o777) === 0o600);
  const url = new URL(fs.readFileSync(callback, 'utf8').trim());
  const redirect = new URL(saved.client.redirect_uri);
  need(url.origin + url.pathname === redirect.origin + redirect.pathname && !url.hash && !url.username && !url.password);
  need(url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === saved.state);
  need(!url.searchParams.has('error') && url.searchParams.getAll('code').length === 1 && url.searchParams.get('code'));
  if (url.searchParams.has('iss')) need(url.searchParams.getAll('iss').length === 1 &&
    url.searchParams.get('iss') === 'https://mcp.commonswarm.com');
  fs.writeFileSync(path.join(stage, 'authorization-code.json'), JSON.stringify({ code: url.searchParams.get('code') }),
    { mode: 0o600, flag: 'wx' });
  console.log('PASS W6 callback privately bound; reviewed token/delivery block still required');
} catch { console.error('FAIL W6 callback contract/timeout; STOP without token exchange'); process.exitCode = 1; }
JS
```

After the revised smoke runner has cleaned up, remove its exact nonsecret
rendezvous pointer using this marked block; never remove another task's pointer.
This is also available after a failed consent, followed by guarded secret close.

```sh
# step: ai-w6-pointer-close
# readonly: no
# host: future authorized Mac worker
set -euo pipefail
: "${INPUTS_FILE:?}"
WINDOW_ID=$(python3 -c 'import json,re,sys; d=json.load(open(sys.argv[1])); assert d["window"]=="W6" and re.fullmatch("[A-Za-z0-9]{6}",d["window_id"]); print(d["window_id"])' "$INPUTS_FILE")
POINTER=/Users/yulanbot/work/dcr-rt/admin-${WINDOW_ID}.json
test -f "$POINTER" && test ! -L "$POINTER"
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm
rm -- "$POINTER" || { printf 'FAIL pointer cleanup refused %s; retain and report guard message; STOP\n' "$POINTER" >&2; exit 1; }
test ! -e "$POINTER"
```

No C1 receipt is supplied by this preparation. Both old smoke FAIL gates remain.

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
assert r.get('audit_kinds')==['init','list','read','action'] and r.get('access_refresh_revoked') is True, 'FAIL W7 C1 incomplete; STOP'
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

## Close and abort cleanup

Before forward close run ai-ordinary-probes, the window's specific probes and
ai-live-controls phase after. Before recovered close use phase recovery. Supply
`CLOSE_RESULT=success|recovered` only after those proofs; it is an outcome input,
not permission to skip probes. Failed recovery cannot close. W5/W6 blocked
preflight creates nothing; a later W5 open followed by implementation STOP can
close recovered only after emergency DB close and ordinary recovery controls.

```sh
# step: ai-close
# readonly: no
# host: box root; verified success/recovery only
set -euo pipefail
: "${CLOSE_RESULT:?}"
case "$CLOSE_RESULT" in success) test -f "$PROOF_DIR/ordinary-after.json";; recovered) test -f "$PROOF_DIR/ordinary-recovery.json";; *) exit 1;; esac
if test "$CLOSE_RESULT" = success; then
 case "$WINDOW" in
  W1) test -f "$PROOF_DIR/schema-committed.txt" && test -f "$PROOF_DIR/W1-probes.txt";;
  W2) test -f "$PROOF_DIR/W2-probes.txt";;
  W3) test -f "$PROOF_DIR/W3-readback.txt";;
  W7) test -f "$PROOF_DIR/retirement.txt";;
  *) echo 'FAIL no implemented forward close for this window; STOP' >&2; exit 1;;
 esac
fi
test ! -e "$PROOF_DIR/closed.txt"
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
systemctl is-active --quiet commonswarm-edge-recycle.timer
python3 - "$SECRET_STAGE" "$PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert pathlib.Path(sys.argv[2]).read_text().strip()==str(p)
for denied in ['', '/', str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child']:
    assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',denied) is None
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) and p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p
assert p.stat().st_mode & 0o777==0o700
PY
# Use guarded PATH rm; a refusal stops cleanup.
rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; retain path and exact guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
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
rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; report guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
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
rm -rf -- "$PREP_DIR" || { printf 'FAIL cleanup refused %s; report exact guard message; STOP\n' "$PREP_DIR" >&2; exit 1; }
test ! -e "$PREP_DIR"
```

Archives on the box are nonsecret and retained for W5 remeasurement. Do not
remove immutable release/proof directories; future retention is a separate
assignment. Every close is recorded in the operator's LOG.md with actual
start/end, identities, gate/probe receipts, approved rollback decision and
secret cleanup outcome. This preparation LOG contains no execution claims.
