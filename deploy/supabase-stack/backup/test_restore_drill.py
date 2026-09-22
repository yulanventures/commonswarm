#!/usr/bin/env python3
"""Fault controls for the real drill orchestration; no Docker or cloud access."""
import datetime
import hashlib
import importlib.util
import json
import os
import signal
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('drill', Path(__file__).with_name('restore-drill.py'))
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class DrillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.name = '20260918T010000Z-' + 'a' * 32
        self.dest = drill.BACKUP_ROOT + '/' + self.name
        self.marker = dict(format='commonswarm-backup-v1', destination=self.dest, objects=1,
                           verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           database_bytes_verified=True, object_bytes_verified=True)
        for name in drill.REQUIRED_FILES:
            (self.source / name).write_text('fixture\n')
        (self.source / 'source-counts.tsv').write_text('auth.users|1\nstorage.objects|1\nswarm.agent_tokens|1\n')
        self.rows = [dict(bucket='b', name='n', version='v')]
        (self.source / 'storage-backend-objects.ndjson').write_text(json.dumps(self.rows[0])+'\n')
        (self.source / 'physical-object-keys.txt').write_text('commonswarm/b/n/v\n')
        (self.source / 'offsite-binding.json').write_text(json.dumps(dict(destination=self.dest, objects=1)))
        self.sums()
        self.calls = []
        self.label = None
        self.network = None
        self.resources = {'container': {}, 'network': {}}
        self.ip = '172.25.0.2'
        self.fail_script = None
        self.cleanup_fail = False
        self.owner_wrong = False
        self.results = [dict(index=0,status=200,matches=True)]
        self.patches = [patch.object(drill,'LOCK_PATH',str(self.root/'lock')),
                        patch.object(drill,'STATUS_FILE',str(self.root/'status.json')),
                        patch.object(drill,'WORKDIR_BASE',str(self.root/'work')),
                        patch.object(drill,'run_cmd',side_effect=self.command),
                        patch.object(drill,'generate_temp_credentials',return_value=('https://example.invalid','test','test','test')),
                        patch.object(drill,'fetch_offsite_bytes',return_value=[dict(self.rows[0],index=0,bytes=1,sha256='test')]),
                        patch.object(drill,'fetch_api_bytes',side_effect=lambda *args:self.results),
                        patch.object(drill.time,'sleep')]
        for p in self.patches:p.start()

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()

    def sums(self):
        (self.source/'SHA256SUMS').write_text(''.join(hashlib.sha256((self.source/n).read_bytes()).hexdigest()+'  '+n+'\n' for n in sorted(drill.REQUIRED_FILES)))

    def command(self,args,**kw):
        self.calls.append(args)
        output = ''
        if args[:2]==['rclone','lsf']:
            if args[2]==drill.BACKUP_ROOT:output=self.name+'/\n'
            else:output='COMPLETE.json\n'
        elif args[:2]==['rclone','cat']:output=json.dumps(self.marker)
        elif args[:2]==['rclone','copy']:shutil.copytree(self.source,args[3],dirs_exist_ok=True)
        elif args[:3]==['docker','network','create']:
            self.label=args[args.index('--label')+1]
            if '--internal' in args:self.network=args[-1]
            self.resources['network'][args[-1]]=self.label
        elif args[:2] in (['docker','run'],['docker','create']):
            if '--name' in args:
                self.resources['container'][args[args.index('--name')+1]]=self.label
            if args[-1].startswith('/work/migrate/') and args[-1].endswith(str(self.fail_script)):
                return subprocess.CompletedProcess(args,1,'','injected partial restore')
        elif args[:2]==['docker','inspect']:
            output=json.dumps([{'Config':{'Labels':dict([self.label.split('=',1)])},'HostConfig':{'PortBindings':{}},
                               'NetworkSettings':{'Networks':{self.network:{'IPAddress':self.ip}}}}])
        elif args[:2]==['docker','exec'] and 'psql' in args[-1]:
            output='off\n' if 'pg_settings' in kw.get('input','') else '1\n'
        elif args[:3]==['docker','ps','-aq']:output='\n'.join(self.resources['container'])
        elif args[:3]==['docker','network','ls']:output='\n'.join(self.resources['network'])
        elif args[0]=='docker' and args[1] in ('container','network') and args[2]=='inspect':
            rid=args[-1];label=self.resources[args[1]][rid]
            labels=dict([label.split('=',1)]) if not self.owner_wrong else {'unrelated':'true'}
            info={'Id':rid,'Labels':labels,'Config':{'Labels':labels}}
            output=json.dumps([info])
        elif args[:2]==['docker','rm'] or args[:3]==['docker','network','rm']:
            if self.cleanup_fail:raise subprocess.CalledProcessError(1,args)
            kind='container' if args[1]=='rm' else 'network'
            del self.resources[kind][args[-1]]
        return subprocess.CompletedProcess(args,0,output,'')

    def status(self):return json.loads((self.root/'status.json').read_text())

    def test_full_orchestration_success_and_cleanup(self):
        self.assertEqual(drill.main(),0)
        self.assertTrue(self.status()['ok'])
        self.assertEqual(self.status()['objects'],1)
        self.assertFalse(any(self.resources.values()))
        scripts=[a[-1] for a in self.calls if a[-1].startswith('/work/migrate/')]
        self.assertEqual(scripts, ['/work/migrate/'+s for s in ['restore-target.sh','prepare-target.sh','restore-cron-jobs.sh','verify-counts.sh']])
        self.assertFalse(list((self.root/'work').rglob('*.env')))
        self.assertFalse(list((self.root/'work').rglob('pass')))

    def test_partial_restore_fails_and_cleans(self):
        self.fail_script='prepare-target.sh'
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])
        self.assertFalse(any(self.resources.values()))
        self.assertFalse(any(a[-1].endswith('verify-counts.sh') for a in self.calls))

    def test_corrupt_file_fails(self):
        self.results=[dict(index=0,status=200,matches=False)]
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])
        self.assertFalse(any(self.resources.values()))

    def test_missing_api_result_fails(self):
        self.results=[]
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])

    def test_wrong_api_index_fails(self):
        self.results=[dict(index=9,status=200,matches=True)]
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])

    def test_production_address_refused_before_restore(self):
        self.ip='172.31.0.10'
        self.assertEqual(drill.main(),1)
        self.assertFalse(any(a[-1].startswith('/work/migrate/') for a in self.calls))
        self.assertFalse(any(self.resources.values()))

    def test_cleanup_error_cannot_report_success(self):
        self.cleanup_fail=True
        self.assertEqual(drill.main(),1)
        self.assertEqual(self.status()['state'],'cleanup_failed')
        self.assertFalse(self.status()['ok'])
        self.assertFalse(list((self.root/'work').rglob('*.env')))

    def test_unowned_resources_are_not_deleted(self):
        self.owner_wrong=True
        self.assertEqual(drill.main(),1)
        self.assertFalse(any(a[:2]==['docker','rm'] for a in self.calls))
        self.assertFalse(self.status()['ok'])

    def test_interrupt_still_cleans_and_fails(self):
        original=self.command
        def interrupted(args,**kw):
            if args[-1].endswith('restore-target.sh'):os.kill(os.getpid(), signal.SIGTERM)
            return original(args,**kw)
        with patch.object(drill,'run_cmd',side_effect=interrupted):self.assertEqual(drill.main(),1)
        self.assertFalse(any(self.resources.values()))
        self.assertFalse(self.status()['ok'])

    def test_bad_checksum_inventory_fails_before_docker(self):
        (self.source/'SHA256SUMS').write_text('')
        self.assertEqual(drill.main(),1)
        self.assertFalse(any(a[0]=='docker' and 'create' in a for a in self.calls))

    def test_corrupt_artifact_fails_before_docker(self):
        (self.source/'database.dump').write_text('corruption')
        self.assertEqual(drill.main(),1)
        self.assertFalse(any(a[0]=='docker' and 'create' in a for a in self.calls))

    def test_cardinality_mismatch_fails(self):
        (self.source/'storage-backend-objects.ndjson').write_text('')
        self.sums()
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])

    def test_newer_incomplete_snapshot_skipped(self):
        newer='20990101T000000Z-'+'b'*32
        original=self.command
        def listing(args,**kw):
            if args[:3]==['rclone','lsf',drill.BACKUP_ROOT]:return subprocess.CompletedProcess(args,0,newer+'/\n'+self.name+'/\n','')
            if args[:3]==['rclone','lsf',drill.BACKUP_ROOT+'/'+newer]:return subprocess.CompletedProcess(args,0,'','')
            return original(args,**kw)
        with patch.object(drill,'run_cmd',side_effect=listing):self.assertEqual(drill.find_backup(drill.BACKUP_ROOT)[0],self.dest)

    def test_stale_completed_backup_fails(self):
        self.marker['verified_at']='2020-01-01T00:00:00Z'
        self.assertEqual(drill.main(),1)
        self.assertFalse(self.status()['ok'])

if __name__=='__main__':unittest.main()
