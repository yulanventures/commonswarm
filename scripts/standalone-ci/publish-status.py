#!/usr/bin/env python3
"""Reconcile read-only CI receipts with GitHub using this job's ephemeral token."""
import argparse
import datetime as dt
import http.client
import json
import os
import re
import stat
import sys
import time

RUNS = '/var/lib/commonswarm-ci/runs'
REPO = '/repos/yulanventures/commonswarm'
ID = r'csci-[0-9a-f]{32}'
SUITES = ('box-dry-run', 'server', 'p1-cli', 'site', 'unit', 'server-permanence')
LEGACY = frozenset(('csci-2bcf14681e054e21b6706774db5a609a',
    'csci-0973a9b8bf7f4559bcbde822aaf23f95', 'csci-6707cacfa0064ebbae06842f6800f37b',
    'csci-163e0902286d4e40a6fff68a83d91824', 'csci-94eed54bd36b4f6fbaf796d9c337caf2',
    'csci-e6717ca3385d4f27a47cc52771525922'))
LIMIT = 1048576


class Refused(Exception):
    pass


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def timestamp(value):
    need(isinstance(value, str) and len(value) <= 40, 'invalid_completion_time')
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        need(result.tzinfo is not None and result.utcoffset() is not None, 'naive_completion_time')
        return result.astimezone(dt.timezone.utc)
    except ValueError:
        raise Refused('invalid_completion_time') from None


def directory(path):
    # Open every component relative to the preceding directory, never a symlink.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = path.strip('/').split('/')
        for index, part in enumerate(parts):
            flag = os.O_RDONLY if index == len(parts) - 1 else os.O_PATH
            new = os.open(part, flag | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_receipt(root, run_id):
    need(re.fullmatch(ID, run_id), 'invalid_run_id')
    # Run ACL permits traversal, never listing; O_PATH also works with --x only.
    run = os.open(run_id, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    try:
        fd = os.open('receipt.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=run)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= LIMIT,
                 'unsafe_receipt')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(LIMIT + 1)
            need(len(raw) <= LIMIT, 'receipt_too_large')
            result = json.loads(raw)
            need(isinstance(result, dict) and result.get('run_id') == run_id, 'receipt_identity_mismatch')
            return result
        finally:
            os.close(fd)
    finally:
        os.close(run)


def candidate(result):
    sha, suite, run_id = (result.get(k) for k in ('resolved_sha', 'suite', 'run_id'))
    need(isinstance(sha, str) and re.fullmatch('[0-9a-f]{40}', sha), 'invalid_resolved_sha')
    need(suite in SUITES, 'invalid_suite')
    need(isinstance(run_id, str) and re.fullmatch(ID, run_id), 'invalid_run_id')
    code = result.get('exit_code')
    need(type(code) is int and 0 <= code <= 255, 'invalid_exit_code')
    need(result.get('state') in ('completed', 'failed') and result.get('pending') is False, 'unfinished_result')
    need((result['state'] == 'completed') == (code == 0), 'inconsistent_result')
    need(type(result.get('timed_out')) is bool, 'invalid_timeout')
    need(isinstance(result.get('cleanup_errors'), list), 'invalid_cleanup')
    infrastructure = bool(result['timed_out'] or result['cleanup_errors'] or result.get('controller_error') or code == 130)
    need(code != 0 or not infrastructure, 'inconsistent_result')
    ended = timestamp(result.get('ended_at'))
    started = timestamp(result.get('started_at'))
    need(started <= ended <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5), 'invalid_chronology')
    state = 'error' if infrastructure else 'success' if code == 0 else 'failure'
    payload = dict(state=state, context='hetzner/' + suite,
                   description=f'{run_id} exit {code} ended {ended.isoformat()}')
    return dict(sha=sha, run_id=run_id, ended=ended, payload=payload, code=code)


class API:
    def __init__(self, token):
        self.token = token
        self.deadline = time.monotonic() + 120

    def request(self, method, path, payload=None):
        need(time.monotonic() < self.deadline, 'github_deadline')
        connection = http.client.HTTPSConnection('api.github.com', timeout=min(15, max(0.1, self.deadline-time.monotonic())))
        try:
            connection.request(method, REPO + path, body=None if payload is None else json.dumps(payload), headers={
                'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
                'User-Agent': 'commonswarm-hetzner-ci'})
            response = connection.getresponse()
            need(response.status == (201 if method == 'POST' else 200), 'github_http_' + str(response.status))
            raw = response.read(LIMIT + 1)
            need(len(raw) <= LIMIT, 'github_response_too_large')
            return json.loads(raw)
        finally:
            connection.close()

    def history(self, sha):
        rows, seen = [], set()
        for page in range(1, 1001):
            batch = self.request('GET', f'/commits/{sha}/statuses?per_page=100&page={page}')
            need(isinstance(batch, list) and len(batch) <= 100, 'invalid_history')
            for row in batch:
                need(isinstance(row, dict) and type(row.get('id')) is int and row['id'] > 0
                     and row.get('state') in ('error', 'failure', 'pending', 'success')
                     and isinstance(row.get('context'), str) and isinstance(row.get('description'), (str, type(None))),
                     'invalid_status')
                need(row['id'] not in seen, 'history_changed_during_pagination')
                seen.add(row['id'])
                rows.append(row)
            if len(batch) < 100:
                return rows
        raise Refused('history_page_limit')


def history_decision(root, item, history):
    payload = item['payload']
    context = [r for r in history if r['context'] == payload['context']]
    legacy_description = f"{item['run_id']} exit {item['code']}"
    identical, superseded = False, False
    provenance = {}
    completions = {item['ended']: item['run_id']}
    # Validate the entire context before skipping, including when an identical
    # or newer result exists. API insertion order is not completion order.
    for row in context:
        description = row['description'] or ''
        match = re.fullmatch(f'({ID}) exit ([0-9]{{1,3}})(?: ended (.+))?', description)
        need(match is not None, 'unknown_status_provenance')
        prior_id, code, ended = match.groups()
        if prior_id == item['run_id']:
            need(description in (payload['description'], legacy_description)
                 and row['state'] == payload['state'], 'conflicting_run_status')
            identical = True
            completed = item['ended']
        elif ended is None:
            prior = candidate(read_receipt(root, prior_id))
            need(prior['sha'] == item['sha'] and prior['payload']['context'] == payload['context']
                 and prior['code'] == int(code) and prior['payload']['state'] == row['state'], 'invalid_legacy_provenance')
            completed = prior['ended']
        else:
            need(int(code) <= 255 and row['state'] != 'pending', 'invalid_status_provenance')
            completed = timestamp(ended)
        signature = (int(code), row['state'], completed)
        need(prior_id not in provenance or provenance[prior_id] == signature, 'conflicting_run_status')
        provenance[prior_id] = signature
        need(completed not in completions or completions[completed] == prior_id, 'newer_or_ambiguous_result')
        completions[completed] = prior_id
        superseded = superseded or completed > item['ended']
    return identical or superseded


def reconcile(api, root, item):
    payload = item['payload']
    if history_decision(root, item, api.history(item['sha'])):
        return 'skipped'
    created = api.request('POST', '/statuses/' + item['sha'], payload)
    need(isinstance(created, dict) and type(created.get('id')) is int and created['id'] > 0, 'invalid_create_response')
    # Retry only valid history that has not exposed this exact created ID yet.
    # POST is outside the loop: a lost acknowledgement is never retried here.
    for attempt in range(3):
        readback = api.history(item['sha'])
        matching = next((r for r in readback if r['id'] == created['id']), None)
        if matching is not None:
            need(all(matching.get(k) == v for k, v in payload.items()), 'status_readback_failed')
        history_decision(root, item, readback)
        if matching is not None:
            return 'published'
        if attempt < 2:
            need(time.monotonic() + 0.5 < api.deadline, 'github_deadline')
            time.sleep(0.5)
    raise Refused('status_readback_failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-ids', default='', help='up to 20 comma-separated audited run IDs; empty discovers ready receipts')
    args = parser.parse_args()
    root = None
    try:
        raw = args.run_ids
        need(len(raw) <= 800, 'too_many_run_ids')
        selected = raw.split(',') if raw else []
        need(len(selected) <= 20 and len(selected) == len(set(selected))
             and all(re.fullmatch(ID, value) for value in selected), 'invalid_run_ids')
        token = os.environ.pop('GITHUB_TOKEN', '')
        need(0 < len(token) <= 4096 and all(33 <= ord(c) <= 126 for c in token), 'invalid_job_token')
        root = directory(RUNS)
        items = []
        for run_id in selected or sorted(n for n in os.listdir(root) if re.fullmatch(ID, n)):
            try:
                receipt = read_receipt(root, run_id)
            except (FileNotFoundError, PermissionError):
                need(not selected, 'selected_receipt_missing')
                continue
            ready = receipt.get('github_status') == dict(state='ready', version=1)
            if not selected and not ready:
                continue
            need(ready or run_id in LEGACY, 'selected_receipt_not_ready')
            items.append(candidate(receipt))
        items.sort(key=lambda i: (i['sha'], i['payload']['context'], i['ended'], i['run_id']))
        # Equal completions from different ready runs are ambiguous even if a
        # later published result would otherwise supersede both. Check before POST.
        completions = set()
        for item in items:
            key = (item['sha'], item['payload']['context'], item['ended'])
            need(key not in completions, 'newer_or_ambiguous_result')
            completions.add(key)
        counts = dict(published=0, skipped=0, eligible=len(items))
        api = API(token)
        for item in items:
            counts[reconcile(api, root, item)] += 1
        print(json.dumps(dict(state='reconciled', **counts)))
        return 0
    except Refused as error:
        print(json.dumps(dict(state='failed', error=str(error))))
    except Exception:
        # Neither exception messages nor response bodies can enter logs.
        print(json.dumps(dict(state='failed', error='publisher_unavailable')))
    finally:
        if root is not None:
            os.close(root)
    return 1


if __name__ == '__main__':
    sys.exit(main())
