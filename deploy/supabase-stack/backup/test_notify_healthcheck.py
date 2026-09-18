import importlib.util
import json
import os
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
        self.ps=[patch.object(n,'CONFIG',self.config),patch.object(n,'ROOT',self.root),patch.object(n,'ping'),patch.dict(os.environ,{'SERVICE_RESULT':'success'})]
        for p in self.ps:p.start()
        n.notify('backup','start')
    def tearDown(self):
        for p in reversed(self.ps):p.stop()
        self.temp.cleanup()
    def status(self,ok=True):
        (self.root/'status.json').write_text(json.dumps(dict(ok=ok,database_bytes_verified=True,object_bytes_verified=True)))
    def test_verified_fresh_success(self):
        self.status();n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'')
    def test_service_failure_overrides_green_file(self):
        self.status()
        with patch.dict(os.environ,{'SERVICE_RESULT':'timeout'}):n.notify('backup','finish')
        self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_stale_success_fails(self):
        self.status();os.utime(self.root/'status.json',(1,1));n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_missing_status_fails(self):
        n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_false_status_fails(self):
        self.status(False);n.notify('backup','finish');self.assertEqual(n.ping.call_args.args[-1],'/fail')
    def test_unsafe_url_refused(self):
        self.config.write_text('HC_BACKUP_URL=https://example.invalid/secret\n')
        with self.assertRaises(ValueError):n.notify('backup','finish')
    def test_delivery_error_not_hidden(self):
        self.status();n.ping.side_effect=OSError('unavailable')
        with self.assertRaises(OSError):n.notify('backup','finish')
if __name__=='__main__':unittest.main()
