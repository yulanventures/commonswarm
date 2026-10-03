/** Execute complete marked W4/W5 blocks; remap only filesystem boundaries and external observations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

const plan = readFileSync(resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'), 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const block = (step: string) => {
  const found = blocks.filter(source => source.startsWith(`# step: ${step}\n`));
  assert.equal(found.length, 1, `one complete ${step} block`);
  return found[0]!;
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = realpathSync(tmpdir());
const scratch = realpathSync(mkdtempSync(join(temporaryRoot, 'admin-w45-')));
const realHome = realpathSync(homedir());
assert.equal(dirname(scratch), temporaryRoot);
assert.ok(scratch !== realHome && !scratch.startsWith(realHome + sep));
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
after(() => {
  assert.equal(dirname(scratch), temporaryRoot);
  assert.match(scratch.slice(temporaryRoot.length + 1), /^admin-w45-[A-Za-z0-9]{6}$/);
  const cleanup = spawnSync('rm', ['-r', '--', scratch], { encoding: 'utf8' });
  assert.equal(cleanup.status, 0, `fixture cleanup refused ${scratch}: ${cleanup.stderr}`);
});

const sha = 'a'.repeat(40), baseline = 'b'.repeat(40), image = 'sha256:' + 'c'.repeat(64);
const client = { client_id: 'https://commonswarm.com/oauth/c1-smoke/client.json',
  redirect_uris: ['https://commonswarm.com/oauth/c1-smoke/callback'] };
// All commands record argv. PATH contains only these stubs, with no daemon fallback.
// Python executes the actual predicates, replacing only HTTP and command observations.
const dispatcher = String.raw`#!/usr/bin/python3
import hashlib,io,json,os,pathlib,shutil,socket,subprocess,sys,urllib.request
root=pathlib.Path(os.environ['W45_ROOT']); cfg=json.loads((root/'fixture.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'commands.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
def refuse(*a,**kw): raise RuntimeError('UNMODELLED '+name+' '+repr(args))
def owned(value):
    p=pathlib.Path(value)
    if not p.is_absolute() or not str(p).startswith(str(root)+'/'): refuse()
    return p
socket.socket.connect=refuse; socket.create_connection=refuse
if name=='python3':
    if args and args[0]=='-': source=sys.stdin.read(); sys.argv=['-']+args[1:]
    elif len(args)>=2 and args[0]=='-c': source=args[1]; sys.argv=['-c']+args[2:]
    else: refuse()
    def observe(request,timeout):
        if timeout!=15: refuse()
        url=request.full_url; method=request.get_method()
        with (root/'http.jsonl').open('a') as log:
            log.write(json.dumps({'url':url,'method':method,'headers':dict(request.header_items()),'data':request.data.decode() if request.data else None})+'\n')
        if url=='https://mcp.commonswarm.com/admin/gate':
            if method not in ('GET','HEAD') or request.get_header('Origin')!='https://commonswarm.com': refuse()
            body=json.dumps({'state':cfg.get('gate_state','closed')}).encode() if method=='GET' else b''
            headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}; status=200
            if method==cfg.get('bad_method','GET'):
                headers['Access-Control-Allow-Origin']=cfg.get('acao','*')
                headers['Cache-Control']=cfg.get('cache','no-store')
                status=cfg.get('gate_status',200)
                if cfg.get('head_body') and method=='HEAD': body=b'nonempty'
        elif url=='https://api.commonswarm.com/admin':
            if method!='POST' or request.get_header('Origin')!='https://commonswarm.com' or request.data!=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}': refuse()
            status=cfg.get('post_status',401); body=b'{"error":"unauthorized"}'; headers={}
        elif url==cfg['client']['client_id']:
            if method!='GET': refuse()
            status=200; body=json.dumps(cfg['client']).encode(); headers={'Content-Type':'application/json'}
        elif url==cfg['client']['redirect_uris'][0]:
            if method!='GET': refuse()
            status=200; body=b'<!doctype html>'; headers={'Content-Type':'text/html'}
        else: refuse()
        class Response(io.BytesIO): pass
        response=Response(body); response.status=status; response.headers=headers
        if url=='https://api.commonswarm.com/admin' and status>=400:
            # Exercise the real block's HTTPError handling, as urllib does on 401.
            raise urllib.error.HTTPError(url,status,'fixture',headers,response)
        return response
    def opener(*handlers):
        if len(handlers)!=1 or not isinstance(handlers[0],urllib.request.HTTPRedirectHandler): refuse()
        class Opener: open=staticmethod(observe)
        return Opener()
    urllib.request.urlopen=observe; urllib.request.build_opener=opener
    real_popen=subprocess.Popen
    def popen(argv,**kw):
        allowed=[['node','scripts/admin-smoke.mjs','--print-client-metadata'],['docker','inspect','commonswarm-edge-edge-runtime-1']]
        if argv not in allowed or kw.get('shell'): refuse()
        return real_popen(argv,**kw)
    subprocess.Popen=popen
    exec(compile(source,'<complete-plan-block>','exec'))
elif name=='node':
    if args!=['scripts/admin-smoke.mjs','--print-client-metadata']: refuse()
    print(json.dumps(cfg['client']))
elif name=='git':
    if args!=['merge-base','--is-ancestor',cfg['sha'],'origin/main']: refuse()
elif name=='mkdir':
    if len(args)!=1: refuse()
    owned(args[0]).mkdir()
elif name=='cp':
    if len(args)==3 and args[0]=='-a' and args[1].endswith('/.'):
        shutil.copytree(owned(args[1]),owned(args[2]),dirs_exist_ok=True)
    elif len(args)==2: shutil.copyfile(owned(args[0]),owned(args[1]))
    else: refuse()
elif name=='chmod':
    if args!=['-R','go-rwx',str(root/'stage')]: refuse()
    for p in [root/'stage']+list((root/'stage').rglob('*')): p.chmod(p.stat().st_mode & ~0o077)
elif name=='caddy':
    if args not in [['validate','--config',str(root/'stage/Caddyfile'),'--adapter','caddyfile'],['validate','--config',str(root/'etc/caddy/Caddyfile'),'--adapter','caddyfile']]: refuse()
    if not owned(args[2]).is_file(): refuse()
    if cfg.get('caddy_status',0): print('synthetic validation rejected')
    raise SystemExit(cfg.get('caddy_status',0))
elif name=='ai_deadline':
    if args: refuse()
elif name=='ai_run':
    if args not in [['ai-inputs'],['ai-gates'],['ai-timer-guard'],['ai-recycle-install']]: refuse()
elif name=='ai_db':
    if args==['-q','--command','BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;']: pass
    elif args==['-q','--file',str(root/'proof/measure.sql')]: owned(args[2]).read_text()
    else: refuse()
elif name=='ai_ro':
    if args==['-Atq','--command','SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;']: print('t')
    elif args==['-Atq','--command','SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND invalidated_at IS NULL AND measured_generation=release_generation;']: print('7')
    else: refuse()
elif name=='date':
    if args!=['-u','+%Y-%m-%dT%H:%M:%SZ']: refuse()
    print('2026-10-03T12:00:00Z')
elif name=='systemctl':
    if args==['stop','fixture-recycle.timer'] or args==['reload','caddy']: pass
    elif args==['show','-p','ActiveState','--value','fixture-recycle.service']: print('inactive')
    else: refuse()
elif name=='cmp':
    if len(args)!=3 or args[0]!='-s': refuse()
    raise SystemExit(0 if owned(args[1]).read_bytes()==owned(args[2]).read_bytes() else 1)
elif name=='ln':
    if len(args)!=3 or args[0]!='-s': refuse()
    owned(args[2]).symlink_to(owned(args[1]),target_is_directory=True)
elif name=='mv':
    if len(args)!=3 or args[0]!='-Tf': refuse()
    owned(args[1]).replace(owned(args[2]))
elif name=='docker':
    edge=str(root/'edge/releases'/cfg['sha']); compose=edge+'/deploy/edge-runtime'
    if args==['inspect','--format','{{.State.Health.Status}}','commonswarm-edge-edge-runtime-1']: print('healthy')
    elif args==['inspect','commonswarm-edge-edge-runtime-1']:
        print(json.dumps([{'Image':cfg['image'],'State':{'Health':{'Status':'healthy'}},'Config':{'Labels':{'com.docker.compose.project.working_dir':compose}},'HostConfig':{'NetworkMode':'commonswarm-net','Memory':2147483648},'Mounts':[{'Destination':dest,'Source':edge+'/'+rel,'RW':False} for dest,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]]}]))
    elif args==['compose','--project-name','commonswarm-edge','-f',compose+'/compose.yaml','-f',compose+'/compose.override.yaml','up','-d','--no-build','--pull','never','--force-recreate','edge-runtime']:
        if os.environ.get('COMMONSWARM_EDGE_NETWORK_MODE')!='commonswarm-net': refuse()
    else: refuse()
elif name=='timeout':
    expected='until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
    if args!=['90','/bin/bash','-c',expected]: refuse()
    raise SystemExit(subprocess.run(args[1:]).returncode)
elif name=='sha256sum':
    if args!=[str(root/'etc/caddy/Caddyfile')]: refuse()
    print(hashlib.sha256(owned(args[0]).read_bytes()).hexdigest()+'  '+args[0])
elif name=='awk':
    if args!=['{print $1}']: refuse()
    print(sys.stdin.read().split()[0])
elif name=='install':
    if len(args)!=8 or args[:6]!=['-o','root','-g','root','-m','0644']: refuse()
    if args[7] not in [str(root/'etc/caddy/sites/20-commonswarm-mcp.caddy'),str(root/'etc/caddy/sites/10-commonswarm-api.caddy')]: refuse()
    shutil.copyfile(owned(args[6]),owned(args[7])); owned(args[7]).chmod(0o644)
else: refuse()
`;

function fixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(scratch, 'case-'));
  const site = join(root, 'site'), bin = join(root, 'bin'), receipts = join(root, 'receipts');
  const stage = join(root, 'stage'), proof = join(root, 'proof'), newEdge = join(root, 'edge/releases', sha);
  const put = (path: string, value: unknown) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  for (const dir of [site, bin, stage, proof, newEdge]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  put('site/index.html', '<!doctype html>\n');
  const manifest = JSON.stringify([{ path: 'index.html', sha256: hash(readFileSync(join(site, 'index.html'))) }]);
  put('site/manifest.json', manifest);
  const goodClose = `CLOSED=yes\nOUTCOME=released\nPIN_RELEASED=yes\nMANIFEST_SHA256=${hash(manifest)}\n`;
  put('site/CLOSE.txt', goodClose);
  const data = { release_sha: sha, baseline_site_sha: baseline, baseline_edge_image: image, window: 'W5', window_id: 'Fix123',
    baseline_caddyfile_sha256: '', archive_sha256: '' };
  put('authorization.json', { approver: 'HezLead', release_sha: sha, task_ref: 'fixture-qa', browser: 'headless-bundled-chromium' });
  put('fixture.json', { sha, image, client, ...config });
  put('commands.jsonl', ''); put('http.jsonl', '');
  put('bin/_dispatch', dispatcher);
  chmodSync(join(bin, '_dispatch'), 0o700);
  for (const name of ['python3', 'node', 'ssh', 'psql', 'docker', 'curl', 'caddy', 'systemctl', 'sudo', 'git',
    'npm', 'npx', 'open', 'osascript', 'wget', 'op', 'mkdir', 'cp', 'chmod', 'ai_deadline', 'ai_run', 'ai_db',
    'ai_ro', 'date', 'cmp', 'ln', 'mv', 'timeout', 'sha256sum', 'awk', 'install']) symlinkSync('_dispatch', join(bin, name));
  // Synthetic active box baseline, as in the original diagnostic fixtures.
  // Repository templates are historical OAuth-only files, not this block's box input.
  for (const [file, bytes] of [
    ['mcp.caddy', 'mcp.commonswarm.com {\nimport mcp_oauth_active\nimport mcp_resource_active\nrequest>Authorization delete\nresp_headers>Authorization delete\n}\n'],
    ['api.caddy', 'api.commonswarm.com {\n\t@edge_functions path /functions/v1 /functions/v1/*\nrequest>Authorization delete\nresp_headers>Authorization delete\n}\n'],
  ] as const) {
    put('stage/' + file, bytes);
    put('etc/caddy/sites/' + (file === 'mcp.caddy' ? '20-commonswarm-mcp.caddy' : '10-commonswarm-api.caddy'), bytes);
  }
  const caddyfile = 'import /etc/caddy/sites/*.caddy\n';
  // The remapped root is also used in the fixture baseline config's import.
  const fixtureCaddyfile = caddyfile.replace('/etc/caddy', join(root, 'etc/caddy'));
  put('etc/caddy/Caddyfile', fixtureCaddyfile); data.baseline_caddyfile_sha256 = hash(fixtureCaddyfile);
  put('stage/edge.env', 'SWARM_MCP_PUBLIC_ENABLED=1\n'); put('box/.env', 'SWARM_MCP_PUBLIC_ENABLED=1\n');
  const edgeFile = `edge/releases/${sha}/src/reviewed.txt`; put(edgeFile, 'reviewed tracked bytes\n');
  const archive = join(root, `archive/admin-issuance-${sha}-${data.window_id}.tar`);
  mkdirSync(dirname(archive));
  const archived = spawnSync('/usr/bin/python3', ['-c',
    'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="src/reviewed.txt")', archive, join(root, edgeFile)], { encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr); data.archive_sha256 = hash(readFileSync(archive));
  for (const version of ['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005',
    '20260928000003','20261002000001','20261003000001','20261003000002','20261003000003','20261003000004','20261003000005'])
    put(`release/supabase/migrations/${version}_fixture.sql`, '-- reviewed migration fixture\n');
  put('inputs.json', data);
  const later = join(root, 'later.txt');
  function run(steps = ['ai-w5-closed'], env: Record<string, string> = {}, laterMarker = later) {
    let source = steps.map(block).join('\n');
    for (const [from, to] of [
      ['/Users/yulanbot/work/hm37-live-release', receipts], ['/etc/caddy', join(root, 'etc/caddy')],
      ['/home/commonswarm/edge', join(root, 'edge')], ['/home/commonswarm/.env', join(root, 'box/.env')],
      ['/tmp/admin-issuance-', join(root, 'archive/admin-issuance-')], ['/proof/measure.sql', join(proof, 'measure.sql')],
    ] as const) source = source.split(from).join(to);
    const result = spawnSync('/bin/bash', [], {
      input: 'set -euo pipefail\n' + source + `\nprintf 'later side effect\\n' >${quote(laterMarker)}\n`, encoding: 'utf8', timeout: 15_000,
      cwd: root, env: { ...process.env, PATH: bin, PYTHONDONTWRITEBYTECODE: '1', W45_ROOT: root,
        INPUTS_FILE: join(root, 'inputs.json'), SITE_EVIDENCE: site, SITE_RELEASE_SHA: sha, EXPECTED_SITE_SHA: baseline,
        SITE_QA_AUTHORIZATION_FILE: join(root, 'authorization.json'), WINDOW: 'W4', WINDOW_ID: data.window_id,
        SECRET_STAGE: stage, PROOF_DIR: proof, NEW_EDGE: newEdge, RELEASE_ROOT: join(root, 'release'), RELEASE_SHA: sha,
        EDGE_RECYCLE_TIMER: 'fixture-recycle.timer', EDGE_RECYCLE_SERVICE: 'fixture-recycle.service', ...env },
    });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.doesNotMatch(result.stdout + result.stderr, /UNMODELLED/);
    for (const file of ['caddy-validate.log', 'caddy-live-validate.log', 'edge-apply.log'])
      if (existsSync(join(stage, file))) assert.doesNotMatch(readFileSync(join(stage, file), 'utf8'), /UNMODELLED/);
    return { ...result, calls: lines('commands.jsonl'), requests: lines('http.jsonl') };
  }
  function lines(path: string): any[] { return readFileSync(join(root, path), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  return { root, site, stage, proof, goodClose, later, put, run,
    closedRoot: join(receipts, `${data.release_sha}-W5-${data.window_id}`) };
}
type Fixture = ReturnType<typeof fixture>;
type Result = ReturnType<Fixture['run']>;
function pass(f: Fixture, r: Result) {
  assert.equal(r.status, 0, r.stderr); assert.ok(existsSync(f.later), 'positive reaches later action');
}
function stopped(f: Fixture, r: Result, text: string) {
  assert.notEqual(r.status, 0, 'bad measurement must refuse');
  assert.ok(r.stderr.includes(text), `expected block-owned ${text}; observed ${JSON.stringify(r.stderr)}`);
  assert.ok(!existsSync(f.later), 'no later shell side effect');
}
function requestPairs(r: Result) { return r.requests.map(q => [q.method, q.url]); }
const gate = 'https://mcp.commonswarm.com/admin/gate';
const post = 'https://api.commonswarm.com/admin';
const probes = ['ai-w4-probes'];
const gateFailure = (method: string) => `FAIL ai-w4-probes: ${method} /admin/gate status/ACAO/cache/body-length expected 200/*/no-store/<=4096 got 200/non-wildcard-or-missing/no-store/${method === 'GET' ? 19 : 0}; Origin expected commonswarm-site got commonswarm-site; STOP`;

test('edge-caddy-route / canonical-api-admin-route: fails closed when canonical POST misses the verifier', () => {
  const good = fixture(); const r = good.run(['ai-w4-caddy-candidate', ...probes]); pass(good, r);
  // Caddy snippets are global: the MCP candidate defines the snippet imported by API.
  assert.match(readFileSync(join(good.stage, 'mcp.new.caddy'), 'utf8'), /rewrite \* \/functions\/v1\/admin\n/);
  assert.match(readFileSync(join(good.stage, 'api.new.caddy'), 'utf8'), /import admin_resource_active/);
  assert.deepEqual(requestPairs(r), [['GET', gate], ['HEAD', gate], ['POST', post]]);
  const bad = fixture({ post_status: 200 }); const refused = bad.run(['ai-w4-caddy-candidate', ...probes]);
  stopped(bad, refused, 'FAIL ai-w4-probes: POST canonical /admin status/body-length expected 401/<=4096 got 200/not-read-status-mismatch; STOP');
  assert.deepEqual(requestPairs(refused), [['GET', gate], ['HEAD', gate], ['POST', post]]);
  assert.doesNotMatch(refused.stdout, /canonical \/admin reaches verifier/);
});

test('edge-caddy-route / mcp-get-head-gate-cors: fails closed on a non-wildcard gate response', () => {
  const good = fixture(); const r = good.run(probes); pass(good, r);
  assert.deepEqual(requestPairs(r), [['GET', gate], ['HEAD', gate], ['POST', post]]);
  for (const method of ['GET', 'HEAD']) {
    const bad = fixture({ acao: 'https://wrong.example', bad_method: method }); const refused = bad.run(probes);
    stopped(bad, refused, gateFailure(method));
    assert.deepEqual(requestPairs(refused), method === 'GET' ? [['GET', gate]] : [['GET', gate], ['HEAD', gate]]);
    assert.doesNotMatch(refused.stdout, /PASS outside/);
  }
});

test('edge-caddy-route / caddy-validate-reload: fails closed before reload on candidate or live validation failure', () => {
  const good = fixture(); const r = good.run(['ai-w4-caddy-candidate', 'ai-w4-apply']); pass(good, r);
  assert.deepEqual(r.calls.filter(c => c[0] === 'systemctl' && c[1] === 'reload'), [['systemctl', 'reload', 'caddy']]);
  const validate = r.calls.findIndex(c => c[0] === 'caddy' && c[3] === join(good.root, 'etc/caddy/Caddyfile'));
  const reload = r.calls.findIndex(c => c[0] === 'systemctl' && c[1] === 'reload');
  assert.ok(validate >= 0 && reload > validate, 'live validation precedes reload');
  for (const step of ['ai-w4-caddy-candidate', 'ai-w4-apply']) {
    const bad = fixture();
    if (step === 'ai-w4-apply') {
      // Build the real candidates first; then fail only the live validation observation.
      const prepared = bad.run(['ai-w4-caddy-candidate']); pass(bad, prepared);
      // New fixture marker is absent for the failing invocation without deleting any file.
      bad.put('fixture.json', { sha, image, client, caddy_status: 3 });
    } else bad.put('fixture.json', { sha, image, client, caddy_status: 3 });
    // Use a different later marker when preparation has already succeeded.
    const failureMarker = join(bad.root, 'failure-later.txt');
    const refused = bad.run([step], {}, failureMarker);
    assert.notEqual(refused.status, 0);
    assert.ok(refused.stderr.includes(`FAIL ${step}: Caddy validation exit status expected 0 got 3; STOP`), refused.stderr);
    assert.ok(!refused.calls.some(c => c[0] === 'systemctl' && c[1] === 'reload'), 'reload stub must NOT be called');
    assert.ok(!refused.calls.some(c => c[0] === 'ai_run' && c[1] === 'ai-recycle-install'), 'no post-reload recycle install');
    assert.ok(!existsSync(failureMarker), 'no later action after validation refusal');
    assert.doesNotMatch(refused.stdout, /PASS W4 both|Apply body completed/);
    if (step === 'ai-w4-apply') {
      assert.ok(existsSync(join(bad.proof, 'edge-measurement.json')), 'full apply reaches measurement before validation');
      assert.equal(refused.calls.filter(c => c[0] === 'install').length, 2, 'both reviewed files installed before live validation');
    } else assert.ok(!existsSync(join(bad.proof, 'edge-attempted.txt')));
  }
});

test('edge-caddy-route / outside-origin-probe: fails closed on wrong CORS with the site Origin sent outside ingress', () => {
  const good = fixture(); const r = good.run(probes); pass(good, r);
  assert.deepEqual(requestPairs(r), [['GET', gate], ['HEAD', gate], ['POST', post]]);
  for (const q of r.requests) assert.equal(q.headers.Origin, 'https://commonswarm.com');
  const bad = fixture({ acao: 'https://wrong.example' }); const refused = bad.run(probes);
  stopped(bad, refused, gateFailure('GET'));
  assert.deepEqual(requestPairs(refused), [['GET', gate]]);
  assert.equal(refused.requests[0].headers.Origin, 'https://commonswarm.com');
  assert.doesNotMatch(refused.stdout, /PASS outside/);
});

test('site-build-qa / exact-source-build-ci: fails closed on a site SHA different from the release input', () => {
  const good = fixture(); const r = good.run(['ai-w5-preflight']); pass(good, r);
  assert.deepEqual(r.calls.filter(c => c[0] === 'git'), [['git', 'merge-base', '--is-ancestor', sha, 'origin/main']]);
  const bad = fixture(); const refused = bad.run(['ai-w5-preflight'], { SITE_RELEASE_SHA: 'c'.repeat(40) });
  stopped(bad, refused, 'FAIL ai-w5-preflight: SITE_RELEASE_SHA expected input-release-sha got mismatch; STOP');
  assert.ok(!refused.calls.some(c => c[0] === 'git'));
  assert.equal(refused.calls.filter(c => c[0] === 'python3').length, 1, 'no baseline or authorization read after mismatch');
});

test('site-build-qa / authorized-headless-view-only-qa: fails closed on real-Chrome authorization', () => {
  const good = fixture(); pass(good, good.run(['ai-w5-preflight']));
  const bad = fixture(); bad.put('authorization.json', { approver: 'HezLead', release_sha: sha, task_ref: 'fixture-qa', browser: 'real-chrome' });
  const refused = bad.run(['ai-w5-preflight']);
  stopped(bad, refused, 'FAIL ai-w5-preflight: browser/task_ref expected headless-bundled-chromium/nonempty-string got other-browser/nonempty-string; STOP');
  assert.equal(refused.calls.filter(c => c[0] === 'git').length, 1, 'reaches authorization after main-ancestry check');
  assert.ok(!refused.calls.some(c => ['node', 'npm', 'npx', 'open', 'osascript'].includes(c[0])));
  assert.ok(!existsSync(bad.closedRoot));
});

test('site-build-qa / reviewed-browser-ownership-close-before-W5-close: fails closed on an unreleased ownership close', () => {
  const good = fixture(), admitted = good.run(); pass(good, admitted);
  assert.match(admitted.stdout, /PASS W5 site ownership close and outside GET\/HEAD gate CLOSED/);
  assert.equal(JSON.parse(readFileSync(join(good.closedRoot, 'W5-closed.json'), 'utf8')).site_ownership_close, 'PASS');
  assert.ok(existsSync(join(good.closedRoot, 'inputs.json'))); assert.ok(existsSync(join(good.closedRoot, 'closed.txt')));
  assert.deepEqual(requestPairs(admitted), [['GET', gate], ['HEAD', gate], ['GET', client.client_id], ['GET', client.redirect_uris[0]]]);
  assert.ok(admitted.calls.some(c => c[0] === 'node'));
  for (const [from, to, stop] of [
    ['CLOSED=yes', 'CLOSED=no', 'FAIL site ownership/manifest close not released; STOP'],
    ['OUTCOME=released', 'OUTCOME=rolled-back', 'FAIL site ownership/manifest close not released; STOP'],
    ['PIN_RELEASED=yes', 'PIN_RELEASED=no', 'FAIL site ownership/manifest close not released; STOP'],
    ['MANIFEST_SHA256=', 'WRONG_MANIFEST_SHA256=', 'FAIL site close manifest digest; STOP'],
  ] as const) {
    const bad = fixture(); bad.put('site/CLOSE.txt', bad.goodClose.replace(from, to)); const refused = bad.run();
    stopped(bad, refused, stop); assert.deepEqual(refused.requests, [], 'no outside probe after bad close');
    assert.ok(!refused.calls.some(c => c[0] === 'node')); assert.ok(!existsSync(bad.closedRoot));
  }
});

test('site-build-qa / GET-HEAD-admin-gate-closed-after-W5: fails closed on an open GET gate or nonempty HEAD', () => {
  const good = fixture(); const r = good.run(); pass(good, r);
  assert.deepEqual(requestPairs(r), [['GET', gate], ['HEAD', gate], ['GET', client.client_id], ['GET', client.redirect_uris[0]]]);
  for (const method of ['GET', 'HEAD']) {
    const bad = fixture(method === 'GET' ? { gate_state: 'open' } : { head_body: true, bad_method: 'HEAD' });
    const refused = bad.run();
    stopped(bad, refused, `FAIL ai-w5-closed: ${method} /admin/gate body expected ${method === 'GET' ? 'closed got open' : 'empty got nonempty'}; STOP`);
    assert.deepEqual(requestPairs(refused), method === 'GET' ? [['GET', gate]] : [['GET', gate], ['HEAD', gate]]);
    assert.ok(!refused.calls.some(c => c[0] === 'node')); assert.ok(!existsSync(bad.closedRoot), 'no W5 receipts');
    assert.doesNotMatch(refused.stdout, /PASS W5/);
  }
});
