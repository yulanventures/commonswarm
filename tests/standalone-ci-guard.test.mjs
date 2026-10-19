// Independent contracts: real guard admission in disposable Linux containers;
// controller lifecycle with real git/flock/clock and a Docker boundary fixture.
// These catch overlapping runs, wrong source, lost failures, unsafe cleanup and
// broad deletion. No existing test owns the new standalone entry point.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, renameSync, rmdirSync, symlinkSync, existsSync, statSync } from 'node:fs';
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
        if 'dst=/receipt' in args[i+1]: assert mount.name=='worker-artifacts', 'parent receipt mounted'
        assert not (mount.parent.name=='runs' and mount.name.startswith('csci-')), 'run parent exposed'
        token=root/'auth'/'token'
        assert mount != token and mount not in token.parents, 'credential mounted in test container'
assert os.environ['DOCKER_CONTEXT']=='default'
assert os.environ['DOCKER_HOST']=='unix:///var/run/docker.sock'
def event(action,name):
    with (root/'events.jsonl').open('a') as f: f.write(json.dumps(dict(action=action,name=name,at=time.monotonic()))+'\\n')
if args[0]=='run':
    name=args[args.index('--name')+1]
    label=args[args.index('--label')+1].split('=',1)[1]
    if name.endswith('-worker') and ${control.workerLaunch ?? 0}: sys.exit(${control.workerLaunch ?? 0})
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
  // Model process ownership at the subprocess boundary; never start a fake
  // Runner.Worker under the real host's gha account (operator watches see it).
  // Own status work is always present, so an unscoped probe is genuinely busy.
  writeFileSync(join(bin, 'pgrep'), `#!/usr/bin/env python3
import pathlib,sys
args=sys.argv[1:]
processes=[(0,'systemd'),(1003,'Runner.Worker')]
if pathlib.Path(${JSON.stringify(join(root,'pe-active'))}).exists(): processes.append((1001,'Runner.Worker'))
uid=args[args.index('-u')+1] if '-u' in args else None
uid=0 if uid=='root' else int(uid) if uid is not None else None
name=args[args.index('-x')+1]
sys.exit(0 if any(pname==name and (uid is None or owner==uid) for owner,pname in processes) else 1)
`); chmodSync(join(bin, 'pgrep'), 0o755);
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
    dind_image: 'fixture@sha256:' + '2'.repeat(64), timeout_seconds: 10, pe_runner_uid: 1001, status_reader_uid: process.platform === 'linux' ? 65534 : null};
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify(cfg), {mode:0o600});
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
    if (process.platform==='linux') assert.deepEqual(r.github_status,{state:'ready',version:1});
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

// Test-audit: the controller must distinguish the two runner roles by UID.
// The old generic probe blocks on own status work; a wrong/nonexistent PE UID
// misses actual PE activity. Existing fixtures had no process ownership. This
// paired lifecycle proof owns both controls, with no production test seam.
test('own status worker permits CI; PE starting mid-suite defers owned work then retries the same SHA quietly', async () => {
  const f = fixture({sleep: 2});
  const busyPath = join(f.root,'pe-active');
  const running = start(f);
  let workerStarted = false;
  for (let n=0; n<400; n++) {
    const events = join(f.root,'events.jsonl');
    if (existsSync(events) && readFileSync(events,'utf8').includes('-worker')) {workerStarted=true; break;}
    await delay(10);
  }
  assert.equal(workerStarted,true,'own status worker must permit CI before PE starts');
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
  assert.equal(deferred.github_status,undefined);
  assert.equal(deferred.pending,true); assert.equal(deferred.exit_code,75);
  assert.deepEqual(deferred.cleanup_errors,[]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
  // The simulated PE job ends itself; the controller never cancels it.
  renameSync(busyPath,join(f.root,'pe-finished'));
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
  writeFileSync(join(f.root,'pe-active'),'active');
  const result = await start(f); assert.equal(result.status,124,result.stderr);
  const [receipt] = f.receipts();
  assert.equal(receipt.timed_out,true); assert.equal(receipt.state,'failed');
  assert.equal(receipt.pending,false); assert.equal(receipt.exit_code,124);
  assert.ok(!existsSync(join(f.root,'events.jsonl')) || !readFileSync(join(f.root,'events.jsonl'),'utf8').includes('-worker'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'containers.json'))),{unowned:{label:'some-other-run'}});
});

// Test-audit: invalid identity config must refuse before fetch/worker startup.
// Python bools pass isinstance(int), and aliasing either service/reader would
// defeat role separation. Lifecycle coverage supplies only a valid identity;
// this admission table adds the distinct config failure boundary, without hooks.
test('PE runner UID requires a positive integer distinct from service and reader before work', async () => {
  const f=fixture();
  const reader=f.cfg.status_reader_uid;
  for (const uid of [undefined,null,true,false,0,-1,1.5,'1001',process.getuid()]) {
    f.cfg.pe_runner_uid=uid; writeFileSync(f.config,JSON.stringify(f.cfg));
    const r=await start(f);
    assert.notEqual(r.status,0); assert.match(r.stderr,/invalid PE runner UID/);
    assert.equal(existsSync(join(f.root,'fetches.jsonl')),false);
    assert.equal(existsSync(join(f.root,'events.jsonl')),false);
  }
  f.cfg.pe_runner_uid=1001; f.cfg.status_reader_uid=1001;
  writeFileSync(f.config,JSON.stringify(f.cfg));
  const overlap=await start(f);
  assert.notEqual(overlap.status,0); assert.match(overlap.stderr,/invalid PE runner UID/);
  assert.equal(existsSync(join(f.root,'fetches.jsonl')),false);
  assert.equal(existsSync(join(f.root,'events.jsonl')),false);
  f.cfg.status_reader_uid=reader; writeFileSync(f.config,JSON.stringify(f.cfg));
  const positive=await start(f); assert.equal(positive.status,0,positive.stderr);
  assert.equal(f.receipts().length,1);
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
    assert.match(r.stderr,kind==='script' ? /checksum mismatch/ : /state owner\/access ACL mismatch/);
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

// Test-audit four questions: controller owns final readiness, artifact isolation,
// atomic replacement and effective ACLs. Regressions are parent mounts, broad ACLs,
// lost markers or readiness errors aborting later suites/retention. API behavior
// moved to publisher owner; lifecycle above cannot prove API history/readback.
// Only external Docker/process transport is simulated; no production test flag.
// These are the former publication-persistence cases at their new ready owner.
test('readiness failures preserve CI exits, later suites and final retention', async () => {
  for (const fault of ['none','acl','rename']) for (const exit of [0,7]) {
    const f=fixture({exit:{'box-dry-run':exit}});
    f.env.GITHUB_TOKEN='synthetic-status-only-token';
    if (fault==='acl') {
      writeFileSync(join(f.root,'bin','setfacl'),'#!/bin/sh\nexit 1\n');
      chmodSync(join(f.root,'bin','setfacl'),0o755);
    }
    if (fault==='rename') {
      // Fail only the ready replacement after baseline/scratch writes succeeded.
      const script=join(f.cfg.controller,'run.sh');
      writeFileSync(script,readFileSync(script,'utf8').replace("if ready:\n            if reader is None:","if ready:\n            (run / 'receipt.json').unlink()\n            (run / 'receipt.json').mkdir()\n            if reader is None:"));
      f.cfg.controller_checksums['run.sh']=createHash('sha256').update(readFileSync(script)).digest('hex');
      writeFileSync(f.config,JSON.stringify(f.cfg));
    }
    const oldID='csci-'+'f'.repeat(32), old=join(f.state,'runs',oldID);
    mkdirSync(old,{recursive:true,mode:0o700});
    writeFileSync(join(old,'receipt.json'),JSON.stringify({run_id:oldID,ended_at:'2000-01-01T00:00:00+00:00',cleanup_errors:[]}));
    const result=await start(f,f.args('all'));
    assert.equal(result.status,exit,result.stderr);
    assert.equal(existsSync(old),false);
    const summaries=result.stdout.trim().split('\n').map(JSON.parse).filter(r=>r.github_status);
    assert.equal(summaries.length,5);
    if (fault!=='none') for (const summary of summaries) {
      assert.equal(summary.github_status,'failed');
      assert.ok(summary.persistence_errors.includes('readiness_unavailable'));
      if (fault==='rename') assert.ok(summary.persistence_errors.includes('receipt_record_unavailable'));
    }
    if (fault!=='rename') for (const r of f.receipts()) assert.equal(r.exit_code,r.suite==='box-dry-run' ? exit : 0);
    assert.equal(existsSync(join(f.state,'statuses')),false,'controller never publishes or keeps publication records');
    assert.equal(result.stderr.includes('Traceback'),false);
    assert.equal((result.stdout+result.stderr).includes('synthetic-status-only-token'),false);
  }
});

test('actual Linux named-reader ACL denies logs/write/private state and survives replacement and new runs', {skip:process.platform!=='linux' || process.getuid()!==0 ? 'Root Linux ACL gate required' : false}, async () => {
  const f=fixture(); chmodSync(f.root,0o755);
  const probe=async () => {
    const receipts=f.receipts();
    for (const receipt of receipts) {
      const dir=join(f.state,'runs',receipt.run_id), file=join(dir,'receipt.json');
      const script=`import os,json,sys\np=sys.argv[1]\nassert json.load(open(p))['github_status']=={'state':'ready','version':1}\ndef denied(fn):\n try: fn()\n except PermissionError: return\n raise RuntimeError('reader access escaped')\ndenied(lambda:open(p,'ab'))\ndenied(lambda:os.listdir(os.path.dirname(p)))\nfor p in sys.argv[2:]: denied(lambda p=p:open(p,'rb'))\n`;
      const r=run('setpriv',['--reuid=65534','--regid=65534','--clear-groups','python3','-c',script,file,join(dir,'suite.log'),join(f.state,'source.git','config'),join(f.state,'queue.lock'),f.config]);
      assert.equal(r.status,0,r.stderr);
    }
  };
  const retention=join(f.cfg.controller,'retain.py');
  writeFileSync(retention,readFileSync(retention,'utf8').replace('import argparse','import argparse\nimport time\ntime.sleep(0.4)'));
  f.cfg.controller_checksums['retain.py']=createHash('sha256').update(readFileSync(retention)).digest('hex');
  writeFileSync(f.config,JSON.stringify(f.cfg));
  const running=start(f); let before;
  for(let n=0;n<400;n++) {
    const runs=join(f.state,'runs');
    if(existsSync(runs)) for(const id of readdirSync(runs)) {
      const file=join(runs,id,'receipt.json');
      if(existsSync(file) && !JSON.parse(readFileSync(file)).github_status) before={file,inode:statSync(file).ino};
    }
    if(before) break;
    await delay(10);
  }
  assert.ok(before,'baseline receipt observed before final readiness');
  assert.equal((await running).status,0);
  assert.notEqual(statSync(before.file).ino,before.inode,'ready marker replaces the baseline inode');
  await probe();
  // A second invocation validates ACL-bearing state and creates a fresh inode.
  assert.equal((await start(f)).status,0); await probe();
  assert.equal(f.receipts().length,2);
  const entries=good('getfacl',['-cpn',f.state]);
  good('setfacl',['-m','u:65533:--x',f.state]);
  const denied=await start(f); assert.notEqual(denied.status,0); assert.match(denied.stderr,/ACL mismatch/);
  assert.ok(entries.includes('user:65534:--x'));
});
