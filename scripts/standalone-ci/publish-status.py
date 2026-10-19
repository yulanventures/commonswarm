#!/usr/bin/env python3
"""Host-only final commit statuses; stdin is controller-owned result metadata.

For audited historical backfills, --receipt reads an operator-selected final
receipt. It never accepts a SHA override: the receipt's resolved SHA is tested.
Only the GitHub commit-status API is used; no checks, comments or workflow API.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys


class Refused(Exception):
    pass


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def status_payload(result):
    sha, suite, run_id = (result.get(k) for k in ('resolved_sha', 'suite', 'run_id'))
    need(isinstance(sha, str) and re.fullmatch('[0-9a-f]{40}', sha), 'invalid_resolved_sha')
    need(suite in ('server', 'p1-cli', 'site', 'box-dry-run', 'unit'), 'invalid_suite')
    need(isinstance(run_id, str) and re.fullmatch('csci-[0-9a-f]{32}', run_id), 'invalid_run_id')
    code = result.get('exit_code')
    need(type(code) is int and 0 <= code <= 255, 'invalid_exit_code')
    need(result.get('state') in ('completed', 'failed') and result.get('pending') is False,
         'unfinished_result')
    need((result['state'] == 'completed') == (code == 0), 'inconsistent_result')
    need(type(result.get('timed_out')) is bool, 'invalid_timeout')
    cleanup_failed = result.get('cleanup_failed', bool(result.get('cleanup_errors')))
    need(type(cleanup_failed) is bool, 'invalid_cleanup')
    need(code != 0 or not (result['timed_out'] or cleanup_failed), 'inconsistent_result')
    state = ('error' if result['timed_out'] or cleanup_failed or code == 130
             else 'success' if code == 0 else 'failure')
    # Include only validated controller metadata; never logs, gate text or URLs.
    return sha, dict(state=state, context='hetzner/' + suite,
                     description=f'{run_id} exit {code}')


def token_from_file(cfg):
    name = cfg.get('github_status_token_file')
    need(isinstance(name, str) and name, 'token_file_unconfigured')
    path = Path(name)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'unsafe_token_path')
    # State (including checkout/scratch/receipts) and controller are exposed to
    # workers in bind mounts. A credential must never reside in either tree.
    for key in ('state', 'controller'):
        root = Path(cfg[key]).resolve()
        need(path != root and root not in path.parents, 'token_in_container_tree')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(fd)
        need(stat.S_ISREG(metadata.st_mode) and metadata.st_uid in (0, os.getuid())
             and metadata.st_mode & 0o777 == 0o600, 'unsafe_token_permissions')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            token = stream.read(4097).strip()
        need(0 < len(token) <= 4096 and all(33 <= ord(c) <= 126 for c in token), 'invalid_token_file')
        return token
    finally:
        os.close(fd)


def publish(cfg, result):
    sha, payload = status_payload(result)
    token = token_from_file(cfg)
    # Fixed host/path, no redirects, proxies, shell, subprocess or response bodies.
    # Thus a remote error cannot redirect the Authorization header or echo it.
    connection = http.client.HTTPSConnection('api.github.com', timeout=15)
    try:
        connection.request('POST', '/repos/yulanventures/commonswarm/statuses/' + sha,
                           body=json.dumps(payload), headers={
                               'Authorization': 'Bearer ' + token,
                               'Accept': 'application/vnd.github+json',
                               'X-GitHub-Api-Version': '2022-11-28',
                               'Content-Type': 'application/json',
                               'User-Agent': 'commonswarm-hetzner-ci'})
        response = connection.getresponse()
        need(response.status == 201, 'github_http_' + str(response.status))
    finally:
        connection.close()
    return dict(state='published', context=payload['context'], status=payload['state'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--receipt', help='operator-audited final receipt for backfill')
    args = parser.parse_args()
    try:
        cfg = json.loads(Path(args.config).read_text())
        result = json.loads(Path(args.receipt).read_text() if args.receipt else sys.stdin.read())
        publication = publish(cfg, result)
    except Refused as error:
        publication = dict(state='failed', error=str(error))
    except Exception:
        # Never format exceptions or print HTTP response content.
        publication = dict(state='failed', error='publisher_unavailable')
    print(json.dumps(publication))
    return 0 if publication['state'] == 'published' else 1


if __name__ == '__main__':
    sys.exit(main())
