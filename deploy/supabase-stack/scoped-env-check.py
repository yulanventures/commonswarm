#!/usr/bin/env python3
"""Root-only release gate. Input is a private Compose JSON model on stdin.
No env value, credential or credential-derived fingerprint is printed.
"""
import base64,json,os,subprocess,sys,urllib.parse
from pathlib import Path
REGISTRY=Path('/etc/commonswarm-service-env/registry.json')
def require(value,message):
 if not value:raise RuntimeError(message)
def inspect(name):return json.loads(subprocess.check_output(['docker','inspect',name],stderr=subprocess.DEVNULL))[0]
def strings(value):
 if isinstance(value,dict):
  for v in value.values():yield from strings(v)
 elif isinstance(value,list):
  for v in value:yield from strings(v)
 elif isinstance(value,str):yield value
def decoded(value):
 seen={value};pending=[(value,0)]
 while pending:
  raw,depth=pending.pop()
  if depth>=2:continue
  candidates=[urllib.parse.unquote(raw)]
  try:candidates+=list(strings(json.loads(raw)))
  except (ValueError,TypeError):pass
  try:candidates.append(base64.b64decode(raw,validate=True).decode())
  except (ValueError,UnicodeError):pass
  try:
   if len(raw)%2==0:candidates.append(bytes.fromhex(raw).decode())
  except (ValueError,UnicodeError):pass
  for item in candidates:
   if item not in seen:seen.add(item);pending.append((item,depth+1))
 return seen
def main():
 require(os.geteuid()==0,'requires_root');require(REGISTRY.is_file() and not REGISTRY.is_symlink(),'missing_registry');registry=json.loads(REGISTRY.read_text());model=json.load(sys.stdin);selected=sys.argv[1:] or list(registry['services']);admin=dict(x.split('=',1) for x in inspect('commonswarm-realtime')['Config']['Env'])['DB_PASSWORD'];require(bool(admin),'empty_admin_reference');out={}
 for svc in selected:
  meta=registry['services'][svc];p=Path(meta['target_file']);st=p.stat();require(p.resolve()==p and not p.is_symlink() and (st.st_uid,st.st_gid,st.st_mode&0o777)==(0,0,0o600),'private_env_metadata_'+svc);desired=dict(l.split('=',1) for l in p.read_text().splitlines() if l and not l.startswith('#'));require(set(desired)==set(meta['file_names']),'private_env_name_set_'+svc)
  source=model['services'][svc];require(source.get('environment')==desired,'rendered_env_value_or_name_delta_'+svc)
  for name,value in desired.items():require(not any(admin in v for v in decoded(value)),'admin_credential_alias_'+svc+'_'+name)
  image=json.loads(subprocess.check_output(['docker','image','inspect',source['image']],stderr=subprocess.DEVNULL))[0];require(image['Id']==meta['current_image'],'unapproved_image_'+svc)
  out[svc]={'status':'PASS','names':sorted(desired),'admin_alias_matches':0,'image_id':image['Id']}
 print(json.dumps({'status':'PASS','services':out}))
if __name__=='__main__':
 try:main()
 except Exception as exc:print('STOP scoped env gate: '+str(exc),file=sys.stderr);sys.exit(1)
