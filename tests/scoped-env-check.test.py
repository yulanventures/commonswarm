"""CLI security boundary regressions; synthetic filesystem and Docker responses only.

Run: python3 tests/scoped-env-check.test.py
Protects fail-closed coverage and redacted failures. Existing box dry-run stubs
exercise deployment blocks, not this root-only gate. No production test seam.
"""
import base64,contextlib,copy,io,json,os,runpy,subprocess,sys,types,unittest,urllib.parse
from pathlib import Path
from unittest.mock import patch
SCRIPT=Path(__file__).resolve().parents[1]/'deploy/supabase-stack/scoped-env-check.py'
REG='/etc/commonswarm-service-env/registry.json'
SERVICES=('postgrest','storage-api','gotrue','edge-runtime')
SECRET='synthetic-must-never-appear'
class GateCLI(unittest.TestCase):
 def setUp(self):
  self.registry={'version':1,'services':{}};self.files={};self.model={'services':{}}
  for i,s in enumerate(SERVICES):
   image='sha256:'+str(i+1)*64;ref='fixture/'+s+':reviewed';p='/etc/commonswarm-service-env/'+s+'.env';self.registry['services'][s]={'container':('commonswarm-edge-edge-runtime-1' if s=='edge-runtime' else 'commonswarm-'+s),'target_file':p,'file_names':['CLIENT_ONLY'],'expected_effective_names':['CLIENT_ONLY','PATH'],'current_image':image,'approved_image_refs':[image,ref]};self.files[p]='CLIENT_ONLY=synthetic-client\n';self.model['services'][s]={'image':ref,'environment':{'CLIENT_ONLY':'synthetic-client'}}
  self.calls=[]
 def invoke(self,args=(),fail_inspect=False):
  fs={**self.files,REG:json.dumps(self.registry)};calls=self.calls;registry=self.registry
  class FixturePath:
   def __init__(self,p):self.p=str(p)
   def is_file(self):return self.p in fs
   def is_symlink(self):return False
   def resolve(self):return self
   def stat(self):return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o100600)
   def read_text(self):return fs[self.p]
  def docker(cmd,**kwargs):
   calls.append(cmd)
   if cmd==['docker','inspect','commonswarm-realtime']:return json.dumps([{'Config':{'Env':['DB_PASSWORD=synthetic-admin-password']}}]).encode()
   if fail_inspect:raise subprocess.CalledProcessError(1,['docker','image','inspect','postgres://role:'+SECRET+'@example/db'])
   for m in registry['services'].values():
    if cmd==['docker','image','inspect',m['approved_image_refs'][-1]]:return json.dumps([{'Id':m['current_image'],'Config':{'Env':['PATH=/fixture']}}]).encode()
   raise subprocess.CalledProcessError(1,cmd)
  stdout,stderr=io.StringIO(),io.StringIO();status=0
  with patch('pathlib.Path',FixturePath),patch('os.geteuid',return_value=0),patch('subprocess.check_output',side_effect=docker),patch.object(sys,'argv',[str(SCRIPT),*args]),patch.object(sys,'stdin',io.StringIO(json.dumps(self.model))),contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):
   try:runpy.run_path(str(SCRIPT),run_name='__main__')
   except SystemExit as exc:status=exc.code
  return status,stdout.getvalue(),stderr.getvalue()
 def test_default_covers_all_four_and_named_subset_is_explicit(self):
  status,out,err=self.invoke();self.assertEqual((status,err),(0,''));self.assertEqual(set(json.loads(out)['services']),set(SERVICES))
  status,out,err=self.invoke(['gotrue']);self.assertEqual((status,err),(0,''));self.assertEqual(list(json.loads(out)['services']),['gotrue'])
 def test_empty_partial_registry_cannot_pass(self):
  for entries in [{},{'postgrest':self.registry['services']['postgrest']}]:
   with self.subTest(entries=list(entries)):
    self.registry['services']=entries;status,out,err=self.invoke();self.assertNotEqual(status,0);self.assertEqual(out,'');self.assertIn('registry_services',err)
 def test_invalid_selection_is_rejected(self):
  for args in [[''],['unknown'],['gotrue','gotrue']]:
   with self.subTest(args=args):
    status,out,err=self.invoke(args);self.assertNotEqual(status,0);self.assertIn('service_selection',err)
 def test_incomplete_metadata_rejected_before_docker(self):
  del self.registry['services']['gotrue']['approved_image_refs'];status,out,err=self.invoke(['postgrest']);self.assertNotEqual(status,0);self.assertIn('registry_image_refs',err);self.assertEqual(self.calls,[])
 def test_untrusted_image_never_reaches_subprocess_or_output(self):
  self.model['services']['postgrest']['image']='postgres://role:'+SECRET+'@example/db';status,out,err=self.invoke(['postgrest']);self.assertNotEqual(status,0);self.assertIn('rendered_image_not_approved',err);self.assertNotIn(SECRET,out+err);self.assertEqual(self.calls,[])
 def test_subprocess_failure_is_redacted(self):
  status,out,err=self.invoke(['postgrest'],fail_inspect=True);self.assertNotEqual(status,0);self.assertEqual(out,'');self.assertNotIn(SECRET,err);self.assertIn('inspection_or_input_failure',err)
if __name__=='__main__':unittest.main()
