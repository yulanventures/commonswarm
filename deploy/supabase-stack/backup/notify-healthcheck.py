#!/usr/bin/env python3
"""Send backup/drill start and result pings without exposing capability URLs."""
import json
import os
from pathlib import Path
import re
import sys
import stat
import time
import urllib.request

CONFIG = Path('/etc/commonswarm-backup/healthchecks.env')
ROOT = Path('/var/backups/commonswarm-postgres')
KINDS = {'backup': ('HC_BACKUP_URL', 'status.json', ('database_bytes_verified', 'object_bytes_verified')),
         'restore': ('HC_RESTORE_URL', 'restore-status.json', ('database_verified', 'all_files_verified'))}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('redirect refused')


def ping(url, suffix):
    request = urllib.request.Request(url + suffix, data=b'CommonSwarm scheduled backup verification', method='POST')
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError('ping rejected')


def read_url(config, key):
    if config != CONFIG:
        if not config.is_absolute():
            raise ValueError('absolute healthcheck config required')
        info = config.lstat()
        if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600):
            raise ValueError('healthcheck config must be regular root:root 0600')
    if config.stat().st_mode & 0o077:
        raise ValueError('healthcheck config must be private')
    lines = [line for line in config.read_text().splitlines() if line and not line.startswith('#')]
    if config != CONFIG and (len(lines) != 1 or not lines[0].startswith(key + '=')):
        raise ValueError('expected one healthcheck key')
    values = dict(line.split('=', 1) for line in lines)
    url = values[key].strip().strip('"').strip("'").rstrip('/')
    if not re.fullmatch(r'https://hc-ping\.com/[a-f0-9-]{36}', url):
        raise ValueError('invalid healthcheck URL')
    return url


def notify(kind, phase, config=None):
    key, status_name, flags = KINDS[kind]
    url = read_url(CONFIG if config is None else config, key)
    if config is not None and phase in ('ok', 'fail'):
        ping(url, '' if phase == 'ok' else '/fail')
        return
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    start_file = ROOT / (kind + '-ping-start.json')
    if phase == 'start':
        start_file.write_text(json.dumps({'at': time.time(), 'invocation_id': os.environ.get('INVOCATION_ID')}))
        ping(url, '/start')
        return
    if phase != 'finish':
        raise ValueError('invalid phase')
    ok = False
    try:
        started = json.loads(start_file.read_text())['invocation_id']
        invocation_id = os.environ.get('INVOCATION_ID')
        status_path = ROOT / status_name
        status = json.loads(status_path.read_text())
        if not isinstance(status, dict):
            raise ValueError('status must be an object')
        ok = (os.environ.get('SERVICE_RESULT') == 'success' and status.get('ok') is True
              and all(status.get(flag) is True for flag in flags)
              and isinstance(invocation_id, str) and bool(re.fullmatch(r'[0-9a-f]{32}', invocation_id))
              and started == invocation_id and status.get('invocation_id') == invocation_id)
    except (OSError, ValueError, KeyError, TypeError):
        ok = False
    ping(url, '' if ok else '/fail')


def main():
    os.umask(0o077)
    try:
        config = None
        if len(sys.argv) == 5 and sys.argv[3] == '--config':
            config = Path(sys.argv[4])
        elif len(sys.argv) != 3:
            raise ValueError('expected kind and phase')
        notify(sys.argv[1], sys.argv[2], config)
        return 0
    except Exception as error:
        print('Healthcheck notification failed: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
