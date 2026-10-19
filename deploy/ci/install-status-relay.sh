#!/bin/bash
# Existing-install migration only. Root reviews/executes; never provisions tools.
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import shutil
import socket
import stat
import subprocess as sp


def need(ok, message):
    if not ok:
        raise SystemExit('REFUSE: ' + message)


def call(args):
    return sp.check_output(args, text=True, stderr=sp.DEVNULL, timeout=20)


def protected(path, owner=0, directory=False):
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'noncanonical protected path')
    for parent in reversed(path.parents):
        info = parent.stat()
        need(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe parent of protected path')
    info = path.lstat()
    need(info.st_uid == owner and not info.st_mode & 0o022 and
         (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)), 'unsafe protected path metadata')


def acl(path):
    return {line.split('#', 1)[0].strip() for line in call(['getfacl', '-cpn', str(path)]).splitlines() if line.strip()}


def expected(directory, uid, permission):
    return {'user::rwx' if directory else 'user::rw-', 'group::---', 'other::---',
            f'user:{uid}:{permission}', 'mask::' + permission}


def atomic(path, data, mode, uid=0, gid=0):
    temporary = path.with_name('.status-relay-' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.close(fd)
        if temporary.exists():
            temporary.unlink()


os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('--sha')
parser.add_argument('--runner-user')
parser.add_argument('--rollback')
args = parser.parse_args()
need(os.geteuid() == 0 and os.uname().sysname == 'Linux' and socket.gethostname().split('.')[0] == 'pe-ci-1', 'requires root on pe-ci-1')
for tool in ('getfacl', 'setfacl', 'runuser', 'git', 'pgrep', 'sudo'):
    need(shutil.which(tool), 'missing tool ' + tool)
need(sp.run(['pgrep', '-u', 'root', '-x', 'systemd'], stdout=sp.DEVNULL).returncode == 0, 'process visibility unproven')
pe_runner_uid = pwd.getpwnam('gha').pw_uid
need(type(pe_runner_uid) is int and pe_runner_uid > 0, 'invalid PE runner UID')
probe = sp.run(['pgrep', '-u', str(pe_runner_uid), '-x', 'Runner.Worker'], stdout=sp.DEVNULL)
need(probe.returncode == 1, 'PE runner active or quiet probe failed')
state = Path('/var/lib/commonswarm-ci')
install = Path('/opt/commonswarm-ci')
config = install / 'config.json'
protected(install, directory=True)
protected(install / 'scripts', directory=True)
protected(config)
cfg = json.loads(config.read_text())
need(cfg['state'] == str(state) and cfg['controller'] == str(install / 'scripts') and cfg['allowed_hostname'] == 'pe-ci-1', 'installed path/host mismatch')
service = pwd.getpwnam('commonswarm-ci')
need((cfg['service_uid'], cfg['service_gid']) == (service.pw_uid, service.pw_gid), 'service identity mismatch')
need(pe_runner_uid not in (service.pw_uid, cfg.get('status_reader_uid')), 'PE identity overlaps service or reader')
installed_pe_uid = cfg.get('pe_runner_uid')
need(installed_pe_uid is None or (type(installed_pe_uid) is int and installed_pe_uid == pe_runner_uid), 'installed PE identity differs from gha')
# No writable ancestor, symlink or replacement queue inode is accepted.
for path in (state, state / 'runs'):
    need(path.resolve() == path and not path.is_symlink() and path.is_dir() and path.stat().st_uid == service.pw_uid, 'unsafe state path')
lockpath = state / 'queue.lock'
lockfd = os.open(lockpath, os.O_RDWR | os.O_NOFOLLOW)
need(stat.S_ISREG(os.fstat(lockfd).st_mode) and os.fstat(lockfd).st_uid == service.pw_uid, 'unsafe queue lock')
try:
    fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    need(False, 'queue is not quiet')
need(lockpath.stat().st_ino == os.fstat(lockfd).st_ino, 'queue lock changed')


def restore(backup):
    protected(backup, directory=True)
    protected(backup / 'manifest.json')
    manifest = json.loads((backup / 'manifest.json').read_text())
    allowed = {str(config)} | {str(install / 'scripts' / n) for n in ('run.sh', 'suite.sh', 'retain.py', 'publish-status.py')}
    for record in manifest['files']:
        target = Path(record['path'])
        need(str(target) in allowed, 'invalid rollback target')
        source = backup / record['backup']
        protected(source)
        data = source.read_bytes()
        need(hashlib.sha256(data).hexdigest() == record['sha256'], 'backup checksum mismatch')
        atomic(target, data, record['mode'], record['uid'], record['gid'])
    for record in manifest['acls']:
        target = Path(record['path'])
        need(target in (state, state / 'runs') or
             (target.parent == state / 'runs' and re.fullmatch('csci-[0-9a-f]{32}', target.name)) or
             (target.name == 'receipt.json' and target.parent.parent == state / 'runs'), 'invalid ACL rollback target')
        need(target.resolve() == target and not target.is_symlink() and target.stat().st_ino == record['inode'], 'ACL target replaced; Root must reconcile')
        source = backup / record['backup']
        protected(source)
        need(hashlib.sha256(source.read_bytes()).hexdigest() == record['sha256'], 'ACL backup checksum mismatch')
        call(['setfacl', '--restore=' + str(source)])


if args.rollback:
    need(not args.sha and not args.runner_user, 'rollback takes no install arguments')
    backup = Path(args.rollback)
    need(backup.parent == Path('/var/backups/commonswarm-status') and re.fullmatch('[0-9TZ-]+', backup.name), 'invalid backup path')
    restore(backup)
    print('Restored controller/config and exact per-file ACL backups; no service or PE changes.')
    raise SystemExit(0)
need(args.sha and re.fullmatch('[0-9a-f]{40}', args.sha) and args.runner_user == 'commonswarm-status', 'use --sha <reviewed-40hex> --runner-user commonswarm-status')
source = Path(call(['git', 'rev-parse', '--show-toplevel']).strip())
need(call(['git', '-C', str(source), 'rev-parse', 'HEAD']).strip() == args.sha and not call(['git', '-C', str(source), 'status', '--porcelain']).strip(), 'source is not clean exact reviewed SHA')
account = pwd.getpwnam(args.runner_user)
need(account.pw_uid > 0 and account.pw_uid not in (service.pw_uid, pe_runner_uid) and account.pw_dir == '/var/lib/commonswarm-status-runner', 'unexpected runner identity')
need(call(['id', '-G', args.runner_user]).strip() == str(account.pw_gid), 'runner has supplementary groups')
sudo = sp.run(['runuser', '-u', args.runner_user, '--', 'sudo', '-n', '-l'], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
need(sudo.returncode != 0, 'runner may have sudo privileges; Root must resolve')
uid = account.pw_uid
need(cfg.get('status_reader_uid') in (None, uid), 'different installed reader')
# Validate the installed source inventory before saving or replacing anything.
names = ('run.sh', 'suite.sh', 'retain.py', 'publish-status.py')
need(set(cfg['controller_checksums']) == set(names), 'unexpected controller inventory')
for name in names:
    old = install / 'scripts' / name
    protected(old)
    need(hashlib.sha256(old.read_bytes()).hexdigest() == cfg['controller_checksums'][name], 'installed controller hash mismatch')
    new = source / 'scripts' / 'standalone-ci' / name
    need(new.resolve() == new and new.is_file() and not new.is_symlink(), 'unsafe source file')
publisher = runpy.run_path(str(source / 'scripts/standalone-ci/publish-status.py'))
legacy = publisher['LEGACY']
acl_targets = [(state, '--x', True), (state / 'runs', 'r-x', True)]
rootfd = publisher['directory'](str(state / 'runs'))
try:
    for run_id in sorted(legacy):
        receipt = publisher['read_receipt'](rootfd, run_id)
        publisher['candidate'](receipt)
        run = state / 'runs' / run_id
        acl_targets.extend(((run, '--x', True), (run / 'receipt.json', 'r--', False)))
finally:
    os.close(rootfd)
for path, permission, isdir in acl_targets:
    need(path.resolve() == path and not path.is_symlink() and path.stat().st_uid == service.pw_uid, 'ACL target owner/path mismatch')
    base = {'user::rwx' if isdir else 'user::rw-', 'group::---', 'other::---'}
    need(acl(path) in (base, expected(isdir, uid, permission)), 'unsupported existing ACL')
backup_root = Path('/var/backups/commonswarm-status')
backup_root.mkdir(mode=0o700, exist_ok=True)
protected(backup_root, directory=True)
backup = backup_root / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S-%fZ')
backup.mkdir(mode=0o700)
manifest = dict(source_sha=args.sha, reader_uid=uid, files=[], acls=[])
for index, path in enumerate([config] + [install / 'scripts' / n for n in names]):
    info = path.stat()
    data = path.read_bytes()
    name = f'file-{index}'
    (backup / name).write_bytes(data)
    manifest['files'].append(dict(path=str(path), backup=name, sha256=hashlib.sha256(data).hexdigest(), mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid))
for index, (path, _, _) in enumerate(acl_targets):
    data = call(['getfacl', '-pn', str(path)]).encode()
    name = f'acl-{index}'
    (backup / name).write_bytes(data)
    manifest['acls'].append(dict(path=str(path), backup=name, inode=path.stat().st_ino, sha256=hashlib.sha256(data).hexdigest()))
(backup / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
try:
    for name in names:
        atomic(install / 'scripts' / name, (source / 'scripts/standalone-ci' / name).read_bytes(), 0o755)
    cfg.pop('github_status_token_file', None)
    cfg.update(controller_sha=args.sha, status_reader_uid=uid, pe_runner_uid=pe_runner_uid,
               controller_checksums={n: hashlib.sha256((install / 'scripts' / n).read_bytes()).hexdigest() for n in names})
    atomic(config, (json.dumps(cfg, indent=2)+'\n').encode(), 0o640, 0, service.pw_gid)
    for path, permission, isdir in acl_targets:
        call(['setfacl', '-m', f'u:{uid}:{permission},m::{permission}', str(path)])
        need(acl(path) == expected(isdir, uid, permission), 'ACL grant readback mismatch')
    # Actual unprivileged access, including a positive read and sibling denial.
    probe = '''import os,sys
receipt,run,state,config=sys.argv[1:]
with open(receipt,'rb') as f: assert f.read(1)
def denied(fn):
 try: fn()
 except PermissionError: return
 raise RuntimeError('unexpected reader access')
denied(lambda: open(receipt,'ab'))
denied(lambda: os.listdir(run))
for path in [config,state+'/source.git/config',state+'/queue.lock',state+'/home',run+'/suite.log']:
 denied(lambda p=path: open(p,'rb'))
'''
    run = state / 'runs' / sorted(legacy)[0]
    call(['runuser', '-u', args.runner_user, '--', 'python3', '-c', probe, str(run / 'receipt.json'), str(run), str(state), str(config)])
except BaseException:
    restore(backup)
    raise
print(json.dumps(dict(state='installed', source_sha=args.sha, reader_uid=uid, legacy_receipts=len(legacy), backup=str(backup), controller_checksums=cfg['controller_checksums'])))
print('Rollback under quiet queue: sudo bash deploy/ci/install-status-relay.sh --rollback ' + str(backup))
PY
