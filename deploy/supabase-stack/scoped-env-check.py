#!/usr/bin/env python3
"""Root-only gate: private Compose JSON on stdin; never emit input values."""
import base64,json,os,re,subprocess,sys,urllib.parse
from pathlib import Path
REGISTRY=Path('/etc/commonswarm-service-env/registry.json')
SERVICES=('postgrest','storage-api','gotrue','edge-runtime')
CONTAINERS={s:('commonswarm-edge-edge-runtime-1' if s=='edge-runtime' else 'commonswarm-'+s) for s in SERVICES}
IMAGE_REF=re.compile(r'(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?(?:@sha256:[0-9a-f]{64})?)')
class GateError(Exception):pass
def require(value,code):
 if not value:raise GateError(code)
def private_file(path):
 require(path.is_file() and not path.is_symlink() and path.resolve()==path,'private_file_path')
 st=path.stat();require((st.st_uid,st.st_gid,st.st_mode&0o777)==(0,0,0o600),'private_file_metadata')
def inspect(*args):
 return json.loads(subprocess.check_output(['docker',*args],stderr=subprocess.DEVNULL))[0]
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
def names(value):
 return isinstance(value,list) and bool(value) and all(isinstance(v,str) and re.fullmatch(r'[A-Z_][A-Z0-9_]*',v) for v in value) and len(value)==len(set(value))
def main():
 require(os.geteuid()==0,'requires_root');private_file(REGISTRY);registry=json.loads(REGISTRY.read_text())
 require(isinstance(registry,dict) and registry.get('version')==1,'registry_version')
 entries=registry.get('services');require(isinstance(entries,dict) and set(entries)==set(SERVICES),'registry_services')
 # Validate every entry before choosing a subset; default always means all four.
 for svc in SERVICES:
  meta=entries[svc];require(isinstance(meta,dict),'registry_metadata')
  require(meta.get('container')==CONTAINERS[svc] and meta.get('target_file')=='/etc/commonswarm-service-env/'+svc+'.env','registry_service_identity')
  require(names(meta.get('file_names')) and names(meta.get('expected_effective_names')) and set(meta['file_names'])<=set(meta['expected_effective_names']),'registry_names')
  image=meta.get('current_image');require(isinstance(image,str) and re.fullmatch(r'sha256:[0-9a-f]{64}',image),'registry_image_id')
  refs=meta.get('approved_image_refs');require(isinstance(refs,list) and 0<len(refs)<=20 and all(isinstance(v,str) and len(v)<=255 and IMAGE_REF.fullmatch(v) for v in refs) and len(refs)==len(set(refs)) and image in refs,'registry_image_refs')
 selected=sys.argv[1:] or list(SERVICES);require(len(selected)==len(set(selected)) and all(s in SERVICES for s in selected),'service_selection')
 model=json.load(sys.stdin);require(isinstance(model,dict) and isinstance(model.get('services'),dict),'compose_model')
 # A rendered value is never a subprocess argument until exact allowlist validation.
 for svc in selected:
  source=model['services'].get(svc);require(isinstance(source,dict),'compose_service')
  ref=source.get('image');require(isinstance(ref,str) and ref in entries[svc]['approved_image_refs'],'rendered_image_not_approved')
 admin=dict(x.split('=',1) for x in inspect('inspect','commonswarm-realtime')['Config']['Env'])['DB_PASSWORD'];require(bool(admin),'empty_admin_reference');out={}
 for svc in selected:
  meta=entries[svc];p=Path(meta['target_file']);private_file(p);lines=[l for l in p.read_text().splitlines() if l and not l.startswith('#')];require(all('=' in l for l in lines),'private_env_format');desired=dict(l.split('=',1) for l in lines);require(len(lines)==len(desired) and set(desired)==set(meta['file_names']),'private_env_names')
  source=model['services'][svc];require(source.get('environment')==desired,'rendered_env_delta')
  for value in desired.values():require(not any(admin in v for v in decoded(value)),'admin_credential_alias')
  image=inspect('image','inspect',source['image']);require(image['Id']==meta['current_image'],'resolved_image_delta');defaults=dict(x.split('=',1) for x in image['Config'].get('Env',[]));require(set(meta['expected_effective_names'])==set(desired)|set(defaults),'effective_name_metadata')
  out[svc]={'status':'PASS','names':sorted(desired),'admin_alias_matches':0,'image_id':image['Id']}
 print(json.dumps({'status':'PASS','services':out}))
if __name__=='__main__':
 try:main()
 except GateError as exc:print('STOP scoped env gate: '+str(exc),file=sys.stderr);sys.exit(1)
 except Exception:print('STOP scoped env gate: inspection_or_input_failure',file=sys.stderr);sys.exit(1)
