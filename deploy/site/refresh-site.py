#!/usr/bin/env python3
"""Before either flip, retain the live asset graph and advance HTML validators."""
import os
from pathlib import Path
import re
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

    def collect_assets(rel_path):
        live_assets = live / rel_path
        target_assets = target / rel_path
        if not live_assets.exists():
            return
        if not live_assets.is_dir():
            raise ValueError('asset directory collision')
        parent = target
        for part in Path(rel_path).parts:
            parent = parent / part
            if parent.exists() and not parent.is_dir():
                raise ValueError('asset directory collision')
        for source in live_assets.rglob('*'):
            dest = target_assets / source.relative_to(live_assets)
            if source.is_dir():
                if dest.exists() and not dest.is_dir():
                    raise ValueError('asset directory collision')
            else:
                if dest.exists():
                    if not dest.is_file() or source.read_bytes() != dest.read_bytes():
                        raise ValueError('asset byte collision')
                else:
                    pending.append((source, dest))

    collect_assets('_astro')
    if (live / 'next').exists():
        if not (live / 'next').is_dir():
            raise ValueError('asset directory collision')
        collect_assets(Path('next') / 'assets')
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


EXPECTED_NEXT_CSP = b"frame-ancestors 'none'"
_FINAL_STATUS_RE = re.compile(rb'HTTP/[0-9]+(?:\.[0-9]+)? [2-5][0-9]{2}(?:[ \t][\x20-\x7e\t]*)?')
_CONTENT_TYPE_HTML_RE = re.compile(rb'text/html(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?', re.IGNORECASE)
_HEADER_NAME_BYTES = frozenset(
    b"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)


def parse_final_http_headers(headers_path):
    """Parse only the final HTTP response header block from a curl -D dump."""
    raw = Path(headers_path).read_bytes()
    lines = [line[:-1] if line.endswith(b'\r') else line for line in raw.split(b'\n')]
    blocks = []
    current = []
    for line in lines:
        if line == b'':
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    if not blocks:
        return None
    final_block = blocks[-1]
    if not _FINAL_STATUS_RE.fullmatch(final_block[0]):
        return None
    headers = {}
    for line in final_block[1:]:
        if line[:1] in (b' ', b'\t'):
            return None
        name, sep, value = line.partition(b':')
        if not sep or not name or any(b not in _HEADER_NAME_BYTES for b in name):
            return None
        if any((b < 0x20 and b != 0x09) or b >= 0x7F for b in value):
            return None
        headers.setdefault(name.lower(), []).append(value.strip(b' \t'))
    return headers


def _check_csp_header(headers):
    csp_values = headers.get(b'content-security-policy', [])
    if len(csp_values) == 0:
        return 'missing-csp'
    if len(csp_values) > 1:
        return 'multiple-csp'
    if csp_values[0] != EXPECTED_NEXT_CSP:
        return 'csp-mismatch'
    return None


def check_next_csp(headers_path):
    """Require a single exact Content-Security-Policy header on the final HTTP response block."""
    headers = parse_final_http_headers(headers_path)
    if headers is None:
        return 'invalid-http-headers'
    return _check_csp_header(headers)


def check_next_html_headers(headers_path):
    """Require all five preview HTML headers once each on the final HTTP response block."""
    headers = parse_final_http_headers(headers_path)
    if headers is None:
        return 'invalid-http-headers'
    ct_values = headers.get(b'content-type', [])
    if len(ct_values) > 1:
        return 'multiple-content-type'
    if len(ct_values) == 0 or not _CONTENT_TYPE_HTML_RE.fullmatch(ct_values[0]):
        return 'content-type-mismatch'
    csp_reason = _check_csp_header(headers)
    if csp_reason is not None:
        return csp_reason
    nosniff_values = headers.get(b'x-content-type-options', [])
    if len(nosniff_values) > 1:
        return 'multiple-nosniff'
    if len(nosniff_values) == 0:
        return 'missing-nosniff'
    if nosniff_values[0].lower() != b'nosniff':
        return 'nosniff-mismatch'
    referrer_values = headers.get(b'referrer-policy', [])
    if len(referrer_values) > 1:
        return 'multiple-referrer-policy'
    if len(referrer_values) == 0:
        return 'missing-referrer-policy'
    if referrer_values[0].lower() != b'no-referrer':
        return 'referrer-policy-mismatch'
    cache_values = headers.get(b'cache-control', [])
    if len(cache_values) > 1:
        return 'multiple-cache-control'
    if len(cache_values) == 0 or cache_values[0].lower() != b'no-cache':
        return 'cache-control-mismatch'
    return None


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--check-next-csp':
            reason = check_next_csp(sys.argv[2])
            if reason is not None:
                sys.exit(reason)
        elif len(sys.argv) == 3 and sys.argv[1] == '--check-next-html-headers':
            reason = check_next_html_headers(sys.argv[2])
            if reason is not None:
                sys.exit(reason)
        else:
            prepare(*sys.argv[1:])
    except Exception as error:
        sys.exit('Refusing site refresh: ' + str(error))
