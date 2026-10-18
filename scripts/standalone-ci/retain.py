#!/usr/bin/env python3
"""Bounded retention. Caller holds queue.lock; never follows a run symlink."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import shutil


def remove_owned(root, target, scratch=False):
    root, target = Path(root), Path(target)
    if (not root.is_absolute() or root.is_symlink() or root.resolve() != root
            or root in (Path('/'), Path.home()) or target.is_symlink()
            or target.resolve() != target):
        raise ValueError('refuse unsafe deletion path')
    relative = target.relative_to(root)
    parts = relative.parts
    if (len(parts) != (3 if scratch else 2) or parts[0] != 'runs'
            or not re.fullmatch(r'csci-[0-9a-f]{32}', parts[1])
            or (scratch and parts[2] != 'scratch')):
        raise ValueError('refuse path outside owned run')
    receipt = json.loads((root / 'runs' / parts[1] / 'receipt.json').read_text())
    if receipt['run_id'] != parts[1] or receipt.get('cleanup_errors') or not receipt.get('ended_at'):
        raise ValueError('refuse incomplete or unclean run')
    shutil.rmtree(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--scratch')
    args = parser.parse_args()
    root = Path(args.root)
    if args.scratch:
        remove_owned(root, Path(args.scratch), scratch=True)
        return
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=14)
    for run in (root / 'runs').iterdir():
        if run.is_symlink() or not re.fullmatch(r'csci-[0-9a-f]{32}', run.name):
            continue
        try:
            receipt = json.loads((run / 'receipt.json').read_text())
            ended = dt.datetime.fromisoformat(receipt['ended_at'])
            if ended < cutoff and not receipt.get('cleanup_errors'):
                remove_owned(root, run)
        except (OSError, ValueError, KeyError, TypeError):
            # Incomplete/unknown paths remain for an operator; never guess ownership.
            continue


if __name__ == '__main__':
    main()
