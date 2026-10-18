#!/usr/bin/env python3
"""Read-only release contract checks. No network, box access, or secret reads.

The reviewed release-contract fence inventories inputs, artifacts and run paths.
Artifacts are logical paths (including template variables), not live observations.
The box still measures the declared reads and freshness in its existing gates.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


def deletion_controls(repo, temp_root='/private/tmp'):
    # Current site releases never prune: reuse the canonical executable owner
    # for positive deploy, genuine refusals, rollback and reserve retention.
    # Historical inline deletion helpers belong to the pinned legacy CLI tests.
    # The owner retains its existing Linux/root scope for rendered-script proof.
    pathlib.Path(temp_root).resolve(strict=True)
    environment = dict(os.environ)
    environment.pop('NODE_TEST_CONTEXT', None)  # Run the owner, not a nested-runner no-op.
    result = subprocess.run(['node', '--import', 'tsx', '--test',
                             'tests/p1-cli/site-artifact.test.ts'],
                            cwd=pathlib.Path(repo).resolve(strict=True),
                            capture_output=True, text=True, env=environment)
    if result.returncode or not re.search(r'^# pass [1-9][0-9]*$', result.stdout, re.M):
        raise ValueError('current site release controls failed: ' + result.stdout + result.stderr)


def blocks(text):
    result = {}
    for body in re.findall(r'^```sh\n(.*?)^```$', text, re.M | re.S):
        match = re.match(r'# step: ([a-z0-9-]+)', body)
        if not match or match[1] in result:
            raise ValueError('missing or duplicate step')
        result[match[1]] = body
    return result


def measurements(body):
    paths = set(re.findall(r'(?<![\w/])/(?:home/commonswarm|srv/commonswarm|etc)/(?:[A-Za-z0-9_./*-]+)', body))
    # Embedded Python argv carries the same observations as shell commands.
    normalized = re.sub(r"['\"]\s*,\s*['\"]", ' ', body)
    commands = {name for name in ('docker inspect', 'docker stats', 'docker compose',
                                 'docker image inspect', 'systemctl is-active', 'readlink -f', 'release_psql_ro') if name in normalized}
    urls = set(re.findall(r'https?://[^\s\"\'<>),]+', body))
    return sorted(paths | {'command:' + name for name in commands} | {'endpoint:' + url for url in urls})


def repo_references(body):
    return set(re.findall(r'(?<![\w/-])(?:deploy|services|supabase|scripts|tests|site|src)/[A-Za-z0-9_./+-]+', body))


def cleanup_targets(body):
    return set(a or b for a, b in re.findall(
        r'(?m)^\s*(?:if\s+!\s+)?(?:/usr/bin/)?rm\s+(?:(?:-[\w-]+)\s+)*(?:"([^"\n]+)"|([^\s;|&]+))', body))


def receipt(path, sha, gates):
    p = pathlib.Path(path)
    if not p.is_absolute() or p.is_symlink() or not p.is_file():
        raise ValueError('receipt must be an absolute regular non-symlink file')
    value = json.loads(p.read_text())
    if not isinstance(value, dict) or value.get('sha') != sha:
        raise ValueError('receipt sha mismatch')
    statuses = value.get('gates', {})
    if not isinstance(statuses, dict) or any(statuses.get(gate) != 'PASS' for gate in gates):
        raise ValueError('receipt gate missing or failed')


def fields(path, expected):
    # Existing machine receipts are key=value fields; ignore unrelated prose.
    rows = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', line):
            for key, value in re.findall(r'(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)', line):
                rows.setdefault(key, []).append(value)
    for key, value in expected.items():
        if rows.get(key) != [value]:
            raise ValueError('receipt field missing, duplicate or mismatching: ' + key)


def valid_input(value, rule):
    if not isinstance(value, str) or not value or '\n' in value or '\0' in value:
        return False
    fmt = rule['format']
    patterns = {'sha40': r'[0-9a-f]{40}', 'digest': r'sha256:[0-9a-f]{64}',
                'uuid': r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
                'decimal-positive': r'[1-9][0-9]*', 'schema-set': r'[0-9]{14}(,[0-9]{14})*',
                'op-reference': r'op://Yulan Ventures Infra/[^/\n]+/[^/\n]+'}
    if fmt in patterns:
        if not re.fullmatch(patterns[fmt], value):
            return False
        if fmt == 'schema-set' and len(value.split(',')) != len(set(value.split(','))):
            return False
        if 'maximum' in rule and int(value) > rule['maximum']:
            return False
        return True
    if fmt == 'utc-window':
        try:
            end = datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
            return 0 < (end - datetime.datetime.now(datetime.timezone.utc)).total_seconds() <= 1800
        except ValueError:
            return False
    if fmt.startswith('literal:'):
        return value == fmt[len('literal:'):]
    p = pathlib.Path(value)
    if not p.is_absolute() or '..' in p.parts or p.is_symlink():
        return False
    if fmt == 'abs-file':
        # Check metadata only; never open a credential file.
        return p.is_file() and ('mode' not in rule or stat.S_IMODE(p.stat().st_mode) == rule['mode'])
    if fmt == 'empty-dir':
        return p.is_dir() and not any(p.iterdir()) and ('mode' not in rule or stat.S_IMODE(p.stat().st_mode) == rule['mode'])
    return False


def check(plan, inputs, repo):
    problems = []
    text = plan.read_text()
    fences = re.findall(r'^```release-contract\n(.*?)^```$', text, re.M | re.S)
    if len(fences) != 1:
        return ['plan: exactly one release-contract required']
    contract = json.loads(fences[0])
    steps = blocks(text)
    if inputs.get(contract['plan_input']) != str(plan.resolve()):
        problems.append('field ' + contract['plan_input'] + ': does not identify the supplied plan')
    for field, rule in contract['inputs'].items():
        if not valid_input(inputs.get(field), rule):
            problems.append('field ' + field + ': missing or invalid ' + rule['format'])
    sha = inputs.get(contract['release_input'], '')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        problems.append('RELEASE_SHA: full lowercase commit required')
    else:
        identity = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', sha + '^{commit}'], capture_output=True, text=True)
        if identity.returncode or identity.stdout.strip() != sha:
            problems.append('RELEASE_SHA: commit missing')
    for alias, dependency in contract.get('references', {}).items():
        result = subprocess.run(['git', '-C', str(repo), 'show', sha + ':' + dependency['plan']], capture_output=True, text=True)
        try:
            steps[alias] = blocks(result.stdout)[dependency['step']]
        except (ValueError, KeyError):
            problems.append(alias + ': referenced plan/step missing at RELEASE_SHA')
    for candidate, baseline in contract.get('different', []):
        if inputs.get(candidate) == inputs.get(baseline):
            problems.append('field ' + candidate + ': must differ from ' + baseline)
    for gate in contract.get('gate_receipts', []):
        try:
            receipt(inputs.get(gate['input'], ''), sha, gate['gates'])
        except (ValueError, OSError, TypeError) as error:
            problems.append('field ' + gate['input'] + ': ' + str(error))
    # Repository paths are checked in the object database, never the worktree.
    for path in contract['repo_paths']:
        if path.startswith('/') or '..' in pathlib.PurePosixPath(path).parts:
            problems.append('repo path ' + path + ': unsafe')
        elif subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', sha + ':' + path], capture_output=True).returncode:
            problems.append('repo path ' + path + ': missing at RELEASE_SHA')
    covered = set(contract['repo_paths']) | set(contract.get('runtime_paths', []))
    for step, body in steps.items():
        for path in repo_references(body) - covered:
            problems.append(step + ': repo path absent from inventory: ' + path)
    # Each normal/recovery route is independent: a future or alternate-route
    # producer cannot supply a consumer in this run. Optional absence tests do
    # not consume the file; helper-created files name the invoking step.
    for route, order in contract['routes'].items():
        available = set(contract.get('input_files', []))
        created = set()
        for step in order:
            if step not in steps:
                problems.append('route ' + route + ': missing step ' + step)
                continue
            io = contract['steps'].get(step, {})
            for path in io.get('consumes', []):
                if path not in available:
                    problems.append(step + ': consumer has no earlier producer/input: ' + path)
            for path in io.get('creates', []):
                available.add(path)
                created.add(path)
            for path in io.get('cleanup', []):
                if path not in created:
                    problems.append(step + ': cleanup target not created in this route: ' + path)
    for step in steps:
        if step not in contract['steps']:
            problems.append(step + ': missing I/O declaration')
    for step, io in contract['steps'].items():
        if step not in steps:
            problems.append(step + ': declared step missing')
        if step in steps and io.get('sha256') != hashlib.sha256(steps[step].encode()).hexdigest():
            problems.append(step + ': block changed; review/update its I/O inventory')
        for read in measurements(steps.get(step, '')):
            if read not in io.get('reads', []):
                problems.append(step + ': box measurement not listed as read: ' + read)
        for target in cleanup_targets(steps.get(step, '')):
            producer = io.get('cleanup_owners', {}).get(target)
            if not producer or target not in contract['steps'].get(producer, {}).get('creates', []):
                problems.append(step + ': cleanup target not created by plan: ' + target)
    return problems


def main():
    try:
        if len(sys.argv) >= 2 and sys.argv[1] == 'deletion-controls':
            deletion_controls(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else '/private/tmp')
        elif len(sys.argv) >= 2 and sys.argv[1] == 'gate':
            receipt(sys.argv[2], sys.argv[3], sys.argv[4:])
        elif len(sys.argv) >= 2 and sys.argv[1] == 'fields':
            fields(sys.argv[2], dict(item.split('=', 1) for item in sys.argv[3:]))
        else:
            if len(sys.argv) != 4:
                raise ValueError('usage: release-preflight.py PLAN INPUTS.json REPO')
            inputs = json.loads(pathlib.Path(sys.argv[2]).read_text())
            if not isinstance(inputs, dict):
                raise ValueError('INPUTS must be a JSON object of nonsecret values')
            problems = check(pathlib.Path(sys.argv[1]), inputs, pathlib.Path(sys.argv[3]))
            if problems:
                print('\n'.join('FAIL: ' + problem for problem in problems))
                return 1
        print('PASS')
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('FAIL: ' + str(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
