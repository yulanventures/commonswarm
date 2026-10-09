/** Executes the box-local edit lifecycle; only unavailable root/service I/O is stubbed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const helper = resolve('deploy/supabase-stack/caddy-live-edit/edit-api-pair.py');
const plan = resolve('deploy/supabase-stack/STORAGE-CORS-LIVE-EDIT.md');
const temp = spawnSync('mktemp', ['-d', '/tmp/storage-cors-test.XXXXXX'], { encoding: 'utf8' });
assert.equal(temp.status, 0, temp.stderr);
const scratch = realpathSync(temp.stdout.trim());
function run(command: string, args: string[], input?: string) {
  for (const arg of args) assert.ok(Buffer.byteLength(arg) < 64 * 1024, 'argv must stay under 64 KiB');
  const r = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r;
}

// The harness reads fixtures and runs the real helper. It does not add a test
// flag, write seam or command override to the box plan. Service responses and
// root identity cannot be reached on a non-root Mac and are the only stand-ins.
const harness = String.raw`
import contextlib, datetime, difflib, hashlib, importlib.util, io, json, os
from pathlib import Path
import re, socket, stat, subprocess, sys, tarfile, tempfile
os.umask(0o077)

helper, plan, root, scenario = sys.argv[1:]
spec=importlib.util.spec_from_file_location('editor',helper)
e=importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
root=Path(tempfile.mkdtemp(prefix='case-',dir=root))
sites=root/'sites'; sites.mkdir()
proof=root/'proof'; proof.mkdir(mode=0o700)
e.SITE_DIR=sites; e.LOCK=root/'lock'; e.MARKER=root/'marker'; e.CADDYFILE=root/'Caddyfile'
e.CADDYFILE.write_bytes(b'import sites/*.caddy\n')
ca=root/'ca'; ca.write_bytes(b'independent-test-ca')
real_stat=Path.lstat
owners={}; chown_calls=[]
def rootstat(path,*a,**kw):
    s=real_stat(path,*a,**kw)
    if path==root or root in path.parents:
        v=list(s); v[4],v[5]=owners.get(path,(0,0)); return os.stat_result(v)
    return s
Path.lstat=rootstat
os.geteuid=lambda:0
def fchown(fd,uid,gid):
    s=os.fstat(fd)
    paths=[p for p in sites.iterdir() if (real_stat(p).st_dev,real_stat(p).st_ino)==(s.st_dev,s.st_ino)]
    assert len(paths)==1
    p=paths[0]
    # Each staged file must receive its own member's saved IDs.
    m=next(m for m,(name,_,_) in e.MEMBERS.items() if p.name.startswith('.'+Path(name).stem+'.'))
    assert (uid,gid)==fixture_owners[m],(m,uid,gid)
    chown_calls.append((m,uid,gid)); owners[p]=(uid,gid)
os.fchown=fchown
native_replace=os.replace
def replace(src,dst):
    native_replace(src,dst)
    owners[Path(dst)]=owners.pop(Path(src),(0,0))
e.os.replace=replace
socket.gethostname=lambda: 'c1-staging-20261006' if scenario=='staging' else 'yulan-vps-1'
now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
fmt=lambda t:t.strftime('%Y-%m-%dT%H:%M:%SZ')
sha=lambda b:hashlib.sha256(b).hexdigest()
gate=b'(admin_gate) {\n # PRIVATE_GATE_SENTINEL_123456789012345678901234567890\n # admin_gate\n # admin_gate\n}\n'
new={}; previous={}; before={}
fixture_owners={'10':(1101,2101),'11':(1102,2102)}
repo=Path(helper).parents[3]
for m, (name,source,host) in e.MEMBERS.items():
    new[m]=(repo/'deploy/supabase-stack'/source).read_bytes()
    # Independent fixture replaces the one indentation-bounded new route.
    match=re.search(rb'(?ms)^(?P<i>[ \t]+)handle /storage/v1/\* \{\n.*?^(?P=i)\}',new[m])
    assert match
    indent=match['i']
    old=indent+b'handle /storage/v1/* {\n'+indent*2+b'uri strip_prefix /storage/v1\n'+indent*2+b'reverse_proxy 127.0.0.1:18004\n'+indent+b'}'
    previous[m]=new[m][:match.start()]+old+new[m][match.end():]
    if scenario=='spaces' and m=='10':
        previous[m]=previous[m].replace(old,old.replace(b'\t',b'    '))
    before[m]=(gate if m=='10' else b'')+previous[m]
    p=sites/name; p.write_bytes(before[m]); p.chmod(0o640 if m=='10' else 0o600)
    owners[p]=fixture_owners[m]
members=['10'] if scenario=='staging' else ['10','11']
if scenario=='staging':
    (sites/e.MEMBERS['11'][0]).unlink()
    e.MARKER.write_bytes(b'c1-staging-disposable-no-production'); e.MARKER.chmod(0o600)

def archive(path,sha_id,values):
    with tarfile.open(path,'w',format=tarfile.PAX_FORMAT,pax_headers={'comment':sha_id}) as t:
        for m in members:
            raw=values[m]; item=tarfile.TarInfo('deploy/supabase-stack/'+e.MEMBERS[m][1]); item.size=len(raw)
            t.addfile(item,io.BytesIO(raw))
release=root/'release.tar'; oldtar=root/'previous.tar'
archive(release,'a'*40,new); archive(oldtar,'b'*40,previous)
d=dict(TARGET='staging' if scenario=='staging' else 'production',BOX_HOSTNAME=socket.gethostname(),MEMBERS=' '.join(members),
 RELEASE_SHA='a'*40,PREVIOUS_SHA='b'*40,RELEASE_ARCHIVE=str(release),PREVIOUS_ARCHIVE=str(oldtar),
 RELEASE_ARCHIVE_SHA256=sha(release.read_bytes()),PREVIOUS_ARCHIVE_SHA256=sha(oldtar.read_bytes()),
 PLAN_SHA256=sha(Path(plan).read_bytes()),WINDOW_START_UTC=fmt(now-datetime.timedelta(seconds=1)),
 WINDOW_END_UTC=fmt(now+datetime.timedelta(minutes=20)),REFUSAL_WINDOWS_UTC=[[fmt(now+datetime.timedelta(hours=1)),fmt(now+datetime.timedelta(hours=2))]],
 CADDY_CA_FILE=str(ca),CADDY_CA_SHA256=sha(ca.read_bytes()),CADDYFILE_SHA256=sha(e.CADDYFILE.read_bytes()),ROLLBACK_APPROVED='yes')
for m in members:
    d['BEFORE_SHA256_'+m]=sha(before[m])
    diff=b''.join(difflib.diff_bytes(difflib.unified_diff,previous[m].splitlines(keepends=True),before[m].splitlines(keepends=True),fromfile=b'previous',tofile=b'live'))
    d['DIFF_SHA256_'+m]=sha(diff)
inputs=root/'inputs.json'
def write_inputs():
    inputs.write_text(json.dumps(d)); inputs.chmod(0o600)
write_inputs()
calls=[]; failures={}; http_bad=None
def infra(args,**kw):
    calls.append(args)
    kind='validate' if 'validate' in args else ('reload' if 'reload' in args else 'other')
    code=1 if failures.get(kind,0)>0 else 0
    if code: failures[kind]-=1
    if code and scenario in ('validate-ca-missing','reload-ca-missing'): ca.unlink()
    if args[0]=='curl':
        url=args[-1]; method=args[args.index('--request')+1]
        origin='https://evil.example' if 'Origin: https://evil.example' in args else 'https://commonswarm.com'
        if '/bucket' in url: status=401; headers={}
        elif method=='OPTIONS' and origin=='https://commonswarm.com':
            status=204; headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'PUT, OPTIONS','Access-Control-Allow-Headers':'content-type','Vary':'Origin'}
            if http_bad=='allowed': headers['Access-Control-Allow-Origin']='https://wrong.example'
        elif method=='OPTIONS':
            status=400; headers={}
            if http_bad=='denied': headers['Access-Control-Allow-Origin']=origin
        else:
            status=400; headers={} if url.startswith('http://') else {'Access-Control-Allow-Origin':origin}
            if http_bad=='put' and not url.startswith('http://'): headers['Access-Control-Allow-Credentials']='true'
        if http_bad=='baseline' and '/bucket' in url: status=403
        Path(args[args.index('--dump-header')+1]).write_text('HTTP/1.1 '+str(status)+'\r\n'+''.join(k+': '+v+'\r\n' for k,v in headers.items())+'\r\n')
        Path(args[args.index('--output')+1]).write_bytes(b'private upstream body')
        return subprocess.CompletedProcess(args,0,stdout=str(status).encode())
    return subprocess.CompletedProcess(args,code)
e.subprocess.run=infra
def session():return e.Session(inputs,proof,Path(helper).parent,Path(plan))
def refusal(call,label):
    try: call()
    except e.Refusal as ex: assert str(ex)==label,(str(ex),label)
    else: raise AssertionError('expected refusal '+label)
def exact_before():
    for m in members:
        p=sites/e.MEMBERS[m][0]
        assert p.read_bytes()==before[m]
        s=p.lstat()
        assert (s.st_uid,s.st_gid)==fixture_owners[m]
        assert stat.S_IMODE(s.st_mode)==(0o640 if m=='10' else 0o600)
def chowned(rounds):
    assert chown_calls==[(m,*fixture_owners[m]) for _ in range(rounds) for m in members],chown_calls
def success(s):
    s.apply(); s.verify(); s.close('success')
    assert not e.LOCK.exists()
    for m in members:
        expected=(gate if m=='10' else b'')+new[m]
        assert (sites/e.MEMBERS[m][0]).read_bytes()==expected
    safe=(proof/'copyback.json').read_bytes()
    assert b'PRIVATE_GATE' not in safe and b'handle ' not in safe and b'private upstream' not in safe
    assert json.loads(safe)['result']=='success'
    assert stat.S_IMODE((proof/'copyback.json').stat().st_mode)==0o600

if scenario in ('pair','staging','spaces'):
    s=session(); s.preflight(); success(s)
    assert len([c for c in calls if 'validate' in c])==1
    assert len([c for c in calls if 'reload' in c])==1
    curls=[c for c in calls if c[0]=='curl' and c[-1].startswith('https://')]
    assert len(curls)==5*len(members)
    for c in curls:
        assert '--resolve' in c and c[c.index('--resolve')+1].endswith(':443:127.0.0.1')
        assert '--cacert' in c and '--insecure' not in c and c[c.index('--noproxy')+1]=='*'
    for p in proof.iterdir(): assert stat.S_IMODE(p.stat().st_mode)==0o600
elif scenario in ('validate','reload','validate-ca-missing','reload-ca-missing'):
    kind=scenario.split('-')[0]
    s=session(); s.preflight(); failures[kind]=1
    refusal(s.apply,kind+' failed'); exact_before(); chowned(2)
    assert (proof/'rollback.ok').exists()
    assert len([c for c in calls if 'validate' in c])==2
    assert len([c for c in calls if 'reload' in c])==(1 if kind=='validate' else 2)
    if scenario.endswith('ca-missing'): assert not ca.exists()
    session().close('rolled-back'); assert not e.LOCK.exists()
elif scenario=='rollback-ca-missing':
    s=session(); s.preflight(); s.apply(); ca.unlink()
    owner=(e.LOCK/'owner').read_bytes(); probe_count=len([c for c in calls if c[0]=='curl'])
    session().rollback(); exact_before(); chowned(2)
    assert (proof/'rollback.ok').read_bytes()==b'PASS\n'
    assert (e.LOCK/'owner').read_bytes()==owner
    assert len([c for c in calls if c[0]=='curl'])==probe_count
    session().close('rolled-back'); assert not e.LOCK.exists()
    assert json.loads((proof/'copyback.json').read_bytes())['result']=='rolled-back'
elif scenario=='partial':
    s=session(); s.preflight(); s.acquire(); e.save(proof/'attempt',b'APPLY\n')
    p=sites/e.MEMBERS['10'][0]; p.write_bytes((proof/'after-10').read_bytes())
    # Restoration must remain admitted after the forward deadline has passed.
    real_clock=e.datetime.datetime
    class Expired(real_clock):
        @classmethod
        def now(cls,tz=None): return now+datetime.timedelta(hours=3)
    e.datetime.datetime=Expired
    s=session(); s.rollback(); exact_before(); chowned(1); s.close('rolled-back')
elif scenario=='rename-failure':
    s=session(); s.preflight(); real_replace=e.os.replace; renames=[0]
    def interrupted(src,dst):
        renames[0]+=1
        if renames[0]==2: raise OSError('private rename failure')
        return real_replace(src,dst)
    e.os.replace=interrupted
    try:s.apply()
    except OSError:pass
    else:raise AssertionError('rename should fail')
    exact_before(); assert (proof/'rollback.ok').exists(); s.close('rolled-back')
elif scenario=='forbidden':
    d['REFUSAL_WINDOWS_UTC']=[[fmt(now+datetime.timedelta(minutes=10)),fmt(now+datetime.timedelta(minutes=11))]];write_inputs()
    refusal(session().preflight,'forbidden window overlap');exact_before();assert not e.LOCK.exists()
elif scenario in ('abort','abort-ca-missing'):
    s=session();s.preflight()
    if scenario=='abort-ca-missing':ca.unlink()
    session().close('aborted');exact_before();chowned(0);assert not e.LOCK.exists()
    assert not [c for c in calls if 'reload' in c]
elif scenario=='ca-hash':
    s=session();s.preflight();s.apply();ca.write_bytes(b'changed-test-ca')
    refusal(lambda:session().verify(),'CA hash mismatch')
    session().rollback();exact_before();chowned(2);session().close('rolled-back')
elif scenario=='hash':
    d['BEFORE_SHA256_10']='0'*64;write_inputs()
    refusal(session().preflight,'before hash mismatch');exact_before()
elif scenario=='diff-hash':
    d['DIFF_SHA256_10']='0'*64;write_inputs()
    refusal(session().preflight,'DIFF_SHA256 mismatch');exact_before()
elif scenario in ('zero','two','host','storage-diff'):
    p=sites/e.MEMBERS['10'][0]
    if scenario=='zero':changed=before['10'].replace(b'handle /storage/v1/*',b'handle /different/*')
    elif scenario=='two':changed=before['10'].replace(b'\thandle /storage/v1/*',b'\thandle /storage/v1/* {\n\t\turi strip_prefix /storage/v1\n\t\treverse_proxy 127.0.0.1:18004\n\t}\n\thandle /storage/v1/*',1)
    elif scenario=='host':changed=before['10'].replace(b'api.commonswarm.com {',b'wrong.example {')
    else:changed=before['10'].replace(b'\t\turi strip_prefix /storage/v1',b'        uri strip_prefix /storage/v1')
    p.write_bytes(changed);d['BEFORE_SHA256_10']=sha(changed);write_inputs()
    label='wrong host block' if scenario=='host' else ('previous/live diff touches Storage block' if scenario=='storage-diff' else 'Storage block count or shape')
    refusal(session().preflight,label);assert p.read_bytes()==changed and not e.LOCK.exists()
elif scenario in ('http-allowed','http-denied','http-put','http-baseline'):
    s=session();s.preflight();s.apply();http_bad=scenario[5:]
    expected={'allowed':'allowed preflight failed','denied':'denied origin allowed','put':'upstream PUT CORS failed','baseline':'non-upload status changed'}
    refusal(s.verify,expected[http_bad]);s.rollback();exact_before();s.close('rolled-back')
elif scenario=='gate-drift':
    s=session();s.preflight();s.apply()
    p=sites/e.MEMBERS['10'][0];p.write_bytes(p.read_bytes().replace(b'PRIVATE_GATE',b'CHANGED_GATE'))
    refusal(s.verify,'live member drift');assert e.LOCK.exists()
else:raise AssertionError('unknown scenario')
print('PASS '+scenario)
`;

test('every kit-runner block and log helper parses', () => {
  const rows = [...readFileSync(plan, 'utf8').matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map(m => m[1]!);
  assert.equal(rows.length, 5);
  for (const row of rows) run('/bin/bash', ['-n'], row);
  for (const name of ['prepare-logs.sh', 'caddy-log-guards.sh']) {
    run('/bin/bash', ['-n', resolve('deploy/supabase-stack/caddy-live-edit', name)]);
  }
});

const cases = [
  ['pair', 'gated API preserves every outside byte; unchanged 11 yields the release source'],
  ['spaces', 'space-indented live Storage block admits the archive replacement'],
  ['staging', 'MEMBERS=10 staging validates identity and verifies only its local API'],
  ['hash', 'before hash mismatch refuses all writes'],
  ['zero', 'missing four-line Storage block refuses all writes'],
  ['two', 'duplicate Storage block refuses all writes'],
  ['host', 'Storage block in the wrong host refuses all writes'],
  ['diff-hash', 'unapproved previous/live diff refuses all writes'],
  ['storage-diff', 'previous/live change within Storage refuses all writes'],
  ['forbidden', 'any approved-window overlap with a refusal interval is rejected'],
  ['validate', 'validation failure restores exact pair bytes and metadata before recovery reload'],
  ['reload', 'reload failure restores exact pair bytes and metadata with recovery reload'],
  ['validate-ca-missing', 'validation failure restores the pair and closes after losing the probe CA'],
  ['reload-ca-missing', 'reload failure restores the pair and closes after losing the probe CA'],
  ['rollback-ca-missing', 'rollback without the probe CA restores bytes, owner, group, mode and owned lock state'],
  ['partial', 'partial-apply rollback restores both members after deadline expiry'],
  ['rename-failure', 'second rename failure triggers exact automatic pair restoration'],
  ['abort', 'aborted close proves baseline and never reloads'],
  ['abort-ca-missing', 'aborted close remains admitted without the probe CA'],
  ['ca-hash', 'HTTP verify still refuses an altered probe CA while rollback remains admitted'],
  ['http-allowed', 'verify rejects incorrect allowed-origin preflight'],
  ['http-denied', 'verify rejects ACAO on denied-origin preflight'],
  ['http-put', 'verify rejects upstream CORS credentials on bogus-token PUT'],
  ['http-baseline', 'verify rejects non-upload baseline status change'],
  ['gate-drift', 'verify refuses a changed live gate and retains the lock'],
] as const;
for (const [scenario, description] of cases) {
  test(description, () => {
    const r = run('python3', ['-', helper, plan, scratch, scenario], harness);
    assert.equal(r.stdout, `PASS ${scenario}\n`);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE_GATE|private upstream|admin_gate\) \{/);
  });
}
