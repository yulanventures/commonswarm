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
import shlex
import subprocess as sp
import sys
import time
import uuid

SUITES = ('server', 'p1-cli', 'site', 'box-dry-run', 'unit')
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
os.umask(0o077)
timeout = cfg.get('timeout_seconds', 1800)
if not isinstance(timeout, int) or not 1 <= timeout <= 1800:
    refuse('suite timeout must be 1..1800 seconds')
for key in ('worker_image', 'dind_image'):
    if not re.fullmatch(r'(?:[^\s]+@)?sha256:[0-9a-f]{64}', cfg[key]):
        refuse('images must be resolved immutable digests')
controller = Path(cfg['controller']).resolve()
# Keep the same home. Discard inherited provider/production credentials and
# Docker selectors; only the separately installed repository SSH config is used.
environment = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG') if k in os.environ}
os.environ.clear()
os.environ.update(environment, GIT_TERMINAL_PROMPT='0')
def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()
def cmd(argv, **kw):
    return sp.run(argv, check=True, **kw)
def output(argv):
    return sp.check_output(argv, text=True).strip()
queued = stamp()
# All callers, including manual single suites and the timer, share this inode.
with (state / 'queue.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    source = state / 'source.git'
    if not source.exists():
        cmd(['git', 'init', '--bare', str(source)], stdout=sp.DEVNULL)
    git = ['git', '-c', 'core.sshCommand=ssh -F ' + shlex.quote(cfg['ssh_config']), '--git-dir=' + str(source)]
    # Root installs a repo-only read-only deploy key via SSH config. No credentials
    # enter URLs, arguments, suite environments, or artifacts.
    cmd(git + ['fetch', '--quiet', cfg['source_url'], 'refs/heads/main' if requested == 'main' else requested], timeout=120)
    resolved = output(git + ['rev-parse', 'FETCH_HEAD^{commit}'])
    if not re.fullmatch('[0-9a-f]{40}', resolved) or (requested != 'main' and resolved != requested):
        refuse('fetch did not resolve the requested commit')
    cmd(git + ['update-ref', 'refs/heads/ci-input', resolved])
    suites = SUITES if selection == 'all' else (selection,)
    overall = 0
    for suite in suites:
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
                       timeout_seconds=timeout, timed_out=False, gates={}, cleanup_errors=[])
        receipt['controller_checksums'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                             for p in sorted(controller.iterdir()) if p.is_file()}
        active = None
        def interrupted(sig, frame):
            raise InterruptedError('controller interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        code = 1
        with (run / 'suite.log').open('wb') as log:
            deadline = time.monotonic() + timeout
            def bounded(argv):
                global active
                active = sp.Popen(argv, stdout=log, stderr=sp.STDOUT, start_new_session=True)
                try:
                    result = active.wait(timeout=max(0.001, deadline - time.monotonic()))
                    if result:
                        raise sp.CalledProcessError(result, argv)
                except BaseException:
                    os.killpg(active.pid, signal.SIGTERM) if active.poll() is None else None
                    try:
                        active.wait(timeout=60)
                    except sp.TimeoutExpired:
                        os.killpg(active.pid, signal.SIGKILL)
                        active.wait()
                    raise
                finally:
                    active = None
            try:
                # Existing PromptEden workers take precedence. Do not cancel them.
                busy = sp.run(['pgrep', '-x', 'Runner.Worker'], stdout=sp.DEVNULL)
                if busy.returncode != 1:
                    raise sp.CalledProcessError(75, ['contention-preflight'])
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
                         'dockerd', '--host=tcp://0.0.0.0:2375', '--host=unix:///var/run/docker.sock', '--tls=false'])
                bounded(['docker', 'run', '--name', worker, '--label', label,
                         '--memory=4g', '--network', 'container:' + daemon, '--user', '0' if suite == 'box-dry-run' else 'ciworker',
                         '--mount', f'type=bind,src={work},dst=/work',
                         '--mount', f'type=bind,src={tmp},dst=/tmp',
                         '--mount', f'type=bind,src={tmp},dst=/private/tmp',
                         '--mount', f'type=bind,src={controller},dst=/controller,readonly',
                         '--mount', f'type=bind,src={run},dst=/receipt',
                         '--workdir', '/work', '--env', 'CI=true', '--env', 'STANDALONE_CI=1',
                         '--env', 'DOCKER_HOST=tcp://127.0.0.1:2375', '--env', 'DOCKER_TLS_CERTDIR=',
                         '--env', 'RUNNER_TEMP=/tmp', '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
                         '--env', 'C1_CADDY_BINARY=/usr/local/bin/caddy',
                         '--env', 'CSCI_PROJECT=' + run_id, cfg['worker_image'],
                         '/bin/bash', '/controller/suite.sh', suite])
                code = 0
            except sp.TimeoutExpired:
                receipt['timed_out'] = True
                code = 124
            except sp.CalledProcessError as e:
                code = e.returncode if e.returncode > 0 else 128 - e.returncode
            except InterruptedError:
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
                    if output(['docker', 'inspect', '--format', '{{ index .Config.Labels "com.commonswarm.ci.run" }}', cleaner]) != run_id:
                        raise RuntimeError('cleaner ownership mismatch')
                    cmd(['docker', 'rm', '-fv', cleaner], stdout=log, stderr=log, timeout=60)
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
                    except Exception as e:
                        receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
                try:
                    found = sp.run(['docker', 'network', 'inspect', '--format', '{{ index .Labels "com.commonswarm.ci.run" }}', run_id], capture_output=True, text=True, timeout=20)
                    if found.returncode == 0:
                        if found.stdout.strip() != run_id:
                            raise RuntimeError('network ownership mismatch')
                        cmd(['docker', 'network', 'rm', run_id], stdout=log, stderr=log, timeout=60)
                except Exception as e:
                    receipt['cleanup_errors'].append(type(e).__name__ + ': ' + str(e))
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGINT, signal.SIG_DFL)
        if receipt['cleanup_errors']:
            code = code or 1
        receipt.update(exit_code=code, ended_at=stamp())
        for name in ('gates.json', 'versions.json'):
            if (run / name).exists():
                try:
                    receipt[name.removesuffix('.json')] = json.loads((run / name).read_text())
                except (ValueError, OSError):
                    receipt['artifact_error'] = 'invalid ' + name
                    code = code or 1
                    receipt['exit_code'] = code
        receipt['artifacts'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted(run.iterdir()) if p.is_file() and p.name != 'receipt.json'}
        (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        # Scratch includes generated test credentials. Retention removes it only
        # after owned services are gone; logs/receipts remain private for 14 days.
        if not receipt['cleanup_errors']:
            try:
                cmd([sys.executable, str(controller / 'retain.py'), '--scratch', str(scratch), '--root', str(state)])
            except Exception as e:
                code = code or 1
                receipt['exit_code'] = code
                receipt['cleanup_errors'].append('scratch: ' + type(e).__name__)
                (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'receipt': str(run / 'receipt.json'), 'suite': suite, 'exit_code': code}), flush=True)
        overall = overall or code
        if code == 130:
            break
    cmd([sys.executable, str(controller / 'retain.py'), '--root', str(state)])
    sys.exit(overall)
PY
