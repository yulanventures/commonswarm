#!/usr/bin/env python3
"""Weekly cold recovery proof; persist U7 identity and integrity before cleanup."""

import base64
import concurrent.futures
import datetime
import hashlib
import hmac
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import re
import ipaddress


LOCK_PATH = '/var/lock/commonswarm-postgres-maintenance.lock'
STATUS_FILE = '/var/backups/commonswarm-postgres/restore-status.json'
BACKUP_ROOT = 'r2:yulan-vps-1-backups/000-commonswarm-postgres'
STACK_DIR = str(Path(__file__).resolve().parent.parent)
DEADLINE = None
REQUIRED_FILES = {'database.dump', 'roles.sql', 'manifest.txt', 'source-counts.tsv',
                  'storage-objects.ndjson', 'storage-backend-objects.ndjson', 'cron-jobs.ndjson',
                  'globals.sql', 'physical-object-keys.txt', 'offsite-binding.json', 'retention-evidence.json'}
REQUIRED_DATABASE_SCHEMAS = frozenset({
    'auth', 'public', 'realtime', 'storage', 'supabase_migrations', 'swarm',
    'swarm_read', 'commonswarm_oauth', 'commonswarm_ops',
})
WORKDIR_BASE = '/var/backups/commonswarm-postgres/restore-drill'
# DRILL_WORKDIR_KEEP = 2 counts the current run: that directory plus one earlier run.
DRILL_WORKDIR_KEEP = 2
KEY_TABLES = ('auth.users', 'storage.objects', 'swarm.agent_tokens',
              'commonswarm_oauth.provider_artifacts', 'commonswarm_ops.migration_checksums')

def atomic_write_status(path, status_obj):
    tmp = path.with_suffix(f'.tmp.{os.getpid()}')
    tmp.write_text(json.dumps(status_obj, indent=2) + '\n')
    tmp.chmod(0o600)
    tmp.rename(path)

def run_cmd(args, **kwargs):
    kwargs.setdefault('check', True)
    kwargs.setdefault('text', True)
    kwargs.setdefault('capture_output', True)
    limit = kwargs.pop('timeout', 900)
    if DEADLINE is not None:
        remaining = DEADLINE - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('drill budget exceeded')
        limit = min(limit, remaining)
    return subprocess.run(args, timeout=limit, **kwargs)


def wait_ready(probe, attempts, error, expected=None):
    for _ in range(attempts):
        response = probe()
        if response.returncode == 0 and (expected is None or response.stdout.strip() == expected):
            return
        time.sleep(1)
    raise RuntimeError(error)


def validate_manifest(text):
    entries = {}
    for line in text.splitlines():
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key in entries:
            raise ValueError('duplicate database artifact manifest key')
        entries[key] = value
    schemas = entries.get('schemas', '').split(',')
    if (entries.get('format') != 'commonswarm-n-db-v2' or
            len(schemas) != len(set(schemas)) or set(schemas) != REQUIRED_DATABASE_SCHEMAS):
        raise ValueError('unsupported database artifact format or schema set')


def cleanup(workdir, label):
    # All Docker resources carry a unique label set before creation. Enumerate
    # again after deletion: a successful command alone does not prove absence.
    failures = []
    for kind in ('container', 'network'):
        listing = ['docker', 'ps', '-aq', '--filter', 'label=' + label] if kind == 'container' else [
            'docker', 'network', 'ls', '-q', '--filter', 'label=' + label]
        try:
            ids = run_cmd(listing, timeout=30).stdout.splitlines()
            for resource_id in ids:
                info = json.loads(run_cmd(['docker', kind, 'inspect', resource_id], timeout=30).stdout)[0]
                labels = info.get('Config', {}).get('Labels', {}) if kind == 'container' else info.get('Labels', {})
                key, value = label.split('=', 1)
                if labels.get(key) != value or not info['Id'].startswith(resource_id):
                    raise RuntimeError('cleanup ownership mismatch')
                args = ['docker', 'rm', '-fv', info['Id']] if kind == 'container' else ['docker', 'network', 'rm', info['Id']]
                run_cmd(args, timeout=30)
            if run_cmd(listing, timeout=30).stdout.strip():
                raise RuntimeError('owned resources remain')
        except Exception:
            failures.append(kind)
    for name in ('database.env', 'storage.env', 'pass'):
        try:
            (workdir / name).unlink(missing_ok=True)
        except Exception:
            failures.append('credential')
    if failures:
        raise RuntimeError('cleanup failed: ' + ','.join(failures))


def generate_temp_credentials(tenant_prefix):
    rclone_conf_res = run_cmd(['rclone', 'config', 'dump'])
    rclone_conf = json.loads(rclone_conf_res.stdout)
    if 'r2' not in rclone_conf:
        raise RuntimeError("Missing r2 remote in rclone config")
    r2_conf = rclone_conf['r2']
    parent_access_key = r2_conf['access_key_id']
    parent_secret = r2_conf['secret_access_key']
    endpoint = r2_conf['endpoint']

    host = urlparse(endpoint).hostname
    if not host:
        raise ValueError("Invalid R2 endpoint")
    account_id = host.split('.')[0]

    now = int(time.time())
    claims = {
        "bucket": "yulan-vps-1-backups",
        "scope": "object-read-only",
        "paths": {"prefixPaths": [tenant_prefix + '/']},
        "sub": account_id,
        "iss": parent_access_key,
        "aud": host,
        "iat": now,
        "exp": now + 3600
    }

    def enc(v):
        return base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode('utf-8')).decode('utf-8').rstrip('=')

    jwt_data = enc({"alg": "HS256", "typ": "JWT"}) + '.' + enc(claims)
    jwt_sig = base64.urlsafe_b64encode(hmac.new(parent_secret.encode('utf-8'), jwt_data.encode('utf-8'), hashlib.sha256).digest()).decode('utf-8').rstrip('=')
    signed_jws = jwt_data + '.' + jwt_sig
    digest = hashlib.sha256(signed_jws.encode('utf-8')).hexdigest()
    session = base64.b64encode(('jwt/' + signed_jws).encode('utf-8')).decode('utf-8')

    return endpoint, parent_access_key, digest, session

def fetch_offsite_bytes(rows, endpoint, access_key, secret_key, session_token, tenant_id):
    import boto3
    from botocore.config import Config
    client = boto3.client('s3', endpoint_url=endpoint, region_name='auto',
                          aws_access_key_id=access_key, aws_secret_access_key=secret_key,
                          aws_session_token=session_token,
                          config=Config(max_pool_connections=12, connect_timeout=10, read_timeout=30))
    def expected(pair):
        index, row = pair
        key = tenant_id + '/' + row['bucket'] + '/' + row['name'] + '/' + row['version']
        body = client.get_object(Bucket='yulan-vps-1-backups', Key=key)['Body']
        try:
            data = body.read()
        finally:
            body.close()
        return dict(row, index=index, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        items = list(pool.map(expected, enumerate(rows)))
    return items

def fetch_api_bytes(rows_expected, storage_container):
    code = r'''const crypto=require('crypto');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{const items=JSON.parse(raw),results=[];let next=0;async function work(){for(;;){const i=next++;if(i>=items.length)return;const x=items[i];try{const url='http://127.0.0.1:5000/object/authenticated/'+encodeURIComponent(x.bucket)+'/'+x.name.split('/').map(encodeURIComponent).join('/');const response=await fetch(url,{headers:{authorization:'Bearer '+process.env.SERVICE_KEY,apikey:process.env.SERVICE_KEY},signal:AbortSignal.timeout(60000)});const bytes=Buffer.from(await response.arrayBuffer());const hash=crypto.createHash('sha256').update(bytes).digest('hex');results.push({index:x.index,status:response.status,bytes:bytes.length,matches:response.status===200&&bytes.length===x.bytes&&hash===x.sha256});}catch(e){results.push({index:x.index,status:0,matches:false});}}}await Promise.all(Array.from({length:8},work));console.log(JSON.stringify(results.sort((a,b)=>a.index-b.index)));});'''
    res = run_cmd(['docker', 'exec', '-i', storage_container, 'node', '-e', code], input=json.dumps(rows_expected))
    return json.loads(res.stdout)

def find_backup(remote):
    entries = run_cmd(['rclone', 'lsf', remote, '--dirs-only', '--max-depth', '1']).stdout.splitlines()
    for name in sorted(entries, reverse=True):
        name = name.rstrip('/')
        if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{32}', name):
            continue
        destination = remote + '/' + name
        files = run_cmd(['rclone', 'lsf', destination, '--files-only', '--max-depth', '1']).stdout.splitlines()
        if 'COMPLETE.json' not in files:
            continue
        data = json.loads(run_cmd(['rclone', 'cat', destination + '/COMPLETE.json']).stdout)
        if (data.get('format') != 'commonswarm-backup-v1' or data.get('destination') != destination
                or data.get('database_bytes_verified') is not True or data.get('object_bytes_verified') is not True
                or type(data.get('objects')) is not int or data['objects'] < 0):
            raise ValueError('invalid completed backup marker')
        verified = datetime.datetime.fromisoformat(data['verified_at'].replace('Z', '+00:00'))
        age = (datetime.datetime.now(datetime.timezone.utc) - verified).total_seconds()
        if age < -300:
            raise ValueError('backup timestamp is in future')
        if age <= 36 * 3600:
            return destination, data
    raise RuntimeError('no fresh completed offsite backup')


def validate_artifact(artifact, marker):
    checksums = {}
    for line in (artifact / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([a-zA-Z0-9_.-]+)', line)
        if not match or match[2] in checksums:
            raise ValueError('malformed checksum inventory')
        checksums[match[2]] = match[1]
    if set(checksums) != REQUIRED_FILES:
        raise ValueError('incomplete checksum inventory')
    for name, expected in checksums.items():
        file = artifact / name
        if file.is_symlink() or not file.is_file():
            raise ValueError('invalid artifact file')
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('artifact checksum mismatch')
    binding = json.loads((artifact / 'offsite-binding.json').read_text())
    if any(marker.get(k) != v for k, v in binding.items()) or binding.get('destination') != marker['destination']:
        raise ValueError('offsite binding mismatch')
    validate_manifest((artifact / 'manifest.txt').read_text())
    counts = {}
    for line in (artifact / 'source-counts.tsv').read_text().splitlines():
        table, count = line.split('|')
        if table in counts or not count.isdigit():
            raise ValueError('invalid table counts')
        counts[table] = int(count)
    if not set(KEY_TABLES) <= counts.keys():
        raise ValueError('missing core table counts')
    if counts['commonswarm_ops.migration_checksums'] < 1:
        raise ValueError('C1 migration checksum table has no rows')
    rows = [json.loads(line) for line in (artifact / 'storage-backend-objects.ndjson').read_text().splitlines()]
    keys = []
    for row in rows:
        for field in ('bucket', 'name', 'version'):
            value = row[field]
            if not isinstance(value, str) or not value or any(c in value for c in '\r\n\0') or any(
                    part in ('', '.', '..') for part in value.split('/')):
                raise ValueError('invalid file identity')
        keys.append('commonswarm/' + row['bucket'] + '/' + row['name'] + '/' + row['version'])
    if len(rows) != counts['storage.objects'] or len(rows) != marker['objects'] or len(set(keys)) != len(keys):
        raise ValueError('file inventory cardinality mismatch')
    if keys != (artifact / 'physical-object-keys.txt').read_text().splitlines():
        raise ValueError('physical object inventory mismatch')
    # Empty storage is valid only when the verified DB and marker agree it is empty.
    return rows, counts


def assert_owned_db(info, label, network):
    key, value = label.split('=', 1)
    if info.get('Config', {}).get('Labels', {}).get(key) != value or info.get('HostConfig', {}).get('PortBindings'):
        raise ValueError('not an isolated owned database')
    networks = info['NetworkSettings']['Networks']
    if set(networks) != {network}:
        raise ValueError('unexpected database network')
    address = networks[network]['IPAddress']
    ip = ipaddress.ip_address(address)
    if not ip.is_private or ip.is_loopback or address == '172.31.0.10':
        raise ValueError('unsafe database address')
    return address


def run_drill(workdir, unique_label, result):
    destination, marker_data = find_backup(BACKUP_ROOT)
    db_artifact = workdir / 'database'
    db_artifact.mkdir(mode=0o700)
    run_cmd(['rclone', 'copy', destination + '/database', str(db_artifact), '--immutable'])
    rows, counts = validate_artifact(db_artifact, marker_data)
    result['key_table_counts'] = {table: {'source': counts[table]} for table in KEY_TABLES}
    db_name = 'cold-db-' + secrets.token_hex(4)
    net_name = 'cold-net-' + secrets.token_hex(4)
    image = 'public.ecr.aws/supabase/postgres:17.6.1.147'

    run_cmd(['docker', 'network', 'create', '--internal', '--label', unique_label, net_name])

    pw = secrets.token_hex(24)
    jwt_secret = secrets.token_hex(32)
    env_file = workdir / 'database.env'
    env_file.write_text(f"POSTGRES_PASSWORD={pw}\nJWT_SECRET={jwt_secret}\nJWT_EXP=3600\nBACKUP_RO_PASSWORD={secrets.token_hex(24)}\nCOMMONSWARM_EDGE_DB_PASSWORD={secrets.token_hex(24)}\n")
    env_file.chmod(0o600)

    created = run_cmd(['docker', 'run', '-d', '--name', db_name, '--network', net_name, '--network-alias', 'cold-db', '--memory', '768m', '--env-file', str(env_file), '--label', unique_label, image, 'postgres', '-D', '/etc/postgresql', '-c', 'cron.launch_active_jobs=off', '-c', 'shared_buffers=64MB', '-c', 'max_connections=40'])
    result.update(restore_container_id=created.stdout.strip(), database='postgres')

    def sql(q):
        return run_cmd(['docker', 'exec', '-i', db_name, 'sh', '-c', 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U supabase_admin -d postgres -Atq'], input=q, check=False, timeout=15)

    wait_ready(lambda: sql("SELECT setting FROM pg_settings WHERE name='cron.launch_active_jobs';"),
               180, 'isolated database not ready/cron not disabled', 'off')

    address = assert_owned_db(json.loads(run_cmd(['docker', 'inspect', db_name]).stdout)[0], unique_label, net_name)

    setup_q = f"ALTER DATABASE postgres SET \"commonswarm.stack_identity\" TO 'n-db-target-v1'; ALTER DATABASE postgres SET \"commonswarm.local_rehearsal\" TO '1'; ALTER DATABASE postgres SET \"commonswarm.local_target_address\" TO '{address}';"
    if sql(setup_q).returncode != 0:
        raise RuntimeError("Failed to set local rehearsal variables")

    service_file = workdir / 'service'
    service_file.write_text(''.join(f'[{service}]\nhost=cold-db\nport=5432\ndbname={database}\nuser=supabase_admin\nsslmode=disable\n'
                                   for service, database in (('target', 'postgres'), ('source', 'schema_source'))))
    service_file.chmod(0o600)

    pass_file = workdir / 'pass'
    pass_file.write_text(f"cold-db:5432:*:supabase_admin:{pw}\n")
    pass_file.chmod(0o600)

    args = ['docker', 'run', '--rm', '--network', net_name, '--env-file', str(env_file), '-e', 'MIGRATION_ARTIFACT_DIR=/artifacts', '-e', 'PGSERVICEFILE=/run/service', '-e', 'PGPASSFILE=/run/pass', '-e', 'TARGET_DATABASE_URL=isolated-cold-recovery', '-v', f"{STACK_DIR}:/work:ro", '-v', f"{db_artifact}:/artifacts", '-v', f"{service_file}:/run/service:ro", '-v', f"{pass_file}:/run/pass:ro", '--label', unique_label, '--entrypoint']
    def artifact_tool(tool, *options):
        return run_cmd(args + [tool, image, *options], timeout=1800).stdout

    # Rebuild the artifact schema in the owned container, independently of the
    # target. Both hashes use one pg_dump filter; only its outer headers vary.
    listing = artifact_tool('pg_restore', '--list', '/artifacts/database.dump')
    (db_artifact / 'schema-list').write_text(''.join(line + '\n' for line in listing.splitlines()
        if 'commonswarm_cutover_write_freeze' not in line and 'commonswarm_cutover_write_guard' not in line))
    result['schema_checksums'] = {'algorithm': 'sha256-schema-ddl-v3'}
    artifact_tool('psql', '--dbname=service=target', '-X', '-v', 'ON_ERROR_STOP=1', '--file=/artifacts/roles.sql')
    artifact_tool('createdb', '--maintenance-db=service=target', '--template=postgres', 'schema_source')
    artifact_tool('pg_restore', '--dbname=service=source', '--schema-only', '--clean', '--if-exists',
                  '--exit-on-error',
                  '--use-list=/artifacts/schema-list', '/artifacts/database.dump')
    def schema_checksum(service):
        # PG17 --schema disables include_everything and silently omits all
        # publications/subscriptions. --exclude-schema keeps them dumpable.
        schemas = ','.join("'" + schema + "'" for schema in sorted(REQUIRED_DATABASE_SCHEMAS))
        excluded = artifact_tool('psql', '--dbname=service=' + service, '-XAt', '-v', 'ON_ERROR_STOP=1',
            '-c', f'SELECT pg_catalog.quote_ident(nspname) FROM pg_catalog.pg_namespace WHERE nspname NOT IN ({schemas}) ORDER BY nspname;')
        ddl = artifact_tool('pg_dump', '--dbname=service=' + service, '--schema-only', '--no-owner', '--no-privileges',
            '--exclude-table=public.commonswarm_cutover_probe',
            '--exclude-table=public.commonswarm_cutover_state', '--exclude-table=realtime.messages_*',
            *['--exclude-schema=' + schema for schema in excluded.splitlines()])
        # Anchors prevent header-shaped comments inside function bodies from
        # being normalized. Keep object headers, body comments and blank lines.
        ddl = re.sub(r'\A--\n-- PostgreSQL database dump\n--\n\n(?:\\restrict [A-Za-z0-9]+\n\n)?'
                     r'-- Dumped from database version [^\n]+\n-- Dumped by pg_dump version [^\n]+\n\n', '', ddl)
        ddl = re.sub(r'--\n-- PostgreSQL database dump complete\n--\n\n(?:\\unrestrict [A-Za-z0-9]+\n\n)?\Z', '', ddl)
        return hashlib.sha256(ddl.encode('utf-8')).hexdigest()
    result['schema_checksums']['source'] = schema_checksum('source')
    for script in ('restore-target.sh', 'prepare-target.sh', 'restore-cron-jobs.sh', 'verify-counts.sh'):
        res = run_cmd(args + ['/bin/bash', image, f'/work/migrate/{script}'], check=False, timeout=1800)
        (workdir / f"{script}.log").write_text(res.stdout + '\n' + res.stderr)
        if res.returncode != 0:
            raise RuntimeError(f"Script {script} failed")
        if script == 'restore-target.sh':
            result['restored_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            result['schema_checksums']['target'] = schema_checksum('target')
            measured = sql(' UNION ALL '.join(f"SELECT '{table}', count(*) FROM {table}" for table in KEY_TABLES) + ';')
            measured.check_returncode()
            for line in measured.stdout.splitlines():
                table, count = line.split('|')
                result['key_table_counts'][table]['target'] = int(count)

    if result['key_table_counts']['storage.objects']['target'] != len(rows):
        raise ValueError('restored file row count mismatch')
    tenant_prefix = destination.split('yulan-vps-1-backups/', 1)[1] + '/objects/commonswarm'
    endpoint, acc_key, digest, session = generate_temp_credentials(tenant_prefix)

    def enc(v): return base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode('utf-8')).decode('utf-8').rstrip('=')
    now_t = int(time.time())
    def make_jwt(role):
        data = enc({'alg': 'HS256', 'typ': 'JWT'}) + '.' + enc({'role': role, 'iss': 'supabase', 'iat': now_t, 'exp': now_t + 3600})
        sig = base64.urlsafe_b64encode(hmac.new(jwt_secret.encode('utf-8'), data.encode('utf-8'), hashlib.sha256).digest()).decode('utf-8').rstrip('=')
        return data + '.' + sig

    storage_env = {
        'ANON_KEY': make_jwt('anon'),
        'SERVICE_KEY': make_jwt('service_role'),
        'AUTH_JWT_SECRET': jwt_secret,
        'DATABASE_URL': f"postgres://supabase_storage_admin:{pw}@cold-db:5432/postgres?sslmode=disable",
        'REGION': 'auto',
        'STORAGE_BACKEND': 's3',
        'STORAGE_S3_FORCE_PATH_STYLE': 'true',
        'STORAGE_S3_REGION': 'auto',
        'FILE_SIZE_LIMIT': '26214400',
        'UPLOAD_FILE_SIZE_LIMIT': '26214400',
        'UPLOAD_FILE_SIZE_LIMIT_STANDARD': '26214400',
        'SIGNED_UPLOAD_URL_EXPIRATION_TIME': '7200',
        'S3_PROTOCOL_ENABLED': 'false',
        'ENABLE_IMAGE_TRANSFORMATION': 'false',
        'SERVER_PORT': '5000',
        'SERVER_ADMIN_PORT': '5001',
        'ENABLE_QUEUE_EVENTS': 'false',
        'TENANT_ID': tenant_prefix,
        'STORAGE_S3_BUCKET': 'yulan-vps-1-backups',
        'STORAGE_S3_ENDPOINT': endpoint,
        'AWS_ACCESS_KEY_ID': acc_key,
        'AWS_SECRET_ACCESS_KEY': digest,
        'AWS_SESSION_TOKEN': session
    }
    storage_env_file = workdir / 'storage.env'
    storage_env_file.write_text(''.join(f"{k}={v}\n" for k, v in storage_env.items()))
    storage_env_file.chmod(0o600)

    storage_name = 'cold-storage-' + secrets.token_hex(4)
    run_cmd(['docker', 'create', '--name', storage_name, '--network', net_name, '--memory', '384m', '--env-file', str(storage_env_file), '--label', unique_label, 'public.ecr.aws/supabase/storage-api:v1.77.5'])
    egress_name = net_name + '-egress'
    run_cmd(['docker', 'network', 'create', '--label', unique_label, egress_name])
    run_cmd(['docker', 'network', 'connect', egress_name, storage_name])
    run_cmd(['docker', 'start', storage_name])

    wait_ready(lambda: run_cmd(['docker', 'exec', storage_name, 'node', '-e', "fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], check=False, timeout=10),
               120, 'isolated storage API not ready')

    items_expected = fetch_offsite_bytes(rows, endpoint, acc_key, digest, session, tenant_prefix)
    results = fetch_api_bytes(items_expected, storage_name)

    if sorted(x['index'] for x in results) != list(range(len(rows))):
        raise RuntimeError("Duplicate or missing indices in API results")

    if any(x.get('matches') is not True or x.get('status') != 200 for x in results):
        raise RuntimeError("Object match failed for some items")

    return {'destination': destination, 'objects': len(rows), 'tables': len(counts),
            'database_verified': True, 'all_files_verified': True}


def remove_drill_directory(path):
    # Unlink a symlink. Do not walk it. A symlink can point outside this directory.
    if path.is_symlink():
        raise RuntimeError('refusing to delete a drill symlink')
    if not path.is_dir():
        raise RuntimeError('refusing to delete a non-directory')
    for child in path.iterdir():
        if child.is_symlink() or not child.is_dir():
            child.unlink()
            continue
        remove_drill_directory(child)
    path.rmdir()


def prune_drill_workdirs(base, keep):
    if keep < 1:
        raise RuntimeError('drill directory keep count must be at least 1')
    base = Path(base)
    if base.is_symlink() or not base.is_dir():
        raise RuntimeError('drill work directory base is not a directory')
    base_abs = Path(os.path.abspath(base))
    candidates = sorted((Path(os.path.abspath(child)) for child in base.iterdir()
                         if not child.is_symlink() and child.is_dir() and re.fullmatch(r'[0-9a-f]{32}', child.name)),
                        key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
    for old in candidates[keep:]:
        if old.is_symlink() or not old.is_dir() or old.parent != base_abs:
            raise RuntimeError('refusing to delete outside the drill directory')
        if re.fullmatch(r'[0-9a-f]{32}', old.name) is None:
            raise RuntimeError('refusing to delete outside the drill directory')
        remove_drill_directory(old)


def main():
    import fcntl
    global DEADLINE
    os.umask(0o077)
    status_file = Path(STATUS_FILE)
    status_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        return 75
    workdir = Path(WORKDIR_BASE) / secrets.token_hex(16)
    label = 'commonswarm.drill=' + secrets.token_hex(16)
    result = {'ok': False, 'state': 'running', 'invocation_id': os.environ.get('INVOCATION_ID'), 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    old_handlers = {}
    def interrupted(signum, frame):
        raise InterruptedError('restore drill interrupted')
    try:
        atomic_write_status(status_file, result)
        workdir.mkdir(parents=True, mode=0o700)
        prune_drill_workdirs(Path(WORKDIR_BASE), DRILL_WORKDIR_KEEP)
        (workdir / 'ownership.json').write_text(json.dumps({'label': label, 'workdir': str(workdir)}))
        result['label'] = label
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
            old_handlers[sig] = signal.signal(sig, interrupted)
        DEADLINE = time.monotonic() + 3 * 3600
        signal.alarm(3 * 3600)
        result.update(run_drill(workdir, label, result))
        result['state'] = 'verified_pending_cleanup'
    except BaseException as error:
        result.update(state='failed', error_type=type(error).__name__)
    finally:
        signal.alarm(0)
        DEADLINE = None
        for sig in (signal.SIGINT, signal.SIGTERM):
            if sig in old_handlers:
                signal.signal(sig, signal.SIG_IGN)
        try:
            result['status'] = 'PASS' if result['state'] == 'verified_pending_cleanup' else 'FAIL'
            try:
                atomic_write_status(status_file, result)
            finally:
                cleanup(workdir, label)
            if result['state'] == 'verified_pending_cleanup':
                result.update(ok=True, state='complete')
        except BaseException as error:
            result.update(ok=False, state='cleanup_failed', cleanup_error_type=type(error).__name__)
        result['status'] = 'PASS' if result['ok'] else 'FAIL'
        result.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), evidence=str(workdir))
        try:
            atomic_write_status(status_file, result)
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)
            os.close(lock_fd)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
