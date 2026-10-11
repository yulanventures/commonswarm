/** U9 driver contracts: real source checkpoints, staging refusal and exclusive bound receipts.
 * Offline Python filesystem observations replace box identities; no service, Docker or browser. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const driver = new URL('../../scripts/c1-staging-u9/faults.py', import.meta.url).pathname;
const plan = new URL('../../docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md', import.meta.url).pathname;
const run = (code: string) => spawnSync('python3', ['-B', '-c', `import contextlib,pathlib,tempfile
with contextlib.ExitStack() as stack:
 root=pathlib.Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='u9-'))).resolve()
 exec(compile(${JSON.stringify(code)}, '<u9-test>', 'exec'))
`, driver, plan], { encoding: 'utf8' });

test('all three derived W4 bodies differ by one fault at the specified boundary', () => {
  const r = run(String.raw`
import importlib.util,pathlib,subprocess,sys
spec=importlib.util.spec_from_file_location('u9',sys.argv[1]); u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
blocks=u.preflight.blocks(pathlib.Path(sys.argv[2]).read_text()); original=blocks['ai-w4-apply']
for case in ('F1','F2','F3'):
 body=u.inject(original,case,'FAULT_RECEIPT')
 assert body.replace('FAULT_RECEIPT\nexit 97\n','')==original
 if case=='F2':
  assert body.index("pathlib.Path(sys.argv[3]).write_text") < body.index('FAULT_RECEIPT') < body.index('install -o root -g root -m 0644')
 assert subprocess.run(['/bin/bash','-n'],input=body,text=True,capture_output=True).returncode==0
 # Execute the actual anchor with harmless command functions: establish the
 # positive path and prove the sentinel following the selected point is skipped.
 anchor,after=u.CHECKPOINTS[case]
 control=('set -e\n'+('echo healthy\n' if case=='F2' else '')+'ln() { echo switch; }\ntimeout() { echo healthy; }\nai_run() { echo install; }\n'+anchor+'echo next\n')
 good=subprocess.run(['/bin/bash','-c',control],text=True,capture_output=True)
 bad=subprocess.run(['/bin/bash','-c',u.inject(control,case,'echo receipt')],text=True,capture_output=True)
 assert good.returncode==0 and 'next' in good.stdout
 assert bad.returncode==97 and 'next' not in bad.stdout and 'receipt' in bad.stdout
 assert ('switch' not in bad.stdout) if case=='F1' else (('healthy' if case=='F2' else 'install') in bad.stdout)
 for invalid in (original.replace(anchor,''),original+anchor):
  try: u.inject(invalid,case,'FAULT_RECEIPT')
  except ValueError: pass
  else: raise AssertionError('ambiguous/missing anchor accepted')
print('F1 F2 F3 positive and negative checkpoints PASS')
`);
  assert.equal(r.status, 0, r.stderr);
});

test('emission binds the real reviewed context, reuses rollback/close bytes and guards copied output', () => {
  const r = run(String.raw`
import contextlib,hashlib,importlib.util,io,json,os,pathlib,socket,stat,subprocess,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('u9',sys.argv[1]); u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
plan=str(pathlib.Path(sys.argv[2]).resolve()); source=pathlib.Path(plan).read_text()
d={'release_sha':'a'*40,'window':'W4','window_id':'Test12','plan_sha256':hashlib.sha256(source.encode()).hexdigest()}
inputs=root/'inputs.json'; inputs.write_text(json.dumps(d)); inputs.chmod(0o600)
marker=root/'marker'; marker.write_bytes(b'test-only-machine-bytes\n'); marker.chmod(0o600)
proof='/home/commonswarm/admin-issuance/release-proofs/'+d['release_sha']+'-W4-Test12'
local_proof=root/'proof'; local_proof.mkdir(mode=0o700)
real_open,real_stat,real_fstat,real_resolve=os.open,os.lstat,os.fstat,os.path.realpath
def local(p): return str(marker) if str(p)==u.guard.__globals__['MACHINE_ID'] else str(local_proof) if str(p)==proof else p
def owned(s): return os.stat_result((s.st_mode,s.st_ino,s.st_dev,s.st_nlink,0,0,s.st_size,s.st_atime,s.st_mtime,s.st_ctime))
with patch.object(os,'geteuid',return_value=0),patch.object(socket,'gethostname',return_value=u.HOST),patch.dict(u.guard.__globals__,digest=lambda raw:u.guard.__globals__['MACHINE_SHA256'] if raw==b'test-only-machine-bytes\n' else hashlib.sha256(raw).hexdigest()),patch.object(os,'open',side_effect=lambda p,*a:real_open(local(p),*a)),patch.object(os,'lstat',side_effect=lambda p:owned(real_stat(local(p)))),patch.object(os,'fstat',side_effect=lambda fd:owned(real_fstat(fd))),patch.object(os.path,'realpath',side_effect=lambda p:str(p) if str(p) in (u.guard.__globals__['MACHINE_ID'],proof) else real_resolve(p)):
 for action in ('fault','undo','close'):
  for case in ('F1','F2','F3'):
   sys.argv=['u9',action,case,plan,str(inputs),proof]; out=io.StringIO()
   with contextlib.redirect_stdout(out): u.main()
   body=out.getvalue()
   if action!='fault':
    expected=u.preflight.blocks(source)['ai-w4-rollback' if action=='undo' else 'ai-close']
    assert body.endswith(('CLOSE_RESULT=recovered\n' if action=='close' else '')+expected+'\n)\n')
   # Even a copied body in a matching shell refuses on the actual non-staging
   # host before any original service/rollback command can execute.
   shell_env=dict(os.environ,PLAN_FILE=plan,INPUTS_FILE=str(inputs),PROOF_DIR=proof,RELEASE_SHA=d['release_sha'],WINDOW='W4',WINDOW_ID='Test12')
   refused=subprocess.run(['/bin/bash','-c',body],env=shell_env,text=True,capture_output=True)
   assert refused.returncode==2 and 'STOP U9 fault driver' in refused.stderr
 # A valid positive context reaches plan/window checks, which then reject drift.
 for key,value in [('plan_sha256','0'*64),('window','W6')]:
  bad=dict(d,**{key:value}); inputs.write_text(json.dumps(bad))
  try: u.context(plan,str(inputs),proof)
  except ValueError: pass
  else: raise AssertionError('context drift accepted')
  inputs.write_text(json.dumps(d))
 assert u.context(plan,str(inputs),proof)[0]==d
`);
  assert.equal(r.status, 0, r.stderr);
});

test('off-staging refuses every action; a valid staging guard reaches the same file check', () => {
  const r = run(String.raw`
import importlib.util,os,socket,sys,io,hashlib,stat
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('u9',sys.argv[1]); u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
import common as c
class Machine(io.BytesIO):
 def fileno(self): return 9876
stage='29e448988c239181332e852c902c4c36815d628bb58cebc7da53c23f0f443565'; prod='6b63dad34fa7ced95e4f653aecb7e37ea7aa2a32902bdd593e23e93bb9877b22'
# An OS/hash double exists only in this test process. It verifies exact bytes,
# including newline, reach hashing; environment values cannot select identity.
with patch.object(os,'open',return_value=9876) as opened,patch.object(os,'fdopen',side_effect=lambda *a:Machine(b'exact-machine-bytes\n')),patch.object(os,'fstat',return_value=os.stat_result((stat.S_IFREG|0o444,1,1,1,0,0,20,0,0,0))),patch.object(os,'geteuid',return_value=0):
 for host,sha,ok in [('c1-staging-20261006',stage,True),('yulan-vps-1',prod,False),(c.HOST,prod,False),('yulan-vps-1',stage,False),(c.HOST,hashlib.sha256(b'c1-staging-disposable-no-production').hexdigest(),False)]:
  seen=[]
  def hash_bytes(raw): seen.append(raw); return sha
  with patch.object(socket,'gethostname',return_value=host),patch.object(c,'digest',side_effect=hash_bytes),patch.dict(os.environ,STAGING_ONLY='1',HOSTNAME=c.HOST,MACHINE_ID_SHA256=stage):
   receipt=c.identity(); assert set(receipt)=={'hostname','machine_id_sha256','measured_at'}
   try: c.guard()
   except ValueError: assert not ok
   else: assert ok
   assert seen==[b'exact-machine-bytes\n']*2
   assert all(call.args[0]=='/etc/machine-id' and call.args[1] & os.O_NOFOLLOW for call in opened.call_args_list)
 # A marker or environment claim cannot replace a missing measured file.
 with patch.object(socket,'gethostname',return_value='c1-staging-20261006'),patch.dict(os.environ,STAGING_ONLY='1',HOSTNAME=c.HOST,MACHINE_ID_SHA256=stage),patch.object(c,'read',return_value=b'c1-staging-disposable-no-production'),patch.object(os,'open',side_effect=FileNotFoundError):
  try: c.guard()
  except FileNotFoundError: pass
  else: raise AssertionError('missing machine-id accepted')
`);
  assert.equal(r.status, 0, r.stderr);
  for (const action of ['fault', 'undo', 'close', 'check', 'receipt']) {
    const refused = spawnSync('python3', ['-B', driver, action, 'F1', plan, '/missing-input', '/missing-proof'], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /STOP U9 fault driver/);
    assert.equal(refused.stdout, '');
  }
});

test('receipt uses exact nonsecret keys/mode, refuses overwrite; root-owned file read refuses wrong owner', () => {
  const r = run(String.raw`
import hashlib,importlib.util,json,os,pathlib,stat,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('u9',sys.argv[1]); u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
row={'release_sha':'a'*40,'window_id':'Test12','plan_sha256':'b'*64}
real=os.fstat
def metadata(fd,uid):
 s=real(fd); return os.stat_result((s.st_mode,s.st_ino,s.st_dev,s.st_nlink,uid,0,s.st_size,s.st_atime,s.st_mtime,s.st_ctime))
(root/'w4-state').mkdir(mode=0o700)
artifacts={'w4-state/roots-before.json':{'roots':['/etc/caddy'],'entries':{},'cutover':{}},'w4-state/recycle-baseline.json':{'mode':'upgrade-existing'},'keeper-retired.json':{'release_sha':row['release_sha'],'window_id':'Test12'}}
for name,value in artifacts.items(): (root/name).write_text(json.dumps(value)); (root/name).chmod(0o600)
with patch.object(os,'fchown') as owner,patch.object(u,'guard'),patch.object(os,'fstat',side_effect=lambda fd:metadata(fd,0)),patch.object(u.subprocess,'check_output',return_value=json.dumps([{'Id':'container-id','State':{'StartedAt':'start','Health':{'Status':'healthy'}},'Image':'sha256:image'}]).encode()):
 for case in ('F1','F2','F3'):
  cutover={'admin_issuance_enabled':False,'invalidated':case!='F3','release_generation':4,'measured_generation':3 if case!='F3' else 4}
  if case in ('F2','F3'):
   artifacts['edge-measurement.json']={'release_sha':row['release_sha']}; (root/'edge-measurement.json').write_text(json.dumps(artifacts['edge-measurement.json']))
  if case=='F3':
   artifacts['w4-state/install-after.json']={'mode':'upgrade-existing','archive':{'sha256':'c'*64}}; (root/'w4-state/install-after.json').write_text(json.dumps(artifacts['w4-state/install-after.json'])); (root/'w4-state/install-after.json').chmod(0o600)
  for bad in (dict(cutover,admin_issuance_enabled=True),dict(cutover,invalidated=not cutover['invalidated'])):
   try: u.receipt(case,row,str(root),bad)
   except ValueError: pass
   else: raise AssertionError('false boundary observation accepted')
  if case!='F1':
   with patch.object(u.subprocess,'check_output',return_value=b'[{"State":{"Health":{"Status":"unhealthy"}}}]'):
    try: u.receipt(case,row,str(root),cutover)
    except ValueError: pass
    else: raise AssertionError('unhealthy edge accepted')
  baseline=root/'w4-state/roots-before.json'; saved=baseline.read_bytes(); baseline.write_text('{}'); baseline.chmod(0o666)
  try: u.receipt(case,row,str(root),cutover)
  except ValueError: pass
  else: raise AssertionError('unprotected comparison input accepted')
  baseline.write_bytes(saved); baseline.chmod(0o600)
  assert not (root/('u9-'+case+'-injected.json')).exists()
  u.receipt(case,row,str(root),cutover); p=root/('u9-'+case+'-injected.json'); before=p.read_bytes()
  r=json.loads(before)
  assert set(r)=={'kind','case','host','release_sha','window','window_id','plan_sha256','checkpoint_sha256','exit_status','at','observation'}
  assert r['case']==case and r['exit_status']==97 and r['window_id']=='Test12' and r['host']=='c1-staging-20261006'
  assert r['window']=='W4' and r['release_sha']==row['release_sha']
  observation=r['observation']; assert observation['cutover']==cutover and observation['healthy'] is True
  assert observation['container']=={'id':'container-id','started_at':'start','image_digest':'sha256:image'}
  assert set(observation['artifacts'])==set(artifacts)
  for name,value in artifacts.items():
   ref=observation['artifacts'][name]; assert ref['path']==str(root/name) and ref['sha256']==hashlib.sha256((root/name).read_bytes()).hexdigest() and ref['value']==value
  assert observation['recycle_install']==('completed' if case=='F3' else 'not-run')
  assert stat.S_IMODE(p.stat().st_mode)==0o600
  try: u.receipt(case,row,str(root),cutover)
  except FileExistsError: pass
  else: raise AssertionError('overwrite accepted')
  assert p.read_bytes()==before
 assert owner.call_args_list[0].args[1:]==(0,0)
p=root/'u9-F1-injected.json'
with patch.object(os,'fstat',side_effect=lambda fd:metadata(fd,0)):
 assert u.read(p)==p.read_bytes()
with patch.object(os,'fstat',side_effect=lambda fd:metadata(fd,1000)):
 try: u.read(p)
 except ValueError: pass
 else: raise AssertionError('wrong owner accepted')
`);
  assert.equal(r.status, 0, r.stderr);
});

// These doubles replace host/filesystem observations only inside Python tests.
// Production has no configurable identity or backup path.
const localHarness = String.raw`
import contextlib,datetime,hashlib,importlib.util,io,json,os,pathlib,stat,sys,socket,subprocess
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
import common as c
import status as s
backup=root/'backup'; backup.mkdir(mode=0o700)
proof=root/'proof'; proof.mkdir(mode=0o700)
dump=root/'dump'; dump.mkdir(mode=0o700)
dump_file=dump/'database.dump'; dump_file.write_bytes(b'PGDMP actual dump bytes'); dump_file.chmod(0o600)
os.utime(dump_file,(c.now().timestamp()-5,)*2)
s.STATUS=str(backup/'status.json'); s.RESTORE=str(backup/'restore-status.json')
machine=root/'machine-id'; machine.write_bytes(b'test-machine-id-with-newline\n'); c.MACHINE_ID=str(machine)
real_digest,real_stat,real_fstat=c.digest,os.lstat,os.fstat
def real_rm(p):
 assert p.parent.resolve().is_relative_to(root)
 os.rmdir(p) if p.is_dir() and not p.is_symlink() else os.unlink(p)
def owned(meta,path=''):
 mode=meta.st_mode
 if str(path) in (tempfile.gettempdir(),str(pathlib.Path(tempfile.gettempdir()).resolve())): mode &= ~0o022
 fields={key:getattr(meta,key) for key in dir(meta) if key.startswith('st_')}
 return SimpleNamespace(**dict(fields,st_mode=mode,st_uid=0,st_gid=0))
stack.enter_context(patch.object(os,'geteuid',return_value=0))
stack.enter_context(patch.object(socket,'gethostname',return_value=c.HOST))
stack.enter_context(patch.object(c,'digest',side_effect=lambda raw:c.MACHINE_SHA256 if raw==machine.read_bytes() else real_digest(raw)))
stack.enter_context(patch.object(os,'lstat',side_effect=lambda p:owned(real_stat(p),p)))
stack.enter_context(patch.object(os,'fstat',side_effect=lambda fd:owned(real_fstat(fd))))
stack.enter_context(patch.object(os,'fchown'))
def invoke(action,name,source=None):
 with contextlib.redirect_stdout(io.StringIO()): s.run(action,str(proof/name),str(dump),str(proof/source) if source else None)
 return json.loads((proof/name).read_text())
def drill(**changes):
 row=dict(ok=True,state='complete',at=c.now().isoformat()); row.update(changes)
 p=pathlib.Path(s.RESTORE); p.write_text(json.dumps(row)); p.chmod(0o600)
def refuses(call,types=(ValueError,OSError,KeyError,TypeError)):
 try: call()
 except types: pass
 else: raise AssertionError('unsafe operation accepted')
`;

test('status uses the exact local contract, computed dump hash and exclusive protected files', () => {
  const r = run(localHarness + String.raw`
before=invoke('before','before.json'); assert before['restore_status']=={'exists':False,'sha256':None}
# Missing and unsuccessful drills refuse at their actual boundary.
refuses(lambda:invoke('write','writer.json','before.json'))
for changes in [{'ok':False},{'state':'failed'},{'at':(c.now()-datetime.timedelta(seconds=1801)).isoformat()}, {'at':(c.now()+datetime.timedelta(seconds=5)).isoformat()}, {'at':'2026-10-11T00:00:00'}]:
 drill(**changes); refuses(lambda:invoke('write','writer.json','before.json')); assert not os.path.lexists(s.STATUS)
drill(); writer=invoke('write','writer.json','before.json')
p=pathlib.Path(s.STATUS); raw=p.read_bytes(); row=json.loads(raw)
assert set(row)=={'destination','dump_sha256','drill','verified_at'}
assert row['destination']=='local-staging:'+str(dump) and row['dump_sha256']==hashlib.sha256(dump_file.read_bytes()).hexdigest()
assert row['drill']=='PASS' and c.utc(row['verified_at']).utcoffset().total_seconds()==0
assert stat.S_IMODE(p.stat().st_mode)==0o600 and writer['dump_sha256']==row['dump_sha256']
assert writer['restore_status']=={'exists':True,'sha256':hashlib.sha256(pathlib.Path(s.RESTORE).read_bytes()).hexdigest()}
refuses(lambda:invoke('write','overwrite.json','before.json')); assert p.read_bytes()==raw
real_rm(p); p.symlink_to(dump_file)
refuses(lambda:invoke('write','symlink.json','before.json')); assert dump_file.read_bytes().startswith(b'PGDMP')
real_rm(p)
with patch.object(socket,'gethostname',return_value='yulan-vps-1'):
 refuses(lambda:invoke('write','off-host.json','before.json'))
assert not p.exists()
# The mode and dump-file checks are real filesystem refusals.
dump.chmod(0o755); refuses(lambda:invoke('write','bad-dir.json','before.json')); dump.chmod(0o700)
dump_file.chmod(0o644); refuses(lambda:invoke('write','bad-dump.json','before.json')); dump_file.chmod(0o600)
`);
  assert.equal(r.status, 0, r.stderr);
});

test('remover validates both gates before any guarded call and retains bound before/absence receipts', () => {
  const r = run(localHarness + String.raw`
invoke('before','before.json'); drill(); writer=invoke('write','writer.json','before.json')
p=pathlib.Path(s.STATUS); q=pathlib.Path(s.RESTORE); raw=p.read_bytes(); restore=q.read_bytes()
log=root/'rm-argv.jsonl'; guarded=root/'guarded-rm'
guarded.write_text('#!'+sys.executable+'\nimport json,os,pathlib,sys\n'
 'assert pathlib.Path('+repr(str(proof/'removed.json.before'))+').is_file()\n'
 'assert len(sys.argv)==3 and sys.argv[1]=="--" and sys.argv[2] in '+repr((str(p),str(q)))+'\n'
 'p=pathlib.Path(sys.argv[2]); assert p.parent.resolve().is_relative_to(pathlib.Path('+repr(str(root))+'))\n'
 'with pathlib.Path('+repr(str(log))+').open("a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n'
 'os.unlink(p)\n'); guarded.chmod(0o700)
stack.enter_context(patch.dict(os.environ,U9_GUARDED_RM=str(guarded)))
def rejected():
 saved={str(f):f.lstat() if f.is_symlink() else f.read_bytes() for f in (p,q)}
 refuses(lambda:invoke('remove','removed.json','writer.json'))
 assert os.path.lexists(p) and os.path.lexists(q) and not log.exists()
 assert saved=={str(f):f.lstat() if f.is_symlink() else f.read_bytes() for f in (p,q)}
 assert not (proof/'removed.json.before').exists() and not (proof/'removed.json').exists()
link=root/'rm-link'; link.symlink_to(guarded)
(root/'not-executable').write_text('not executable')
for value in ('', 'guarded-rm', str(root/'rm-link'), str(root/'not-executable')):
 with patch.dict(os.environ,U9_GUARDED_RM=value): rejected()
with patch.dict(os.environ):
 os.environ.pop('U9_GUARDED_RM'); rejected()
for mode in (0o644,0o400):
 p.chmod(mode); rejected()
p.chmod(0o600)
for target in (p,q):
 inode=target.stat().st_ino
 def wrong(fd):
  m=owned(real_fstat(fd)); return os.stat_result((m.st_mode,m.st_ino,m.st_dev,m.st_nlink,1000,0,m.st_size,m.st_atime,m.st_mtime,m.st_ctime)) if m.st_ino==inode else m
 with patch.object(os,'fstat',side_effect=wrong): rejected()
 saved=target.read_bytes(); target.write_bytes(b'wrong sha'); rejected(); target.write_bytes(saved)
 real_rm(target); target.symlink_to(dump_file); rejected(); real_rm(target); target.write_bytes(saved); target.chmod(0o600)
for changed in [dict(writer['status'],dump_sha256='0'*64),dict(writer['status'],destination='r2:fake'),dict(writer['status'],extra=True)]:
 p.write_text(json.dumps(changed)); rejected()
p.write_bytes(raw)
with patch.object(socket,'gethostname',return_value='yulan-vps-1'): rejected()
assert q.read_bytes()==restore
untouched=backup/'unrelated.json'; untouched.write_text('preserve')
expected={str(f):dict(sha256=hashlib.sha256(f.read_bytes()).hexdigest(),size=f.stat().st_size,mtime_ns=f.stat().st_mtime_ns) for f in (p,q)}
removed=invoke('remove','removed.json','writer.json')
assert not os.path.lexists(p) and not os.path.lexists(q) and untouched.read_text()=='preserve'
assert [json.loads(line) for line in log.read_text().splitlines()]==[['--',str(p)],['--',str(q)]]
prior=proof/'removed.json.before'; before=json.loads(prior.read_text())
assert before['files']==expected and removed['files']==expected
assert before['writer_receipt_sha256']==hashlib.sha256((proof/'writer.json').read_bytes()).hexdigest()
assert removed['before_removal_receipt_sha256']==hashlib.sha256(prior.read_bytes()).hexdigest()
assert removed['absent']=={str(p):True,str(q):True} and removed['dump_sha256']==writer['dump_sha256']
assert removed['restore_status']=={'exists':False,'sha256':None}
assert before['identity']['machine_id_sha256']==c.MACHINE_SHA256 and stat.S_IMODE(prior.stat().st_mode)==0o600
after=invoke('after','after.json'); assert after['restore_status']=={'exists':False,'sha256':None}
# A guard refusal retains the durable pre-removal evidence and reports the path.
p.write_bytes(raw); p.chmod(0o600); q.write_bytes(restore); q.chmod(0o600)
guarded.write_text('#!'+sys.executable+'\nimport sys\nprint("fake guard refuses",file=sys.stderr)\nsys.exit(93)\n')
err=io.StringIO()
with contextlib.redirect_stderr(err): refuses(lambda:invoke('remove','refused.json','writer.json'))
assert p.read_bytes()==raw and q.read_bytes()==restore and (proof/'refused.json.before').exists()
assert not (proof/'refused.json').exists() and 'BLOCKED by rm guard:' in err.getvalue() and str(p) in err.getvalue()
`);
  assert.equal(r.status, 0, r.stderr);
});

const archiveHarness = localHarness + String.raw`
import archive as a
source=pathlib.Path(sys.argv[2]).read_text(); plan=str(pathlib.Path(sys.argv[2]).resolve())
d={'release_sha':'a'*40,'window':'W4','window_id':'Test12','plan_sha256':hashlib.sha256(source.encode()).hexdigest(),'keeper_upload_owner':'root'}
inputs=root/'inputs.json'; inputs.write_text(json.dumps(d)); inputs.chmod(0o600)
logical_proof='/home/commonswarm/admin-issuance/release-proofs/'+d['release_sha']+'-W4-Test12'
sha='b'*40; legacy='/tmp/admin-issuance-'+sha+'-Old123.tar'; durable='/var/lib/commonswarm-admin-release/archives/'+sha+'-Old123.tar'
rescue=root/'rescue'; rescue.mkdir(mode=0o700)
tar=root/'legacy.tar'; tar.write_bytes(b'exact legacy archive'); tar.chmod(0o600)
rescue_tar=rescue/'archive.tar'; rescue_tar.write_bytes(tar.read_bytes()); rescue_tar.chmod(0o600)
config={'release_sha':sha,'target':'/home/commonswarm/edge/releases/'+sha,'release_root':'/home/commonswarm/admin-issuance/releases/'+sha,'archive':legacy,'artifact_digest':hashlib.sha256(tar.read_bytes()).hexdigest()}
a.CONFIG=str(root/'config.json'); cfg=pathlib.Path(a.CONFIG); cfg.write_text(json.dumps(config,indent=3)+'\n'); cfg.chmod(0o600); raw_config=cfg.read_bytes()
a.HOOK=str(root/'hook'); hook=pathlib.Path(a.HOOK); hook.write_text('#!/bin/bash\n'+a.preflight.blocks(source)['ai-recycle-hook']); hook.chmod(0o700)
real_open,real_link,real_unlink,real_realpath,real_resolve=os.open,os.link,os.unlink,os.path.realpath,pathlib.Path.resolve
helper=root/'helper'; helper.mkdir(mode=0o700)
mapping={legacy:str(tar),durable:str(rescue_tar),str(pathlib.Path(durable).parent):str(rescue),config['release_root']:str(helper),'/tmp':str(root)}
def mapped(p):
 p=str(p)
 return str(proof)+p[len(logical_proof):] if p==logical_proof or p.startswith(logical_proof+'/') else mapping.get(p,p)
def resolved(p,strict=False):
 if str(p) in ('/home/commonswarm/edge/current','/home/commonswarm/admin-issuance/releases/'+sha):
  return pathlib.Path('/home/commonswarm/'+('edge' if 'edge/current' in str(p) else 'admin-issuance')+'/releases/'+sha)
 return real_resolve(p,strict=strict)
stack.enter_context(patch.object(os,'open',side_effect=lambda p,*args:real_open(mapped(p),*args)))
stack.enter_context(patch.object(os,'lstat',side_effect=lambda p:owned(real_stat(mapped(p)),mapped(p))))
stack.enter_context(patch.object(os.path,'realpath',side_effect=lambda p:str(p) if mapped(p)!=str(p) else real_realpath(p)))
stack.enter_context(patch.object(pathlib.Path,'resolve',resolved))
stack.enter_context(patch.object(os,'link',side_effect=lambda src,dst,**kw:real_link(mapped(src),mapped(dst),**kw)))
stack.enter_context(patch.object(os,'unlink',side_effect=lambda p:real_unlink(mapped(p))))
state={'timer':'active','service':'inactive','result':'success','started':'before-start','journal':'FAIL recycle hook; issuance state UNKNOWN (no confirming readback)'}
def command(*args):
 if args[0]=='docker': return json.dumps([{'State':{'StartedAt':state['started'],'Health':{'Status':'healthy'}},'Image':'sha256:'+'c'*64,'Mounts':[]}])
 if args[0]=='journalctl': return state['journal']
 if args[:2]==('systemctl','stop'): state['timer']='inactive'; return ''
 if '--property=ExecStartPre' in args: return '{ path='+a.HOOK+' ; argv[]='+a.HOOK+' before ; code=exited ; status=1 }'
 if '--property=ActiveState' in args: return state['timer'] if a.TIMER in args else state['service']
 if '--property=Result' in args: return state['result']
 raise AssertionError(args)
stack.enter_context(patch.object(a,'command',side_effect=command))
cutover={'admin_issuance_enabled':False,'release_generation':1,'measured_generation':1,'invalidated':False,'release_sha':sha,'target':config['target'],'mount':config['target'],'image_digest':'sha256:'+'c'*64,'artifact_digest':config['artifact_digest']}
def phase(name,rc=0):
 sys.argv=['archive','execute',name,plan,str(inputs),logical_proof,str(rc)]
 with patch.object(sys,'stdin',io.StringIO(json.dumps(cutover))): a.main()
 return json.loads((proof/('u9-ARCH-'+name+'.json')).read_text())
`;

test('ARCH 1–3 emit guarded bodies and retain bound loss/recovery receipts with exact restoration', () => {
  const r = run(archiveHarness + String.raw`
for step in ('1','2','3','undo'):
 sys.argv=['archive',step,plan,str(inputs),logical_proof]; out=io.StringIO()
 with contextlib.redirect_stdout(out): a.main()
 body=out.getvalue()
 if step=='2': assert 'systemctl start '+a.SERVICE+' || U9_ARCH_RC=$?' in body and 'u9_arch negative "$U9_ARCH_RC"' in body
 if step in ('3','undo'): assert body.index('u9_arch restore') < body.index('systemctl reset-failed '+a.SERVICE) < body.index('systemctl start '+a.SERVICE)
 else: assert 'reset-failed' not in body
 assert subprocess.run(['/bin/bash','-n'],input=body,text=True,capture_output=True).returncode==0
 shell_env=dict(os.environ,PLAN_FILE=plan,INPUTS_FILE=str(inputs),PROOF_DIR=logical_proof,RELEASE_SHA=d['release_sha'],WINDOW='W4',WINDOW_ID=d['window_id'])
 refused=subprocess.run(['/bin/bash','-c',body],env=shell_env,text=True,capture_output=True)
 assert refused.returncode==2 and 'STOP U9 ARCH' in refused.stderr
before=phase('before'); assert state['timer']=='inactive'
assert (proof/'u9-ARCH-config.json').read_bytes()==raw_config
assert set(before)=={'kind','phase','release_sha','window','window_id','plan_sha256','identity','observation','service_exit','archive_owner','archive_mode','aside','archive_identity','aside_identity','config_bytes_sha256'}
cutover['release_generation']=cutover['measured_generation']=2; state['started']='positive-start'
phase('positive'); loss=phase('loss'); assert not tar.exists() and (proof/'u9-ARCH-legacy.tar').exists() and rescue_tar.exists()
state.update(service='failed',result='exit-code')
# A restart, missing UNKNOWN, successful exit or unreadable/open DB cannot pass the negative.
state['started']='unexpected-restart'; refuses(lambda:phase('negative',1)); state['started']='positive-start'
refuses(lambda:phase('negative',0))
state['journal']='FAIL recycle hook; issuance readback unavailable'; refuses(lambda:phase('negative',1)); assert not (proof/'u9-ARCH-negative.json').exists()
state['journal']='FAIL recycle hook; issuance state UNKNOWN (no confirming readback)'
cutover['admin_issuance_enabled']=True; refuses(lambda:phase('negative',1)); cutover['admin_issuance_enabled']=False
negative=phase('negative',1); assert negative['unknown_observed'] is True
assert set(loss)==set(negative)-{'unknown_observed','journal_sha256'}
phase('restore'); assert tar.read_bytes()==rescue_tar.read_bytes() and not (proof/'u9-ARCH-legacy.tar').exists() and cfg.read_bytes()==raw_config
assert stat.S_IMODE(tar.stat().st_mode)==0o600
state.update(service='inactive',result='success',started='recovered-start'); cutover['release_generation']=cutover['measured_generation']=3
phase('recovered'); state['timer']='active'; done=phase('done')
assert done['observation']['timer_active']=='active' and done['window_id']=='Test12'
assert len(list(proof.glob('u9-ARCH-*.json')))==8
`);
  assert.equal(r.status, 0, r.stderr);
});


test('ARCH entry point retries failed copies and proof writes; undo rejects drift and foreign files', () => {
  for (const scenario of ['exdev', 'copy-fsync', 'copy-dir-fsync', 'snapshot-fsync', 'receipt-fsync', 'foreign-aside', 'foreign-snapshot', 'symlink-aside', 'unlink', 'shared', 'digest']) {
    const r = run(archiveHarness + `
scenario=${JSON.stringify(scenario)}
` + String.raw`
import errno
aside=proof/'u9-ARCH-legacy.tar'; expected=tar.read_bytes(); snapshot=proof/'u9-ARCH-config.json'
fsync=os.fsync
if scenario=='symlink-aside':
 # Translate box paths before the real canonical/realpath checks (Mac /home is a symlink).
 canonical=c.canonical
 def local_canonical(p):
  canonical(mapped(p)); return str(p)
 stack.enter_context(patch.object(c,'canonical',side_effect=local_canonical))
 stack.enter_context(patch.object(a,'canonical',side_effect=local_canonical))
 context,logical_paths=a.context,os.path.realpath
 def admitted_context(*args):
  # Admission checks the box's logical proof name; execution checks real temp paths.
  with patch.object(os.path,'realpath',side_effect=logical_paths): return context(*args)
 stack.enter_context(patch.object(a,'context',side_effect=admitted_context))
 stack.enter_context(patch.object(os.path,'realpath',side_effect=real_realpath))
if scenario=='exdev':
 def cross_device(p,*args):
  if str(p)==logical_proof+'/u9-ARCH-legacy.tar': raise OSError(errno.EXDEV,'injected copy failure')
  return real_open(mapped(p),*args)
 with patch.object(os,'open',side_effect=cross_device): refuses(lambda:phase('before'))
elif scenario=='digest':
 def corrupt(p,owner=(0,0)):
  return b'corrupt copy' if str(p)==logical_proof+'/u9-ARCH-legacy.tar' else c.read(p,owner)
 with patch.object(a,'read',side_effect=corrupt): refuses(lambda:phase('before'))
elif scenario.endswith('fsync'):
 target={'copy-fsync':aside,'copy-dir-fsync':proof,'snapshot-fsync':snapshot,'receipt-fsync':proof/'u9-ARCH-before.json'}[scenario]
 failed=[]
 def fail_sync(fd):
  if not failed and target.exists() and real_fstat(fd).st_ino==real_stat(target).st_ino:
   failed.append(True); raise OSError(errno.EIO,'injected fsync failure')
  return fsync(fd)
 with patch.object(os,'fsync',side_effect=fail_sync): refuses(lambda:phase('before'))
 assert failed==[True]
elif scenario=='symlink-aside':
 held=proof/'held-original'; failed=[]
 def symlink_then_fail(fd):
  receipt_path=proof/'u9-ARCH-before.json'
  if not failed and receipt_path.exists() and real_fstat(fd).st_ino==real_stat(receipt_path).st_ino:
   failed.append(True); real_link(aside,held); real_unlink(aside); aside.symlink_to(held)
   raise OSError(errno.EIO,'receipt failure after symlink replacement')
  return fsync(fd)
 with patch.object(os,'fsync',side_effect=symlink_then_fail): refuses(lambda:phase('before'))
 assert failed==[True] and aside.is_symlink() and aside.readlink()==held, 'symlink injection not reached/retained'
 assert held.read_bytes()==expected and state['timer']=='active'
 assert not snapshot.exists(), 'symlinked aside stranded its config snapshot'
 assert not (proof/'u9-ARCH-before.json').exists()
 real_unlink(aside); real_unlink(held)
elif scenario.startswith('foreign-'):
 target=aside if scenario=='foreign-aside' else snapshot
 held=proof/'held-original'; failed=[]
 def replace_then_fail(fd):
  receipt_path=proof/'u9-ARCH-before.json'
  if not failed and receipt_path.exists() and real_fstat(fd).st_ino==real_stat(receipt_path).st_ino:
   failed.append(True); real_link(target,held); real_unlink(target)
   target.write_bytes(b'foreign replacement'); target.chmod(0o600)
   raise OSError(errno.EIO,'receipt failure after inode replacement')
  return fsync(fd)
 with patch.object(os,'fsync',side_effect=replace_then_fail): refuses(lambda:phase('before'))
 assert failed==[True] and target.read_bytes()==b'foreign replacement'
 assert not (snapshot if target==aside else aside).exists()
 real_unlink(target); real_unlink(held)
if scenario not in ('unlink','shared'):
 assert tar.read_bytes()==expected and rescue_tar.read_bytes()==expected and state['timer']=='active'
 assert not aside.exists(), 'failed before stranded its aside'
 assert not snapshot.exists(), 'failed before stranded its config snapshot'
 assert not (proof/'u9-ARCH-before.json').exists(), 'failed before stranded its receipt'
# Scope fsync observations to the aside copy, excluding snapshot/receipt writes.
seen=[]; copy=a.copy_bytes
def observed_copy(p,*args):
 if str(p)!=logical_proof+'/u9-ARCH-legacy.tar': return copy(p,*args)
 def synced(fd):
  meta=real_fstat(fd); seen.append(([meta.st_dev,meta.st_ino],stat.S_IFMT(meta.st_mode))); return fsync(fd)
 with patch.object(os,'fsync',side_effect=synced): return copy(p,*args)
# Cross-device link/rename is never required by the successful retry.
with patch.object(a,'copy_bytes',side_effect=observed_copy),patch.object(os,'link',side_effect=OSError(errno.EXDEV,'cross-device')):
 before=phase('before')
assert seen==[(before['aside_identity'],stat.S_IFREG),([real_stat(proof).st_dev,real_stat(proof).st_ino],stat.S_IFDIR)]
assert aside.read_bytes()==expected and snapshot.read_bytes()==raw_config and state['timer']=='inactive'
cutover['release_generation']=cutover['measured_generation']=2; state['started']='positive-start'; phase('positive')
if scenario=='unlink':
 def fail(p):
  if str(p)==legacy: raise PermissionError(errno.EACCES,'injected unlink refusal')
  return real_unlink(mapped(p))
 with patch.object(os,'unlink',side_effect=fail): refuses(lambda:phase('loss'))
 assert tar.read_bytes()==aside.read_bytes()==expected and not (proof/'u9-ARCH-loss.json').exists()
elif scenario=='shared':
 # Interrupted old link-based restoration: original points to the owned aside.
 real_unlink(tar); real_link(aside,tar)
 assert tar.stat().st_nlink==aside.stat().st_nlink==2
else:
 phase('loss'); assert not tar.exists() and aside.read_bytes()==expected
 if scenario=='digest':
  aside.write_bytes(b'corrupted archive'); refuses(lambda:phase('restore')); assert not tar.exists()
  aside.write_bytes(expected)
  # Exclusive restore cannot overwrite or remove someone else's legacy file.
  tar.write_bytes(b'foreign'); tar.chmod(0o600); refuses(lambda:phase('restore')); assert tar.read_bytes()==b'foreign'
  real_unlink(tar)
  # An identically valued replacement aside is still not our inode.
  held=proof/'held-aside'; real_link(aside,held); real_unlink(aside); aside.write_bytes(expected); aside.chmod(0o600)
  refuses(lambda:phase('restore')); assert aside.read_bytes()==expected and not tar.exists()
  real_unlink(aside); real_link(held,aside); real_unlink(held)
phase('restore')
assert tar.read_bytes()==expected and tar.stat().st_nlink==1 and not aside.exists()
assert stat.S_IMODE(tar.stat().st_mode)==before['archive_mode']==0o600 and rescue_tar.read_bytes()==expected
state.update(service='inactive',result='success',started='recovered-start'); cutover['release_generation']=cutover['measured_generation']=3
phase('recovered'); state['timer']='active'; phase('done')
`);
    assert.equal(r.status, 0, `${scenario}: ${r.stderr}`);
  }
});
