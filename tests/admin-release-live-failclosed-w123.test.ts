/** Execute complete marked release blocks; substitute only box paths and command observations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

const plan = readFileSync(resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'), 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
function block(step: string) {
  const matches = blocks.filter(s => s.startsWith(`# step: ${step}\n`));
  assert.equal(matches.length, 1, `one complete ${step} block`);
  return matches[0]!;
}
const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
assert.ok(python.startsWith('/'), 'absolute Python runtime');
const sha = 'a'.repeat(40), baseline = 'b'.repeat(40), image = 'sha256:' + 'c'.repeat(64);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'admin-live-w123-')));

// Each command records argv before returning independent fixture observations.
// PATH contains only these stubs; unmodelled invocations fail, never reach a daemon.
const dispatcher = String.raw`
import builtins,io,json,os,pathlib,shutil,subprocess,sys,urllib.request
root=pathlib.Path(os.environ['FIXTURE_ROOT']); cfg=json.loads((root/'commands.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'argv.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
def refuse(): raise SystemExit('UNMODELLED '+name+' '+repr(args))
def owned(value):
    p=pathlib.Path(value)
    if not p.is_absolute() or not str(p).startswith(str(root)+'/'): refuse()
    return p
def output(value): print(value)
if name=='python3':
    if args==['-'] or (args and args[0]=='-'):
        source=sys.stdin.read(); sys.argv=['-']+args[1:]
    elif len(args)>=2 and args[0]=='-c': source=args[1]; sys.argv=['-c']+args[2:]
    else: refuse()
    def urlopen(url,timeout):
        if url!='http://127.0.0.1:3490/admin/gate' or timeout!=15: refuse()
        class Response(io.BytesIO): status=cfg.get('http_status',200)
        return Response(cfg.get('gate_body','{"state":"closed"}').encode())
    urllib.request.urlopen=urlopen
    # All these blocks use only local Python I/O except the modelled gate request.
    import socket
    def no_network(*a,**kw): raise RuntimeError('UNMODELLED network')
    socket.socket.connect=no_network; socket.create_connection=no_network
    exec(compile(source,'<complete-plan-block>','exec'))
elif name=='ai_deadline':
    if args: refuse()
elif name=='ai_ro':
    if len(args)!=3 or args[:2]!=['-Atq','--command']: refuse()
    if args[2] not in ['SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;',"SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='commonswarm_admin_issuer';"]: refuse()
    output(cfg.get('readonly','t'))
elif name=='ai_db':
    if args==['-q','--file','-']:
        (root/'applied.sql').write_text(sys.stdin.read())
    elif args==['-q','--command','ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;']:
        (root/'applied.sql').write_text(args[2])
    else: refuse()
elif name=='openssl':
    if args!=['rand','-hex','32']: refuse()
    output('d'*64) # Synthetic fixture, never a generated/live credential.
elif name=='chmod':
    if len(args)!=2 or args[0]!='0600': refuse()
    owned(args[1]).chmod(0o600)
elif name=='install':
    if len(args)!=8 or args[:2]!=['-o','root'] or args[2]!='-g' or args[4]!='-m': refuse()
    if (args[3],args[5]) not in [('986','0440'),('root','0600')]: refuse()
    target=owned(args[7]); target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(owned(args[6]),target); target.chmod(int(args[5],8))
elif name=='stat':
    if args!=['-c','%a %u %g',str(root/'etc/commonswarm-oauth/admin-issuer-database-credentials')]: refuse()
    if not owned(args[2]).is_file(): refuse()
    output('440 0 986')
elif name=='cat':
    if len(args)!=1: refuse()
    sys.stdout.write(owned(args[0]).read_text())
elif name=='cmp':
    if len(args)!=3 or args[0]!='-s': refuse()
    raise SystemExit(0 if owned(args[1]).read_bytes()==owned(args[2]).read_bytes() else 1)
elif name=='mkdir':
    if len(args)!=2 or args[0]!='-p': refuse()
    owned(args[1]).mkdir(parents=True,exist_ok=True)
elif name=='cp':
    if len(args)!=3 or args[0]!='-a' or not args[1].endswith('/.'): refuse()
    shutil.copytree(owned(args[1]),owned(args[2]),dirs_exist_ok=True)
elif name=='rm':
    if args!=['--',str(root/'etc/commonswarm-oauth/admin-issuer-database-credentials')]: refuse()
    if cfg.get('cleanup_refused'): raise SystemExit(64)
    owned(args[1]).unlink()
elif name=='date':
    if args!=['-u','+%Y-%m-%dT%H:%M:%SZ']: refuse()
    output('2026-10-03T12:00:00Z')
elif name=='nice':
    if args[:3]!=['-n','15','docker']: refuse()
    raise SystemExit(subprocess.run(args[2:]).returncode)
elif name=='timeout':
    if args[:3]!=['90','/bin/bash','-c'] or len(args)!=4: refuse()
    if 'docker inspect' not in args[3] or 'healthy' not in args[3]: refuse()
    raise SystemExit(subprocess.run(args[1:]).returncode)
elif name=='ln':
    if len(args)!=3 or args[0]!='-s': refuse()
    owned(args[2]).symlink_to(owned(args[1]),target_is_directory=True)
elif name=='mv':
    if len(args)!=3 or args[0]!='-Tf': refuse()
    owned(args[1]).replace(owned(args[2]))
elif name=='docker':
    if args[:3]==['inspect','--format','{{index .Config.Labels "com.docker.compose.project.config_files"}}'] and args[3:]==['commonswarm-oauth-oauth-1']:
        base=str(root/'oauth/releases'/cfg['baseline']/'deploy/mcp-auth')
        output(base+'/compose.yaml,'+base+'/compose.management.yaml'+(','+base+'/compose.admin-issuer.yaml' if cfg.get('overlay') else ''))
    elif args==['image','ls','--no-trunc','--quiet','--filter','reference=commonswarm-oauth:release-'+cfg['sha']]: output(cfg.get('cached',''))
    elif args==['info','--format','{{.CPUCfsPeriod}} {{.CPUCfsQuota}}']: output(cfg.get('cpu','true true'))
    elif args[:4]==['image','inspect','--format','{{.Id}}'] and args[4:]==['commonswarm-oauth:release-'+cfg['sha']]: output(cfg['image'])
    elif args==['image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',cfg['image']]: output(cfg.get('label',cfg['sha']))
    elif args and args[0]=='build':
        expected=['build','--pull=false','--cpu-period=100000','--cpu-quota=300000','--tag','commonswarm-oauth:release-'+cfg['sha'],'--label','org.opencontainers.image.revision='+cfg['sha'],'--file',str(root/'oauth/releases'/cfg['sha']/'services/mcp-auth/Dockerfile'),str(root/'oauth/releases'/cfg['sha'])]
        if args!=expected or os.environ.get('DOCKER_BUILDKIT')!='0': refuse()
    elif args[:4]==['run','--rm','--network','none']:
        if args[4:9]!=['--entrypoint','node',cfg['image'],'--input-type=module','-e'] or len(args)!=10: refuse()
    elif args[:4]==['run','--rm','--network','commonswarm-net']:
        expected=['run','--rm','--network','commonswarm-net','--add-host','db.commonswarm.internal:172.31.0.10','--env','PGSERVICE=target','--env','PGSERVICEFILE=/run/service.conf','--env','PGPASSFILE=/run/pass','--volume',str(root/'stage/issuer-service.conf')+':/run/service.conf:ro','--volume',str(root/'stage/issuer-pass')+':/run/pass:ro','--volume','/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro','--entrypoint','psql','fixture-postgres','-X','--set=ON_ERROR_STOP=1','-Atq','--command',"SELECT current_user='commonswarm_admin_issuer' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;"]
        if args!=expected: refuse()
        if cfg.get('tls_failed'): raise SystemExit(1)
        output(cfg.get('login','t'))
    elif args and args[0]=='compose':
        base=str(root/'oauth/releases'/cfg['sha']/'deploy/mcp-auth')
        expected=['compose','--project-name','commonswarm-oauth','--env-file',str(root/'etc/commonswarm-oauth/compose.env'),'-f',base+'/compose.yaml','-f',base+'/compose.management.yaml','up','-d','--no-build','--pull','never','--force-recreate','oauth']
        if args!=expected: refuse()
    elif args==['inspect','--format','{{.State.Health.Status}}','commonswarm-oauth-oauth-1']: output('healthy')
    elif args==['inspect','--format','{{.Image}}','commonswarm-oauth-oauth-1']: output(cfg.get('running_image',cfg['image']))
    else: refuse()
else: refuse()
`;

function fixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(scratch, 'case-'));
  const bin = join(root, 'bin'), proof = join(root, 'proof'), stage = join(root, 'stage');
  for (const dir of [bin, proof, stage, join(root, 'etc/commonswarm-oauth'), join(root, 'backup'), join(root, 'release/deploy/mcp-auth'), join(root, 'oauth/releases', baseline, 'deploy/mcp-auth')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (path: string, value: unknown) => writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  put('commands.json', { sha, baseline, image, ...config }); put('argv.jsonl', '');
  put('inputs.json', { release_sha: sha, window_id: 'fixture', window: 'W3', baseline_oauth_sha: baseline });
  put('proof/ordinary-before.json', '{}'); put('proof/schema-committed.txt', 'PASS');
  put('etc/commonswarm-oauth/service.env', 'MCP_OAUTH_ENABLED=1\n'); put('stage/service.env', 'MCP_OAUTH_ENABLED=1\n');
  put('etc/commonswarm-oauth/compose.env', 'MCP_OAUTH_IMAGE=baseline\n'); put('stage/compose.env', 'MCP_OAUTH_IMAGE=baseline\n');
  put('stage/service.conf', '[target]\nhost=db.commonswarm.internal\nsslmode=verify-full\nsslrootcert=/etc/ssl/yulan-internal-ca.pem\nuser=fixture\n');
  put('stage/pass', 'db.commonswarm.internal:5432:fixture:fixture:synthetic\n');
  put('etc/commonswarm-oauth/protected-sibling', 'must survive');
  for (const file of ['compose.yaml', 'compose.management.yaml']) {
    put('release/deploy/mcp-auth/' + file, 'reviewed '+file);
    put('oauth/releases/'+baseline+'/deploy/mcp-auth/'+file, 'reviewed '+file);
  }
  for (const name of ['python3', 'ai_deadline', 'ai_ro', 'ai_db', 'openssl', 'chmod', 'install', 'stat', 'cat', 'cmp', 'mkdir', 'cp', 'rm', 'date', 'nice', 'timeout', 'ln', 'mv', 'docker']) {
    writeFileSync(join(bin, name), '#!'+python+'\n'+dispatcher, { mode: 0o700 });
  }
  const env = { ...process.env, PATH: bin, FIXTURE_ROOT: root, WINDOW: 'W3', PROOF_DIR: proof, SECRET_STAGE: stage,
    INPUTS_FILE: join(root, 'inputs.json'), LIVE_CONTROLS_FILE: join(root, 'controls.json'), RELEASE_SHA: sha,
    RELEASE_ROOT: join(root, 'release'), NEW_OAUTH: join(root, 'oauth/releases', sha), PSQL_IMAGE: 'fixture-postgres' };
  function run(steps: string[], window = 'W3') {
    let source = steps.map(block).join('\n');
    // Remap filesystem boundaries only. SQL, shell guards and Python assertions stay verbatim.
    for (const [from, to] of [
      ['/var/backups/commonswarm-postgres', join(root, 'backup')],
      ['/etc/commonswarm-oauth', join(root, 'etc/commonswarm-oauth')],
      ['/home/commonswarm/oauth', join(root, 'oauth')],
    ]) source = source.split(from!).join(to!);
    const result = spawnSync('/bin/bash', [], { input: source, env: { ...env, WINDOW: window }, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    const calls = readFileSync(join(root, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    // Hidden daemon/build logs must not disguise an unsupported fixture command.
    for (const path of ['stage/build.log', 'stage/recreate.log', 'stage/issuer-login.log']) {
      if (existsSync(join(root, path))) assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /UNMODELLED/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /UNMODELLED/);
    return { ...result, calls };
  }
  return { root, proof, put, run };
}
function pass(result: ReturnType<ReturnType<typeof fixture>['run']>) {
  assert.equal(result.status, 0, result.stderr);
}
function stopped(result: ReturnType<ReturnType<typeof fixture>['run']>, text: string) {
  assert.notEqual(result.status, 0, 'bad observation must refuse');
  assert.ok(result.stderr.includes(text), `expected block-owned ${text}; observed ${JSON.stringify(result.stderr)}`);
}
const backup = () => ({ ok: true, database_bytes_verified: true, object_bytes_verified: true, verified_at: new Date().toISOString(), destination: 'r2:yulan-vps-1-backups/000-commonswarm-postgres/fixture' });
const restore = () => ({ ok: true, state: 'complete', at: new Date().toISOString() });
function backupRun(b = backup(), r = restore()) {
  const f = fixture(); f.put('backup/status.json', b); f.put('backup/restore-status.json', r);
  return { f, result: f.run(['ai-w1-backup-gate'], 'W1') };
}
function backupBad(b: ReturnType<typeof backup>, r: ReturnType<typeof restore>, message: string) {
  const { f, result } = backupRun(b, r);
  assert.ok(!existsSync(join(f.proof, 'backup-gate.json')), 'no receipt after refusal');
  stopped(result, message);
}

test('backup-restore-gate / fresh-verified-database-and-object-backup: fails closed on unverified bytes or wrong destination', () => {
  const good = backupRun(); pass(good.result); assert.equal(JSON.parse(readFileSync(join(good.f.proof, 'backup-gate.json'), 'utf8')).status, 'PASS');
  for (const key of ['ok', 'database_bytes_verified', 'object_bytes_verified']) backupBad({ ...backup(), [key]: false }, restore(), 'FAIL verified backup; STOP');
  backupBad({ ...backup(), destination: 'r2:wrong/fixture' }, restore(), 'FAIL fresh backup; STOP');
});
test('backup-restore-gate / complete-isolated-restore-receipt: fails closed on failed or incomplete restore status', () => {
  pass(backupRun().result);
  backupBad(backup(), { ...restore(), ok: false }, 'FAIL complete restore drill; STOP');
  backupBad(backup(), { ...restore(), state: 'running' }, 'FAIL complete restore drill; STOP');
});
test('backup-restore-gate / stale-or-failed-status-refused: fails closed on stale, future or failed measurements', () => {
  pass(backupRun().result);
  for (const seconds of [-3600, 3600]) backupBad({ ...backup(), verified_at: new Date(Date.now()+seconds*1000).toISOString() }, restore(), 'FAIL fresh backup; STOP');
  for (const seconds of [-9*86400, 3600]) backupBad(backup(), { ...restore(), at: new Date(Date.now()+seconds*1000).toISOString() }, 'FAIL restore freshness; STOP');
  backupBad({ ...backup(), ok: false }, restore(), 'FAIL verified backup; STOP');
  backupBad(backup(), { ...restore(), ok: false }, 'FAIL complete restore drill; STOP');
});
const ordinaryKeys = ['hosted_mcp_consent_refresh', 'dcr_registration_consent', 'cimd_consent', 'human_recovery', 'worker_command_read'];
for (const key of ordinaryKeys) {
  test(`ordinary-paths-unchanged / ${key.replaceAll('_', '-')}: fails closed on false or missing measurement`, () => {
    for (const mode of ['good', 'false', 'missing']) {
      const f = fixture(), controls: Record<string, boolean> = Object.fromEntries(ordinaryKeys.map(k => [k, true]));
      if (mode === 'false') controls[key] = false;
      if (mode === 'missing') delete controls[key];
      f.put('controls.json', { release_sha: sha, window_id: 'fixture', window: 'W3', phase: 'after', controls });
      const result = f.run(['ai-live-controls']);
      if (mode === 'good') { pass(result); assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'ordinary-after.json'), 'utf8')).controls, controls); }
      else { assert.ok(!existsSync(join(f.proof, 'ordinary-after.json'))); stopped(result, 'FAIL live controls; STOP'); }
    }
  });
}
test('admin-issuer-credential-provisioning / failed-provisioning-nologin-clear-password-guarded-file-removal: fails closed when guarded cleanup refuses', () => {
  for (const refused of [false, true]) {
    const f = fixture({ cleanup_refused: refused }); f.put('etc/commonswarm-oauth/admin-issuer-database-credentials', 'synthetic fixture');
    const result = f.run(['ai-w2-issuer-rollback'], 'W2');
    assert.equal(readFileSync(join(f.root, 'applied.sql'), 'utf8'), 'ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;');
    assert.deepEqual(result.calls.filter(c => c[0] === 'rm'), [['rm', '--', join(f.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials')]]);
    assert.equal(readFileSync(join(f.root, 'etc/commonswarm-oauth/protected-sibling'), 'utf8'), 'must survive');
    if (refused) {
      assert.ok(existsSync(join(f.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials')));
      assert.ok(!existsSync(join(f.proof, 'issuer-rollback.txt'))); assert.ok(!result.calls.some(c => c[0] === 'ai_ro'));
      stopped(result, 'FAIL guarded issuer cleanup refused; STOP');
    } else { pass(result); assert.ok(!existsSync(join(f.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials'))); assert.ok(existsSync(join(f.proof, 'issuer-rollback.txt'))); }
  }
  // The complete block's own symlink guard protects an unrelated target before rm.
  const f = fixture();
  const target = join(f.root, 'etc/commonswarm-oauth/protected-sibling');
  symlinkSync(target, join(f.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials'));
  const result = f.run(['ai-w2-issuer-rollback'], 'W2'); assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some(c => c[0] === 'rm')); assert.ok(!existsSync(join(f.proof, 'issuer-rollback.txt')));
  assert.equal(readFileSync(target, 'utf8'), 'must survive');
});

// Complete-block diagnostics must identify the failed measurement without
// printing protected values. Each positive control still runs first.
test('release-plan-contract / w3-unset-env-overlay-absent: fails closed on set admin keys or active issuer overlay', () => {
  const good = fixture(); pass(good.run(['ai-w3-preflight']));
  for (const key of ['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED', 'MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE']) {
    const f = fixture(); f.put('etc/commonswarm-oauth/service.env', 'MCP_OAUTH_ENABLED=1\n'+key+'=fixture\n');
    const result = f.run(['ai-w3-preflight']);
    assert.ok(!existsSync(join(f.root, 'oauth/releases', sha))); assert.ok(!result.calls.some(c => c[0] === 'cp'));
    stopped(result, 'FAIL W3 admin env must be unset; STOP');
  }
  const f = fixture({ overlay: true });
  f.put('oauth/releases/'+baseline+'/deploy/mcp-auth/compose.admin-issuer.yaml', 'active overlay');
  const result = f.run(['ai-w3-preflight']); assert.ok(!result.calls.some(c => c[0] === 'cp'));
  assert.ok(!existsSync(join(f.root, 'oauth/releases', sha)));
  stopped(result, 'FAIL ai-w3-preflight: active Compose files expected baseline-base-and-management got mismatch; STOP');
});
test('admin-issuer-credential-provisioning / dedicated-role-tls-login-positive: fails closed on bad issuer role or TLS login', () => {
  const good = fixture(); const positive = good.run(['ai-w2-issuer-credential'], 'W2'); pass(positive);
  assert.ok(existsSync(join(good.proof, 'issuer-credential.txt')));
  assert.match(readFileSync(join(good.root, 'stage/issuer-service.conf'), 'utf8'), /sslmode = verify-full/);
  assert.match(readFileSync(join(good.root, 'stage/issuer-service.conf'), 'utf8'), /user = commonswarm_admin_issuer/);
  for (const [config, message] of [
    [{ login: 'f' }, 'FAIL ai-w2-issuer-credential: dedicated-role measurement expected t got non-t; STOP'],
    [{ tls_failed: true }, 'FAIL ai-w2-issuer-credential: TLS psql login exit status expected 0 got 1; STOP'],
  ] as const) {
    const f = fixture(config), result = f.run(['ai-w2-issuer-credential'], 'W2');
    assert.ok(!existsSync(join(f.proof, 'issuer-credential.txt')));
    assert.ok(result.calls.some(c => c[0] === 'docker' && c.includes('psql')));
    stopped(result, message);
  }
});
test('oauth-build-route / cpu-capped-build-once-source-label: fails closed on unsupported CPU caps or wrong source label', () => {
  const good = fixture(); const positive = good.run(['ai-w3-build']); pass(positive);
  assert.equal(positive.calls.filter(c => c[0] === 'docker' && c[1] === 'build').length, 1);
  assert.equal(readFileSync(join(good.proof, 'oauth-image.id'), 'utf8').trim(), image);
  const cached = fixture({ cached: image }); const cachedResult = cached.run(['ai-w3-build']); pass(cachedResult);
  assert.equal(cachedResult.calls.filter(c => c[0] === 'docker' && c[1] === 'build').length, 0);
  for (const [config, message] of [
    [{ cpu: 'false false' }, 'FAIL ai-w3-build: CPU cap support expected true-true got unsupported; STOP'],
    [{ label: 'e'.repeat(40) }, 'FAIL ai-w3-build: image source label expected release-sha got mismatch; STOP'],
  ] as const) {
    const f = fixture(config), result = f.run(['ai-w3-build']);
    assert.ok(!existsSync(join(f.proof, 'oauth-image.id')));
    assert.ok(!result.calls.some(c => c[0] === 'docker' && c[1] === 'run'));
    if ('cpu' in config) assert.ok(!result.calls.some(c => c[0] === 'docker' && c[1] === 'build'));
    stopped(result, message);
  }
});
test('oauth-build-route / ordinary-on-config: fails closed on baseline Compose drift or service env drift before apply', () => {
  const good = fixture(); good.put('proof/oauth-image.id', image); const positive = good.run(['ai-w3-preflight', 'ai-w3-apply']); pass(positive);
  assert.equal(positive.calls.filter(c => c[0] === 'docker' && c[1] === 'compose').length, 1);
  assert.equal(readFileSync(join(good.root, 'etc/commonswarm-oauth/service.env'), 'utf8'), 'MCP_OAUTH_ENABLED=1\n');
  for (const file of ['compose.yaml', 'compose.management.yaml']) {
    const preflight = fixture(); preflight.put('oauth/releases/'+baseline+'/deploy/mcp-auth/'+file, 'unreviewed config');
    const before = preflight.run(['ai-w3-preflight', 'ai-w3-apply']);
    assert.ok(!existsSync(join(preflight.proof, 'oauth-attempted.txt'))); assert.ok(!before.calls.some(c => c[0] === 'cp' || c[0] === 'install' || (c[0] === 'docker' && c[1] === 'compose')));
    stopped(before, `FAIL ai-w3-preflight: ${file} bytes expected identical got different-or-unreadable; STOP`);
  }
  for (const file of ['compose.env', 'service.env']) {
    const apply = fixture(); apply.put('proof/oauth-image.id', image); pass(apply.run(['ai-w3-preflight']));
    apply.put('etc/commonswarm-oauth/'+file, 'unreviewed env\n');
    const after = apply.run(['ai-w3-apply']);
    assert.ok(!existsSync(join(apply.proof, 'oauth-attempted.txt'))); assert.ok(!after.calls.some(c => c[0] === 'install' || (c[0] === 'docker' && c[1] === 'compose')));
    stopped(after, `FAIL ai-w3-apply: ${file} bytes expected identical got different-or-unreadable; STOP`);
  }
});
test('oauth-build-route / local-gate-closed: fails closed on open or non-JSON gate', () => {
  const good = fixture(); pass(good.run(['ai-w3-local-gate'])); assert.equal(readFileSync(join(good.proof, 'W3-probes.txt'), 'utf8'), 'PASS\n');
  for (const [gate_body, message] of [
    ['{"state":"open"}', 'FAIL ai-w3-local-gate: gate status/body expected HTTP-200-and-closed got mismatch; STOP'],
    ['not-json', 'FAIL ai-w3-local-gate: gate body expected JSON got non-JSON; STOP'],
  ]) {
    const f = fixture({ gate_body }), result = f.run(['ai-w3-local-gate']);
    assert.ok(!existsSync(join(f.proof, 'W3-probes.txt'))); stopped(result, message!);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
});

// Cleanup goes through the host's PATH-first rm guard, only for our own resolved root.
after(() => {
  assert.equal(dirname(scratch), realpathSync(tmpdir()));
  assert.match(basename(scratch), /^admin-live-w123-[A-Za-z0-9]{6}$/);
  assert.equal(realpathSync(scratch), scratch);
  const home = realpathSync(homedir());
  assert.ok(scratch !== home && !scratch.startsWith(home + '/'));
  const removed = spawnSync('rm', ['-r', '--', scratch], {
    encoding: 'utf8', env: { ...process.env, PATH: join(homedir(), '.local/bin') + ':' + process.env.PATH },
  });
  assert.equal(removed.status, 0, `guard refused cleanup ${scratch}: ${removed.stderr}`);
});
