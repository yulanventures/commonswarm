# OAuth image release

This plan releases only the OAuth service image in the post-C1 layout. HezLead
approves the exact reviewed SHA, window and rollback decision; the assigned
release operator executes it. Before opening, HezLead verifies the server suite
(including the OAuth/MCP HTTP contract) is green at that SHA. This document
prepares a procedure; it does not authorize a production release.

Use the existing root shell through `sudo -n -i /bin/bash -s`. Each box block is
a Bash 5 subshell; each Mac block uses macOS `/bin/bash` 3.2. Paste complete
blocks. A failure stops that block. Stop forward work on every FAIL, command
failure or unknown outcome; retain the window and use the recovery rows below.
Never print resolved Compose config, inspect output, env files or logs. No
secret goes into argv or shell environment. Use the PATH `rm` guard; a refusal
leaves the named path in place and must be reported verbatim. Never change HOME.
Do not stop other services, prune Docker, change Caddy, touch the database or
stop timers. Keep the baseline tree and image. Only one OAuth window may be
open, and only one operator may run its blocks.

At open, measure the resolved `oauth/current`, running image and SHA label, and
SHA-256 of `/etc/commonswarm-oauth/{compose,service}.env` privately on the box.
Create one mode-0600 JSON file with the required keys below and, optionally,
`service_env_provider_list` (no C1 INPUTS fields):

| Key | Value |
| --- | --- |
| release_sha | Reviewed 40 lowercase hex SHA landed on origin/main |
| archive_sha256 | SHA-256 of `git archive --format=tar` at that SHA |
| window_id | Six alphanumeric characters; production refuses /^stg/i; staging requires it |
| window_end_utc | UTC `YYYY-MM-DDTHH:MM:SSZ`, future and at most 30 minutes from box open |
| baseline_oauth_sha | Measured 40 lowercase hex SHA of the resolved current tree |
| baseline_oauth_image | Measured local immutable `sha256:` image ID |
| compose_env_sha256 | Measured SHA-256 of compose.env bytes |
| service_env_sha256 | Measured SHA-256 of service.env bytes |
| service_env_provider_list | Optional: absent/null keeps service.env unchanged; otherwise an ordered comma list such as `google,github` |
| target | production or staging |

The operator supplies the measured main ancestry receipt by running the Mac
archive block against a freshly fetched origin/main. Copy the JSON to a unique
absolute `/tmp/` file on the chosen box before row 0, without changing its
bytes. Set `INPUTS_FILE` to that box file for row 1, and to the identical local
file for rows 0 and 2. Set Mac `BOX_HOST` to the approved SSH destination (production
`ops@100.115.66.74`; staging uses its separately measured host). Set box
`CADDY_CA_FILE` to the existing, measured public CA file which verifies this
box's Caddy certificate for mcp.commonswarm.com. Never use `-k`. Never use a
certificate taken from the chain the box itself serves, or an external
production route for staging. A CA root obtained from the issuer's published
source is allowed only if, before row 0, its SHA-256 fingerprint is verified
to match a second independent source and the file is installed with owner
root, group root and mode 0644. Record this preparation as a step outside
this plan's rows.
The CA bytes are saved at open and proven by the baseline probes; all later
probes reuse that copy. Staging is allowed only on hostname
`c1-staging-20261006` with the regular root:root 0600 marker
`/etc/commonswarm-release/STAGING-ONLY` containing exactly
`c1-staging-disposable-no-production` (no newline). Production requires hostname
`yulan-vps-1` and that marker absent.

Use the `PROOF_DIR` printed by row 1 in every later box shell. Use the
`MAC_STAGE` printed by row 2 in the final Mac copy-back. These are
operational paths, not additional JSON inputs. Inputs and nonsecret evidence
stay in the root-only proof directory. Env snapshots and diagnostics stay in a
fresh 0700 `/tmp/anvil-secret.XXXXXX` until verified close. No release SHA,
baseline SHA, image ID, archive digest or release date is fixed in this plan.

| Row | Step | Host | Condition | Decision |
| --- | --- | --- | --- | --- |
| 0 | oauth-root-shell | Mac | Approved host and local inputs | Measure target hostname; verify root Bash access before any root block |
| 1 | oauth-open | box | Approved window and staged inputs | Validate target, timing and measured baseline; save recovery state and prove baseline routes/CA |
| 2 | oauth-archive | Mac | Open succeeded | Prove ancestry, make and verify exact archive; upload archive and receipt |
| 3 | oauth-preflight | box | Archive and ancestry receipt present | Verify archive, exact Compose bytes; prepare absent release tree |
| 4 | oauth-build | box | Preflight succeeded | Reuse revision-labelled image or build once under caps |
| 5 | oauth-apply | box | Image verified and window still valid; provider step runs only when service_env_provider_list is set | Validate the release catalog and GoTrue providers before the receipt, atomically switch provider keys if selected; recreate only oauth, switch current, prove health |
| 6 | oauth-probes | box | Apply succeeded; PROBE_PHASE=forward | Probe local Caddy metadata/JWKS and MCP 401; require closed gate |
| 7 | oauth-close | box | All forward checks pass; CLOSE_RESULT=success | Recheck identity/env/proofs, clean secrets, record success |
| R0 | oauth-abort | box | Stop after open with oauth-attempted.txt absent; HezLead directs close | Prove unchanged baseline without recreate or rollback; mark aborted-before-attempt |
| R1 | oauth-rollback | box | Attempt receipt present; HezLead directs recovery | Restore exact baseline service.env and Compose bytes before restarting baseline image/current; prove health (no deadline) |
| R2 | oauth-release-aside | box | Rollback or abort proven | Retain only this window's receipt-backed tree under failed-attempts |
| R3 | oauth-probes | box | Rollback and aside complete; PROBE_PHASE=recovery | Probe restored baseline through local Caddy (no deadline) |
| R4 | oauth-close | box | Rollback or abort checks and aside pass; CLOSE_RESULT=rolled-back or aborted | Require restored service.env digest, baseline and absence of this window's receipt-backed tree; record provider step and before/after digests |
| 8 | oauth-copyback | Mac | Verified success, rolled-back or aborted close | Copy only nonsecret proof files; guarded Mac scratch cleanup |

The optional provider step is part of row 5. Before the attempt receipt it
validates input grammar, the release catalog, existing assignments, exact byte
differences and GoTrue settings. Only the prepared atomic write runs after the
receipt, before Compose changes or recreation. A validation refusal takes R0
without restarting the healthy baseline. Absent/null preserves service.env.
A set value contains distinct, nonempty IDs matching `[a-z0-9_-]{1,64}` in
requested order. The allowed set comes from the unpacked release tree's
`services/mcp-auth/src/auth-provider-catalog.js`, checked against its config
parser's catalog use. Unreadable or unrecognized source is refused. Each ID
must also be enabled (`external.<id>` is JSON true) in `/auth/v1/settings`
measured through local Caddy with the saved CA. No credential is sent.

Do not edit service.env by hand before open: release 1 needs its singular key,
and rollback must get that key back from the exact open snapshot. The switch
removes exactly one `MCP_OAUTH_GOTRUE_PROVIDER=<id>` line if present; its ID must
be in the requested list. It then appends exactly one
`MCP_OAUTH_GOTRUE_PROVIDERS=<list>\n` line unless that exact assignment already
exists. Duplicate, ambiguous or conflicting assignments, a missing final
newline before an append, or any other byte difference are refused. An
already-switched file is a byte and inode no-op on rerun; row 5 itself still
refuses a second release attempt in the same window.

The switch preserves every other byte, owner, group and mode, using a
same-directory temp, fsync and rename with a write-time race check. Failure
before rename removes that temp through the rm guard and prints only its path;
a guard refusal retains the path and is reported. Only digests, key names and
provider IDs enter nonsecret evidence; settings and env bytes stay in the
secret stage. Rollback restores and proves the exact open service.env digest
before the baseline image restarts. Recovered close requires those restored
bytes; every close records both key names, whether the optional step ran, and
the before/after digests (including its apply digest after rollback).

If row 1 fails before it prints its proof path, nothing was deployed. Retain any
partial proof/scratch directory and report the failure; do not infer an open
window. After open, recovery is permitted after the deadline. A close failure
keeps the incident open. Never reapply after an attempted switch or silently
reuse a present release tree; finish the matching abort or rollback path, aside
and close, then
open a fresh window ID for a same-SHA retry. With no attempt receipt, use R0,
R2 and R4 with CLOSE_RESULT=aborted; do not run R1 or R3. An attempt receipt
(including an unsafe symlink or unknown outcome) forbids the no-op path; STOP
for HezLead if the receipt is not regular. A tree retained from an earlier
successful release is deliberately ineligible: this plan never reuses or moves
that live-history tree. Returning to that SHA needs a separate reviewed plan.

```sh
# step: oauth-root-shell
# readonly: yes
# host: Mac mini /bin/bash 3.2; box /bin/bash 5 as root via SSH
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-root-shell: line %s; STOP\n" "$LINENO" >&2' ERR
: "${BOX_HOST:?FAIL oauth-root-shell: BOX_HOST required; STOP}" "${INPUTS_FILE:?FAIL oauth-root-shell: local INPUTS_FILE required; STOP}"
TARGET=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["target"])' "$INPUTS_FILE")
case "$TARGET" in
 production) EXPECTED_HOST=yulan-vps-1;;
 staging) EXPECTED_HOST=c1-staging-20261006;;
 *) printf 'FAIL oauth-root-shell: invalid target; STOP\n' >&2; exit 1;;
esac
MEASURED_HOST=$(ssh -n "$BOX_HOST" hostname)
test "$MEASURED_HOST" = "$EXPECTED_HOST" || { printf 'FAIL oauth-root-shell: measured hostname mismatch; STOP\n' >&2; exit 1; }
ssh "$BOX_HOST" 'sudo -n -i /bin/bash -s' <<'BOX'
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-root-shell (box): line %s; STOP\n" "$LINENO" >&2' ERR
test "$(id -u)" -eq 0
test "${BASH_VERSINFO[0]}" -ge 5
)
BOX
)
```

```sh
# step: oauth-open
# readonly: no
# host: box /bin/bash 5 as root; captures files only
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-open: line %s; STOP\n" "$LINENO" >&2' ERR
umask 077
test "$(id -u)" -eq 0
: "${INPUTS_FILE:?FAIL oauth-open: INPUTS_FILE required; STOP}" "${CADDY_CA_FILE:?FAIL oauth-open: CADDY_CA_FILE required; STOP}"
# Validator and clock gate: tests execute this exact Python with file/host fixtures.
python3 - "$INPUTS_FILE" /etc/commonswarm-release/STAGING-ONLY "$(hostname)" <<'PY'
import datetime,json,os,pathlib,re,stat,sys
name,marker,host=sys.argv[1:4]
def need(ok,label):
    if not ok: raise SystemExit('FAIL oauth-open: '+label+'; STOP')
def pairs(rows):
    result={}
    for k,v in rows:
        need(k not in result,'duplicate input key'); result[k]=v
    return result
p=pathlib.Path(name)
need(p.is_absolute() and p.is_file() and not p.is_symlink(),'inputs must be absolute regular file')
need(stat.S_IMODE(p.stat().st_mode)==0o600,'inputs mode must be 0600')
try: d=json.loads(p.read_bytes(),object_pairs_hook=pairs)
except (ValueError,UnicodeError): raise SystemExit('FAIL oauth-open: invalid JSON; STOP') from None
keys={'release_sha','archive_sha256','window_id','window_end_utc','baseline_oauth_sha','baseline_oauth_image','compose_env_sha256','service_env_sha256','target'}
need(isinstance(d,dict) and keys<=set(d)<=keys|{'service_env_provider_list'},'exact input keys required')
need(all(isinstance(d[k],str) for k in keys),'all required input values must be strings')
v=d.get('service_env_provider_list')
if v is not None:
    need(isinstance(v,str) and re.fullmatch(r'[a-z0-9_-]{1,64}(?:,[a-z0-9_-]{1,64})*',v) is not None,'invalid provider list')
    need(len(v.split(','))==len(set(v.split(','))),'duplicate provider')
for k in ('release_sha','baseline_oauth_sha'): need(re.fullmatch('[0-9a-f]{40}',d[k]) is not None,k+' must be full SHA')
for k in ('archive_sha256','compose_env_sha256','service_env_sha256'): need(re.fullmatch('[0-9a-f]{64}',d[k]) is not None,k+' must be SHA-256')
need(re.fullmatch('sha256:[0-9a-f]{64}',d['baseline_oauth_image']) is not None,'baseline image must be immutable')
need(d['release_sha']!=d['baseline_oauth_sha'],'release must differ from baseline')
need(re.fullmatch('[A-Za-z0-9]{6}',d['window_id']) is not None,'window_id must be six alnum')
need(d['target'] in ('production','staging'),'target must be production or staging')
m=pathlib.Path(marker)
if d['target']=='staging':
    need(host=='c1-staging-20261006','staging hostname mismatch')
    need(m.is_file() and not m.is_symlink(),'staging marker required')
    s=m.stat(); need(s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'staging marker must be root:root 0600')
    need(m.read_bytes()==b'c1-staging-disposable-no-production','staging marker content mismatch')
    need(re.match('stg',d['window_id'],re.I) is not None,'staging requires stg window_id')
else:
    need(host=='yulan-vps-1' and not os.path.lexists(marker),'production hostname/marker mismatch')
    need(re.match('stg',d['window_id'],re.I) is None,'production refuses stg window_id')
need(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',d['window_end_utc']) is not None,'window end must be UTC Z')
try: end=datetime.datetime.strptime(d['window_end_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
except ValueError: raise SystemExit('FAIL oauth-open: invalid window end; STOP') from None
now=datetime.datetime.now(datetime.timezone.utc)
need(0<(end-now).total_seconds()<=1800,'window must end within 30 minutes')
recycles=[now.replace(hour=h,minute=30,second=0,microsecond=0)+datetime.timedelta(days=day) for day in (0,1) for h in (3,9,15,21)]
next_recycle=min(t for t in recycles if t>=now)
need((next_recycle-now).total_seconds()>2100,'within 35 minutes before recycle')
need(end<next_recycle,'window end reaches recycle')
print('PASS exact inputs, target and timing')
PY
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
NEW_OAUTH=/home/commonswarm/oauth/releases/$RELEASE_SHA
test ! -e "$NEW_OAUTH" && test ! -L "$NEW_OAUTH" || { printf 'FAIL oauth-open: release tree already exists; STOP\n' >&2; exit 1; }
PROOF_DIR=/home/commonswarm/oauth/release-proofs/$RELEASE_SHA-$WINDOW_ID
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR" || { printf 'FAIL oauth-open: proof path already exists or is a symlink; STOP\n' >&2; exit 1; }
install -d -o root -g root -m 0700 /home/commonswarm/oauth/release-proofs
mkdir -m 0700 "$PROOF_DIR"
install -m 0600 -o root -g root "$INPUTS_FILE" "$PROOF_DIR/inputs.json"
SECRET_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX)
printf '%s\n' "$SECRET_STAGE" >"$PROOF_DIR/secret-stage.path"
# The helper saves measured inputs and provides the same checks to all steps.
python3 - "$PROOF_DIR" "$SECRET_STAGE" "$CADDY_CA_FILE" <<'PY'
import datetime,json,pathlib,shlex,sys
proof,stage,ca=sys.argv[1:4]; d=json.loads(pathlib.Path(proof,'inputs.json').read_bytes())
p=pathlib.Path(ca)
if not (p.is_absolute() and p.is_file() and not p.is_symlink()): raise SystemExit('FAIL oauth-open: measured Caddy CA must be absolute regular file; STOP')
pathlib.Path(proof,'caddy-ca.pem').write_bytes(p.read_bytes())
v={'PROOF_DIR':proof,'SECRET_STAGE':stage,'CADDY_CA_FILE':proof+'/caddy-ca.pem','RELEASE_SHA':d['release_sha'],'WINDOW_ID':d['window_id'],
   'OLD_OAUTH':'/home/commonswarm/oauth/releases/'+d['baseline_oauth_sha'],'NEW_OAUTH':'/home/commonswarm/oauth/releases/'+d['release_sha'],
   'BASELINE_IMAGE':d['baseline_oauth_image'],'INPUTS_FILE':proof+'/inputs.json','BOX_ARCHIVE_PATH':'/tmp/oauth-'+d['release_sha']+'-'+d['window_id']+'.tar'}
pathlib.Path(proof,'session.sh').write_text(''.join(k+'='+shlex.quote(x)+'\n' for k,x in v.items()))
pathlib.Path(proof,'opened.txt').write_text(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')+'\n')
PY
cat >>"$PROOF_DIR/session.sh" <<'SH'
# Loaded only from this root-owned 0700 proof directory.
umask 077
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
fail() { printf 'FAIL OAuth release: %s; STOP\n' "$1" >&2; exit 1; }
oauth_deadline() {
 python3 - "$INPUTS_FILE" "$PROOF_DIR/opened.txt" <<'PY'
import datetime,json,pathlib,sys
end=datetime.datetime.strptime(json.load(open(sys.argv[1]))['window_end_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
start=datetime.datetime.strptime(pathlib.Path(sys.argv[2]).read_text().strip(),'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
now=datetime.datetime.now(datetime.timezone.utc)
if not start<=now<end: raise SystemExit('FAIL OAuth release: window expired or clock moved backwards; STOP')
PY
}
oauth_compose() (
 local tree=$1 name keys; shift
 # Keep W3's Docker client environment. Unset interpolation keys read from the
 # exact Compose files so the measured env file alone supplies those values.
 keys=$(python3 -c 'import pathlib,re,sys; print(" ".join(sorted({m for f in sys.argv[1:] for m in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)",pathlib.Path(f).read_text())})))' "$tree/deploy/mcp-auth/compose.yaml" "$tree/deploy/mcp-auth/compose.management.yaml")
 for name in $keys; do unset "$name"; done
 docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
  -f "$tree/deploy/mcp-auth/compose.yaml" -f "$tree/deploy/mcp-auth/compose.management.yaml" "$@"
)
oauth_service_env() {
 python3 - "$1" "$INPUTS_FILE" "$SECRET_STAGE" "$PROOF_DIR" "$CADDY_CA_FILE" "$NEW_OAUTH" <<'PY'
import datetime,hashlib,json,os,pathlib,re,stat,subprocess,sys,tempfile
mode,inputs,stage,proof,ca,tree=sys.argv[1:7]; d=json.load(open(inputs)); proof=pathlib.Path(proof)
p=pathlib.Path('/etc/commonswarm-oauth/service.env'); snapshot=pathlib.Path(stage,'service.env')
def need(ok,label):
    if not ok: raise SystemExit('FAIL OAuth service.env: '+label+'; STOP')
def sha(raw): return hashlib.sha256(raw).hexdigest()
def regular(path):
    need(path.is_file() and not path.is_symlink(),'regular service.env or snapshot required')
def record(name,value):
    with (proof/name).open('x') as f:
        f.write(json.dumps(value,sort_keys=True)+'\n'); f.flush(); os.fsync(f.fileno())
    fd=os.open(proof,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
def secret_file(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:
        os.fchmod(f.fileno(),0o600); f.write(raw); f.flush(); os.fsync(f.fileno())
def identity(s):
    return [s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_size,s.st_mtime_ns]
regular(p); meta=p.stat(); raw=p.read_bytes()
# Baseline check also runs at open, before a snapshot exists.
if mode=='baseline':
    need(sha(raw)==d['service_env_sha256'],'baseline service.env digest mismatch')
    raise SystemExit(0)
regular(snapshot); old=snapshot.read_bytes()
need(sha(old)==d['service_env_sha256'],'snapshot digest mismatch')
v=d.get('service_env_provider_list'); keys=['MCP_OAUTH_GOTRUE_PROVIDER','MCP_OAUTH_GOTRUE_PROVIDERS']
prepared=pathlib.Path(stage,'service-env-prepared.json'); prepared_bytes=pathlib.Path(stage,'service.env.switched')
# Apply consumes only the pre-receipt preparation, with a race check at the write.
if mode=='apply':
    if v is None: raise SystemExit(0)
    regular(prepared); regular(prepared_bytes)
    ready=json.loads(prepared.read_bytes()); evidence=ready['evidence']; wanted=prepared_bytes.read_bytes()
    need(ready['input_sha256']==sha(pathlib.Path(inputs).read_bytes()) and evidence['before_sha256']==sha(old) and
        evidence['after_sha256']==sha(wanted),'prepared switch digest mismatch')
    need(raw==old or raw==wanted,'extra service.env difference before switch')
    receipt=proof/'oauth-attempted.txt'
    need(receipt.is_file() and not receipt.is_symlink(),'regular attempt receipt required before mutation')
    attempted=proof/'service-env-attempted.json'
    if os.path.lexists(attempted):
        regular(attempted); regular(proof/'service-env-step.json')
        need(json.loads(attempted.read_bytes())==evidence and raw==wanted,'provider step already attempted; recover and close')
        raise SystemExit(0)
    need(identity(meta)==ready['identity'],'service.env changed after validation')
    record('service-env-attempted.json',evidence)
else:
    need(mode in ('validate','forward','restore','close-success','close-recovered'),'unknown service.env action')
    expected=old; added=False; removed=False
    # An unchanged refused baseline remains eligible for R0/close and R1.
    unchanged_recovery=mode in ('restore','close-recovered') and raw==old and not os.path.lexists(proof/'service-env-attempted.json')
    if v is not None and not unchanged_recovery:
        need(isinstance(v,str) and re.fullmatch(r'[a-z0-9_-]{1,64}(?:,[a-z0-9_-]{1,64})*',v) is not None,'invalid provider list')
        providers=v.split(','); need(len(providers)==len(set(providers)),'duplicate provider')
        singular=re.findall(rb'^[ \t]*(?:export[ \t]+)?MCP_OAUTH_GOTRUE_PROVIDER[ \t]*=([^\r\n]*)',old,re.M)
        if singular:
            need(len(singular)==1 and singular[0].decode('ascii',errors='replace') in providers,'singular provider not in list or assignment is ambiguous')
            exact=keys[0].encode()+b'='+singular[0]
            rows=old.splitlines(keepends=True)
            need(sum(row in (exact,exact+b'\n') for row in rows)==1,'singular provider assignment is ambiguous')
            expected=b''.join(row for row in rows if row not in (exact,exact+b'\n')); removed=True
        line=keys[1].encode()+b'='+v.encode()
        assignments=re.findall(rb'^[ \t]*(?:export[ \t]+)?MCP_OAUTH_GOTRUE_PROVIDERS[ \t]*=([^\r\n]*)',expected,re.M)
        if assignments:
            need(assignments==[v.encode()] and expected.splitlines().count(line)==1,'existing provider value differs or assignment is ambiguous')
        else:
            need(not expected or expected.endswith(b'\n'),'snapshot needs final newline for exact provider switch')
            expected+=line+b'\n'; added=True
    if mode=='validate':
        need(raw in (old,expected),'extra service.env difference before switch')
        if v is None: raise SystemExit(0)
        # Read only the reviewed, unpacked tree. Fail closed on unreadable or
        # changed source syntax; never execute release JavaScript on the box.
        source=pathlib.Path(tree,'services/mcp-auth/src')
        try:
            catalog=(source/'auth-provider-catalog.js').read_text()
            parser=(source/'config.js').read_text()
        except (OSError,UnicodeError): raise SystemExit('FAIL OAuth service.env: release provider catalog unreadable; STOP') from None
        need('import { AUTH_PROVIDER_CATALOG } from "./auth-provider-catalog.js";' in parser and
            'const known = new Set(AUTH_PROVIDER_CATALOG.map(({ id }) => id));' in parser and
            '!known.has(id)' in parser,'release parser catalog contract changed')
        catalog=re.sub(r'//[^\n]*','',catalog)
        outer=re.fullmatch(r'\s*export const AUTH_PROVIDER_CATALOG = Object\.freeze\(\[([\s\S]*)\]\.map\(\(provider\) => Object\.freeze\(provider\)\)\);\s*',catalog)
        need(outer is not None,'release provider catalog syntax changed')
        # Restrict the whole declaration to literal reviewed entries. Extract
        # IDs from the id field only, not labels, comments or another list.
        string=r'"[^"\\\n]*"'
        entry=r'\s*\{\s*id:\s*/\*\* @type \{"([a-z0-9_-]{1,64})"\} \*/ \("([a-z0-9_-]{1,64})"\),\s*label:\s*'+string+r',\s*name:\s*'+string+r',\s*legalEntity:\s*'+string+r',\s*\},'
        entries=list(re.finditer(entry,outer[1]))
        need(entries and not re.sub(entry,'',outer[1]).strip() and all(x[1]==x[2] for x in entries),'release provider catalog entries changed')
        allowed=[x[2] for x in entries]
        need(len(allowed)==len(set(allowed)) and all(x in allowed for x in providers),'provider outside release catalog')
        settings=pathlib.Path(stage,'gotrue-settings.json')
        result=subprocess.run(['curl','--fail','--silent','--show-error','--noproxy','*','--connect-timeout','5','--max-time','15',
            '--cacert',ca,'--resolve','api.commonswarm.com:443:127.0.0.1','--output',str(settings),
            'https://api.commonswarm.com/auth/v1/settings'],stderr=subprocess.DEVNULL)
        need(result.returncode==0,'GoTrue settings request failed')
        body=settings.read_bytes(); need(len(body)<=131072,'oversized GoTrue settings')
        try: external=json.loads(body).get('external')
        except (ValueError,AttributeError): raise SystemExit('FAIL OAuth service.env: invalid GoTrue settings; STOP') from None
        need(isinstance(external,dict) and all(external.get(x) is True for x in providers),'provider not enabled in GoTrue')
        evidence={'ran':True,'added':added,'removed_singular':removed,'before_sha256':sha(old),'after_sha256':sha(expected),
            'key_names':keys,'added_line':line.decode() if added else None,'enabled_providers':providers,
            'owner_uid':meta.st_uid,'owner_gid':meta.st_gid,'mode':format(stat.S_IMODE(meta.st_mode),'04o')}
        # Secret preparation is not an attempt. A refusal above leaves R0 open.
        secret_file(prepared_bytes,expected)
        secret_file(prepared,(json.dumps({'evidence':evidence,'identity':identity(meta),
            'input_sha256':sha(pathlib.Path(inputs).read_bytes())})+'\n').encode())
        raise SystemExit(0)
    elif mode=='restore':
        need(raw in (old,expected),'extra service.env difference during recovery')
        wanted=old
    else:
        wanted=expected if mode in ('forward','close-success') else old
        need(raw==wanted,'extra service.env difference or missing provider switch')
# Rename only on a byte change; keep owner/group/mode and fsync both stages.
if mode in ('apply','restore') and raw!=wanted:
    fd,name=tempfile.mkstemp(prefix='.service.env.oauth-',dir=p.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            os.fchown(f.fileno(),meta.st_uid,meta.st_gid)
            os.fchmod(f.fileno(),stat.S_IMODE(meta.st_mode))
            f.write(wanted); f.flush(); os.fsync(f.fileno())
        need(p.read_bytes()==raw and identity(p.stat())==identity(meta),'service.env changed during atomic preparation')
        os.replace(name,p)
        fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.lexists(name):
            # Use the installed rm guard, even on failure. Report only the path.
            print(name,flush=True)
            need(subprocess.run(['rm','--',name]).returncode==0,'temp cleanup refused; retain path and guard message')
regular(p); after=p.stat()
need(p.read_bytes()==wanted,'service.env byte proof failed')
need((after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode))==(meta.st_uid,meta.st_gid,stat.S_IMODE(meta.st_mode)),'service.env metadata changed')
if mode=='apply' and v is not None:
    record('service-env-step.json',evidence)
    print('PASS service.env sha256 '+sha(old)+' -> '+sha(wanted))
    if evidence['removed_singular']: print('-'+keys[0])
    if evidence['added']: print('+'+keys[1]+'='+v)
if mode=='restore':
    need(sha(p.read_bytes())==d['service_env_sha256'],'restored digest differs from open')
    if v is not None:
        (proof/'service-env-restored.json').write_text(json.dumps({'sha256':sha(old)})+'\n')
if mode.startswith('close-'):
    attempted=proof/'service-env-attempted.json'; ran=os.path.lexists(attempted)
    need(not ran or (attempted.is_file() and not attempted.is_symlink()),'unsafe provider step receipt')
    r={'ran':ran,'key_names':keys,'before_sha256':sha(old),'after_sha256':sha(wanted)}
    if ran:
        a=json.loads(attempted.read_bytes())
        need(v is not None and a['before_sha256']==sha(old) and a['after_sha256']==sha(expected),'provider receipt digest mismatch')
        r['apply_after_sha256']=a['after_sha256']
    if mode=='close-success' and v is not None:
        need(ran and (proof/'service-env-step.json').is_file(),'completed provider step required')
    (proof/'service-env-close.json').write_text(json.dumps(r,sort_keys=True)+'\n')
PY
}

oauth_env() {
 python3 - "$INPUTS_FILE" "$1" <<'PY'
import hashlib,json,pathlib,re,stat,sys
inputs,expected=sys.argv[1:3]; d=json.load(open(inputs))
def need(ok,label):
    if not ok: raise SystemExit('FAIL OAuth release: '+label+'; STOP')
for kind in ('compose','service'):
    p=pathlib.Path('/etc/commonswarm-oauth/'+kind+'.env')
    need(p.is_file() and not p.is_symlink(),'env must be regular')
    s=p.stat(); need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'env must be root:root 0600')
    raw=p.read_bytes()
    # Even an empty assignment is forbidden. Comments are harmless.
    need(re.search(rb'^\s*(?:export\s+)?MCP_OAUTH_ADMIN_(?:ISSUANCE_ENABLED|ISSUER_DATABASE_CREDENTIALS_FILE)\s*=',raw,re.M) is None,'admin issuance env must stay unset')
    if expected==d['baseline_oauth_image'] or (kind=='service' and d.get('service_env_provider_list') is None):
        need(hashlib.sha256(raw).hexdigest()==d[kind+'_env_sha256'],'measured env digest mismatch')
    if kind=='compose':
        matches=re.findall(rb'^MCP_OAUTH_IMAGE=(.*)$',raw,re.M)
        need(matches==[expected.encode()],'Compose image must equal expected immutable ID')
PY
 if test "$1" = "$BASELINE_IMAGE"; then oauth_service_env baseline; else oauth_service_env forward; fi
}
oauth_identity() {
 python3 - "$1" "$2" "$PROOF_DIR/port.txt" <<'PY'
import json,pathlib,subprocess,sys
sha,image,portfile=sys.argv[1:4]; tree='/home/commonswarm/oauth/releases/'+sha
# Captured inspect output can contain secrets. It stays inside this process.
def read(args): return subprocess.check_output(args,stderr=subprocess.DEVNULL)
def need(ok,label):
    if not ok: raise SystemExit('FAIL OAuth release: '+label+'; STOP')
c=json.loads(read(['docker','inspect','commonswarm-oauth-oauth-1']))[0]; labels=c['Config']['Labels']
need(c['Image']==image and c['State']['Running'] and c['State']['Health']['Status']=='healthy','running image/health mismatch')
need(labels.get('com.docker.compose.project')=='commonswarm-oauth' and labels.get('com.docker.compose.service')=='oauth','Compose project/service mismatch')
need(labels.get('com.docker.compose.project.config_files')==tree+'/deploy/mcp-auth/compose.yaml,'+tree+'/deploy/mcp-auth/compose.management.yaml','active Compose files mismatch')
need(labels.get('com.docker.compose.project.working_dir')==tree+'/deploy/mcp-auth','active Compose working directory mismatch')
need(pathlib.Path('/home/commonswarm/oauth/current').is_symlink() and str(pathlib.Path('/home/commonswarm/oauth/current').resolve(strict=True))==tree,'current symlink mismatch')
need(read(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image]).decode().strip()==sha,'image revision mismatch')
need(not any(r.split('=',1)[0] in ('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE') for r in c['Config']['Env']),'running admin env must be unset')
ports=c['NetworkSettings']['Ports']['3490/tcp']
need(len(ports)==1 and ports[0]['HostIp']=='127.0.0.1','OAuth must bind one loopback port')
port=ports[0]['HostPort']; need(port.isdigit() and 3490<=int(port)<=3499,'OAuth loopback port mismatch')
pathlib.Path(portfile).write_text(port+'\n')
PY
}
oauth_health() {
 timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
}
oauth_route_probes() {
 local phase=$1 ROUTE URL EXPECTED CODE PORT
 local -a ARGS
for ROUTE in metadata jwks mcp; do
 case "$ROUTE" in
 metadata) URL=https://mcp.commonswarm.com/.well-known/oauth-authorization-server; EXPECTED=200;;
 jwks) URL=https://mcp.commonswarm.com/jwks; EXPECTED=200;;
 mcp) URL=https://mcp.commonswarm.com/mcp; EXPECTED=401;;
 esac
 ARGS=(--silent --show-error --noproxy '*' --connect-timeout 5 --max-time 15 --cacert "$CADDY_CA_FILE" --resolve mcp.commonswarm.com:443:127.0.0.1)
 if test "$ROUTE" = mcp; then
  ARGS+=(--request POST --header 'Content-Type: application/json' --header 'Accept: application/json, text/event-stream' --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"oauth-release-probe","version":"1"}}}')
 fi
 CODE=$(curl "${ARGS[@]}" --output "$SECRET_STAGE/$ROUTE.json" --dump-header "$SECRET_STAGE/$ROUTE.headers" --write-out '%{http_code}' "$URL")
 test "$CODE" = "$EXPECTED" || fail 'Caddy route status mismatch'
done
PORT=$(cat "$PROOF_DIR/port.txt")
curl --fail --silent --show-error --noproxy '*' --max-time 15 \
 --output "$SECRET_STAGE/gate.json" "http://127.0.0.1:$PORT/admin/gate"
python3 - "$SECRET_STAGE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
def need(ok,label):
    if not ok: raise SystemExit('FAIL oauth-probes: '+label+'; STOP')
def value(name):
    raw=(p/(name+'.json')).read_bytes(); need(len(raw)<=131072,'oversized route body')
    try: v=json.loads(raw)
    except ValueError: raise SystemExit('FAIL oauth-probes: route must return JSON; STOP') from None
    need(isinstance(v,dict),'route JSON must be object'); return v
m=value('metadata'); need(m.get('issuer')=='https://mcp.commonswarm.com' and m.get('jwks_uri')=='https://mcp.commonswarm.com/jwks','metadata issuer/JWKS mismatch')
k=value('jwks').get('keys'); need(isinstance(k,list) and bool(k) and all(isinstance(x,dict) and 'd' not in x and 'k' not in x for x in k),'public JWKS mismatch')
need('www-authenticate:' in (p/'mcp.headers').read_text().lower(),'MCP 401 must carry authentication challenge')
need(value('gate')=={'state':'closed'},'local admin gate must remain closed')
PY
printf 'PASS\n' >"$PROOF_DIR/probes-$phase.txt"
}
test "$(id -u)" -eq 0 || fail 'root required'
test ! -e "$PROOF_DIR/close-result.json" && test ! -L "$PROOF_DIR/close-result.json" || fail 'window already closed or close path unsafe'
SH
chmod 0600 "$PROOF_DIR/session.sh"
. "$PROOF_DIR/session.sh"
oauth_env "$BASELINE_IMAGE"
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
# Prove the CA, routes and closed gate BEFORE copying secrets or preparing a tree.
oauth_route_probes baseline
# Store snapshots only after the input digests, running baseline and probes match.
install -m 0600 -o root -g root /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
install -m 0600 -o root -g root /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
oauth_deadline
printf 'PASS open; PROOF_DIR=%s\n' "$PROOF_DIR"
)
```

```sh
# step: oauth-archive
# readonly: no
# host: Mac mini /bin/bash 3.2; archive and upload only
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-archive: line %s; STOP\n" "$LINENO" >&2' ERR
umask 077
: "${INPUTS_FILE:?FAIL oauth-archive: INPUTS_FILE required; STOP}" "${BOX_HOST:?FAIL oauth-archive: BOX_HOST required; STOP}"
RELEASE_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["release_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["window_id"]; assert re.fullmatch("[A-Za-z0-9]{6}",v); print(v)' "$INPUTS_FILE")
case "$(git remote get-url origin)" in
 git@github.com:yulanventures/commonswarm.git|https://github.com/yulanventures/commonswarm.git|https://github.com/yulanventures/commonswarm) ;;
 *) printf 'FAIL oauth-archive: origin must be yulanventures/commonswarm on GitHub; STOP\n' >&2; exit 1;;
esac
git fetch origin main
test "$(git rev-parse "$RELEASE_SHA^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
MAC_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
printf 'Mac scratch created: MAC_STAGE=%s\n' "$MAC_STAGE"
install -m 0600 "$INPUTS_FILE" "$MAC_STAGE/inputs.json"
git archive --format=tar "$RELEASE_SHA" >"$MAC_STAGE/release.tar"
MAIN_SHA=$(git rev-parse origin/main)
python3 - "$MAC_STAGE" "$MAIN_SHA" <<'PY'
import datetime,hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes())
if hashlib.sha256((p/'release.tar').read_bytes()).hexdigest()!=d['archive_sha256']: raise SystemExit('FAIL oauth-archive: exact archive checksum mismatch; STOP')
r={'release_sha':d['release_sha'],'origin_main_sha':sys.argv[2],'is_ancestor':True,'measured_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
(p/'ancestry.json').write_text(json.dumps(r,sort_keys=True)+'\n')
PY
scp "$MAC_STAGE/release.tar" "$BOX_HOST:/tmp/oauth-$RELEASE_SHA-$WINDOW_ID.tar"
scp "$MAC_STAGE/ancestry.json" "$BOX_HOST:/tmp/oauth-$RELEASE_SHA-$WINDOW_ID.ancestry.json"
printf 'PASS exact landed archive uploaded; MAC_STAGE=%s\n' "$MAC_STAGE"
)
```

```sh
# step: oauth-preflight
# readonly: no
# host: box /bin/bash 5 as root; verifies archive and prepares tree
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-preflight: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-preflight: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
oauth_deadline
test "$(cat "$PROOF_DIR/probes-baseline.txt")" = PASS || fail 'baseline probe receipt required before forward work'
test ! -e "$PROOF_DIR/aborted-before-attempt.txt" && test ! -L "$PROOF_DIR/aborted-before-attempt.txt" || fail 'window aborted; close it before a new window'
oauth_env "$BASELINE_IMAGE"
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
test ! -e "$PROOF_DIR/oauth-attempted.txt" && test ! -L "$PROOF_DIR/oauth-attempted.txt" || fail 'release already attempted; recover and close'
python3 - "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$NEW_OAUTH" <<'PY'
import datetime,hashlib,json,os,pathlib,re,sys,tarfile
inputs,archive,proof,new=sys.argv[1:5]; d=json.load(open(inputs)); p=pathlib.Path(proof)
def need(ok,label):
    if not ok: raise SystemExit('FAIL oauth-preflight: '+label+'; STOP')
a=pathlib.Path(archive); need(a.is_file() and not a.is_symlink(),'archive must be regular')
need(hashlib.sha256(a.read_bytes()).hexdigest()==d['archive_sha256'],'archive sha256 mismatch')
rp=pathlib.Path(archive.removesuffix('.tar')+'.ancestry.json'); need(rp.is_file() and not rp.is_symlink(),'ancestry receipt required')
r=json.loads(rp.read_bytes())
need(set(r)=={'release_sha','origin_main_sha','is_ancestor','measured_at'} and r['release_sha']==d['release_sha'] and r['is_ancestor'] is True and isinstance(r['origin_main_sha'],str) and re.fullmatch('[0-9a-f]{40}',r['origin_main_sha']) is not None,'main ancestry receipt mismatch')
at=datetime.datetime.strptime(r['measured_at'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
start=datetime.datetime.strptime((p/'opened.txt').read_text().strip(),'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
need(start<=at<=datetime.datetime.now(datetime.timezone.utc),'ancestry receipt must be measured in this window')
(p/'ancestry.json').write_bytes(rp.read_bytes())
need(not os.path.lexists(new),'new release tree must be absent; recover previous window before retry')
# Reject archive escapes before extracting an exact git archive.
with tarfile.open(archive) as t:
    members=t.getmembers(); names=[m.name for m in members]
    need(len(names)==len(set(names)),'duplicate archive members')
    for m in members:
        path=pathlib.PurePosixPath(m.name)
        need(not path.is_absolute() and '..' not in path.parts and (m.isfile() or m.isdir() or m.issym()),'unsafe archive member')
        if m.issym():
            target=pathlib.PurePosixPath(m.linkname)
            need(not target.is_absolute() and '..' not in target.parts,'unsafe archive symlink')
    # Git's archive commit header independently binds the archive to the SHA.
    need(t.pax_headers.get('comment')==d['release_sha'],'archive commit header mismatch')
    with (p/'oauth-tree-created.txt').open('x') as f: f.write(new+'\n')
    pathlib.Path(new).mkdir(mode=0o755)
    t.extractall(new,filter='data')
(p/'archive.sha256').write_text(d['archive_sha256']+'\n')
(p/'oauth-releases-inventory.json').write_text(json.dumps({'baseline':d['baseline_oauth_sha'],'release':d['release_sha'],'other_releases_ignored':sorted(n for n in os.listdir('/home/commonswarm/oauth/releases') if n not in (d['baseline_oauth_sha'],d['release_sha']))},sort_keys=True)+'\n')
PY
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" "$NEW_OAUTH/deploy/mcp-auth/compose.yaml"
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" "$NEW_OAUTH/deploy/mcp-auth/compose.management.yaml"
printf 'PASS\n' >"$PROOF_DIR/preflight.txt"
printf 'PASS archive and Compose bytes exact; admin activation remains unset\n'
)
```

```sh
# step: oauth-build
# readonly: no
# host: box /bin/bash 5 as root; build once with CPU caps
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-build: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-build: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
oauth_deadline
test "$(cat "$PROOF_DIR/probes-baseline.txt")" = PASS || fail 'baseline probe receipt required before forward work'
test ! -e "$PROOF_DIR/aborted-before-attempt.txt" && test ! -L "$PROOF_DIR/aborted-before-attempt.txt" || fail 'window aborted; close it before a new window'
test "$(cat "$PROOF_DIR/preflight.txt")" = PASS
IMAGE_TAG=commonswarm-oauth:release-$RELEASE_SHA
# Revision-label lookup covers a previous failed window even if its tag was lost.
CACHED=$(docker image ls --no-trunc --quiet --filter "label=org.opencontainers.image.revision=$RELEASE_SHA" | sort -u)
TAGGED=$(docker image ls --no-trunc --quiet --filter "reference=$IMAGE_TAG")
if test -n "$TAGGED"; then
 test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")" = "$RELEASE_SHA" || fail 'cached tag revision mismatch'
fi
if test -n "$CACHED"; then
 test "$(printf '%s\n' "$CACHED" | wc -l)" -eq 1 || fail 'multiple images carry release revision'
 IMAGE=$CACHED
 test -z "$TAGGED" || test "$TAGGED" = "$IMAGE"
 docker image tag "$IMAGE" "$IMAGE_TAG"
else
 test -z "$TAGGED" || fail 'tag exists without expected revision'
 test "$(docker info --format '{{.CPUCfsPeriod}} {{.CPUCfsQuota}}')" = 'true true' || fail 'builder cannot enforce CPU cap'
 python3 - "$NEW_OAUTH/services/mcp-auth/Dockerfile" >"$PROOF_DIR/oauth-base-references.txt" <<'PY'
import pathlib,re,sys
refs=[line.split()[1] for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.startswith('FROM ')]
if not refs or len(set(refs))!=1 or not all(re.fullmatch(r'node:[0-9A-Za-z.+-]+@sha256:[0-9a-f]{64}',r) for r in refs): raise SystemExit('FAIL oauth-build: reviewed bases must share one pinned digest; STOP')
print(refs[0])
PY
 while IFS= read -r BASE_REFERENCE; do
  docker pull "$BASE_REFERENCE" >>"$SECRET_STAGE/build.log" 2>&1
 done <"$PROOF_DIR/oauth-base-references.txt"
 DOCKER_BUILDKIT=0 nice -n 15 docker build --pull=false \
  --cpu-period=100000 --cpu-quota=300000 --tag "$IMAGE_TAG" \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --file "$NEW_OAUTH/services/mcp-auth/Dockerfile" "$NEW_OAUTH" >>"$SECRET_STAGE/build.log" 2>&1
 IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
fi
python3 - "$IMAGE" <<'PY'
import re,sys
if not re.fullmatch('sha256:[0-9a-f]{64}',sys.argv[1]): raise SystemExit('FAIL oauth-build: image must be immutable ID; STOP')
PY
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$RELEASE_SHA"
docker image inspect "$BASELINE_IMAGE" >/dev/null 2>&1
printf '%s\n' "$IMAGE" >"$PROOF_DIR/oauth-image.id"
# Preserve W3's image-content control, deriving the package bytes from this SHA.
PACKAGE_SHA256=$(sha256sum "$NEW_OAUTH/services/mcp-auth/package.json" | cut -d ' ' -f 1)
docker run --rm --network none --pull never --entrypoint node "$IMAGE" --input-type=module -e \
 'import fs from "node:fs"; import crypto from "node:crypto"; const raw=fs.readFileSync("package.json"); if(crypto.createHash("sha256").update(raw).digest("hex")!==process.argv[1] || !fs.existsSync("src/management-command.generated.js") || !fs.existsSync("src/admin-authority.generated.js")) process.exit(1)' \
 "$PACKAGE_SHA256" >"$SECRET_STAGE/image-control.log" 2>&1
oauth_deadline
printf 'PASS image source verified; image and SHA tag retained across windows\n'
)
```

```sh
# step: oauth-apply
# readonly: no
# host: box /bin/bash 5 as root; recreates only oauth
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-apply: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-apply: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
oauth_deadline
test "$(cat "$PROOF_DIR/probes-baseline.txt")" = PASS || fail 'baseline probe receipt required before forward work'
test ! -e "$PROOF_DIR/aborted-before-attempt.txt" && test ! -L "$PROOF_DIR/aborted-before-attempt.txt" || fail 'window aborted; close it before a new window'
test ! -e "$PROOF_DIR/oauth-attempted.txt" && test ! -L "$PROOF_DIR/oauth-attempted.txt" || fail 'release already attempted; recover and close'
oauth_env "$BASELINE_IMAGE"
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" "$NEW_OAUTH/deploy/mcp-auth/compose.yaml"
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" "$NEW_OAUTH/deploy/mcp-auth/compose.management.yaml"
IMAGE=$(cat "$PROOF_DIR/oauth-image.id")
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$RELEASE_SHA"
python3 - "$SECRET_STAGE/compose.env" "$PROOF_DIR/oauth-image.id" "$SECRET_STAGE/compose.new.env" <<'PY'
import pathlib,re,sys
raw=pathlib.Path(sys.argv[1]).read_bytes(); image=pathlib.Path(sys.argv[2]).read_bytes().strip()
if not re.fullmatch(rb'sha256:[0-9a-f]{64}',image) or len(re.findall(rb'^MCP_OAUTH_IMAGE=.*$',raw,re.M))!=1: raise SystemExit('FAIL oauth-apply: baseline image assignment mismatch; STOP')
pathlib.Path(sys.argv[3]).write_bytes(re.sub(rb'^MCP_OAUTH_IMAGE=.*$',b'MCP_OAUTH_IMAGE='+image,raw,flags=re.M))
PY
chmod 0600 "$SECRET_STAGE/compose.new.env"
# Validate the exact switch and GoTrue settings before admission: refusal uses R0.
oauth_service_env validate
oauth_deadline
# Attempt receipt precedes every mutation; an unknown outcome always recovers.
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/oauth-attempted.txt"
# Optional reviewed provider step; null/absent makes no service.env change or settings request.
oauth_service_env apply
oauth_deadline
install -o root -g root -m 0600 "$SECRET_STAGE/compose.new.env" /etc/commonswarm-oauth/compose.env
oauth_compose "$NEW_OAUTH" up -d --no-build --no-deps --pull never --force-recreate oauth >"$SECRET_STAGE/recreate.log" 2>&1
ln -sfT "$NEW_OAUTH" /home/commonswarm/oauth/current.oauth-release
mv -Tf /home/commonswarm/oauth/current.oauth-release /home/commonswarm/oauth/current
oauth_health
oauth_identity "$RELEASE_SHA" "$IMAGE"
oauth_env "$IMAGE"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.new.env"
oauth_service_env forward
oauth_deadline
printf 'PASS\n' >"$PROOF_DIR/applied.txt"
printf 'PASS OAuth image applied and healthy; probes and close still required\n'
)
```

```sh
# step: oauth-probes
# readonly: probe
# host: box /bin/bash 5 as root; local Caddy with verified CA and TLS hostname
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-probes: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-probes: PROOF_DIR required; STOP}" "${PROBE_PHASE:?FAIL oauth-probes: PROBE_PHASE required; STOP}"
. "$PROOF_DIR/session.sh"
case "$PROBE_PHASE" in
 forward) oauth_deadline; test "$(cat "$PROOF_DIR/applied.txt")" = PASS; SHA=$RELEASE_SHA; IMAGE=$(cat "$PROOF_DIR/oauth-image.id");;
 recovery) test "$(cat "$PROOF_DIR/rollback.txt")" = PASS; test -f "$PROOF_DIR/oauth-aside.json"; SHA=${OLD_OAUTH##*/}; IMAGE=$BASELINE_IMAGE;;
 *) fail 'probe phase must be forward or recovery';;
esac
oauth_identity "$SHA" "$IMAGE"
oauth_env "$IMAGE"
oauth_route_probes "$PROBE_PHASE"
if test "$PROBE_PHASE" = forward; then oauth_deadline; fi
printf 'PASS Caddy metadata/JWKS, ordinary MCP 401 without token, local gate closed\n'
)
```

```sh
# step: oauth-abort
# readonly: no
# host: box /bin/bash 5 as root; aborted-before-attempt, no service mutation
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-abort: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-abort: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
test ! -e "$PROOF_DIR/oauth-attempted.txt" && test ! -L "$PROOF_DIR/oauth-attempted.txt" || fail 'attempt present or unknown; use oauth-rollback'
test ! -e "$PROOF_DIR/rollback.txt" && test ! -L "$PROOF_DIR/rollback.txt" || fail 'rollback already run; close as rolled-back'
oauth_env "$BASELINE_IMAGE"
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
oauth_route_probes aborted-before-attempt
printf 'PASS\n' >"$PROOF_DIR/aborted-before-attempt.txt"
printf 'PASS aborted-before-attempt; baseline unchanged, no recreate or rollback; aside and aborted close required\n'
)
```

```sh
# step: oauth-rollback
# readonly: no
# host: box /bin/bash 5 as root; recovery has no deadline
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-rollback: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-rollback: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
test -f "$PROOF_DIR/oauth-attempted.txt" && test ! -L "$PROOF_DIR/oauth-attempted.txt" || fail 'no regular attempt receipt; use oauth-abort if absent, otherwise STOP for HezLead'
# Check snapshots against the measured input hashes BEFORE restoring any byte.
python3 - "$INPUTS_FILE" "$SECRET_STAGE" <<'PY'
import hashlib,json,pathlib,sys
inputs,stage=sys.argv[1:3]; d=json.load(open(inputs))
for kind in ('compose','service'):
    p=pathlib.Path(stage,kind+'.env')
    if not p.is_file() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=d[kind+'_env_sha256']: raise SystemExit('FAIL oauth-rollback: snapshot missing or digest mismatch; STOP')
PY
docker image inspect "$BASELINE_IMAGE" >/dev/null 2>&1
install -o root -g root -m 0600 "$SECRET_STAGE/compose.env" /etc/commonswarm-oauth/compose.env
# Restore the exact checked snapshot BEFORE restarting the baseline image.
# Null/absent selection retains the previous drift refusal and performs no write.
oauth_service_env restore
oauth_env "$BASELINE_IMAGE"
oauth_compose "$OLD_OAUTH" up -d --no-build --no-deps --pull never --force-recreate oauth >"$SECRET_STAGE/rollback.log" 2>&1
ln -sfT "$OLD_OAUTH" /home/commonswarm/oauth/current.oauth-release
mv -Tf /home/commonswarm/oauth/current.oauth-release /home/commonswarm/oauth/current
oauth_health
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
printf 'PASS\n' >"$PROOF_DIR/rollback.txt"
printf 'PASS baseline current, Compose bytes and image restored; aside, probes and close required\n'
)
```

```sh
# step: oauth-release-aside
# readonly: no
# host: box /bin/bash 5 as root; retains failed attempt after baseline recovery
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-release-aside: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-release-aside: PROOF_DIR required; STOP}"
. "$PROOF_DIR/session.sh"
if test -e "$PROOF_DIR/oauth-attempted.txt" || test -L "$PROOF_DIR/oauth-attempted.txt"; then
 test "$(cat "$PROOF_DIR/rollback.txt")" = PASS
else
 test "$(cat "$PROOF_DIR/aborted-before-attempt.txt")" = PASS
fi
oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"
test ! -L /home/commonswarm/oauth/failed-attempts
install -d -o root -g root -m 0700 /home/commonswarm/oauth/failed-attempts
python3 - "$NEW_OAUTH" "$WINDOW_ID" "$PROOF_DIR" <<'PY'
import datetime,json,os,pathlib,sys
new,wid,proof=sys.argv[1:4]; src=pathlib.Path(new); parent=pathlib.Path('/home/commonswarm/oauth/failed-attempts')
dest=parent/(src.name+'-oauth-'+wid); record=pathlib.Path(proof,'oauth-aside.json')
receipt=pathlib.Path(proof,'oauth-tree-created.txt'); created=os.path.lexists(receipt)
def need(ok,label):
    if not ok: raise SystemExit('FAIL oauth-release-aside: '+label+'; STOP')
if created: need(receipt.is_file() and not receipt.is_symlink() and receipt.read_text()==new+'\n','regular tree-created receipt for this window required')
need(parent.stat().st_uid==parent.stat().st_gid==0 and parent.stat().st_mode & 0o777==0o700,'aside parent must be root:root 0700')
if record.exists():
    r=json.loads(record.read_bytes())
    need((not created or not os.path.lexists(src)) and r.get('from')==new and r.get('window_id')==wid and (r.get('moved') is False or (created and r.get('to')==str(dest) and dest.is_dir() and not dest.is_symlink())),'inconsistent completed aside')
    raise SystemExit(0)
moved=created and os.path.lexists(src)
if moved:
    need(src.is_dir() and not src.is_symlink() and src.parent.stat().st_dev==parent.stat().st_dev,'aside must be directory on same filesystem, not symlink')
    need(not os.path.lexists(dest),'aside destination must be absent')
    # Identity check above proves current and the running Compose tree use baseline.
    os.rename(src,dest)
with record.open('x') as f: f.write(json.dumps({'release_sha':src.name,'window_id':wid,'from':new,'to':str(dest) if moved else None,'moved':moved,'at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},sort_keys=True)+'\n')
need(not created or not os.path.lexists(src),'receipt-backed failed tree must be absent from releases')
PY
printf 'PASS receipt-backed tree retained aside or absent; unrecorded trees untouched\n'
)
```

```sh
# step: oauth-close
# readonly: no
# host: box /bin/bash 5 as root; verified success or recovered close only
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-close: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?FAIL oauth-close: PROOF_DIR required; STOP}" "${CLOSE_RESULT:?FAIL oauth-close: CLOSE_RESULT required; STOP}"
. "$PROOF_DIR/session.sh"
case "$CLOSE_RESULT" in
 success)
  oauth_deadline
  test "$(cat "$PROOF_DIR/applied.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-forward.txt")" = PASS
  IMAGE=$(cat "$PROOF_DIR/oauth-image.id")
  oauth_identity "$RELEASE_SHA" "$IMAGE"; oauth_env "$IMAGE"
  cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.new.env";;
 rolled-back)
  test "$(cat "$PROOF_DIR/rollback.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-recovery.txt")" = PASS
  test -f "$PROOF_DIR/oauth-aside.json"
  oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"; oauth_env "$BASELINE_IMAGE"
  cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env";;
 aborted)
  test ! -e "$PROOF_DIR/oauth-attempted.txt" && test ! -L "$PROOF_DIR/oauth-attempted.txt" || fail 'attempt present or unknown; aborted close refused'
  test ! -e "$PROOF_DIR/rollback.txt" && test ! -L "$PROOF_DIR/rollback.txt" || fail 'rollback already run; aborted close refused'
  test "$(cat "$PROOF_DIR/aborted-before-attempt.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-aborted-before-attempt.txt")" = PASS
  test -f "$PROOF_DIR/oauth-aside.json"
  oauth_identity "${OLD_OAUTH##*/}" "$BASELINE_IMAGE"; oauth_env "$BASELINE_IMAGE"
  cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env";;
 *) fail 'close result must be success, rolled-back or aborted';;
esac
if test "$CLOSE_RESULT" != success && { test -e "$PROOF_DIR/oauth-tree-created.txt" || test -L "$PROOF_DIR/oauth-tree-created.txt"; }; then
 test -f "$PROOF_DIR/oauth-tree-created.txt" && test ! -L "$PROOF_DIR/oauth-tree-created.txt" || fail 'regular tree-created receipt required'
 test "$(cat "$PROOF_DIR/oauth-tree-created.txt")" = "$NEW_OAUTH" || fail 'tree-created receipt path mismatch'
 test ! -e "$NEW_OAUTH" && test ! -L "$NEW_OAUTH" || fail 'failed tree remains in releases; run oauth-release-aside'
fi
if test "$CLOSE_RESULT" = success; then oauth_service_env close-success; else oauth_service_env close-recovered; fi
# Guard proof: reject unsafe deletion paths, then validate this exact created root.
python3 - "$SECRET_STAGE" "$PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
stage,record=sys.argv[1:3]
def permitted(name): return re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',name) is not None
for denied in ('','/',str(pathlib.Path.home()),'/tmp/other','/tmp/anvil-secret.abcdef/child','/private/tmp/anvil-secret.abcdef'):
    if permitted(denied): raise SystemExit('FAIL oauth-close: deletion guard negative control failed; STOP')
p=pathlib.Path(stage)
if not (permitted(stage) and pathlib.Path(record).read_text()==stage+'\n' and p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700): raise SystemExit('FAIL oauth-close: unsafe secret stage; STOP')
PY
rm -r -- "$SECRET_STAGE" || { printf 'FAIL oauth-close: rm guard refused %s; retain exact guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE" || fail 'secret stage remains after cleanup'
python3 - "$INPUTS_FILE" "$CLOSE_RESULT" "$PROOF_DIR" <<'PY'
import datetime,json,pathlib,sys
inputs,result,proof=sys.argv[1:4]; p=pathlib.Path(proof); d=json.load(open(inputs))
r={'release_sha':d['release_sha'],'baseline_oauth_sha':d['baseline_oauth_sha'],'baseline_oauth_image':d['baseline_oauth_image'],'result':result,
   'service_env':json.loads((p/'service-env-close.json').read_bytes()),
   'window_id':d['window_id'],'target':d['target'],'opened_at':(p/'opened.txt').read_text().strip(),'closed_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
with (p/'close-result.json').open('x') as f: f.write(json.dumps(r,sort_keys=True)+'\n')
(p/'closed.txt').write_text(r['closed_at']+'\n')
PY
chmod 0600 "$PROOF_DIR/close-result.json" "$PROOF_DIR/closed.txt"
printf 'PASS verified close: %s; nonsecret evidence retained\n' "$CLOSE_RESULT"
)
```

```sh
# step: oauth-copyback
# readonly: no
# host: Mac mini /bin/bash 3.2; curated proof copy-back and guarded scratch cleanup
(
set -euo pipefail
set -E
trap 'printf "FAIL oauth-copyback: line %s; STOP\n" "$LINENO" >&2' ERR
umask 077
: "${BOX_HOST:?FAIL oauth-copyback: BOX_HOST required; STOP}" "${INPUTS_FILE:?FAIL oauth-copyback: local INPUTS_FILE required; STOP}"
# INPUTS_FILE remains the operator's original local JSON, including when archive
# preparation stopped before it created a Mac stage. MAC_STAGE is optional only
# in that branch. Once created, the printed stage path must be supplied here.
RELEASE_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["release_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["window_id"]; assert re.fullmatch("[A-Za-z0-9]{6}",v); print(v)' "$INPUTS_FILE")
PROOF_DIR=/home/commonswarm/oauth/release-proofs/$RELEASE_SHA-$WINDOW_ID
EVIDENCE_DIR=docs/evidence/oauth-release-$RELEASE_SHA-$WINDOW_ID
test ! -e "$EVIDENCE_DIR"
mkdir -m 0700 "$EVIDENCE_DIR"
# Ancestry may be absent after an early archive failure; it stays in box proofs
# when measured. No env, session.sh, stage pointer or diagnostics in copy-back.
for FILE in inputs.json opened.txt close-result.json closed.txt; do
 ssh -n "$BOX_HOST" "sudo -n cat '$PROOF_DIR/$FILE'" >"$EVIDENCE_DIR/$FILE"
done
python3 - "$EVIDENCE_DIR" "$INPUTS_FILE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes()); r=json.loads((p/'close-result.json').read_bytes())
if not (d==json.load(open(sys.argv[2])) and all(r[k]==d[k] for k in ('release_sha','baseline_oauth_sha','baseline_oauth_image','window_id','target')) and r['result'] in ('success','rolled-back','aborted') and (p/'closed.txt').read_text()==r['closed_at']+'\n'): raise SystemExit('FAIL oauth-copyback: bound close record required; STOP')
PY
if test -n "${MAC_STAGE:-}"; then
 # Guard proof includes negative controls before removing only the created root.
 python3 - "$MAC_STAGE" <<'PY'
import pathlib,re,sys
def permitted(name): return re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',name) is not None
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child','/tmp/anvil-secret.abcdef'):
    if permitted(denied): raise SystemExit('FAIL oauth-copyback: deletion guard negative control failed; STOP')
p=pathlib.Path(sys.argv[1])
if not (permitted(str(p)) and p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700): raise SystemExit('FAIL oauth-copyback: unsafe Mac stage; STOP')
PY
 rm -r -- "$MAC_STAGE" || { printf 'FAIL oauth-copyback: rm guard refused %s; retain exact guard message; STOP\n' "$MAC_STAGE" >&2; exit 1; }
 test ! -e "$MAC_STAGE" && test ! -L "$MAC_STAGE" || { printf 'FAIL oauth-copyback: Mac stage remains after cleanup; STOP\n' >&2; exit 1; }
else
 printf 'No Mac stage supplied: valid only if oauth-archive stopped before creating one\n'
fi
printf 'PASS verified close copied to %s; supplied Mac scratch removed\n' "$EVIDENCE_DIR"
)

```

The uploaded archive and ancestry receipt are nonsecret; retain them on the
box for release provenance. The JSON inputs and close record stay 0600. Close
records distinguish success, a measured rollback, and an aborted-before-attempt
window that changed no live OAuth state. The probes
check the three stated routes and the closed gate; they do not claim a fresh
signed-in consent flow. HezLead's exact-SHA server-suite receipt supplies that
separate release gate.
