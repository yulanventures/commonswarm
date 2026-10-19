#!/bin/bash
# Installed from the reviewed controller SHA, independently of the SHA under test.
set -euo pipefail
exec python3 - "$@" <<'PY'
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess as sp
import sys
import time
import uuid

SUITES = ('box-dry-run', 'server', 'p1-cli', 'site', 'unit')
def refuse(message):
    sys.exit('REFUSE: ' + message)

args = sys.argv[1:]
if len(args) != 4 or args[0] not in ('--sha', '--ref') or args[2] != '--suite':
    refuse('use --sha <40hex> or --ref main, followed by --suite all|server|p1-cli|site|box-dry-run|unit')
requested, selection = args[1], args[3]
if (args[0] == '--sha' and not re.fullmatch('[0-9a-f]{40}', requested)) or (args[0] == '--ref' and requested != 'main'):
    refuse('only an exact lowercase SHA or --ref main is accepted')
if selection not in (*SUITES, 'all'):
    refuse('unknown suite')
cfg_path = Path(os.environ.get('COMMONSWARM_CI_CONFIG', '/opt/commonswarm-ci/config.json'))
cfg = json.loads(cfg_path.read_text())
if not re.fullmatch('[0-9a-f]{40}', cfg['controller_sha']):
    refuse('controller SHA must be exact')
hostname = sp.check_output(['hostname', '-s'], text=True).strip()
if os.uname().sysname != 'Linux' or hostname == 'yulan-vps-1' or hostname != cfg['allowed_hostname']:
    refuse('standalone execution requires the configured nonproduction Linux CI host')
state = Path(cfg['state'])
if not state.is_absolute() or state.is_symlink() or state.resolve() != state or state == Path('/') or state == Path.home():
    refuse('state must be a canonical dedicated absolute directory')
state.mkdir(mode=0o700, parents=True, exist_ok=True)
if state.stat().st_uid != os.getuid() or state.stat().st_mode & 0o077:
    refuse('state must be private and owned by the service user')
if (cfg.get('service_uid'), cfg.get('service_gid')) != (os.getuid(), os.getgid()):
    refuse('dedicated service identity mismatch')
os.umask(0o077)
SOURCE_URL = 'https://github.com/yulanventures/commonswarm.git'
if cfg.get('source_url') != SOURCE_URL:
    refuse('source must be the public CommonSwarm HTTPS URL')
timeout = cfg.get('timeout_seconds', 1800)
if not isinstance(timeout, int) or not 1 <= timeout <= 1800:
    refuse('suite timeout must be 1..1800 seconds')
for key in ('worker_image', 'dind_image'):
    if not re.fullmatch(r'(?:[^\s]+@)?sha256:[0-9a-f]{64}', cfg[key]):
        refuse('images must be resolved immutable digests')
controller = Path(cfg['controller']).resolve()
expected = cfg.get('controller_checksums', {})
if set(expected) != {'run.sh', 'suite.sh', 'retain.py', 'publish-status.py'} or any(
        hashlib.sha256((controller / name).read_bytes()).hexdigest() != digest
        for name, digest in expected.items()):
    refuse('installed controller checksum mismatch')
# Keep the same home. Discard inherited provider/production credentials and
# Docker selectors. Public source needs no credentials or SSH configuration.
environment = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG') if k in os.environ}
os.environ.clear()
os.environ.update(environment, GIT_TERMINAL_PROMPT='0',
                  GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                  GIT_CONFIG_SYSTEM='/dev/null', DOCKER_CONTEXT='default',
                  DOCKER_HOST='unix:///var/run/docker.sock', DOCKER_CONFIG=str(state / 'docker-config'))
(state / 'docker-config').mkdir(mode=0o700, exist_ok=True)
# Signals never throw through cleanup. This latch persists across all attempts,
# queue waits and retention, and is checked before every new external work item.
stopping = False
active = None
class StopRequested(BaseException):
    pass
def interrupted(sig, frame):
    global stopping
    stopping = True
    if active is not None and active.poll() is None:
        try:
            os.killpg(active.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
def check_stopping():
    if stopping:
        raise StopRequested()
# A negative PE probe is meaningful only if another user's PID 1 is visible.
probe = sp.run(['pgrep', '-u', 'root', '-x', 'systemd'], stdout=sp.DEVNULL, timeout=2)
if probe.returncode != 0:
    refuse('cannot observe root systemd; PE process visibility unproven')
def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()
def cmd(argv, interruptible=False, **kw):
    global active
    if not interruptible:
        return sp.run(argv, check=True, **{'timeout': 60, **kw})
    if stopping:
        sys.exit(130)
    limit = kw.pop('timeout', 60)
    active = sp.Popen(argv, start_new_session=True, **kw)
    started = time.monotonic()
    try:
        while active.poll() is None:
            if stopping:
                raise StopRequested()
            if time.monotonic() - started >= limit:
                raise sp.TimeoutExpired(argv, limit)
            time.sleep(0.1)
        if stopping:
            raise StopRequested()
        if active.returncode:
            raise sp.CalledProcessError(active.returncode, argv)
    except BaseException as failure:
        if active.poll() is None:
            os.killpg(active.pid, signal.SIGTERM)
            try:
                active.wait(timeout=1)
            except sp.TimeoutExpired:
                os.killpg(active.pid, signal.SIGKILL)
                active.wait(timeout=5)
        if isinstance(failure, StopRequested):
            sys.exit(130)
        raise
    finally:
        active = None
def output(argv):
    return sp.check_output(argv, text=True, timeout=20).strip()
queued = stamp()
# All callers, including manual single suites and the timer, share this inode.
with (state / 'queue.lock').open('a') as lock:
    queue_deadline = time.monotonic() + 600
    while True:
        if stopping:
            sys.exit(130)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= queue_deadline:
                refuse('queue wait exceeded 600 seconds')
            time.sleep(0.25)
    if stopping:
        sys.exit(130)
    source = state / 'source.git'
    if not source.exists():
        cmd(['git', 'init', '--bare', str(source)], stdout=sp.DEVNULL, interruptible=True)
    # Replace repository-local transport, hooks, includes and rewrite settings.
    # Private permissions exclude unprivileged identities, not root/Docker admins.
    (source / 'config').write_text('[core]\nrepositoryformatversion = 0\nbare = true\n')
    git = ['git', '-c', 'credential.helper=', '-c', 'http.extraHeader=',
           '--git-dir=' + str(source)]
    cmd(git + ['fetch', '--quiet', SOURCE_URL,
               '+refs/tags/*:refs/tags/*',
               '+refs/heads/main:refs/heads/main',
               '+refs/heads/main:refs/remotes/origin/main'], timeout=120, interruptible=True)
    if stopping:
        sys.exit(130)
    if requested != 'main':
        cmd(git + ['fetch', '--quiet', SOURCE_URL, requested], timeout=120, interruptible=True)
    if stopping:
        sys.exit(130)
    resolved = output(git + ['rev-parse', ('refs/heads/main' if requested == 'main' else 'FETCH_HEAD') + '^{commit}'])
    if not re.fullmatch('[0-9a-f]{40}', resolved) or (requested != 'main' and resolved != requested):
        refuse('fetch did not resolve the requested commit')
    cmd(git + ['update-ref', 'refs/heads/ci-input', resolved], interruptible=True)
    suites = SUITES if selection == 'all' else (selection,)
    overall = 0
    status_dir = state / 'statuses'
    for suite in suites:
        if stopping:
            overall = 130
            break
        suite_clock = time.monotonic()
        deadline = suite_clock + timeout
        suite_started = stamp()
        attempt = 0
        prior_attempts = []
        while True:
            if stopping:
                overall = 130
                break
            attempt += 1
            run_id = 'csci-' + uuid.uuid4().hex
            run = state / 'runs' / run_id
            run.mkdir(parents=True, mode=0o700)
            scratch = run / 'scratch'
            scratch.mkdir()
            work = scratch / 'work'
            tmp = scratch / 'tmp'
            tmp.mkdir(mode=0o1777)
            tmp.chmod(0o1777)
            # DinD and the worker see identical /work and /tmp paths: nested bind
            # mounts and --network host fixtures never refer to the CI host.
            daemon, worker, cleaner = run_id + '-docker', run_id + '-worker', run_id + '-cleaner'
            label = 'com.commonswarm.ci.run=' + run_id
            receipt = dict(requested_sha=requested, resolved_sha=resolved, suite=suite,
                           queued_at=queued, started_at=stamp(), run_id=run_id,
                           controller_sha=cfg['controller_sha'], images={k: cfg[k] for k in ('worker_image', 'dind_image')},
                           timeout_seconds=timeout, timed_out=False, gates={}, cleanup_errors=[],
                           attempt=attempt, prior_attempts=list(prior_attempts), state='running',
                           pending=True, suite_started_at=suite_started)
            receipt['controller_checksums'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                                 for p in sorted(controller.iterdir()) if p.is_file()}
            active = None
            code = 1
            suite_command = None
            with (run / 'suite.log').open('wb') as log:
                class Deferred(Exception):
                    pass
                def check_capacity():
                    check_stopping()
                    probe = sp.run(['pgrep', '-x', 'Runner.Worker'], stdout=sp.DEVNULL, timeout=2)
                    if probe.returncode == 0:
                        raise Deferred()
                    if probe.returncode != 1:
                        raise RuntimeError('PE worker probe failed')
                def bounded(argv):
                    global active
                    if time.monotonic() >= deadline:
                        raise sp.TimeoutExpired(argv, timeout)
                    check_capacity()
                    active = sp.Popen(argv, stdout=log, stderr=sp.STDOUT, start_new_session=True)
                    try:
                        while active.poll() is None:
                            check_capacity()
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise sp.TimeoutExpired(argv, timeout)
                            try:
                                active.wait(timeout=min(0.25, remaining))
                            except sp.TimeoutExpired:
                                pass
                        check_stopping()
                        result = active.returncode
                        if result:
                            raise sp.CalledProcessError(result, argv)
                        if time.monotonic() >= deadline:
                            raise sp.TimeoutExpired(argv, timeout)
                        check_capacity()
                    except BaseException as failure:
                        os.killpg(active.pid, signal.SIGTERM) if active.poll() is None else None
                        try:
                            active.wait(timeout=1 if isinstance(failure, Deferred) else 60)
                        except sp.TimeoutExpired:
                            os.killpg(active.pid, signal.SIGKILL)
                            active.wait(timeout=5)
                        raise
                    finally:
                        active = None
                try:
                    bounded(['git', 'clone', '--quiet', '--no-hardlinks', '--no-checkout', str(source), str(work)])
                    bounded(['git', '-C', str(work), 'checkout', '--quiet', '--detach', resolved])
                    bounded(['git', '-C', str(work), 'remote', 'set-url', 'origin', 'https://github.com/yulanventures/commonswarm.git'])
                    bounded(['docker', 'network', 'create', '--label', label, run_id])
                    # Port conflicts are private to this fresh daemon/network namespace.
                    bounded(['docker', 'run', '-d', '--name', daemon, '--label', label, '--network', run_id, '--privileged', '--memory=2g',
                             '--mount', f'type=bind,src={work},dst=/work',
                             '--mount', f'type=bind,src={tmp},dst=/tmp',
                             '--mount', f'type=bind,src={tmp},dst=/private/tmp',
                             '--env', 'DOCKER_TLS_CERTDIR=', cfg['dind_image'],
                             'dockerd', '--host=tcp://127.0.0.1:2375', '--host=unix:///var/run/docker.sock', '--ip=127.0.0.1', '--tls=false'])
                    # Filter in this namespace before Docker DNAT, including future bridges.
                    # Only replies to namespace-originated traffic may enter on eth0.
                    bounded(['docker', 'exec', daemon, 'sh', '-ec', '''
                        for firewall in iptables ip6tables; do
                            "$firewall" -w 5 -t mangle -I PREROUTING 1 -i eth0 \
                                -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
                            "$firewall" -w 5 -t mangle -C PREROUTING -i eth0 \
                                -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
                        done
                    '''])
                    suite_command = ['docker', 'run', '--name', worker, '--label', label,
                             '--memory=4g', '--network', 'container:' + daemon, '--user', '0' if suite == 'box-dry-run' else 'ciworker',
                             *(['--tmpfs', '/run:rw,mode=755'] if suite == 'box-dry-run' else []),
                             '--mount', f'type=bind,src={work},dst=/work',
                             '--mount', f'type=bind,src={tmp},dst=/tmp',
                             '--mount', f'type=bind,src={tmp},dst=/private/tmp',
                             '--mount', f'type=bind,src={controller},dst=/controller,readonly',
                             '--mount', f'type=bind,src={run},dst=/receipt',
                             '--workdir', '/work', '--env', 'SUDO_UID=' + str(os.getuid()),
                             '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
                             '--env', 'GIT_CONFIG_SYSTEM=/dev/null', '--env', 'GIT_TERMINAL_PROMPT=0',
                             '--env', 'CI=true', '--env', 'STANDALONE_CI=1',
                             '--env', 'DOCKER_HOST=tcp://127.0.0.1:2375', '--env', 'DOCKER_TLS_CERTDIR=',
                             '--env', 'RUNNER_TEMP=/tmp', '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
                             '--env', 'C1_CADDY_BINARY=/usr/local/bin/caddy',
                             '--env', 'CSCI_PROJECT=' + run_id, '--env', 'CSCI_REQUESTED=' + requested, cfg['worker_image'],
                             '/bin/bash', '/controller/suite.sh', suite]
                    bounded(suite_command)
                    code = 0
                except Deferred:
                    receipt.update(state='deferred', deferred_at=stamp(), reason='PromptEden worker active')
                    code = 75
                except sp.TimeoutExpired:
                    receipt['timed_out'] = True
                    code = 124
                except sp.CalledProcessError as e:
                    code = e.returncode if e.returncode > 0 else 128 - e.returncode
                    if e.cmd != suite_command or e.returncode in (125, 126, 127):
                        receipt['controller_error'] = 'setup_command_failed'
                except StopRequested:
                    code = 130
                except Exception as e:
                    code = 1
                    receipt['controller_error'] = type(e).__name__ + ': ' + str(e)
                finally:
                    # Never prune or select by prefix. Verify exact ownership before
                    # removing only these two containers (their anonymous volumes too).
                    for name in (worker, daemon):
                        try:
                            found = sp.run(['docker', 'inspect', '--format', '{{ index .Config.Labels "com.commonswarm.ci.run" }}', name],
                                           capture_output=True, text=True, timeout=20)
                            if found.returncode == 0:
                                if found.stdout.strip() != run_id:
                                    raise RuntimeError('ownership mismatch: ' + name)
                                cmd(['docker', 'rm', '-fv', name], stdout=log, stderr=log, timeout=60)
                            elif found.returncode < 0:
                                raise RuntimeError('cleanup inspect interrupted: ' + name + ' rc=' + str(found.returncode))
                            elif sp.run(['docker', 'info'], stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=20).returncode:
                                raise RuntimeError('Docker unavailable during cleanup')
                        except Exception as e:
                            receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
                    # Root fixtures and nested services can leave root-owned files,
                    # including receipt artifacts. Reclaim only this run's mount.
                    try:
                        cmd(['docker', 'run', '--name', cleaner, '--label', label, '--network', 'none', '--user', '0',
                             '--mount', f'type=bind,src={run},dst=/receipt', cfg['worker_image'],
                             'chown', '-R', f'{os.getuid()}:{os.getgid()}', '/receipt'], stdout=log, stderr=log, timeout=60)
                    except Exception as e:
                        receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
                    finally:
                        # A failed or timed-out cleaner is still our responsibility.
                        try:
                            found = sp.run(['docker', 'inspect', '--format', '{{ index .Config.Labels "com.commonswarm.ci.run" }}', cleaner], capture_output=True, text=True, timeout=20)
                            if found.returncode == 0:
                                if found.stdout.strip() != run_id:
                                    raise RuntimeError('cleaner ownership mismatch')
                                cmd(['docker', 'rm', '-fv', cleaner], stdout=log, stderr=log, timeout=60)
                            elif found.returncode < 0:
                                raise RuntimeError('cleanup inspect interrupted: ' + cleaner + ' rc=' + str(found.returncode))
                        except Exception as e:
                            receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
                    try:
                        found = sp.run(['docker', 'network', 'inspect', '--format', '{{ index .Labels "com.commonswarm.ci.run" }}', run_id], capture_output=True, text=True, timeout=20)
                        if found.returncode == 0:
                            if found.stdout.strip() != run_id:
                                raise RuntimeError('network ownership mismatch')
                            cmd(['docker', 'network', 'rm', run_id], stdout=log, stderr=log, timeout=60)
                        elif found.returncode < 0:
                            raise RuntimeError('cleanup network inspect interrupted: rc=' + str(found.returncode))
                    except Exception as e:
                        receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
            if stopping:
                code = 130
                receipt.update(state='failed', pending=False)
            if receipt['cleanup_errors']:
                code = code or 1
                receipt['state'] = 'failed'
            elif receipt['state'] != 'deferred':
                receipt['state'] = 'completed' if code == 0 else 'failed'
            receipt.update(exit_code=code, ended_at=stamp(),
                           elapsed_seconds=round(time.monotonic() - suite_clock, 3),
                           pending=receipt['state'] == 'deferred')
            for name in ('gates.json', 'versions.json'):
                if (run / name).exists():
                    try:
                        receipt[name.removesuffix('.json')] = json.loads((run / name).read_text())
                    except (ValueError, OSError):
                        receipt['artifact_error'] = 'invalid ' + name
                        if receipt['state'] != 'deferred':
                            code = code or 1
                            receipt.update(exit_code=code, state='failed', pending=False)
            receipt['artifacts'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted(run.iterdir()) if p.is_file() and p.name != 'receipt.json'}
            (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            # Scratch includes generated test credentials. Retention removes it only
            # after owned services are gone; logs/receipts remain private for 14 days.
            if not receipt['cleanup_errors']:
                try:
                    cmd([sys.executable, str(controller / 'retain.py'), '--scratch', str(scratch), '--root', str(state)], timeout=60)
                except Exception as e:
                    code = code or 1
                    receipt['exit_code'] = code
                    receipt.update(state='failed', pending=False)
                    receipt['cleanup_errors'].append('scratch: ' + type(e).__name__)
                    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            if stopping:
                code = 130
                receipt.update(exit_code=130, state='failed', pending=False)
                (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps({'receipt': str(run / 'receipt.json'), 'suite': suite, 'state': receipt['state'], 'exit_code': code}), flush=True)
            if receipt['state'] == 'deferred':
                # Deferred is unfinished work, never a suite pass. Retry this snapshot
                # only after PE becomes quiet, within the original suite deadline.
                try:
                    while True:
                        if time.monotonic() >= deadline:
                            raise sp.TimeoutExpired(['quiet-retry'], timeout)
                        try:
                            check_capacity()
                            break
                        except Deferred:
                            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
                except sp.TimeoutExpired:
                    code = 124
                    receipt.update(state='failed', pending=False, timed_out=True, exit_code=code, ended_at=stamp(),
                                   elapsed_seconds=round(time.monotonic() - suite_clock, 3))
                    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                except (Exception, KeyboardInterrupt, StopRequested) as e:
                    code = 130 if isinstance(e, (KeyboardInterrupt, StopRequested)) else 1
                    receipt.update(state='failed', pending=False, exit_code=code, ended_at=stamp(),
                                   controller_error=type(e).__name__)
                    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                else:
                    prior_attempts.append(run_id)
                    continue
            # Only a final attempt may publish. Use host-owned values in memory,
            # never a receipt re-read from the worker-writable mount. In particular,
            # a deferred attempt that exhausts its quiet wait is now a final error.
            result = dict(resolved_sha=resolved, suite=suite, run_id=run_id,
                          state=receipt['state'], pending=receipt['pending'],
                          exit_code=code, timed_out=receipt['timed_out'],
                          controller_failed=bool(receipt.get('controller_error')),
                          cleanup_failed=bool(receipt['cleanup_errors']))
            try:
                published = sp.run([sys.executable, '-I', str(controller / 'publish-status.py'),
                                    '--config', str(cfg_path.resolve())],
                                   input=json.dumps(result), text=True, capture_output=True, timeout=30)
                publication = json.loads(published.stdout)
                if published.returncode or publication.get('state') != 'published':
                    publication = dict(state='failed', error=publication.get('error', 'publisher_failed'))
            except Exception:
                # No exception strings: transports and responses can echo secrets.
                publication = dict(state='failed', error='publisher_unavailable')
            publication.update(resolved_sha=resolved, suite=suite, run_id=run_id, attempted_at=stamp())
            # This host-only directory is never mounted into test containers. Keep
            # failures for operator retry without changing the underlying CI exit.
            publication_record = status_dir / (run_id + '.json')
            persistence_errors = []
            try:
                status_dir.mkdir(mode=0o700, exist_ok=True)
                publication_record.write_text(json.dumps(publication, indent=2) + '\n')
            except OSError:
                persistence_errors.append('status_record_unavailable')
            receipt['github_status'] = publication
            try:
                (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            except OSError:
                persistence_errors.append('receipt_record_unavailable')
            print(json.dumps({'suite': suite, 'resolved_sha': resolved,
                              'github_status': publication['state'],
                              'publication': publication,
                              'persistence_errors': persistence_errors,
                              'publication_record': None if 'status_record_unavailable' in persistence_errors
                              else str(publication_record)}), flush=True)
            overall = overall or code
            break
        if stopping or code == 130:
            break
    cmd([sys.executable, str(controller / 'retain.py'), '--root', str(state)], timeout=60)
    sys.exit(130 if stopping else overall)
PY
