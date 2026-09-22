#!/usr/bin/env python3
"""Fault controls for the real drill orchestration; no Docker or cloud access."""
import base64
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

    def test_old_drill_directories_stay_inside_the_keep_bound(self):
        self.assertEqual(drill.DRILL_WORKDIR_KEEP, 2)
        base = self.root / 'work'
        base.mkdir()
        outside = self.root / 'outside-evidence'
        outside.mkdir()
        (outside / 'keep-me').write_text('safe')
        for index, name in enumerate(('a' * 32, 'b' * 32, 'c' * 32)):
            directory = base / name
            directory.mkdir()
            (directory / 'database.dump').write_text('dump')
            os.utime(directory, (1000 + index, 1000 + index))
        (base / ('a' * 32) / 'leak').symlink_to(outside / 'keep-me')
        os.utime(base / ('a' * 32), (1000, 1000))
        (base / 'notes.txt').write_text('keep')
        (base / 'not-a-drill').mkdir()
        (base / 'not-a-drill' / 'keep').write_text('keep')
        (base / ('d' * 32)).symlink_to(outside, target_is_directory=True)
        self.assertEqual(drill.main(), 0)
        remaining = sorted(
            path.name for path in base.iterdir()
            if path.is_dir() and not path.is_symlink() and len(path.name) == 32 and all(c in '0123456789abcdef' for c in path.name)
        )
        self.assertEqual(len(remaining), drill.DRILL_WORKDIR_KEEP)
        self.assertIn('c' * 32, remaining)
        self.assertNotIn('a' * 32, remaining)
        self.assertNotIn('b' * 32, remaining)
        self.assertTrue((base / 'notes.txt').is_file())
        self.assertTrue((base / 'not-a-drill' / 'keep').is_file())
        self.assertTrue((base / ('d' * 32)).is_symlink())
        self.assertEqual((outside / 'keep-me').read_text(), 'safe')


class TempCredentialTests(unittest.TestCase):
    def test_minted_scope_is_object_read_only(self):
        prefix = '000-commonswarm-postgres/abc/objects/commonswarm'
        payload = json.dumps({'r2': {
            'access_key_id': 'parent-access-key',
            'secret_access_key': 'parent-secret-key',
            'endpoint': 'https://accountid.r2.cloudflarestorage.com',
        }})
        def rclone(args, **kwargs):
            if args[:3] != ['rclone', 'config', 'dump']:
                raise AssertionError('unexpected command')
            return subprocess.CompletedProcess(args, 0, payload, '')
        with patch.object(drill, 'run_cmd', side_effect=rclone):
            endpoint, access_key, _digest, session = drill.generate_temp_credentials(prefix)
        self.assertEqual(endpoint, 'https://accountid.r2.cloudflarestorage.com')
        self.assertEqual(access_key, 'parent-access-key')
        token = base64.b64decode(session).decode()
        self.assertTrue(token.startswith('jwt/'))
        segment = token[len('jwt/'):].split('.')[1]
        segment += '=' * (-len(segment) % 4)
        claims = json.loads(base64.urlsafe_b64decode(segment))
        self.assertEqual(claims['scope'], 'object-read-only')
        self.assertEqual(claims['paths'], {'prefixPaths': [prefix + '/']})
        self.assertEqual(claims['bucket'], 'yulan-vps-1-backups')


class UnitFileTests(unittest.TestCase):
    def text(self, name):
        return Path(__file__).with_name(name).read_text()

    def test_services_depend_on_docker_and_timers_name_their_units(self):
        for name in ('commonswarm-postgres-backup.service', 'commonswarm-postgres-restore.service'):
            unit = self.text(name)
            self.assertIn('After=network-online.target docker.service\n', unit)
            self.assertIn('Requires=docker.service\n', unit)
        self.assertIn('Unit=commonswarm-postgres-backup.service\n', self.text('commonswarm-postgres-backup.timer'))
        self.assertIn('Unit=commonswarm-postgres-restore.service\n', self.text('commonswarm-postgres-restore.timer'))

    def test_backup_and_restore_share_one_lock(self):
        self.assertEqual(drill.LOCK_PATH, '/var/lock/commonswarm-postgres-maintenance.lock')
        self.assertIn(drill.LOCK_PATH, self.text('run-backup.sh'))
        self.assertIn('flock -n 9', self.text('run-backup.sh'))
        self.assertIn('LOCK_PATH', Path(__file__).with_name('restore-drill.py').read_text())

if __name__=='__main__':unittest.main()
