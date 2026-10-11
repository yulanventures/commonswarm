#!/usr/bin/env python3
"""ARCH section 5: legacy positive/loss/restoration controls, steps 1–3 only.

Emit for the admitted ai_ro session; every execution rechecks faults.context.
No upgrade, reboot, durable migration, or legacy W4 rollback is synthesized.
"""
import argparse
import json
import os
import pathlib
import pwd
import re
import shlex
import stat
import subprocess
import sys

from common import canonical, digest, directory, guard, need, read, sync_directory, write
from faults import context, preflight

CONFIG = '/etc/commonswarm-admin-release/recycle.json'
HOOK = '/usr/local/libexec/commonswarm-admin-edge-recycle'
SERVICE = 'commonswarm-edge-recycle.service'
TIMER = 'commonswarm-edge-recycle.timer'
SQL = "SELECT json_build_object('admin_issuance_enabled',admin_issuance_enabled,'release_generation',release_generation,'measured_generation',measured_generation,'invalidated',invalidated_at IS NOT NULL,'release_sha',measured_edge_release_sha,'target',measured_edge_target,'mount',measured_mount,'image_digest',measured_image_digest,'artifact_digest',measured_artifact_digest)::text FROM commonswarm_oauth.admin_cutover_state WHERE singleton;"


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=120).strip()


def file_id(path):
    s = os.lstat(path)  # Ownership checks must identify a replacement symlink itself.
    return [s.st_dev, s.st_ino]


def copy_bytes(path, raw, owner, mode, expected):
    """Exclusive verified copy; on failure remove only our own created inode."""
    need(digest(raw) == expected, 'copy source digest mismatch')
    fd = os.open(canonical(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    created = os.fstat(fd)
    identity = [created.st_dev, created.st_ino]
    try:
        with os.fdopen(fd, 'wb') as file:
            os.fchown(file.fileno(), *owner)
            os.fchmod(file.fileno(), mode)
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        sync_directory(pathlib.Path(path).parent)
        need(file_id(path) == identity and digest(read(path, owner)) == expected, 'copy digest mismatch')
    except BaseException:
        try:
            ours = file_id(path) == identity
        except (OSError, ValueError):
            ours = False
        if ours:
            os.unlink(path)
            sync_directory(pathlib.Path(path).parent)
        raise
    return identity


def observation(cutover):
    need(isinstance(cutover, dict) and cutover.get('admin_issuance_enabled') is False,
         'independent CLOSED readback required; unreadable is UNKNOWN')
    raw = read(CONFIG)
    config = json.loads(raw)
    match = re.fullmatch(r'/tmp/admin-issuance-([0-9a-f]{40})-([A-Za-z0-9]{6})\.tar', config['archive'])
    need(match and match[1] == config['release_sha'], 'exact legacy binding required')
    need(config['release_root'] == '/home/commonswarm/admin-issuance/releases/' + match[1], 'bound helper tree required')
    canonical(config['archive'])
    durable = '/var/lib/commonswarm-admin-release/archives/' + match[1] + '-' + match[2] + '.tar'
    directory(pathlib.Path(durable).parent)
    need(digest(read(durable)) == config['artifact_digest'], 'durable rescue digest mismatch')
    fd = os.open(canonical(HOOK), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        s = os.fstat(file.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and s.st_nlink == 1
             and stat.S_IMODE(s.st_mode) == 0o700, 'root:root 0700 hook required')
        hook = digest(file.read())
    c = json.loads(command('docker', 'inspect', 'commonswarm-edge-edge-runtime-1'))[0]
    def metadata(path):
        s = os.lstat(path)
        return dict(uid=s.st_uid, gid=s.st_gid, mode=stat.S_IMODE(s.st_mode), links=s.st_nlink)
    return dict(config_sha256=digest(raw), hook_sha256=hook, archive=config['archive'],
                artifact_digest=config['artifact_digest'], durable=durable,
                config_metadata=metadata(CONFIG), hook_metadata=metadata(HOOK),
                mounts=[m for m in c['Mounts'] if m['Destination'] in
                        ('/home/deno/main', '/home/deno/functions-source', '/var/src')],
                edge_current=str(pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True)),
                helper_tree=str(pathlib.Path(canonical(config['release_root'])).resolve(strict=True)),
                started_at=c['State']['StartedAt'], image_digest=c['Image'],
                healthy=c['State'].get('Health', {}).get('Status') == 'healthy',
                timer_active=command('systemctl', 'show', TIMER, '--property=ActiveState', '--value'),
                service_state=command('systemctl', 'show', SERVICE, '--property=ActiveState', '--value'),
                service_result=command('systemctl', 'show', SERVICE, '--property=Result', '--value'),
                cutover=cutover)


def execute(phase, d, text, proof, cutover, rc=0):
    guard()
    current = observation(cutover)
    def path(name): return proof + '/u9-ARCH-' + name + '.json'
    def saved(name):
        row = json.loads(read(path(name)))
        need(row['release_sha'] == d['release_sha'] and row['window_id'] == d['window_id']
             and row['plan_sha256'] == d['plan_sha256'], 'ARCH receipt binding mismatch')
        return row
    receipt = dict(kind='c1-staging-u9-archive', phase=phase, release_sha=d['release_sha'],
                   window='W4', window_id=d['window_id'], plan_sha256=d['plan_sha256'],
                   identity=guard(), observation=current, service_exit=rc)
    need(not os.path.lexists(path(phase)), 'ARCH phase already recorded')
    if phase == 'before':
        account = pwd.getpwnam(d['keeper_upload_owner'])
        owner = (account.pw_uid, account.pw_gid)
        archive = current['archive']
        s = os.lstat(archive)
        if s.st_uid == s.st_gid == 0: owner = (0, 0)
        need(digest(read(archive, owner)) == current['artifact_digest'], 'legacy archive digest mismatch')
        # Installed compatibility hook must be the reviewed plan's exact block.
        expected = digest(('#!/bin/bash\n' + preflight.blocks(text)['ai-recycle-hook']).encode())
        need(current['hook_sha256'] == expected and current['timer_active'] == 'active'
             and current['service_state'] == 'inactive', 'reviewed compatibility hook and idle active timer required')
        receipt.update(archive_owner=list(owner), archive_mode=stat.S_IMODE(s.st_mode),
                       aside=proof + '/u9-ARCH-legacy.tar', archive_identity=file_id(archive),
                       config_bytes_sha256=current['config_sha256'])
        receipt['aside_identity'] = copy_bytes(receipt['aside'], read(archive, owner), owner,
                                              receipt['archive_mode'], current['artifact_digest'])
        created = {receipt['aside']: receipt['aside_identity']}
        try:
            created[path('config')] = copy_bytes(path('config'), read(CONFIG), (0, 0), 0o600,
                                                current['config_sha256'])
            raw = (json.dumps(receipt, sort_keys=True) + '\n').encode()
            copy_bytes(path(phase), raw, (0, 0), 0o600, digest(raw))
        except BaseException:
            # No durable undo pointer yet: remove only this call's owned inodes.
            for artifact, identity in created.items():
                try:
                    ours = file_id(artifact) == identity
                except (OSError, ValueError):
                    continue
                if ours:
                    os.unlink(artifact)
            sync_directory(proof)
            raise
        # The verified durable undo pointer precedes every timer mutation.
        command('systemctl', 'stop', TIMER)
        need(command('systemctl', 'show', SERVICE, '--property=ActiveState', '--value') == 'inactive',
             'service raced timer hold; STOP, use explicit undo')
        return
    baseline = saved('before')
    prior = baseline['observation']
    for key in ('config_sha256', 'hook_sha256', 'archive', 'artifact_digest', 'durable',
                'edge_current', 'helper_tree', 'image_digest', 'config_metadata', 'hook_metadata', 'mounts'):
        need(current[key] == prior[key], 'ARCH baseline drift')
    archive, aside = prior['archive'], baseline['aside']
    need(aside == proof + '/u9-ARCH-legacy.tar', 'exact aside required')
    owner = tuple(baseline['archive_owner'])
    if phase == 'loss':
        positive = saved('positive')['observation']
        need(current['timer_active'] == 'inactive' and current['service_state'] == 'inactive'
             and current['cutover'] == positive['cutover'] and current['started_at'] == positive['started_at'], 'idle held positive baseline required')
        need(file_id(archive) == baseline['archive_identity']
             and file_id(aside) == baseline['aside_identity']
             and digest(read(archive, owner)) == digest(read(aside, owner)) == prior['artifact_digest'],
             'legacy/aside identity or bytes changed')
        os.unlink(archive)
    elif phase == 'restore':
        need(current['timer_active'] == 'inactive' and current['service_state'] in ('failed', 'inactive'), 'held idle restore required')
        if current['service_state'] == 'failed':
            saved('negative')  # never restore/reset an unrecorded or unexpected failure
        if os.path.lexists(aside):
            need(file_id(aside) == baseline['aside_identity'], 'aside is not driver-created')
            if os.path.lexists(archive) and file_id(archive) == file_id(aside):
                # Recover the old link/unlink failure without single-link read().
                fd = os.open(canonical(aside), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, 'rb') as file:
                    s = os.fstat(file.fileno())
                    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 2 and (s.st_uid, s.st_gid) == owner
                         and stat.S_IMODE(s.st_mode) == baseline['archive_mode']
                         and digest(file.read()) == prior['artifact_digest'], 'shared aside mismatch')
            elif os.path.lexists(archive):
                need(digest(read(archive, owner)) == prior['artifact_digest'], 'legacy path occupied')
            else:
                copy_bytes(archive, read(aside, owner), owner, baseline['archive_mode'], prior['artifact_digest'])
            os.unlink(aside)
        need(digest(read(archive, owner)) == prior['artifact_digest'] and read(CONFIG) == read(proof + '/u9-ARCH-config.json'), 'exact archive/config restore required')
    elif phase == 'negative':
        positive = saved('positive')['observation']
        pre = command('systemctl', 'show', SERVICE, '--property=ExecStartPre', '--value')
        journal = command('journalctl', '--unit=' + SERVICE, '--since=' + saved('loss')['identity']['measured_at'], '--output=cat', '--no-pager')
        need(rc != 0 and not os.path.lexists(archive) and current['service_result'] == 'exit-code'
             and HOOK + ' before' in pre and re.search(r'\bstatus=[1-9][0-9]*\b', pre) and 'code=exited' in pre
             and 'UNKNOWN' in journal and current['started_at'] == positive['started_at']
             and current['cutover'] == positive['cutover'], 'expected pre-hook UNKNOWN/no-restart failure not proved')
        receipt.update(unknown_observed=True, journal_sha256=digest(journal.encode()))
    else:
        need(phase in ('positive', 'recovered', 'done') and rc == 0 and current['healthy']
             and current['service_result'] == 'success' and current['cutover'].get('invalidated') is False
             and current['cutover']['release_generation'] == current['cutover']['measured_generation'], 'successful measured CLOSED recycle required')
        for key in ('release_sha', 'target', 'mount', 'image_digest', 'artifact_digest'):
            need(current['cutover'][key] == prior['cutover'][key], 'recycle measurement identity drift')
        previous = saved('positive')['observation'] if phase == 'recovered' and os.path.lexists(path('positive')) else prior
        need(current['cutover']['release_generation'] > previous['cutover']['release_generation'] if phase != 'done'
             else current['timer_active'] == 'active', 'fresh generation / final timer required')
        need(digest(read(archive, owner)) == prior['artifact_digest'], 'positive archive mismatch')
    if phase in ('loss', 'restore'):
        sync_directory(pathlib.Path(archive).parent)
        sync_directory(proof)
    write(path(phase), receipt)


def emit(step, args, d):
    invocation = 'python3 ' + shlex.quote(str(pathlib.Path(__file__).resolve()))
    tail = ' '.join(shlex.quote(x) for x in (args.plan, args.inputs, args.proof))
    call = invocation + ' execute '
    lines = ['set -euo pipefail', invocation + ' check ' + tail + ' || exit 2',
             'declare -F ai_ro >/dev/null || exit 2',
             'u9_arch() { ai_ro -Atq --command ' + shlex.quote(SQL) + ' | ' + call + '"$1" ' + tail + ' "${2:-0}"; }']
    bindings = dict(PLAN_FILE=args.plan, INPUTS_FILE=args.inputs, PROOF_DIR=args.proof,
                    RELEASE_SHA=d['release_sha'], WINDOW='W4', WINDOW_ID=d['window_id'])
    lines[1:1] = ['test "${' + key + ':-}" = ' + shlex.quote(value) + ' || exit 2'
                  for key, value in bindings.items()]
    if step == '1':
        lines += ['u9_arch before', 'systemctl start ' + SERVICE, 'u9_arch positive']
    elif step == '2':
        lines += ['u9_arch loss', 'U9_ARCH_RC=0', 'systemctl start ' + SERVICE + ' || U9_ARCH_RC=$?',
                  'u9_arch negative "$U9_ARCH_RC"']
    else:  # explicit undo is restoration, a fresh control, then timer recovery
        lines += ['u9_arch restore', 'systemctl reset-failed ' + SERVICE, 'systemctl start ' + SERVICE,
                  'u9_arch recovered', 'systemctl start ' + TIMER, 'u9_arch done']
    return '(\n' + '\n'.join(lines) + '\n)'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['1', '2', '3', 'undo', 'execute', 'check'])
    parser.add_argument('rest', nargs='+')
    args = parser.parse_args()
    if args.action == 'execute':
        phase, args.plan, args.inputs, args.proof, rc = args.rest
    else:
        args.plan, args.inputs, args.proof = args.rest
    d, text = context(args.plan, args.inputs, args.proof)
    if args.action == 'execute':
        cutover = json.load(sys.stdin)
        execute(phase, d, text, args.proof, cutover, int(rc))
    elif args.action != 'check':
        print(emit(args.action, args, d))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        raise SystemExit('STOP U9 ARCH: context/control refused; archive, aside and held timer require explicit undo or lead inspection') from None
