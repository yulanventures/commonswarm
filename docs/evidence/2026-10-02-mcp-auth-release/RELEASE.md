# HM37 OAuth binding release and MCP switch-on
Mac blocks must not call setuid/setgid tools.

Box image-build rule: build once per `OAUTH_RELEASE_SHA` and reuse the
persistent local `commonswarm-oauth:release-<SHA>` tag across retries/windows.
Verify `org.opencontainers.image.revision` equals that SHA before reuse or
deployment; build only if absent. The marked build explicitly selects the
legacy builder with `DOCKER_BUILDKIT=0`, then uses `nice -n 15` and
`--cpu-period=100000 --cpu-quota=300000` to cap its sequential build steps at
three CPUs. Unsupported caps or mismatched labels are STOP. See the shared
preamble in [RELEASE-TO-BOX.md](../../../deploy/RELEASE-TO-BOX.md).

**Prepared, not executed.** Base: origin/main `68a0d2a6715bfb4c874655cda6a4c490eea5baae`.
That tree has no production lane-2 composition: Docker CMD and npm start run
`node src/server.js`, which calls `startServer()` without either binding.
This lane builds the existing management transaction handler into the OAuth
image and composes it with a verified-user workspace reader at that entrypoint.

HezLead must arrange independent review, land the fix on main, then supply
`OAUTH_RELEASE_SHA` as the exact landed 40-character SHA. This document's
presence grants no production approval. `TOM_ENABLE_APPROVAL=2026-09-29` is
a **named prompt input supplied by HezLead**, required only for switch-on.
The done-test follows separately; route readiness is not a completed sign-in.

## Measurement limits and release inputs

The original allowed read-only command `ssh -o BatchMode=yes -o ConnectTimeout=10
ops@100.115.66.74 ...` failed with `Operation not permitted` at port 22 in
this worker's sandbox. **No live path, image, port, env file, container or
health was measured by this preparation worker.** The following are repository/handoff baselines,
which the preflight below must reconcile before any production mutation.
Later HezLead measurements in `~/work/hm37-live-release/OAUTH-REPORT.md`
and TASK-5 supply the equivalent Caddy import, JWKS type, box rm binary,
transport modes and Compose UID:GID used below; this worker has not rerun
those live checks:

| Input | Repository / HezLead evidence |
| --- | --- |
| `EXPECTED_OAUTH_SHA` | HezLead's latest measured live ON or OFF report; full 40 lowercase hex, independently checked against the running source |
| `EXPECTED_OAUTH_IMAGE_DIGEST` | Same measured report; full sha256 + 64 lowercase hex, independently checked against the running image; no registry tag |
| Historical OAuth baseline only | `826db6a34f235064a3a03c57377d8e32a35d2f05` / `sha256:5511a358e0a7d7d52749d2b7b562d8343cf0daf79e2d389041cb9ca359a6dd5a`; HM6, superseded by try 2 |
| Latest task handoff | TASK-11 reports production ON at source `603a206e`, image prefix `sha256:67687a3f`, both flags 1, management override/mount present and Caddy active. Prefixes are evidence only; HezLead supplies the full measured inputs. |
| OAuth project / service / container | `commonswarm-oauth` / `oauth` / `commonswarm-oauth-oauth-1` |
| OAuth inputs | `/etc/commonswarm-oauth/compose.env`, `/etc/commonswarm-oauth/service.env` |
| Port/network | HM6 recorded loopback `3490`; Compose allows `3490..3499`; `commonswarm-net` |
| `EXPECTED_EDGE_SHA` | HezLead's latest measured edge release; full 40 lowercase hex, checked against the running container's Compose labels, `/home/commonswarm/edge/current` and `RELEASE_SHA` |
| Edge project / service / container | `commonswarm-edge` / `edge-runtime` / `commonswarm-edge-edge-runtime-1` |
| Edge env/override | `/home/commonswarm/.env`; deployed `deploy/edge-runtime/compose.override.yaml` must be retained |
| Caddy | `/etc/caddy/Caddyfile`, `/etc/caddy/sites/20-commonswarm-mcp.caddy`; HM6 rendered OAuth ingress, resource routes dark |
| Existing protected files | `/etc/commonswarm-oauth/{signing-keys.pem,cookie-keys,database-credentials}`, `/etc/ssl/yulan-internal-ca.pem` |
| ON-only protected file | `/etc/commonswarm-oauth/management-database-credentials`, JSON `databaseUrl` from the existing edge DB configuration |

Sources: `deploy/mcp-auth/{RUNBOOK.md,compose.yaml,compose.management.yaml,env.example}`,
`deploy/edge-runtime/compose.yaml`, `deploy/supabase-stack/commonswarm-mcp.caddy`,
`docs/evidence/2026-09-28-release-826db6a34f23-v5/`, and the supplied
`~/work/hm37-live-release/B-FINAL-REPORT.md`. The latter reports B PASS and
both flags rolled back OFF; it is a handoff, not this worker's live measurement.
The later `~/work/hm37-live-release/OAUTH-ON-REPORT.md` (try 2) reports
972df171 / 80b52aa6 healthy and OFF with 28 OFF probes passed, then closes
the window. Preserve its source and proof directory. The two baseline inputs
must come from HezLead's latest measured report, not from these expected values;
preflight and open independently reconcile them against the running container.
The rollback release/Compose path comes from its labels and working directory,
with the current symlink and RELEASE_SHA checked against that measured path.

New input **name**: `MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE` (container
path `/run/commonswarm-oauth/management-database-credentials`). Step (f)
installs the newly produced credential and adds `compose.management.yaml`;
ON-baseline recovery reinstalls the captured original file/override. OFF uses the unchanged base
Compose file and has no management credential on host or in container. Its value
source is a protected on-box file, not an environment secret or management
bearer. Only `SWARM_DATABASE_URL` in `/home/commonswarm/.env` supplies the edge login.
A root program reads it on the box at switch-on; there is no fallback, new
1Password item, secret shell variable, secret argv or credential output.
Before writing even the staged credential it checks membership, SET ROLE and
the management path's schema/table privileges with that login in read-only
transactions. A failed requirement prints its number and fixed description
(`FAIL hm37-mcp-enable REQ <n>: <description>`), including privilege/object/role
for grants, and stops; never widen grants. That login must set `swarm_command` and `swarm_read`;
do not grant these to `commonswarm_oauth_runtime`. Existing
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, GoTrue config, signing/cookie inputs and
CA remain in their named service files/mounts. The repo does not name exact
OAuth 1Password items: HM6 takes `OAUTH_SIGNING_OP_REFERENCE`,
`OAUTH_COOKIE_OP_REFERENCE`, `OAUTH_DATABASE_OP_REFERENCE` from HezLead in
vault **Yulan Ventures Infra**. Do not invent item names. No op call is needed
for this procedure's reuse of existing box files; recovery must use the
service-account token file and fresh protected staging under Anvil's rules.

Execute only the marked blocks, extracted by step ID. Mac blocks use Bash
3.2 syntax. Box blocks run in HezLead's approved root release shell; **this
preparation worker has not used sudo**. Each box block receives the same
nonsecret `OAUTH_RELEASE_SHA`; preflight and open also receive the two
baseline inputs, `EXPECTED_EDGE_SHA` and the checked MODE; later blocks reload a root-owned state file holding
only paths, SHA/image identity, and helper code. On deploy/verification FAIL stop forward
work and follow the failure-state table before cleanup/closing. CLOSE_FAILED
after verified ON follows the closure decision table and never requests rollback. Do not invent
commands during the window. No Actions, HOME changes, Mac Docker or browser.

## HezLead rerun order and input sources

The try-2 window is closed: restart at (0) with the reviewed merge of this
branch landed on main, a fresh archive and fresh secret staging. Execute each
existing marked block by its step ID; no ad hoc recovery of the closed state.

| Phase | Exact step IDs, in order |
| --- | --- |
| (0) | `hm37-oauth-plan-inputs`, then `hm37-mcp-baseline-state` (box, read-only; retain the same root shell for preflight/open) |
| (a) | `hm37-oauth-archive` (Mac), `hm37-oauth-preflight` (box), then `hm37-oauth-open` (box) |
| (a1), ON baseline only | `hm37-mcp-transition-off` immediately after open, then `hm37-mcp-route-probes` with `MCP_EXPECTED_MODE=off`. OFF baselines skip (a1). |
| (b) | `hm37-oauth-build` |
| (c) | `hm37-oauth-inputs` |
| (d) | `hm37-oauth-release-off`, then `hm37-mcp-route-probes` with `MCP_EXPECTED_MODE=off` |
| (e), failure recovery only | `hm37-oauth-rollback`: baseline image OFF and OFF probes, then exact baseline ON restoration and ON probes/memory if the baseline was ON. These checks run inside the block; stop forward work. |
| (f), after every OFF gate passes | `hm37-mcp-enable`, then `hm37-mcp-route-probes` with `MCP_EXPECTED_MODE=on` (includes memory gate) |

On failed enable/ON probes, automatic rollback is followed by
`hm37-mcp-disable` and `hm37-mcp-route-probes` with `MCP_EXPECTED_MODE=off`.
For an ON baseline, every failure after transition (including build/inputs,
OFF release/probes, enable and ON probes/memory) must run (e) to restore the
baseline image and ON snapshots. For an OFF baseline, use (e) if the release
must revert. After successful ON or verified baseline recovery, run `hm37-oauth-close` (box) and
`hm37-oauth-mac-close` (Mac). Stop and report any failed rollback/cleanup.
The separately approved HM done-test follows successful activation.

| Input | Source and use |
| --- | --- |
| `OAUTH_RELEASE_SHA` | HezLead supplies the exact reviewed merge SHA landed on main; archive verifies ancestry. Supply it to all box blocks; must differ from `EXPECTED_OAUTH_SHA`. |
| `EXPECTED_OAUTH_SHA`, `EXPECTED_OAUTH_IMAGE_DIGEST` | HezLead's latest measured live ON or OFF report: SHA is 40 lowercase hex; image is sha256: plus 64 lowercase hex. Supply to preflight/open; open saves them with the measured release/Compose path in the new window state. |
| `EXPECTED_EDGE_SHA` | HezLead supplies the full measured edge SHA, 40 lowercase hex. Export with the baseline inputs; preflight/open require the running Compose labels and canonical current target to match. A stale input stops the window. |
| `OAUTH_ARCHIVE_SHA256` | Exact `shasum -a 256` result from `hm37-oauth-archive`; HezLead supplies it to open. |
| `BOX_ARCHIVE_PATH` | Exact printed path from `hm37-oauth-archive`; HezLead supplies it to open. |
| `TOM_ENABLE_APPROVAL` | HezLead's named prompt authorization `2026-09-29`; required for (f), never inferred from this document. |
| `MCP_EXPECTED_MODE` | `off` at (d)/recovery; `on` after successful (f). Supply to each marked route-probe invocation. |
| `ARCHIVE_DIR` | Original Mac archive block's retained variable/directory; keep it for Mac close. |

Open creates the new release/proof paths and secret stage; later box blocks
load these and the captured baseline identities from the new state file.
Never supply guessed rollback paths or reuse the baseline proof directory.

Supply the three nonsecret identities from HezLead's latest measured report
in the retained box shell. This block validates and exports them without defaults.


## Shared preflight and closure decision

Run `oauth-release-shared-preflight` **first**, before every existing run-order entry.
Start in the reviewed repository with `OAUTH_PLAN_FILE` set to this absolute plan
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
# step: oauth-release-shared-preflight
# readonly: yes
# host: Mac /bin/bash 3.2; FIRST, before archive, box contact or window
set -euo pipefail
: "${RELEASE_INPUTS_JSON:?absolute nonsecret INPUTS JSON required}"
RELEASE_PREFLIGHT_TOOL="$(pwd -P)/scripts/release-preflight.py"
export RELEASE_PREFLIGHT_TOOL
python3 "$RELEASE_PREFLIGHT_TOOL" "${OAUTH_PLAN_FILE:?absolute reviewed plan required}" "$RELEASE_INPUTS_JSON" "$(pwd -P)"
# Export exactly the validated nonsecret fields; shlex.quote prevents shell code.
eval "$(python3 -c 'import json,re,shlex,sys; p=json.load(open(sys.argv[1])); c=json.loads(re.search(r"^```release-contract\n(.*?)^```$",open(sys.argv[2]).read(),re.M|re.S)[1]); print("\n".join("export "+k+"="+shlex.quote(p[k]) for k in c["inputs"]))' "$RELEASE_INPUTS_JSON" "$OAUTH_PLAN_FILE")"
```

```sh
# step: hm37-oauth-plan-inputs
set -euo pipefail
: "${EXPECTED_OAUTH_SHA:?FAIL: measured OAuth baseline SHA missing}"
: "${EXPECTED_OAUTH_IMAGE_DIGEST:?FAIL: measured OAuth baseline image missing}"
: "${EXPECTED_EDGE_SHA:?FAIL: measured edge SHA missing}"
oauth_expected_baselines() {
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
oauth_expected_baselines validate
export EXPECTED_OAUTH_SHA EXPECTED_OAUTH_IMAGE_DIGEST EXPECTED_EDGE_SHA
```

## (0) Measure the MCP baseline before opening a window

Run this block first in the same root Bash shell as preflight/open. It defines
the shared read-only checker and route probe; preflight/open repeat both before
any write. MODE is recorded in the shell and printed without credentials;
open persists it in the new proof directory. Mixed flags, file/mount/Compose
drift, a mismatched Caddy site or failed public probes refuse the window.

```sh
# step: hm37-mcp-baseline-state
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
require((site.count('import mcp_resource_active')==1 and '@mcp_unavailable' not in site) if mode=='on' else ('import mcp_resource_active' not in site and site.count('@mcp_unavailable path')==1 and site.count('handle @mcp_unavailable')==1),14,'baseline Caddy resource activation agrees with MODE')
print(mode)
PY
}
mcp_route_probes() {
python3 - "$MCP_EXPECTED_MODE" <<'PY' || return 1
import json, re, sys, urllib.error, urllib.request
enabled=sys.argv[1]=='on'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
for base in ['http://127.0.0.1:3490','https://mcp.commonswarm.com']:
    for ua in ['Python-urllib/3.12','curl/8.7.1']:
        paths=[('/health','GET',200),('/.well-known/openid-configuration','GET',200),
            ('/.well-known/oauth-authorization-server','GET',200),('/jwks','GET',200),
            ('/authorize','GET',400 if enabled else 503),('/token','POST',None if enabled else 503)]
        if base.startswith('https:'):
            paths += [('/mcp','POST',401 if enabled else 503),
                ('/.well-known/oauth-protected-resource/mcp','GET',200 if enabled else 503)]
        for path,method,expected in paths:
            req=urllib.request.Request(base+path, data=b'' if method=='POST' else None, method=method,
                headers={'User-Agent':ua,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'})
            try: response=opener.open(req, timeout=15)
            except urllib.error.HTTPError as error: response=error
            with response:
                body=response.read(131073); code=response.code
                content_type=response.headers.get('Content-Type','')
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
BASELINE_MCP_MODE=$(hm37_baseline_mode) || exit 1
MCP_EXPECTED_MODE=$BASELINE_MCP_MODE
mcp_route_probes || { echo 'FAIL hm37-mcp-baseline-state REQ 15: baseline route probes disagree with MODE; STOP' >&2; exit 1; }
printf 'MODE=%s baseline consistency and public probes PASS (read-only)\n' "$BASELINE_MCP_MODE"
```

## (a) Archive and read-only preflight

Mac input: reviewed landed `OAUTH_RELEASE_SHA`. Box preflight/open inputs:
`EXPECTED_OAUTH_SHA`, `EXPECTED_OAUTH_IMAGE_DIGEST` and `EXPECTED_EDGE_SHA` from HezLead's measured live
ON or OFF report. Run from a clean checkout.
The public archive is copied as a mode-0600 file to the box's `/tmp` (1777),
using a fresh suffix chosen by Mac `mktemp`. HezLead supplies its printed
`OAUTH_ARCHIVE_SHA256` and `BOX_ARCHIVE_PATH` to the box shell. Mac staging
remains under `/private/tmp`; the box's `/private` is root-only (0700).

```sh
# step: hm37-oauth-archive
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-archive line $LINENO" >&2' ERR
: "${OAUTH_RELEASE_SHA:?FAIL: HezLead must supply the landed SHA}"
case "$OAUTH_RELEASE_SHA" in ''|*[!0-9a-f]*) echo 'FAIL: SHA format' >&2; exit 1;; esac
test "${#OAUTH_RELEASE_SHA}" -eq 40 || exit 1
test -z "$(git status --porcelain)" || { echo 'FAIL: dirty checkout' >&2; exit 1; }
git merge-base --is-ancestor "$OAUTH_RELEASE_SHA" origin/main || exit 1
ARCHIVE_DIR=$(mktemp -d /private/tmp/hm37-oauth-archive.XXXXXX) || exit 1
git archive --format=tar "$OAUTH_RELEASE_SHA" >"$ARCHIVE_DIR/release.tar" || exit 1
chmod 0600 "$ARCHIVE_DIR/release.tar" || exit 1
BOX_ARCHIVE_PATH=/tmp/hm37-oauth-${OAUTH_RELEASE_SHA}-${ARCHIVE_DIR##*.}.tar
shasum -a 256 "$ARCHIVE_DIR/release.tar" || exit 1
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 \
  "test \"\$(stat -c '%a' /tmp)\" = 1777 && (set -C; umask 077; : > '$BOX_ARCHIVE_PATH')" || exit 1
scp -p "$ARCHIVE_DIR/release.tar" "ops@100.115.66.74:$BOX_ARCHIVE_PATH" || exit 1
printf 'BOX_ARCHIVE_PATH=%s\n' "$BOX_ARCHIVE_PATH"
printf 'Retain public archive until box reconciliation: %s\n' "$ARCHIVE_DIR"
```

Preflight reads values only inside the process; it prints env **names** and
safe identities. It creates no secret backups and changes no service. If
any baseline differs, report the conflict and stop before opening the window.
The sites import is resolved against `/etc/caddy`: both `sites/*.caddy`
and `/etc/caddy/sites/*.caddy` match. Box `/tmp` is 1777 and ops can write
there; retained proofs are root-only 0700, reached only by the root block.
Snapshot, switch-on and rollback use
the same check; no step rewrites `/etc/caddy/Caddyfile`.

```sh
# step: hm37-oauth-preflight
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-preflight line $LINENO" >&2' ERR
: "${BASELINE_MCP_MODE:?FAIL: run hm37-mcp-baseline-state first in this shell}"
oauth_expected_baselines check
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
python3 - "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "$MODE" "${EXPECTED_EDGE_SHA:-}" <<'PY'
import json, pathlib, posixpath, re, shlex, subprocess, sys
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-oauth-preflight REQ {number}: {description}; STOP")
baseline_sha,baseline_image,mode,edge_sha=sys.argv[1:]
require(re.fullmatch(r"[0-9a-f]{40}",baseline_sha),1,"EXPECTED_OAUTH_SHA must be 40 lowercase hex")
require(re.fullmatch(r"sha256:[0-9a-f]{64}",baseline_image),2,"EXPECTED_OAUTH_IMAGE_DIGEST must be an immutable image ID")
require(re.fullmatch(r"[0-9a-f]{40}",edge_sha),10,"EXPECTED_EDGE_SHA must be 40 lowercase hex")
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
        current=root/'current'
        require(current.is_symlink() and current.exists(),11,'edge current must be a live symlink')
        release=current.resolve(strict=True)
        require(release==root/'releases'/sha and (release/'RELEASE_SHA').read_text().strip()==sha,12,'edge current and RELEASE_SHA equal EXPECTED_EDGE_SHA')
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

## Open window and retain rollback inputs

Additional prompt inputs: `EXPECTED_OAUTH_SHA`, `EXPECTED_OAUTH_IMAGE_DIGEST`, `EXPECTED_EDGE_SHA`,
`OAUTH_ARCHIVE_SHA256` and `BOX_ARCHIVE_PATH`. Open remeasures the baseline
before any write. Only the new `OAUTH_RELEASE_SHA` release/proof directories
are checked for collision; the baseline proof directory is preserved.
HezLead measured `command -v rm` as `/usr/bin/rm` for root and ops;
no `/usr/local/bin/rm` or `/usr/local/sbin/rm` exists. The box has no rm
wrapper. Preflight, open and each removal recheck root's binary and the
absence of local wrappers, stopping with `FAIL: box-rm-preflight` on drift.
All box removals run as root with absolute `/usr/bin/rm`; no step runs rm
as ops. Each checks its exact literal or mktemp-created path, rejects
symlinks, `/` and home directories, and stops on failed cleanup.
Secret backups stay in a fresh mode-0700 `/private/tmp/anvil-secret.*`.
The Mac archive cleanup retains the installed Mac guard unchanged. Retain
old release/image and original files; report failed cleanup paths and errors.

```sh
# step: hm37-oauth-open
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-open line $LINENO" >&2' ERR
: "${BASELINE_MCP_MODE:?FAIL: run hm37-mcp-baseline-state first in this shell}"
oauth_expected_baselines check
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
python3 - "${EXPECTED_OAUTH_SHA:-}" "${EXPECTED_OAUTH_IMAGE_DIGEST:-}" "$OAUTH_RELEASE_SHA" "$MODE" "${EXPECTED_EDGE_SHA:-}" <<'PY'
import json, pathlib, re, shlex, subprocess, sys
def require(ok, number, description):
    if not ok: raise SystemExit(f"FAIL hm37-oauth-open REQ {number}: {description}; STOP")
sha,image,new_sha,mode,edge_sha=sys.argv[1:]
require(re.fullmatch(r'[0-9a-f]{40}',sha),1,'EXPECTED_OAUTH_SHA must be 40 lowercase hex')
require(re.fullmatch(r'sha256:[0-9a-f]{64}',image),2,'EXPECTED_OAUTH_IMAGE_DIGEST must be an immutable image ID')
require(new_sha!=sha,3,'OAUTH_RELEASE_SHA must differ from EXPECTED_OAUTH_SHA; preserve baseline proofs')
require(re.fullmatch(r'[0-9a-f]{40}',edge_sha),12,'EXPECTED_EDGE_SHA must be 40 lowercase hex')
edge=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],text=True))[0]
edge_labels=edge['Config']['Labels']
edge_current=pathlib.Path('/home/commonswarm/edge/current')
edge_release=pathlib.Path('/home/commonswarm/edge/releases')/edge_sha
require(edge_current.is_symlink() and edge_current.exists() and edge_current.resolve(strict=True)==edge_release
    and (edge_release/'RELEASE_SHA').read_text().strip()==edge_sha,13,'edge current and RELEASE_SHA equal EXPECTED_EDGE_SHA')
edge_work=edge_release/'deploy/edge-runtime'
require(edge_labels.get('com.docker.compose.project')=='commonswarm-edge' and edge_labels.get('com.docker.compose.service')=='edge-runtime'
    and edge_labels.get('com.docker.compose.project.working_dir')==str(edge_work)
    and edge_labels.get('com.docker.compose.project.config_files')==str(edge_work/'compose.yaml')+','+str(edge_work/'compose.override.yaml'),14,'running edge Compose labels equal EXPECTED_EDGE_SHA')
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
test "$EDGE_DIR" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA" || { echo 'FAIL hm37-oauth-open: edge current changed during snapshot; STOP' >&2; exit 1; }
STATE=$PROOF_DIR/hm37-window.sh
umask 077
printf 'OAUTH_RELEASE_DIR=%q\nPROOF_DIR=%q\nSECRET_STAGE=%q\nBASELINE_MCP_MODE=%q\nEXPECTED_OAUTH_SHA=%q\nEXPECTED_OAUTH_IMAGE_DIGEST=%q\nBASELINE_OAUTH_DIR=%q\nBASELINE_OAUTH_COMPOSE=%q\nEDGE_DIR=%q\n' \
  "$OAUTH_RELEASE_DIR" "$PROOF_DIR" "$SECRET_STAGE" "$BASELINE_MCP_MODE" "$EXPECTED_OAUTH_SHA" "$EXPECTED_OAUTH_IMAGE_DIGEST" \
  "$BASELINE_OAUTH_DIR" "$BASELINE_OAUTH_COMPOSE" "$EDGE_DIR" >"$STATE"
cat >>"$STATE" <<'SH'
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
  install -o root -g root -m 0644 "$SECRET_STAGE/mcp.off.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || return 1
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || return 1
  systemctl reload caddy || return 1
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
  install -o root -g root -m 0644 "$SECRET_STAGE/mcp.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || return 1
  cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || return 1
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || return 1
  systemctl reload caddy || return 1
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
    outage_receipt || { echo "CLOSE_FAILED hm37-oauth-rollback: LIVE_STATE=ON SOURCE=$EXPECTED_OAUTH_SHA IMAGE=$EXPECTED_OAUTH_IMAGE_DIGEST; receipt failed; retain stage; do not roll back" >&2; return 1; }
    echo 'Baseline image and exact ON snapshots restored; ON probes PASS; stop forward release work'
  else
    echo 'Baseline image restored; end state OFF; OFF probes PASS; stop forward release work'
  fi
}
outage_receipt() {
  test -f "$PROOF_DIR/mcp-503-start.epoch" || return 0
  test ! -e "$PROOF_DIR/mcp-503-receipt.txt" || return 0
  date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/mcp-503-end.utc" || return 1
  date -u +%s >"$PROOF_DIR/mcp-503-end.epoch" || return 1
  python3 - "$PROOF_DIR" <<'PY' || return 1
import pathlib, sys
proof=pathlib.Path(sys.argv[1]); start=int((proof/'mcp-503-start.epoch').read_text()); end=int((proof/'mcp-503-end.epoch').read_text())
assert end>=start, 'UTC clock moved backwards'
receipt='503 window start='+ (proof/'mcp-503-start.utc').read_text().strip()+' end='+ (proof/'mcp-503-end.utc').read_text().strip()+' duration_seconds='+str(end-start)+'\n'
(proof/'mcp-503-receipt.txt').write_text(receipt)
print(receipt,end='')
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
declare -f hm37_baseline_mode mcp_route_probes >>"$STATE"
. "$STATE"
prepare_off_inputs "$EXPECTED_OAUTH_IMAGE_DIGEST" || { echo 'FAIL hm37-oauth-open REQ 24: OFF inputs could not be prepared; baseline unchanged; STOP' >&2; exit 1; }
cp "$SECRET_STAGE/compose.env" "$SECRET_STAGE/compose.baseline.off.env" || exit 1
caddy_sites_import || exit 1
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || { echo 'FAIL: Caddy snapshot changed; stop and report' >&2; exit 1; }
printf 'Window state (paths and code only): %s\n' "$STATE"
```

## (a1) ON baseline: transition OFF immediately after open

For an OFF baseline this is a no-op. For ON, it uses only the fresh stage:
the OFF service/edge/Caddy inputs and baseline Compose image prepared by open.
The original ON files, including management credentials, remain byte-exact in
that stage. Start is recorded before the first mutation; end follows successful
ON probes and memory gate. This conservatively includes container work/probes.

```sh
# step: hm37-mcp-transition-off
set -euo pipefail
trap 'echo "FAIL hm37-mcp-transition-off REQ 99: unexpected transition failure; run hm37-oauth-rollback; STOP" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
if test "$BASELINE_MCP_MODE" = on; then
  test ! -e "$PROOF_DIR/mcp-503-start.epoch" || { echo 'FAIL hm37-mcp-transition-off REQ 1: transition already attempted; STOP' >&2; exit 1; }
  date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/mcp-503-start.utc"
  date -u +%s >"$PROOF_DIR/mcp-503-start.epoch"
  if ! baseline_rollback_off; then
    recover_baseline || exit 1
    echo 'FAIL hm37-mcp-transition-off REQ 2: transition failed; baseline ON restored; STOP' >&2
    exit 1
  fi
fi
```

Run `hm37-mcp-route-probes` with `MCP_EXPECTED_MODE=off` next, then (b)-(d).
Any failure after the transition requires (e); do not close a failed ON-baseline
window while the new image is merely OFF. Recovery restores the baseline ON,
or reports a verified baseline OFF if ON restoration fails.

## (b) Build the exact-SHA image on the box

These are RUNBOOK's exact pull/build commands. The context changed to the
repository root to include the shared command source. `git archive` includes
only tracked files at the reviewed SHA, so untracked credentials, `.env` files,
node_modules and local scratch are absent. This is the context boundary; no
root `.dockerignore` is required for this archive-only build. The Dockerfile
copies package manifests, the five required `src` contract files, command and
shared function directories, the build adapter, and the OAuth runtime source.
It never uses `COPY .`; no secret files are copied into the image. There is
no app registry tag or Mac image build.

```sh
# step: hm37-oauth-build
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-build line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
BASE_REFERENCES=$PROOF_DIR/oauth-base-references.txt
python3 - "$OAUTH_RELEASE_DIR/services/mcp-auth/Dockerfile" >"$BASE_REFERENCES" <<'PY'
import pathlib,re,sys
references=[]
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('FROM '):
        reference=line.split()[1]
        assert re.fullmatch(r'node:[0-9A-Za-z.+-]+@sha256:[0-9a-f]{64}',reference), 'FAIL: reviewed Dockerfile base must be immutable; STOP'
        references.append(reference)
assert references, 'FAIL: no reviewed Dockerfile bases; STOP'
print('\n'.join(sorted(set(references))))
PY
IMAGE_TAG=commonswarm-oauth:release-$OAUTH_RELEASE_SHA
CACHED_IMAGE=$(docker image ls --no-trunc --quiet --filter "reference=$IMAGE_TAG") || { echo 'FAIL: image lookup' >&2; exit 1; }
if [ -n "$CACHED_IMAGE" ]; then
  IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG") || exit 1
  test "$IMAGE" = "$CACHED_IMAGE" || { echo 'FAIL: image lookup changed' >&2; exit 1; }
  printf '%s\n' "$IMAGE" >"$PROOF_DIR/oauth-image.id"
else
  test "$(docker info --format '{{.CPUCfsPeriod}} {{.CPUCfsQuota}}')" = 'true true' || { echo 'FAIL: Docker CPU quota unavailable' >&2; exit 1; }
  while IFS= read -r BASE_REFERENCE; do
    docker pull "$BASE_REFERENCE" || { echo 'FAIL: pinned base pull' >&2; exit 1; }
  done <"$BASE_REFERENCES"
  DOCKER_BUILDKIT=0 nice -n 15 docker build --pull=false \
    --cpu-period=100000 --cpu-quota=300000 \
    --tag "$IMAGE_TAG" --label "org.opencontainers.image.revision=$OAUTH_RELEASE_SHA" \
    --iidfile "$PROOF_DIR/oauth-image.id" \
    --file "$OAUTH_RELEASE_DIR/services/mcp-auth/Dockerfile" \
    "$OAUTH_RELEASE_DIR" || { echo 'FAIL: capped OAuth image build' >&2; exit 1; }
fi
IMAGE=$(cat "$PROOF_DIR/oauth-image.id") || exit 1
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$OAUTH_RELEASE_SHA" || { echo 'FAIL: image source SHA mismatch' >&2; exit 1; }
case "$IMAGE" in sha256:*) ;; *) echo 'FAIL: image must be immutable' >&2; exit 1;; esac
test "${#IMAGE}" -eq 71 || exit 1
docker image inspect "$EXPECTED_OAUTH_IMAGE_DIGEST" >/dev/null || exit 1
docker run --rm --network none --entrypoint node "$IMAGE" --input-type=module -e \
  'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.dependencies["oidc-provider"]!=="9.12.2" || !fs.existsSync("src/management-command.generated.js")) process.exit(1)' || exit 1
```

## (c) Stage only OFF env files

No secret appears in argv, environment, output, evidence or the source tree.
Read the existing edge file with Python, never `source` it. Reject ambiguous
env syntax/duplicate names. No new management credential is produced or installed in (c)/(d).
For an ON baseline, open already retained its original credential in the fresh stage.
The least-privilege OAuth artifact credential remains unchanged.
For an OFF baseline, service/edge OFF files are exact byte copies, preserving
absent flags and line endings. For ON, open creates separate OFF copies with
both flags 0 and a dark Caddy site; original ON bytes are preserved for (e).
The shared preparer selects the new image for (c). Enable edits separate ON
copies; disable restores the OFF inputs and compares their bytes. Compose
stays on the new OFF image until (e) selects the original baseline image.

```sh
# step: hm37-oauth-inputs
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-inputs line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
IMAGE=$(cat "$PROOF_DIR/oauth-image.id") || exit 1
prepare_off_inputs "$IMAGE" || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/compose.off.env" /etc/commonswarm-oauth/compose.env || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/service.off.env" /etc/commonswarm-oauth/service.env || exit 1
```

## (d) Recreate with flags OFF using base Compose only

```sh
# step: hm37-oauth-release-off
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-release-off line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
oauth_compose config --quiet || exit 1
oauth_compose up -d --no-deps --force-recreate --pull never oauth || exit 1
healthy commonswarm-oauth-oauth-1 || exit 1
test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$(cat "$PROOF_DIR/oauth-image.id")" || exit 1
docker exec commonswarm-oauth-oauth-1 node --input-type=module -e '
import fs from "node:fs";
import {loadConfig} from "./src/config.js";
import {createProductionManagementBindings} from "./src/management-bindings.js";
if(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1" ||
   process.env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE ||
   fs.existsSync("/run/commonswarm-oauth/management-database-credentials")) process.exit(1);
const bindings=await createProductionManagementBindings(await loadConfig());
if(Object.keys(bindings).length!==0) process.exit(1);
console.log("OFF startup without management inputs: PASS");
' || exit 1
test ! -e /etc/commonswarm-oauth/management-database-credentials && test ! -L /etc/commonswarm-oauth/management-database-credentials || exit 1
docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c \
  'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" != 1' || exit 1
test -L /home/commonswarm/oauth/current || exit 1
ln -sfn "$OAUTH_RELEASE_DIR" /home/commonswarm/oauth/current || exit 1
```

Use the same probe in OFF, ON and rollback states. Every request has a bounded
timeout, no credentials, no redirect following and a non-browser UA. No body
is printed; a 502, HTML challenge, 1010 or unexpected status fails. Enabled
authorization is deliberately an invalid request (400) with `text/html` from
oidc-provider's default error renderer; its bounded body must have no stack trace
markers. All other routes require JSON (JWKS also accepts `application/jwk-set+json`).
MCP is a proper POST without a bearer (401); GET `/mcp` would only test method refusal.

```sh
# step: hm37-mcp-route-probes
set -euo pipefail
trap 'echo "FAIL: hm37-mcp-route-probes line $LINENO" >&2' ERR
: "${MCP_EXPECTED_MODE:?FAIL: supply off or on for this marked probe}"
case "$MCP_EXPECTED_MODE" in off|on) ;; *) echo 'FAIL: probe mode' >&2; exit 1;; esac
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
if test "$MCP_EXPECTED_MODE" = on; then
  if ! mcp_route_probes || ! oauth_memory_gate; then
    echo 'FAIL: ON probes/memory; rolling back to OFF' >&2
    rollback_to_off || { echo 'FAIL: rollback-to-OFF; stop and report' >&2; exit 1; }
    exit 1
  fi
  outage_receipt || { echo "CLOSE_FAILED hm37-mcp-route-probes: LIVE_STATE=ON SOURCE=$OAUTH_RELEASE_SHA IMAGE=$(cat "$PROOF_DIR/oauth-image.id"); receipt failed; retain stage; do not roll back" >&2; exit 1; }
else
  mcp_route_probes || exit 1
fi
```

For step (d) supply `MCP_EXPECTED_MODE=off` and run the probe. Do not enable
either flag until the OFF startup check and all OFF probes pass. The read-only grant
preflight runs before writing the management credential in (f); binding and
workspace readiness are rechecked after the ON-only mount is installed.

## (e) ROLLBACK to the measured BASELINE_OAUTH_* and original env/Caddy

Run after any failure following the ON-to-OFF transition, including a failure
before enable. The shared recovery helper selects the measured baseline image
and base Compose, restores OFF inputs, removes management credentials with the
existing guarded helper, darkens Caddy, checks effective OFF consistency and
verifies OFF probes. For an ON baseline it then restores exact original
service/compose/edge/Caddy/management bytes with original management permissions,
selects the baseline management override, verifies the image and both healthy
services, and runs ON consistency/probes/memory. ON restore failure retries
baseline OFF recovery and verifies 503 before a named FAIL. An OFF baseline
ends OFF without invoking ON restoration. No prior window's stage is consulted.

```sh
# step: hm37-oauth-rollback
set -euo pipefail
trap 'echo "FAIL hm37-oauth-rollback REQ 99: unexpected recovery failure; STOP" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
recover_baseline || exit 1
```

The baseline release/base Compose path is captured from running labels. The
same Compose helpers are reused with that validated baseline release directory;
the image is explicitly `EXPECTED_OAUTH_IMAGE_DIGEST`. Original compose.env bytes are
restored, and current returns to `BASELINE_OAUTH_DIR`. Existing source/proofs
are preserved. No migration, stack, site, signing key or timer changes occur.

Standalone recovery retry uses the same helper and includes baseline OFF first:

```sh
# step: hm37-mcp-restore-on
set -euo pipefail
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$BASELINE_MCP_MODE" = on || { echo 'FAIL hm37-mcp-restore-on REQ 1: ON baseline required; STOP' >&2; exit 1; }
recover_baseline || exit 1
```

| Failure branch | Required recovery and end state |
| --- | --- |
| Baseline measurement/preflight failure | No service mutation; baseline untouched (mixed state is refused). STOP. |
| Open/snapshot preparation failure, before transition | Baseline service state untouched; retain any incomplete stage/proofs, report and STOP. Cleanup only via marked close when its state exists. |
| ON transition failure | Automatic baseline recovery: baseline ON with ON probes; if restoration fails, verified baseline OFF (REQ 92). STOP. |
| Build, inputs, OFF deploy or OFF probe failure after ON transition | Run (e): baseline image ON with ON probes; ON restoration failure ends verified baseline OFF (REQ 92). STOP. |
| Enable/readiness or ON probe/memory failure, ON baseline | Automatic new-image OFF is containment only; explicit disable/OFF probes, then mandatory (e) restores baseline ON. Restore failure ends baseline OFF/503 (REQ 92). STOP. |
| Release failure, OFF baseline | Run (e): baseline image OFF and OFF probes. STOP. |
| Enable or ON probe failure, OFF baseline | Disable/OFF probes: new image OFF; (e) restores baseline image OFF if release reversion is needed. STOP. |
| Baseline OFF recovery or OFF containment itself fails | REQ 90/91: end state UNVERIFIED; retain secret stage for recovery, report exact failure, STOP. Never claim OFF or close the window without verified probes. |
| Receipt or cleanup fails after verified ON/OFF | Service remains in the last verified state; retain remaining evidence/stage, report exact error, STOP. |

Failure recovery does not authorize forward retries. A verified OFF fallback
has no window end time: MCP remains unavailable, and HezLead must arrange
recovery before any new release. A successful release or baseline ON recovery
writes `mcp-503-receipt.txt` with UTC start/end and duration seconds. The interval
begins before transition and ends after ON checks; it bounds the 503 outage.
For an OFF baseline no new 503 interval is claimed.

## (f) MCP SWITCH-ON

The management producer uses the edge runtime's existing `SWARM_DATABASE_URL`,
read by a root Node program inside a transient instance of the exact OAuth
image on the box. Its only added capability is `DAC_READ_SEARCH`, needed
to read the service-owned mode-0600 edge env despite dropping all other
capabilities; the source env/CA binds are read-only, and only the protected
staging bind is writable. Base Compose's `extra_hosts` maps `db.commonswarm.internal`
to `172.31.0.10`; the OFF runtime's DNS and actual UID/GID must match first.
The producer accepts an absent query or exactly one parsed query pair,
`sslmode=verify-full`; duplicates, other names or other values fail closed.
It strips the query before connecting or writing the management URL, preserving
the existing login/password/database and replacing the host with that name.
The runtime still requires a query-free management URL. Non-5432 ports fail
closed. Both the producer and the bundled management client receive `ssl.ca`,
`ssl.servername=db.commonswarm.internal`, and `ssl.rejectUnauthorized=true`.
HezLead measured runtime UID:GID `996:986` in OAUTH-REPORT.md. Compose's
explicit `user` overrides Dockerfile `USER 10001:10001`; retain that existing
unprivileged identity and recheck `Config.User`/`process.getuid()`/`process.getgid()`.
Any drift stops. Install `0440 root:986`: root owns it, only root and the
runtime group can read it, and no user can write it via mode bits. The ON-only bind is read-only;
OFF has neither the env input nor mount. No management 1Password item exists.

Requires HezLead's named `TOM_ENABLE_APPROVAL=2026-09-29` prompt input and
all OFF readiness gates. The edge code at `deploy/edge-runtime/main/router.ts`
gates the MCP worker via `SWARM_MCP_PUBLIC_ENABLED`. Caddy's shipped site
still returns 503 directly, so the flags alone are insufficient: replace only
the measured dark resource block with its existing reviewed resource import.
Keep the OAuth loopback upstream, certificate, log filters and method bounds.

```sh
# step: hm37-mcp-enable
set -euo pipefail
test "${TOM_ENABLE_APPROVAL:-}" = 2026-09-29 || { echo 'FAIL: named HezLead switch-on approval missing' >&2; exit 1; }
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
caddy_sites_import || exit 1
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.off.env" || { echo 'FAIL: edge env changed since snapshot; stop and report' >&2; exit 1; }
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.off.caddy" || { echo 'FAIL: Caddy changed since snapshot; stop and report' >&2; exit 1; }
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
text=(stage/'mcp.off.caddy').read_text()
assert text.count('import mcp_oauth_active')==1 and 'import mcp_resource_active' not in text
pattern=r'\t\t@mcp_unavailable path /mcp /\.well-known/oauth-protected-resource/mcp\n\t\thandle @mcp_unavailable \{\n(?:[^\n]*\n)*?\t\t\}'
text,count=re.subn(pattern,'\t\timport mcp_resource_active',text)
assert count==1 and '@mcp_unavailable' not in text, 'live Caddy differs; stop'
(stage/'mcp.on.caddy').write_text(text); os.chmod(stage/'mcp.on.caddy',0o600)
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
  install -o root -g root -m 0644 "$SECRET_STAGE/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || return 1
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || return 1
  systemctl reload caddy || return 1
}
if ! switch_on; then
  echo 'FAIL: switch-on/readiness; rolling back to OFF' >&2
  rollback_to_off || { echo 'FAIL: rollback-to-OFF; stop and report' >&2; exit 1; }
  exit 1
fi
```

The command bundle allocates its postgres.js pool only on first database use,
with maximum two connections. The ON route-probe block measures OAuth memory via
`docker stats --no-stream` after enable, management readiness and ON probes,
compares it to `.HostConfig.Memory` from inspect, and automatically rolls back
to OFF on usage at or above 80% (or any failed ON probe/memory check).
The enable block independently rolls back on failed enable/readiness checks.
This is one release sample, not a sustained-load measurement.

```sh
# step: hm37-mcp-disable
set -euo pipefail
trap 'echo "FAIL: hm37-mcp-disable line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
rollback_to_off || exit 1
docker exec commonswarm-oauth-oauth-1 node -e 'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1" || process.env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE ? 1 : 0)' || exit 1
docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c 'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" != 1' || exit 1
```

Run the marked route probe with `MCP_EXPECTED_MODE=on`: health, both discovery
documents and JWKS 200; invalid authorization 400; token 400/401; public
`/mcp` POST 401 and protected-resource metadata 200 through Caddy/Cloudflare.
If any probe fails, run `hm37-mcp-disable` (base Compose, both flags OFF,
exact checked management-file removal), then the OFF probe; authorization, token,
MCP and protected-resource metadata must all return disabled 503 JSON again.
Disable restores OFF flags/inputs, recreates both services, and darkens Caddy.
Step (e) is mandatory after an ON-baseline release failure, restoring baseline ON
or the documented verified OFF fallback; OFF-baseline release reversion also uses (e).

## Close and remove secret staging

Run only after successful ON or verified baseline recovery route checks pass.
For ON-baseline failures, finish (e) before closing; automatic new-image OFF is
not the recovery end state. After REQ 92 (verified baseline OFF), close only after
reporting the OFF fallback; after REQ 90/91 retain the stage and STOP. On any
cleanup failure, retain the path, report the exact error, and stop cleanup.
No copyback of secret backups or raw docker inspect/env output.

```sh
# step: hm37-oauth-close
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      hm37-oauth-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_FAILURE_PHASE=DEPLOY_FAILED

trap 'echo "FAIL: hm37-oauth-close line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
RELEASE_LIVE_STATE="$(hm37_baseline_mode) source=$(readlink -f /home/commonswarm/oauth/current); preceding-route-check-verified"
RELEASE_FAILURE_PHASE=CLOSE_FAILED
box_rm_preflight || exit 1
python3 - "$SECRET_STAGE" <<'PY'
import pathlib, re, sys
path=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(path))
assert path not in (pathlib.Path('/'), pathlib.Path.home())
assert path.resolve(strict=True)==path and path.is_dir() and not path.is_symlink()
assert path.stat().st_mode & 0o777==0o700
PY
/usr/bin/rm -rf -- "$SECRET_STAGE" || { echo "FAIL: box secret cleanup failed $SECRET_STAGE; report exact error" >&2; exit 1; }
test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE" || exit 1
printf 'Secret staging removed. Retain SHA/image IDs and status-only probe evidence at %s\n' "$PROOF_DIR"
```

Mac public archive cleanup (only the directory created by the archive block):

```sh
# step: hm37-oauth-mac-close
set -euo pipefail
release_close_exit() {
  release_close_status=$?
  trap - EXIT
  if test "$release_close_status" -ne 0; then
    release_close_action=retain-verified-bytes
    if test "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" = DEPLOY_FAILED; then release_close_action=run-marked-recovery; fi
    printf '%s step=%s LIVE_STATE=%s SOURCE=%s BASELINE=%s IMAGE=%s LEFTOVERS=%s,%s,%s PID=%s ACTION=%s; retain evidence\n' \
      "${RELEASE_FAILURE_PHASE:-CLOSE_FAILED}" \
      hm37-oauth-mac-close "${RELEASE_LIVE_STATE:-unknown-use-last-verification-receipt}" \
      "${SITE_RELEASE_SHA:-${RELEASE_SHA:-${OAUTH_RELEASE_SHA:-unknown}}}" \
      "${EXPECTED_SITE_SHA:-${EXPECTED_EDGE_SHA:-${EXPECTED_OAUTH_SHA:-unknown}}}" \
      "${EXPECTED_OAUTH_IMAGE_DIGEST:-see-verified-image-receipt}" \
      "${SECRET_STAGE:-${SITE_BROWSER_ROOT:-none}}" "${ARCHIVE_DIR:-${DCR_ARCHIVE_DIR:-none}}" "${PROOF_DIR:-${SITE_EVIDENCE:-none}}" "${SITE_CHROME_PID:-none}" "$release_close_action" >&2
  fi
  exit "$release_close_status"
}
trap release_close_exit EXIT
RELEASE_LIVE_STATE="last-verified-ON; see retained verification receipt"

: "${ARCHIVE_DIR:?FAIL: original public archive directory missing}"
case "$ARCHIVE_DIR" in /private/tmp/hm37-oauth-archive.*) ;; *) echo 'FAIL: archive cleanup boundary' >&2; exit 1;; esac
test "$(cd "$ARCHIVE_DIR" && pwd -P)" = "$ARCHIVE_DIR" || exit 1
rm -rf "$ARCHIVE_DIR" || { echo "FAIL: guarded cleanup refused $ARCHIVE_DIR" >&2; exit 1; }
```

```release-contract
{
  "version": 1,
  "release_input": "OAUTH_RELEASE_SHA",
  "inputs": {"EXPECTED_EDGE_SHA": {"format": "sha40"}, "EXPECTED_OAUTH_IMAGE_DIGEST": {"format": "digest"}, "EXPECTED_OAUTH_SHA": {"format": "sha40"}, "OAUTH_PLAN_FILE": {"format": "abs-file"}, "OAUTH_RELEASE_SHA": {"format": "sha40"}, "TOM_ENABLE_APPROVAL": {"format": "literal:2026-09-29"}},
  "repo_paths": ["deploy/edge-runtime", "deploy/edge-runtime/compose.override.yaml", "deploy/edge-runtime/compose.yaml", "deploy/mcp-auth/compose.management.yaml", "deploy/mcp-auth/compose.yaml", "deploy/supabase-stack/commonswarm-mcp.caddy", "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md", "scripts/release-preflight.py", "services/mcp-auth/Dockerfile"],
  "runtime_paths": ["src/management-command.generated.js"],
  "input_files": ["$OAUTH_PLAN_FILE"],
  "routes": {"normal": ["oauth-release-shared-preflight", "hm37-oauth-plan-inputs", "hm37-mcp-baseline-state", "hm37-oauth-archive", "hm37-oauth-preflight", "hm37-oauth-open", "hm37-mcp-transition-off", "hm37-mcp-route-probes", "hm37-oauth-build", "hm37-oauth-inputs", "hm37-oauth-release-off", "hm37-mcp-route-probes", "hm37-mcp-enable", "hm37-mcp-route-probes", "hm37-oauth-close", "hm37-oauth-mac-close"], "off-baseline": ["oauth-release-shared-preflight", "hm37-oauth-plan-inputs", "hm37-mcp-baseline-state", "hm37-oauth-archive", "hm37-oauth-preflight", "hm37-oauth-open", "hm37-mcp-route-probes", "hm37-oauth-build", "hm37-oauth-inputs", "hm37-oauth-release-off", "hm37-mcp-route-probes", "hm37-mcp-enable", "hm37-mcp-route-probes", "hm37-oauth-close", "hm37-oauth-mac-close"], "recovery": ["oauth-release-shared-preflight", "hm37-oauth-plan-inputs", "hm37-mcp-baseline-state", "hm37-oauth-archive", "hm37-oauth-preflight", "hm37-oauth-open", "hm37-mcp-transition-off", "hm37-mcp-route-probes", "hm37-oauth-build", "hm37-oauth-inputs", "hm37-oauth-release-off", "hm37-mcp-route-probes", "hm37-mcp-enable", "hm37-mcp-route-probes", "hm37-oauth-rollback", "hm37-oauth-close", "hm37-oauth-mac-close"]},
  "steps": {
    "oauth-release-shared-preflight": {"reads": [], "sha256": "07764b1010a047acbf1736114007c4558d2c5fcc115e34fff4874f5bd5df6391"},
    "hm37-oauth-plan-inputs": {"reads": ["/home/commonswarm/edge/releases", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/releases", "/home/commonswarm/oauth/releases/", "command:docker inspect"], "sha256": "70d027ebb5ef8f0a72bd520c05fb677000f8cbbb5da1b7efde945ca6321a43c3"},
    "hm37-mcp-baseline-state": {"reads": ["/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "command:docker inspect", "endpoint:http://127.0.0.1:3490", "endpoint:https://mcp.commonswarm.com", "endpoint:https://mcp.commonswarm.com/mcp"], "sha256": "2259f7a6f9c5be7e550e57406322b3c8be56d6bf80f8a33805d7e029d7678b6d"},
    "hm37-oauth-archive": {"creates": ["$ARCHIVE_DIR", "$ARCHIVE_DIR/release.tar", "$BOX_ARCHIVE_PATH", "ARCHIVE_DIR", "BOX_ARCHIVE_PATH"], "reads": [], "sha256": "386c92f13c8cb795343d0731cf0e670f651e8ecda02a191f12e09425962486e9"},
    "hm37-oauth-preflight": {"reads": ["/etc/caddy", "/etc/caddy/Caddyfile", "/etc/caddy/sites/*.caddy", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/cookie-keys", "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env", "/etc/commonswarm-oauth/signing-keys.pem", "/etc/ssl/yulan-internal-ca.pem", "/home/commonswarm/.env", "command:docker inspect"], "sha256": "6108a06477ef441541ce80d4a27830cfd13598f6c2cb9099164fe2da0e3b5fd1"},
    "hm37-oauth-open": {"cleanup": ["BOX_ARCHIVE_PATH"], "cleanup_owners": {"$BOX_ARCHIVE_PATH": "hm37-oauth-archive", "/etc/commonswarm-oauth/management-database-credentials": "hm37-mcp-enable"}, "creates": ["$PROOF_DIR/baseline-mcp-mode", "$PROOF_DIR/hm37-window.sh", "$PROOF_DIR/release.tar", "$SECRET_STAGE", "$SECRET_STAGE/compose.baseline.off.env", "$SECRET_STAGE/compose.env", "$SECRET_STAGE/edge.env", "$SECRET_STAGE/edge.off.env", "$SECRET_STAGE/management.baseline", "$SECRET_STAGE/mcp.caddy", "$SECRET_STAGE/mcp.off.caddy", "$SECRET_STAGE/service.env", "SECRET_STAGE"], "reads": ["/etc/caddy", "/etc/caddy/Caddyfile", "/etc/caddy/sites/*.caddy", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/.env", "/home/commonswarm/edge/current", "/home/commonswarm/edge/releases", "/home/commonswarm/edge/releases/", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "/home/commonswarm/oauth/releases", "/home/commonswarm/oauth/releases/", "command:docker compose", "command:docker image inspect", "command:docker inspect", "command:docker stats", "command:readlink -f"], "sha256": "de31ef3fac17b3bf09bef13b0ccf023feb937c7ed839f7084a4fe7f9a10ee32c"},
    "hm37-mcp-transition-off": {"creates": ["$PROOF_DIR/mcp-503-start.epoch", "$PROOF_DIR/mcp-503-start.utc"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "01e4454c92e62f408991396aee4342bb8a93a7698c96665654bb6bdd258a320b"},
    "hm37-oauth-build": {"consumes": ["$PROOF_DIR/oauth-image.id"], "creates": ["$PROOF_DIR/oauth-base-references.txt", "$PROOF_DIR/oauth-image.id"], "reads": ["/home/commonswarm/oauth/release-proofs/", "command:docker image inspect"], "sha256": "96819761d3286f5f355afb527abf9f3b55d1d89569f47c61a4038b356a9f80f1"},
    "hm37-oauth-inputs": {"consumes": ["$PROOF_DIR/oauth-image.id"], "creates": ["$SECRET_STAGE/compose.off.env", "$SECRET_STAGE/service.off.env"], "reads": ["/etc/commonswarm-oauth/compose.env", "/etc/commonswarm-oauth/service.env", "/home/commonswarm/oauth/release-proofs/"], "sha256": "bd6c1a75477f20170dbeba6191a8d63a8897bc6ef1242c9868ed18d73cf70f70"},
    "hm37-oauth-release-off": {"consumes": ["$PROOF_DIR/oauth-image.id"], "reads": ["/etc/commonswarm-oauth/management-database-credentials", "/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect"], "sha256": "a6b9e18ce3481d3c667cb6dc0d293d75a8c1e103421dc6222ec54ea3c7150e08"},
    "hm37-mcp-route-probes": {"creates": ["$PROOF_DIR/mcp-503-end.epoch", "$PROOF_DIR/mcp-503-end.utc", "$PROOF_DIR/mcp-503-receipt.txt", "$PROOF_DIR/oauth-image.id", "$PROOF_DIR/oauth-memory-limit.bytes", "$PROOF_DIR/oauth-stats.json"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "75d3a60a70bb245804e2524cd118dbf6e643cd4f4526fc0ea76f55cbe768f24f"},
    "hm37-oauth-rollback": {"reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "2fb7a9c5332b1813f910321ee81b214cd0d87a8a707b21ac42a6e2213718e188"},
    "hm37-mcp-restore-on": {"reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "891eef231fca606faf6d8a0c7f9e55882c5a426707c77096ffd2870728b12b83"},
    "hm37-mcp-enable": {"consumes": ["$PROOF_DIR/oauth-image.id", "$SECRET_STAGE/edge.off.env", "$SECRET_STAGE/mcp.off.caddy", "$SECRET_STAGE/service.off.env"], "creates": ["$SECRET_STAGE/edge.on.env", "$SECRET_STAGE/management-database-credentials", "$SECRET_STAGE/mcp.on.caddy", "$SECRET_STAGE/service.on.env", "/etc/commonswarm-oauth/management-database-credentials", "management-database-credentials"], "reads": ["/etc/caddy/Caddyfile", "/etc/caddy/sites/20-commonswarm-mcp.caddy", "/etc/commonswarm-oauth/management-database-credentials", "/etc/commonswarm-oauth/service.env", "/etc/ssl/yulan-internal-ca.pem", "/home/commonswarm/.env", "/home/commonswarm/oauth/release-proofs/", "command:docker inspect"], "sha256": "d1ae90abb86f7b75c3c5ab9ac9b7ec49060dc03f60fe6f76326147af664eea45"},
    "hm37-mcp-disable": {"cleanup": ["management-database-credentials"], "reads": ["/home/commonswarm/oauth/release-proofs/"], "sha256": "7f638c50258483cf37a18f16d848780a1f505dd725ab6bab690fb85950025e1c"},
    "hm37-oauth-close": {"cleanup": ["SECRET_STAGE"], "cleanup_owners": {"$SECRET_STAGE": "hm37-oauth-open"}, "consumes": [], "reads": ["/home/commonswarm/oauth/current", "/home/commonswarm/oauth/release-proofs/", "command:readlink -f"], "sha256": "d543abcac8c13a683b545e4a4c5e8617e6f4517be104929297052da3b3cad474"},
    "hm37-oauth-mac-close": {"cleanup": ["ARCHIVE_DIR"], "cleanup_owners": {"$ARCHIVE_DIR": "hm37-oauth-archive"}, "reads": [], "sha256": "ae9464ad1b84cb9430c3a2d1ce7f101804874a5a6428e1afc7a948404103187e"}
  },
  "different": [["OAUTH_RELEASE_SHA", "EXPECTED_OAUTH_SHA"]],
  "plan_input": "OAUTH_PLAN_FILE"
}
```
