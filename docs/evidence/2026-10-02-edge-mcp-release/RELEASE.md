# Edge-only release from the MCP ON baseline

**Option (b): prepared, not executed.** HezLead supplies the reviewed, landed
MCP-fix SHA and separately authorizes execution. This worker has made no live
measurements. The task handoff says edge `eb2a87ac`, OAuth `00e89738`,
app/stack `ad964ed1`, site `603a206e`, with MCP ON. Only the full edge identity
below is an executable pin; preflight captures the other running identities
and refuses drift throughout the window.

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
resolved environment is checked against the running container without output.

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
| `BASELINE_EDGE_SHA` | Exactly `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` | Task handoff; preflight checks current, RELEASE_SHA and container mounts. |
| `WINDOW_END_UTC` | `YYYY-MM-DDTHH:MM:SSZ`, future and at most 30 minutes away at preflight | HezLead's approved window end, checked on box clock. |
| `MAX_MCP_OUTAGE_SECONDS` | Positive decimal, 1..600 | HezLead's approved maximum; checked in the final 503 receipt, including rollback. Exceeding it is FAIL even if ON was restored. |
| `PLAN_FILE` | Absolute file containing this independently reviewed plan | Mac operator; transport extracts exactly one marked sh block. |
| `ARCHIVE_DIR`, `WINDOW_ID` | Fresh `/private/tmp/hm37-edge-archive.XXXXXX`; six alphanumerics | Archive step derives them; retain for Mac cleanup. |
| `BOX_ARCHIVE_PATH` | `/tmp/hm37-edge-<RELEASE_SHA>-<WINDOW_ID>.tar` | Archive step creates/uploads mode 0600 with no overwrite. |
| `EDGE_ARCHIVE_SHA256` | 64 lowercase hex | Archive step's SHA-256 output, passed to box preflight. |
| `BOX_STEP` | One box step ID in the order below | Operator chooses the exact block for transport; no prose-generated commands. |
| `SECRET_STAGE` for open-abort only | Exact `/private/tmp/anvil-secret.XXXXXX` path reported by failed open | Pass as input 8 through transport; a path is nonsecret. If open failed before creation, there is no secret cleanup step. |
| `PREVIOUS_EDGE`, `NEW_EDGE`, `PROOF_DIR`, `SECRET_STAGE` | Validated canonical paths | Box derives previous from current and full baseline SHA; new from RELEASE_SHA; proofs per SHA/window; secret stage from mktemp. Never guessed or taken from an old window. |
| Network / flags / override / timer | `commonswarm-net`; both public flags `1`; 2147483648 bytes; six-hour timer active | Measured by preflight; no flag input can turn MCP OFF. |

Normal order: `edge-mcp-archive`, `edge-mcp-preflight`, `edge-mcp-open`,
`edge-mcp-stage`, `edge-mcp-transition-503`, `edge-mcp-apply`,
`edge-mcp-restore-on`, `edge-mcp-probes`, `edge-mcp-close`,
`edge-mcp-mac-close`. Use `edge-mcp-transport` for each box block if needed.
The transport combines preflight/open and supplies positional inputs to each
fresh root invocation. There is no release execution in this documentation task.

Failures before transition: stop forward work, run `edge-mcp-rollback` if open
completed, then close only after baseline ON probes. Failures from transition
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

```sh
# step: edge-mcp-archive
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL edge-mcp-archive: line $LINENO; STOP" >&2' ERR
: "${RELEASE_SHA:?}" "${BASELINE_EDGE_SHA:?}" "${PLAN_FILE:?}"
case "$RELEASE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#RELEASE_SHA}" = 40
test "$BASELINE_EDGE_SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
test "$RELEASE_SHA" != "$BASELINE_EDGE_SHA"
test -z "$(git status --porcelain)"
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
: "${BOX_STEP:?}" "${PLAN_FILE:?}" "${RELEASE_SHA:?}" "${WINDOW_ID:?}"
case "$BOX_STEP" in
  edge-mcp-preflight-open|edge-mcp-stage|edge-mcp-transition-503|edge-mcp-apply|edge-mcp-restore-on|edge-mcp-probes|edge-mcp-rollback|edge-mcp-close|edge-mcp-timer-recover|edge-mcp-open-abort) ;;
  *) echo 'FAIL edge-mcp-transport: unknown box step; STOP' >&2; exit 1;;
esac
python3 - "$PLAN_FILE" "$BOX_STEP" >"$ARCHIVE_DIR/box-step.sh" <<'PY'
import pathlib,re,sys
blocks=re.findall(r'^```sh\n(.*?)^```$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
steps=['edge-mcp-preflight','edge-mcp-open'] if sys.argv[2]=='edge-mcp-preflight-open' else [sys.argv[2]]
for step in steps:
    found=[b for b in blocks if re.search(r'^# step: '+re.escape(step)+r'$',b,re.M)]
    assert len(found)==1, 'FAIL edge-mcp-transport: step missing or duplicated'
    print(found[0])
PY
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -s -- %q %q %q %q %q %q %q %q' \
  "$RELEASE_SHA" "$WINDOW_ID" "$BASELINE_EDGE_SHA" "$BOX_ARCHIVE_PATH" \
  "$EDGE_ARCHIVE_SHA256" "$WINDOW_END_UTC" "$MAX_MCP_OUTAGE_SECONDS" "${SECRET_STAGE:-}"
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
RELEASE_SHA=${1:?}; WINDOW_ID=${2:?}; BASELINE_EDGE_SHA=${3:?}
BOX_ARCHIVE_PATH=${4:?}; EDGE_ARCHIVE_SHA256=${5:?}
WINDOW_END_UTC=${6:?}; MAX_MCP_OUTAGE_SECONDS=${7:?}
test "$(id -u)" = 0
python3 - "$RELEASE_SHA" "$WINDOW_ID" "$BASELINE_EDGE_SHA" "$BOX_ARCHIVE_PATH" "$EDGE_ARCHIVE_SHA256" "$WINDOW_END_UTC" "$MAX_MCP_OUTAGE_SECONDS" <<'PY'
import datetime,pathlib,re,sys
s,w,b,a,h,end,budget=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and s!=b
assert b=='eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922'
assert re.fullmatch('[A-Za-z0-9]{6}',w) and a==f'/tmp/hm37-edge-{s}-{w}.tar'
assert re.fullmatch('[0-9a-f]{64}',h)
assert re.fullmatch('[1-9][0-9]*',budget) and int(budget)<=600
assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',end)
until=datetime.datetime.strptime(end,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(until-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=1800
p=pathlib.Path(a); assert p.is_file() and not p.is_symlink() and p.stat().st_mode & 0o777==0o600
PY
PREVIOUS_EDGE=/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA
NEW_EDGE=/home/commonswarm/edge/releases/$RELEASE_SHA
PROOF_DIR=/home/commonswarm/edge/release-proofs/$RELEASE_SHA-$WINDOW_ID
test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"
test "$(cat "$PREVIOUS_EDGE/RELEASE_SHA")" = "$BASELINE_EDGE_SHA"
test "$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$EDGE_ARCHIVE_SHA256"
test "$(command -v rm)" = /usr/bin/rm
test -x /usr/bin/rm && test ! -L /usr/bin/rm
systemctl is-active --quiet caddy
systemctl is-active --quiet commonswarm-edge-recycle.timer
test "$(systemctl show -p ActiveState --value commonswarm-edge-recycle.service)" = inactive
systemctl cat commonswarm-edge-recycle.timer | python3 -c 'import sys; s=sys.stdin.read(); assert "OnCalendar=*-*-* 03,09,15,21:30:00 UTC" in s and "Persistent=false" in s'
systemctl cat commonswarm-edge-recycle.service | python3 -c 'import sys; s=sys.stdin.read(); assert "docker restart --time 30 commonswarm-edge-edge-runtime-1" in s'
edge_compose() {
  COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge -f "$EDGE_DIR/deploy/edge-runtime/compose.yaml" \
    -f "$EDGE_DIR/deploy/edge-runtime/compose.override.yaml" "$@"
}
edge_config_check() {
python3 - "$EDGE_DIR" "$PREVIOUS_EDGE" <<'PY'
import json,os,subprocess,sys
env=dict(os.environ,COMMONSWARM_EDGE_NETWORK_MODE='commonswarm-net',COMMONSWARM_EDGE_ENV_FILE='/home/commonswarm/.env')
try:
    configs=[]
    for root in sys.argv[1:]:
        work=root+'/deploy/edge-runtime'
        value=json.loads(subprocess.check_output(['docker','compose','-p','commonswarm-edge','-f',work+'/compose.yaml','-f',work+'/compose.override.yaml','config','--format','json'],env=env,stderr=subprocess.DEVNULL))
        configs.append(value['services']['edge-runtime'])
    new,old=configs
    assert new['environment']==old['environment'] and new['environment'].get('SWARM_MCP_PUBLIC_ENABLED')=='1'
    assert new['image']==old['image'] and new['network_mode']=='commonswarm-net' and new['mem_limit']==2147483648
    print('PASS edge-mcp-config: same complete ON env, image pin, commonswarm-net, 2 GiB')
except Exception: raise SystemExit('FAIL edge-mcp-config: new Compose changes effective env/image/network/memory; STOP') from None
PY
}
edge_check() {
python3 - "$EDGE_DIR" <<'PY'
import json,pathlib,subprocess,sys,os
def need(ok):
    if not ok: raise SystemExit('FAIL edge-mcp-runtime: baseline/ON/network/override/env mismatch; STOP')
def inspect(n): return json.loads(subprocess.check_output(['docker','inspect',n]))[0]
p=pathlib.Path(sys.argv[1]); need(p.resolve()==p and p.is_dir())
env=pathlib.Path('/home/commonswarm/.env'); st=env.stat()
need(not env.is_symlink() and st.st_mode & 0o777==0o600 and st.st_uid in (0,p.stat().st_uid))
edge=inspect('commonswarm-edge-edge-runtime-1'); oauth=inspect('commonswarm-oauth-oauth-1')
need(edge['State']['Health']['Status']=='healthy' and oauth['State']['Health']['Status']=='healthy')
need(edge['HostConfig']['Memory']==2147483648 and edge['HostConfig']['NetworkMode']=='commonswarm-net')
labels=edge['Config']['Labels']; work=str(p/'deploy/edge-runtime')
need(labels.get('com.docker.compose.project.working_dir')==work)
need(labels.get('com.docker.compose.project.config_files')==work+'/compose.yaml,'+work+'/compose.override.yaml')
need(any(m['Source']==str(p/'supabase/functions') and m['Destination']=='/home/deno/functions-source' and not m['RW'] for m in edge['Mounts']))
process_env=dict(os.environ,COMMONSWARM_EDGE_NETWORK_MODE='commonswarm-net',COMMONSWARM_EDGE_ENV_FILE=str(env))
config=json.loads(subprocess.check_output(['docker','compose','-p','commonswarm-edge','-f',work+'/compose.yaml','-f',work+'/compose.override.yaml','config','--format','json'],env=process_env,stderr=subprocess.DEVNULL))
expected=config['services']['edge-runtime']; effective=dict(x.split('=',1) for x in edge['Config']['Env'])
need(expected['environment'].get('SWARM_MCP_PUBLIC_ENABLED')=='1')
need(all(effective.get(k)==str(v) for k,v in expected['environment'].items()))
need(effective.get('SWARM_SELF_SERVE')=='1' and not any(k.startswith('SWARM_CMD_TEST_') for k in effective))
need(dict(x.split('=',1) for x in oauth['Config']['Env']).get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED')=='1')
site=pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').read_text()
need(site.count('import mcp_resource_active')==1 and '@mcp_unavailable' not in site)
need(site.count('import mcp_oauth_active')==1)
need(pathlib.Path('/etc/caddy/sites/20-commonswarm-mcp.caddy').stat().st_mode & 0o777==0o644)
print('PASS edge-mcp-runtime: env values withheld; both public flags 1, healthy, commonswarm-net, 2 GiB, exact mounts')
PY
}
edge_probes() {
python3 - <<'PY'
import json,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
checks=[('http://127.0.0.1:9000/health','GET',200),('http://127.0.0.1:3490/health','GET',200),
 ('https://mcp.commonswarm.com/health','GET',200),('https://mcp.commonswarm.com/mcp','POST',401),
 ('https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp','GET',200),
 ('https://mcp.commonswarm.com/.well-known/oauth-authorization-server','GET',200),
 ('https://mcp.commonswarm.com/.well-known/openid-configuration','GET',200)]
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
    assert oauth_release.name.startswith('00e89738') and pathlib.Path(facts['stack']).name.startswith('ad964ed1') and '603a206e' in pathlib.Path(facts['site']).name, 'FAIL edge-mcp-external: task handoff conflicts with live baseline; STOP'
    if sys.argv[2]=='capture': pathlib.Path(sys.argv[1]).write_text(json.dumps(facts,sort_keys=True)+'\n')
elif facts!=json.loads(pathlib.Path(sys.argv[1]).read_text()): raise SystemExit('FAIL edge-mcp-external: OAuth/stack/site/main-Caddy drift; STOP')
PY
}
window_check() {
  test ! -e "$PROOF_DIR/closed.txt"
  test "$(date -u +%s)" -le "$(date -u -d "$WINDOW_END_UTC" +%s)"
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
edge_compose config --quiet
edge_config_check
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
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR"
install -d -o root -g root -m 0700 "$PROOF_DIR"
# Match the existing OAuth window's protected Linux /private/tmp staging.
test -d /private/tmp && test ! -L /private/tmp
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
install -m 0600 /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cp -p /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
cp -p "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" "$PROOF_DIR/compose.override.yaml"
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
  for name in RELEASE_SHA WINDOW_ID BASELINE_EDGE_SHA BOX_ARCHIVE_PATH EDGE_ARCHIVE_SHA256 WINDOW_END_UTC MAX_MCP_OUTAGE_SECONDS PREVIOUS_EDGE NEW_EDGE PROOF_DIR SECRET_STAGE; do
    printf '%s=%q\n' "$name" "${!name}"
  done
  declare -f edge_compose edge_config_check edge_check edge_probes external_check window_check receipt
} >"$PROOF_DIR/state.sh"
chmod 0600 "$PROOF_DIR/state.sh"
printf 'open\n' >"$PROOF_DIR/open.txt"
printf 'PASS edge-mcp-open: protected env snapshot; no production mutation\n'
```

Stage verifies a fresh archive tree and any reused destination, including the
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
test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"
test "$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$EDGE_ARCHIVE_SHA256"
python3 - "$BOX_ARCHIVE_PATH" "$PROOF_DIR/source" "$NEW_EDGE" "$RELEASE_SHA" "$PROOF_DIR/compose.override.yaml" <<'PY'
import os,pathlib,pwd,shutil,stat,sys,tarfile
archive,source,new,sha,override=sys.argv[1:]; source=pathlib.Path(source); new=pathlib.Path(new)
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
                assert m.name not in ('RELEASE_SHA','deploy/edge-runtime/compose.override.yaml')
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
    uid=pwd.getpwnam('commonswarm').pw_uid; gid=pwd.getpwnam('commonswarm').pw_gid
    assert (new.stat().st_uid,new.stat().st_gid)==(uid,gid)
    for base,dirs,files in os.walk(new,followlinks=False):
        for name in dirs+files:
            s=(pathlib.Path(base)/name).lstat(); assert (s.st_uid,s.st_gid)==(uid,gid)
    print('PASS edge-mcp-stage: exact archive path inventory, bytes, symlinks, modes, owner')
except Exception: raise SystemExit('FAIL edge-mcp-stage: immutable release mismatch or incomplete stage; STOP') from None
PY
EDGE_DIR=$NEW_EDGE
edge_compose config --quiet
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
test "$(systemctl show -p ActiveState --value commonswarm-edge-recycle.service)" = inactive
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
edge_compose config --quiet
edge_config_check
edge_compose up -d --no-deps --force-recreate --pull never edge-runtime
deadline=$(( $(date -u +%s) + 180 ))
until test "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)" = healthy; do
  test "$(date -u +%s)" -lt "$deadline"
  sleep 2
done
# Switch current only after the container is healthy. Rollback uses captured path.
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
test "$(readlink -f /home/commonswarm/edge/current)" = "$NEW_EDGE"
install -o root -g root -m 0644 "$PROOF_DIR/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
EDGE_DIR=$NEW_EDGE
edge_check
edge_probes >"$PROOF_DIR/on-probes.txt"
receipt
```

Rollback recreates only the captured baseline release with its override and
unchanged ON env, then restores the original Caddy site. It works if the new
container was recreated but current never moved. It does not depend on a
successful apply marker or unexpired forward window. The runtime pattern is
§6 rollback (`deploy/RELEASE-TO-BOX.md:2648`), with added ON gates.

```sh
# step: edge-mcp-rollback
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-rollback: line $LINENO; ON unverified, retain stage, run timer-recover, report ongoing outage; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test "$PREVIOUS_EDGE" = /home/commonswarm/edge/releases/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
test "$(cat "$PREVIOUS_EDGE/RELEASE_SHA")" = "$BASELINE_EDGE_SHA"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" "$PROOF_DIR/compose.override.yaml"
external_check
EDGE_DIR=$PREVIOUS_EDGE
edge_compose config --quiet
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
  until test "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)" = healthy; do
    test "$(date -u +%s)" -lt "$deadline"
    sleep 2
  done
  ln -sfn "$PREVIOUS_EDGE" /home/commonswarm/edge/current
  install -o root -g root -m 0644 "$PROOF_DIR/mcp.on.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
  runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  systemctl reload caddy
fi
test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
edge_check
edge_probes >"$PROOF_DIR/rollback-probes.txt"
external_check
touch "$PROOF_DIR/rollback.txt"
receipt
```

```sh
# step: edge-mcp-probes
# host: box root /bin/bash
set -euo pipefail
trap 'echo "FAIL edge-mcp-probes: line $LINENO; run rollback; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
if test -f "$PROOF_DIR/rollback.txt"; then EDGE_DIR=$PREVIOUS_EDGE; else EDGE_DIR=$NEW_EDGE; fi
test "$(readlink -f /home/commonswarm/edge/current)" = "$EDGE_DIR"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
external_check
edge_check
edge_probes >"$PROOF_DIR/final-probes.txt"
test -s "$PROOF_DIR/mcp-503-receipt.txt"
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
trap 'echo "FAIL edge-mcp-close: line $LINENO; retain remaining stage and report exact error; STOP" >&2' ERR
. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"
if test -f "$PROOF_DIR/closed.txt"; then
  echo 'edge-mcp-close: already closed'
  if grep -qFx 'budget_met=no' "$PROOF_DIR/mcp-503-receipt.txt"; then exit 1; fi
  exit 0
fi
if test -f "$PROOF_DIR/rollback.txt"; then EDGE_DIR=$PREVIOUS_EDGE; else EDGE_DIR=$NEW_EDGE; fi
test "$(readlink -f /home/commonswarm/edge/current)" = "$EDGE_DIR"
edge_check
edge_probes >"$PROOF_DIR/close-probes.txt"
external_check
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$PROOF_DIR/mcp.on.caddy"
test -s "$PROOF_DIR/mcp-503-receipt.txt"
if test -f "$PROOF_DIR/timer-restore-required.txt"; then systemctl start commonswarm-edge-recycle.timer; fi
systemctl is-active --quiet commonswarm-edge-recycle.timer
test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
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
test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
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
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test ! -L /usr/bin/rm
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
