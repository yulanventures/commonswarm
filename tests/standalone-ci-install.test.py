"""Real-file installer regression; host identity/ACL/process boundaries are modeled.

Test-audit: protects migration from the deployed three-file inventory and exact
rollback, including absence. Rejects the original inventory bug, lost absence,
and deletion of a later replacement. No existing installer lifecycle coverage;
no production test seam. File hashing, atomic writes, locks and rollback are real.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import socket
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
SCRIPT = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else REPO / 'deploy/ci/install-status-relay.sh'
PROGRAM = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
NAMES = ('run.sh', 'suite.sh', 'retain.py', 'publish-status.py')
SHA = 'a' * 40


class Installation:
    def __init__(self, count=3):
        self.root = Path(tempfile.mkdtemp(prefix='status-install.')).resolve()
        self.install = self.root / 'install'
        self.state = self.root / 'state'
        self.backups = self.root / 'backups'
        self.source = self.root / 'source'
        self.acls = {}
        self.failure = None
        for path in (self.install / 'scripts', self.state / 'runs', self.source / 'scripts/standalone-ci'):
            path.mkdir(parents=True, mode=0o700)
        (self.state / 'queue.lock').touch(mode=0o600)
        for name in NAMES:
            (self.source / 'scripts/standalone-ci' / name).write_bytes((REPO / 'scripts/standalone-ci' / name).read_bytes())
        for name in NAMES[:count]:
            (self.install / 'scripts' / name).write_text('original ' + name)
            (self.install / 'scripts' / name).chmod(0o755)
        self.config = self.install / 'config.json'
        self.cfg = dict(state=str(self.state), controller=str(self.install / 'scripts'),
                        allowed_hostname='pe-ci-1', service_uid=2002, service_gid=2002,
                        controller_sha='c29188793839f66c3c968b41857b8750ca56ab99',
                        controller_checksums={name: hashlib.sha256((self.install / 'scripts' / name).read_bytes()).hexdigest() for name in NAMES[:count]})
        self.save_config()
        publisher = runpy.run_path(str(REPO / 'scripts/standalone-ci/publish-status.py'))
        for run_id in publisher['LEGACY']:
            run = self.state / 'runs' / run_id
            run.mkdir(mode=0o700)
            (run / 'receipt.json').write_text(json.dumps(dict(run_id=run_id, resolved_sha=SHA, suite='unit',
                state='completed', pending=False, exit_code=0, timed_out=False, cleanup_errors=[],
                started_at='2026-10-18T00:00:00Z', ended_at='2026-10-18T01:00:00Z')))
        self.original = self.snapshot()
        self.real_stat, self.real_lstat, self.real_fstat = Path.stat, Path.lstat, os.fstat
        self.real_open = os.open
        self.real_close = os.close
        self.real_replace = os.replace
        self.fds = {}

    def save_config(self):
        self.config.write_text(json.dumps(self.cfg))
        self.config.chmod(0o640)

    def snapshot(self):
        return {str(p.relative_to(self.install)): (p.read_bytes(), stat.S_IMODE(p.stat().st_mode))
                for p in self.install.rglob('*') if p.is_file()}

    def metadata(self, path, info):
        values = list(info)
        values[4] = values[5] = 2002 if path == self.state or self.state in path.parents else 0
        if path != self.root and self.root not in path.parents:
            values[0] &= ~0o022  # Platform parents: real deployment requires root/nonwritable.
        return os.stat_result(values)

    def opened(self, path, *args, **kwargs):
        fd = self.real_open(path, *args, **kwargs)
        self.fds[fd] = Path(path) if isinstance(path, (str, bytes, os.PathLike)) else self.root
        return fd

    def closed(self, fd):
        self.fds.pop(fd, None)
        return self.real_close(fd)

    def replaced(self, source, target):
        if self.failure == 'publisher-write' and target == self.install / 'scripts/publish-status.py':
            self.failure = None
            raise OSError('injected publisher replacement failure')
        return self.real_replace(source, target)

    def output(self, args, **kwargs):
        if args[0] == 'git':
            return str(self.source) + '\n' if args[-1] == '--show-toplevel' else SHA + '\n' if args[-1] == 'HEAD' else ''
        if args[0] == 'id':
            return '2003\n'
        if args[0] == 'getfacl':
            path = args[-1]
            entries = self.acls.get(path, ['user::rwx' if Path(path).is_dir() else 'user::rw-', 'group::---', 'other::---'])
            return '\n'.join(entries) if args[1] == '-cpn' else json.dumps([path, entries])
        if args[0] == 'setfacl':
            if args[1].startswith('--restore='):
                path, entries = json.loads(Path(args[1].split('=', 1)[1]).read_text())
                self.acls[path] = entries
            else:
                if self.failure == 'acl':
                    raise subprocess.CalledProcessError(1, args)
                uid, permission = args[2].split(',')[0].split(':')[1:]
                path = args[-1]
                self.acls[path] = ['user::rwx' if Path(path).is_dir() else 'user::rw-', 'group::---', 'other::---',
                                   f'user:{uid}:{permission}', 'mask::' + permission]
            return ''
        if args[0] == 'runuser':
            return ''  # Effective Linux ACL access remains Root's separate gate.
        raise AssertionError('unexpected subprocess ' + repr(args))

    def invoke(self, rollback=None):
        program = PROGRAM
        for original, replacement in (('/opt/commonswarm-ci', self.install), ('/var/lib/commonswarm-ci', self.state),
                                      ('/var/backups/commonswarm-status', self.backups)):
            program = program.replace(original, str(replacement))
        accounts = {name: types.SimpleNamespace(pw_uid=uid, pw_gid=uid, pw_dir=home) for name, uid, home in
                    [('gha', 2001, '/unused'), ('commonswarm-ci', 2002, '/unused'),
                     ('commonswarm-status', 2003, '/var/lib/commonswarm-status-runner')]}
        def process(args, **kwargs):
            assert args[0] in ('pgrep', 'runuser'), args
            return subprocess.CompletedProcess(args, 0 if args[0] == 'pgrep' and 'root' in args else 1)
        argv = ['installer', '--rollback', str(rollback)] if rollback else ['installer', '--sha', SHA, '--runner-user', 'commonswarm-status']
        patches = [patch('os.geteuid', return_value=0), patch('os.uname', return_value=types.SimpleNamespace(sysname='Linux')),
                   patch.object(socket, 'gethostname', return_value='pe-ci-1'), patch('pwd.getpwnam', side_effect=accounts.__getitem__),
                   patch('shutil.which', return_value='/modeled/host-tool'), patch('subprocess.run', side_effect=process),
                   patch('subprocess.check_output', side_effect=self.output), patch('os.fchown'),
                   patch.object(Path, 'stat', lambda p, **kw: self.metadata(p, self.real_stat(p, **kw))),
                   patch.object(Path, 'lstat', lambda p: self.metadata(p, self.real_lstat(p))),
                   patch('os.open', side_effect=self.opened), patch('os.close', side_effect=self.closed),
                   patch('os.replace', side_effect=self.replaced),
                   patch('os.fstat', side_effect=lambda fd: self.metadata(self.fds[fd], self.real_fstat(fd))),
                   patch.object(os, 'O_PATH', getattr(os, 'O_PATH', os.O_RDONLY), create=True), patch.object(sys, 'argv', argv)]
        previous_umask = os.umask(0o077)
        try:
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                try:
                    exec(compile(program, str(SCRIPT), 'exec'), {'__name__': '__main__'})
                except SystemExit as error:
                    if error.code != 0:
                        raise
        finally:
            for fd in list(self.fds):
                self.closed(fd)
            os.umask(previous_umask)

    def backup(self):
        return next(self.backups.iterdir())


class InstallerTests(unittest.TestCase):
    def test_both_inventories_install_and_manual_rollback_exactly(self):
        for count in (3, 4):
            with self.subTest(count=count):
                f = Installation(count)
                f.invoke()
                cfg = json.loads(f.config.read_text())
                self.assertEqual(set(cfg['controller_checksums']), set(NAMES))
                for name in NAMES:
                    data = (f.install / 'scripts' / name).read_bytes()
                    self.assertEqual(data, (f.source / 'scripts/standalone-ci' / name).read_bytes())
                    self.assertEqual(hashlib.sha256(data).hexdigest(), cfg['controller_checksums'][name])
                    self.assertEqual(stat.S_IMODE((f.install / 'scripts' / name).stat().st_mode), 0o755)
                manifest = json.loads((f.backup() / 'manifest.json').read_text())
                absent = [r for r in manifest['files'] if r.get('absent')]
                self.assertEqual([Path(r['path']).name for r in absent], ['publish-status.py'] if count == 3 else [])
                f.invoke(rollback=f.backup())
                self.assertEqual(f.snapshot(), f.original)
                f.invoke(rollback=f.backup())  # Restoring an already absent original is safe.
                self.assertEqual(f.snapshot(), f.original)

    def test_partial_install_restores_absence_and_original_bytes(self):
        for failure, error in (('publisher-write', OSError), ('acl', subprocess.CalledProcessError)):
            with self.subTest(failure=failure):
                f = Installation()
                f.failure = failure  # Fail before publisher replace, or after all file writes.
                with self.assertRaises(error):
                    f.invoke()
                self.assertEqual(f.snapshot(), f.original)
                self.assertFalse((f.install / 'scripts/publish-status.py').exists())
                self.assertTrue((f.backup() / 'manifest.json').is_file())

    def test_unexpected_replacement_is_preserved_even_with_identical_bytes(self):
        for replacement in ('inode', 'bytes', 'symlink'):
            with self.subTest(replacement=replacement):
                f = Installation()
                f.invoke()
                publisher = f.install / 'scripts/publish-status.py'
                if replacement == 'inode':
                    other = publisher.with_name('replacement')
                    other.write_bytes(publisher.read_bytes())
                    other.replace(publisher)
                elif replacement == 'bytes':
                    publisher.write_text('operator replacement')
                else:
                    publisher.unlink()
                    publisher.symlink_to(f.config)
                before = f.snapshot()
                with self.assertRaisesRegex(SystemExit, 'replaced|noncanonical'):
                    f.invoke(rollback=f.backup())
                self.assertEqual(f.snapshot(), before)

    def test_unknown_inventory_tampering_or_unrecorded_publisher_refuses_before_backup(self):
        for defect in ('inventory', 'hash', 'publisher', 'dangling'):
            with self.subTest(defect=defect):
                f = Installation()
                publisher = f.install / 'scripts/publish-status.py'
                reason = 'unexpected controller inventory' if defect == 'inventory' else 'installed controller hash mismatch' if defect == 'hash' else 'unexpected pre-existing publisher'
                if defect == 'inventory':
                    f.cfg['controller_checksums'].pop('retain.py')
                    f.save_config()
                elif defect == 'hash':
                    (f.install / 'scripts/run.sh').write_text('tampered')
                elif defect == 'publisher':
                    publisher.write_text('unrecorded')
                else:
                    publisher.symlink_to(f.root / 'missing')
                before = f.snapshot()
                with self.assertRaisesRegex(SystemExit, reason):
                    f.invoke()
                self.assertEqual(f.snapshot(), before)
                self.assertFalse(f.backups.exists())


if __name__ == '__main__':
    unittest.main()
