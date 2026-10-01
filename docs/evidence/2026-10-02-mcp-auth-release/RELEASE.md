# HM37 OAuth binding release and MCP switch-on

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

The allowed read-only command `ssh -o BatchMode=yes -o ConnectTimeout=10
ops@100.115.66.74 ...` failed with `Operation not permitted` at port 22 in
this worker's sandbox. **No live path, image, port, env file, container or
health was measured here.** The following are repository/handoff baselines,
which the preflight below must reconcile before any production mutation:

| Input | Repository / HezLead evidence |
| --- | --- |
| Old OAuth release | `826db6a34f235064a3a03c57377d8e32a35d2f05`, `/home/commonswarm/oauth/current` |
| Old immutable image (no registry tag) | `sha256:5511a358e0a7d7d52749d2b7b562d8343cf0daf79e2d389041cb9ca359a6dd5a`; HM6 `oauth-image.json` and `oauth-runtime.json` |
| OAuth project / service / container | `commonswarm-oauth` / `oauth` / `commonswarm-oauth-oauth-1` |
| OAuth inputs | `/etc/commonswarm-oauth/compose.env`, `/etc/commonswarm-oauth/service.env` |
| Port/network | HM6 recorded loopback `3490`; Compose allows `3490..3499`; `commonswarm-net` |
| Edge release | `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`, `/home/commonswarm/edge/current` |
| Edge project / service / container | `commonswarm-edge` / `edge-runtime` / `commonswarm-edge-edge-runtime-1` |
| Edge env/override | `/home/commonswarm/.env`; deployed `deploy/edge-runtime/compose.override.yaml` must be retained |
| Caddy | `/etc/caddy/Caddyfile`, `/etc/caddy/sites/20-commonswarm-mcp.caddy`; HM6 rendered OAuth ingress, resource routes dark |
| Existing protected files | `/etc/commonswarm-oauth/{signing-keys.pem,cookie-keys,database-credentials}`, `/etc/ssl/yulan-internal-ca.pem` |
| New protected file | `/etc/commonswarm-oauth/management-database-credentials`, JSON `databaseUrl` from the existing edge DB configuration |

Sources: `deploy/mcp-auth/{RUNBOOK.md,compose.yaml,env.example}`,
`deploy/edge-runtime/compose.yaml`, `deploy/supabase-stack/commonswarm-mcp.caddy`,
`docs/evidence/2026-09-28-release-826db6a34f23-v5/`, and the supplied
`~/work/hm37-live-release/B-FINAL-REPORT.md`. The latter reports B PASS and
both flags rolled back OFF; it is a handoff, not this worker's live measurement.

New input **name**: `MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE` (container
path `/run/commonswarm-oauth/management-database-credentials`). Its value
source is a protected on-box file, not an environment secret or management
bearer. `SWARM_DATABASE_URL` (fallback `SUPABASE_DB_URL`) already lives in
`/home/commonswarm/.env`. That login must set `swarm_command` and `swarm_read`;
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
nonsecret `OAUTH_RELEASE_SHA`; each reloads a root-owned state file holding
only paths, SHA/image identity, and helper code. On any FAIL stop forward
work, run rollback then cleanup before closing the window. Do not invent
commands during the window. No Actions, HOME changes, Mac Docker or browser.

## (a) Archive and read-only preflight

Mac input: reviewed landed `OAUTH_RELEASE_SHA`. Run from a clean checkout.
The public archive is copied to `/private/tmp` on the box; HezLead supplies
its printed `OAUTH_ARCHIVE_SHA256` to the box shell.

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
shasum -a 256 "$ARCHIVE_DIR/release.tar" || exit 1
scp "$ARCHIVE_DIR/release.tar" "ops@100.115.66.74:/private/tmp/hm37-oauth-${OAUTH_RELEASE_SHA}.tar" || exit 1
printf 'Retain public archive until box reconciliation: %s\n' "$ARCHIVE_DIR"
```

Preflight reads values only inside the process; it prints env **names** and
safe identities. It creates no secret backups and changes no service. If
any baseline differs, report the conflict and stop before opening the window.

```sh
# step: hm37-oauth-preflight
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-preflight line $LINENO" >&2' ERR
python3 - <<'PY'
import json, pathlib, subprocess
def inspect(name):
    return json.loads(subprocess.check_output(['docker','inspect',name], text=True))[0]
for name, project, service, sha in [
    ('commonswarm-oauth-oauth-1','commonswarm-oauth','oauth','826db6a34f235064a3a03c57377d8e32a35d2f05'),
    ('commonswarm-edge-edge-runtime-1','commonswarm-edge','edge-runtime','eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922')]:
    data=inspect(name); labels=data['Config']['Labels']; env=dict(x.split('=',1) for x in data['Config']['Env'])
    ids=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project='+project,
        '--filter','label=com.docker.compose.service='+service], text=True).split()
    assert ids==[data['Id'][:12]], 'container count/identity conflict'
    assert labels['com.docker.compose.project']==project and labels['com.docker.compose.service']==service
    root=pathlib.Path('/home/commonswarm/'+('oauth' if service=='oauth' else 'edge'))
    release=(root/'current').resolve(strict=True)
    assert release==root/'releases'/sha and (release/'RELEASE_SHA').read_text().strip()==sha
    assert data['State']['Health']['Status']=='healthy'
    assert 'commonswarm-net' in (data['NetworkSettings'].get('Networks') or {})
    flag='MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED' if service=='oauth' else 'SWARM_MCP_PUBLIC_ENABLED'
    assert env.get(flag)!='1', 'public flag already enabled'
    work=release/'deploy'/('mcp-auth' if service=='oauth' else 'edge-runtime')
    assert labels['com.docker.compose.project.working_dir']==str(work)
    files=str(work/'compose.yaml') + (','+str(work/'compose.override.yaml') if service=='edge-runtime' else '')
    assert labels['com.docker.compose.project.config_files']==files, 'compose files differ'
    if service=='oauth':
        assert data['Image']=='sha256:5511a358e0a7d7d52749d2b7b562d8343cf0daf79e2d389041cb9ca359a6dd5a'
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
assert 'import mcp_oauth_active' in site and '@mcp_unavailable' in site and '(mcp_resource_active)' in site
assert 'import mcp_resource_active' not in site and 'reverse_proxy 127.0.0.1:3490' in site
assert 'import /etc/caddy/sites/*.caddy' in pathlib.Path('/etc/caddy/Caddyfile').read_text()
print('preflight baseline reconciled; no production mutation')
PY
```

## Open window and retain rollback inputs

Additional prompt inputs: `OAUTH_ARCHIVE_SHA256` and `BOX_RM_GUARD` (the exact
installed guarded-rm path, verified by HezLead; not measured by this worker).
Secret backups stay in a fresh mode-0700 `/private/tmp/anvil-secret.*`.
If the guard refuses cleanup, leave the directory and report its exact path
and refusal. Never bypass it. Retain old release/image and original files.

```sh
# step: hm37-oauth-open
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-open line $LINENO" >&2' ERR
: "${OAUTH_RELEASE_SHA:?FAIL: reviewed landed SHA missing}"
: "${OAUTH_ARCHIVE_SHA256:?FAIL: Mac archive hash missing}"
: "${BOX_RM_GUARD:?FAIL: box rm guard not confirmed}"
case "$OAUTH_RELEASE_SHA" in ''|*[!0-9a-f]*) echo 'FAIL: SHA format' >&2; exit 1;; esac
test "${#OAUTH_RELEASE_SHA}" -eq 40 || exit 1
test "$(command -v rm)" = "$BOX_RM_GUARD" && test -x "$BOX_RM_GUARD" || exit 1
OAUTH_RELEASE_DIR=/home/commonswarm/oauth/releases/$OAUTH_RELEASE_SHA
PROOF_DIR=/home/commonswarm/oauth/release-proofs/$OAUTH_RELEASE_SHA
test ! -e "$OAUTH_RELEASE_DIR" && test ! -e "$PROOF_DIR" || { echo 'FAIL: window already exists; do not overwrite it' >&2; exit 1; }
test -f "/private/tmp/hm37-oauth-${OAUTH_RELEASE_SHA}.tar" || exit 1
ACTUAL=$(sha256sum "/private/tmp/hm37-oauth-${OAUTH_RELEASE_SHA}.tar") || exit 1
test "${ACTUAL%% *}" = "$OAUTH_ARCHIVE_SHA256" || exit 1
install -d -m 0755 "$OAUTH_RELEASE_DIR" || exit 1
tar -xf "/private/tmp/hm37-oauth-${OAUTH_RELEASE_SHA}.tar" -C "$OAUTH_RELEASE_DIR" || exit 1
printf '%s\n' "$OAUTH_RELEASE_SHA" >"$OAUTH_RELEASE_DIR/RELEASE_SHA"
install -d -m 0700 "$PROOF_DIR" || exit 1
install -d -m 1777 /private/tmp || exit 1
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX) || exit 1
chmod 0700 "$SECRET_STAGE" || exit 1
python3 - "$SECRET_STAGE" <<'PY'
import pathlib, re, sys
path=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]+',str(path))
assert path.resolve(strict=True)==path and path.is_dir() and not path.is_symlink()
assert path.stat().st_mode & 0o777==0o700
PY
cp /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" || exit 1
cp /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env" || exit 1
cp /home/commonswarm/.env "$SECRET_STAGE/edge.env" || exit 1
cp /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || exit 1
chmod 0600 "$SECRET_STAGE/"* || exit 1
OLD_OAUTH_DIR=$(readlink -f /home/commonswarm/oauth/current) || exit 1
EDGE_DIR=$(readlink -f /home/commonswarm/edge/current) || exit 1
OLD_IMAGE=$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1) || exit 1
STATE=$PROOF_DIR/hm37-window.sh
umask 077
printf 'OAUTH_RELEASE_DIR=%q\nPROOF_DIR=%q\nSECRET_STAGE=%q\nOLD_OAUTH_DIR=%q\nEDGE_DIR=%q\nOLD_IMAGE=%q\nBOX_RM_GUARD=%q\n' \
  "$OAUTH_RELEASE_DIR" "$PROOF_DIR" "$SECRET_STAGE" "$OLD_OAUTH_DIR" "$EDGE_DIR" "$OLD_IMAGE" "$BOX_RM_GUARD" >"$STATE"
cat >>"$STATE" <<'SH'
oauth_compose() {
  docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
    -f "$OAUTH_RELEASE_DIR/deploy/mcp-auth/compose.yaml" "$@"
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
SH
printf 'Window state (paths and code only): %s\n' "$STATE"
```

## (b) Build the exact-SHA image on the box

These are RUNBOOK's exact pull/build commands. The context changed to the
repository root to include the shared command source; no secrets are copied
into the immutable archive. There is no app registry tag or Mac image build.

```sh
# step: hm37-oauth-build
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-build line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
BASE_REFERENCE=node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
docker pull "$BASE_REFERENCE" || { echo 'FAIL: pinned base pull' >&2; exit 1; }
docker build --pull=false \
  --iidfile "$PROOF_DIR/oauth-image.id" \
  --file "$OAUTH_RELEASE_DIR/services/mcp-auth/Dockerfile" \
  "$OAUTH_RELEASE_DIR" || { echo 'FAIL: OAuth image build' >&2; exit 1; }
IMAGE=$(cat "$PROOF_DIR/oauth-image.id") || exit 1
case "$IMAGE" in sha256:*) ;; *) echo 'FAIL: image must be immutable' >&2; exit 1;; esac
test "${#IMAGE}" -eq 71 || exit 1
docker image inspect "$OLD_IMAGE" >/dev/null || exit 1
docker run --rm --network none --entrypoint node "$IMAGE" --input-type=module -e \
  'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.dependencies["oidc-provider"]!=="9.12.2" || !fs.existsSync("src/management-command.generated.js")) process.exit(1)' || exit 1
```

## (c) Stage the binding credential and OFF env files

No secret appears in argv, environment, output, evidence or the source tree.
Read the existing edge file with Python, never `source` it. Reject ambiguous
env syntax/duplicate names and connection options; report a mismatch to
HezLead instead of stripping options or provisioning another database role.
The least-privilege OAuth artifact credential remains unchanged.

```sh
# step: hm37-oauth-inputs
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-inputs line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
python3 - "$SECRET_STAGE" "$PROOF_DIR/oauth-image.id" <<'PY'
import json, os, pathlib, re, sys, urllib.parse
stage=pathlib.Path(sys.argv[1]); image=pathlib.Path(sys.argv[2]).read_text().strip()
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
assert edge.get('SWARM_MCP_PUBLIC_ENABLED')!='1' and service.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED')!='1'
url=edge.get('SWARM_DATABASE_URL') or edge.get('SUPABASE_DB_URL')
assert url, 'existing management DB configuration missing'
parsed=urllib.parse.urlsplit(url)
assert parsed.scheme in ('postgres','postgresql') and parsed.username and parsed.password
assert parsed.hostname==compose['MCP_OAUTH_DATABASE_HOST'] and not parsed.query and not parsed.fragment
assert service.get('SUPABASE_URL') and service.get('SUPABASE_ANON_KEY')
(stage/'management-database-credentials').write_text(json.dumps({'databaseUrl':url})+'\n')
os.chmod(stage/'management-database-credentials',0o600)
save(stage/'compose.off.env',stage/'compose.env',{'MCP_OAUTH_IMAGE':image,'MCP_OAUTH_ENV_FILE':'/etc/commonswarm-oauth/service.env'})
save(stage/'service.off.env',stage/'service.env',{'MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED':'0'})
save(stage/'edge.off.env',stage/'edge.env',{'SWARM_MCP_PUBLIC_ENABLED':'0'})
print('input names validated; secret values retained only in protected files')
PY
if test -e /etc/commonswarm-oauth/management-database-credentials; then
  test ! -L /etc/commonswarm-oauth/management-database-credentials || exit 1
  cp /etc/commonswarm-oauth/management-database-credentials "$SECRET_STAGE/prior-management" || exit 1
  chmod 0600 "$SECRET_STAGE/prior-management" || exit 1
fi
GROUP=$(stat -c '%G' /etc/commonswarm-oauth/database-credentials) || exit 1
install -o root -g "$GROUP" -m 0640 "$SECRET_STAGE/management-database-credentials" /etc/commonswarm-oauth/management-database-credentials || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/compose.off.env" /etc/commonswarm-oauth/compose.env || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/service.off.env" /etc/commonswarm-oauth/service.env || exit 1
```

## (d) Recreate with flags OFF; verify service and bindings

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
import {loadConfig} from "./src/config.js";
import {createProductionManagementBindings} from "./src/management-bindings.js";
if(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1") process.exit(1);
const config=await loadConfig({...process.env,MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED:"1"});
const bindings=await createProductionManagementBindings(config);
try {
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
' || exit 1
docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c \
  'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" != 1' || exit 1
test -L /home/commonswarm/oauth/current || exit 1
ln -sfn "$OAUTH_RELEASE_DIR" /home/commonswarm/oauth/current || exit 1
```

Use the same probe in OFF, ON and rollback states. Every request has a bounded
timeout, no credentials, no redirect following and a non-browser UA. No body
is printed; a 502, HTML challenge, 1010 or unexpected status fails. Enabled
authorization is deliberately an invalid request (400), and MCP is a proper
POST without a bearer (401); GET `/mcp` would only test method refusal.

```sh
# step: hm37-mcp-route-probes
set -euo pipefail
trap 'echo "FAIL: hm37-mcp-route-probes line $LINENO" >&2' ERR
: "${MCP_EXPECTED_MODE:?FAIL: supply off or on for this marked probe}"
case "$MCP_EXPECTED_MODE" in off|on) ;; *) echo 'FAIL: probe mode' >&2; exit 1;; esac
python3 - "$MCP_EXPECTED_MODE" <<'PY'
import json, sys, urllib.error, urllib.request
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
                assert len(body)<=131072 and 'application/json' in response.headers.get('Content-Type',''), 'non-JSON or oversized response'
                value=json.loads(body)
                assert code==expected if expected is not None else code in (400,401), 'unexpected status'
                if path=='/health': assert value.get('status')=='ok'
                if path.startswith('/.well-known/') and code==200:
                    if path.endswith('/mcp'):
                        assert value.get('resource')=='https://mcp.commonswarm.com/mcp'
                        assert 'https://mcp.commonswarm.com' in value.get('authorization_servers',[])
                    else: assert value.get('issuer')=='https://mcp.commonswarm.com'
                if path=='/jwks': assert value.get('keys') and all('d' not in key for key in value['keys'])
                if code==503: assert value.get('error') in ('authorization_service_disabled','feature_disabled')
                print(method,base+path,ua,code,'PASS')
PY
```

For step (d) supply `MCP_EXPECTED_MODE=off` and run the probe. Do not enable
either flag until both the binding readiness and all OFF probes pass.

## (e) ROLLBACK to 826db6a3 and original env/Caddy

This block applies after a failed release or switch-on. It restores **both**
original OFF env files, old image/Compose release and exact Caddy file, retains
the deployed edge override, recreates both containers, and verifies health.
Then run the marked route probe with `MCP_EXPECTED_MODE=off` before cleanup.

```sh
# step: hm37-oauth-rollback
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-rollback line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$OLD_OAUTH_DIR" = /home/commonswarm/oauth/releases/826db6a34f235064a3a03c57377d8e32a35d2f05 || exit 1
test "$OLD_IMAGE" = sha256:5511a358e0a7d7d52749d2b7b562d8343cf0daf79e2d389041cb9ca359a6dd5a || exit 1
docker image inspect "$OLD_IMAGE" >/dev/null || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/service.env" /etc/commonswarm-oauth/service.env || exit 1
install -o root -g root -m 0600 "$SECRET_STAGE/compose.env" /etc/commonswarm-oauth/compose.env || exit 1
cat "$SECRET_STAGE/edge.env" >/home/commonswarm/.env || exit 1
if test -f "$SECRET_STAGE/prior-management"; then
  GROUP=$(stat -c '%G' /etc/commonswarm-oauth/database-credentials) || exit 1
  install -o root -g "$GROUP" -m 0640 "$SECRET_STAGE/prior-management" /etc/commonswarm-oauth/management-database-credentials || exit 1
else
  chmod 0600 /etc/commonswarm-oauth/management-database-credentials || exit 1
fi
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || exit 1
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || exit 1
systemctl reload caddy || exit 1
OAUTH_RELEASE_DIR=$OLD_OAUTH_DIR
oauth_compose config --quiet || exit 1
oauth_compose up -d --no-deps --force-recreate --pull never oauth || exit 1
edge_compose up -d --no-deps --force-recreate --pull never edge-runtime || exit 1
healthy commonswarm-oauth-oauth-1 && healthy commonswarm-edge-edge-runtime-1 || exit 1
test "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)" = "$OLD_IMAGE" || exit 1
docker exec commonswarm-oauth-oauth-1 node -e 'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1" ? 1 : 0)' || exit 1
docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c 'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" != 1' || exit 1
test -L /home/commonswarm/oauth/current || exit 1
ln -sfn "$OLD_OAUTH_DIR" /home/commonswarm/oauth/current || exit 1
```

A newly created management credential is retained root-only on rollback
(matching HM6's retired-secret rule); the old image cannot consume it.
No migration, app/stack, site, signing key, artifact credential or timer change.

## (f) MCP SWITCH-ON

Requires HezLead's named `TOM_ENABLE_APPROVAL=2026-09-29` prompt input and
all OFF readiness gates. The edge code at `deploy/edge-runtime/main/router.ts`
gates the MCP worker via `SWARM_MCP_PUBLIC_ENABLED`. Caddy's shipped site
still returns 503 directly, so the flags alone are insufficient: replace only
the measured dark resource block with its existing reviewed resource import.
Keep the OAuth loopback upstream, certificate, log filters and method bounds.

```sh
# step: hm37-mcp-enable
set -euo pipefail
trap 'echo "FAIL: hm37-mcp-enable line $LINENO" >&2' ERR
test "${TOM_ENABLE_APPROVAL:-}" = 2026-09-29 || { echo 'FAIL: named HezLead switch-on approval missing' >&2; exit 1; }
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
python3 - "$SECRET_STAGE" <<'PY'
import os, pathlib, re, sys
stage=pathlib.Path(sys.argv[1])
for source,target,flag in [('service.off.env','service.on.env','MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED'),
    ('edge.off.env','edge.on.env','SWARM_MCP_PUBLIC_ENABLED')]:
    text=(stage/source).read_text()
    text,count=re.subn(r'^'+flag+r'=0$',flag+'=1',text,flags=re.M)
    assert count==1, 'flag inventory conflict'
    (stage/target).write_text(text); os.chmod(stage/target,0o600)
text=(stage/'mcp.caddy').read_text()
assert text.count('import mcp_oauth_active')==1 and 'import mcp_resource_active' not in text
pattern=r'\t\t@mcp_unavailable path /mcp /\.well-known/oauth-protected-resource/mcp\n\t\thandle @mcp_unavailable \{\n(?:[^\n]*\n)*?\t\t\}'
text,count=re.subn(pattern,'\t\timport mcp_resource_active',text)
assert count==1 and '@mcp_unavailable' not in text, 'live Caddy differs; stop'
(stage/'mcp.on.caddy').write_text(text); os.chmod(stage/'mcp.on.caddy',0o600)
PY
install -o root -g root -m 0600 "$SECRET_STAGE/service.on.env" /etc/commonswarm-oauth/service.env || exit 1
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env" || { echo 'FAIL: edge env changed since snapshot' >&2; exit 1; }
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy" || { echo 'FAIL: Caddy changed since snapshot' >&2; exit 1; }
cat "$SECRET_STAGE/edge.on.env" >/home/commonswarm/.env || exit 1
oauth_compose up -d --no-deps --force-recreate --pull never oauth || exit 1
edge_compose up -d --no-deps --force-recreate --pull never edge-runtime || exit 1
healthy commonswarm-oauth-oauth-1 && healthy commonswarm-edge-edge-runtime-1 || exit 1
docker exec commonswarm-oauth-oauth-1 node -e 'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED==="1" ? 0 : 1)' || exit 1
docker exec commonswarm-edge-edge-runtime-1 /bin/bash -c 'test "${SWARM_MCP_PUBLIC_ENABLED:-0}" = 1' || exit 1
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || exit 1
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || exit 1
systemctl reload caddy || exit 1
```

Run the marked route probe with `MCP_EXPECTED_MODE=on`: health, both discovery
documents and JWKS 200; invalid authorization 400; token 400/401; public
`/mcp` POST 401 and protected-resource metadata 200 through Caddy/Cloudflare.
If any probe fails, run step (e), then the OFF probe; authorization, token,
MCP and protected-resource metadata must all return disabled 503 JSON again.
The rollback restores both flags, recreates both services, and restores Caddy.

## Close and remove secret staging

Run only after the appropriate ON or rollback-OFF route checks pass. On any
cleanup refusal, retain the path, report the guard's exact message, and stop
cleanup. No copyback of secret backups or raw docker inspect/env output.

```sh
# step: hm37-oauth-close
set -euo pipefail
trap 'echo "FAIL: hm37-oauth-close line $LINENO" >&2' ERR
. "/home/commonswarm/oauth/release-proofs/${OAUTH_RELEASE_SHA:?}/hm37-window.sh"
test "$(command -v rm)" = "$BOX_RM_GUARD" || exit 1
python3 - "$SECRET_STAGE" <<'PY'
import pathlib, re, sys
path=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]+',str(path))
assert path.resolve(strict=True)==path and path.is_dir() and not path.is_symlink()
assert path.stat().st_mode & 0o777==0o700
PY
rm -rf "$SECRET_STAGE" || { echo "FAIL: guarded cleanup refused $SECRET_STAGE; report exact guard message" >&2; exit 1; }
test ! -e "$SECRET_STAGE" || exit 1
printf 'Secret staging removed. Retain SHA/image IDs and status-only probe evidence at %s\n' "$PROOF_DIR"
```

Mac public archive cleanup (only the directory created by the archive block):

```sh
# step: hm37-oauth-mac-close
set -euo pipefail
: "${ARCHIVE_DIR:?FAIL: original public archive directory missing}"
case "$ARCHIVE_DIR" in /private/tmp/hm37-oauth-archive.*) ;; *) echo 'FAIL: archive cleanup boundary' >&2; exit 1;; esac
test "$(cd "$ARCHIVE_DIR" && pwd -P)" = "$ARCHIVE_DIR" || exit 1
rm -rf "$ARCHIVE_DIR" || { echo "FAIL: guarded cleanup refused $ARCHIVE_DIR" >&2; exit 1; }
```
