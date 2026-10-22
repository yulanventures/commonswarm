# SOURCE ONLY / UNRUN. ROOT owns review, shared lock and assigned pe-ci-1 gap.
from pathlib import Path, PurePosixPath
import re, os, sys, json, hashlib, subprocess as sp, tarfile, io, shlex, socket, tempfile, stat, shutil
ROOT=Path('/Users/yulanbot/work/kylon-redesign')
CANDIDATE_CSS='site/src/styles/kylon-lists.css'
HEADS={'lists':'9ed6cda1796a7124df805e392ee8386412d2c9c2'}
TREE='9fc23475f2384098df486c58484af9634ea69e5c'
BASE='3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb';BASE_TREE='601c359061d8d3f9de9882e6391c9dbde965346c'
IMAGE='sha256:a1afd014aad702828c81cd6db16389dd4abbb943b89b04adf7c8b47ffcc3bc99'
SSH='/Users/yulanbot/work/pe-ci-hetzner/s';PREFIX='kylon-lists-images.';NAME=PREFIX[:-1]+'-';LIMIT=256*1024*1024
HELPERS={'run.py','job.sh','camera.mjs','native-owner.mjs','fixture-entry.ts','README.md','source-pins.json'}
FILES=HELPERS|{'tools/package.json','tools/package-lock.json'}
def frozen():
 if CANDIDATE_CSS!='site/src/styles/kylon-lists.css' or HEADS!={'lists':'9ed6cda1796a7124df805e392ee8386412d2c9c2'} or TREE!='9fc23475f2384098df486c58484af9634ea69e5c' or BASE!='3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb' or BASE_TREE!='601c359061d8d3f9de9882e6391c9dbde965346c':
  raise SystemExit('UNFROZEN: root must adopt the pushed candidate head, replace all pins, and read the complete diff before execution')
sha=lambda b:hashlib.sha256(b).hexdigest()
def save(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
def brief(e):
 if isinstance(e,(sp.CalledProcessError,sp.TimeoutExpired)):return type(e).__name__+' returncode='+str(getattr(e,'returncode',None))
 return type(e).__name__+': '+str(e)[:240]
def fact(b):return {'bytes':len(b),'sha256':sha(b)}
def members(tf):
 rows=tf.getmembers();seen=set();total=0;assert len(rows)<30000
 for r in rows:
  p=PurePosixPath(r.name);k=str(p)
  assert r.name==k and not p.is_absolute() and '..' not in p.parts and '\\' not in r.name
  assert k not in seen and (r.isfile() or r.isdir()) and 0<=r.size<=LIMIT;seen.add(k)
  if r.isfile():total+=r.size
  assert total<=LIMIT
 kinds={str(PurePosixPath(r.name)):r.isdir() for r in rows}
 for k in kinds:assert all(kinds.get(str(p),True) for p in PurePosixPath(k).parents)
 return rows
def docker(*args,timeout=30):return sp.check_output(['docker',*args],text=True,timeout=timeout)
def guard():
 frozen()
 assert os.geteuid()==0 and socket.gethostname().split('.')[0]=='pe-ci-1'
 p=sp.run(['pgrep','-x','Runner.Worker'],capture_output=True,timeout=10)
 assert p.returncode==1
 assert not docker('ps','-q').strip()
 image=json.loads(docker('image','inspect',IMAGE))[0]
 assert image['Id']==IMAGE and image['Config'].get('Volumes') in (None,{})
def root_path(s):
 assert s and '\\' not in s
 p=Path(s);assert p.is_absolute() and p.resolve()==p and not p.is_symlink()
 assert p.parent==Path('/var/tmp') and p.name.startswith(PREFIX) and len(p.name)>len(PREFIX)
 assert p.is_dir() and p.stat().st_uid==0
 marker=json.loads((p/'ownership.json').read_text())
 assert marker=={'heads':HEADS,'root':str(p),'image':IMAGE}
 return p
def owned(root):
 r=json.loads((root/'container.json').read_text())
 assert r['heads']==HEADS and r['root']==str(root) and r['image']==IMAGE
 assert r['name']==NAME+root.name.split('.')[-1]
 assert len(r['id'])==64 and all(c in '0123456789abcdef' for c in r['id'])
 return r
def inspect(r):
 q=sp.run(['docker','inspect',r['id']],capture_output=True,text=True,timeout=20)
 if q.returncode:
  assert not docker('ps','-aq','--filter','name=^/'+r['name']+'$').strip();return None
 o=json.loads(q.stdout)[0]
 assert o['Id']==r['id'] and o['Name']=='/'+r['name'] and o['Image']==IMAGE
 assert o['Config']['Labels'].get('kylon.images.root')==r['root']
 assert o['Config']['Labels'].get('kylon.images.job')=='lists-review-images'
 return o
def stop(root):
 if not (root/'container.json').exists():
  ids=docker('ps','-aq','--no-trunc','--filter','label=kylon.images.root='+str(root)).split();assert len(ids)<=1
  if not ids:return {'ownedContainers':0,'noContainerCreated':True}
  save(root/'container.json',{'heads':HEADS,'root':str(root),'image':IMAGE,'id':ids[0],'name':NAME+root.name.split('.')[-1]})
 r=owned(root);o=inspect(r)
 if o:
  if o['State']['Running']:docker('stop','--time','10',r['id'],timeout=30)
  docker('rm','-v',r['id'],timeout=20)
 assert not docker('ps','-aq','--filter','label=kylon.images.root='+str(root)).strip()
 return {'ownedContainers':0,'id':r['id'],'name':r['name']}
def extract(root,digest):
 assert sha((root/'input.tar').read_bytes())==digest
 with tarfile.open(root/'input.tar','r:') as tf:
  data={r.name:tf.extractfile(r).read() for r in members(tf) if r.isfile()}
 expected=json.loads(data.pop('input-files.json'));assert set(data)==FILES
 assert expected=={k:fact(v) for k,v in data.items()}
 target=root/'inputs';target.mkdir(mode=0o755)
 for name,b in data.items():
  p=target/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);p.chmod(0o644)
 for p in target.rglob('*'):
  assert not p.is_symlink()
  if p.is_dir():p.chmod(0o755)
 return target
def run_job(root,digest):
 guard();inputs=extract(root,digest);work=root/'work';work.mkdir(mode=0o700);os.chown(work,65534,65534)
 name=NAME+root.name.split('.')[-1];assert not docker('ps','-aq','--filter','name=^/'+name+'$').strip()
 cid=docker('create','--pull=never','--name',name,'--label','kylon.images.root='+str(root),'--label','kylon.images.job=lists-review-images',
  '--user','65534:65534','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','2g','--memory-swap','2g',
  '--pids-limit','256','--network','bridge','--mount','type=bind,src='+str(inputs)+',dst=/inputs,readonly',
  '--mount','type=bind,src='+str(work)+',dst=/tmp/qa','--workdir','/tmp/qa','--entrypoint','/usr/bin/env',IMAGE,
  '-i','PATH=/usr/local/bin:/usr/bin:/bin','/bin/sh','/inputs/job.sh').strip()
 r={'heads':HEADS,'root':str(root),'image':IMAGE,'id':cid,'name':name};save(root/'container.json',r);code=None;error=None
 try:
  o=inspect(r);c=o['HostConfig']
  assert o['Config']['User']=='65534:65534' and c['ReadonlyRootfs'] and c['NetworkMode']=='bridge' and c['PidMode']==''
  assert c['Memory']==c['MemorySwap']==2147483648 and c['NanoCpus']==2000000000 and c['PidsLimit']==256
  assert c['CapDrop']==['ALL'] and any(v.startswith('no-new-privileges') for v in c['SecurityOpt'])
  assert not c.get('PortBindings') and not c.get('PublishAllPorts') and len(o['Mounts'])==2
  assert {(m['Destination'],m['RW']) for m in o['Mounts']}=={('/inputs',False),('/tmp/qa',True)}
  assert {m['Destination']:m['Source'] for m in o['Mounts']}=={'/inputs':str(inputs),'/tmp/qa':str(work)}
  save(root/'container-inspect.json',o);docker('start',cid)
  code=int(docker('wait',cid,timeout=1500).strip());terminal=inspect(r)['State']
  assert not terminal['Running'] and terminal['ExitCode']==code;save(root/'container-terminal.json',terminal)
 except BaseException as e:error=brief(e)
 finally:
  try:
   with (root/'job.log').open('wb') as f:sp.run(['docker','logs',cid],stdout=f,stderr=sp.STDOUT,check=True,timeout=30)
  except BaseException as e:error=(error or '')+'; logs: '+brief(e)
  cleanup=stop(root);result={**r,'exitCode':code,'error':error,'cleanup':cleanup,'inputArchiveSha256':digest};save(root/'receipt.json',result)
 return result
def refusals(root):
 link=root/'delete-refusal-link';link.symlink_to(root,target_is_directory=True);rows=[]
 try:
  for label,value in [('empty',''),('root','/'),('parent','/var/tmp'),('home','/root'),('sibling','/var/tmp/unowned'),('symlink',str(link))]:
   try:root_path(value)
   except (AssertionError,OSError,ValueError):rows.append({'control':label,'refused':True})
   else:raise AssertionError(label)
 finally:link.unlink()
 assert len(rows)==6;save(root/'cleanup-controls.json',rows)
def results(root):
 cleanup=stop(root);refusals(root)
 if not (root/'receipt.json').exists():save(root/'receipt.json',{'heads':HEADS,'error':'No terminal receipt','cleanup':cleanup})
 selected=[root/n for n in ['ownership.json','receipt.json','container.json','container-inspect.json','container-terminal.json','job.log','cleanup-controls.json'] if (root/n).is_file()]
 for name in ['records','proofs','configs']:
  d=root/'work'/name
  if d.is_dir():
   for p in d.rglob('*'):
    assert not p.is_symlink() and p.resolve().is_relative_to(d)
    if p.is_file():selected.append(p)
 total=0;mapping={}
 for p in selected:
  assert not p.is_symlink() and p.resolve().is_relative_to(root) and stat.S_ISREG(p.stat().st_mode)
  b=p.read_bytes();total+=len(b);assert total<=LIMIT;mapping[str(p.relative_to(root))]=fact(b)
 save(root/'result-files.json',mapping);selected.append(root/'result-files.json')
 with tarfile.open(root/'results.tar','w:') as tf:
  for p in selected:tf.add(p,arcname=str(p.relative_to(root)),recursive=False)
 b=(root/'results.tar').read_bytes();assert len(b)<=LIMIT;return {'root':str(root),**fact(b)}
def remote_main():
 assert os.geteuid()==0 and socket.gethostname().split('.')[0]=='pe-ci-1'
 action=sys.argv[2]
 if action=='upload':
  guard();b=sys.stdin.buffer.read(LIMIT+1);assert len(b)<=LIMIT and sha(b)==sys.argv[3]
  root=Path(tempfile.mkdtemp(prefix=PREFIX,dir='/var/tmp'));root.chmod(0o755)
  save(root/'ownership.json',{'heads':HEADS,'root':str(root),'image':IMAGE});(root/'input.tar').write_bytes(b);(root/'input.tar').chmod(0o600)
  print(json.dumps({'root':str(root),**fact(b)}))
 elif action=='run':print(json.dumps(run_job(root_path(sys.argv[3]),sys.argv[4])))
 elif action=='stop':print(json.dumps(stop(root_path(sys.argv[3]))))
 elif action=='results':print(json.dumps(results(root_path(sys.argv[3]))))
 elif action=='read':sys.stdout.buffer.write((root_path(sys.argv[3])/'results.tar').read_bytes())
 elif action=='remove':
  root=root_path(sys.argv[3]);assert sha((root/'results.tar').read_bytes())==sys.argv[4]
  controls=json.loads((root/'cleanup-controls.json').read_text());assert len(controls)==6 and all(r['refused'] is True for r in controls)
  stop(root);name=root.name;shutil.rmtree(root);assert not root.exists();print(json.dumps({'removedOwnedRoot':name,'ownedContainers':0,'resultsSha256':sys.argv[4]}))
 else:raise ValueError()
def local_main():
 frozen() # Before output creation, helper/SSH reads, subprocesses, or resource actions.
 assert sys.platform=='darwin' and len(sys.argv)==2
 here=Path(__file__).resolve().parent;out=Path(sys.argv[1]);assert out.is_absolute() and out.resolve()==out and not out.exists() and out.parent==here/'generated'
 (here/'generated').mkdir(mode=0o700,exist_ok=True)
 out.mkdir(mode=0o700);state={'heads':HEADS};save(out/'state.json',state)
 def read(p):
  assert p.is_absolute() and p.resolve()==p and p.is_file() and not p.is_symlink();return p.read_bytes()
 data={n:read(here/n) for n in HELPERS}
 pins=json.loads(data['source-pins.json']);adoption=pins['adoption']
 source_metadata={adoption['file']:fact(read(ROOT/adoption['file']))}
 assert source_metadata[adoption['file']]=={'bytes':adoption['bytes'],'sha256':adoption['sha256']}
 save(out/'source-metadata-bindings-before.json',source_metadata)
 for n in ['job.sh','camera.mjs']:
  for h in HEADS.values():assert h.encode() in data[n]
  assert CANDIDATE_CSS.encode() in data[n]
 for n in ['package.json','package-lock.json']:data['tools/'+n]=read(ROOT/'candidate/linux-artifact-tools-v1'/n)
 assert sha(data['tools/package.json'])=='37dc2985db4eb6eccb6a70f7c8501811c6390f18b47f1da3a873ce255ce67e12'
 assert sha(data['tools/package-lock.json'])=='1eded2880b70774af425e63fdeed805feaa3ff13d9732b60a12bec4f100593e3'
 assert set(data)==FILES;mapping={n:fact(b) for n,b in data.items()};blob=io.BytesIO()
 with tarfile.open(fileobj=blob,mode='w:') as tf:
  for n,b in sorted({**data,'input-files.json':(json.dumps(mapping)+'\n').encode()}.items()):
   t=tarfile.TarInfo(n);t.size=len(b);t.mode=0o644;t.uid=t.gid=0;tf.addfile(t,io.BytesIO(b))
 archive=blob.getvalue();assert len(archive)<=LIMIT;(out/'inputs.tar').write_bytes(archive);code=read(Path(__file__).resolve()).decode();assert code.encode()==data['run.py'];ssh_binding=fact(read(Path(SSH)));save(out/'binding.json',{'run':fact(code.encode()),'sshWrapper':{SSH:ssh_binding},'inputs':mapping,'archive':fact(archive)})
 def remote(args,b=b'',timeout=120):return sp.check_output([SSH,'sudo -n python3 -I -c '+shlex.quote(code)+' '+shlex.join(['_remote',*args])],input=b,timeout=timeout)
 root=None;result=None;error=None;retrieved=False;removed=False
 try:
  upload=json.loads(remote(['upload',sha(archive)],archive,600));root=upload['root'];assert fact(archive)=={k:upload[k] for k in ['bytes','sha256']};save(out/'upload.json',upload)
  result=json.loads(remote(['run',root,sha(archive)],timeout=1620));save(out/'receipt.json',result)
 except BaseException as e:error=brief(e)
 finally:
  if root:
   try:save(out/'cleanup.json',json.loads(remote(['stop',root])))
   except BaseException as e:error=(error or '')+'; cleanup: '+brief(e)
   try:
    receipt=json.loads(remote(['results',root]));b=remote(['read',root],timeout=180);assert fact(b)=={k:receipt[k] for k in ['bytes','sha256']} and len(b)<=LIMIT
    (out/'results.tar').write_bytes(b)
    with tarfile.open(fileobj=io.BytesIO(b),mode='r:') as tf:rows={r.name:tf.extractfile(r).read() for r in members(tf) if r.isfile()}
    expected=json.loads(rows.pop('result-files.json'));assert expected=={n:fact(v) for n,v in rows.items()}
    dest=out/'retrieved';dest.mkdir(mode=0o700)
    for n,v in rows.items():p=dest/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(v)
    controls=json.loads(rows['cleanup-controls.json']);assert len(controls)==6 and all(r['refused'] is True for r in controls)
    save(out/'retrieval.json',receipt);retrieved=True
    save(out/'root-cleanup.json',json.loads(remote(['remove',root,receipt['sha256']])));removed=True
   except BaseException as e:error=(error or '')+'; retrieve: '+brief(e)
  try:
   source_metadata_after={n:fact(read(ROOT/n)) for n in source_metadata}
   save(out/'source-metadata-bindings-after.json',source_metadata_after);assert source_metadata_after==source_metadata
   save(out/'local-bindings-after.json',{'run':fact(read(Path(__file__).resolve())),'sshWrapper':{SSH:fact(read(Path(SSH)))},'inputs':{n:fact(read(here/n if not n.startswith('tools/') else ROOT/'candidate/linux-artifact-tools-v1'/n[6:])) for n in FILES}})
   assert read(Path(__file__).resolve()).decode()==code
   assert fact(read(Path(SSH)))==ssh_binding
   assert {n:fact(read(here/n if not n.startswith('tools/') else ROOT/'candidate/linux-artifact-tools-v1'/n[6:])) for n in FILES}==mapping
  except BaseException as e:error=(error or '')+'; local input drift: '+brief(e)
  state.update({'error':error,'exitCode':result.get('exitCode') if result else None,'remoteRoot':root,'retrieved':retrieved,'ownedRootRemoved':removed});save(out/'state.json',state)
 assert not error and result and result['exitCode']==0 and not result['error'] and retrieved and removed
if __name__=='__main__':
 frozen()
 if len(sys.argv)>1 and sys.argv[1]=='_remote':remote_main()
 else:local_main()
