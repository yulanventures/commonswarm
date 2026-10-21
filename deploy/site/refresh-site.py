#!/usr/bin/env python3
"""Before either flip, retain the live asset graph and advance HTML validators."""
import os
from pathlib import Path
import shutil
import stat
import sys
import time


def scan_error(error):
    raise error


def prepare(live, target):
    live, target = Path(live), Path(target)
    # Reject links and special files, including asset-directory roots, before writes.
    for root in (live, target):
        if not root.is_dir() or root.is_symlink():
            raise ValueError('release directory required')
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
            for name in dirs + files:
                mode = (Path(directory) / name).lstat().st_mode
                if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    raise ValueError('release symlink/special file refused')
    for root in (live, target):
        if not (root / '_astro').is_dir():
            raise ValueError('assets directory required')
    pending = []
    for source in (live / '_astro').rglob('*'):
        dest = target / '_astro' / source.relative_to(live / '_astro')
        if source.is_dir():
            if dest.exists() and not dest.is_dir():
                raise ValueError('asset directory collision')
        else:
            if dest.exists():
                if not dest.is_file() or source.read_bytes() != dest.read_bytes():
                    raise ValueError('asset byte collision')
            else:
                pending.append((source, dest))
    html = list(target.rglob('*.html'))
    served = list(live.rglob('*.html'))
    if not html or not served:
        raise ValueError('HTML required in both releases')
    previous = max(p.stat().st_mtime_ns // 1_000_000_000 for p in html + served)
    if previous > int(time.time()):
        raise ValueError('future HTML timestamp refused')
    for source, dest in pending:
        dest.parent.mkdir(parents=True, exist_ok=True)
        directory = dest.parent
        while directory != target:
            directory.chmod(0o755)
            directory = directory.parent
        shutil.copy2(source, dest)
        dest.chmod(0o644)
    # HTTP dates discard subseconds. Wait for a real later second, bounded by
    # monotonic time even if the wall clock moves backwards. Never future-date.
    deadline = time.monotonic() + 2.0
    while int(time.time()) <= previous:
        if time.monotonic() >= deadline:
            raise ValueError('HTML clock did not advance within 2 seconds')
        time.sleep(0.01)
    stamp = int(time.time())
    for path in html:
        os.utime(path, ns=(stamp * 1_000_000_000, stamp * 1_000_000_000))
    if stamp <= previous or stamp > int(time.time()):
        raise ValueError('HTML freshness clock invalid')


if __name__ == '__main__':
    try:
        prepare(*sys.argv[1:])
    except Exception as error:
        sys.exit('Refusing site refresh: ' + str(error))
