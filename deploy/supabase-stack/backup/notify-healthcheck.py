#!/usr/bin/env python3
"""Send backup/drill start and result pings without exposing capability URLs."""
import json
import os
from pathlib import Path
import re
import sys
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


def notify(kind, phase):
    key, status_name, flags = KINDS[kind]
    if CONFIG.stat().st_mode & 0o077:
        raise ValueError('healthcheck config must be private')
    values = dict(line.split('=', 1) for line in CONFIG.read_text().splitlines() if line and not line.startswith('#'))
    url = values[key].strip().strip('"').strip("'").rstrip('/')
    if not re.fullmatch(r'https://hc-ping\.com/[a-f0-9-]{36}', url):
        raise ValueError('invalid healthcheck URL')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    start_file = ROOT / (kind + '-ping-start.json')
    if phase == 'start':
        start_file.write_text(json.dumps({'at': time.time()}))
        ping(url, '/start')
        return
    if phase != 'finish':
        raise ValueError('invalid phase')
    ok = False
    try:
        started = json.loads(start_file.read_text())['at']
        status_path = ROOT / status_name
        status = json.loads(status_path.read_text())
        ok = (os.environ.get('SERVICE_RESULT') == 'success' and status.get('ok') is True
              and all(status.get(flag) is True for flag in flags) and status_path.stat().st_mtime >= started)
    except (OSError, ValueError, KeyError, TypeError):
        ok = False
    ping(url, '' if ok else '/fail')


def main():
    os.umask(0o077)
    try:
        if len(sys.argv) != 3:
            raise ValueError('expected kind and phase')
        notify(sys.argv[1], sys.argv[2])
        return 0
    except Exception as error:
        print('Healthcheck notification failed: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
