# Edge-only release after C1 W4

HezLead approves the exact reviewed main SHA, checker receipt, host, deadline
and rollback decision. The assigned release operator runs these blocks. This
plan prepares release inputs; it does not authorize a production operation.
It leaves C1 parked and does not close W5 or reopen admin issuance.

Use complete blocks in a persistent shell. Mac blocks use /bin/bash 3.2;
box blocks use root Bash 5 through sudo -n -i /bin/bash -s. Every block owns a
subshell, disables errexit only in the persistent parent before entering it,
uses ERR inheritance inside it, and stops forward work on FAIL or an unknown
outcome. No secret enters arguments, reports or shell environment. No HOME
assignment, Caddy reload, schema migration, OAuth/stack/site restart or image
pull occurs. Diagnostic output and env copies stay in a private secret stage.
Only one operator and one edge window may be open. A partial open must be
reported with every created path; never assume that a missing PASS means no files.

Before row 0, measure all inputs afresh on the chosen target. HezLead supplies a
mode-0600 checker JSON with exactly release_sha, plan_sha256, archive_sha256,
result (PASS), server_suite (PASS), and meta_regression (PASS). This receipt
must come from the independent checker/CI; the maker does not write it.
Measure the archive from git archive --format=tar at the reviewed SHA; obtain
plan_sha256 from the reviewed document bytes. Set Mac INPUTS_FILE, BOX_HOST,
CHECKER_FILE and PLAN_FILE to absolute local files/the approved SSH host.
Stage identical inputs, checker and plan on the box at absolute paths; row 1
uses INPUTS_FILE, CHECKER_FILE, PLAN_FILE, and CADDY_CA_FILE (the independently
verified public CA for the local Caddy certificate, never a served-chain CA).
Do not use insecure TLS. All rows after open use its printed PROOF_DIR.

Create one JSON with exactly the following keys. No example identity is a
release input. All SHA, image, artifact and date values come from fresh
measurements. JSON fields are strings. The validator below owns the key set.

| Key | Fresh value |
| --- | --- |
| release_sha | Reviewed 40 lowercase hex SHA landed on origin/main |
| archive_sha256 | Exact git archive SHA-256 |
| plan_sha256 | Reviewed EDGE-RELEASE.md SHA-256 |
| checker_sha256 | Independent checker receipt SHA-256 |
| target | production or staging |
| box_hostname | Measured hostname, production yulan-vps-1; staging c1-staging-20261006 |
| window_id | Six alphanumeric characters; staging starts stg, production does not |
| window_end_utc | UTC Z deadline, within 30 minutes of opening |
| rollback_approved | yes, approved by HezLead for this window |
| baseline_edge_sha | Resolved edge/current full SHA |
| baseline_edge_image | Running immutable sha256: image ID |
| baseline_oauth_sha | Resolved oauth/current full SHA |
| baseline_oauth_image | Running immutable OAuth image ID |
| baseline_stack_sha | Resolved stack/current full SHA |
| baseline_site_sha | Site release-name source prefix resolved uniquely against Git history |
| baseline_postgres_image | Running immutable Postgres image ID |
| baseline_site_target | Absolute resolved site/current target under /srv/commonswarm/site/releases/ |
| edge_env_sha256 | /home/commonswarm/.env bytes |
| override_sha256 | Baseline edge compose.override.yaml bytes (2 GiB) |
| caddyfile_sha256 | /etc/caddy/Caddyfile bytes |
| api_caddy_sha256 | /etc/caddy/sites/10-commonswarm-api.caddy bytes |
| mcp_caddy_sha256 | /etc/caddy/sites/20-commonswarm-mcp.caddy bytes |
| caddy_ca_sha256 | Independently verified local TLS CA bytes |
| edge_recycle_timer | Measured commonswarm-edge-recycle.timer |
| edge_recycle_service | Measured commonswarm-edge-recycle.service |
| recycle_unit_sha256 | systemctl cat service bytes including existing drop-in |
| recycle_timer_sha256 | systemctl cat timer bytes, six-hour UTC schedule |
| recycle_hook_sha256 | Installed /usr/local/libexec/commonswarm-admin-edge-recycle bytes |
| recycle_dropin_sha256 | Existing 50-admin-measurement.conf bytes |
| recycle_json_sha256 | Exact baseline recycle.json bytes |
| recycle_archive_sha256 | Retained baseline archive bytes; must match recycle.json artifact_digest |
| baseline_cutover_sha256 | Safe cutover projection produced by edge_db_state below |
| baseline_ledger_sha256 | Ordered migration-version output from edge_db_state |

Staging is snapshot M (post-W4), on c1-staging. Its hostname and regular root:root
0600 /etc/commonswarm-release/STAGING-ONLY marker must match the validator;
marker bytes are exactly c1-staging-disposable-no-production, no newline.
Production requires the marker absent. Do not route a staging probe to the
public production host: every HTTP probe here resolves to local Caddy.
Opening and forward admission use OAuth’s timing rule: do not open within
35 minutes before 03:30/09:30/15:30/21:30 UTC. The window must end strictly
before the next recycle. Recheck before apply.
Recovery has no deadline. Timer ownership starts before any stop and ends on
success, ERR, INT or TERM. An inactive timer forbids every close.

| Row | Step | Host | Condition | Decision |
| --- | --- | --- | --- | --- |
| 0 | edge-root-shell | Mac | Approved files/host | Measure hostname and root Bash access |
| 1 | edge-open | box | Fresh measurements and checker | Validate, snapshot rollback bytes, prove gate/fence and baseline routes |
| 2 | edge-archive | Mac | Open passed | Fetch main, prove ancestry, verify/upload archive and receipt |
| 3 | edge-preflight | box | Archive received | Verify archive; create receipt-backed edge and helper trees |
| 4 | edge-ready | box | Preflight passed | Verify effective env, pinned image, network/memory and closed baseline |
| 5 | edge-apply | box | Ready; deadline valid | Commit close/invalidation, stop guarded timer, switch/recreate, atomically rebind and measure |
| 6 | edge-probes | box | PROBE_PHASE=forward | Local Caddy gate, canonical admin, discovery and public MCP 401 controls |
| 7 | edge-close | box | CLOSE_RESULT=success | Verify active timer, gate/fence, bindings and invariants; record success |
| R0 | edge-abort | box | No attempt receipt, including partial open | Prove baseline unchanged; partial open skips routes and removes its secret stage; no recreation |
| R1 | edge-rollback | box | Attempt or uncertain apply; HezLead directs | Commit invalidation, restore exact binding/hook state and baseline source; remeasure CLOSED |
| R2 | edge-release-aside | box | Baseline live and abort/rollback proven | Move only receipt-backed failed edge/helper trees aside |
| R3 | edge-probes | box | Rollback and aside complete; PROBE_PHASE=recovery; skip after R0 | Verify restored baseline routes; no deadline |
| R4 | edge-close | box | CLOSE_RESULT=rolled-back or aborted | Require recovered proof, active timer and exact baseline bindings |
| 8 | edge-copyback | Mac | Verified close | Copy curated nonsecret receipts and clean Mac scratch through rm guard |

R0 is the only path before an attempt; it never recreates. An aborted window
takes R0 → R2 (record no trees if none were created) → R4 with
CLOSE_RESULT=aborted. R0 records the unchanged-baseline route probes as
probes-aborted-before-attempt.txt; R3 is excluded because no service changed.
R4 requires those probes and repeats them at close. After an attempt,
including a lost switch response, use R1 then R2/R3/R4. Unsafe attempt receipts
STOP for HezLead. Never silently reuse a tree. Retain incomplete incidents and
all archives/helper roots still referenced. After success retain BOTH old and
new artifacts through verified close; this plan also retains them afterward.
No pruning occurs. Same-SHA retry requires a fresh window after recovery/aside.

The archive carries compose.override.yaml. Preflight always replaces the new
edge tree's copy with the measured baseline file, preserving its owner and
mode, and records both hashes and whether the archive already matched in
override.json. The helper tree retains exact archive bytes. The unchanged C1
recycle hook compares live files with the archive; if the override differs,
edge-ready refuses before recreation. HezLead must arrange a reviewed hook
change for that case; copying the baseline alone cannot make it releasable.

Release parents must already exist at their exact absolute paths, resolve to
themselves, be real directories, and have no group/world write bits. The edge
parent may be root-owned or commonswarm-owned (measured commonswarm:0750);
the helper parent stays root-owned (measured root:0700). Each new top-level
tree copies its corresponding baseline tree's root:root 0700 metadata, and
RELEASE_SHA is root:root 0600. Preflight records parent and baseline/new-tree
metadata in tree-layout.json; copyback retains that nonsecret proof.

If open fails before `PASS open`, use R0 → R4 with CLOSE_RESULT=aborted,
including failures before session.sh or database snapshots exist. R0 uses the
early partial-session.sh, requires opened.txt and no open PASS or forward
receipts, verifies the lock and measured baseline files/bindings/containers,
and removes only the recorded secret stage through the rm guard. It records
PROOF_DIR, LOCK and the stage path in partial-open-aborted.json. R2/R3 are
excluded: no release trees or services changed. R4 repeats the partial checks,
requires the stage absent and an active timer, records an aborted close and
releases OPEN. Routes and the database gate remain explicitly unverified; no
route probe can block this recovery. Recovery files are prepared before OPEN
is acquired. A failure while preparing them leaves an unowned proof directory,
without a window lock or secret stage; report that path for HezLead.

The unauthenticated tools/call with params._meta must return HTTP 401 and no
JSON-RPC -32602. Authentication precedes parsing: this proves ingress/auth only.
The independent pre-release meta_regression receipt must cover the parser fix.
After success, HezLead checks tools/call with params._meta using an existing
operator-owned authenticated MCP client, paired with the same call without
_meta; require neither to return -32602. No credential is copied into this
plan. Record the nonsecret outcome separately; the close receipt explicitly
says this authenticated production check is pending, and does not claim it ran.


```sh
# step: edge-root-shell
# readonly: yes
# host: Mac /bin/bash 3.2; approved target via SSH
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-root-shell: line %s; STOP\n" "$LINENO" >&2' ERR
: "${BOX_HOST:?}" "${INPUTS_FILE:?}"
EXPECTED_HOST=$(python3 -c 'import json,re,sys; x=json.load(open(sys.argv[1]))["box_hostname"]; assert re.fullmatch(r"[A-Za-z0-9.-]+",x); print(x)' "$INPUTS_FILE")
test "$(ssh -n "$BOX_HOST" hostname)" = "$EXPECTED_HOST"
ssh -n "$BOX_HOST" 'sudo -n /bin/bash -c '\''test "$(id -u)" = 0 && test "${BASH_VERSINFO[0]}" -ge 5'\'''
printf 'PASS target hostname and root Bash access\n'
)
```

```sh
# step: edge-open
# readonly: no
# host: box root /bin/bash 5; snapshot/read-only database
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-open: line %s; PROOF_DIR=%s; LOCK=%s; SECRET_STAGE=%s; STOP\n" "$LINENO" "${PROOF_DIR:-not-created}" "${LOCK:-not-created}" "${SECRET_STAGE:-not-created}" >&2' ERR
umask 077
test "$(id -u)" = 0
: "${INPUTS_FILE:?}" "${CHECKER_FILE:?}" "${PLAN_FILE:?}" "${CADDY_CA_FILE:?}"
python3 - "$INPUTS_FILE" /etc/commonswarm-release/STAGING-ONLY "$(hostname)" <<'PY'

import datetime,json,os,pathlib,re,stat,sys
name,marker,host=sys.argv[1:4]
def need(ok,label):
    if not ok: raise SystemExit('FAIL edge-open: '+label+'; STOP')
def pairs(rows):
    d={}
    for k,v in rows:
        need(k not in d,'duplicate input key'); d[k]=v
    return d
p=pathlib.Path(name)
need(p.is_absolute() and p.is_file() and not p.is_symlink(),'absolute regular inputs required')
need(stat.S_IMODE(p.stat().st_mode)==0o600,'inputs mode must be 0600')
try: d=json.loads(p.read_bytes(),object_pairs_hook=pairs)
except (ValueError,UnicodeError): raise SystemExit('FAIL edge-open: malformed JSON; STOP') from None
sha_keys={'release_sha','baseline_edge_sha','baseline_oauth_sha','baseline_stack_sha','baseline_site_sha'}
image_keys={'baseline_edge_image','baseline_oauth_image','baseline_postgres_image'}
digest_keys={'archive_sha256','plan_sha256','checker_sha256','edge_env_sha256','override_sha256','caddyfile_sha256','api_caddy_sha256','mcp_caddy_sha256','caddy_ca_sha256','recycle_unit_sha256','recycle_timer_sha256','recycle_hook_sha256','recycle_dropin_sha256','recycle_json_sha256','recycle_archive_sha256','baseline_cutover_sha256','baseline_ledger_sha256'}
keys=sha_keys|image_keys|digest_keys|{'target','box_hostname','window_id','window_end_utc','rollback_approved','baseline_site_target','edge_recycle_timer','edge_recycle_service'}
need(isinstance(d,dict) and set(d)==keys,'exact input keys required')
need(all(isinstance(d[k],str) for k in keys),'all values must be strings')
for k in sha_keys: need(re.fullmatch('[0-9a-f]{40}',d[k]) is not None,k+' full SHA required')
for k in digest_keys: need(re.fullmatch('[0-9a-f]{64}',d[k]) is not None,k+' SHA-256 required')
for k in image_keys: need(re.fullmatch('sha256:[0-9a-f]{64}',d[k]) is not None,k+' immutable image required')
need(d['release_sha']!=d['baseline_edge_sha'],'release must differ from baseline')
need(d['rollback_approved']=='yes','rollback approval required')
need(d['edge_recycle_timer']=='commonswarm-edge-recycle.timer' and d['edge_recycle_service']=='commonswarm-edge-recycle.service','measured recycle unit names required')
need(re.fullmatch(r'/srv/commonswarm/site/releases/[A-Za-z0-9._-]+',d['baseline_site_target']) is not None,'site target required')
need(re.fullmatch('[A-Za-z0-9]{6}',d['window_id']) is not None,'six alnum window required')
need(d['target'] in ('production','staging') and d['box_hostname']==host,'target/hostname mismatch')
m=pathlib.Path(marker)
if d['target']=='staging':
    need(host=='c1-staging-20261006','staging hostname mismatch')
    need(m.is_file() and not m.is_symlink(),'staging marker required')
    s=m.stat(); need(s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'root:root 0600 marker required')
    need(m.read_bytes()==b'c1-staging-disposable-no-production','staging marker content mismatch')
    need(re.match('stg',d['window_id'],re.I) is not None,'staging window required')
else:
    need(host=='yulan-vps-1' and not os.path.lexists(marker),'production host/marker mismatch')
    need(re.match('stg',d['window_id'],re.I) is None,'production refuses staging window')
need(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',d['window_end_utc']) is not None,'UTC Z deadline required')
try: end=datetime.datetime.strptime(d['window_end_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
except ValueError: raise SystemExit('FAIL edge-open: malformed deadline; STOP') from None
now=datetime.datetime.now(datetime.timezone.utc)
need(0<(end-now).total_seconds()<=1800,'window must end within 30 minutes')
recycles=[now.replace(hour=h,minute=30,second=0,microsecond=0)+datetime.timedelta(days=day) for day in (0,1) for h in (3,9,15,21)]
next_recycle=min(t for t in recycles if t>=now)
need((next_recycle-now).total_seconds()>2100,'within 35 minutes before recycle')
need(end<next_recycle,'window end reaches recycle')
print('PASS exact inputs, target and timing')
PY
python3 - "$INPUTS_FILE" "$CHECKER_FILE" "$PLAN_FILE" <<'PY'
import hashlib,json,pathlib,sys
d=json.load(open(sys.argv[1])); c=pathlib.Path(sys.argv[2]); p=pathlib.Path(sys.argv[3])
for f,key in ((c,'checker_sha256'),(p,'plan_sha256')):
 assert f.is_absolute() and f.is_file() and not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==d[key]
r=json.loads(c.read_bytes()); assert set(r)=={'release_sha','plan_sha256','archive_sha256','result','server_suite','meta_regression'}
assert all(r[k]==d[k] for k in ('release_sha','plan_sha256','archive_sha256')) and all(r[k]=='PASS' for k in ('result','server_suite','meta_regression'))
PY
edge_archive_library() { cat <<'ARCHIVE_PY'
import hashlib,json,os,pathlib,re,stat
STATE='/var/lib/commonswarm-admin-release'
ARCHIVES=STATE+'/archives'
KEEPER=['/usr/local/libexec/commonswarm-recycle-archive','/etc/systemd/system/commonswarm-recycle-archive-keep.service','/etc/systemd/system/commonswarm-recycle-archive-keep.timer','/etc/systemd/system/commonswarm-recycle-archive-restore.service','/etc/tmpfiles.d/commonswarm-recycle-archive.conf']
OWNED={'uid':0,'gid':0,'mode':'0o600'}
def need(ok,label):
    if not ok: raise SystemExit('FAIL edge archives: '+label+'; STOP')
def keeper_absent():
    present=[name for name in KEEPER if os.path.lexists(name)]
    need(not present,'keeper files present '+','.join(present))
    return {'keeper_files_present':present}
def identity(st): return st.st_dev,st.st_ino
class Directory:
    # Pin every ancestor from /; no later read/create/fsync resolves those paths again.
    def __init__(self,name,create=False,proof=False):
        need(isinstance(name,str) and name.startswith('/') and os.path.normpath(name)==name and not name.startswith('//'),'canonical non-symlink directory path required')
        self.name=name; self.fds=[]; self.edges=[]; self.proof=proof
        try:
            fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); self.fds.append(fd)
            need(stat.S_ISDIR(os.fstat(fd).st_mode),'directory descriptor required')
            current=''
            for part in pathlib.Path(name).parts[1:]:
                current+='/'+part
                self.check()
                try: child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                except FileNotFoundError:
                    need(create and current in (STATE,ARCHIVES),'canonical non-symlink directory missing')
                    os.mkdir(part,0o700,dir_fd=fd)
                    child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    self.fds.append(child); self.edges.append((fd,part,child,current))
                    os.fchown(child,0,0); os.fchmod(child,0o700); os.fsync(child); os.fsync(fd)
                except OSError: need(False,'canonical non-symlink directory required')
                else:
                    self.fds.append(child); self.edges.append((fd,part,child,current))
                st=os.fstat(child)
                need(stat.S_ISDIR(st.st_mode),'directory descriptor required')
                if current in (STATE,ARCHIVES) or (proof and current==name):
                    need((st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))==(0,0,0o700),'durable/proof directories require root:root 0700')
                fd=child
            self.fd=fd; self.check()
        except BaseException:
            self.close(); raise
    def check(self):
        for parent,part,child,name in self.edges:
            try: live=os.stat(part,dir_fd=parent,follow_symlinks=False)
            except OSError: need(False,'canonical non-symlink directory identity changed')
            st=os.fstat(child)
            need(stat.S_ISDIR(live.st_mode) and identity(live)==identity(st),'canonical non-symlink directory identity changed')
            need(stat.S_ISDIR(st.st_mode),'directory descriptor required')
            if name in (STATE,ARCHIVES) or (self.proof and name==self.name):
                need((st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))==(0,0,0o700),'durable/proof directories require root:root 0700')
    def leaf(self,name,fd):
        self.check()
        try: live=os.stat(name,dir_fd=self.fd,follow_symlinks=False)
        except OSError: need(False,'file pathname identity changed')
        need(stat.S_ISREG(live.st_mode) and identity(live)==identity(os.fstat(fd)),'file pathname identity changed')
    def close(self):
        for fd in reversed(self.fds): os.close(fd)
        self.fds=[]
    def __enter__(self): return self
    def __exit__(self,*unused): self.close()
def directories(create=False): return Directory(ARCHIVES,create=create)
def names(name,sha):
    need(isinstance(sha,str) and re.fullmatch('[0-9a-f]{40}',sha) is not None,'binding SHA required')
    need(isinstance(name,str),'archive name required')
    legacy=re.fullmatch('/tmp/admin-issuance-'+sha+r'-([A-Za-z0-9]{6})\.tar',name)
    durable=re.fullmatch(ARCHIVES+'/'+sha+r'-([A-Za-z0-9]{6})\.tar',name)
    need(legacy is not None or durable is not None,'exact legacy or durable archive name required')
    window=(legacy or durable).group(1)
    return durable is not None,ARCHIVES+'/'+sha+'-'+window+'.tar'
def metadata(fd):
    st=os.fstat(fd)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink==1,'single-link regular archive/proof descriptor required')
    return {'uid':st.st_uid,'gid':st.st_gid,'mode':oct(stat.S_IMODE(st.st_mode))}
def contents(fd):
    os.lseek(fd,0,os.SEEK_SET); chunks=[]
    while True:
        chunk=os.read(fd,1048576)
        if not chunk: break
        chunks.append(chunk)
    return b''.join(chunks)
def read_at(parent,leaf,owned=False,optional=False):
    parent.check()
    try: fd=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent.fd)
    except FileNotFoundError:
        if optional: parent.check(); return None,None
        need(False,'archive/proof file missing')
    except OSError: need(False,'canonical non-symlink archive/proof file required')
    try:
        info=metadata(fd)
        if owned: need(info==OWNED,'durable archive/proof requires root:root 0600')
        body=contents(fd)
        need(metadata(fd)==info,'archive/proof descriptor metadata changed')
        parent.leaf(leaf,fd)
        return body,dict(info,sha256=hashlib.sha256(body).hexdigest(),path=parent.name+'/'+leaf)
    finally: os.close(fd)
def read(name,durable=False):
    p=pathlib.Path(name)
    with Directory(str(p.parent)) as parent:
        if durable: need(str(p.parent)==ARCHIVES,'durable archive parent required')
        return read_at(parent,p.name,owned=durable)
def create_at(parent,leaf,body,want,label):
    need(leaf not in ('','.','..') and '/' not in leaf,'single file component required')
    parent.check()
    # One destination descriptor for writing, verification, metadata and fsync.
    try: fd=os.open(leaf,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=parent.fd)
    except FileExistsError:
        try: fd=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent.fd)
        except OSError: need(False,'canonical non-symlink '+label+' file required')
        created=False
    else: created=True
    try:
        if created:
            parent.leaf(leaf,fd)
            os.fchown(fd,want['uid'],want['gid']); os.fchmod(fd,int(want['mode'],8))
            view=memoryview(body)
            while view:
                size=os.write(fd,view); need(size>0,label+' write failed'); view=view[size:]
        info=metadata(fd); kept=contents(fd)
        need(kept==body and all(info[k]==want[k] for k in ('uid','gid','mode')),'conflicting existing '+label+' bytes or metadata')
        os.fsync(fd); os.fsync(parent.fd)
        need(metadata(fd)==info,'archive/proof descriptor metadata changed')
        parent.leaf(leaf,fd)
        return dict(info,sha256=hashlib.sha256(kept).hexdigest(),path=parent.name+'/'+leaf)
    finally: os.close(fd)
def create_or_equal(name,body,want):
    p=pathlib.Path(name)
    with Directory(str(p.parent)) as parent: return create_at(parent,p.name,body,want,'archive')
def write_proof(proof,name,body):
    # All new helper/receipt bytes use this exclusive no-follow, root:root 0600 writer.
    if isinstance(body,str): body=body.encode()
    if isinstance(proof,Directory): return create_at(proof,name,body,OWNED,'proof')
    with Directory(str(proof),proof=True) as parent: return create_at(parent,name,body,OWNED,'proof')
def receipt(proof,name,value): return write_proof(proof,name,json.dumps(value,sort_keys=True)+'\n')
def promote(name,body):
    keeper_absent()
    p=pathlib.Path(name); need(str(p.parent)==ARCHIVES,'promotion destination must be durable')
    with directories(create=True) as parent: return create_at(parent,p.name,body,OWNED,'archive')
def admit(binding):
    keeper_absent()
    durable,rescue=names(binding['archive'],binding['release_sha'])
    body,record=read(binding['archive'],durable)
    need(record['sha256']==binding['artifact_digest'],'baseline archive digest mismatch')
    return dict(record,durable=durable,rescue=rescue)
def baseline_record(proof):
    with Directory(str(proof),proof=True) as p:
        raw,_=read_at(p,'recycle.baseline.json')
        inputs,_=read_at(p,'inputs.json'); inputs=json.loads(inputs)
        need(hashlib.sha256(raw).hexdigest()==inputs['recycle_json_sha256'],'baseline binding digest mismatch')
        binding=json.loads(raw); baseline,_=read_at(p,'archive-baseline.json',owned=True); baseline=json.loads(baseline)
        durable,name=names(binding['archive'],binding['release_sha'])
        need((baseline['path'],baseline['sha256'],baseline['durable'],baseline['rescue'])==(binding['archive'],binding['artifact_digest'],durable,name),'baseline rescue mapping drift')
        return pathlib.Path(proof),baseline

def rescue(proof):
    with Directory(str(proof),proof=True) as p:
        _,baseline=baseline_record(proof)
        body,record=read(baseline['path'],baseline['durable'])
        need(all(record[k]==baseline[k] for k in record),'baseline archive changed before rescue')
        kept=promote(baseline['rescue'],body)
        receipt(p,'archive-rescue.json',{'legacy':None if baseline['durable'] else baseline['path'],'durable':baseline['rescue'],'sha256':kept['sha256']})
def restore(proof):
    keeper_absent()
    with Directory(str(proof),proof=True) as p:
        _,baseline=baseline_record(proof); durable=baseline['durable']
        previous,_=read_at(p,'archive-restore.json',owned=True,optional=True)
        if previous is not None:
            value=json.loads(previous)
            need(set(value)=={'archive','sha256','restaged'} and value['archive']==baseline['path'] and value['sha256']==baseline['sha256'] and type(value['restaged']) is bool,'restage receipt drift')
            need(previous==(json.dumps(value,sort_keys=True)+'\n').encode(),'restage receipt bytes drift')
        body,record=read(baseline['rescue'],True)
        need(record['sha256']==baseline['sha256'],'durable rescue digest mismatch')
        # Same durable name and admitted legacy uid/gid/mode as C Fix M2; no pathname reopen.
        with Directory(str(pathlib.Path(baseline['path']).parent)) as parent:
            live,record=read_at(parent,pathlib.Path(baseline['path']).name,owned=durable,optional=True)
            missing=live is None
            if not durable: create_at(parent,pathlib.Path(baseline['path']).name,body,baseline,'archive')
        live,record=read(baseline['path'],durable)
        need(live==body and all(record[k]==baseline[k] for k in record),'baseline archive bytes or metadata differ')
        if previous is not None:
            # Verify and retain the first owned receipt byte-for-byte; never rewrite it.
            need(not missing or value['restaged'],'restage receipt no longer describes the restore')
            write_proof(p,'archive-restore.json',previous)
        else: receipt(p,'archive-restore.json',{'archive':baseline['path'],'sha256':record['sha256'],'restaged':missing})
ARCHIVE_PY
}
edge_archive_library | python3 -c 'import json,sys; scope={}; exec(sys.stdin.read(),scope); print(json.dumps(scope["keeper_absent"](),sort_keys=True))'
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
PROOF_DIR=/home/commonswarm/edge/release-proofs/$RELEASE_SHA-$WINDOW_ID
LOCK=/home/commonswarm/edge/release-proofs/OPEN
install -d -o root -g root -m 0700 /home/commonswarm/edge/release-proofs
test ! -e "$PROOF_DIR"
test ! -L "$PROOF_DIR"
test ! -e "$LOCK"
test ! -L "$LOCK"
mkdir -m 0700 "$PROOF_DIR"
printf 'Partial/open proof path: PROOF_DIR=%s\n' "$PROOF_DIR"
install -m 0600 "$INPUTS_FILE" "$PROOF_DIR/inputs.json"
install -m 0600 "$PLAN_FILE" "$PROOF_DIR/plan.md"
install -m 0600 "$CHECKER_FILE" "$PROOF_DIR/checker.json"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/opened.txt"
cat >"$PROOF_DIR/partial-session.sh" <<'PARTIAL_SH'
edge_partial_admit() {
 python3 - "$PROOF_DIR" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes())
assert re.fullmatch('[0-9a-f]{40}',d['release_sha']) and re.fullmatch('[A-Za-z0-9]{6}',d['window_id'])
assert p==pathlib.Path('/home/commonswarm/edge/release-proofs')/(d['release_sha']+'-'+d['window_id'])
assert p.is_dir() and not p.is_symlink() and p.resolve()==p
assert p.stat().st_uid==0 and stat.S_IMODE(p.stat().st_mode)==0o700
for name in ('inputs.json','plan.md','checker.json','opened.txt','partial-session.sh'):
 f=p/name; assert f.is_file() and not f.is_symlink()
assert hashlib.sha256((p/'plan.md').read_bytes()).hexdigest()==d['plan_sha256']
assert hashlib.sha256((p/'checker.json').read_bytes()).hexdigest()==d['checker_sha256']
r=json.loads((p/'checker.json').read_bytes())
assert all(r[k]==d[k] for k in ('release_sha','plan_sha256','archive_sha256'))
assert all(r[k]=='PASS' for k in ('result','server_suite','meta_regression'))
for name in ('open.txt','edge-attempted.txt','preflight.txt','ready.txt','applied.txt','rollback.txt','closed.txt','close-result.json','edge-tree-created.json','helper-tree-created.json'):
 assert not os.path.lexists(p/name), 'FAIL partial-open forward/terminal receipt; STOP'
lock=p.parent/'OPEN'
assert lock.is_dir() and not lock.is_symlink() and lock.resolve()==lock
f=lock/'proof.path'; assert f.is_file() and not f.is_symlink() and f.read_text()==str(p)+'\n'
for root in ('/home/commonswarm/edge/releases/','/home/commonswarm/admin-issuance/releases/'):
 assert not os.path.lexists(root+d['release_sha']), 'FAIL partial-open release tree exists; STOP'
PY
}
edge_partial_baseline() {
 # Read-only host checks; no DB connection, HTTP, service stop/start or recreation.
 python3 - "$PROOF_DIR/inputs.json" <<'PY'
import hashlib,json,pathlib,subprocess,sys
d=json.load(open(sys.argv[1]))
def digest(name,key):
 p=pathlib.Path(name); assert p.is_file() and not p.is_symlink()
 assert hashlib.sha256(p.read_bytes()).hexdigest()==d[key], 'FAIL partial-open baseline drift; STOP'
for surface in ('edge','oauth','stack'):
 assert str(pathlib.Path('/home/commonswarm/'+surface+'/current').resolve(strict=True))=='/home/commonswarm/'+surface+'/releases/'+d['baseline_'+surface+'_sha']
assert str(pathlib.Path('/srv/commonswarm/site/current').resolve(strict=True))==d['baseline_site_target']
for name,key in [('/home/commonswarm/.env','edge_env_sha256'),('/home/commonswarm/edge/current/deploy/edge-runtime/compose.override.yaml','override_sha256'),('/etc/caddy/Caddyfile','caddyfile_sha256'),('/etc/caddy/sites/10-commonswarm-api.caddy','api_caddy_sha256'),('/etc/caddy/sites/20-commonswarm-mcp.caddy','mcp_caddy_sha256'),('/etc/commonswarm-admin-release/recycle.json','recycle_json_sha256'),('/usr/local/libexec/commonswarm-admin-edge-recycle','recycle_hook_sha256'),('/etc/systemd/system/'+d['edge_recycle_service']+'.d/50-admin-measurement.conf','recycle_dropin_sha256')]: digest(name,key)
for unit,key in [(d['edge_recycle_timer'],'recycle_timer_sha256'),(d['edge_recycle_service'],'recycle_unit_sha256')]:
 assert hashlib.sha256(subprocess.check_output(['systemctl','cat',unit])).hexdigest()==d[key]
subprocess.run(['systemctl','is-active','--quiet',d['edge_recycle_timer']],check=True)
assert subprocess.check_output(['systemctl','show','-p','ActiveState','--value',d['edge_recycle_service']],text=True).strip()=='inactive'
for name,key in [('commonswarm-edge-edge-runtime-1','baseline_edge_image'),('commonswarm-oauth-oauth-1','baseline_oauth_image'),('commonswarm-postgres','baseline_postgres_image')]:
 c=json.loads(subprocess.check_output(['docker','inspect',name],stderr=subprocess.DEVNULL))[0]
 assert c['Image']==d[key] and c['State']['Running']
 if name=='commonswarm-edge-edge-runtime-1':
  assert c['State']['Health']['Status']=='healthy'
  assert c['Config']['Labels']['com.docker.compose.project.working_dir']=='/home/commonswarm/edge/releases/'+d['baseline_edge_sha']+'/deploy/edge-runtime'
PY
}
edge_partial_stage() {
 # Print only a validated nonsecret path; a missing pointer means no stage existed.
 python3 - "$PROOF_DIR/secret-stage.path" "$1" <<'PY'
import os,pathlib,re,stat,sys
p=pathlib.Path(sys.argv[1]); mode=sys.argv[2]
if not os.path.lexists(p): raise SystemExit
assert p.is_file() and not p.is_symlink()
name=p.read_text(); assert name.endswith('\n') and name.count('\n')==1
name=name[:-1]
def permitted(x): return re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',x) is not None
for bad in ('','/',str(pathlib.Path.home()),'/tmp/other','/tmp/anvil-secret.abcdef/child'): assert not permitted(bad)
assert permitted(name), 'FAIL partial-open unsafe stage; STOP'
s=pathlib.Path(name)
if mode=='cleanup':
 if os.path.lexists(s): assert s.is_dir() and not s.is_symlink() and s.resolve()==s and s.stat().st_uid==0 and stat.S_IMODE(s.stat().st_mode)==0o700
else:
 assert mode=='absent' and not os.path.lexists(s), 'FAIL partial-open secret stage remains; STOP'
print(name)
PY
}
PARTIAL_SH
# Bootstrap the helper through its own pinned, exclusive proof writer.
edge_archive_library | python3 -c 'import sys; body=sys.stdin.read(); scope={}; exec(body,scope); scope["write_proof"](sys.argv[1],"edge-archives.py",body)' "$PROOF_DIR"
mkdir -m 0700 "$LOCK" # Existing incident lock forbids another window.
printf '%s\n' "$PROOF_DIR" >"$LOCK/proof.path"
SECRET_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
printf '%s\n' "$SECRET_STAGE" >"$PROOF_DIR/secret-stage.path"
python3 - "$PROOF_DIR" "$SECRET_STAGE" "$CADDY_CA_FILE" <<'PY'
import datetime,hashlib,importlib.util,json,pathlib,re,shlex,stat,subprocess,sys
p=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('edge_archives',p/'edge-archives.py'); archives=importlib.util.module_from_spec(spec); spec.loader.exec_module(archives)
archives.receipt(p,'keeper.json',archives.keeper_absent())
p=pathlib.Path(sys.argv[1]); stage=pathlib.Path(sys.argv[2]); d=json.load(open(p/'inputs.json'))
def safe(name):
 f=pathlib.Path(name); assert f.is_file() and not f.is_symlink(); return f.read_bytes()
ca=pathlib.Path(sys.argv[3]); assert ca.is_absolute(); raw=safe(ca)
assert hashlib.sha256(raw).hexdigest()==d['caddy_ca_sha256']; (p/'caddy-ca.pem').write_bytes(raw)
edge='/home/commonswarm/edge/releases/'+d['baseline_edge_sha']; new='/home/commonswarm/edge/releases/'+d['release_sha']
helper='/home/commonswarm/admin-issuance/releases/'+d['release_sha']
assert not pathlib.Path(new).exists() and not pathlib.Path(new).is_symlink()
assert not pathlib.Path(helper).exists() and not pathlib.Path(helper).is_symlink()
files=[('/home/commonswarm/.env','edge.env','edge_env_sha256'),(edge+'/deploy/edge-runtime/compose.override.yaml','override.yaml','override_sha256'),('/etc/caddy/Caddyfile','Caddyfile','caddyfile_sha256'),('/etc/caddy/sites/10-commonswarm-api.caddy','api.caddy','api_caddy_sha256'),('/etc/caddy/sites/20-commonswarm-mcp.caddy','mcp.caddy','mcp_caddy_sha256')]
for name,out,key in files:
 raw=safe(name); assert hashlib.sha256(raw).hexdigest()==d[key]; (stage/out).write_bytes(raw)
for name,out in [('compose','oauth.compose.env'),('service','oauth.service.env')]: (stage/out).write_bytes(safe('/etc/commonswarm-oauth/'+name+'.env'))
hook='/usr/local/libexec/commonswarm-admin-edge-recycle'; drop='/etc/systemd/system/'+d['edge_recycle_service']+'.d/50-admin-measurement.conf'; config='/etc/commonswarm-admin-release/recycle.json'
for name,out,key,mode in [(hook,'hook.baseline','recycle_hook_sha256',0o700),(drop,'dropin.baseline','recycle_dropin_sha256',0o644),(config,'recycle.baseline.json','recycle_json_sha256',0o600)]:
 f=pathlib.Path(name); raw=safe(name); s=f.stat(); assert s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==mode
 assert hashlib.sha256(raw).hexdigest()==d[key]; (p/out).write_bytes(raw)
r=json.loads((p/'recycle.baseline.json').read_bytes())
assert set(r)=={'release_sha','target','image_digest','artifact_digest','archive','postgres_image','release_root'}
assert r['release_sha']==d['baseline_edge_sha'] and r['target']==edge and r['image_digest']==d['baseline_edge_image'] and r['postgres_image']==d['baseline_postgres_image']
assert r['artifact_digest']==d['recycle_archive_sha256']
archive_baseline=archives.admit(r)
archives.receipt(p,'archive-baseline.json',archive_baseline)
assert r['release_root']=='/home/commonswarm/admin-issuance/releases/'+r['release_sha'] and pathlib.Path(r['release_root']).resolve()==pathlib.Path(r['release_root'])
for unit,out,key in [(d['edge_recycle_service'],'unit.baseline','recycle_unit_sha256'),(d['edge_recycle_timer'],'timer.baseline','recycle_timer_sha256')]:
 raw=subprocess.check_output(['systemctl','cat',unit]); assert hashlib.sha256(raw).hexdigest()==d[key]; (p/out).write_bytes(raw)
intent=pathlib.Path('/etc/commonswarm-admin-release/recycle-intent.json')
if intent.exists() or intent.is_symlink():
 raw=safe(intent); st=intent.stat(); assert st.st_uid==st.st_gid==0 and stat.S_IMODE(st.st_mode)==0o600
 value=json.loads(raw); assert value.get('reopen') is False, 'FAIL retained reopen intent; STOP'
 (p/'intent.baseline.json').write_bytes(raw)
else: (p/'intent.absent').write_text('absent\n')
unit=(p/'unit.baseline').read_text(); timer=(p/'timer.baseline').read_text()
assert 'ExecStartPre='+hook+' before' in unit and 'ExecStartPost='+hook+' after' in unit
assert 'Persistent=false' in timer and 'OnCalendar=*-*-* 03,09,15,21:30:00 UTC' in timer, 'FAIL measured timer schedule needs review; STOP'
resources={}
for name,key in [('commonswarm-oauth-oauth-1','baseline_oauth_image'),('commonswarm-postgres','baseline_postgres_image')]:
 c=json.loads(subprocess.check_output(['docker','inspect',name],stderr=subprocess.DEVNULL))[0]
 assert c['Image']==d[key] and c['State']['Running']; resources[name]={'Id':c['Id'],'Image':c['Image'],'StartedAt':c['State']['StartedAt']}
(p/'resources.json').write_text(json.dumps(resources,sort_keys=True)+'\n')
v={'PROOF_DIR':str(p),'SECRET_STAGE':str(stage),'INPUTS_FILE':str(p/'inputs.json'),'CADDY_CA_FILE':str(p/'caddy-ca.pem'),'RELEASE_SHA':d['release_sha'],'WINDOW_ID':d['window_id'],'OLD_EDGE':edge,'NEW_EDGE':new,'OLD_HELPER':r['release_root'],'NEW_HELPER':helper,'OLD_ARCHIVE':r['archive'],'OLD_ARCHIVE_DIGEST':r['artifact_digest'],'BOX_ARCHIVE_PATH':'/tmp/admin-issuance-'+d['release_sha']+'-'+d['window_id']+'.tar','DURABLE_ARCHIVE_PATH':archives.ARCHIVES+'/'+d['release_sha']+'-'+d['window_id']+'.tar','POSTGRES_IMAGE':d['baseline_postgres_image'],'EDGE_RECYCLE_TIMER':d['edge_recycle_timer'],'EDGE_RECYCLE_SERVICE':d['edge_recycle_service'],'RECYCLE_JSON':config,'RECYCLE_HOOK':hook,'RECYCLE_DROPIN':drop,'LOCK':str(p.parent/'OPEN')}
(p/'session.sh').write_text(''.join(k+'='+shlex.quote(val)+'\n' for k,val in v.items()))
PY
cat >>"$PROOF_DIR/session.sh" <<'SH'

umask 077
unset NODE_OPTIONS COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
fail() { printf 'FAIL edge release: %s; STOP\n' "$1" >&2; exit 1; }
edge_admit() {
 test -f "$PROOF_DIR/open.txt"
 test ! -L "$PROOF_DIR/open.txt"
 test ! -e "$PROOF_DIR/closed.txt"
 test ! -L "$PROOF_DIR/closed.txt"
 test ! -e "$PROOF_DIR/close-result.json"
 test ! -L "$PROOF_DIR/close-result.json"
 python3 - "$INPUTS_FILE" "$PROOF_DIR/plan.md" <<'PY'
import hashlib,json,pathlib,sys
assert hashlib.sha256(pathlib.Path(sys.argv[2]).read_bytes()).hexdigest()==json.load(open(sys.argv[1]))['plan_sha256'], 'FAIL reviewed plan bytes changed; STOP'
PY
}
edge_forward_admit() {
 edge_admit
 test ! -e "$PROOF_DIR/aborted-before-attempt.txt"
 test ! -L "$PROOF_DIR/aborted-before-attempt.txt"
 test ! -e "$PROOF_DIR/rollback.txt"
 test ! -L "$PROOF_DIR/rollback.txt"
}
edge_deadline() {
 python3 - "$INPUTS_FILE" "$PROOF_DIR/opened.txt" <<'PY'
import datetime,json,pathlib,sys
d=json.load(open(sys.argv[1])); end=datetime.datetime.fromisoformat(d['window_end_utc'].replace('Z','+00:00'))
start=datetime.datetime.fromisoformat(pathlib.Path(sys.argv[2]).read_text().strip().replace('Z','+00:00'))
now=datetime.datetime.now(datetime.timezone.utc)
assert start<=now<end, 'FAIL edge deadline or backwards clock; STOP'
# Revalidate the OPEN time, not a new opening at each forward step. A valid
# window may continue inside the 35-minute margin, but must end before :30.
recycles=[start.replace(hour=h,minute=30,second=0,microsecond=0)+datetime.timedelta(days=day) for day in (0,1) for h in (3,9,15,21)]
next_recycle=min(t for t in recycles if t>=start)
assert (next_recycle-start).total_seconds()>2100, 'FAIL within 35 minutes before recycle; STOP'
assert 0<(end-start).total_seconds()<=1800, 'FAIL window must end within 30 minutes; STOP'
assert end<next_recycle, 'FAIL window end reaches recycle; STOP'
PY
}
edge_db() {
 # Only owned nonsecret SQL command/file. No SQL on stdin (no docker -i).
 local args=("$@") count=0
 while test $# -gt 0; do
  case "$1" in
   -q|-Atq) shift;;
   --command) test $# -ge 2; test -n "$2"; count=$((count+1)); shift 2;;
   --file) test $# -ge 2; [[ "$2" =~ ^/(proof|release)/[A-Za-z0-9/_.-]+\.sql$ ]]; count=$((count+1)); shift 2;;
   *) fail 'unsupported database arguments';;
  esac
 done
 test "$count" -gt 0
 docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
  --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$SECRET_STAGE/service.conf:/run/service.conf:ro" --volume "$SECRET_STAGE/pass:/run/pass:ro" \
  --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
  --volume "$PROOF_DIR:/proof:ro" --volume "$OLD_HELPER:/release:ro" \
  --entrypoint psql "$POSTGRES_IMAGE" -X --set=ON_ERROR_STOP=1 "${args[@]}" 2>"$SECRET_STAGE/db.log"
}
edge_ro() { edge_db --command 'SET default_transaction_read_only=on;' "$@"; }
edge_fence() {
 test "$(edge_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND legacy_closed AND legacy_closed_at IS NOT NULL AND legacy_fence_evidence_ref IS NOT NULL AND auth_contract_version=2 FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
 test "$(edge_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
 # Full apply_legacy_admin_fence + guard_cutover_state contract from
 # supabase/migrations/20261003000003_admin_oauth_cutover.sql. Effective
 # privileges for every revoked role also include any PUBLIC grant. Check all
 # table privileges (PG17) and column privileges; report only one boolean.
 test "$(edge_ro -Atq --command "WITH revoked_roles(role_name) AS (
 SELECT 'anon' UNION ALL SELECT 'authenticated' UNION ALL SELECT 'swarm_read'
 UNION ALL SELECT 'swarm_command' UNION ALL SELECT 'commonswarm_oauth_runtime'
 ) SELECT
 NOT EXISTS(SELECT 1 FROM swarm.admin_credentials WHERE revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active')
 AND EXISTS(SELECT 1 FROM pg_class WHERE oid='swarm.admin_credentials'::regclass AND relrowsecurity AND relforcerowsecurity)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='swarm.admin_credentials'::regclass)
 AND NOT EXISTS(SELECT 1 FROM revoked_roles WHERE
 has_table_privilege(role_name,'swarm.admin_credentials','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
 OR has_any_column_privilege(role_name,'swarm.admin_credentials','SELECT,INSERT,UPDATE,REFERENCES'));")" = t
}
edge_invalidate() {
 # Same committed transaction as W4. Independent readback precedes mutation.
 edge_db -q --command 'BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;' >/dev/null
 test "$(edge_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t || fail 'invalidation not confirmed; issuance state UNKNOWN'
}
edge_db_state() {
 local prefix=$1 grant
 edge_ro -Atq --command "SELECT row_to_json(x) FROM (SELECT admin_issuance_enabled,legacy_closed,auth_contract_version,approved_edge_release_sha,measured_edge_release_sha,measured_edge_target,measured_mount,measured_image_digest,measured_artifact_digest,release_generation,measured_generation,invalidated_at FROM commonswarm_oauth.admin_cutover_state WHERE singleton) x;" >"$prefix.cutover.json"
 edge_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$prefix.ledger.txt"
 # No customer rows. Preserve exact role attributes/memberships, including absence.
 edge_ro -Atq --command "SELECT row_to_json(x) FROM (SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('commonswarm_edge','commonswarm_oauth_runtime','commonswarm_admin_issuer') ORDER BY rolname) x; SELECT row_to_json(x) FROM (SELECT parent.rolname AS parent,child.rolname AS member,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE child.rolname IN ('commonswarm_edge','commonswarm_admin_issuer') ORDER BY child.rolname,parent.rolname) x;" >"$prefix.catalog.txt"
 grant=$(edge_ro -Atq --command "SELECT count(*) FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole;")
 case "$grant" in
  0) :;;
  1) test "$(edge_ro -Atq --file /release/deploy/release-proofs/item-ai/edge-oauth-runtime-catalog.sql --command '\echo :catalog_ok')" = t || fail 'W6 runtime catalog refused';;
  *) fail 'runtime grant count refused';;
 esac
}
edge_timer_active() { systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || fail 'recycle timer inactive; close forbidden'; }
edge_timer_recover() {
 systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL timer recovery start; STOP\n' >&2; return 1; }
 systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL timer recovery inactive; STOP\n' >&2; return 1; }
}
edge_timer_guard() {
 edge_timer_exit() {
  local status=$1 recovered
  trap - EXIT INT TERM
  set +e
  ( set -eEuo pipefail; edge_timer_recover )
  recovered=$?
  if test "$recovered" -ne 0; then printf 'FAIL timer recovery; incident remains open; STOP\n' >&2; exit 1; fi
  exit "$status"
 }
 trap 'edge_timer_exit "$?"' EXIT
 trap 'exit 130' INT
 trap 'exit 143' TERM
}
edge_switch() {
 local target=$1 link=/home/commonswarm/edge/current.edge-release
 test ! -e "$link"
 test ! -L "$link"
 ln -s "$target" "$link"
 mv -Tf "$link" /home/commonswarm/edge/current
}
edge_compose() (
 local tree=$1 name keys; shift
 keys=$(python3 -c 'import pathlib,re,sys; print(" ".join(sorted({k for f in sys.argv[1:] for k in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)",pathlib.Path(f).read_text())})))' "$tree/deploy/edge-runtime/compose.yaml" "$tree/deploy/edge-runtime/compose.override.yaml")
 for name in $keys; do unset "$name"; done
 COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
 docker compose --project-name commonswarm-edge --env-file /home/commonswarm/.env \
  -f "$tree/deploy/edge-runtime/compose.yaml" -f "$tree/deploy/edge-runtime/compose.override.yaml" "$@"
)
edge_recreate() {
 edge_compose "$1" up -d --no-build --pull never --force-recreate edge-runtime >"$SECRET_STAGE/recreate.log" 2>&1
 timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
}
edge_identity() {
 python3 - "$1" "$INPUTS_FILE" <<'PY'
import json,pathlib,subprocess,sys
target=sys.argv[1]; d=json.load(open(sys.argv[2])); assert str(pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True))==target
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
assert c['Image']==d['baseline_edge_image'] and c['State']['Health']['Status']=='healthy'
assert c['Config']['Labels']['com.docker.compose.project.working_dir']==target+'/deploy/edge-runtime'
assert c['Config']['Labels']['com.docker.compose.project.config_files']==target+'/deploy/edge-runtime/compose.yaml,'+target+'/deploy/edge-runtime/compose.override.yaml'
assert c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648
for dst,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src'),('/home/deno/deploy/bootstrap.sh','deploy/edge-runtime/bootstrap.sh'),('/home/deno/deploy/h0-deno.json','deploy/edge-runtime/h0-deno.json')]:
 m=[m for m in c['Mounts'] if m['Destination']==dst]
 assert len(m)==1 and m[0]['Source']==target+'/'+rel and m[0]['RW'] is False
PY
}
edge_archives() {
 python3 - "$1" "$PROOF_DIR" "$DURABLE_ARCHIVE_PATH" "$INPUTS_FILE" <<'PY'
import importlib.util,json,pathlib,sys
mode,proof,name,inputs=sys.argv[1:]; p=pathlib.Path(proof)
spec=importlib.util.spec_from_file_location('edge_archives',p/'edge-archives.py'); a=importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
a.keeper_absent()
if mode=='restore': a.restore(proof)
else:
 assert mode=='ready'
 d=json.load(open(inputs)); durable,expected=a.names(name,d['release_sha']); assert durable and name==expected
 body,record=a.read(name,True); a.need(record['sha256']==d['archive_sha256'],'promoted archive digest mismatch')
 _,baseline=a.baseline_record(proof)
 body,record=a.read(baseline['rescue'],True); a.need(record['sha256']==baseline['sha256'],'rescue archive digest mismatch')
PY
}
edge_binding() {
 # Bind the verified durable promotion, or restore exact baseline JSON after archive restaging.
 # No hook/drop-in change; E never installs, runs or retires the keeper.
 case "$1" in apply) edge_archives ready;; restore) edge_archives restore;; *) fail 'binding mode refused';; esac
 python3 - "$1" "$INPUTS_FILE" "$PROOF_DIR" "$RECYCLE_JSON" "$NEW_HELPER" "$DURABLE_ARCHIVE_PATH" <<'PY'
import hashlib,json,os,pathlib,stat,sys,tempfile
mode,inputs,proof,name,helper,archive=sys.argv[1:]; d=json.load(open(inputs)); p=pathlib.Path(proof); dest=pathlib.Path(name)
def regular(x):
 assert x.is_file() and not x.is_symlink()
 return x.read_bytes()
baseline=regular(p/'recycle.baseline.json'); assert hashlib.sha256(baseline).hexdigest()==d['recycle_json_sha256']
old=json.loads(baseline); new=dict(old,release_sha=d['release_sha'],target='/home/commonswarm/edge/releases/'+d['release_sha'],image_digest=d['baseline_edge_image'],artifact_digest=d['archive_sha256'],archive=archive,release_root=helper)
newbytes=(json.dumps(new,sort_keys=True)+'\n').encode()
current=regular(dest); assert current in (baseline,newbytes), 'FAIL unrelated recycle.json drift; STOP'
assert mode in ('apply','restore'); data=newbytes if mode=='apply' else baseline
s=dest.stat(); assert s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600
fd,tmp=tempfile.mkstemp(prefix='.recycle.edge-',dir=str(dest.parent))
# Keep a failed temp rather than unguarded deletion; its nonsecret path is reported.
try:
 with os.fdopen(fd,'wb') as f:
  os.fchmod(f.fileno(),0o600); os.fchown(f.fileno(),0,0); f.write(data); f.flush(); os.fsync(f.fileno())
 assert regular(dest)==current, 'FAIL binding race; STOP'
 os.replace(tmp,dest)
 directory=os.open(str(dest.parent),os.O_RDONLY); os.fsync(directory); os.close(directory)
 assert regular(dest)==data
except BaseException:
 print('FAIL atomic binding; retained temporary path '+tmp+'; STOP',file=sys.stderr); raise
(p/('binding-'+mode+'.json')).write_text(json.dumps({'sha256':hashlib.sha256(data).hexdigest(),'release_sha':json.loads(data)['release_sha']},sort_keys=True)+'\n')
PY
}
edge_measure() {
 # Fresh measurement, never restore an old generation. Existing fence stays set.
 python3 - "$1" "$RECYCLE_JSON" "$PROOF_DIR/measure.sql" "$WINDOW_ID" <<'PY'
import json,pathlib,re,sys
sha,name,out,wid=sys.argv[1:]; r=json.load(open(name))
assert re.fullmatch('[0-9a-f]{40}',sha) and r['release_sha']==sha
for k in ('artifact_digest',): assert re.fullmatch('[0-9a-f]{64}',r[k])
assert re.fullmatch('sha256:[0-9a-f]{64}',r['image_digest'])
target='/home/commonswarm/edge/releases/'+sha; assert r['target']==target
sql="BEGIN; DO $$ BEGIN IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksum_failures()) OR NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND legacy_closed AND auth_contract_version=2 AND NOT admin_issuance_enabled AND invalidated_at IS NOT NULL) THEN RAISE EXCEPTION 'edge measurement refused'; END IF; END $$; SET LOCAL ROLE commonswarm_admin_release; "
sql+="UPDATE commonswarm_oauth.admin_cutover_state SET approved_edge_release_sha='"+sha+"',measured_edge_release_sha='"+sha+"',measured_edge_target='"+target+"',measured_mount='"+target+"',measured_image_digest='"+r['image_digest']+"',measured_artifact_digest='"+r['artifact_digest']+"',measured_generation=release_generation,measured_at=statement_timestamp(),measurement_evidence_ref='EDGE/"+wid+"',invalidated_at=NULL,admin_issuance_enabled=false WHERE singleton; COMMIT;\n"
pathlib.Path(out).write_text(sql)
PY
 edge_db -q --file /proof/measure.sql >/dev/null
 edge_readback "$1"
}
edge_readback() {
 local sha=$1
 test "$(edge_ro -Atq --command "SELECT NOT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation AND approved_edge_release_sha='$sha' AND measured_edge_release_sha='$sha' AND measured_edge_target='/home/commonswarm/edge/releases/$sha' AND measured_mount=measured_edge_target FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t
 edge_ro -Atq --command 'SELECT row_to_json(x) FROM (SELECT approved_edge_release_sha,measured_edge_release_sha,measured_image_digest,measured_artifact_digest FROM commonswarm_oauth.admin_cutover_state WHERE singleton) x;' >"$PROOF_DIR/measurement-readback.json"
 python3 - "$RECYCLE_JSON" "$PROOF_DIR/measurement-readback.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); m=json.load(open(sys.argv[2]))
assert m['approved_edge_release_sha']==m['measured_edge_release_sha']==r['release_sha']
assert m['measured_image_digest']==r['image_digest'] and m['measured_artifact_digest']==r['artifact_digest']
PY
 edge_fence
}
edge_tree_check() {
 local role=helper
 case "$1" in "$OLD_EDGE"|"$NEW_EDGE") role=edge;; "$OLD_HELPER"|"$NEW_HELPER") ;; *) fail 'unknown release tree';; esac
 python3 - "$1" "$2" "$3" "$INPUTS_FILE" "$role" <<'PY'
import hashlib,pathlib,sys,tarfile
root,archive,digest,inputs,role=sys.argv[1:]; p=pathlib.Path(root); a=pathlib.Path(archive)
assert p.is_dir() and not p.is_symlink() and a.is_file() and not a.is_symlink()
assert hashlib.sha256(a.read_bytes()).hexdigest()==digest
override='deploy/edge-runtime/compose.override.yaml'
if role=='edge':
 import json
 f=p/override; assert f.is_file() and not f.is_symlink()
 assert hashlib.sha256(f.read_bytes()).hexdigest()==json.load(open(inputs))['override_sha256'], 'FAIL baseline override digest differs; STOP'
names=set()
with tarfile.open(a) as t:
 for m in t.getmembers():
  q=pathlib.PurePosixPath(m.name); assert not q.is_absolute() and '..' not in q.parts and q.as_posix() not in names; names.add(q.as_posix())
  f=p/m.name
  if m.isfile():
   assert f.is_file() and not f.is_symlink()
   if role!='edge' or q.as_posix()!=override: assert f.read_bytes()==t.extractfile(m).read()
  elif m.issym(): assert f.is_symlink() and f.readlink().as_posix()==m.linkname
  else: assert m.isdir() and f.is_dir() and not f.is_symlink()
actual={str(f.relative_to(p)) for f in p.rglob('*')}
expected=names|{'RELEASE_SHA'}
if role=='edge': expected.add(override)
assert actual==expected, 'FAIL extra/missing release files; STOP'
marker=p/'RELEASE_SHA'; assert marker.is_file() and not marker.is_symlink() and marker.read_text()==p.name+'\n'
PY
}
edge_invariants() {
 cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
 cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/oauth.compose.env"
 cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/oauth.service.env"
 cmp -s "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" "$SECRET_STAGE/override.yaml"
 cmp -s /etc/caddy/Caddyfile "$SECRET_STAGE/Caddyfile"
 cmp -s /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.caddy"
 cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy"
 cmp -s "$RECYCLE_HOOK" "$PROOF_DIR/hook.baseline"
 cmp -s "$RECYCLE_DROPIN" "$PROOF_DIR/dropin.baseline"
 python3 - "$PROOF_DIR" "$RECYCLE_HOOK" "$RECYCLE_DROPIN" <<'PY'
import pathlib,stat,sys
p=pathlib.Path(sys.argv[1]); intent=pathlib.Path('/etc/commonswarm-admin-release/recycle-intent.json')
for name,mode in [(sys.argv[2],0o700),(sys.argv[3],0o644)]:
 f=pathlib.Path(name); assert f.is_file() and not f.is_symlink()
 st=f.stat(); assert st.st_uid==st.st_gid==0 and stat.S_IMODE(st.st_mode)==mode
if (p/'intent.absent').exists(): assert not intent.exists() and not intent.is_symlink()
else:
 assert intent.is_file() and not intent.is_symlink() and intent.read_bytes()==(p/'intent.baseline.json').read_bytes()
 st=intent.stat(); assert st.st_uid==st.st_gid==0 and stat.S_IMODE(st.st_mode)==0o600
PY
 systemctl cat "$EDGE_RECYCLE_SERVICE" >"$PROOF_DIR/unit.now"
 systemctl cat "$EDGE_RECYCLE_TIMER" >"$PROOF_DIR/timer.now"
 cmp -s "$PROOF_DIR/unit.now" "$PROOF_DIR/unit.baseline"
 cmp -s "$PROOF_DIR/timer.now" "$PROOF_DIR/timer.baseline"
 edge_db_state "$PROOF_DIR/now"
 cmp -s "$PROOF_DIR/now.ledger.txt" "$PROOF_DIR/baseline.ledger.txt"
 cmp -s "$PROOF_DIR/now.catalog.txt" "$PROOF_DIR/baseline.catalog.txt"
 python3 - "$PROOF_DIR/resources.json" "$INPUTS_FILE" <<'PY'
import json,pathlib,subprocess,sys
d=json.load(open(sys.argv[2])); baseline=json.load(open(sys.argv[1]))
for link in ('oauth','stack'):
 assert str(pathlib.Path('/home/commonswarm/'+link+'/current').resolve(strict=True))=='/home/commonswarm/'+link+'/releases/'+d['baseline_'+link+'_sha']
assert str(pathlib.Path('/srv/commonswarm/site/current').resolve(strict=True))==d['baseline_site_target']
import re
site=re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}',pathlib.Path(d['baseline_site_target']).name)
assert site and site[1]==d['baseline_site_sha'][:12]
for name,b in baseline.items():
 c=json.loads(subprocess.check_output(['docker','inspect',name],stderr=subprocess.DEVNULL))[0]
 assert c['Id']==b['Id'] and c['Image']==b['Image'] and c['State']['Running'] and c['State']['StartedAt']==b['StartedAt']
 if name=='commonswarm-oauth-oauth-1':
  assert c['State']['Health']['Status']=='healthy'
  label=subprocess.check_output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',c['Image']],text=True,stderr=subprocess.DEVNULL).strip()
  assert label==d['baseline_oauth_sha']
  env=dict(x.split('=',1) for x in c['Config']['Env']); assert env['MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED']=='1'
  assert not any(k.startswith('MCP_OAUTH_TEST_') for k in env)
PY
 edge_tree_check "$OLD_EDGE" "$OLD_ARCHIVE" "$OLD_ARCHIVE_DIGEST"
 edge_tree_check "$OLD_HELPER" "$OLD_ARCHIVE" "$OLD_ARCHIVE_DIGEST"
 edge_fence
}
edge_render() {
 edge_compose "$1" config --format json >"$SECRET_STAGE/render.json" 2>"$SECRET_STAGE/render.log"
 python3 - "$SECRET_STAGE/render.json" "$INPUTS_FILE" <<'PY'
import json,subprocess,sys
d=json.load(open(sys.argv[2])); c=json.load(open(sys.argv[1]))['services']['edge-runtime']
assert c['network_mode']=='commonswarm-net' and int(c['mem_limit'])==2147483648
img=json.loads(subprocess.check_output(['docker','image','inspect',c['image']],stderr=subprocess.DEVNULL))[0]
assert img['Id']==d['baseline_edge_image']
live=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
env=dict(x.split('=',1) for x in img['Config'].get('Env',[])); env.update(c['environment'])
assert env==dict(x.split('=',1) for x in live['Config']['Env'])
assert env['SWARM_MCP_PUBLIC_ENABLED']=='1' and not any(k.startswith(('SWARM_CMD_TEST_','MCP_OAUTH_TEST_')) for k in env)
PY
}
edge_route_probes() {
 python3 - "$CADDY_CA_FILE" <<'PY'
import http.client,json,ssl,sys
ctx=ssl.create_default_context(cafile=sys.argv[1])
# Resolve transport to loopback without changing TLS SNI or HTTP Host.
class LocalTLS(http.client.HTTPSConnection):
 def connect(self):
  import socket
  self.sock=ctx.wrap_socket(socket.create_connection(('127.0.0.1',443),15),server_hostname=self.host)
def request(host,path,method='GET',body=None,headers=None):
 c=LocalTLS(host,context=ctx,timeout=15); c.request(method,path,body,headers or {})
 r=c.getresponse(); data=r.read(65537); assert len(data)<=65536
 headers=dict((k.lower(),v) for k,v in r.getheaders()); status=r.status; c.close(); return status,headers,data
# Only gate reads model the site's credential-free browser/CORS request.
# admin-gate.js emits wildcard ACAO unconditionally; no origin allowlist is assumed.
gate_headers={'Origin':'https://commonswarm.com','Accept':'*/*'}
discovery_headers={'Accept':'application/json'}
# MCP connector/CLI backends send no Origin. Match Streamable HTTP's JSON/SSE Accept.
mcp_headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
for method in ('GET','HEAD'):
 status,h,b=request('mcp.commonswarm.com','/admin/gate',method,headers=gate_headers)
 assert status==200 and h.get('access-control-allow-origin')=='*' and 'no-store' in h.get('cache-control','')
 assert json.loads(b)=={'state':'closed'} if method=='GET' else b==b''
status,h,b=request('api.commonswarm.com','/admin','POST','{"jsonrpc":"2.0","id":1,"method":"tools/list"}',headers=mcp_headers)
assert status==401
status,h,b=request('api.commonswarm.com','/.well-known/oauth-protected-resource/admin',headers=discovery_headers)
assert status==200; d=json.loads(b)
assert d['resource']=='https://api.commonswarm.com/admin' and d['authorization_servers']==['https://mcp.commonswarm.com']
status,h,b=request('api.commonswarm.com','/.well-known/oauth-protected-resource/admin','HEAD',headers=discovery_headers); assert status==405
status,h,b=request('mcp.commonswarm.com','/.well-known/oauth-authorization-server',headers=discovery_headers); assert status==200
assert json.loads(b)['issuer']=='https://mcp.commonswarm.com'
status,h,b=request('mcp.commonswarm.com','/.well-known/oauth-protected-resource/mcp',headers=discovery_headers); assert status==200
assert json.loads(b)=={'resource':'https://mcp.commonswarm.com/mcp','authorization_servers':['https://mcp.commonswarm.com'],'bearer_methods_supported':['header'],'scopes_supported':['mcp'],'resource_name':'CommonSwarm hosted MCP'}
for meta in (False,True):
 params={'name':'cswarm_check','arguments':{}}
 if meta: params['_meta']={'progressToken':'edge-release-public-probe'}
 body=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':params})
 status,h,b=request('mcp.commonswarm.com','/mcp','POST',body,headers=mcp_headers); assert status==401
 try: value=json.loads(b)
 except ValueError: value={}
 error=value.get('error') if isinstance(value,dict) else None
 assert not isinstance(error,dict) or error.get('code')!=-32602
print('PASS local Caddy closed gate/CORS, canonical admin, discovery, MCP unauthenticated 401 pair; authenticated parser check pending')
PY
}
SH
. "$PROOF_DIR/session.sh"
PG_SERVICE_OUTPUT="$SECRET_STAGE/service.conf" PG_PASS_OUTPUT="$SECRET_STAGE/pass" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "$OLD_HELPER/deploy/supabase-stack/migrate/make-pg-service.mjs" >"$SECRET_STAGE/session.log" 2>&1
chmod 0600 "$SECRET_STAGE/service.conf" "$SECRET_STAGE/pass"
python3 - "$OLD_HELPER/deploy/supabase-stack/migrate/lib.sh" "$PROOF_DIR/identity.sql" <<'PY'
import pathlib,sys
s=pathlib.Path(sys.argv[1]).read_text().split('assert_target_identity() {\n',1)[1].split('\nassert_backup_ro_identity()',1)[0]
sql=s.split("<<'SQL'\n",1)[1].split('\nSQL',1)[0]; assert "current_user <> 'supabase_admin'" in sql and 'rolsuper' in sql
pathlib.Path(sys.argv[2]).write_text(sql+'\n')
PY
edge_ro -q --file /proof/identity.sql >/dev/null
edge_db_state "$PROOF_DIR/baseline"
python3 - "$INPUTS_FILE" "$PROOF_DIR" <<'PY'
import hashlib,json,pathlib,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2])
for name,key in [('baseline.cutover.json','baseline_cutover_sha256'),('baseline.ledger.txt','baseline_ledger_sha256')]: assert hashlib.sha256((p/name).read_bytes()).hexdigest()==d[key]
r=json.load(open(p/'baseline.cutover.json'))
assert not r['admin_issuance_enabled'] and r['legacy_closed'] and r['auth_contract_version']==2
assert r['approved_edge_release_sha']==r['measured_edge_release_sha']==d['baseline_edge_sha'] and r['measured_generation']==r['release_generation'] and r['invalidated_at'] is None
assert r['measured_edge_target']==r['measured_mount']=='/home/commonswarm/edge/releases/'+d['baseline_edge_sha']
assert r['measured_image_digest']==d['baseline_edge_image'] and r['measured_artifact_digest']==d['recycle_archive_sha256']
PY
edge_timer_active
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
edge_identity "$OLD_EDGE"
edge_invariants
edge_route_probes
printf 'PASS\n' >"$PROOF_DIR/probes-baseline.txt"
printf 'PASS\n' >"$PROOF_DIR/open.txt"
printf 'PASS open: PROOF_DIR=%s; baseline gate CLOSED; no service mutation\n' "$PROOF_DIR"
)
```

```sh
# step: edge-archive
# readonly: no
# host: Mac /bin/bash 3.2; archive/upload
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -euo pipefail
set -E
trap 'printf "FAIL edge-archive: line %s; STOP\n" "$LINENO" >&2' ERR
umask 077
: "${INPUTS_FILE:?FAIL edge-archive: INPUTS_FILE required; STOP}" "${BOX_HOST:?FAIL edge-archive: BOX_HOST required; STOP}"
RELEASE_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["release_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["window_id"]; assert re.fullmatch("[A-Za-z0-9]{6}",v); print(v)' "$INPUTS_FILE")
case "$(git remote get-url origin)" in
 git@github.com:yulanventures/commonswarm.git|https://github.com/yulanventures/commonswarm.git|https://github.com/yulanventures/commonswarm) ;;
 *) printf 'FAIL edge-archive: origin must be yulanventures/commonswarm on GitHub; STOP\n' >&2; exit 1;;
esac
git fetch origin main
test "$(git rev-parse "$RELEASE_SHA^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
MAC_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
printf 'Mac scratch created: MAC_STAGE=%s\n' "$MAC_STAGE"
install -m 0600 "$INPUTS_FILE" "$MAC_STAGE/inputs.json"
git archive --format=tar "$RELEASE_SHA" >"$MAC_STAGE/release.tar"
MAIN_SHA=$(git rev-parse origin/main)
SITE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_site_sha"])' "$INPUTS_FILE")
test "$(git rev-parse --verify "${SITE_SHA:0:12}^{commit}")" = "$SITE_SHA"
python3 - "$MAC_STAGE" "$MAIN_SHA" <<'PY'
import datetime,hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes())
if hashlib.sha256((p/'release.tar').read_bytes()).hexdigest()!=d['archive_sha256']: raise SystemExit('FAIL edge-archive: exact archive checksum mismatch; STOP')
r={'release_sha':d['release_sha'],'origin_main_sha':sys.argv[2],'is_ancestor':True,'baseline_site_sha':d['baseline_site_sha'],'measured_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
(p/'ancestry.json').write_text(json.dumps(r,sort_keys=True)+'\n')
PY
# Reserve both previously absent transport paths; never overwrite retained history.
ssh -n "$BOX_HOST" "umask 077; test ! -e '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.tar' && test ! -L '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.tar' && test ! -e '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.ancestry.json' && test ! -L '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.ancestry.json' && (set -C; : > '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.tar'; : > '/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.ancestry.json')"
scp "$MAC_STAGE/release.tar" "$BOX_HOST:/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.tar"
scp "$MAC_STAGE/ancestry.json" "$BOX_HOST:/tmp/admin-issuance-$RELEASE_SHA-$WINDOW_ID.ancestry.json"
printf 'PASS exact landed archive uploaded; MAC_STAGE=%s\n' "$MAC_STAGE"
)
```

```sh
# step: edge-preflight
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-preflight: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_forward_admit

edge_deadline
edge_identity "$OLD_EDGE"; edge_invariants; edge_timer_active
python3 - "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$NEW_EDGE" "$NEW_HELPER" "$RECYCLE_HOOK" "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" <<'PY'
import datetime,hashlib,importlib.util,io,json,os,pathlib,pwd,re,shutil,stat,sys,tarfile
inputs,archive,proof,edge,helper,hook,baseline=sys.argv[1:]; d=json.load(open(inputs)); p=pathlib.Path(proof); a=pathlib.Path(archive)
spec=importlib.util.spec_from_file_location('edge_archives',p/'edge-archives.py'); archives=importlib.util.module_from_spec(spec); spec.loader.exec_module(archives)
archives.keeper_absent()
archive_bytes,upload=archives.read(str(a)); assert upload['sha256']==d['archive_sha256']
r=json.load(open(a.with_suffix('.ancestry.json')))
assert r['release_sha']==d['release_sha'] and re.fullmatch('[0-9a-f]{40}',r['origin_main_sha']) and r['is_ancestor'] is True and r['baseline_site_sha']==d['baseline_site_sha']
at=datetime.datetime.fromisoformat(r['measured_at'].replace('Z','+00:00')); now=datetime.datetime.now(datetime.timezone.utc)
assert 0<=(now-at).total_seconds()<=1800
assert not os.path.lexists(edge) and not os.path.lexists(helper)
def metadata(path):
 s=path.stat(); return {'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode))}
layout=[]
for root,kind,expected_parent,owners in [
 (helper,'helper','/home/commonswarm/admin-issuance/releases',{0}),
 (edge,'edge','/home/commonswarm/edge/releases',{0,pwd.getpwnam('commonswarm').pw_uid}),
]:
 tree=pathlib.Path(root); parent=tree.parent
 assert tree==pathlib.Path(expected_parent)/d['release_sha'], 'FAIL unexpected release parent/path; STOP'
 assert parent.is_absolute() and parent.is_dir() and not parent.is_symlink() and parent.resolve()==parent, 'FAIL release parent must be an exact real directory; STOP'
 s=parent.stat()
 assert s.st_uid in owners and not stat.S_IMODE(s.st_mode)&0o022, 'FAIL release parent owner/write mode refused; STOP'
 old=parent/d['baseline_edge_sha']
 assert old.is_dir() and not old.is_symlink() and old.resolve()==old, 'FAIL baseline release tree must be an exact real directory; STOP'
 measured=metadata(old)
 assert measured=={'uid':0,'gid':0,'mode':'0o700'}, 'FAIL baseline release tree must match measured root:root 0700 layout; STOP'
 layout.append({'part':kind,'path':root,'parent':dict(path=str(parent),**metadata(parent)),'baseline':{'path':str(old),'metadata':measured}})
(p/'tree-layout.json').write_text(json.dumps(layout,sort_keys=True)+'\n')
baseline=pathlib.Path(baseline)
assert baseline.is_file() and not baseline.is_symlink(), 'FAIL baseline override must be a regular non-symlink file; STOP'
baseline_stat=baseline.stat(); baseline_hash=hashlib.sha256(baseline.read_bytes()).hexdigest()
assert baseline_hash==d['override_sha256'], 'FAIL baseline override digest differs from measured input; STOP'
override='deploy/edge-runtime/compose.override.yaml'
with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as t:
 seen={}
 for m in t.getmembers():
  q=pathlib.PurePosixPath(m.name); name=q.as_posix()
  assert name!='.' and not q.is_absolute() and '..' not in q.parts and name not in seen
  seen[name]=m
  assert m.isfile() or m.isdir() or m.issym()
  if m.issym():
   link=pathlib.PurePosixPath(m.linkname); assert not link.is_absolute() and '..' not in link.parts
 for name,m in seen.items():
  for parent in pathlib.PurePosixPath(name).parents:
   if str(parent)!='.': assert str(parent) in seen and seen[str(parent)].isdir(), 'FAIL archive parent is not a directory; STOP'
  if m.issym():
   target=(pathlib.PurePosixPath(name).parent/pathlib.PurePosixPath(m.linkname)).as_posix()
   assert target in seen and seen[target].isfile(), 'FAIL archive symlink target is not a regular member; STOP'
 assert 'RELEASE_SHA' not in seen, 'FAIL archive must not contain RELEASE_SHA; STOP'
 # Runtime mounts, bootstrap inputs and the recycle DB helper live at repository root.
 required={
  'deploy/edge-runtime/compose.yaml':'file', override:'file',
  'deploy/edge-runtime/bootstrap.sh':'file','deploy/edge-runtime/h0-deno.json':'file',
  'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md':'file',
  'deploy/supabase-stack/migrate/make-pg-service.mjs':'file',
  'deploy/edge-runtime/main':'dir','supabase/functions':'dir','src':'dir',
 }
 for name,kind in required.items():
  assert name in seen and (seen[name].isfile() if kind=='file' else seen[name].isdir()), 'FAIL required archive path/type '+name+'; STOP'
 # The installed hook must be exactly the reviewed C1 hook, unchanged.
 source=t.extractfile('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md').read().decode()
 found=re.findall(r'^```sh\n(# step: ai-recycle-hook\n.*?)^```$',source,re.M|re.S); assert len(found)==1
 assert ('#!/bin/bash\n'+found[0]).encode()==pathlib.Path(hook).read_bytes(), 'FAIL hook differs; STOP for reviewed hook investigation'
 # Before release-tree/service/binding mutation: retain the exact baseline and promote the verified upload.
 archives.rescue(proof)
 promoted=archives.promote(archives.ARCHIVES+'/'+d['release_sha']+'-'+d['window_id']+'.tar',archive_bytes)
 archives.receipt(p,'archive-promotion.json',promoted)
 archive_hash=hashlib.sha256(t.extractfile(override).read()).hexdigest()
 for row in layout:
  root,kind=row['path'],row['part']; tree=pathlib.Path(root)
  # Exclusive receipt before mkdir; records window ownership even on extraction failure.
  with (p/(kind+'-tree-created.json')).open('x') as f: f.write(json.dumps({'path':root,'release_sha':d['release_sha'],'window_id':d['window_id']})+'\n')
  tree.mkdir(mode=int(row['baseline']['metadata']['mode'],8))
  os.chmod(tree,int(row['baseline']['metadata']['mode'],8))
  t.extractall(root,filter='data')
  row['created']=metadata(tree)
  assert row['created']==row['baseline']['metadata'], 'FAIL new release tree owner/mode differs from baseline; STOP'
  marker=tree/'RELEASE_SHA'; assert not os.path.lexists(marker)
  with marker.open('x') as f: f.write(d['release_sha']+'\n')
  marker.chmod(0o600)
  assert metadata(marker)=={'uid':0,'gid':0,'mode':'0o600'}, 'FAIL RELEASE_SHA must be root:root 0600; STOP'
  (p/'tree-layout.json').write_text(json.dumps(layout,sort_keys=True)+'\n')
dest=pathlib.Path(edge)/override
assert dest.is_file() and not dest.is_symlink()
shutil.copy2(baseline,dest)
os.chown(dest,baseline_stat.st_uid,baseline_stat.st_gid)
os.chmod(dest,stat.S_IMODE(baseline_stat.st_mode))
copied_hash=hashlib.sha256(dest.read_bytes()).hexdigest(); copied_stat=dest.stat()
assert copied_hash==d['override_sha256'], 'FAIL copied baseline override digest differs; STOP'
assert (copied_stat.st_uid,copied_stat.st_gid,stat.S_IMODE(copied_stat.st_mode))==(baseline_stat.st_uid,baseline_stat.st_gid,stat.S_IMODE(baseline_stat.st_mode)), 'FAIL copied baseline override owner/mode differs; STOP'
(p/'override.json').write_text(json.dumps({'archive_sha256':archive_hash,'baseline_sha256':baseline_hash,'copied_sha256':copied_hash,'archive_matched_baseline':archive_hash==baseline_hash,'uid':copied_stat.st_uid,'gid':copied_stat.st_gid,'mode':oct(stat.S_IMODE(copied_stat.st_mode))},sort_keys=True)+'\n')
(p/'ancestry.json').write_text(json.dumps(r,sort_keys=True)+'\n')
PY
edge_tree_check "$NEW_EDGE" "$BOX_ARCHIVE_PATH" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")"
edge_tree_check "$NEW_HELPER" "$BOX_ARCHIVE_PATH" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")"
cmp -s "$NEW_EDGE/deploy/edge-runtime/compose.yaml" "$OLD_EDGE/deploy/edge-runtime/compose.yaml" || fail 'edge runtime definition changed; separate reviewed runtime release required'
printf 'PASS\n' >"$PROOF_DIR/preflight.txt"

)
```

```sh
# step: edge-ready
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-ready: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_forward_admit

edge_deadline
test "$(cat "$PROOF_DIR/preflight.txt")" = PASS
# The unchanged C1 hook verifies the durable archive and compares its bytes at recycle.
edge_archives ready
python3 - "$PROOF_DIR/override.json" "$INPUTS_FILE" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); d=json.load(open(sys.argv[2]))
assert r['baseline_sha256']==r['copied_sha256']==d['override_sha256']
assert r['archive_sha256']==d['override_sha256'] and r['archive_matched_baseline'] is True, 'FAIL unchanged recycle hook requires archive override to match baseline; STOP for reviewed hook change'
PY
edge_render "$NEW_EDGE"
edge_identity "$OLD_EDGE"; edge_invariants; edge_timer_active
printf 'PASS\n' >"$PROOF_DIR/ready.txt"

)
```

```sh
# step: edge-apply
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-apply: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_forward_admit

edge_deadline
test "$(cat "$PROOF_DIR/ready.txt")" = PASS
test ! -e "$PROOF_DIR/edge-attempted.txt"
test ! -L "$PROOF_DIR/edge-attempted.txt"
edge_invariants; edge_render "$NEW_EDGE"
edge_archives ready # Refuse keeper/promotion/rescue drift before any apply mutation.
# Receipt precedes even the DB mutation, so every uncertain mutation takes R1.
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-attempted.txt"
edge_timer_guard
edge_invalidate
systemctl stop "$EDGE_RECYCLE_TIMER"
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_TIMER")" = inactive
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
edge_switch "$NEW_EDGE"
edge_recreate "$NEW_EDGE"
edge_identity "$NEW_EDGE"
edge_binding apply
edge_measure "$RELEASE_SHA"
edge_invariants
printf 'PASS\n' >"$PROOF_DIR/applied.txt"
# EXIT restores/verifies timer. Row 7 independently checks it.

)
```

```sh
# step: edge-probes
# readonly: probe
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-probes: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_admit

case "${PROBE_PHASE:?forward or recovery}" in
 forward) edge_forward_admit; edge_deadline; test "$(cat "$PROOF_DIR/applied.txt")" = PASS; target=$NEW_EDGE; sha=$RELEASE_SHA;;
 recovery) test "$(cat "$PROOF_DIR/rollback.txt")" = PASS; test -f "$PROOF_DIR/aside.json"; test ! -L "$PROOF_DIR/aside.json"; target=$OLD_EDGE; sha=${OLD_EDGE##*/};;
 *) fail 'probe phase refused';;
esac
edge_timer_active; edge_identity "$target"; edge_readback "$sha"; edge_invariants
edge_route_probes
printf 'PASS\n' >"$PROOF_DIR/probes-$PROBE_PHASE.txt"

)
```

```sh
# step: edge-abort
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-abort: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
if test ! -e "$PROOF_DIR/open.txt" && test ! -L "$PROOF_DIR/open.txt"; then
 test -f "$PROOF_DIR/partial-session.sh"
 test ! -L "$PROOF_DIR/partial-session.sh"
 . "$PROOF_DIR/partial-session.sh"
 edge_partial_admit
 edge_partial_baseline
 PARTIAL_STAGE=$(edge_partial_stage cleanup)
 if test -n "$PARTIAL_STAGE" && test -e "$PARTIAL_STAGE"; then
  rm -r -- "$PARTIAL_STAGE" || { printf 'FAIL rm guard refused %s; retain guard message; STOP\n' "$PARTIAL_STAGE" >&2; exit 1; }
 fi
 edge_partial_stage absent >/dev/null
 python3 - "$PROOF_DIR" "$PARTIAL_STAGE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes())
r={'release_sha':d['release_sha'],'window_id':d['window_id'],'proof_dir':str(p),'lock':str(p.parent/'OPEN'),'secret_stage':sys.argv[2] or None,'routes':'skipped-partial-open','admin_gate':'not-verified-partial-open','services':'not-mutated'}
(p/'partial-open-aborted.json').write_text(json.dumps(r,sort_keys=True)+'\n')
PY
 printf 'PASS partial-open abort: PROOF_DIR=%s; LOCK=%s; SECRET_STAGE=%s removed/absent; routes unverified; run R4 CLOSE_RESULT=aborted\n' "$PROOF_DIR" "${PROOF_DIR%/*}/OPEN" "${PARTIAL_STAGE:-none}"
 exit 0
fi
test -f "$PROOF_DIR/open.txt"
test ! -L "$PROOF_DIR/open.txt"
. "$PROOF_DIR/session.sh"
edge_admit

test ! -e "$PROOF_DIR/rollback.txt"
test ! -L "$PROOF_DIR/rollback.txt"
test ! -e "$PROOF_DIR/edge-attempted.txt" && test ! -L "$PROOF_DIR/edge-attempted.txt" || fail 'attempt present/unknown; use rollback'
edge_timer_active; edge_identity "$OLD_EDGE"; edge_invariants
cmp -s "$RECYCLE_JSON" "$PROOF_DIR/recycle.baseline.json"
edge_db_state "$PROOF_DIR/abort"
cmp -s "$PROOF_DIR/abort.cutover.json" "$PROOF_DIR/baseline.cutover.json"
edge_route_probes
printf 'PASS\n' >"$PROOF_DIR/probes-aborted-before-attempt.txt"
printf 'PASS\n' >"$PROOF_DIR/aborted-before-attempt.txt"

)
```

```sh
# step: edge-rollback
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-rollback: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_admit

test -f "$PROOF_DIR/edge-attempted.txt" && test ! -L "$PROOF_DIR/edge-attempted.txt" || fail 'regular attempt receipt required; HezLead recovery'
edge_archives restore
edge_timer_guard
edge_invalidate
systemctl stop "$EDGE_RECYCLE_TIMER"
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_TIMER")" = inactive
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
# Hook/drop-in were never modified. The retained durable rescue restages a missing legacy tar
# at its exact old path with admitted metadata before exact-byte binding restore. Any conflict stops.
edge_invariants
edge_binding restore
cmp -s "$RECYCLE_JSON" "$PROOF_DIR/recycle.baseline.json"
edge_switch "$OLD_EDGE"
edge_recreate "$OLD_EDGE"
edge_identity "$OLD_EDGE"
edge_measure "${OLD_EDGE##*/}"
edge_invariants
printf 'PASS\n' >"$PROOF_DIR/rollback.txt"

)
```

```sh
# step: edge-release-aside
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-release-aside: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
. "$PROOF_DIR/session.sh"
edge_admit

edge_identity "$OLD_EDGE"; edge_invariants; edge_timer_active
if test -e "$PROOF_DIR/edge-attempted.txt" || test -L "$PROOF_DIR/edge-attempted.txt"; then
 test "$(cat "$PROOF_DIR/rollback.txt")" = PASS
else
 test "$(cat "$PROOF_DIR/aborted-before-attempt.txt")" = PASS
fi
python3 - "$INPUTS_FILE" "$PROOF_DIR" "$NEW_EDGE" "$NEW_HELPER" "$RECYCLE_JSON" <<'PY'
import json,os,pathlib,stat,subprocess,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2]); binding=json.load(open(sys.argv[5]))
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
results=[]
for root,kind in [(sys.argv[3],'edge'),(sys.argv[4],'helper')]:
 receipt=p/(kind+'-tree-created.json'); tree=pathlib.Path(root)
 if not receipt.exists():
  assert not os.path.lexists(tree); results.append({'part':kind,'moved':False}); continue
 assert receipt.is_file() and not receipt.is_symlink()
 r=json.load(open(receipt)); assert r=={'path':root,'release_sha':d['release_sha'],'window_id':d['window_id']}
 assert binding['target']!=root and binding['release_root']!=root and str(pathlib.Path('/home/commonswarm/edge/current').resolve())!=root
 assert not c['Config']['Labels']['com.docker.compose.project.working_dir'].startswith(root+'/')
 parent=tree.parent.parent/'failed-attempts'; parent.mkdir(mode=0o700,exist_ok=True)
 assert not parent.is_symlink() and parent.resolve()==parent and parent.stat().st_uid==0 and stat.S_IMODE(parent.stat().st_mode)==0o700
 dest=parent/(d['release_sha']+'-EDGE-'+d['window_id'])
 if not os.path.lexists(tree):
  assert dest.is_dir() and not dest.is_symlink(); results.append({'part':kind,'moved':True,'to':str(dest)}); continue
 assert tree.is_dir() and not tree.is_symlink() and not os.path.lexists(dest) and tree.stat().st_dev==parent.stat().st_dev
 os.rename(tree,dest); assert not os.path.lexists(tree)
 results.append({'part':kind,'moved':True,'to':str(dest)})
(p/'aside.json').write_text(json.dumps(results,sort_keys=True)+'\n')
PY

)
```

```sh
# step: edge-close
# readonly: no
# host: box root /bin/bash 5; complete subshell
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -eEuo pipefail
trap 'printf "FAIL edge-close: line %s; STOP\n" "$LINENO" >&2' ERR
: "${PROOF_DIR:?PROOF_DIR required}"
if test ! -e "$PROOF_DIR/open.txt" && test ! -L "$PROOF_DIR/open.txt"; then
 test "${CLOSE_RESULT:?}" = aborted
 test -f "$PROOF_DIR/partial-session.sh"
 test ! -L "$PROOF_DIR/partial-session.sh"
 . "$PROOF_DIR/partial-session.sh"
 edge_partial_admit
 edge_partial_baseline
 PARTIAL_STAGE=$(edge_partial_stage absent)
 python3 - "$PROOF_DIR" "$PARTIAL_STAGE" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes()); f=p/'partial-open-aborted.json'
assert f.is_file() and not f.is_symlink()
r=json.loads(f.read_bytes())
assert r=={'release_sha':d['release_sha'],'window_id':d['window_id'],'proof_dir':str(p),'lock':str(p.parent/'OPEN'),'secret_stage':sys.argv[2] or None,'routes':'skipped-partial-open','admin_gate':'not-verified-partial-open','services':'not-mutated'}
closed={'release_sha':d['release_sha'],'baseline_edge_sha':d['baseline_edge_sha'],'window_id':d['window_id'],'target':d['target'],'result':'aborted','closed_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'timer':'active','admin_gate':r['admin_gate'],'routes':r['routes'],'services':r['services'],'authenticated_meta_operator_check':'not-applicable'}
with (p/'close-result.json').open('x') as f: f.write(json.dumps(closed,sort_keys=True)+'\n')
(p/'closed.txt').write_text(closed['closed_at']+'\n')
PY
 LOCK="${PROOF_DIR%/*}/OPEN"
 test "$(cat "$LOCK/proof.path")" = "$PROOF_DIR"
 rm -- "$LOCK/proof.path" || { printf 'FAIL rm guard refused lock receipt; STOP\n' >&2; exit 1; }
 rmdir "$LOCK"
 printf 'PASS partial-open close: aborted; timer active; services unchanged; routes and gate unverified\n'
 exit 0
fi
test -f "$PROOF_DIR/open.txt"
test ! -L "$PROOF_DIR/open.txt"
. "$PROOF_DIR/session.sh"
edge_admit

edge_timer_active
case "${CLOSE_RESULT:?success, rolled-back or aborted}" in
 success)
  edge_forward_admit
  edge_deadline
  test "$(cat "$PROOF_DIR/applied.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-forward.txt")" = PASS
  edge_identity "$NEW_EDGE"; edge_readback "$RELEASE_SHA"
  digest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")
  edge_archives ready
  edge_tree_check "$NEW_EDGE" "$DURABLE_ARCHIVE_PATH" "$digest"
  edge_tree_check "$NEW_HELPER" "$DURABLE_ARCHIVE_PATH" "$digest"
  python3 - "$RECYCLE_JSON" "$INPUTS_FILE" "$DURABLE_ARCHIVE_PATH" "$NEW_HELPER" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); d=json.load(open(sys.argv[2]))
assert r['release_sha']==d['release_sha'] and r['target']=='/home/commonswarm/edge/releases/'+d['release_sha'] and r['archive']==sys.argv[3] and r['release_root']==sys.argv[4] and r['artifact_digest']==d['archive_sha256'] and r['image_digest']==d['baseline_edge_image']
PY
  ;;
 rolled-back)
  test "$(cat "$PROOF_DIR/rollback.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-recovery.txt")" = PASS
  edge_identity "$OLD_EDGE"; edge_readback "${OLD_EDGE##*/}"
  cmp -s "$RECYCLE_JSON" "$PROOF_DIR/recycle.baseline.json";;
 aborted)
  test ! -e "$PROOF_DIR/edge-attempted.txt"
  test ! -L "$PROOF_DIR/edge-attempted.txt"
  test ! -e "$PROOF_DIR/rollback.txt"
  test ! -L "$PROOF_DIR/rollback.txt"
  test "$(cat "$PROOF_DIR/aborted-before-attempt.txt")" = PASS
  test "$(cat "$PROOF_DIR/probes-aborted-before-attempt.txt")" = PASS
  edge_identity "$OLD_EDGE"
  cmp -s "$RECYCLE_JSON" "$PROOF_DIR/recycle.baseline.json"
  edge_db_state "$PROOF_DIR/abort-close"
  cmp -s "$PROOF_DIR/abort-close.cutover.json" "$PROOF_DIR/baseline.cutover.json";;
 *) fail 'close result refused';;
esac
if test "$CLOSE_RESULT" != success; then
 test -f "$PROOF_DIR/aside.json"
 test ! -L "$PROOF_DIR/aside.json"
 test ! -e "$NEW_EDGE"
 test ! -L "$NEW_EDGE"
 test ! -e "$NEW_HELPER"
 test ! -L "$NEW_HELPER"
fi
edge_invariants; edge_route_probes; edge_timer_active
# Refuse unsafe cleanup; control proves rejected names. Use the installed rm guard.
python3 - "$SECRET_STAGE" "$PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
stage,record=sys.argv[1:]
def permitted(x): return re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',x) is not None
for bad in ('','/',str(pathlib.Path.home()),'/tmp/other','/tmp/anvil-secret.abcdef/child'):
 assert not permitted(bad), 'FAIL deletion negative control; STOP'
p=pathlib.Path(stage); assert permitted(stage) and pathlib.Path(record).read_text()==stage+'\n'
assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PY
rm -r -- "$SECRET_STAGE" || { printf 'FAIL rm guard refused %s; retain guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
# No more DB operations after stage deletion; retain release/proof/helper/archive history.
python3 - "$INPUTS_FILE" "$PROOF_DIR" "$CLOSE_RESULT" <<'PY'
import datetime,json,pathlib,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2]); result=sys.argv[3]
r={'release_sha':d['release_sha'],'baseline_edge_sha':d['baseline_edge_sha'],'window_id':d['window_id'],'target':d['target'],'result':result,'closed_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'timer':'active','admin_gate':'closed','authenticated_meta_operator_check':'pending' if result=='success' else 'not-applicable'}
with (p/'close-result.json').open('x') as f: f.write(json.dumps(r,sort_keys=True)+'\n')
(p/'closed.txt').write_text(r['closed_at']+'\n')
PY
test "$(cat "$LOCK/proof.path")" = "$PROOF_DIR"
rm -- "$LOCK/proof.path" || { printf 'FAIL rm guard refused lock receipt; STOP\n' >&2; exit 1; }
rmdir "$LOCK"
printf 'PASS verified close: %s; timer active; gate CLOSED\n' "$CLOSE_RESULT"

)
```

```sh
# step: edge-copyback
# readonly: no
# host: Mac /bin/bash 3.2; curated copyback and guarded scratch cleanup
set +e # Keep a failed subshell from exiting a persistent parent with errexit.
(
set -euo pipefail
set -E
trap 'printf "FAIL edge-copyback: line %s; STOP\n" "$LINENO" >&2' ERR
umask 077
: "${BOX_HOST:?FAIL edge-copyback: BOX_HOST required; STOP}" "${INPUTS_FILE:?FAIL edge-copyback: local INPUTS_FILE required; STOP}"
# INPUTS_FILE remains the operator's original local JSON, including when archive
# preparation stopped before it created a Mac stage. MAC_STAGE is optional only
# in that branch. Once created, the printed stage path must be supplied here.
RELEASE_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["release_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["window_id"]; assert re.fullmatch("[A-Za-z0-9]{6}",v); print(v)' "$INPUTS_FILE")
PROOF_DIR=/home/commonswarm/edge/release-proofs/$RELEASE_SHA-$WINDOW_ID
EVIDENCE_DIR=docs/evidence/edge-release-$RELEASE_SHA-$WINDOW_ID
test ! -e "$EVIDENCE_DIR"
mkdir -m 0700 "$EVIDENCE_DIR"
# Ancestry may be absent after an early archive failure; it stays in box proofs
# when measured. No env, session.sh, stage pointer or diagnostics in copy-back.
for FILE in inputs.json opened.txt close-result.json closed.txt; do
 ssh -n "$BOX_HOST" "sudo -n cat '$PROOF_DIR/$FILE'" >"$EVIDENCE_DIR/$FILE"
done
# Preflight provenance is optional only when it stopped before each receipt.
for FILE in override.json tree-layout.json keeper.json archive-baseline.json archive-rescue.json archive-promotion.json archive-restore.json; do
 ssh -n "$BOX_HOST" "if sudo -n test -e '$PROOF_DIR/$FILE' || sudo -n test -L '$PROOF_DIR/$FILE'; then sudo -n test -f '$PROOF_DIR/$FILE' && ! sudo -n test -L '$PROOF_DIR/$FILE' && sudo -n cat '$PROOF_DIR/$FILE'; else printf '%s\n' '{\"status\":\"not-created\"}'; fi" >"$EVIDENCE_DIR/$FILE"
done
python3 - "$EVIDENCE_DIR" "$INPUTS_FILE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads((p/'inputs.json').read_bytes()); r=json.loads((p/'close-result.json').read_bytes())
if not (d==json.load(open(sys.argv[2])) and all(r[k]==d[k] for k in ('release_sha','baseline_edge_sha','window_id','target')) and r['result'] in ('success','rolled-back','aborted') and (p/'closed.txt').read_text()==r['closed_at']+'\n'): raise SystemExit('FAIL edge-copyback: bound close record required; STOP')
PY
if test -n "${MAC_STAGE:-}"; then
 # Guard proof includes negative controls before removing only the created root.
 python3 - "$MAC_STAGE" <<'PY'
import pathlib,re,sys
def permitted(name): return re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',name) is not None
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child','/tmp/anvil-secret.abcdef'):
    if permitted(denied): raise SystemExit('FAIL edge-copyback: deletion guard negative control failed; STOP')
p=pathlib.Path(sys.argv[1])
if not (permitted(str(p)) and p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700): raise SystemExit('FAIL edge-copyback: unsafe Mac stage; STOP')
PY
 rm -r -- "$MAC_STAGE" || { printf 'FAIL edge-copyback: rm guard refused %s; retain exact guard message; STOP\n' "$MAC_STAGE" >&2; exit 1; }
 test ! -e "$MAC_STAGE" && test ! -L "$MAC_STAGE" || { printf 'FAIL edge-copyback: Mac stage remains after cleanup; STOP\n' >&2; exit 1; }
else
 printf 'No Mac stage supplied: valid only if oauth-archive stopped before creating one\n'
fi
printf 'PASS verified close copied to %s; supplied Mac scratch removed\n' "$EVIDENCE_DIR"
)
```

The current hook accepts the new identity without code changes: C1 RELEASE.md
4201–4212 validates the SHA-derived archive/helper conventions; 4257–4275 compares
live target/image/mounts/archive; 4287–4293 writes the measurement at the approved
SHA. edge_binding updates all seven config fields atomically while the timer is
stopped; postgres_image is preserved. edge_measure commits the new approval and
measurement with CLOSED issuance. Rollback restores byte-identical recycle.json,
never removes the existing hook/drop-in, and creates a fresh baseline measurement.
Old helper/archive and immutable baseline trees remain checked and retained. E admits exactly
the legacy /tmp/admin-issuance-<binding-sha>-<6alnum>.tar or the durable
/var/lib/commonswarm-admin-release/archives/<binding-sha>-<6alnum>.tar.
Before release-tree/service/binding mutation it preserves the verified baseline at the same
durable name used by C1 W4, then promotes the exact verified transport bytes exclusively
(root:root 0600 under canonical root:root 0700 directories; equal existing copies only).
BOX_ARCHIVE_PATH remains the /tmp transport, with its ancestry file retained;
DURABLE_ARCHIVE_PATH is the binding and success-close path. Rollback restages a missing
legacy tar exclusively at its exact original path, verifies bytes and admitted metadata,
fsyncs file and parent, then restores exact baseline JSON (C:5233–5261).
Keeper file presence STOPs before opening E or any archive/service/binding mutation;
E never installs, runs or retires the keeper.
Hook/drop-in bytes, ownership/modes and the baseline recycle-intent.json
(or its absence) are snapshotted and independently checked before/after.
Neither apply nor rollback invokes the hook, so its intent state stays exact;
intent drift STOPs instead of restoring an unrelated operator's state.
If hook bytes, config schema, timer schedule or either admitted archive convention differs,
STOP: this procedure does not install a different hook or reinterpret its contract.
After build B lands, main edge releases require the new C1 W4 hook already installed;
the candidate hook equality check remains mandatory.

Source map (C1 is docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md):

| New boundary | C1 source | Adaptation |
| --- | --- | --- |
| open/preflight/ready | ai-w4-preflight:3716; ai-prepare/ai-extract:810/841; ai-db-session:1479 | Fresh inputs, existing hook, exact archive and rollback capture |
| apply/invalidate/measurement | ai-w4-apply:3882 | Keep committed close/invalidation and measurement; omit initial legacy-fence mutation and Caddy install |
| probes/readback | ai-w4-probes:3967; ai-w4-readback:4020 | Local Caddy with independently verified CA for both targets; unchanged Caddy comparison; _meta 401 control and explicit operator check |
| rollback | ai-w4-rollback:4033 | Preserve existing hook/drop-in, restore exact recycle JSON, freshly measure baseline |
| timer guard/recovery | ai-timer-guard:4069; ai-w4-timer-recovery:4092 | Persist helpers; EXIT/INT/TERM guard installed before stop; close requires active timer |
| binding/compatibility | ai-recycle-hook:4158; ai-recycle-install:4314; ai-recycle-rollback:4367 | Keep hook bytes, atomic rebind instead of install; exact baseline restoration instead of removal |
| aside | ai-release-aside:3620 | Add window-owned receipts for both edge/helper trees; retain archives |
| run order/abort/close | deploy/mcp-auth/OAUTH-RELEASE.md:66 | Distinct success/rolled-back/aborted states; baseline abort has no recreate |

Dropped ai-w4-caddy-candidate:3785 (initial ingress cutover), Caddy install/reload,
initial hook/drop-in installation/removal, initial apply_legacy_admin_fence call,
C1 consent/window/migration/activation dependencies. This edge-only release
verifies their durable post-W4 results; it cannot complete or reopen C1.
