#!/usr/bin/env python3
"""Retain and byte-check one exact database/file snapshot. Never deletes data."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

ROOT = 'r2:yulan-vps-1-backups'
PREFIX = ROOT + '/000-commonswarm-postgres'
FILES = ['database.dump', 'roles.sql', 'manifest.txt', 'source-counts.tsv',
         'storage-objects.ndjson', 'storage-backend-objects.ndjson',
         'cron-jobs.ndjson', 'globals.sql']


def physical_keys(rows):
    keys = []
    for row in rows:
        for field in ('bucket', 'name', 'version'):
            value = row.get(field)
            if not isinstance(value, str) or not value or any(c in value for c in '\r\n\0'):
                raise ValueError('invalid physical object identity')
            if any(part in ('', '.', '..') for part in value.split('/')):
                raise ValueError('unsafe physical object path')
            if field != 'name' and '/' in value:
                raise ValueError('invalid bucket or version')
        keys.append('commonswarm/{bucket}/{name}/{version}'.format(**row))
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate physical object identity')
    return keys


def selected_host_snapshot(names):
    names = [name.rstrip('/') for name in names if name]
    if not names or not re.fullmatch(r'\d{8}T\d{6}Z', max(names)):
        raise ValueError('existing host backup selector is not a timestamp; refusing upload')
    # The new namespace sorts before every YYYY... host backup. Existing
    # host restore code selects sorted root names[-1], not nested prefixes.
    if max(names + ['000-commonswarm-postgres']) != max(names):
        raise ValueError('new prefix would alter the host restore selection')
    return max(names)


def private_file(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('required file is not private')
    return path.read_text()


def upload(artifact, retention_file):
    os.umask(0o077)
    artifact = artifact.resolve(strict=True)
    if not artifact.is_dir() or artifact.stat().st_mode & 0o077:
        raise ValueError('artifact directory must be private')
    for name in FILES:
        info = (artifact / name).stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError('missing or non-private database artifact')
    if 'format=commonswarm-n-db-v2\n' not in (artifact / 'manifest.txt').read_text():
        raise ValueError('unsupported database artifact format')
    evidence = json.loads(retention_file.read_text())
    if (not evidence.get('publicDisabled') or
        not evidence.get('path', '').endswith('/buckets/yulan-vps-1-backups/settings') or
        'Delete objects after 35 day(s)\nEnabled' not in evidence.get('rules', '') or
        not evidence.get('observed_at')):
        raise ValueError('verified private bucket/35-day policy evidence required')
    values = {}
    for line in private_file(Path(os.environ.get('COMMONSWARM_ENV_FILE', '/home/commonswarm/.env'))).splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            if key in values:
                raise ValueError('duplicate environment key')
            values[key] = value
    if values.get('TENANT_ID') != 'commonswarm' or values.get('STORAGE_S3_BUCKET') != 'commonswarm-files':
        raise ValueError('unexpected object store binding')
    child_env = dict(os.environ)
    for key, value in {'TYPE': 's3', 'PROVIDER': 'Cloudflare', 'REGION': 'auto',
                       'ENDPOINT': values['STORAGE_S3_ENDPOINT'],
                       'ACCESS_KEY_ID': values['AWS_ACCESS_KEY_ID'],
                       'SECRET_ACCESS_KEY': values['AWS_SECRET_ACCESS_KEY'],
                       'NO_CHECK_BUCKET': 'true'}.items():
        child_env['RCLONE_CONFIG_CSFILES_' + key] = value
    log_path = artifact / 'offsite-copy.log'
    with log_path.open('a') as log:
        os.chmod(log_path, 0o600)

        def call(args, capture=False):
            result = subprocess.run(args, env=child_env, cwd=artifact,
                                    stdout=subprocess.PIPE if capture else log,
                                    stderr=log, text=True, timeout=3600)
            if result.returncode:
                raise RuntimeError('offsite command failed; private log retained')
            return result.stdout if capture else None

        covered = {line.split('  ', 1)[1] for line in (artifact / 'SHA256SUMS').read_text().splitlines() if '  ' in line}
        if not set(FILES).issubset(covered):
            raise ValueError('checksum manifest does not cover required database artifacts')
        call(['sha256sum', '--check', 'SHA256SUMS'])
        before = selected_host_snapshot(call(['rclone', 'lsf', ROOT, '--dirs-only', '--max-depth', '1'], True).splitlines())
        rows = [json.loads(line) for line in (artifact / 'storage-backend-objects.ndjson').read_text().splitlines() if line]
        counts = dict(line.split('|', 1) for line in (artifact / 'source-counts.tsv').read_text().splitlines())
        if len(rows) != int(counts['storage.objects']):
            raise ValueError('physical object manifest does not match snapshot row count')
        keys = physical_keys(rows)
        listing = artifact / 'physical-object-keys.txt'
        listing.write_text(''.join(key + '\n' for key in keys))
        snapshot = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex
        destination = PREFIX + '/' + snapshot
        binding = {'format': 'commonswarm-backup-v1', 'destination': destination,
                   'objects': len(keys), 'retention_policy_observed_at': evidence['observed_at'],
                   'retention_days': 35, 'immutable_bucket_lock': False,
                   'host_snapshot_before': before, 'source_bucket': 'commonswarm-files',
                   'physical_key_format': 'commonswarm/{bucket}/{name}/{version}'}
        (artifact / 'offsite-binding.json').write_text(json.dumps(binding, indent=2))
        (artifact / 'retention-evidence.json').write_text(json.dumps(evidence, indent=2))
        source = 'csfiles:commonswarm-files'
        if keys:
            call(['rclone', 'copy', source, destination + '/objects', '--files-from-raw', str(listing),
                  '--immutable', '--s3-no-head-object'])
            copied = call(['rclone', 'lsf', destination + '/objects', '--recursive', '--files-only', '--format', 'p'], True).splitlines()
            if sorted(copied) != sorted(keys):
                raise RuntimeError('retained object inventory does not match database snapshot')
            call(['rclone', 'check', source, destination + '/objects', '--files-from-raw', str(listing),
                  '--download', '--one-way', '--s3-no-head-object'])
        files = FILES + ['physical-object-keys.txt', 'offsite-binding.json', 'retention-evidence.json']
        sums = ''.join(hashlib.sha256((artifact / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in files)
        (artifact / 'SHA256SUMS').write_text(sums)
        db_list = artifact / 'database-files.txt'
        db_list.write_text('\n'.join(files + ['SHA256SUMS']) + '\n')
        call(['rclone', 'copy', str(artifact), destination + '/database', '--files-from-raw', str(db_list), '--immutable'])
        call(['rclone', 'check', str(artifact), destination + '/database', '--files-from-raw', str(db_list), '--download', '--one-way'])
        after = selected_host_snapshot(call(['rclone', 'lsf', ROOT, '--dirs-only', '--max-depth', '1'], True).splitlines())
        if after < before:
            raise RuntimeError('host snapshot selection moved backwards')
        result = dict(binding, host_snapshot_after=after, verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      database_bytes_verified=True, object_bytes_verified=True)
        marker = artifact / 'COMPLETE.json'
        marker.write_text(json.dumps(result, indent=2))
        call(['rclone', 'copyto', str(marker), destination + '/COMPLETE.json', '--immutable'])
        if json.loads(call(['rclone', 'cat', destination + '/COMPLETE.json'], True)) != result:
            raise RuntimeError('remote completion marker verification failed')
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: upload-snapshot.py <private artifact directory> <retention evidence JSON>')
    try:
        print(json.dumps(upload(Path(sys.argv[1]), Path(sys.argv[2]))))
    except Exception as error:
        # Do not surface subprocess output, env values, object names or payloads.
        print('Backup upload failed: ' + type(error).__name__ + '; artifacts and private logs retained.', file=sys.stderr)
        raise SystemExit(1)
