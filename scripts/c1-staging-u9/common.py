#!/usr/bin/env python3
"""U9's sole measured staging guard and protected local receipt I/O (ruling 43).

No runtime identity override. Tests replace OS observations inside their process.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import socket
import stat

HOST = 'c1-staging-20261006'
MACHINE_SHA256 = '29e448988c239181332e852c902c4c36815d628bb58cebc7da53c23f0f443565'
MACHINE_ID = '/etc/machine-id'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(path):
    path = str(path)
    need(os.path.isabs(path) and os.path.normpath(path) == path
         and os.path.realpath(path) == path, 'canonical absolute path required')
    return path


def directory(path):
    s = os.lstat(canonical(path))
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0
         and stat.S_IMODE(s.st_mode) == 0o700, 'root:root 0700 directory required')


def read(path, owner=(0, 0)):
    """One canonical, no-follow, root 0600 single-link descriptor."""
    fd = os.open(canonical(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        s = os.fstat(file.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and (s.st_uid, s.st_gid) == owner
             and stat.S_IMODE(s.st_mode) == 0o600, 'owned 0600 regular single-link file required')
        return file.read()


def identity():
    # Hash exact bytes, including the terminal newline. Probe performs no writes.
    fd = os.open(MACHINE_ID, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        need(stat.S_ISREG(os.fstat(file.fileno()).st_mode), 'regular machine-id required')
        machine_hash = digest(file.read())
    return dict(hostname=socket.gethostname(), machine_id_sha256=machine_hash,
                measured_at=now().isoformat())


def guard():
    row = identity()
    need(row['hostname'] == HOST and row['machine_id_sha256'] == MACHINE_SHA256,
         'measured staging identity mismatch')
    need(os.geteuid() == 0, 'staging root required')
    return row


def write_bytes(path, raw):
    fd = os.open(canonical(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        os.fchown(file.fileno(), 0, 0)
        os.fchmod(file.fileno(), 0o600)
        file.write(raw)
        file.flush()
        os.fsync(file.fileno())
    sync_directory(pathlib.Path(path).parent)


def sync_directory(path):
    fd = os.open(canonical(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write(path, row):
    write_bytes(path, (json.dumps(row, sort_keys=True) + '\n').encode())


def utc(value):
    need(isinstance(value, str) and re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value), 'aware UTC required')
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


if __name__ == '__main__':
    import sys
    try:
        need(sys.argv[1:] in (['identity'], ['check']), 'identity or check required')
        print(json.dumps(identity() if sys.argv[1] == 'identity' else guard(), sort_keys=True))
    except (ValueError, OSError):
        raise SystemExit('STOP U9 identity: measurement unavailable or staging identity mismatch') from None
