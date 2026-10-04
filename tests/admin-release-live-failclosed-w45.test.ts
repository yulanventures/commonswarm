/** Execute complete marked W4/W5 blocks; remap only filesystem boundaries and external observations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// Test-data stand-in for the released producer bytes at RELEASE_SHA (never written under repo scripts/).
const producerSource = 'export const fixtureProducer = "live-ordinary-controls";\n';
const planPath = resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
const ordinaryKeys = ['hosted_mcp_consent_refresh', 'dcr_registration_consent', 'cimd_consent', 'human_recovery', 'worker_command_read'];
const inDays = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
function consentReceipt(phase: 'pre-W1' | 'post-W5', change: Record<string, unknown> = {}) {
  return { kind: 'c1-consent', release_sha: sha, consent_phase: phase, measured_at: new Date(Date.now() - 60_000).toISOString(),
    producer_sha256: hash(producerSource), controls: { cimd_consent: true, dcr_registration_consent: true },
    dcr_client_ids: ['dcr-post-w5-1'],
    cleanup: phase === 'pre-W1' ? null : { grants_revoked: true, dcr_clients_expiring: [{ client_id: 'dcr-pre-w1-1', expires_after: inDays(30) }] },
    ...change };
}
function liveReceipt(phase: string, consentText: string, change: Record<string, unknown> = {}) {
  return { release_sha: sha, window_id: 'Fix123', window: 'W5', phase, controls: Object.fromEntries(ordinaryKeys.map(k => [k, true])),
    consent_receipt_sha256: hash(consentText), producer_sha256: hash(producerSource), dcr_client_ids: ['dcr-w5-after-1'], ...change };
}
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
        allowed=[['node','scripts/admin-smoke.mjs','--print-client-metadata'],['docker','inspect','commonswarm-edge-edge-runtime-1'],['/bin/bash'],['/bin/bash','-n']] # /bin/bash: the plan's extract-and-run of ai-live-controls; -n: in-memory syntax checks
        if argv not in allowed or kw.get('shell'): refuse()
        return real_popen(argv,**kw)
    subprocess.Popen=popen
    if cfg.get('install_root'):
        # Ownership boundary: a non-root test cannot chown to 0:0; record the request instead.
        def fchown(fd,uid,gid):
            with (root/'fchown.jsonl').open('a') as log: log.write(json.dumps([uid,gid])+'\n')
        os.fchown=fchown
        if cfg.get('corrupt_install'):
            # Corrupt the installed hook immediately after the plan's single write.
            real_write=os.write
            def write(fd,data):
                n=real_write(fd,data); real_write(fd,b'# tampered after write\n'); return n
            os.write=write
    exec(compile(source,'<complete-plan-block>','exec'))
elif name=='node':
    if args!=['scripts/admin-smoke.mjs','--print-client-metadata']: refuse()
    print(json.dumps(cfg['client']))
elif name=='git':
    if args==['show',cfg['sha']+':scripts/live-ordinary-controls.mjs']: sys.stdout.write(cfg.get('producer',''))
    elif args==['rev-parse','HEAD']: print(cfg.get('head',cfg['sha']))
    elif args==['status','--porcelain']:
        if cfg.get('status_fail'): raise SystemExit(128) # git failed with empty stdout
        sys.stdout.write(cfg.get('dirty',''))
    elif args!=['merge-base','--is-ancestor',cfg['sha'],'origin/main']: refuse()
elif name=='ssh':
    # Positive-control boundary: every local guard admitted before the first remote operation.
    print('ADMITTED ssh'); raise SystemExit(97)
elif name=='dirname':
    if len(args)!=1: refuse()
    print(os.path.dirname(args[0]))
elif name=='mkdir' and args and args[0]=='-p' and cfg.get('install_root'):
    for value in args[1:]: owned(value).mkdir(parents=True,exist_ok=True)
elif name=='mkdir' and args and args[0]=='-p':
    # Positive-control boundary: every guard admitted before the first directory creation.
    print('ADMITTED mkdir -p'); raise SystemExit(97)
elif name=='mkdir':
    if len(args)!=1: refuse()
    owned(args[0]).mkdir()
elif name=='cp':
    if len(args)==3 and args[0]=='-a' and args[1].endswith('/.'):
        shutil.copytree(owned(args[1]),owned(args[2]),dirs_exist_ok=True)
    elif len(args)==2: shutil.copyfile(owned(args[0]),owned(args[1]))
    else: refuse()
elif name=='chmod' and len(args)==2 and args[0] in ('0700','0644') and cfg.get('install_root'):
    owned(args[1]).chmod(int(args[0],8))
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
    if args not in [['ai-inputs'],['ai-gates'],['ai-timer-guard'],['ai-recycle-install'],['ai-backup-gate-check']]: refuse()
    # The shared backup receipt validator's verdict; its content checks run from plan bytes in admin-release-plan.test.ts.
    if args==['ai-backup-gate-check'] and cfg.get('backup_gate_refused'): raise SystemExit(1)
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
elif name=='systemctl' and args==['is-active','--quiet','fixture-recycle.timer']:
    raise SystemExit(0 if cfg.get('timer_active') else 3)
elif name=='systemctl':
    if args==['stop','fixture-recycle.timer'] or args==['reload','caddy']: pass
    elif args==['show','-p','ActiveState','--value','fixture-recycle.service']: print('inactive')
    elif args==['daemon-reload'] and cfg.get('install_root'): pass
    elif args==['cat','fixture-recycle.service'] and cfg.get('install_root'):
        dropin=root/'systemd/fixture-recycle.service.d/50-admin-measurement.conf'
        print('# fixture-recycle.service\n[Service]\nExecStart=/bin/true\n# '+str(dropin)+'\n'+dropin.read_text())
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
    elif args==['inspect','--format','{{index .Config.Labels "com.docker.compose.project.config_files"}}','commonswarm-edge-edge-runtime-1']:
        old=str(root/'edge/releases'/cfg['baseline']/'deploy/edge-runtime'); print(old+'/compose.yaml,'+old+'/compose.override.yaml')
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
  const data = { release_sha: sha, baseline_site_sha: baseline, baseline_edge_sha: baseline, baseline_postgres_image: image, baseline_edge_image: image, window: 'W5', window_id: 'Fix123',
    baseline_caddyfile_sha256: '', archive_sha256: '', plan_sha256: hash(readFileSync(planPath)) };
  put('authorization.json', { approver: 'HezLead', release_sha: sha, task_ref: 'fixture-qa', browser: 'headless-bundled-chromium' });
  put('fixture.json', { sha, baseline, image, client, producer: producerSource, ...config });
  // W5 forward close inputs: post-W5 consent and the window's phase-after live receipt.
  const consentText = JSON.stringify(consentReceipt('post-W5'));
  put('consent.json', consentText); put('live.json', liveReceipt('after', consentText));
  // W5 opening inputs: pre-W1 consent and the phase-before live receipt (ai-w5-preflight).
  const preText = JSON.stringify(consentReceipt('pre-W1'));
  put('consent-pre.json', preText); put('live-before.json', liveReceipt('before', preText));
  mkdirSync(join(root, 'prep'), { mode: 0o700 }); mkdirSync(join(root, 'prep-open'), { mode: 0o700 });
  // Close-path fixtures start from a passed W5 opening staged under PREP_DIR.
  put('prep/w5-live-before/ordinary-before.json', liveReceipt('before', preText)); put('prep/w5-live-before/consent-pre-W1.json', preText);
  put('commands.jsonl', ''); put('http.jsonl', '');
  put('bin/_dispatch', dispatcher);
  chmodSync(join(bin, '_dispatch'), 0o700);
  for (const name of ['python3', 'node', 'ssh', 'psql', 'docker', 'curl', 'caddy', 'systemctl', 'sudo', 'git',
    'npm', 'npx', 'open', 'osascript', 'wget', 'op', 'mkdir', 'cp', 'chmod', 'ai_deadline', 'ai_run', 'ai_db',
    'ai_ro', 'date', 'cmp', 'ln', 'mv', 'timeout', 'sha256sum', 'awk', 'install', 'dirname']) symlinkSync('_dispatch', join(bin, name));
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
  // The release archive also carries the producer; W5 reads it from PREP_DIR/release.tar.
  const producerFile = `edge/releases/${sha}/scripts/live-ordinary-controls.mjs`; put(producerFile, producerSource);
  const archived = spawnSync('/usr/bin/python3', ['-c',
    'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    t.add(sys.argv[2],arcname="src/reviewed.txt"); t.add(sys.argv[3],arcname="scripts/live-ordinary-controls.mjs")', archive, join(root, edgeFile), join(root, producerFile)], { encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr); data.archive_sha256 = hash(readFileSync(archive));
  for (const prep of ['prep', 'prep-open']) { copyFileSync(archive, join(root, prep, 'release.tar')); chmodSync(join(root, prep, 'release.tar'), 0o600); }
  for (const version of ['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005',
    '20260928000003','20261002000001','20261003000001','20261003000002','20261003000003','20261003000004','20261003000005'])
    put(`release/supabase/migrations/${version}_fixture.sql`, '-- reviewed migration fixture\n');
  put('inputs.json', data);
  const later = join(root, 'later.txt');
  function run(steps = ['ai-w5-closed'], env: Record<string, string> = {}, laterMarker = later) {
    const opening = steps[0] === 'ai-w5-preflight';
    let source = steps.map(block).join('\n');
    for (const [from, to] of [
      ['/Users/yulanbot/work/hm37-live-release', receipts], ['/etc/caddy', join(root, 'etc/caddy')],
      ['/home/commonswarm/edge', join(root, 'edge')], ['/home/commonswarm/.env', join(root, 'box/.env')],
      ['/tmp/admin-issuance-', join(root, 'archive/admin-issuance-')], ['/proof/measure.sql', join(proof, 'measure.sql')],
      ['/etc/systemd/system', join(root, 'systemd')],
      ['/usr/local/libexec', join(root, 'libexec')], ['/etc/commonswarm-admin-release', join(root, 'admin-release')],
    ] as const) source = source.split(from).join(to);
    const result = spawnSync('/bin/bash', [], {
      input: 'set -euo pipefail\n' + source + `\nprintf 'later side effect\\n' >${quote(laterMarker)}\n`, encoding: 'utf8', timeout: 15_000,
      cwd: root, env: { ...process.env, PATH: bin, PYTHONDONTWRITEBYTECODE: '1', W45_ROOT: root,
        INPUTS_FILE: join(root, 'inputs.json'), SITE_EVIDENCE: site, SITE_RELEASE_SHA: sha, EXPECTED_SITE_SHA: baseline,
        SITE_QA_AUTHORIZATION_FILE: join(root, 'authorization.json'), WINDOW: 'W4', WINDOW_ID: data.window_id,
        SECRET_STAGE: stage, PROOF_DIR: proof, NEW_EDGE: newEdge, RELEASE_ROOT: join(root, 'release'), RELEASE_SHA: sha,
        EDGE_RECYCLE_TIMER: 'fixture-recycle.timer', EDGE_RECYCLE_SERVICE: 'fixture-recycle.service',
        LIVE_CONTROLS_FILE: join(root, opening ? 'live-before.json' : 'live.json'),
        CONSENT_RECEIPT_FILE: join(root, opening ? 'consent-pre.json' : 'consent.json'), PLAN_FILE: planPath,
        PREP_DIR: join(root, opening ? 'prep-open' : 'prep'), BOX_ARCHIVE_PATH: archive, ...env },
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

test('backup-restore-gate / w4-apply-mutation-boundary: ai-w4-apply validates the backup receipt right before its first database mutation', () => {
  const good = fixture(); const r = good.run(['ai-w4-caddy-candidate', 'ai-w4-apply']); pass(good, r);
  const gate = r.calls.findIndex(c => c[0] === 'ai_run' && c[1] === 'ai-backup-gate-check');
  const mutation = r.calls.findIndex(c => c[0] === 'ai_db' && c.join(' ').includes('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false'));
  assert.ok(gate >= 0 && mutation > gate, 'the backup check precedes the first W4 database mutation');
  const bad = fixture(); pass(bad, bad.run(['ai-w4-caddy-candidate']));
  bad.put('fixture.json', { sha, image, client, backup_gate_refused: true });
  const refused = bad.run(['ai-w4-apply']);
  assert.notEqual(refused.status, 0);
  assert.ok(refused.stderr.includes('FAIL ai-w4-apply: W4: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP'), refused.stderr);
  assert.ok(!refused.calls.some(c => c[0] === 'ai_db'), 'no database mutation after a refused backup receipt');
  assert.ok(!refused.calls.some(c => c[0] === 'systemctl' && c[1] === 'reload'), 'no Caddy reload after a refused backup receipt');
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

// W5 forward close (Amendment A): ai-w5-closed runs the complete ai-live-controls
// block, phase after, bound to the post-W5 consent receipt, before any outside probe.
function w5Refused(f: Fixture, r: Result, text: string) {
  stopped(f, r, text); assert.doesNotMatch(r.stderr, /Traceback/);
  assert.deepEqual(r.requests, [], 'no outside probe after a live-controls refusal');
  assert.ok(!r.calls.some(c => c[0] === 'node')); assert.ok(!existsSync(f.closedRoot), 'no W5 close receipts');
}
function w5Pair(f: Fixture, consent: Record<string, unknown>, phase = 'after', change: Record<string, unknown> = {}) {
  const text = JSON.stringify(consent); f.put('consent.json', text); f.put('live.json', liveReceipt(phase, text, change));
}
test('ordinary-paths-unchanged / w5-forward-close-live-controls: ai-w5-closed refuses unless phase-after controls bind to the post-W5 consent receipt', () => {
  const good = fixture(), r = good.run(); pass(good, r);
  assert.equal(readFileSync(join(good.closedRoot, 'consent-post-W5.json'), 'utf8'), readFileSync(join(good.root, 'consent.json'), 'utf8'));
  assert.equal(readFileSync(join(good.closedRoot, 'consent-pre-W1.json'), 'utf8'), readFileSync(join(good.root, 'consent-pre.json'), 'utf8'));
  assert.ok(existsSync(join(good.closedRoot, 'ordinary-before.json')));
  // Close refuses without the W5 opening receipts.
  for (const name of ['ordinary-before.json', 'consent-pre-W1.json']) {
    const f = fixture(); renameSync(join(f.root, 'prep/w5-live-before', name), join(f.root, 'moved-' + name));
    w5Refused(f, f.run(), `FAIL ai-w5-closed: W5 opening receipt expected ${name} got missing; STOP`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(good.closedRoot, 'ordinary-after.json'), 'utf8')), JSON.parse(readFileSync(join(good.root, 'live.json'), 'utf8')));
  assert.ok(!r.calls.some(c => c[0] === 'git'), 'producer comes from the verified archive, never git show');
  const expiring = (entries: unknown[]) => consentReceipt('post-W5', { cleanup: { grants_revoked: true, dcr_clients_expiring: entries } });
  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>, string]> = [
    [consentReceipt('pre-W1'), 'after', {}, 'FAIL ai-live-controls: consent_phase for W5 after expected post-W5 got pre-W1; STOP'],
    [consentReceipt('pre-W1'), 'before', {}, 'FAIL ai-live-controls: live phase expected after got before; STOP'],
    [consentReceipt('post-W5', { cleanup: null }), 'after', {}, 'FAIL ai-live-controls: post-W5 consent cleanup expected object got null-or-other; STOP'],
    [expiring([{ client_id: 'dcr-pre-w1-1', expires_after: inDays(-1) }]), 'after', {}, 'FAIL ai-live-controls: post-W5 cleanup expires_after expected future got past-or-invalid; STOP'],
    [expiring([{ client_id: 'dcr-pre-w1-1', expires_after: inDays(30), note: 'x' }]), 'after', {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring entry expected exact-client_id-and-expires_after got other; STOP'],
    [expiring([{ client_id: 'dcr-post-w5-1', expires_after: inDays(30) }]), 'after', {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring client_id expected not-own-dcr_client_id got own-id; STOP'],
    [consentReceipt('post-W5'), 'after', { controls: { ...Object.fromEntries(ordinaryKeys.map(k => [k, true])), human_recovery: false } }, 'FAIL ai-live-controls: live control human_recovery expected true got false; STOP'],
  ];
  for (const [consent, phase, change, message] of cases) { const f = fixture(); w5Pair(f, consent, phase, change); w5Refused(f, f.run(), message); }
  { const f = fixture(); w5Pair(f, consentReceipt('post-W5'), 'after', { producer_sha256: 'f'.repeat(64) });
    w5Refused(f, f.run(), 'FAIL ai-live-controls: live producer_sha256 expected sha256-of-released-script got mismatch; STOP'); }
  // The prepared archive is re-verified: replaced bytes refuse, even with matching receipts.
  { const f = fixture(); f.put('prep/release.tar', 'not the verified archive');
    w5Refused(f, f.run(), 'FAIL ai-live-controls: BOX_ARCHIVE_PATH bytes expected input-archive_sha256 got mismatch; STOP'); }
  // The retained opening pair is re-validated in full, not only for presence.
  { const f = fixture(); f.put('prep/w5-live-before/ordinary-before.json', '{}'); const out = f.run();
    w5Refused(f, out, 'FAIL ai-w5-closed: retained W5 opening receipts expected valid got refused; STOP');
    assert.ok(out.stderr.includes('FAIL ai-live-controls: live receipt keys expected exact-schema-set got other-set; STOP'));
    assert.ok(!existsSync(join(f.root, 'prep/w5-live-controls'))); }
  // Only W5 inputs reach W5's close.
  { const f = fixture(); f.put('inputs.json', { ...JSON.parse(readFileSync(join(f.root, 'inputs.json'), 'utf8')), window: 'W2' }); const out = f.run();
    w5Refused(f, out, 'FAIL ai-w5-closed: INPUTS window expected W5 got other; STOP'); assert.ok(!existsSync(join(f.root, 'prep/w5-live-controls'))); }
  for (const name of ['LIVE_CONTROLS_FILE', 'CONSENT_RECEIPT_FILE', 'PLAN_FILE']) {
    const f = fixture(); const refused = f.run(['ai-w5-closed'], { [name]: '' });
    w5Refused(f, refused, `FAIL ai-w5-closed: ${name} expected absolute-regular-file got unset; STOP`);
    assert.ok(!refused.calls.some(c => c[0] === 'git'));
  }
  { const f = fixture(); mkdirSync(join(f.root, 'prep/w5-live-controls'));
    const refused = f.run(); w5Refused(f, refused, 'FAIL ai-w5-closed: live-controls staging expected absent got present; STOP');
    assert.ok(!refused.calls.some(c => c[0] === 'git')); }
});

// Former statement-level `A && B` guards, each half now refusing on its own line.
function admitted(r: Result, marker: string) {
  assert.equal(r.status, 97, r.stderr); assert.match(r.stdout, new RegExp(marker)); assert.doesNotMatch(r.stderr, /FAIL/);
}
function guardRefused(f: Fixture, r: Result, text: string) {
  stopped(f, r, text); assert.doesNotMatch(r.stdout, /ADMITTED/);
}
test('release-plan-contract / w4-apply-candidate-guards: refuses a missing MCP or API Caddy candidate before closing issuance', () => {
  for (const [present, message] of [[[], 'FAIL ai-w4-apply: mcp.new.caddy candidate expected present got missing; STOP'],
    [['mcp.new.caddy'], 'FAIL ai-w4-apply: api.new.caddy candidate expected present got missing; STOP']] as const) {
    const f = fixture(); for (const file of present) f.put('stage/' + file, 'candidate\n');
    const r = f.run(['ai-w4-apply']); guardRefused(f, r, message);
    assert.ok(!r.calls.some(c => c[0] === 'ai_db')); assert.ok(!existsSync(join(f.proof, 'edge-attempted.txt')));
  }
});
test('release-plan-contract / w4-preflight-override-and-new-edge-guards: refuses a missing or symlinked override and an existing or symlinked new edge release', () => {
  const ready = (f: Fixture, override = true) => {
    // W4 inputs and a valid retained opening pair: W4 preflight re-validates it in full.
    f.put('inputs.json', { ...JSON.parse(readFileSync(join(f.root, 'inputs.json'), 'utf8')), window: 'W4' });
    const pre = JSON.stringify(consentReceipt('pre-W1'));
    f.put('proof/consent-pre-W1.json', pre); f.put('proof/ordinary-before.json', liveReceipt('before', pre, { window: 'W4' }));
    f.put('proof/backup-gate.json', { status: 'PASS', backup_verified_at: '2026-10-04T00:00:00Z', restore_at: '2026-10-01T00:00:00Z' });
    if (override) f.put(`edge/releases/${baseline}/deploy/edge-runtime/compose.override.yaml`, 'reviewed override\n');
    renameSync(join(f.root, 'edge/releases', sha), join(f.root, 'moved-new-edge'));
  };
  const good = fixture(); ready(good); admitted(good.run(['ai-w4-preflight']), 'ADMITTED mkdir -p');
  // W4 runs the shared backup gate after open, as W1 does: its preflight refuses unless the shared validator accepts this window's receipt.
  assert.ok(good.run(['ai-w4-preflight']).calls.some(c => c[0] === 'ai_run' && c[1] === 'ai-backup-gate-check'));
  const noBackup = fixture({ backup_gate_refused: true }); ready(noBackup);
  guardRefused(noBackup, noBackup.run(['ai-w4-preflight']), 'FAIL ai-w4-preflight: W4: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP');
  const missing = fixture(); ready(missing, false);
  guardRefused(missing, missing.run(['ai-w4-preflight']), 'FAIL ai-w4-preflight: baseline compose.override.yaml expected regular-file got missing; STOP');
  const linked = fixture(); ready(linked, false); linked.put('real-override.yaml', 'reviewed override\n');
  mkdirSync(join(linked.root, `edge/releases/${baseline}/deploy/edge-runtime`), { recursive: true });
  symlinkSync(join(linked.root, 'real-override.yaml'), join(linked.root, `edge/releases/${baseline}/deploy/edge-runtime/compose.override.yaml`));
  guardRefused(linked, linked.run(['ai-w4-preflight']), 'FAIL ai-w4-preflight: baseline compose.override.yaml expected not-symlink got symlink; STOP');
  const present = fixture(); ready(present); mkdirSync(join(present.root, 'edge/releases', sha));
  guardRefused(present, present.run(['ai-w4-preflight']), 'FAIL ai-w4-preflight: new edge release directory expected absent got present; STOP');
  const dangling = fixture(); ready(dangling); symlinkSync(join(dangling.root, 'absent-edge'), join(dangling.root, 'edge/releases', sha));
  guardRefused(dangling, dangling.run(['ai-w4-preflight']), 'FAIL ai-w4-preflight: new edge release directory expected not-symlink got symlink; STOP');
  assert.ok(!existsSync(join(dangling.root, 'absent-edge')));
});
test('release-plan-contract / recycle-install-dropin-guards: refuses an existing or symlinked recycle drop-in', () => {
  const good = fixture(); admitted(good.run(['ai-recycle-install']), 'ADMITTED mkdir -p');
  const dropin = 'systemd/fixture-recycle.service.d/50-admin-measurement.conf';
  const present = fixture(); present.put(dropin, '[Service]\n');
  guardRefused(present, present.run(['ai-recycle-install']), 'FAIL ai-recycle-install: recycle drop-in expected absent got present; STOP');
  assert.equal(readFileSync(join(present.root, dropin), 'utf8'), '[Service]\n');
  const linked = fixture(); mkdirSync(dirname(join(linked.root, dropin)), { recursive: true });
  symlinkSync(join(linked.root, 'absent-dropin'), join(linked.root, dropin));
  guardRefused(linked, linked.run(['ai-recycle-install']), 'FAIL ai-recycle-install: recycle drop-in expected not-symlink got symlink; STOP');
});
test('release-plan-contract / w6-prepare-checkout-and-proof-guards: refuses a wrong HEAD, dirty tree, or existing or symlinked C1 proof directory', () => {
  const env = { WINDOW: 'W6' };
  const good = fixture(); admitted(good.run(['ai-w6-prepare'], env), 'ADMITTED mkdir -p');
  const wrong = fixture({ head: 'c'.repeat(40) });
  guardRefused(wrong, wrong.run(['ai-w6-prepare'], env), 'FAIL ai-w6-prepare: checkout HEAD expected release-sha got mismatch; STOP');
  const dirty = fixture({ dirty: ' M site/index.html\n' });
  guardRefused(dirty, dirty.run(['ai-w6-prepare'], env), 'FAIL ai-w6-prepare: worktree expected clean got dirty; STOP');
  // A failing git status (empty stdout, exit 128) must not read as a clean tree.
  const broken = fixture({ status_fail: true }); const failed = broken.run(['ai-w6-prepare'], env);
  assert.equal(failed.status, 128, failed.stderr); assert.doesNotMatch(failed.stdout, /ADMITTED/); assert.ok(!existsSync(broken.later));
  assert.ok(!failed.calls.some(c => c[0] === 'mkdir'));
  const c1 = (f: Fixture) => join(f.root, 'receipts', `c1-${sha}-Fix123`);
  const present = fixture(); mkdirSync(c1(present), { recursive: true });
  guardRefused(present, present.run(['ai-w6-prepare'], env), 'FAIL ai-w6-prepare: C1_PROOF_DIR expected absent got present; STOP');
  const linked = fixture(); mkdirSync(join(linked.root, 'receipts')); symlinkSync(join(linked.root, 'absent-c1'), c1(linked));
  guardRefused(linked, linked.run(['ai-w6-prepare'], env), 'FAIL ai-w6-prepare: C1_PROOF_DIR expected not-symlink got symlink; STOP');
});
test('release-plan-contract / w6-transfer-file-guards: refuses a missing or symlinked upload and an existing or symlinked download target', () => {
  const env = (direction: string, file: string, f: Fixture) => ({ WINDOW: 'W6', C1_TRANSFER_DIRECTION: direction, C1_TRANSFER_FILE: file, C1_PROOF_DIR: join(f.root, 'c1') });
  const up = fixture(); up.put('c1/agent.json', '{}'); admitted(up.run(['ai-w6-transfer'], env('upload', 'agent.json', up)), 'ADMITTED ssh');
  const missing = fixture(); mkdirSync(join(missing.root, 'c1'));
  let r = missing.run(['ai-w6-transfer'], env('upload', 'agent.json', missing));
  guardRefused(missing, r, 'FAIL ai-w6-transfer: upload file expected regular-file got missing; STOP'); assert.ok(!r.calls.some(c => c[0] === 'ssh'));
  const linked = fixture(); linked.put('elsewhere.json', '{}'); mkdirSync(join(linked.root, 'c1'));
  symlinkSync(join(linked.root, 'elsewhere.json'), join(linked.root, 'c1/agent.json'));
  r = linked.run(['ai-w6-transfer'], env('upload', 'agent.json', linked));
  guardRefused(linked, r, 'FAIL ai-w6-transfer: upload file expected not-symlink got symlink; STOP'); assert.ok(!r.calls.some(c => c[0] === 'ssh'));
  // Download positive: guards admit; the remote read's stdout lands in the new 0600 target.
  const down = fixture(); mkdirSync(join(down.root, 'c1')); r = down.run(['ai-w6-transfer'], env('download', 'C1-audit.json', down));
  assert.equal(r.status, 97, r.stderr); assert.doesNotMatch(r.stderr, /FAIL/);
  assert.equal(readFileSync(join(down.root, 'c1/C1-audit.json'), 'utf8'), 'ADMITTED ssh\n');
  const present = fixture(); present.put('c1/C1-audit.json', 'retained\n');
  r = present.run(['ai-w6-transfer'], env('download', 'C1-audit.json', present));
  guardRefused(present, r, 'FAIL ai-w6-transfer: download target expected absent got present; STOP'); assert.ok(!r.calls.some(c => c[0] === 'ssh'));
  assert.equal(readFileSync(join(present.root, 'c1/C1-audit.json'), 'utf8'), 'retained\n');
  const dangling = fixture(); mkdirSync(join(dangling.root, 'c1')); symlinkSync(join(dangling.root, 'absent-audit'), join(dangling.root, 'c1/C1-audit.json'));
  r = dangling.run(['ai-w6-transfer'], env('download', 'C1-audit.json', dangling));
  guardRefused(dangling, r, 'FAIL ai-w6-transfer: download target expected not-symlink got symlink; STOP'); assert.ok(!r.calls.some(c => c[0] === 'ssh'));
  assert.ok(!existsSync(join(dangling.root, 'absent-audit')));
});

// W5 opening: ai-w5-preflight runs ai-live-controls phase before with the pre-W1 consent
// receipt before any site build, upload or other side effect.
test('ordinary-paths-unchanged / w5-opening-live-controls: ai-w5-preflight refuses unless phase-before controls bind to the pre-W1 consent receipt', () => {
  const good = fixture(), r = good.run(['ai-w5-preflight']); pass(good, r);
  const staged = join(good.root, 'prep-open/w5-live-before');
  assert.equal(readFileSync(join(staged, 'consent-pre-W1.json'), 'utf8'), readFileSync(join(good.root, 'consent-pre.json'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(staged, 'ordinary-before.json'), 'utf8')), JSON.parse(readFileSync(join(good.root, 'live-before.json'), 'utf8')));
  const refusedOpen = (f: Fixture, out: Result, text: string) => {
    stopped(f, out, text); assert.doesNotMatch(out.stderr, /Traceback/);
    assert.deepEqual(out.requests, []); assert.ok(!out.calls.some(c => ['node', 'npm', 'npx', 'ssh', 'docker'].includes(c[0])));
    assert.ok(!existsSync(join(f.root, 'prep-open/w5-live-before/ordinary-before.json')));
    assert.ok(!existsSync(join(f.root, 'prep-open/w5-live-before/consent-pre-W1.json')));
  };
  { const f = fixture(); refusedOpen(f, f.run(['ai-w5-preflight'], { LIVE_CONTROLS_FILE: join(f.root, 'absent-before.json') }),
      'FAIL ai-live-controls: LIVE_CONTROLS_FILE expected absolute-regular-file got missing-or-not-regular; STOP'); }
  { const f = fixture(); refusedOpen(f, f.run(['ai-w5-preflight'], { LIVE_CONTROLS_FILE: '' }),
      'FAIL ai-w5-preflight: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP'); }
  { const f = fixture(), post = JSON.stringify(consentReceipt('post-W5')); f.put('consent-pre.json', post); f.put('live-before.json', liveReceipt('before', post));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: consent_phase for W5 before expected pre-W1 got post-W5; STOP'); }
  { const f = fixture(), pre = readFileSync(join(f.root, 'consent-pre.json'), 'utf8'); f.put('live-before.json', liveReceipt('after', pre));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: live phase expected before got after; STOP'); }
  { const f = fixture(), pre = readFileSync(join(f.root, 'consent-pre.json'), 'utf8'); f.put('live-before.json', liveReceipt('after', pre, { phase: 'recovery' }));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: live phase expected before got recovery; STOP'); }
  { const f = fixture(), pre = readFileSync(join(f.root, 'consent-pre.json'), 'utf8');
    f.put('live-before.json', liveReceipt('before', pre, { controls: { ...Object.fromEntries(ordinaryKeys.map(k => [k, true])), cimd_consent: false } }));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: live control cimd_consent expected true got false; STOP'); }
  // A valid W5 phase-after pair presented at the opening passes ai-live-controls but not the opening phase check.
  { const f = fixture(); f.put('consent-pre.json', readFileSync(join(f.root, 'consent.json'), 'utf8')); f.put('live-before.json', readFileSync(join(f.root, 'live.json'), 'utf8'));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: live phase expected before got after; STOP'); }
  // Finding 4: a matching W2 before pair (W2 inputs) is refused before any staging.
  { const f = fixture(), pre = readFileSync(join(f.root, 'consent-pre.json'), 'utf8');
    f.put('inputs.json', { ...JSON.parse(readFileSync(join(f.root, 'inputs.json'), 'utf8')), window: 'W2' });
    f.put('live-before.json', { ...liveReceipt('before', pre), window: 'W2' });
    const out = f.run(['ai-w5-preflight']); refusedOpen(f, out, 'FAIL ai-w5-preflight: INPUTS window expected W5 got other; STOP');
    assert.ok(!existsSync(join(f.root, 'prep-open/w5-live-before')), 'no staging for a non-W5 receipt'); }
  // The W5 Mac runner executes ai-live-controls only from plan bytes bound to INPUTS plan_sha256.
  { const noOp = join(scratch, 'noop-RELEASE.md'); writeFileSync(noOp, readFileSync(planPath, 'utf8').split('# step: ai-live-controls\n').join('# step: ai-live-controls\nexit 0\n'));
    const linked = join(scratch, 'linked-RELEASE.md'); if (!existsSync(linked)) symlinkSync(planPath, linked);
    for (const [planFile, got] of [[noOp, 'digest-mismatch'], [linked, 'missing-or-not-regular']] as const) {
      const f = fixture(); f.put('live-before.json', '{}');
      refusedOpen(f, f.run(['ai-w5-preflight'], { PLAN_FILE: planFile }), `FAIL ai-w5-preflight: PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got ${got}; STOP`);
    } }
  // The prepared archive is re-verified at the opening too.
  { const f = fixture(); f.put('prep-open/release.tar', 'not the verified archive');
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-live-controls: BOX_ARCHIVE_PATH bytes expected input-archive_sha256 got mismatch; STOP'); }
  { const f = fixture(); mkdirSync(join(f.root, 'prep-open/w5-live-before'));
    refusedOpen(f, f.run(['ai-w5-preflight']), 'FAIL ai-w5-preflight: live-controls staging expected absent got present; STOP'); }
});

// ai-recycle-install's single write + post-install comparison, executed in a temporary root.
test('release-plan-contract / recycle-install-verified-write: installs exactly the verified hook bytes and refuses a corrupted install before registering the drop-in', () => {
  const hookBlock = blocks.filter(b => b.startsWith('# step: ai-recycle-hook\n'));
  assert.equal(hookBlock.length, 1);
  const dropin = 'systemd/fixture-recycle.service.d/50-admin-measurement.conf', installed = 'libexec/commonswarm-admin-edge-recycle';
  const good = fixture({ install_root: true }); const r = good.run(['ai-recycle-install']); pass(good, r);
  assert.equal(readFileSync(join(good.root, installed), 'utf8'), '#!/bin/bash\n' + hookBlock[0], 'installed bytes are the verified extraction');
  assert.equal(statSync(join(good.root, installed)).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(good.root, 'fchown.jsonl'), 'utf8').trim(), '[0, 0]');
  assert.match(readFileSync(join(good.root, dropin), 'utf8'), /ExecStartPre=.*commonswarm-admin-edge-recycle before/);
  assert.ok(r.calls.some(c => c[0] === 'systemctl' && c[1] === 'daemon-reload'), 'drop-in registered');
  assert.ok(existsSync(join(good.proof, 'recycle-unit-after.txt')));
  assert.match(r.stdout, /PASS recycle pre-invalidation\/post-measurement hooks installed/);
  // Negative: the installed file is corrupted after the single write.
  const bad = fixture({ install_root: true, corrupt_install: true }); const refused = bad.run(['ai-recycle-install']);
  stopped(bad, refused, 'FAIL ai-recycle-install: installed hook expected verified-bytes got changed; STOP');
  assert.ok(!existsSync(join(bad.root, dropin)), 'drop-in not written'); assert.ok(!refused.calls.some(c => c[0] === 'systemctl' && c[1] === 'daemon-reload'), 'no daemon-reload');
  assert.ok(!existsSync(join(bad.proof, 'recycle-unit-after.txt')));
  // Negative: a symlink planted at the install path is never written through.
  const planted = fixture({ install_root: true }); planted.put('victim.txt', 'must survive\n');
  mkdirSync(join(planted.root, 'libexec'), { recursive: true }); symlinkSync(join(planted.root, 'victim.txt'), join(planted.root, installed));
  const blocked = planted.run(['ai-recycle-install']);
  stopped(planted, blocked, 'FAIL ai-recycle-install: installed hook expected writable-regular-file got symlink-or-unwritable; STOP');
  assert.equal(readFileSync(join(planted.root, 'victim.txt'), 'utf8'), 'must survive\n'); assert.ok(!existsSync(join(planted.root, dropin)));
});
