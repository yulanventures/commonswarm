import importlib.util
import json
import os
import contextlib
import io
import stat
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('notify',Path(__file__).with_name('notify-healthcheck.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.config=self.root/'config';self.config.write_text('HC_BACKUP_URL=https://hc-ping.com/00000000-0000-0000-0000-000000000000\n');self.config.chmod(0o600)
        self.ps=[patch.object(n,'CONFIG',self.config),patch.object(n,'ROOT',self.root),patch.object(n,'ping'),patch.dict(os.environ,{'SERVICE_RESULT':'success','INVOCATION_ID':'1'*32})]
        for p in self.ps:p.start()
        n.notify('backup','start')
    def tearDown(self):
        for p in reversed(self.ps):p.stop()
        self.temp.cleanup()
    def status(self,ok=True):
        (self.root/'status.json').write_text(json.dumps(dict(ok=ok,database_bytes_verified=True,object_bytes_verified=True,invocation_id='1'*32)))
    def test_verified_fresh_success(self):
        self.status();n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'')
    def test_service_failure_overrides_green_file(self):
        self.status()
        with patch.dict(os.environ,{'SERVICE_RESULT':'timeout'}):n.notify('backup','finish')
        self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_stale_success_fails(self):
        self.status();p=self.root/'status.json';d=json.loads(p.read_text());d['invocation_id']='2'*32;p.write_text(json.dumps(d));n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_missing_status_fails(self):
        n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_false_status_fails(self):
        self.status(False);n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_missing_invocation_id_fails(self):
        self.status()
        with patch.dict(os.environ, {'INVOCATION_ID':''}):n.notify('backup','finish')
        self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_non_object_status_sends_failure(self):
        (self.root/'status.json').write_text('null')
        n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_unsafe_url_refused(self):
        self.config.write_text('HC_BACKUP_URL=https://example.invalid/secret\n')
        with self.assertRaises(ValueError):n.notify('backup','finish')
    def test_delivery_error_not_hidden(self):
        self.status();n.ping.side_effect=OSError('unavailable')
        with self.assertRaises(OSError):n.notify('backup','finish')
    def test_default_cli_matches_base_bytes(self):
        source=subprocess.check_output(['git','show','43c09b2a:deploy/supabase-stack/backup/notify-healthcheck.py'])
        base={"__name__":"base"};exec(compile(source,'<base-notifier>','exec'),base)
        for kind in ('backup','restore'):
            key,name,flags=n.KINDS[kind]
            self.config.write_text(key+'=https://hc-ping.com/00000000-0000-0000-0000-000000000000\n')
            for phase in ('start','finish','invalid'):
                results=[]
                for candidate in (base,n.__dict__):
                    candidate['CONFIG']=self.config;candidate['ROOT']=self.root
                    sent=[];previous=candidate['ping'];candidate['ping']=lambda url,suffix: sent.append((url,suffix))
                    (self.root/(kind+'-ping-start.json')).write_text(json.dumps({'invocation_id':'1'*32}))
                    (self.root/name).write_text(json.dumps(dict(ok=True,invocation_id='1'*32,**{f:True for f in flags})))
                    out,err=io.StringIO(),io.StringIO()
                    try:
                        with patch.object(sys,'argv',['notify-healthcheck.py',kind,phase]),patch.object(n.time,'time',return_value=123),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
                            code=candidate['main']()
                        results.append((code,out.getvalue().encode(),err.getvalue().encode(),sent,(self.root/(kind+'-ping-start.json')).read_bytes()))
                    finally: candidate['ping']=previous
                self.assertEqual(results[0],results[1],(kind,phase))

    def test_explicit_config_enforces_w4_metadata_and_single_key(self):
        config=self.root/'w4';config.write_text(self.config.read_text());config.chmod(0o600)
        info=config.lstat()
        def metadata(mode=stat.S_IFREG|0o600,uid=0,gid=0):
            return os.stat_result((mode,info.st_ino,info.st_dev,info.st_nlink,uid,gid,info.st_size,info.st_atime,info.st_mtime,info.st_ctime))
        for row in [metadata(uid=1000),metadata(gid=1000),metadata(mode=stat.S_IFREG|0o644),metadata(mode=stat.S_IFLNK|0o600)]:
            with patch.object(Path,'lstat',return_value=row):
                with self.assertRaises(ValueError):n.notify('backup','ok',config)
                with self.assertRaises(ValueError):n.notify('backup','fail',config)
        with patch.object(Path,'lstat',return_value=metadata()):
            for bad in ['HC_RESTORE_URL=https://hc-ping.com/00000000-0000-0000-0000-000000000000\n','HC_BACKUP_URL=https://example.invalid\n',self.config.read_text()*2]:
                config.write_text(bad)
                with self.assertRaises((ValueError,KeyError)):n.notify('backup','ok',config)
            config.write_text(self.config.read_text())
            for phase,suffix in [('ok',''),('fail','/fail')]:
                with patch.object(sys,'argv',['notify-healthcheck.py','backup',phase,'--config',str(config)]):self.assertEqual(n.main(),0)
                self.assertEqual(n.ping.call_args.args[-1],suffix)
        with self.assertRaises(FileNotFoundError):n.notify('backup','ok',self.root/'absent')
        with self.assertRaises(ValueError):n.notify('backup','ok',Path('relative'))

if __name__=='__main__':unittest.main()
