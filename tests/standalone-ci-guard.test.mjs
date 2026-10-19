// Independent contracts: real guard admission in disposable Linux containers;
// controller lifecycle with real git/flock/clock and a Docker boundary fixture.
// These catch overlapping runs, wrong source, lost failures, unsafe cleanup and
// broad deletion. No existing test owns the new standalone entry point.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const repo = resolve(import.meta.dirname, '..');
const controller = join(repo, 'scripts/standalone-ci');
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}
function good(command, args, options) {
  const r = run(command, args, options);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}
function fixture(control = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-ci-test.')));
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const installed = join(root, 'controller'); mkdirSync(installed);
  for (const name of ['run.sh', 'suite.sh', 'retain.py', 'publish-status.py']) writeFileSync(join(installed,name),readFileSync(join(controller,name)));
  if (control.statusPort) {
    const publisher = join(installed, 'publish-status.py');
    // Redirect only the HTTPS transport to a real loopback HTTP API. No
    // production endpoint flag; assertions exercise the actual wire request.
    writeFileSync(publisher, `import http.client\nhttp.client.HTTPSConnection=lambda host,timeout: http.client.HTTPConnection('127.0.0.1',${control.statusPort},timeout=timeout)\n` + readFileSync(publisher,'utf8'));
  }
  mkdirSync(source); mkdirSync(bin);
  good('git', ['init', '--quiet', '--initial-branch=main', source]);
  good('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  good('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  writeFileSync(join(source, 'control.json'), JSON.stringify(control));
  writeFileSync(join(source, 'identity'), 'first source');
  good('git', ['-C', source, 'add', '.']);
  good('git', ['-C', source, 'commit', '--quiet', '-m', 'fixture']);
  const sha = good('git', ['-C', source, 'rev-parse', 'HEAD']);
  good('git', ['-C', source, 'tag', 'fixture-tag']);
  writeFileSync(join(root, 'containers.json'), JSON.stringify({unowned: {label: 'some-other-run'}}));
  // The fixture only implements the external Docker transport. The real
  // controller writes the receipts, resolves git, queues, times out and cleans.
  const docker = `#!/usr/bin/env python3
import json,pathlib,sys,time,subprocess,os,signal
root=pathlib.Path(${JSON.stringify(root)})
p=root/'containers.json'
args=sys.argv[1:]
assert 'synthetic-status-only-token' not in json.dumps(args)+json.dumps(dict(os.environ))
for i,a in enumerate(args):
    if a=='--mount':
        mount=pathlib.Path(args[i+1].split(',')[1][4:]).resolve()
        token=root/'auth'/'token'
        assert mount != token and mount not in token.parents, 'credential mounted in test container'
assert os.environ['DOCKER_CONTEXT']=='default'
assert os.environ['DOCKER_HOST']=='unix:///var/run/docker.sock'
def event(action,name):
    with (root/'events.jsonl').open('a') as f: f.write(json.dumps(dict(action=action,name=name,at=time.monotonic()))+'\\n')
if args[0]=='run':
    name=args[args.index('--name')+1]
    label=args[args.index('--label')+1].split('=',1)[1]
    store=json.loads(p.read_text()); store[name]=dict(label=label); p.write_text(json.dumps(store))
    event('start',name)
    if name.endswith('-worker'):
        assert store.get(name.replace('-worker','-docker'),{}).get('ingress_policy'), 'worker started without ingress policy'
        mounts=[args[i+1] for i,a in enumerate(args) if a=='--mount']
        work=pathlib.Path(next(m.split(',')[1][4:] for m in mounts if 'dst=/work' in m))
        control=json.loads((work/'control.json').read_text())
        print((work/'identity').read_text(),flush=True)
        subprocess.run(['git','-C',str(work),'rev-parse','--verify','origin/main'],check=True)
        subprocess.run(['git','-C',str(work),'rev-parse','--verify','refs/tags/fixture-tag'],check=True)
        time.sleep(control.get('sleep',0))
        if control.get('tamper'):
            store=json.loads(p.read_text()); store[name.replace('-worker','-docker')]['label']='unowned'; p.write_text(json.dumps(store))
        event('finish',name)
        sys.exit(control.get('exit',{}).get(args[-1],0))
    sys.exit(0)
if args[0]=='exec':
    name=args[1]
    store=json.loads(p.read_text()); assert name in store
    if ${control.policyFail ? "True" : "False"}: sys.exit(42)
    store[name]['ingress_policy']=True; p.write_text(json.dumps(store)); event('policy',name); sys.exit(0)
if args[0]=='inspect':
    if args[-1].endswith('-worker') and ${control.killInspect ? "True" : "False"}:
        os.kill(os.getppid(),signal.SIGTERM)
        os.kill(os.getpid(),signal.SIGTERM)
    store=json.loads(p.read_text()); found=store.get(args[-1])
    if found: print(found['label']); sys.exit(0)
    sys.exit(1)
if args[0]=='rm':
    if args[-1].endswith('-worker') and ${control.signalCleanup ? "True" : "False"}:
        os.kill(os.getppid(),signal.SIGTERM)
    store=json.loads(p.read_text()); store.pop(args[-1],None); p.write_text(json.dumps(store)); event('remove',args[-1]); sys.exit(0)
if args[0]=='info': sys.exit(0)
if args[0]=='network':
    store=json.loads(p.read_text())
    if args[1]=='create': store[args[-1]]=dict(label=args[args.index('--label')+1].split('=',1)[1]); p.write_text(json.dumps(store)); sys.exit(0)
    if args[1]=='inspect':
        found=store.get(args[-1])
        if found: print(found['label']); sys.exit(0)
        sys.exit(1)
    if args[1]=='rm': store.pop(args[-1],None); p.write_text(json.dumps(store)); sys.exit(0)
sys.exit(2)
`;
  writeFileSync(join(bin, 'docker'), docker); chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\n[ "$4" = systemd ] && exit 0\nexit 1\n'); chmodSync(join(bin, 'pgrep'), 0o755);
  const realGit = good('which', ['git']);
  // Only the external source transport is replaced; git still resolves/clones
  // real commits. Inspect the fetch environment before redirecting it locally.
  const git = `#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
args=sys.argv[1:]
if 'fetch' in args:
    assert os.environ.get('GIT_CONFIG_NOSYSTEM') == '1'
    assert os.environ.get('GIT_CONFIG_GLOBAL') == '/dev/null'
    assert os.environ.get('GIT_TERMINAL_PROMPT') == '0'
    assert 'https://github.com/yulanventures/commonswarm.git' in args
    assert 'credential.helper=' in args and 'http.extraHeader=' in args
    cfg=Path(next(a.split('=',1)[1] for a in args if a.startswith('--git-dir=')))/'config'
    assert 'insteadOf' not in cfg.read_text() and 'include' not in cfg.read_text()
    with Path(${JSON.stringify(join(root,'fetches.jsonl'))}).open('a') as f: f.write(json.dumps(args)+'\\n')
    args[args.index('https://github.com/yulanventures/commonswarm.git')]=${JSON.stringify(source)}
    if ${control.dropMain ? "True" : "False"} and '+refs/tags/*:refs/tags/*' in args:
        args=[a for a in args if not a.startswith('+refs/heads/main:')]+['refs/heads/main']
        args.remove('+refs/tags/*:refs/tags/*')
os.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)},*args])
`;
  writeFileSync(join(bin, 'git'), git); chmodSync(join(bin, 'git'), 0o755);
  // Only the platform boundary is mocked on the Mini; real Linux/root guard
  // admission remains a separately reported Docker case on Root's CI host.
  if (process.platform !== 'linux') {
    const realPython=good('which',['python3']);
    const bootstrap=join(root,'linux-fixture.py');
    writeFileSync(bootstrap, `import os,sys\nif sys.argv[1]=='-':\n    actual=os.uname()\n    os.uname=lambda: type(actual)(('Linux',*actual[1:]))\n    sys.argv=sys.argv[1:]\n    exec(compile(sys.stdin.read(),'<controller>','exec'))\nelse: os.execv(${JSON.stringify(realPython)},[${JSON.stringify(realPython)},*sys.argv[1:]])\n`);
    writeFileSync(join(bin,'python3'), `#!/bin/sh\nexec '${realPython}' '${bootstrap}' "$@"\n`);
    chmodSync(join(bin,'python3'),0o755);
  }
  const cfg = {state, controller: installed, service_uid:process.getuid(), service_gid:process.getgid(),
    controller_checksums:Object.fromEntries(['run.sh','suite.sh','retain.py','publish-status.py'].map(name=>[name,createHash('sha256').update(readFileSync(join(installed,name))).digest('hex')])), source_url: 'https://github.com/yulanventures/commonswarm.git', allowed_hostname: good('hostname',['-s']),
    controller_sha: 'a'.repeat(40), worker_image: 'sha256:' + '1'.repeat(64),
    dind_image: 'fixture@sha256:' + '2'.repeat(64), timeout_seconds: 10};
  if (control.statusPort) {
    const auth = join(root,'auth'); mkdirSync(auth,{mode:0o700});
    cfg.github_status_token_file = join(auth,'token');
    writeFileSync(cfg.github_status_token_file,'synthetic-status-only-token\n',{mode:0o600});
  }
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify(cfg));
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, COMMONSWARM_CI_CONFIG: config};
  const args = (suite = 'unit', ref = ['--sha', sha]) => [join(installed, 'run.sh'), ...ref, '--suite', suite];
  const receipts = () => readdirSync(join(state, 'runs')).sort().map(n => JSON.parse(readFileSync(join(state, 'runs', n, 'receipt.json'))));
  return {root, source, state, sha, cfg, config, env, args, receipts};
}
function start(f, args = f.args(), command = 'bash') {
  const child = spawn(command, args, {env: f.env});
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x);
  child.stderr.on('data', x => stderr += x);
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', status => resolve({status, stdout, stderr}));
  });
  completion.child=child;
  return completion;
}

test('guard admits standalone and GHA, retaining CI/root/host/path refusals in a disposable container', {skip:process.platform !== 'linux' ? 'requires Root Linux/Docker guard execution' : false}, () => {
  const guard = join(realpathSync(mkdtempSync(join(tmpdir(), 'standalone-ci-guard.'))), 'guard.sh');
  writeFileSync(guard, readFileSync(join(repo, 'tests/box-dry-run/guard.sh')));
  chmodSync(guard, 0o644);
  const probe = (env, setup = ':', user = '0') => run('docker', ['run', '--rm', '--network', 'none',
    '--hostname', setup === 'production' ? 'yulan-vps-1' : 'guard-fixture', '--user', user,
    '--mount', `type=bind,src=${guard},dst=/guard.sh,readonly`, ...Object.entries(env).flatMap(([k,v]) => ['-e', `${k}=${v}`]),
    'ubuntu:24.04', 'bash', '-c', `${setup === 'production' ? ':' : setup}; exec bash /guard.sh`]);
  const base = {BOX_DRY_RUN:'1', CI:'true', STANDALONE_CI:'1'};
  for (const env of [base, {BOX_DRY_RUN:'1', CI:'true', GITHUB_ACTIONS:'true'}]) {
    const r = probe(env); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /BOX_DRY_RUN_GUARD=PASS/);
  }
  for (const [env, setup, user, reason] of [
    [{...base, STANDALONE_CI:''}, ':', '0', 'GITHUB_ACTIONS=true or STANDALONE_CI=1'],
    [{...base, CI:''}, ':', '0', 'CI=true'],
    [{...base, BOX_DRY_RUN:''}, ':', '0', 'BOX_DRY_RUN=1'],
    [base, 'production', '0', 'production hostname'],
    [base, 'uname() { echo Darwin; }; export -f uname', '0', 'Linux is required'],
    [base, ':', '65534', 'root is required'],
    [base, 'mkdir -p /home/commonswarm', '0', '/home/commonswarm existed'],
    [base, 'mkdir -p /srv/commonswarm', '0', '/srv/commonswarm existed'],
  ]) { const r = probe(env, setup, user); assert.equal(r.status, 77, r.stderr); assert.ok(r.stderr.includes(reason), r.stderr); }
});

test('strict CLI rejects branches, bad SHA, unknown suites and extra flags before work', () => {
  for (const args of [[], ['--sha','main','--suite','unit'], ['--ref','release','--suite','unit'],
    ['--sha','a'.repeat(40),'--suite','unknown'], ['--sha','a'.repeat(40),'--suite','unit','--extra']]) {
    const r = run('bash', [join(controller,'run.sh'), ...args]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /REFUSE:/);
  }
});

test('all suites aggregate failures and retain exact source provenance and log checksums', async () => {
  const f = fixture({exit: {'p1-cli': 9}});
  writeFileSync(join(f.source,'identity'), 'second source');
  good('git',['-C',f.source,'commit','-qam','later source']);
  const result = await start(f, f.args('all'));
  assert.equal(result.status, 9, result.stderr);
  const receipts = f.receipts();
  assert.equal(receipts.length, 5);
  assert.deepEqual(receipts.map(r => r.suite).sort(), ['box-dry-run','p1-cli','server','site','unit']);
  for (const r of receipts) {
    assert.equal(r.resolved_sha, f.sha); assert.equal(r.requested_sha, f.sha);
    assert.equal(r.controller_sha, f.cfg.controller_sha);
    assert.equal(r.exit_code, r.suite === 'p1-cli' ? 9 : 0);
    assert.equal(r.timed_out, false); assert.deepEqual(r.cleanup_errors, []);
    assert.ok(r.queued_at <= r.started_at && r.started_at <= r.ended_at);
    assert.match(r.artifacts['suite.log'], /^[a-f0-9]{64}$/);
    const runDir = join(f.state, 'runs', r.run_id);
    assert.equal(r.artifacts['suite.log'], createHash('sha256').update(readFileSync(join(runDir,'suite.log'))).digest('hex'));
    assert.match(readFileSync(join(runDir,'suite.log'),'utf8'), /first source/);
    assert.equal(existsSync(join(runDir,'scratch')), false);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))), {unowned: {label:'some-other-run'}});
});

test('concurrent invocations serialize actual worker lifetimes through the shared queue', async () => {
  const f = fixture({sleep: 0.3});
  const results = await Promise.all([start(f), start(f)]);
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const events = readFileSync(join(f.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(e => e.name.endsWith('-worker'));
  assert.deepEqual(events.map(e => e.action), ['start','finish','remove','start','finish','remove']);
  const receipts = f.receipts().sort((a,b) => a.started_at.localeCompare(b.started_at));
  assert.ok(receipts[1].started_at >= receipts[0].ended_at);
});

test('timeout writes failure receipt and removes owned services without removing an unrelated container', async () => {
  const f = fixture({sleep: 10}); f.cfg.timeout_seconds = 1;
  writeFileSync(f.config,JSON.stringify(f.cfg));
  const r = await start(f); assert.equal(r.status,124,r.stderr);
  const [receipt] = f.receipts(); assert.equal(receipt.timed_out,true); assert.equal(receipt.exit_code,124);
  assert.deepEqual(receipt.cleanup_errors,[]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))), {unowned:{label:'some-other-run'}});
});

test('cleanup refuses an exact-name container whose ownership label changed', async () => {
  const f = fixture({tamper:true}); const r = await start(f); assert.notEqual(r.status,0);
  const [receipt] = f.receipts(); assert.match(receipt.cleanup_errors.join(' '),/ownership mismatch/);
  const containers = JSON.parse(readFileSync(join(f.root,'containers.json')));
  assert.equal(containers[receipt.run_id+'-docker'].label,'unowned');
  assert.equal(existsSync(join(f.state,'runs',receipt.run_id,'scratch')),true);
});

test('main resolves to one exact commit across all suites', async () => {
  const f = fixture({sleep:0.3});
  const running = start(f, f.args('all',['--ref','main']));
  let entered = false;
  for (let attempt=0; attempt<200; attempt++) {
    const events=join(f.root,'events.jsonl');
    if (existsSync(events) && readFileSync(events,'utf8').includes('-worker')) { entered=true; break; }
    await delay(10);
  }
  assert.equal(entered,true,'first suite reached the external worker');
  writeFileSync(join(f.source,'identity'),'main advanced during queued all invocation');
  good('git',['-C',f.source,'commit','-qam','advance main during run']);
  const r = await running; assert.equal(r.status,0,r.stderr);
  for (const receipt of f.receipts()) { assert.equal(receipt.requested_sha,'main'); assert.equal(receipt.resolved_sha,f.sha); }
});

test('source accepts only anonymous public HTTPS and ignores inherited Git configuration', async () => {
  const f = fixture();
  f.env.GIT_CONFIG_GLOBAL = '/must-not-read-pe-config';
  f.env.GIT_CONFIG_SYSTEM = '/must-not-read-pe-system';
  f.env.GIT_CONFIG_COUNT = '1';
  f.env.GIT_CONFIG_KEY_0 = 'url.ssh://private/.insteadOf';
  f.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
  const ok = await start(f); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(join(f.root,'fetches.jsonl'),'utf8').trim().split('\n').length, 2);
  for (const url of ['git@github.com:yulanventures/commonswarm.git', 'https://github.com/other/repo.git']) {
    f.cfg.source_url = url; writeFileSync(f.config, JSON.stringify(f.cfg));
    const denied = await start(f); assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /public CommonSwarm HTTPS URL/);
  }
});

test('PE starting mid-suite removes only owned services, records pending deferral, then retries the same SHA quietly', async () => {
  const f = fixture({sleep: 2});
  const busyPath = join(f.root,'pe-active');
  writeFileSync(join(f.root,'bin','pgrep'), `#!/bin/sh\n[ "$4" = systemd ] && exit 0\ntest -e '${busyPath}'\n`);
  const running = start(f);
  let workerStarted = false;
  for (let n=0; n<400; n++) {
    const events = join(f.root,'events.jsonl');
    if (existsSync(events) && readFileSync(events,'utf8').includes('-worker')) {workerStarted=true; break;}
    await delay(10);
  }
  assert.equal(workerStarted,true,'PE starts only after the CI worker is active');
  writeFileSync(busyPath,'active');
  // Advance main while deferred: the retry must retain the original snapshot.
  writeFileSync(join(f.source,'identity'),'later source during PE contention');
  good('git',['-C',f.source,'commit','-qam','advance during PE work']);
  let deferred;
  for (let n=0; n<400; n++) {
    const runs = join(f.state,'runs');
    for (const name of readdirSync(runs)) {
      const path = join(runs,name,'receipt.json');
      if (existsSync(path)) {
        const receipt = JSON.parse(readFileSync(path));
        if (receipt.state === 'deferred') deferred = receipt;
      }
    }
    if (deferred) break;
    await delay(10);
  }
  assert.ok(deferred,'withdrawal persists an unfinished receipt before PE becomes quiet');
  assert.equal(deferred.pending,true); assert.equal(deferred.exit_code,75);
  assert.deepEqual(deferred.cleanup_errors,[]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
  // The simulated PE job ends itself; the controller never cancels it.
  writeFileSync(join(f.root,'bin','pgrep'),'#!/bin/sh\n[ "$4" = systemd ] && exit 0\nexit 1\n');
  const result = await running; assert.equal(result.status,0,result.stderr);
  const receipts = f.receipts().sort((a,b)=>a.attempt-b.attempt);
  assert.equal(receipts.length,2);
  assert.deepEqual(receipts.map(r=>r.state),['deferred','completed']);
  assert.equal(receipts[1].pending,false); assert.equal(receipts[1].exit_code,0);
  assert.deepEqual(receipts[1].prior_attempts,[deferred.run_id]);
  for (const r of receipts) assert.equal(r.resolved_sha,f.sha);
  assert.equal(readFileSync(join(f.root,'fetches.jsonl'),'utf8').trim().split('\n').length,2);
  const events = readFileSync(join(f.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const firstWorker = events.find(e=>e.action==='start' && e.name.endsWith('-worker'));
  assert.ok(events.some(e=>e.action==='remove' && e.name===firstWorker.name));
  assert.ok(!events.some(e=>e.action==='finish' && e.name===firstWorker.name));
});

test('PE quiet waiting consumes the suite budget and fails rather than passing deferred work', async () => {
  const f = fixture(); f.cfg.timeout_seconds=1;
  writeFileSync(f.config,JSON.stringify(f.cfg));
  writeFileSync(join(f.root,'bin','pgrep'),'#!/bin/sh\nexit 0\n');
  const result = await start(f); assert.equal(result.status,124,result.stderr);
  const [receipt] = f.receipts();
  assert.equal(receipt.timed_out,true); assert.equal(receipt.state,'failed');
  assert.equal(receipt.pending,false); assert.equal(receipt.exit_code,124);
  assert.ok(!existsSync(join(f.root,'events.jsonl')) || !readFileSync(join(f.root,'events.jsonl'),'utf8').includes('-worker'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
});

test('retention deletes only expired completed owned runs and rejects root/home/escape/symlink scratch paths', () => {
  const f = fixture(); mkdirSync(join(f.state,'runs'),{recursive:true});
  const create = (id, ended) => {
    const dir=join(f.state,'runs','csci-'+id.repeat(32)); mkdirSync(join(dir,'scratch'),{recursive:true});
    writeFileSync(join(dir,'receipt.json'),JSON.stringify({run_id:'csci-'+id.repeat(32),ended_at:ended,cleanup_errors:[]}));
    return dir;
  };
  const old = create('a','2000-01-01T00:00:00+00:00');
  const fresh = create('b',new Date().toISOString());
  const outsider=join(f.root,'outside'); mkdirSync(outsider); writeFileSync(join(outsider,'keep'),'safe');
  const link=join(f.state,'runs','csci-'+'c'.repeat(32)); symlinkSync(outsider,link);
  const invoke = target => run('python3',[join(controller,'retain.py'),'--root',f.state,'--scratch',target]);
  assert.equal(invoke(join(fresh,'scratch')).status,0);
  for (const target of ['/',process.env.HOME,outsider,join(link,'scratch'),fresh]) assert.notEqual(invoke(target).status,0,target);
  good('python3',[join(controller,'retain.py'),'--root',f.state]);
  assert.equal(existsSync(old),false); assert.equal(existsSync(fresh),true); assert.equal(readFileSync(join(outsider,'keep'),'utf8'),'safe');
});

// These new cases exercise executable boundaries absent from the original
// lifecycle tests: transport history, admission integrity, stop during teardown.
test('missing origin/main fails at the worker git consumer with a successful history control', async () => {
  const positive=fixture(); const ok=await start(positive); assert.equal(ok.status,0,ok.stderr);
  const negative=fixture({dropMain:true}); const bad=await start(negative); assert.notEqual(bad.status,0);
  const [receipt]=negative.receipts();
  assert.match(readFileSync(join(negative.state,'runs',receipt.run_id,'suite.log'),'utf8'),/origin\/main/);
});

test('installed script tampering and public state refuse before fetch or Docker work', async () => {
  const positive=fixture(); assert.equal((await start(positive)).status,0);
  for (const kind of ['script','state']) {
    const f=fixture();
    if (kind==='script') writeFileSync(join(f.cfg.controller,'suite.sh'),'tampered');
    else {
      mkdirSync(f.state,{mode:0o755});
      chmodSync(f.state,0o755);
      assert.equal(statSync(f.state).mode & 0o777,0o755);
    }
    const r=await start(f); assert.notEqual(r.status,0);
    assert.match(r.stderr,kind==='script' ? /checksum mismatch/ : /state must be private/);
    assert.equal(existsSync(join(f.root,'fetches.jsonl')),false);
    assert.equal(existsSync(join(f.root,'events.jsonl')),false);
  }
});

test('local source rewrite config is replaced before the next anonymous fetch', async () => {
  const f=fixture(); assert.equal((await start(f)).status,0);
  good('git',['--git-dir='+join(f.state,'source.git'),'config','url.ssh://foreign/.insteadOf','https://github.com/']);
  const r=await start(f); assert.equal(r.status,0,r.stderr);
  assert.equal(run('git',['--git-dir='+join(f.state,'source.git'),'config','--get-regexp','^url\\.']).status,1);
});

test('signal during owned cleanup completes teardown and prevents every following suite', async () => {
  const f=fixture({signalCleanup:true}); const r=await start(f,f.args('all'));
  assert.equal(r.status,130,r.stderr);
  const receipts=f.receipts(); assert.equal(receipts.length,1);
  assert.equal(receipts[0].exit_code,130); assert.deepEqual(receipts[0].cleanup_errors,[]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
});

test('unobservable root process refuses before any source or Docker operation', async () => {
  const f=fixture(); writeFileSync(join(f.root,'bin','pgrep'),'#!/bin/sh\nexit 1\n');
  const r=await start(f); assert.notEqual(r.status,0); assert.match(r.stderr,/visibility unproven/);
  assert.equal(existsSync(join(f.root,'fetches.jsonl')),false);
});


test('signal while queued exits without starting a second worker', async () => {
  const f=fixture({sleep:1});
  const first=start(f);
  for (let n=0;n<400;n++) {
    const path=join(f.root,'events.jsonl');
    if (existsSync(path) && readFileSync(path,'utf8').includes('-worker')) break;
    await delay(10);
  }
  const second=start(f); await delay(300); second.child.kill('SIGTERM');
  const cancelled=await second; assert.equal(cancelled.status,130,cancelled.stderr);
  assert.equal((await first).status,0);
  assert.equal(f.receipts().length,1);
});

test('signal during scratch retention prevents following suites', async () => {
  const f=fixture(); const path=join(f.cfg.controller,'retain.py');
  writeFileSync(path,"import os,signal\nos.kill(os.getppid(),signal.SIGTERM)\n"+readFileSync(path,'utf8'));
  f.cfg.controller_checksums['retain.py']=createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(f.config,JSON.stringify(f.cfg));
  const r=await start(f,f.args('all')); assert.equal(r.status,130,r.stderr);
  assert.equal(f.receipts().length,1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
});

// A killed inspect used to disappear into a successful Docker info probe.
test('interrupted inspect records cleanup failure, retains scratch and stops later suites', async () => {
  const f=fixture({killInspect:true}); const r=await start(f,f.args('all'));
  assert.equal(r.status,130,r.stderr);
  const receipts=f.receipts(); assert.equal(receipts.length,1);
  assert.equal(receipts[0].exit_code,130);
  assert.ok(receipts[0].cleanup_errors.some(e=>/cleanup inspect interrupted:.*rc=-15/.test(e)));
  assert.equal(existsSync(join(f.state,'runs',receipts[0].run_id,'scratch')),true);
  const store=JSON.parse(readFileSync(join(f.root,'containers.json')));
  assert.deepEqual(Object.keys(store).sort(),[receipts[0].run_id+'-worker','unowned'].sort());
});

// Admission failure must stop the worker and still use ownership-checked cleanup.
test('namespace policy failure prevents worker startup and cleans owned runtime', async () => {
  const positive=fixture(); assert.equal((await start(positive)).status,0);
  const negative=fixture({policyFail:true}); const r=await start(negative);
  assert.equal(r.status,42,r.stderr);
  const [receipt]=negative.receipts(); assert.deepEqual(receipt.cleanup_errors,[]);
  const events=readFileSync(join(negative.root,'events.jsonl'),'utf8');
  assert.equal(events.includes('-worker'),false);
  assert.deepEqual(JSON.parse(readFileSync(join(negative.root,'containers.json'))),{unowned:{label:'some-other-run'}});
  assert.equal(existsSync(join(negative.state,'runs',receipt.run_id,'scratch')),false);
});

// Authoring gate: these cases own the GitHub wire contract and the host final-
// attempt lifecycle. Existing controls never contacted a status API. Credible
// regressions: requested/merge SHA attribution, premature deferred success,
// token exposure and lost CI failures when GitHub is unavailable. Only transport
// is redirected in the disposable installed copy; production gains no test flag.
async function statusAPI(t, response = 201) {
  const requests = [];
  const server = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body += chunk;
    requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,body:JSON.parse(body)});
    res.writeHead(response, response === 302 ? {Location:'http://127.0.0.1:1/never-forward-credentials'} : {}); res.end('synthetic-status-only-token must never be logged from an error response');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {requests,port:server.address().port};
}
function publication(f,r) {
  return JSON.parse(readFileSync(join(f.state,'statuses',r.run_id+'.json')));
}
function assertNoToken(f,result) {
  assert.ok(!(result.stdout+result.stderr).includes('synthetic-status-only-token'));
  for (const receipt of f.receipts()) {
    const runDir=join(f.state,'runs',receipt.run_id);
    for (const name of readdirSync(runDir)) {
      if (statSync(join(runDir,name)).isFile()) assert.ok(!readFileSync(join(runDir,name),'utf8').includes('synthetic-status-only-token'),name);
    }
    assert.ok(!JSON.stringify(publication(f,receipt)).includes('synthetic-status-only-token'));
  }
}

test('final statuses use the tested snapshot for every suite, keep p1 failure and keep credentials host-only', async t => {
  const api=await statusAPI(t);
  const f=fixture({statusPort:api.port,exit:{'p1-cli':9}});
  writeFileSync(join(f.source,'identity'),'later main is not the requested proof');
  good('git',['-C',f.source,'commit','-qam','later main']);
  const result=await start(f,f.args('all'));
  assert.equal(result.status,9,result.stderr);
  assert.equal(api.requests.length,5);
  for (const req of api.requests) {
    assert.equal(req.method,'POST');
    assert.equal(req.path,'/repos/yulanventures/commonswarm/statuses/'+f.sha);
    assert.equal(req.authorization,'Bearer synthetic-status-only-token');
    assert.equal(req.body.state,req.body.context==='hetzner/p1-cli' ? 'failure' : 'success');
    assert.deepEqual(Object.keys(req.body).sort(),['context','description','state']);
  }
  assert.deepEqual(api.requests.map(r=>r.body.context).sort(),['hetzner/box-dry-run','hetzner/p1-cli','hetzner/server','hetzner/site','hetzner/unit']);
  for (const r of f.receipts()) {
    assert.deepEqual(r.github_status,publication(f,r));
    assert.equal(r.github_status.state,'published');
  }
  assertNoToken(f,result);
});

test('GitHub HTTP failures are durable, sanitized, and preserve both successful and failed CI exits', async t => {
  const api=await statusAPI(t,403);
  for (const exit of [0,7]) {
    const f=fixture({statusPort:api.port,exit:{unit:exit}});
    const result=await start(f);
    assert.equal(result.status,exit,result.stderr);
    const [receipt]=f.receipts();
    assert.equal(receipt.exit_code,exit);
    assert.equal(publication(f,receipt).state,'failed');
    assert.equal(publication(f,receipt).error,'github_http_403');
    assert.match(result.stdout,/"github_status": "failed"/);
    assertNoToken(f,result);
  }
  assert.equal(api.requests.length,2);
});

test('nightly main statuses retain the initial resolved SHA when main advances during the invocation', async t => {
  const api=await statusAPI(t); const f=fixture({statusPort:api.port,sleep:0.15});
  const running=start(f,f.args('all',['--ref','main']));
  for (let n=0;n<400;n++) {
    const path=join(f.root,'events.jsonl');
    if (existsSync(path) && readFileSync(path,'utf8').includes('-worker')) break;
    await delay(10);
  }
  writeFileSync(join(f.source,'identity'),'next main snapshot');
  good('git',['-C',f.source,'commit','-qam','advance main']);
  const result=await running; assert.equal(result.status,0,result.stderr);
  assert.equal(api.requests.length,5);
  for (const req of api.requests) assert.equal(req.path,'/repos/yulanventures/commonswarm/statuses/'+f.sha);
});

test('deferred attempts publish no status; quiet retry publishes exactly one final result', async t => {
  const api=await statusAPI(t); const f=fixture({statusPort:api.port,sleep:0.05});
  // A busy first probe followed by a quiet retry drives the real deferral path.
  const marker=join(f.root,'busy-once');
  writeFileSync(join(f.root,'bin','pgrep'),`#!/bin/sh\n[ "$4" = systemd ] && exit 0\nif test ! -e '${marker}'; then touch '${marker}'; exit 0; fi\nexit 1\n`);
  const result=await start(f); assert.equal(result.status,0,result.stderr);
  const receipts=f.receipts().sort((a,b)=>a.attempt-b.attempt);
  assert.deepEqual(receipts.map(r=>r.state),['deferred','completed']);
  assert.equal(api.requests.length,1);
  assert.equal(api.requests[0].body.description,receipts[1].run_id+' exit 0');
  assert.equal(existsSync(join(f.state,'statuses',receipts[0].run_id+'.json')),false);
});

test('quiet-wait timeout publishes a final error, not an unfinished or passing status', async t => {
  const api=await statusAPI(t); const f=fixture({statusPort:api.port});
  f.cfg.timeout_seconds=1; writeFileSync(f.config,JSON.stringify(f.cfg));
  writeFileSync(join(f.root,'bin','pgrep'),'#!/bin/sh\nexit 0\n');
  const result=await start(f); assert.equal(result.status,124,result.stderr);
  assert.equal(api.requests.length,1); assert.equal(api.requests[0].body.state,'error');
  const [r]=f.receipts(); assert.equal(r.state,'failed'); assert.equal(publication(f,r).state,'published');
});

test('publisher refuses unsafe credential placement and permissions before HTTP with a successful control', async t => {
  const api=await statusAPI(t); const positive=fixture({statusPort:api.port});
  assert.equal((await start(positive)).status,0);
  assert.equal(api.requests.length,1);
  for (const kind of ['permissions','mounted']) {
    const f=fixture({statusPort:api.port});
    if (kind==='permissions') chmodSync(f.cfg.github_status_token_file,0o644);
    else {
      f.cfg.github_status_token_file=join(f.cfg.controller,'token');
      writeFileSync(f.cfg.github_status_token_file,'synthetic-status-only-token',{mode:0o600});
      writeFileSync(f.config,JSON.stringify(f.cfg));
    }
    const result=await start(f); assert.equal(result.status,0,result.stderr);
    const [r]=f.receipts(); assert.equal(publication(f,r).error,kind==='permissions' ? 'unsafe_token_permissions' : 'token_in_container_tree');
  }
  assert.equal(api.requests.length,1);
});


test('audited receipt backfills use resolved SHA, refuse unfinished results, and never follow redirects', async t => {
  const okAPI=await statusAPI(t); const redirectAPI=await statusAPI(t,302);
  const f=fixture({statusPort:okAPI.port});
  const receipt={resolved_sha:'1f5d731a986b56642fb527860af69866959d4465',requested_sha:'main',
    suite:'p1-cli',run_id:'csci-e6717ca3385d4f27a47cc52771525922',
    state:'completed',pending:false,exit_code:0,timed_out:false,cleanup_errors:[]};
  const file=join(f.root,'audited-receipt.json');
  const backfill=async value => {
    writeFileSync(file,JSON.stringify(value));
    return start(f,['-I',join(f.cfg.controller,'publish-status.py'),'--config',f.config,'--receipt',file],'python3');
  };
  assert.equal((await backfill(receipt)).status,0);
  assert.equal(okAPI.requests[0].path,'/repos/yulanventures/commonswarm/statuses/1f5d731a986b56642fb527860af69866959d4465');
  for (const value of [
    {...receipt,state:'deferred',pending:true,exit_code:75},
    {...receipt,state:'failed',pending:false},
    {...receipt,resolved_sha:'main'},
  ]) {
    const result=await backfill(value); assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stdout).state,'failed');
  }
  assert.equal(okAPI.requests.length,1);
  // Use a separate disposable installed copy to direct the real HTTP client at
  // a redirecting server. No follow-up request (or token forwarding) is allowed.
  const redirect=fixture({statusPort:redirectAPI.port});
  writeFileSync(file,JSON.stringify(receipt));
  const result=await start(redirect,['-I',join(redirect.cfg.controller,'publish-status.py'),'--config',redirect.config,'--receipt',file],'python3');
  assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stdout).error,'github_http_302');
  assert.equal(redirectAPI.requests.length,1);
});


test('owned cleanup failure publishes error and retains the failing suite result and scratch', async t => {
  const api=await statusAPI(t); const f=fixture({statusPort:api.port,tamper:true});
  const result=await start(f); assert.equal(result.status,1,result.stderr);
  const [receipt]=f.receipts();
  assert.equal(receipt.state,'failed'); assert.ok(receipt.cleanup_errors.length > 0);
  assert.equal(existsSync(join(f.state,'runs',receipt.run_id,'scratch')),true);
  assert.equal(api.requests.length,1); assert.equal(api.requests[0].body.state,'error');
  assert.equal(publication(f,receipt).state,'published');
  assertNoToken(f,result);
});
