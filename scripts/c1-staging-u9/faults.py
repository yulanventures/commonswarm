#!/usr/bin/env python3
"""Emit staging-only W4 faults; keep the reviewed plan and its hash unchanged.

Source checkpoints: RELEASE.md at e8277108:4710, 4734, 4802; recovery:
4875 and 8915-8919. Plan section 1e owns the restoration sets. This tool
does no service work itself; the release worker evaluates its emitted body
in the admitted W4 shell. Each body rechecks the staging guard at execution.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import shlex
import sys
import stat

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_preflight', ROOT / 'scripts/release-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import HOST, canonical, digest, need, now, read, guard, directory, write
CHECKPOINTS = {
    'F1': ('ln -sfT "$NEW_EDGE" /home/commonswarm/edge/current.admin-issuance\n', False),
    'F2': ('# Separate terminal-fence approval was checked by ai-inputs, before open.\n', False),
    'F3': ('RECYCLE_INSTALL_ACTION=install\nai_run ai-recycle-install\n', True),
}


def context(plan, inputs, proof):
    guard()
    d = json.loads(read(inputs))
    need(d.get('window') == 'W4' and re.fullmatch(r'[0-9a-f]{40}', d.get('release_sha', ''))
         and re.fullmatch(r'[A-Za-z0-9]{6}', d.get('window_id', '')), 'W4 release/window binding required')
    need(pathlib.Path(plan).is_absolute() and os.path.realpath(plan) == plan, 'canonical absolute plan required')
    fd = os.open(plan, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        need(stat.S_ISREG(os.fstat(file.fileno()).st_mode), 'regular reviewed plan required')
        raw = file.read()
    need(digest(raw) == d.get('plan_sha256'), 'reviewed plan hash mismatch')
    expected = '/home/commonswarm/admin-issuance/release-proofs/' + d['release_sha'] + '-W4-' + d['window_id']
    need(proof == expected and os.path.realpath(proof) == proof, 'window proof directory mismatch')
    directory(proof)
    return d, raw.decode()


def inject(body, case, command):
    """One insertion; reject a missing or ambiguous source checkpoint."""
    anchor, after = CHECKPOINTS[case]
    need(body.count(anchor) == 1, 'fault checkpoint missing or ambiguous')
    insertion = command + '\nexit 97\n'
    return body.replace(anchor, anchor + insertion if after else insertion + anchor)


# Independent readback through the already-admitted ai_ro shell; never credentials.
SQL = "SELECT json_build_object('admin_issuance_enabled',admin_issuance_enabled,'invalidated',invalidated_at IS NOT NULL,'release_generation',release_generation,'measured_generation',measured_generation)::text FROM commonswarm_oauth.admin_cutover_state WHERE singleton;"


def receipt(case, d, proof, cutover):
    guard()
    need(isinstance(cutover, dict) and cutover.get('admin_issuance_enabled') is False
         and cutover.get('invalidated') is (case != 'F3'), 'CLOSED boundary invalidation readback required')
    c = json.loads(subprocess.check_output(['docker', 'inspect', 'commonswarm-edge-edge-runtime-1'],
                                         stderr=subprocess.DEVNULL, timeout=30))[0]
    healthy = c['State'].get('Health', {}).get('Status') == 'healthy'
    need(case == 'F1' or healthy, 'healthy recreated edge required')
    # Bind the existing comparison inputs rather than invent another manifest.
    # The edge writer uses umask mode, while W4 state receipts are root 0600.
    artifacts = {}
    for name in ('w4-state/roots-before.json', 'w4-state/recycle-baseline.json',
                 'keeper-retired.json', 'keeper-absent.json', 'edge-measurement.json',
                 'w4-state/install-after.json'):
        path = canonical(proof + '/' + name)
        if not os.path.lexists(path):
            continue
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            st = os.fstat(file.fileno())
            need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == st.st_gid == 0
                 and not st.st_mode & 0o022, 'protected boundary artifact required')
            raw = file.read()
        artifacts[name] = dict(path=path, sha256=digest(raw), value=json.loads(raw))
    need(all(name in artifacts for name in ('w4-state/roots-before.json', 'w4-state/recycle-baseline.json'))
         and any(name in artifacts for name in ('keeper-retired.json', 'keeper-absent.json')),
         'pre-attempt comparison inputs required')
    need(('edge-measurement.json' in artifacts) is (case != 'F1')
         and ('w4-state/install-after.json' in artifacts) is (case == 'F3'), 'fault artifact boundary mismatch')
    row = dict(kind='c1-staging-u9-fault', case=case, host=HOST,
               release_sha=d['release_sha'], window='W4', window_id=d['window_id'],
               plan_sha256=d['plan_sha256'], checkpoint_sha256=digest(CHECKPOINTS[case][0].encode()),
               exit_status=97, at=now().isoformat(), observation=dict(cutover=cutover, healthy=healthy,
                   container=dict(id=c['Id'], started_at=c['State']['StartedAt'], image_digest=c['Image']),
                   recycle_install='completed' if case == 'F3' else 'not-run', artifacts=artifacts))
    write(proof + '/u9-' + case + '-injected.json', row)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fault', 'undo', 'close', 'check', 'receipt'])
    parser.add_argument('case', choices=CHECKPOINTS)
    parser.add_argument('plan')
    parser.add_argument('inputs')
    parser.add_argument('proof')
    args = parser.parse_args()
    d, text = context(args.plan, args.inputs, args.proof)
    if args.action == 'check':
        return
    if args.action == 'receipt':
        receipt(args.case, d, args.proof, json.load(sys.stdin))
        return
    blocks = preflight.blocks(text)
    invocation = 'python3 ' + shlex.quote(str(pathlib.Path(__file__).resolve()))
    arguments = ' ' + ' '.join(shlex.quote(x) for x in (args.case, args.plan, args.inputs, args.proof))
    if args.action == 'fault':
        body = inject(blocks['ai-w4-apply'], args.case, 'ai_ro -Atq --command ' + shlex.quote(SQL) + ' | ' + invocation + ' receipt' + arguments + ' || exit 2')
    elif args.action == 'undo':
        body = blocks['ai-w4-rollback']
    else:
        body = 'CLOSE_RESULT=recovered\n' + blocks['ai-close']
    # Guard copied output as well as the emitter. Never eval in an if/|| context:
    # Bash suppresses errexit there, including inside the original W4 subshell.
    bindings = dict(PLAN_FILE=args.plan, INPUTS_FILE=args.inputs, PROOF_DIR=args.proof,
                    RELEASE_SHA=d['release_sha'], WINDOW='W4', WINDOW_ID=d['window_id'])
    checks = '\n'.join('test "${' + key + ':-}" = ' + shlex.quote(value) + ' || exit 2'
                       for key, value in bindings.items())
    print('(\n' + checks + '\n' + invocation + ' check' + arguments + ' || exit 2\n' + body + '\n)')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, subprocess.SubprocessError):
        raise SystemExit('STOP U9 fault driver: invalid staging context, checkpoint or receipt; retained state requires lead inspection') from None
