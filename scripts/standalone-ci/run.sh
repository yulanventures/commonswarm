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
import stat
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
reader = cfg.get('status_reader_uid')
if reader is not None and (type(reader) is not int or reader <= 0 or reader == os.getuid()):
    refuse('invalid status reader UID')
def access_entries(fd):
    result = sp.check_output(['getfacl', '-cpn', '/proc/self/fd/' + str(fd)],
                             pass_fds=(fd,), text=True, stderr=sp.DEVNULL, timeout=5)
    return {line.split('#', 1)[0].strip() for line in result.splitlines() if line.strip()}
def private_directory(path, permission=None, grant=False):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o700 != 0o700:
            raise ValueError('directory owner mismatch')
        base = {'user::rwx', 'group::---', 'other::---'}
        allowed = base | {f'user:{reader}:{permission}', 'mask::' + permission}
        entries = access_entries(fd) if reader is not None else None
        if reader is None:
            if info.st_mode & 0o077:
                raise ValueError('private directory permissions')
        elif entries != base and entries != allowed:
            raise ValueError('unsupported directory ACL')
        if grant:
            sp.run(['setfacl', '-m', f'u:{reader}:{permission},m::{permission}',
                    '/proc/self/fd/' + str(fd)], pass_fds=(fd,), check=True,
                   stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=5)
            if access_entries(fd) != allowed:
                raise ValueError('directory ACL readback failed')
        return fd
    except BaseException:
        os.close(fd)
        raise
try:
    os.close(private_directory(state, '--x'))
except Exception:
    refuse('state owner/access ACL mismatch')
def persist_receipt(run, receipt, ready=False):
    # The worker never sees this directory or temporary inode. Rename publishes
    # the complete controller-owned object, including its final access ACL.
    directory = os.open(run, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.receipt-' + uuid.uuid4().hex
    installed = False
    try:
        if ready:
            if reader is None:
                raise ValueError('reader unconfigured')
            for path, permission in ((state, '--x'), (state / 'runs', 'r-x'), (run, '--x')):
                os.close(private_directory(path, permission, grant=True))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            if ready:
                sp.run(['setfacl', '-m', f'u:{reader}:r--,m::r--', '/proc/self/fd/' + str(fd)],
                       pass_fds=(fd,), check=True, stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=5)
                if access_entries(fd) != {'user::rw-', 'group::---', 'other::---', f'user:{reader}:r--', 'mask::r--'}:
                    raise ValueError('receipt ACL readback failed')
            data = json.dumps(receipt, indent=2).encode() + b'\n'
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, 'receipt.json', src_dir_fd=directory, dst_dir_fd=directory)
        installed = True
        os.fsync(directory)
    except BaseException:
        if ready and installed:
            os.unlink('receipt.json', dir_fd=directory)
        raise
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)
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
            artifacts = run / 'worker-artifacts'
            artifacts.mkdir(mode=0o700)
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
                             '--mount', f'type=bind,src={artifacts},dst=/receipt',
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
                             '--mount', f'type=bind,src={artifacts},dst=/receipt',
                             '--mount', f'type=bind,src={scratch},dst=/scratch', cfg['worker_image'],
                             'chown', '-R', f'{os.getuid()}:{os.getgid()}', '/receipt', '/scratch'], stdout=log, stderr=log, timeout=60)
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
            def artifact_bytes(path):
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1048576:
                        raise ValueError('unsafe worker artifact')
                    with os.fdopen(fd, 'rb', closefd=False) as stream:
                        data = stream.read(1048577)
                    if len(data) > 1048576:
                        raise ValueError('oversized worker artifact')
                    return data
                finally:
                    os.close(fd)
            receipt['artifacts'] = {'suite.log': hashlib.sha256((run / 'suite.log').read_bytes()).hexdigest()}
            for path in sorted(artifacts.iterdir()):
                try:
                    data = artifact_bytes(path)
                    receipt['artifacts'][path.name] = hashlib.sha256(data).hexdigest()
                    if path.name in ('gates.json', 'versions.json'):
                        receipt[path.stem] = json.loads(data)
                except (ValueError, OSError):
                    receipt['artifact_error'] = 'invalid worker artifact'
                    if receipt['state'] != 'deferred':
                        code = code or 1
                        receipt.update(exit_code=code, state='failed', pending=False)
            persist_receipt(run, receipt)
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
                    persist_receipt(run, receipt)
            if stopping:
                code = 130
                receipt.update(exit_code=130, state='failed', pending=False)
                persist_receipt(run, receipt)
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
                    persist_receipt(run, receipt)
                except (Exception, KeyboardInterrupt, StopRequested) as e:
                    code = 130 if isinstance(e, (KeyboardInterrupt, StopRequested)) else 1
                    receipt.update(state='failed', pending=False, exit_code=code, ended_at=stamp(),
                                   controller_error=type(e).__name__)
                    persist_receipt(run, receipt)
                else:
                    prior_attempts.append(run_id)
                    continue
            # Readiness failures are visible but never change CI exits or skip
            # later suites/retention. A failed attempt never exposes a ready inode.
            receipt['github_status'] = dict(state='ready', version=1)
            errors = []
            try:
                persist_receipt(run, receipt, ready=True)
            except Exception:
                receipt['github_status'] = dict(state='failed', error='readiness_unavailable')
                errors.append('readiness_unavailable')
                try:
                    persist_receipt(run, receipt)
                except Exception:
                    errors.append('receipt_record_unavailable')
            print(json.dumps({'suite': suite, 'resolved_sha': resolved,
                              'github_status': receipt['github_status']['state'],
                              'persistence_errors': errors}), flush=True)
            overall = overall or code
            break
        if stopping or code == 130:
            break
    cmd([sys.executable, str(controller / 'retain.py'), '--root', str(state)], timeout=60)
    sys.exit(130 if stopping else overall)
PY
