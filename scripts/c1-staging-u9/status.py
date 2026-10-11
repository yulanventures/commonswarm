#!/usr/bin/env python3
"""Local-only U9 backup admission and two-gate removal; ruling 43 addendum.

database.dump is named by dump-database.sh:30,33 and migrate/dump-source.sh:120.
The drill owns restore-status.json (restore-drill.py:24); only U9 cleanup removes it.
"""
import argparse
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

from common import canonical, digest, directory, guard, need, now, read, sync_directory, utc, write

STATUS = '/var/backups/commonswarm-postgres/status.json'
RESTORE = '/var/backups/commonswarm-postgres/restore-status.json'
KEYS = {'destination', 'dump_sha256', 'drill', 'verified_at'}


def local(row):
    need(isinstance(row, dict) and set(row) == KEYS and row['drill'] == 'PASS'
         and isinstance(row['dump_sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['dump_sha256'])
         and isinstance(row['destination'], str) and row['destination'].startswith('local-staging:'), 'local form required')
    canonical(row['destination'][len('local-staging:'):])
    utc(row['verified_at'])
    return row


def restore_snapshot():
    # lstat distinguishes absence from an unsafe dangling symlink.
    if not os.path.lexists(RESTORE):
        return dict(exists=False, sha256=None)
    return dict(exists=True, sha256=digest(read(RESTORE)))


def removal_record(path):
    """Hash and metadata from one root-owned regular no-follow descriptor."""
    fd = os.open(canonical(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        s = os.fstat(file.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0
             and s.st_nlink == 1, 'root-owned regular single-link gate required')
        return dict(sha256=digest(file.read()), size=s.st_size, mtime_ns=s.st_mtime_ns)


def run(action, receipt, dump_dir=None, before=None):
    identity = guard()
    directory(pathlib.Path(canonical(receipt)).parent)
    need(not os.path.lexists(receipt), 'receipt already exists')
    # Protect every status ancestor against unprivileged replacement.
    for parent in pathlib.Path(STATUS).parents:
        s = os.lstat(canonical(parent))
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0
             and not s.st_mode & 0o022, 'unsafe status ancestor')
    row = dict(kind='c1-staging-u9-status', action=action, identity=identity,
               restore_status=restore_snapshot())
    if action == 'write':
        prior = json.loads(read(before))
        need(prior['kind'] == row['kind'] and prior['action'] == 'before'
             and prior['identity']['hostname'] == identity['hostname']
             and prior['identity']['machine_id_sha256'] == identity['machine_id_sha256'], 'before-drill receipt required')
        directory(dump_dir)
        dump = pathlib.Path(dump_dir) / 'database.dump'
        raw = read(dump)
        need(raw.startswith(b'PGDMP'), 'custom PostgreSQL dump required')
        drill = json.loads(read(RESTORE))
        completed = utc(drill.get('at'))
        need(drill.get('ok') is True and drill.get('state') == 'complete'
             and 0 <= (now() - completed).total_seconds() <= 1800
             and utc(prior['identity']['measured_at']) <= completed
             and 0 <= completed.timestamp() - os.stat(dump, follow_symlinks=False).st_mtime <= 3600,
             'fresh completed drill after dump and before-receipt required')
        content = local(dict(destination='local-staging:' + canonical(dump_dir),
                             dump_sha256=digest(raw), drill='PASS', verified_at=now().isoformat()))
        write(STATUS, content)
        row.update(status=content, dump_sha256=content['dump_sha256'],
                   status_sha256=digest(read(STATUS)), before_receipt_sha256=digest(read(before)))
    elif action == 'remove':
        writer = json.loads(read(before))
        need(writer['kind'] == row['kind'] and writer['action'] == 'write'
             and writer['identity']['hostname'] == identity['hostname']
             and writer['identity']['machine_id_sha256'] == identity['machine_id_sha256'], 'writer receipt required')
        raw = read(STATUS)
        content = local(json.loads(raw))
        need(content == writer['status'] and content['dump_sha256'] == writer['dump_sha256']
             and digest(raw) == writer['status_sha256'], 'status differs from writer receipt')
        guarded_rm = canonical(os.environ.get('U9_GUARDED_RM', ''))
        need(stat.S_ISREG(os.lstat(guarded_rm).st_mode) and os.access(guarded_rm, os.X_OK),
             'HezLead-verified executable guarded rm required')
        files = {path: removal_record(path) for path in (STATUS, RESTORE)}
        need(files[STATUS]['sha256'] == digest(raw)
             and writer['restore_status']['exists'] is True
             and files[RESTORE]['sha256'] == writer['restore_status']['sha256'], 'gate differs from post-drill receipt')
        row.update(dump_sha256=content['dump_sha256'], status_sha256=digest(raw), files=files,
                   writer_receipt_sha256=digest(read(before)), phase='before-removal')
        # Persist BOTH records before the first call; retain this on partial refusal.
        write(receipt + '.before', row)
        for path in files:
            result = subprocess.run([guarded_rm, '--', path], capture_output=True, text=True)
            if result.returncode:
                print('BLOCKED by rm guard: ' + repr(result.stderr.strip()) + '. To resolve: HezLead reviews the exact retained path ' + path + '.', file=sys.stderr)
                raise ValueError('guarded rm refused gate removal')
            need(not os.path.lexists(path), 'guarded rm left gate path present')
            sync_directory(pathlib.Path(path).parent)
        row.update(phase='removed', absent={path: not os.path.lexists(path) for path in files},
                   restore_status=restore_snapshot(),
                   before_removal_receipt_sha256=digest(read(receipt + '.before')))
        need(all(row['absent'].values()), 'gate path reappeared')
    write(receipt, row)
    print(json.dumps(row, sort_keys=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['before', 'write', 'remove', 'after'])
    parser.add_argument('receipt', help='new absolute receipt in a root:root 0700 proof directory')
    parser.add_argument('--dump-dir')
    parser.add_argument('--source-receipt', help='before receipt for write; writer receipt for remove')
    args = parser.parse_args()
    try:
        run(args.action, args.receipt, args.dump_dir, args.source_receipt)
    except (ValueError, OSError, KeyError, TypeError):
        raise SystemExit('STOP U9 status: identity, dump, drill, file or receipt refused; retain state for lead inspection') from None
