#!/usr/bin/env python3
"""Box-local Storage block edit. Live bytes and diagnostics never leave proof."""
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile

SITE_DIR = Path('/etc/caddy/sites')
MARKER = Path('/etc/commonswarm-release/STAGING-ONLY')
LOCK = Path('/run/commonswarm-storage-cors.lock')
CADDYFILE = Path('/etc/caddy/Caddyfile')
MEMBERS = {
    '10': ('10-commonswarm-api.caddy', 'commonswarm-api.caddy', 'api.commonswarm.com'),
    '11': ('11-commonswarm-edge-staging.caddy', 'commonswarm-edge-staging.caddy', 'edge-staging.commonswarm.com'),
}
OLD_ROUTE = (r'(?m)^(?P<i>[ \t]+)handle /storage/v1/\* \{\n'
             r'[ \t]+uri strip_prefix /storage/v1\n'
             r'[ \t]+reverse_proxy 127\.0\.0\.1:18004\n(?P=i)\}')


class Refusal(Exception):
    """Only fixed, nonsecret labels may reach the transcript."""


def need(ok, label):
    if not ok:
        raise Refusal(label)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_live(path):
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode), 'regular non-symlink file required')
    return path.read_bytes(), dict(uid=s.st_uid, gid=s.st_gid, mode=stat.S_IMODE(s.st_mode))


def save(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def save_json(path, value):
    save(path, (json.dumps(value, sort_keys=True) + '\n').encode())


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def site(text, host):
    # Same host-boundary rule as r2 candidate(); tabs and spaces are accepted.
    matches = list(re.finditer(r'(?ms)^' + re.escape(host) + r'[ \t]*\{\n.*?^\}[ \t]*(?=\n|$)', text))
    need(len(matches) == 1, 'wrong host block')
    other = 'edge-staging.commonswarm.com' if host == 'api.commonswarm.com' else 'api.commonswarm.com'
    need(not re.search(r'(?m)^' + re.escape(other) + r'[ \t]*\{', text), 'wrong host block')
    return matches[0]


def route_span(raw, host, old):
    text = raw.decode('utf-8')
    target = site(text, host)
    pattern = OLD_ROUTE if old else r'(?m)^(?P<i>[ \t]+)handle /storage/v1/\* \{\n.*?^(?P=i)\}'
    flags = 0 if old else re.S
    routes = list(re.finditer(pattern, target.group(), flags))
    all_routes = list(re.finditer(r'(?m)^[ \t]+handle /storage/v1/\* \{', text))
    need(len(routes) == len(all_routes) == 1, 'Storage block count or shape')
    start, end = target.start() + routes[0].start(), target.start() + routes[0].end()
    return len(text[:start].encode()), len(text[:end].encode())


def candidate(source, release, host):
    a, b = route_span(source, host, True)
    c, d = route_span(release, host, False)
    after = source[:a] + release[c:d] + source[b:]
    need(after != source, 'Storage replacement unchanged')
    # Compare the complete outside region; the gate may contain secret values.
    x, y = route_span(after, host, False)
    need(source[:a] == after[:x] and source[b:] == after[y:], 'outside Storage changed')
    return after


def outside(raw, host, old):
    a, b = route_span(raw, host, old)
    return digest(raw[:a] + raw[b:])


def approved_diff(previous, live, host):
    a, b = route_span(previous, host, True)
    c, d = route_span(live, host, True)
    p, q = previous.splitlines(keepends=True), live.splitlines(keepends=True)
    ps, pe = previous[:a].count(b'\n'), previous[:b].count(b'\n') + 1
    qs, qe = live[:c].count(b'\n'), live[:d].count(b'\n') + 1
    for tag, i, j, k, l in difflib.SequenceMatcher(None, p, q, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        # Insertions strictly inside the block also count as touching it.
        touches_p = (i < pe and j > ps) if i != j else ps < i < pe
        touches_q = (k < qe and l > qs) if k != l else qs < k < qe
        need(not touches_p and not touches_q, 'previous/live diff touches Storage block')
    return b''.join(difflib.diff_bytes(difflib.unified_diff, p, q,
                                     fromfile=b'previous', tofile=b'live'))


def utc(value):
    need(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value), 'UTC timestamp required')
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)


def check_window(inputs):
    start, end = utc(inputs['WINDOW_START_UTC']), utc(inputs['WINDOW_END_UTC'])
    now = datetime.datetime.now(datetime.timezone.utc)
    need(start <= now < end and 0 < (end-start).total_seconds() <= 1800, 'outside approved window')
    intervals = inputs['REFUSAL_WINDOWS_UTC']
    need(isinstance(intervals, list), 'explicit refusal list required')
    for row in intervals:
        need(isinstance(row, list) and len(row) == 2, 'invalid refusal interval')
        lo, hi = map(utc, row)
        need(lo < hi, 'invalid refusal interval')
        if inputs['TARGET'] == 'production':
            need(not (start < hi and end > lo), 'forbidden window overlap')
    if inputs['TARGET'] == 'production':
        need(bool(intervals), 'production refusal list required')


def identity(inputs):
    need(socket.gethostname() == inputs['BOX_HOSTNAME'], 'hostname mismatch')
    if inputs['TARGET'] == 'staging':
        need(inputs['BOX_HOSTNAME'] == 'c1-staging-20261006' and inputs['MEMBERS'] == '10', 'staging identity or members')
        raw, meta = read_live(MARKER)
        need(meta == dict(uid=0, gid=0, mode=0o600) and raw == b'c1-staging-disposable-no-production', 'staging marker mismatch')
        need(not (SITE_DIR / MEMBERS['11'][0]).exists(), 'unexpected staging second member')
    else:
        need(inputs['TARGET'] == 'production' and inputs['BOX_HOSTNAME'] == 'yulan-vps-1'
             and inputs['MEMBERS'] == '10 11' and not os.path.lexists(MARKER), 'production identity or members')


def inputs_file(path):
    raw, meta = read_live(path)
    need(path.is_absolute() and meta == dict(uid=0, gid=0, mode=0o600), 'root 0600 inputs required')
    def pairs(rows):
        d = {}
        for k, v in rows:
            need(k not in d, 'duplicate input key')
            d[k] = v
        return d
    d = json.loads(raw, object_pairs_hook=pairs)
    base = {'TARGET', 'BOX_HOSTNAME', 'MEMBERS', 'RELEASE_SHA', 'PREVIOUS_SHA',
            'RELEASE_ARCHIVE', 'RELEASE_ARCHIVE_SHA256', 'PREVIOUS_ARCHIVE', 'PREVIOUS_ARCHIVE_SHA256',
            'PLAN_SHA256', 'WINDOW_START_UTC', 'WINDOW_END_UTC', 'REFUSAL_WINDOWS_UTC',
            'CADDY_CA_FILE', 'CADDY_CA_SHA256', 'CADDYFILE_SHA256', 'ROLLBACK_APPROVED'}
    need(d.get('MEMBERS') in ('10', '10 11'), 'invalid member inventory')
    for m in d['MEMBERS'].split():
        base |= {'BEFORE_SHA256_'+m, 'DIFF_SHA256_'+m}
    need(set(d) == base, 'exact inputs required')
    for k in base - {'REFUSAL_WINDOWS_UTC'}:
        need(isinstance(d[k], str), 'string inputs required')
        if 'SHA256' in k:
            need(re.fullmatch('[0-9a-f]{64}', d[k]), 'SHA256 input required')
    for k in ('RELEASE_SHA', 'PREVIOUS_SHA'):
        need(re.fullmatch('[0-9a-f]{40}', d[k]), 'full release SHA required')
    for k in ('RELEASE_ARCHIVE', 'PREVIOUS_ARCHIVE', 'CADDY_CA_FILE'):
        need(re.fullmatch(r'/[A-Za-z0-9._/-]+', d[k]), 'absolute safe input path required')
    need(d['ROLLBACK_APPROVED'] == 'yes', 'rollback approval required')
    identity(d)
    return d


def archive_sources(inputs, prefix):
    path = Path(inputs[prefix+'_ARCHIVE'])
    raw, _ = read_live(path)
    need(digest(raw) == inputs[prefix+'_ARCHIVE_SHA256'], 'archive hash mismatch')
    sources = {}
    with tarfile.open(path, 'r:') as tar:
        need(tar.pax_headers.get('comment') == inputs[prefix+'_SHA'], 'archive commit mismatch')
        for m in inputs['MEMBERS'].split():
            name = 'deploy/supabase-stack/' + MEMBERS[m][1]
            matches = [entry for entry in tar.getmembers() if entry.name == name]
            need(len(matches) == 1 and matches[0].isfile(), 'archive source inventory mismatch')
            sources[m] = tar.extractfile(matches[0]).read()
    return sources


def inspect(inputs, previous, release):
    results = {}
    for m in inputs['MEMBERS'].split():
        name, _, host = MEMBERS[m]
        live, owner = read_live(SITE_DIR / name)
        need(digest(live) == inputs['BEFORE_SHA256_'+m], 'before hash mismatch')
        diff = approved_diff(previous[m], live, host)
        need(digest(diff) == inputs['DIFF_SHA256_'+m], 'DIFF_SHA256 mismatch')
        after = candidate(live, release[m], host)
        if live == previous[m] or m == '11':
            need(live == previous[m] and after == release[m], 'candidate differs from release source')
        results[m] = (live, after, diff, dict(owner, before_sha256=digest(live), after_sha256=digest(after),
                                          outside_sha256=outside(live, host, True), admin_gate_count=live.count(b'admin_gate')))
    return results


class Session:
    def __init__(self, inputs, proof, helper, plan):
        self.d = inputs_file(inputs)
        self.proof, self.helper = proof, helper
        need(os.geteuid() == 0, 'box root required')
        s = proof.lstat()
        need(proof.is_absolute() and stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0
             and stat.S_IMODE(s.st_mode) == 0o700, 'root 0700 proof required')
        need(digest(read_live(plan)[0]) == self.d['PLAN_SHA256'], 'plan hash mismatch')
        need(digest(read_live(CADDYFILE)[0]) == self.d['CADDYFILE_SHA256'], 'Caddyfile drift')
        self.raw_inputs = read_live(inputs)[0]
        if (proof / 'inputs.json').exists():
            need((proof / 'inputs.json').read_bytes() == self.raw_inputs, 'session inputs changed')
        self.members = self.d['MEMBERS'].split()

    def command(self, args, label):
        # caddy diagnostics can include live gate bytes. Retain them only here.
        with (self.proof / (label+'.private')).open('ab') as f:
            os.chmod(f.name, 0o600)
            r = subprocess.run(args, stdout=f, stderr=f)
        need(r.returncode == 0, label+' failed')

    def curl(self, m, tag, method, origin=None, direct=False):
        # Probe-only trust must never gate restoration or recovery close.
        if not direct:
            need(digest(read_live(Path(self.d['CADDY_CA_FILE']))[0]) == self.d['CADDY_CA_SHA256'], 'CA hash mismatch')
        host = MEMBERS[m][2]
        prefix = self.proof / ('http-'+m+'-'+tag)
        path = '/storage/v1/bucket' if tag == 'baseline' else '/storage/v1/object/upload/sign/swarm-files/cors-probe?token=bogus'
        base = 'https://'+host if not direct else 'http://127.0.0.1:18004'
        if direct:
            path = path[len('/storage/v1'):]
        args = ['curl', '--silent', '--show-error', '--noproxy', '*', '--max-time', '20', '--request', method,
                '--dump-header', str(prefix)+'.headers', '--output', str(prefix)+'.body', '--write-out', '%{http_code}']
        if not direct:
            args += ['--resolve', host+':443:127.0.0.1', '--cacert', self.d['CADDY_CA_FILE']]
        if origin:
            args += ['--header', 'Origin: '+origin]
        if method == 'OPTIONS':
            args += ['--header', 'Access-Control-Request-Method: PUT', '--header', 'Access-Control-Request-Headers: content-type']
        if method == 'PUT':
            args += ['--header', 'Content-Type: image/png', '--data-binary', '']
        args += [base+path]
        with (self.proof / 'curl-errors.private').open('ab') as err:
            os.chmod(err.name, 0o600)
            r = subprocess.run(args, stdout=subprocess.PIPE, stderr=err)
        need(r.returncode == 0 and re.fullmatch(b'[1-5][0-9]{2}', r.stdout), 'local curl failed')
        for suffix in ('.headers', '.body'):
            os.chmod(str(prefix)+suffix, 0o600)
        h = {}
        text = Path(str(prefix)+'.headers').read_text().replace('\r\n', '\n').strip().split('\n\n')[-1]
        for line in text.splitlines()[1:]:
            if ':' in line:
                k, v = line.split(':', 1)
                h.setdefault(k.lower(), []).append(v.strip())
        return int(r.stdout), h

    def preflight(self):
        check_window(self.d)
        need(not os.path.lexists(LOCK), 'release lock busy')
        need(not (self.proof / 'inputs.json').exists(), 'proof already used')
        previous = archive_sources(self.d, 'PREVIOUS')
        release = archive_sources(self.d, 'RELEASE')
        results = inspect(self.d, previous, release)
        metadata = {}
        for m, (before, after, diff, meta) in results.items():
            save(self.proof / ('previous-'+m), previous[m])
            save(self.proof / ('before-'+m), before)
            save(self.proof / ('after-'+m), after)
            save(self.proof / ('previous-live-'+m+'.diff'), diff)
            meta['baseline_status'] = self.curl(m, 'baseline', 'GET')[0]
            metadata[m] = meta
        # Nothing is admitted until every live baseline is rechecked.
        for m in self.members:
            need(read_live(SITE_DIR / MEMBERS[m][0]) == (results[m][0], {k: results[m][3][k] for k in ('uid','gid','mode')}), 'concurrent preflight drift')
        save_json(self.proof / 'metadata.json', metadata)
        save(self.proof / 'inputs.json', self.raw_inputs)
        save(self.proof / 'preflight.ok', b'PASS\n')
        fsync_dir(self.proof)

    def entries(self, direction):
        need((self.proof / 'preflight.ok').read_bytes() == b'PASS\n', 'preflight required')
        metadata = json.loads((self.proof / 'metadata.json').read_bytes())
        need(set(metadata) == set(self.members), 'metadata member mismatch')
        entries = []
        for m in self.members:
            meta = metadata[m]
            before, after = ((self.proof / (p+'-'+m)).read_bytes() for p in ('before','after'))
            need(digest(before) == self.d['BEFORE_SHA256_'+m] == meta['before_sha256'] and digest(after) == meta['after_sha256'], 'backup integrity failure')
            need(candidate(before, after, MEMBERS[m][2]) == after, 'candidate integrity failure')
            owner = {k: meta[k] for k in ('uid','gid','mode')}
            path = SITE_DIR / MEMBERS[m][0]
            current, current_owner = read_live(path)
            allowed = (before,) if direction == 'apply' else (before, after)
            need(current in allowed and current_owner == owner, 'live member drift')
            entries.append((path, current, after if direction == 'apply' else before, owner))
        return entries

    def acquire(self):
        if not os.path.lexists(LOCK):
            LOCK.mkdir(mode=0o700)
            save(LOCK / 'owner', (str(self.proof)+'\n').encode())
        self.locked()

    def locked(self):
        s = LOCK.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0 and stat.S_IMODE(s.st_mode) == 0o700, 'unsafe release lock')
        raw, owner = read_live(LOCK / 'owner')
        need(owner == dict(uid=0, gid=0, mode=0o600) and raw == (str(self.proof)+'\n').encode(), 'release lock ownership mismatch')

    def replace(self, direction):
        self.locked()
        entries = self.entries(direction)
        staged = []
        for path, _, target, owner in entries:
            fd, name = tempfile.mkstemp(prefix='.'+path.stem+'.', suffix='.candidate', dir=SITE_DIR)
            with os.fdopen(fd, 'wb') as f:
                f.write(target)
                f.flush()
                os.fchown(f.fileno(), owner['uid'], owner['gid'])
                os.fchmod(f.fileno(), owner['mode'])
                os.fsync(f.fileno())
            staged.append(Path(name))
        expected = {path: (current, owner) for path, current, _, owner in entries}
        for (path, _, target, owner), pending in zip(entries, staged):
            if direction == 'apply':
                check_window(self.d)
            for p, state in expected.items():
                need(read_live(p) == state, 'concurrent member drift')
            os.replace(pending, path)
            expected[path] = (target, owner)
            fsync_dir(SITE_DIR)
        for path, state in expected.items():
            need(read_live(path) == state, 'member post-write mismatch')

    def validate_reload(self, recovery=False):
        sites = [str(SITE_DIR / MEMBERS[m][0]) for m in self.members]
        self.command(['/bin/bash', str(self.helper / 'prepare-logs.sh'), str(self.proof)]+sites, 'logs')
        self.command(['sudo', '-n', '-u', 'caddy', 'caddy', 'validate', '--config', str(CADDYFILE), '--adapter', 'caddyfile'], 'validate')
        if not recovery:
            check_window(self.d)
        self.command(['systemctl', 'reload', 'caddy'], 'reload')
        self.command(['systemctl', 'is-active', '--quiet', 'caddy'], 'active')

    def restored(self):
        for m in self.members:
            need(digest(read_live(SITE_DIR / MEMBERS[m][0])[0]) == self.d['BEFORE_SHA256_'+m], 'restore hash mismatch')
        self.entries('restore')

    def rollback(self):
        self.acquire()
        self.replace('restore')
        self.validate_reload(recovery=True)
        self.restored()
        if not (self.proof / 'rollback.ok').exists():
            save(self.proof / 'rollback.ok', b'PASS\n')

    def apply(self):
        check_window(self.d)
        self.entries('apply')
        self.acquire()
        save(self.proof / 'attempt', b'APPLY\n')
        try:
            self.replace('apply')
            self.validate_reload()
            self.installed()
            save(self.proof / 'apply.ok', b'PASS\n')
        except BaseException:
            # Partial renames and validate/reload failures all restore EVERY member.
            self.rollback()
            raise

    def installed(self):
        self.locked()
        meta = json.loads((self.proof / 'metadata.json').read_bytes())
        self.entries('restore')
        for m in self.members:
            raw = read_live(SITE_DIR / MEMBERS[m][0])[0]
            need(digest(raw) == meta[m]['after_sha256'], 'installed hash mismatch')
            need(outside(raw, MEMBERS[m][2], False) == meta[m]['outside_sha256']
                 and raw.count(b'admin_gate') == meta[m]['admin_gate_count'], 'C1 gate changed')

    def verify(self):
        self.installed()
        baseline = json.loads((self.proof / 'metadata.json').read_bytes())
        for m in self.members:
            origin = 'https://commonswarm.com'
            status, h = self.curl(m, 'allowed', 'OPTIONS', origin)
            need(status == 204 and h.get('access-control-allow-origin') == [origin]
                 and h.get('access-control-allow-methods') == ['PUT, OPTIONS']
                 and h.get('access-control-allow-headers') == ['content-type']
                 and h.get('vary') == ['Origin'], 'allowed preflight failed')
            _, h = self.curl(m, 'denied', 'OPTIONS', 'https://evil.example')
            need('access-control-allow-origin' not in h, 'denied origin allowed')
            upstream, _ = self.curl(m, 'upstream', 'PUT', origin, direct=True)
            status, h = self.curl(m, 'put', 'PUT', origin)
            cors = {k: v for k, v in h.items() if k.startswith('access-control-')}
            need(400 <= status < 500 and status == upstream and cors == {'access-control-allow-origin': [origin]}, 'upstream PUT CORS failed')
            need(self.curl(m, 'baseline', 'GET')[0] == baseline[m]['baseline_status'], 'non-upload status changed')
        self.installed()
        save(self.proof / 'verify.ok', b'PASS\n')

    def close(self, result):
        need(result in ('success','rolled-back','aborted'), 'close result required')
        if result == 'success':
            need((self.proof / 'verify.ok').read_bytes() == b'PASS\n' and not (self.proof / 'rollback.ok').exists(), 'verified success required')
            self.installed()
        else:
            if result == 'rolled-back':
                need((self.proof / 'rollback.ok').read_bytes() == b'PASS\n', 'verified rollback required')
            else:
                need(not (self.proof / 'attempt').exists(), 'abort after attempt forbidden')
            self.restored()
        # Explicit projection: no diagnostic, live, diff or backup file is copyable.
        summary = {'result': result, 'release_sha': self.d['RELEASE_SHA'], 'members': {}}
        for m in self.members:
            raw = read_live(SITE_DIR / MEMBERS[m][0])[0]
            summary['members'][m] = {'sha256': digest(raw), 'admin_gate_count': raw.count(b'admin_gate'),
                                     'diff_sha256': self.d['DIFF_SHA256_'+m], 'status': 'PASS'}
        save_json(self.proof / 'copyback.json', summary)
        if os.path.lexists(LOCK):
            self.locked()
            (LOCK / 'owner').unlink()
            LOCK.rmdir()


def main():
    try:
        os.umask(0o077)
        need(len(sys.argv) in (6, 7), 'usage: MODE INPUTS PROOF HELPER_DIR PLAN [CLOSE_RESULT]')
        mode, inputs, proof, helper, plan = sys.argv[1:6]
        need(mode in ('preflight','apply','verify','rollback','close'), 'unknown mode')
        session = Session(Path(inputs), Path(proof), Path(helper), Path(plan))
        if mode == 'close':
            need(len(sys.argv) == 7, 'close result required')
            session.close(sys.argv[6])
        else:
            getattr(session, mode)()
        for m in session.members:
            print('SHA256 '+m+' '+digest(read_live(SITE_DIR / MEMBERS[m][0])[0]))
        print('PASS cors-'+mode)
    except Refusal as error:
        print('FAIL cors-live-edit: '+str(error)+'; STOP', file=sys.stderr)
        sys.exit(1)
    except BaseException:
        # Never expose a traceback, live line, Caddy diagnostic or raw error.
        print('FAIL cors-live-edit: private operation failed; STOP', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
