#!/usr/bin/env python3
"""Ratchet UTF-8 file sizes in Git snapshots; no third-party dependencies.

CI: --base SHA [--merge-base] --head SHA. Local hook: --staged.
Inventory: --inventory [--head SHA]. Ignore patterns use Git's own matcher.
"""
import argparse
import json
import os
from pathlib import PurePosixPath
import subprocess
import sys
import tempfile

# The complete size policy: estimated tokens = ceil(Unicode characters / 4).
LIMIT = 5000
CHARACTERS_PER_TOKEN = 4
LOCKFILES = {
    'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock',
    'bun.lockb', 'poetry.lock', 'uv.lock', 'deno.lock',
}


def git(*args, data=None, env=None):
    return subprocess.run(
        ['git', *args], input=data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True, env=env,
    ).stdout


def tokens(characters):
    return (characters + CHARACTERS_PER_TOKEN - 1) // CHARACTERS_PER_TOKEN


def characters(blob):
    if b'\0' in blob:
        return None
    try:
        return len(blob.decode('utf-8'))
    except UnicodeDecodeError:
        return None


def empty_tree():
    return git('hash-object', '-w', '-t', 'tree', '--stdin', data=b'').strip().decode()


def resolve(ref):
    if ref and set(ref) == {'0'}:
        return empty_tree()
    return git('rev-parse', '--verify', ref + '^{tree}').strip().decode()


def blobs(oids):
    """Read blobs in one Git process, preserving newlines and arbitrary bytes."""
    oids = sorted(set(oids) - {None})
    if not oids:
        return {}
    output = git('cat-file', '--batch', data=('\n'.join(oids) + '\n').encode())
    result = {}
    offset = 0
    for oid in oids:
        end = output.index(b'\n', offset)
        _, kind, size = output[offset:end].split()
        if kind != b'blob':
            raise ValueError('expected a file blob')
        offset = end + 1
        size = int(size)
        result[oid] = output[offset:offset + size]
        offset += size + 1
    return result


def ignored_paths(tree):
    # Match only the committed/staged policy, never local excludes or .gitignore.
    entry = git('ls-tree', tree, '--', '.file-size-ignore')
    if not entry:
        return set()
    metadata = entry.split(b'\t', 1)[0].split()
    if metadata[1] != b'blob':
        raise ValueError('.file-size-ignore must be a file')
    policy = git('cat-file', 'blob', metadata[2].decode())
    with tempfile.TemporaryDirectory(prefix='file-size-') as directory:
        ignore = os.path.join(directory, 'patterns')
        with open(ignore, 'wb') as handle:
            handle.write(policy)
        env = dict(os.environ, GIT_INDEX_FILE=os.path.join(directory, 'index'))
        git('read-tree', tree, env=env)
        paths = git('ls-files', '-z', '--cached', '--ignored',
                    '--exclude-from=' + ignore, env=env)
    return set(paths.rstrip(b'\0').split(b'\0')) if paths else set()


def skipped(path, ignored):
    return path in ignored or PurePosixPath(os.fsdecode(path)).name in LOCKFILES


def changes(base, head):
    # Raw -z records carry both blob IDs and both paths for detected renames.
    parts = git('diff', '--raw', '-z', '--no-abbrev', '--find-renames',
                '--diff-filter=ACMRT', base, head, '--').split(b'\0')
    index = 0
    while index < len(parts) - 1:
        old_mode, new_mode, old_oid, new_oid, status = parts[index].split()
        old_mode = old_mode.lstrip(b':')
        old_path = parts[index + 1]
        index += 2
        path = old_path
        if status[:1] in (b'R', b'C'):
            path = parts[index]
            index += 1
        if new_mode not in (b'100644', b'100755', b'120000'):
            continue  # Gitlinks are repositories, not UTF-8 files.
        previous = old_oid.decode() if old_mode in (b'100644', b'100755', b'120000') else None
        yield path, previous, new_oid.decode()


def check(base, head):
    ignored = ignored_paths(head)
    records = [row for row in changes(base, head) if not skipped(row[0], ignored)]
    content = blobs(oid for _, old, new in records for oid in (old, new))
    failures = 0
    for path, old, new in records:
        before = characters(content[old]) if old else None
        # Text at base stays subject to the ratchet despite NUL/invalid bytes.
        after = (len(content[new].decode('utf-8', 'replace')) if before is not None
                 else characters(content[new]))
        # All comparisons use the policy measure, including its token rounding.
        if after is None or after <= LIMIT * CHARACTERS_PER_TOKEN:
            continue
        if before is not None and tokens(after) <= tokens(before):
            continue
        baseline = str(tokens(before)) if before is not None else 'new'
        fix = ('split this file into smaller modules' if before is None or
               before <= LIMIT * CHARACTERS_PER_TOKEN else
               'reduce it back to {} tokens or less'.format(tokens(before)))
        # JSON quoting keeps even newline-containing paths on one output line.
        print('{}: base {}, new {} tokens, limit {}; {}'.format(
            json.dumps(os.fsdecode(path), ensure_ascii=False), baseline,
            tokens(after), LIMIT, fix))
        failures += 1
    return bool(failures)


def inventory(head):
    ignored = ignored_paths(head)
    rows = []
    for entry in git('ls-tree', '-r', '-z', head).split(b'\0'):
        if not entry:
            continue
        metadata, path = entry.split(b'\t', 1)
        _, kind, oid = metadata.split()
        if kind == b'blob' and not skipped(path, ignored):
            rows.append((path, oid.decode()))
    content = blobs(oid for _, oid in rows)
    frozen = []
    for path, oid in rows:
        size = characters(content[oid])
        if size is not None and size > LIMIT * CHARACTERS_PER_TOKEN:
            frozen.append({'path': os.fsdecode(path), 'characters': size,
                           'tokens': tokens(size)})
    return sorted(frozen, key=lambda row: (-row['characters'], row['path']))


def main():
    os.chdir(os.fsdecode(git('rev-parse', '--show-toplevel')[:-1]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--merge-base', action='store_true')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--staged', action='store_true')
    mode.add_argument('--inventory', action='store_true')
    args = parser.parse_args()
    if args.staged:
        if args.base or args.merge_base or args.head != 'HEAD':
            parser.error('--staged compares the index against HEAD only')
        head = git('write-tree').strip().decode()
        exists = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = resolve('HEAD') if exists.returncode == 0 else empty_tree()
    else:
        head = resolve(args.head)
        if args.inventory:
            print(json.dumps(inventory(head), ensure_ascii=False, indent=2))
            return 0
        if not args.base:
            parser.error('--base is required unless --staged or --inventory is used')
        base = (resolve(git('merge-base', args.base, args.head).strip().decode())
                if args.merge_base else resolve(args.base))
    return int(check(base, head))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (subprocess.CalledProcessError, ValueError, OSError) as error:
        print('file-size: could not check: {}'.format(error), file=sys.stderr)
        sys.exit(2)
