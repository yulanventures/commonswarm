#!/usr/bin/env python3
"""Fault controls for the real drill orchestration; no Docker or cloud access."""
import base64
import datetime
import hashlib
import importlib.util
import json
import os
import signal
import time
import traceback
from pathlib import Path
import shutil
import subprocess
import sys
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
        backup = self.text('run-backup.sh')
        self.assertIn(drill.LOCK_PATH, backup)
        self.assertIn('flock -n 9', backup)
        self.assertIn('LOCK_PATH', Path(__file__).with_name('restore-drill.py').read_text())
        source = Path(__file__).with_name('restore-drill.py').read_text()
        self.assertIn('counts the current run', source)
        self.assertIn('DRILL_WORKDIR_KEEP = 2', source)
        readme = Path(__file__).with_name('README.md').read_text()
        self.assertIn("current run's directory plus one earlier run", readme)
        self.assertIn('`DRILL_WORKDIR_KEEP = 2`', readme)
        for label, text in (
            ('README.md', readme),
            ('RUNBOOK.md', Path(__file__).resolve().parents[1].joinpath('RUNBOOK.md').read_text()),
        ):
            self.assertNotIn('try-restart', text, label)
            stop = text.index('systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer')
            check = text.index('systemctl is-active commonswarm-postgres-backup.service commonswarm-postgres-restore.service')
            switch = text.index('ln -sfn /home/commonswarm/stack/releases/<sha> /home/commonswarm/stack/current')
            reload = text.index('systemctl daemon-reload')
            start = text.index('systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer')
            listed = text.index('systemctl list-timers commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer')
            self.assertLess(stop, check, label)
            self.assertLess(check, switch, label)
            self.assertLess(switch, reload, label)
            self.assertLess(reload, start, label)
            self.assertLess(start, listed, label)
            self.assertIn('Do not proceed while either line is `active`', text, label)
            self.assertIn('Do not start', text, label)
            self.assertNotIn('systemctl start commonswarm-postgres-backup.service', text, label)
            self.assertNotIn('systemctl start commonswarm-postgres-restore.service', text, label)


BACKUP_LOCK_PATH = '/var/lock/commonswarm-postgres-maintenance.lock'
FLOCK_SHIM = '''#!/usr/bin/env python3
import fcntl
import sys
args = sys.argv[1:]
nonblock = False
shared = False
fd = None
for arg in args:
    if arg in ('-n', '--nb', '--nonblock'):
        nonblock = True
    elif arg in ('-s', '--shared'):
        shared = True
    elif arg in ('-x', '--exclusive'):
        shared = False
    elif arg.isdigit():
        fd = int(arg)
    else:
        sys.stderr.write('flock shim: unsupported arg %s\\n' % arg)
        sys.exit(2)
if fd is None:
    sys.exit(2)
op = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
if nonblock:
    op |= fcntl.LOCK_NB
try:
    fcntl.flock(fd, op)
except BlockingIOError:
    sys.exit(1)
sys.exit(0)
'''


def backup_lock_script():
    """The backup script's own lock lines, pointed at $LOCK_PATH."""
    lines = Path(__file__).with_name('run-backup.sh').read_text().splitlines()
    exec_line = next(line for line in lines if line.startswith('exec 9>'))
    flock_line = next(line for line in lines if line.startswith('flock '))
    if BACKUP_LOCK_PATH not in exec_line:
        raise AssertionError('backup lock path missing from exec line')
    exec_line = exec_line.replace(BACKUP_LOCK_PATH, '"$LOCK_PATH"')
    return '\n'.join([
        'set -euo pipefail',
        exec_line,
        flock_line,
        ': > "$WORK_MARKER"',
        'while [ ! -e "$RELEASE_PATH" ]; do sleep 0.05; done',
        '',
    ])


def maintenance_lock_child(argv):
    """Run restore-drill.main. role 'hold' waits inside the first command."""
    role, root_s, lock_path = argv
    root = Path(root_s)
    root.mkdir(parents=True, exist_ok=True)
    real_sleep = time.sleep
    case = DrillTests('test_full_orchestration_success_and_cleanup')
    case.setUp()
    held = {'value': False}
    original = case.command

    def wrapped(args, **kw):
        if role == 'hold' and not held['value']:
            held['value'] = True
            (root / 'drill-holding').write_text('1\n')
            while not (root / 'drill-release').exists():
                real_sleep(0.05)
        (root / 'drill-work').write_text('1\n')
        return original(args, **kw)

    overrides = [
        patch.object(drill, 'LOCK_PATH', lock_path),
        patch.object(drill, 'STATUS_FILE', str(root / 'status.json')),
        patch.object(drill, 'WORKDIR_BASE', str(root / 'work')),
        patch.object(drill, 'run_cmd', side_effect=wrapped),
    ]
    for item in overrides:
        item.start()
    try:
        return drill.main()
    finally:
        for item in reversed(overrides):
            item.stop()
        case.tearDown()


def shared_lock_probe(lock_path, work_marker):
    """Take a shared non-blocking lock. Exit 75 before any work if it is busy."""
    import fcntl
    fd = os.open(lock_path, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return 75
    os.close(fd)
    Path(work_marker).write_text('shared\n')
    return 0


class LockBehaviourTests(unittest.TestCase):
    def test_backup_and_drill_contend_on_a_temporary_lock(self):
        # Two processes use the backup script's flock line and restore-drill.main.
        # The second exits 75 before work. A shared probe must also fail: LOCK_SH
        # on the drill would let that probe take the lock.
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        lock_path = str(root / 'maintenance.lock')
        shim_dir = root / 'bin'
        shim_dir.mkdir()
        shim = shim_dir / 'flock'
        shim.write_text(FLOCK_SHIM)
        shim.chmod(0o755)
        procs = []

        def spawn(args, env=None):
            proc = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            procs.append(proc)
            return proc

        def finish(proc, timeout):
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
                self.close_pipes(proc)
                self.fail('process still running: %s' % proc.args)
            err = proc.stderr.read() if proc.stderr else ''
            self.close_pipes(proc)
            return code, err

        def start_backup(work_name, release_name):
            env = os.environ.copy()
            env['PATH'] = str(shim_dir) + os.pathsep + env.get('PATH', '')
            env['LOCK_PATH'] = lock_path
            env['WORK_MARKER'] = str(root / work_name)
            env['RELEASE_PATH'] = str(root / release_name)
            return spawn(['bash', '-c', backup_lock_script()], env)

        def start_drill(role, drill_root):
            return spawn([
                sys.executable, str(Path(__file__).resolve()),
                '--maintenance-lock-child', role, str(drill_root), lock_path,
            ])

        try:
            backup = start_backup('backup-work', 'backup-release')
            self.wait_until(root / 'backup-work', backup)
            contend_root = root / 'contend'
            drill_second = start_drill('contend', contend_root)
            code, err = finish(drill_second, 30)
            work_started = any((
                (contend_root / 'status.json').exists(),
                (contend_root / 'drill-work').exists(),
                (contend_root / 'work').exists(),
            ))
            self.assertEqual((code, work_started), (75, False), 'drill second exit=%s work=%s stderr=%s' % (code, work_started, err))
            (root / 'backup-release').write_text('1\n')
            backup_code, backup_err = finish(backup, 15)
            self.assertEqual(backup_code, 0, backup_err)

            hold_root = root / 'hold'
            drill_first = start_drill('hold', hold_root)
            self.wait_until(hold_root / 'drill-holding', drill_first)
            backup_second = start_backup('backup-second-work', 'backup-second-release')
            second_code, second_err = finish(backup_second, 15)
            self.assertEqual(second_code, 75, second_err)
            self.assertFalse((root / 'backup-second-work').exists())
            probe = spawn([
                sys.executable, str(Path(__file__).resolve()),
                '--shared-lock-probe', lock_path, str(root / 'shared-work'),
            ])
            probe_code, probe_err = finish(probe, 15)
            self.assertEqual((probe_code, (root / 'shared-work').exists()), (75, False), 'shared probe exit=%s stderr=%s' % (probe_code, probe_err))
            (hold_root / 'drill-release').write_text('1\n')
            hold_code, hold_err = finish(drill_first, 30)
            self.assertEqual(hold_code, 0, hold_err)
        finally:
            for proc in procs:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                self.close_pipes(proc)

    def close_pipes(self, proc):
        for pipe in (proc.stdout, proc.stderr):
            if pipe is not None and not pipe.closed:
                pipe.close()

    def wait_until(self, path, proc, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if path.exists():
                return
            if proc.poll() is not None:
                err = proc.stderr.read() if proc.stderr else ''
                self.close_pipes(proc)
                self.fail('%s exited %s before %s: %s' % (proc.args, proc.returncode, path.name, err))
            time.sleep(0.05)
        if proc.poll() is None:
            proc.kill()
        self.fail('timed out waiting for %s' % path.name)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--maintenance-lock-child':
        try:
            raise SystemExit(maintenance_lock_child(sys.argv[2:]))
        except SystemExit:
            raise
        except Exception:
            traceback.print_exc()
            raise SystemExit(99)
    if len(sys.argv) > 1 and sys.argv[1] == '--shared-lock-probe':
        try:
            raise SystemExit(shared_lock_probe(sys.argv[2], sys.argv[3]))
        except SystemExit:
            raise
        except Exception:
            traceback.print_exc()
            raise SystemExit(99)
    unittest.main()
