/** Execute complete marked release blocks; substitute only box paths and command observations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
const sha = 'a'.repeat(40), baseline = 'b'.repeat(40), image = 'sha256:' + 'c'.repeat(64), baselineImage = 'sha256:' + 'e'.repeat(64);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'admin-live-w123-')));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Test-data stand-in for the released producer; it is never written under repo scripts/.
const producerSource = 'export const fixtureProducer = "live-ordinary-controls";\n';

// Each command records argv before returning independent fixture observations.
// PATH contains only these stubs; unmodelled invocations fail, never reach a daemon.
const dispatcher = String.raw`
import builtins,hashlib,io,json,os,pathlib,random,re,shutil,string,subprocess,sys,urllib.request
root=pathlib.Path(os.environ['FIXTURE_ROOT']); cfg=json.loads((root/'commands.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'argv.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
def refuse(): raise SystemExit('UNMODELLED '+name+' '+repr(args))
def owned(value):
    p=pathlib.Path(value)
    if not p.is_absolute() or not str(p).startswith(str(root)+'/'): refuse()
    return p
def output(value): print(value)
if name=='node':
    raise SystemExit(97) # Positive-control boundary: ai-db-session reached its first credential operation.
elif name=='python3':
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
    if 'W2 ledger expected no complete 20261003 set before open' in source:
        source=source.replace("n=subprocess.check_output(['/bin/bash','-s','--',sha,image],input=query,text=True,stderr=subprocess.DEVNULL).strip()","n='0'")
    exec(compile(source,'<complete-plan-block>','exec'))
elif name=='ai_deadline':
    if args: refuse()
elif name=='ai_ro':
    if args==['-Atq','--command','SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;']:
        output(cfg['w2b_ledger']); raise SystemExit(0)
    if args==['-Atq','--command','SELECT version,sha256,source,released_sha FROM commonswarm_ops.migration_checksums ORDER BY version;']:
        output(cfg['w2b_checksums']); raise SystemExit(0)
    if args==['-Atq','--file','/proof/catalog.sql']:
        text=(root/'proof/catalog.sql').read_text()
        ok=re.fullmatch(re.escape(chr(92))+r"i /release/deploy/release-proofs/item-ai/(2026100300000[1-5])-catalog\.sql\nSELECT :'catalog_ok'::boolean;\n",text)
        if ok: output(cfg.get('catalog_ok',{}).get(ok.group(1),'t')); raise SystemExit(0)
        m=re.fullmatch(re.escape(chr(92))+r"i /release/deploy/release-proofs/item-ai/(2026100300000[1-5])-catalog\.sql\nSELECT :'catalog_ok_failed_checks';\n",text)
        if not m: refuse()
        output(cfg.get('catalog_failed',{}).get(m.group(1),'')); raise SystemExit(0)
    if args==['-Atq','--file','/proof/w2b-preconditions.sql']:
        if not (root/'proof/w2b-preconditions.sql').read_text().startswith(chr(92)+'i /release/deploy/release-proofs/item-ai/w2b-preconditions.sql'): refuse()
        output(cfg.get('w2b','t')); raise SystemExit(0)
    if len(args)!=3 or args[:2]!=['-Atq','--command']: refuse()
    if args[2]=="SELECT rolcanlogin AND rolpassword IS NOT NULL FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';":
        output(cfg.get('issuer_login','t')); raise SystemExit(0)
    if args[2]=='SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;':
        output(cfg.get('readonly','t')); raise SystemExit(0)
    if 'pg_authid' in args[2] and "rolname='commonswarm_admin_issuer'" in args[2] and 'rolpassword IS NULL' in args[2]:
        if cfg.get('readback_failed'): raise SystemExit(1)
        output(cfg.get('readback','t')); raise SystemExit(0)
    refuse()
elif name=='ai_db_secret_file':
    # The plan's mounted-file helper: the SQL file (in the stage) reaches the database; stdin is never read.
    if len(args)!=1: refuse()
    sql=owned(args[0]).read_text()
    if sql.startswith('SELECT rolcanlogin AND rolpassword='):
        # Readback state model: t only if THIS verifier is the one the database holds.
        held=re.search(r"LOGIN PASSWORD '([^']*)'",(root/'applied.sql').read_text()) if (root/'applied.sql').exists() else None
        asked=re.search(r"rolpassword='([^']*)'",sql)
        output('t' if held and asked and held.group(1)==asked.group(1) else 'f')
    elif sql.startswith('ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD '):
        if not cfg.get('secret_file_noop'): (root/'applied.sql').write_text(sql)
    else: refuse()
elif name=='ai_db':
    if args==['-q','--file','-']:
        # The box's docker run has no -i: stdin never reaches psql, which runs nothing and exits 0.
        pass
    elif args==['-q','--command','ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;']:
        if cfg.get('alter_failed'): raise SystemExit(1)
        (root/'applied.sql').write_text(args[2])
    else: refuse()
elif name=='openssl':
    if args!=['rand','-hex','32']: refuse()
    output('d'*64) # Synthetic fixture, never a generated/live credential.
elif name=='chmod':
    if len(args)<2 or args[0] not in ('0600','0700'): refuse()
    for value in args[1:]: owned(value).chmod(int(args[0],8))
elif name=='install' and args[:1]==['-d']:
    if args!=['-d','-o','root','-g','root','-m','0700',str(root/'oauth/failed-attempts')]: refuse()
    if cfg.get('aside_install_failed'): raise SystemExit(1)
    owned(args[7]).mkdir(exist_ok=True); owned(args[7]).chmod(0o700)
elif name=='install' and len(args)==4 and args[:2]==['-m','0600']:
    target=owned(args[3]); shutil.copyfile(owned(args[2]),target); target.chmod(0o600)
elif name=='install':
    if len(args)!=8 or args[:2]!=['-o','root'] or args[2]!='-g' or args[4]!='-m': refuse()
    if (args[3],args[5]) not in [('986','0440'),('root','0600')]: refuse()
    target=owned(args[7]); target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(owned(args[6]),target); target.chmod(int(args[5],8))
elif name=='stat' and len(args)==3 and args[:2]==['-c','%a']:
    output(format(owned(args[2]).stat().st_mode & 0o777,'o'))
elif name=='sha256sum':
    if len(args)!=1: refuse()
    output(hashlib.sha256(owned(args[0]).read_bytes()).hexdigest()+'  '+args[0])
elif name=='awk':
    if args!=['{print $1}']: refuse()
    for line in sys.stdin: output(line.split()[0])
elif name=='mktemp':
    if len(args)!=2 or args[0]!='-d' or not args[1].endswith('.XXXXXX'): refuse()
    created=owned(args[1][:-6]+''.join(random.choice(string.ascii_letters+string.digits) for _ in range(6)))
    created.mkdir(mode=0o700); output(created)
elif name=='stat' and args==['-c','%a %u %g',str(root/'oauth/failed-attempts')]:
    # Ownership boundary: a non-root test cannot chown to 0:0; the mode is measured, the owner is the fixture's word.
    output(format(owned(args[2]).stat().st_mode & 0o777,'o')+' '+cfg.get('aside_owner','0 0'))
elif name=='stat':
    if args!=['-c','%a %u %g',str(root/'etc/commonswarm-oauth/admin-issuer-database-credentials')]: refuse()
    if not owned(args[2]).is_file(): refuse()
    output(cfg.get('credential_mode','440 0 986'))
elif name=='cat':
    if len(args)!=1: refuse()
    sys.stdout.write(owned(args[0]).read_text())
elif name=='cmp':
    if len(args)!=3 or args[0]!='-s': refuse()
    raise SystemExit(0 if owned(args[1]).read_bytes()==owned(args[2]).read_bytes() else 1)
elif name=='mkdir':
    if len(args)!=2 or args[0]!='-p': refuse()
    owned(args[1]).mkdir(parents=True,exist_ok=True)
elif name=='cp' and len(args)==2:
    shutil.copyfile(owned(args[0]),owned(args[1]))
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
    # The plan uses -sfT: an existing temporary link is replaced, never followed.
    if len(args)!=3 or args[0]!='-sfT': refuse()
    link=owned(args[2])
    if link.is_symlink(): link.unlink()
    elif link.exists(): raise SystemExit(1)
    link.symlink_to(owned(args[1]),target_is_directory=True)
elif name=='readlink':
    if len(args)!=2 or args[0]!='-f': refuse()
    output(os.path.realpath(owned(args[1])))
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
        prefix='issuer-live-' if str(root/'stage/issuer-live-service.conf') in ' '.join(args) else 'issuer-'
        expected=['run','--rm','--network','commonswarm-net','--add-host','db.commonswarm.internal:172.31.0.10','--env','PGSERVICE=target','--env','PGSERVICEFILE=/run/service.conf','--env','PGPASSFILE=/run/pass','--volume',str(root/('stage/'+prefix+'service.conf'))+':/run/service.conf:ro','--volume',str(root/('stage/'+prefix+'pass'))+':/run/pass:ro','--volume','/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro','--entrypoint','psql','fixture-postgres','-X','--set=ON_ERROR_STOP=1','-Atq','--command',"SELECT current_user='commonswarm_admin_issuer' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;"]
        if args!=expected: refuse()
        if cfg.get('tls_failed'): raise SystemExit(1)
        output(cfg.get('login','t'))
    elif args==['inspect','--format','{{index .Config.Labels "com.docker.compose.project.working_dir"}}','commonswarm-oauth-oauth-1']:
        output(cfg.get('working_dir',str(os.path.realpath(root/'oauth/current'))+'/deploy/mcp-auth'))
    elif args and args[0]=='compose' and str(root/'oauth/releases'/cfg['baseline']) in ' '.join(args):
        base=str(root/'oauth/releases'/cfg['baseline']/'deploy/mcp-auth')
        expected=['compose','--project-name','commonswarm-oauth','--env-file',str(root/'etc/commonswarm-oauth/compose.env'),'-f',base+'/compose.yaml','-f',base+'/compose.management.yaml','up','-d','--no-build','--pull','never','--force-recreate','oauth']
        if args!=expected: refuse()
        if cfg.get('rollback_compose_failed'): raise SystemExit(1)
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
  for (const dir of [bin, proof, stage, join(root, 'etc/commonswarm-oauth'), join(root, 'backup'), join(root, 'release/deploy/mcp-auth'), join(root, 'release/scripts'), join(root, 'oauth/releases', baseline, 'deploy/mcp-auth'), join(root, 'archive'), join(root, 'tmp'), join(root, 'mac-anvil-secret'), join(root, 'caddy')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (path: string, value: unknown) => writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  put('commands.json', { sha, baseline, image, ...config }); put('argv.jsonl', '');
  put('proof/schema-committed.txt', 'PASS');
  put('etc/commonswarm-oauth/service.env', 'MCP_OAUTH_ENABLED=1\n'); put('stage/service.env', 'MCP_OAUTH_ENABLED=1\n');
  put('etc/commonswarm-oauth/compose.env', 'MCP_OAUTH_IMAGE=baseline\n'); put('stage/compose.env', 'MCP_OAUTH_IMAGE=baseline\n');
  put('stage/service.conf', '[target]\nhost=db.commonswarm.internal\nsslmode=verify-full\nsslrootcert=/etc/ssl/yulan-internal-ca.pem\nuser=fixture\n');
  put('stage/pass', 'db.commonswarm.internal:5432:fixture:fixture:synthetic\n');
  put('etc/commonswarm-oauth/protected-sibling', 'must survive');
  for (const file of ['compose.yaml', 'compose.management.yaml']) {
    put('release/deploy/mcp-auth/' + file, 'reviewed '+file);
    put('oauth/releases/'+baseline+'/deploy/mcp-auth/'+file, 'reviewed '+file);
  }
  put('release/scripts/live-ordinary-controls.mjs', producerSource);
  // The live OAuth current points at the baseline release (ai-box-preflight measures this before open).
  symlinkSync(join(root, 'oauth/releases', baseline), join(root, 'oauth/current'));
  // The verified release archive is the only producer source; inputs carry its digest.
  const archive = join(root, 'archive/release.tar');
  function buildArchive(producer: string | null, bindInputs = true) {
    const members = producer === null ? [] : ['scripts/live-ordinary-controls.mjs'];
    if (producer !== null) put('release/scripts/live-ordinary-controls.mjs', producer);
    const made = spawnSync(python, ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    [t.add(sys.argv[2]+"/"+m,arcname=m) for m in sys.argv[3:]]', archive, join(root, 'release'), ...members], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr); chmodSync(archive, 0o600);
    if (bindInputs) put('inputs.json', { release_sha: sha, window_id: 'fixture', window: 'W3', baseline_oauth_sha: baseline, baseline_oauth_image: baselineImage, archive_sha256: digest(readFileSync(archive)), plan_sha256: digest(plan) });
  }
  buildArchive(producerSource);
  // A valid opening pair, as ai-open retains it.
  const preText = JSON.stringify(consentReceipt('pre-W1'));
  put('proof/consent-pre-W1.json', preText); put('proof/ordinary-before.json', liveReceipt('W3', 'fixture', 'before', preText));
  for (const name of ['python3', 'ai_deadline', 'ai_ro', 'ai_db', 'ai_db_secret_file', 'openssl', 'chmod', 'install', 'stat', 'cat', 'cmp', 'mkdir', 'cp', 'rm', 'date', 'nice', 'timeout', 'ln', 'mv', 'docker', 'sha256sum', 'awk', 'mktemp', 'node', 'readlink']) {
    writeFileSync(join(bin, name), '#!'+python+'\n'+dispatcher, { mode: 0o700 });
  }
  const env = { ...process.env, PATH: bin, FIXTURE_ROOT: root, WINDOW: 'W3', PROOF_DIR: proof, SECRET_STAGE: stage,
    INPUTS_FILE: join(root, 'inputs.json'), LIVE_CONTROLS_FILE: join(root, 'controls.json'), CONSENT_RECEIPT_FILE: join(root, 'consent.json'), RELEASE_SHA: sha,
    BOX_ARCHIVE_PATH: archive, PLAN_FILE: resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'),
    RELEASE_ROOT: join(root, 'release'), NEW_OAUTH: join(root, 'oauth/releases', sha), PSQL_IMAGE: 'fixture-postgres' };
  function remap(text: string) {
    let source = text;
    // Remap filesystem boundaries only. SQL, shell guards and Python assertions stay verbatim.
    for (const [from, to] of [
      ['/tmp/admin-issuance-', join(root, 'archive/admin-issuance-')],
      ['/home/commonswarm/admin-issuance', join(root, 'admin-issuance')],
      ['/home/commonswarm/.env', join(root, 'home.env')],
      ['/etc/caddy/sites', join(root, 'caddy')],
      ['/private/tmp/anvil-secret', join(root, 'mac-anvil-secret')],
      ['/tmp/anvil-secret', join(root, 'tmp/anvil-secret')],
      ['/var/backups/commonswarm-postgres', join(root, 'backup')],
      ['/etc/commonswarm-oauth', join(root, 'etc/commonswarm-oauth')],
      ['/home/commonswarm/oauth', join(root, 'oauth')],
    ]) source = source.split(from!).join(to!);
    return source;
  }
  function run(steps: string[], window = 'W3', extra: Record<string, string | undefined> = {}) {
    // A step beginning with '#' is raw test source (a modelled shell function), not a plan block.
    const source = remap(steps.map(step => step.startsWith('#') ? step : block(step)).join('\n'));
    const runEnv: Record<string, string | undefined> = { ...env, WINDOW: window, ...extra };
    for (const key of Object.keys(runEnv)) if (runEnv[key] === undefined) delete runEnv[key];
    const result = spawnSync('/bin/bash', [], { input: source, env: runEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    const calls = readFileSync(join(root, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    // Hidden daemon/build logs must not disguise an unsupported fixture command.
    for (const path of ['stage/build.log', 'stage/recreate.log', 'stage/issuer-login.log']) {
      if (existsSync(join(root, path))) assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /UNMODELLED/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /UNMODELLED/);
    return { ...result, calls };
  }
  return { root, proof, put, run, remap, buildArchive, archive, preText };
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
// The shared backup receipt validator, executed from plan bytes through a test ai_run (the box's ai_run evals it the same way).
const gateShim = `# test shim: ai_run runs the plan's own ai-backup-gate-check block
ai_run() { test "$1" = ai-backup-gate-check || return 1; eval "$(cat "$FIXTURE_ROOT/gate-check.sh")"; }`;
function gateWindow(f: ReturnType<typeof fixture>, window: string) {
  const inputs = { ...JSON.parse(readFileSync(join(f.root, 'inputs.json'), 'utf8')), window,
    window_end_utc: new Date(Date.now() + 1_200_000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  f.put('inputs.json', inputs); f.put('proof/inputs.json', inputs);
  f.put('proof/open.txt', new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n');
  f.put('gate-check.sh', block('ai-backup-gate-check'));
  return inputs as Record<string, string>;
}
// A bound receipt as ai-w1-backup-gate writes it (python json.dumps sort_keys).
function validGate(f: ReturnType<typeof fixture>, window: string, change: Record<string, unknown> = {}) {
  const inputs = gateWindow(f, window), now = Date.now(), at = (ms: number) => new Date(now - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const receipt: Record<string, unknown> = { status: 'PASS', release_sha: inputs.release_sha, window, window_id: inputs.window_id,
    backup_verified_at: at(600_000), restore_completed_at: at(86400_000), destination: 'r2:yulan-vps-1-backups/000-commonswarm-postgres/fixture', gate_at: at(60_000), ...change };
  f.put('proof/backup-gate.json', '{' + Object.keys(receipt).sort().map(k => JSON.stringify(k) + ': ' + JSON.stringify(receipt[k])).join(', ') + '}\n');
}
function backupRun(b = backup(), r = restore(), window = 'W1') {
  const f = fixture(); f.put('backup/status.json', b); f.put('backup/restore-status.json', r); gateWindow(f, window);
  return { f, result: f.run([gateShim, 'ai-w1-backup-gate'], window) };
}
function backupBad(b: ReturnType<typeof backup>, r: ReturnType<typeof restore>, message: string) {
  const { f, result } = backupRun(b, r);
  assert.ok(!existsSync(join(f.proof, 'backup-gate.json')), 'no receipt after refusal');
  stopped(result, message);
}

test('backup-restore-gate / shared-w1-w2b-w4: W2b and W4 run the same backup gate; stale, unverified or missing backups STOP', () => {
  for (const window of ['W2b', 'W4']) {
    const good = backupRun(backup(), restore(), window); pass(good.result);
    assert.equal(JSON.parse(readFileSync(join(good.f.proof, 'backup-gate.json'), 'utf8')).status, 'PASS', window);
    const bad: Array<[ReturnType<typeof backup>, ReturnType<typeof restore>, string]> = [
      [{ ...backup(), verified_at: new Date(Date.now() - 3600_000).toISOString() }, restore(), 'FAIL fresh backup; STOP'],
      [{ ...backup(), database_bytes_verified: false }, restore(), 'FAIL verified backup; STOP'],
      [{ ...backup(), object_bytes_verified: false }, restore(), 'FAIL verified backup; STOP'],
      [{ ...backup(), destination: 'r2:other-bucket/x' }, restore(), 'FAIL fresh backup; STOP'],
      [backup(), { ...restore(), at: new Date(Date.now() - 9 * 86400_000).toISOString() }, 'FAIL restore freshness; STOP'],
      [backup(), { ...restore(), state: 'running' }, 'FAIL complete restore drill; STOP'],
    ];
    for (const [b, r, message] of bad) {
      const { f, result } = backupRun(b, r, window); stopped(result, message);
      assert.ok(!existsSync(join(f.proof, 'backup-gate.json')), `${window}: no receipt after refusal`);
    }
    const missing = fixture(); gateWindow(missing, window); const gone = missing.run([gateShim, 'ai-w1-backup-gate'], window);
    stopped(gone, 'FAIL backup and restore status files; STOP'); assert.ok(!existsSync(join(missing.proof, 'backup-gate.json')));
  }
  for (const window of ['W2', 'W3', 'W5', 'W6']) {
    const { f, result } = backupRun(backup(), restore(), window);
    stopped(result, 'FAIL ai-w1-backup-gate: window expected W1-W2b-or-W4 got other; STOP'); assert.ok(!existsSync(join(f.proof, 'backup-gate.json')));
  }
});

test('backup-restore-gate / fresh-verified-database-and-object-backup: fails closed on unverified bytes or wrong destination', () => {
  const good = backupRun(); pass(good.result); assert.equal(JSON.parse(readFileSync(join(good.f.proof, 'backup-gate.json'), 'utf8')).status, 'PASS');
  // The receipt is bound to its window and carries the measured times, the destination and the gate time.
  const receipt = JSON.parse(readFileSync(join(good.f.proof, 'backup-gate.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['backup_verified_at', 'destination', 'gate_at', 'release_sha', 'restore_completed_at', 'status', 'window', 'window_id']);
  assert.equal(receipt.window, 'W1'); assert.equal(receipt.release_sha, sha); assert.equal(receipt.window_id, 'fixture');
  assert.match(good.result.stdout, /PASS ai-backup-gate-check: W1 fixture backup and restore fresh at gate /);
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
// C1 live ordinary controls (SCHEMA section 3): every ordinary-paths-unchanged
// receipt is bound to a release consent receipt and the released producer bytes.
const ordinaryKeys = ['hosted_mcp_consent_refresh', 'dcr_registration_consent', 'cimd_consent', 'human_recovery', 'worker_command_read'];
const producerSha = digest(producerSource);
type Json = Record<string, unknown>;
const inDays = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
const expiring = (ids: string[], days = 30) => ids.map(client_id => ({ client_id, expires_after: inDays(days) }));
function consentReceipt(phase: 'pre-W1' | 'post-W5', change: Json = {}): Json {
  return { kind: 'c1-consent', release_sha: sha, consent_phase: phase,
    measured_at: new Date(Date.now() - 60_000).toISOString(), producer_sha256: producerSha,
    controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dcr-fixture-1', 'dcr-fixture-2'],
    // Amendments A/B: post-W5 cleanup lists earlier clients left to expire, never this run's own.
    cleanup: phase === 'pre-W1' ? null : { grants_revoked: true, dcr_clients_expiring: expiring(['dcr-pre-w1-1', 'dcr-w4-before-1']) },
    ...change };
}
function liveReceipt(window: string, windowId: string, phase: string, consentText: string, change: Json = {}): Json {
  return { release_sha: sha, window_id: windowId, window, phase,
    controls: Object.fromEntries(ordinaryKeys.map(k => [k, true])),
    consent_receipt_sha256: digest(consentText), producer_sha256: producerSha, dcr_client_ids: ['dcr-fixture-3'], ...change };
}
// One complete ai-open run on a W1-W4 window through the existing-RELEASE_ROOT
// branch (Mac Python 3.9 lacks extractall(filter=)); every byte is still reconciled.
const openId = 'Abc123';
function openFixture(window: string, producer = producerSource, includeProducer = true) {
  const f = fixture();
  const planText = 'fixture release plan\n';
  const files: Array<[string, string]> = [['docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md', planText]];
  if (includeProducer) files.push(['scripts/live-ordinary-controls.mjs', producer]);
  const releaseRoot = join(f.root, 'admin-issuance/releases', sha);
  for (const [name, text] of files) { mkdirSync(dirname(join(releaseRoot, name)), { recursive: true }); f.put('admin-issuance/releases/'+sha+'/'+name, text); }
  f.put('admin-issuance/releases/'+sha+'/RELEASE_SHA', sha+'\n');
  mkdirSync(join(f.root, 'admin-issuance/release-proofs'), { recursive: true });
  const archive = join(f.root, 'archive', `admin-issuance-${sha}-${openId}.tar`);
  const made = spawnSync(python, ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    [t.add(sys.argv[i+1],arcname=sys.argv[i]) for i in range(2,len(sys.argv),2)]',
    archive, ...files.flatMap(([name]) => [name, join(releaseRoot, name)])], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  chmodSync(archive, 0o600);
  f.put('open-inputs.json', { release_sha: sha, window_id: openId, window, archive_sha256: digest(readFileSync(archive)), plan_sha256: digest(planText), baseline_postgres_image: image });
  f.put('gates.json', '{}'); f.put('home.env', 'EDGE=fixture\n');
  for (const name of ['20-commonswarm-mcp.caddy', '10-commonswarm-api.caddy']) f.put('caddy/'+name, 'fixture '+name);
  const proof = join(f.root, 'admin-issuance/release-proofs', `${sha}-${window}-${openId}`);
  function open(consent: Json | string | null, live: Json, extra: Record<string, string | undefined> = {}) {
    if (consent !== null) f.put('consent.json', typeof consent === 'string' ? consent : JSON.stringify(consent));
    f.put('controls.json', live);
    return f.run(['ai-open'], window, { INPUTS_FILE: join(f.root, 'open-inputs.json'), GATE_RECEIPT_FILE: join(f.root, 'gates.json'), PLAN_FILE: join(f.root, 'unused-plan'), ...extra });
  }
  return { f, proof, open };
}
function openPair(window: string, phase: 'pre-W1' | 'post-W5', consentChange: Json = {}, liveChange: Json = {}) {
  const text = JSON.stringify(consentReceipt(phase, consentChange));
  return { text, live: liveReceipt(window, openId, 'before', text, liveChange) };
}
function openRefused(o: ReturnType<typeof openFixture>, result: ReturnType<ReturnType<typeof fixture>['run']>, message: string) {
  stopped(result, message);
  assert.doesNotMatch(result.stderr, /Traceback/);
  assert.ok(!existsSync(o.proof), 'no proof directory after refusal');
  assert.ok(!result.calls.some(c => ['mkdir', 'install', 'mktemp', 'cp', 'date'].includes(c[0]!)), 'no later open side effect');
}
function openGood(window: string, phase: 'pre-W1' | 'post-W5') {
  const o = openFixture(window), { text, live } = openPair(window, phase);
  const result = o.open(text, live); pass(result);
  assert.equal(readFileSync(join(o.proof, `consent-${phase}.json`), 'utf8'), text, 'exact consent bytes retained');
  assert.deepEqual(JSON.parse(readFileSync(join(o.proof, 'ordinary-before.json'), 'utf8')), live);
  assert.match(result.stdout, /PASS ai-open/);
}
// ai-live-controls reads the producer from the release archive, re-verified against archive_sha256.
function liveRun(window: string, phase: string, consent: Json | string, change: Json = {}, retained?: string) {
  const f = fixture(), text = typeof consent === 'string' ? consent : JSON.stringify(consent);
  f.put('consent.json', text); f.put('inputs.json', { release_sha: sha, window_id: 'fixture', window, archive_sha256: digest(readFileSync(f.archive)), plan_sha256: digest(plan) });
  f.put('controls.json', liveReceipt(window, 'fixture', phase, text, change));
  for (const name of ['ordinary-before.json', 'consent-pre-W1.json']) unlinkSync(join(f.proof, name));
  if (retained !== undefined) f.put('proof/'+retained.split('\n')[0], retained.split('\n').slice(1).join('\n'));
  return { f, text, result: f.run(['ai-live-controls'], window) };
}
function liveRefused(run: ReturnType<typeof liveRun>, phase: string, message: string) {
  stopped(run.result, message); assert.doesNotMatch(run.result.stderr, /Traceback/);
  assert.ok(!existsSync(join(run.f.proof, `ordinary-${phase}.json`)), 'no ordinary receipt after refusal');
  for (const name of ['consent-pre-W1.json', 'consent-post-W5.json']) assert.ok(!existsSync(join(run.f.proof, name)), 'no consent copy after refusal');
}

for (const key of ordinaryKeys) {
  test(`ordinary-paths-unchanged / ${key.replaceAll('_', '-')}: fails closed on false or missing measurement`, () => {
    for (const mode of ['good', 'false', 'missing']) {
      const controls: Record<string, boolean> = Object.fromEntries(ordinaryKeys.map(k => [k, true]));
      if (mode === 'false') controls[key] = false;
      if (mode === 'missing') delete controls[key];
      const run = liveRun('W3', 'after', consentReceipt('pre-W1'), { controls });
      if (mode === 'good') {
        pass(run.result); assert.deepEqual(JSON.parse(readFileSync(join(run.f.proof, 'ordinary-after.json'), 'utf8')).controls, controls);
        assert.equal(readFileSync(join(run.f.proof, 'consent-pre-W1.json'), 'utf8'), run.text);
      } else liveRefused(run, 'after', mode === 'false' ? `FAIL ai-live-controls: live control ${key} expected true got false; STOP` : 'FAIL ai-live-controls: live control names expected five-ordinary-controls got other-set; STOP');
      // The same control is refused at open, before any proof directory exists.
      const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1', {}, { controls });
      const opened = o.open(text, live);
      if (mode === 'good') pass(opened);
      else openRefused(o, opened, mode === 'false' ? `FAIL ai-open: live control ${key} expected true got false; STOP` : 'FAIL ai-open: live control names expected five-ordinary-controls got other-set; STOP');
    }
  });
}
test('ordinary-paths-unchanged / consent-receipt-binding: ai-open refuses a missing, foreign, unbound or stale consent receipt', () => {
  openGood('W1', 'pre-W1'); openGood('W2', 'pre-W1');
  // Positive control for the freshness scope: a 7 h old pre-W1 receipt is accepted at W2 open.
  { const o = openFixture('W2'), { text, live } = openPair('W2', 'pre-W1', { measured_at: new Date(Date.now() - 7 * 3600_000).toISOString() }); pass(o.open(text, live)); }
  const cases: Array<[string, string, Json, Json, string]> = [
    ['W1', 'pre-W1', { release_sha: 'e'.repeat(40) }, {}, 'FAIL ai-open: consent release_sha expected input-release-sha got mismatch; STOP'],
    ['W2', 'post-W5', {}, {}, 'FAIL ai-open: consent_phase for W2 before expected pre-W1 got post-W5; STOP'],
    ['W1', 'pre-W1', { measured_at: new Date(Date.now() - 7 * 3600_000).toISOString() }, {}, 'FAIL ai-open: pre-W1 consent measured_at age expected at-most-6h got older; STOP'],
    ['W1', 'pre-W1', { measured_at: new Date(Date.now() + 3600_000).toISOString() }, {}, 'FAIL ai-open: pre-W1 consent measured_at expected not-future got future; STOP'],
    ['W1', 'pre-W1', { measured_at: '2026-10-03 12:00:00' }, {}, 'FAIL ai-open: consent measured_at expected UTC-ISO-8601-Z got other; STOP'],
    ['W1', 'pre-W1', { cleanup: { grants_revoked: true, dcr_clients_removed: [] } }, {}, 'FAIL ai-open: pre-W1 consent cleanup expected null got non-null; STOP'],
    ['W1', 'pre-W1', { kind: 'c1-other' }, {}, 'FAIL ai-open: consent kind expected c1-consent got other; STOP'],
    ['W1', 'pre-W1', { controls: { cimd_consent: true, dcr_registration_consent: false } }, {}, 'FAIL ai-open: consent control dcr_registration_consent expected true got false; STOP'],
    ['W1', 'pre-W1', { extra: 1 }, {}, 'FAIL ai-open: consent receipt keys expected exact-schema-set got other-set; STOP'],
    ['W1', 'pre-W1', {}, { consent_receipt_sha256: 'f'.repeat(64) }, 'FAIL ai-open: live consent_receipt_sha256 expected sha256-of-CONSENT_RECEIPT_FILE got mismatch; STOP'],
    ['W1', 'pre-W1', {}, { phase: 'after' }, 'FAIL ai-open: live phase expected before got after; STOP'],
    ['W1', 'pre-W1', {}, { window_id: 'Zzz999' }, 'FAIL ai-open: live window_id expected input-window-id got mismatch; STOP'],
    ['W1', 'pre-W1', {}, { dcr_client_ids: 'dcr-fixture-3' }, 'FAIL ai-open: live dcr_client_ids expected list-of-strings got other; STOP'],
  ];
  for (const [window, phase, consentChange, liveChange, message] of cases) {
    const o = openFixture(window), { text, live } = openPair(window, phase as 'pre-W1' | 'post-W5', consentChange, liveChange);
    openRefused(o, o.open(text, live), message);
  }
  { const o = openFixture('W1'), { live } = openPair('W1', 'pre-W1');
    openRefused(o, o.open(null, live, { CONSENT_RECEIPT_FILE: join(o.f.root, 'absent-consent.json') }), 'FAIL ai-open: CONSENT_RECEIPT_FILE expected absolute-regular-file got missing-or-not-regular; STOP');
    openRefused(o, o.open(null, live, { CONSENT_RECEIPT_FILE: undefined }), 'FAIL ai-open: CONSENT_RECEIPT_FILE expected absolute-regular-file got unset; STOP');
    openRefused(o, o.open(null, live, { LIVE_CONTROLS_FILE: undefined }), 'FAIL ai-open: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP'); }
  { const o = openFixture('W1'), { live } = openPair('W1', 'pre-W1');
    openRefused(o, o.open('not json', live), 'FAIL ai-open: CONSENT_RECEIPT_FILE JSON expected object got non-object; STOP'); }
});
test('ordinary-paths-unchanged / producer-binding: ai-open refuses receipts not produced by the archive script bytes', () => {
  openGood('W3', 'pre-W1');
  // The uploaded archive carries different script bytes than the ones that ran.
  { const o = openFixture('W1', 'export const other = 1;\n'), { text, live } = openPair('W1', 'pre-W1');
    openRefused(o, o.open(text, live), 'FAIL ai-open: live producer_sha256 expected sha256-of-released-script got mismatch; STOP'); }
  { const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1', { producer_sha256: 'f'.repeat(64) });
    openRefused(o, o.open(text, live), 'FAIL ai-open: consent producer_sha256 expected sha256-of-released-script got mismatch; STOP'); }
  { const o = openFixture('W1', producerSource, false), { text, live } = openPair('W1', 'pre-W1');
    openRefused(o, o.open(text, live), 'FAIL ai-open: scripts/live-ordinary-controls.mjs in BOX_ARCHIVE_PATH expected regular-file got missing; STOP'); }
});
test('ordinary-paths-unchanged / per-window-consent-phase: ai-live-controls binds W1-W4 and W5 before to pre-W1, W5 after/recovery and W6/W7 to post-W5 with Amendment A/B cleanup', () => {
  for (const [window, phase, consentPhase] of [['W1', 'after', 'pre-W1'], ['W4', 'recovery', 'pre-W1'], ['W5', 'before', 'pre-W1'], ['W5', 'after', 'post-W5'], ['W5', 'recovery', 'post-W5'], ['W6', 'before', 'post-W5'], ['W7', 'after', 'post-W5']] as const) {
    const run = liveRun(window, phase, consentReceipt(consentPhase)); pass(run.result);
    assert.equal(readFileSync(join(run.f.proof, `consent-${consentPhase}.json`), 'utf8'), run.text);
    assert.ok(existsSync(join(run.f.proof, `ordinary-${phase}.json`)));
  }
  const cleaned = (entries: unknown[]) => ({ cleanup: { grants_revoked: true, dcr_clients_expiring: entries } });
  const cases: Array<[string, string, Json | string, Json, string]> = [
    ['W5', 'after', consentReceipt('pre-W1'), {}, 'FAIL ai-live-controls: consent_phase for W5 after expected post-W5 got pre-W1; STOP'],
    ['W6', 'after', consentReceipt('pre-W1'), {}, 'FAIL ai-live-controls: consent_phase for W6 after expected post-W5 got pre-W1; STOP'],
    ['W2', 'after', consentReceipt('post-W5'), {}, 'FAIL ai-live-controls: consent_phase for W2 after expected pre-W1 got post-W5; STOP'],
    ['W5', 'after', consentReceipt('post-W5', { cleanup: null }), {}, 'FAIL ai-live-controls: post-W5 consent cleanup expected object got null-or-other; STOP'],
    ['W5', 'after', consentReceipt('post-W5', cleaned([])), {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring expected nonempty-list got other; STOP'],
    ['W6', 'after', consentReceipt('post-W5', cleaned(['dcr-pre-w1-1'])), {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring entry expected exact-client_id-and-expires_after got other; STOP'],
    ['W5', 'after', consentReceipt('post-W5', cleaned([{ ...expiring(['dcr-pre-w1-1'])[0], removed: true }])), {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring entry expected exact-client_id-and-expires_after got other; STOP'],
    ['W5', 'after', consentReceipt('post-W5', cleaned(expiring(['dcr-pre-w1-1', 'dcr-fixture-2']))), {}, 'FAIL ai-live-controls: post-W5 cleanup dcr_clients_expiring client_id expected not-own-dcr_client_id got own-id; STOP'],
    ['W7', 'after', consentReceipt('post-W5', cleaned(expiring(['dcr-pre-w1-1'], -1))), {}, 'FAIL ai-live-controls: post-W5 cleanup expires_after expected future got past-or-invalid; STOP'],
    ['W6', 'before', consentReceipt('post-W5', cleaned([{ client_id: 'dcr-pre-w1-1', expires_after: '2026-11-02' }])), {}, 'FAIL ai-live-controls: post-W5 cleanup expires_after expected UTC-ISO-8601-Z got other; STOP'],
    ['W7', 'after', consentReceipt('post-W5', { cleanup: { grants_revoked: true } }), {}, 'FAIL ai-live-controls: post-W5 consent cleanup expected object got null-or-other; STOP'],
    ['W5', 'after', consentReceipt('post-W5', { cleanup: { grants_revoked: true, dcr_clients_removed: ['dcr-pre-w1-1'] } }), {}, 'FAIL ai-live-controls: post-W5 consent cleanup expected object got null-or-other; STOP'],
    ['W5', 'recovery', consentReceipt('post-W5', { cleanup: { grants_revoked: false, dcr_clients_expiring: expiring(['dcr-pre-w1-1']) } }), {}, 'FAIL ai-live-controls: post-W5 cleanup grants_revoked expected true got non-true; STOP'],
    ['W3', 'after', consentReceipt('pre-W1', { release_sha: 'e'.repeat(40) }), {}, 'FAIL ai-live-controls: consent release_sha expected input-release-sha got mismatch; STOP'],
    ['W3', 'after', consentReceipt('pre-W1'), { consent_receipt_sha256: 'f'.repeat(64) }, 'FAIL ai-live-controls: live consent_receipt_sha256 expected sha256-of-CONSENT_RECEIPT_FILE got mismatch; STOP'],
    ['W3', 'after', consentReceipt('pre-W1'), { producer_sha256: 'f'.repeat(64) }, 'FAIL ai-live-controls: live producer_sha256 expected sha256-of-released-script got mismatch; STOP'],
    ['W3', 'after', consentReceipt('pre-W1'), { phase: 'during' }, 'FAIL ai-live-controls: live phase expected before-after-or-recovery got other; STOP'],
    ['W3', 'after', consentReceipt('pre-W1'), { window: 'W4' }, 'FAIL ai-live-controls: live window expected input-window got mismatch; STOP'],
  ];
  for (const [window, phase, consent, change, message] of cases) liveRefused(liveRun(window, phase, consent, change), phase, message);
  // Producer bytes come only from the verified archive: an extracted tree is never read.
  const producerCase = (setup: (f: ReturnType<typeof fixture>) => void, message: string) => {
    const f = fixture(); const text = JSON.stringify(consentReceipt('pre-W1')); f.put('consent.json', text);
    f.put('controls.json', liveReceipt('W3', 'fixture', 'after', text));
    for (const name of ['ordinary-before.json', 'consent-pre-W1.json']) unlinkSync(join(f.proof, name));
    setup(f); const result = f.run(['ai-live-controls']); stopped(result, message); assert.doesNotMatch(result.stderr, /Traceback/);
    assert.ok(!existsSync(join(f.proof, 'ordinary-after.json')) && !existsSync(join(f.proof, 'consent-pre-W1.json')));
  };
  // Positive control: matching archive, while the extracted RELEASE_ROOT copy is replaced and ignored.
  { const f = fixture(); const text = JSON.stringify(consentReceipt('pre-W1')); f.put('consent.json', text);
    f.put('controls.json', liveReceipt('W3', 'fixture', 'after', text)); unlinkSync(join(f.proof, 'consent-pre-W1.json'));
    f.put('release/scripts/live-ordinary-controls.mjs', 'export const unverified = 1;\n'); pass(f.run(['ai-live-controls'])); }
  producerCase(f => f.buildArchive('export const other = 1;\n'), 'FAIL ai-live-controls: live producer_sha256 expected sha256-of-released-script got mismatch; STOP');
  producerCase(f => f.buildArchive('export const other = 1;\n', false), 'FAIL ai-live-controls: BOX_ARCHIVE_PATH bytes expected input-archive_sha256 got mismatch; STOP');
  producerCase(f => f.buildArchive(null), 'FAIL ai-live-controls: scripts/live-ordinary-controls.mjs in BOX_ARCHIVE_PATH expected regular-file got missing; STOP');
  producerCase(f => { unlinkSync(f.archive); symlinkSync(join(f.root, 'absent.tar'), f.archive); }, 'FAIL ai-live-controls: BOX_ARCHIVE_PATH expected absolute-regular-file got missing-or-not-regular; STOP');
  // A retained consent copy from open cannot be replaced by different bytes.
  { const run = liveRun('W3', 'after', consentReceipt('pre-W1'), {}, 'consent-pre-W1.json\n{"other":true}');
    stopped(run.result, 'FAIL ai-live-controls: retained consent-pre-W1.json expected absent-or-identical got different-bytes; STOP');
    assert.equal(readFileSync(join(run.f.proof, 'consent-pre-W1.json'), 'utf8'), '{"other":true}', 'retained copy unchanged');
    assert.ok(!existsSync(join(run.f.proof, 'ordinary-after.json'))); }
  // Missing consent input.
  { const f = fixture(); f.put('controls.json', liveReceipt('W3', 'fixture', 'after', '{}'));
    const result = f.run(['ai-live-controls'], 'W3', { CONSENT_RECEIPT_FILE: join(f.root, 'absent-consent.json') });
    stopped(result, 'FAIL ai-live-controls: CONSENT_RECEIPT_FILE expected absolute-regular-file got missing-or-not-regular; STOP');
    assert.ok(!existsSync(join(f.proof, 'ordinary-after.json'))); }
  for (const name of ['LIVE_CONTROLS_FILE', 'CONSENT_RECEIPT_FILE', 'BOX_ARCHIVE_PATH', 'PROOF_DIR']) {
    const f = fixture(), text = JSON.stringify(consentReceipt('pre-W1')); f.put('consent.json', text); f.put('controls.json', liveReceipt('W3', 'fixture', 'after', text));
    const result = f.run(['ai-live-controls'], 'W3', { [name]: undefined });
    stopped(result, `FAIL ai-live-controls: ${name} expected ${name.endsWith('_FILE') ? 'absolute-regular-file' : 'open-shell-variable'} got unset; STOP`);
    assert.ok(!result.calls.some(c => c[0] === 'python3')); assert.ok(!existsSync(join(f.proof, 'ordinary-after.json')));
  }
});
test('ordinary-paths-unchanged / retained-receipts-revalidated: W3 preflight re-runs ai-live-controls on the retained opening pair', () => {
  const good = fixture(); const ok = good.run(['ai-w3-preflight']); pass(ok); assert.match(ok.stdout, /PASS live authenticated ordinary controls/);
  const bad = (change: (f: ReturnType<typeof fixture>) => void, inner: string) => {
    const f = fixture(); change(f); const r = f.run(['ai-w3-preflight']);
    stopped(r, inner); stopped(r, 'FAIL ai-w3-preflight: retained before receipts expected valid got refused; STOP');
    assert.doesNotMatch(r.stderr, /Traceback/);
    assert.ok(!r.calls.some(c => c[0] === 'cp' || c[0] === 'docker')); assert.ok(!existsSync(join(f.root, 'oauth/releases', sha)));
  };
  bad(f => f.put('proof/ordinary-before.json', '{}'), 'FAIL ai-live-controls: live receipt keys expected exact-schema-set got other-set; STOP');
  bad(f => f.put('proof/consent-pre-W1.json', '{}'), 'FAIL ai-live-controls: live consent_receipt_sha256 expected sha256-of-CONSENT_RECEIPT_FILE got mismatch; STOP');
  bad(f => f.put('proof/ordinary-before.json', liveReceipt('W3', 'fixture', 'after', f.preText)), 'FAIL ai-live-controls: live phase expected before got after; STOP');
  bad(f => f.put('proof/ordinary-before.json', liveReceipt('W2', 'fixture', 'before', f.preText)), 'FAIL ai-live-controls: live window expected input-window got mismatch; STOP');
  bad(f => f.put('proof/ordinary-before.json', liveReceipt('W3', 'fixture', 'before', f.preText, { producer_sha256: 'f'.repeat(64) })), 'FAIL ai-live-controls: live producer_sha256 expected sha256-of-released-script got mismatch; STOP');
  bad(f => f.buildArchive('export const other = 1;\n'), 'FAIL ai-live-controls: live producer_sha256 expected sha256-of-released-script got mismatch; STOP');
  bad(f => { const post = JSON.stringify(consentReceipt('post-W5')); f.put('proof/consent-pre-W1.json', post); f.put('proof/ordinary-before.json', liveReceipt('W3', 'fixture', 'before', post)); },
    'FAIL ai-live-controls: consent_phase for W3 before expected pre-W1 got post-W5; STOP');
  bad(f => { const other = join(f.root, 'elsewhere.json'); writeFileSync(other, readFileSync(join(f.proof, 'ordinary-before.json'))); unlinkSync(join(f.proof, 'ordinary-before.json')); symlinkSync(other, join(f.proof, 'ordinary-before.json')); },
    'FAIL ai-live-controls: LIVE_CONTROLS_FILE expected absolute-regular-file got missing-or-not-regular; STOP');
});
test('release-plan-contract / verified-plan-runner: W3 preflight runs ai-live-controls only from plan bytes bound to INPUTS plan_sha256', () => {
  const good = fixture(); pass(good.run(['ai-w3-preflight']));
  const noOp = join(scratch, 'noop-RELEASE.md');
  writeFileSync(noOp, plan.split('# step: ai-live-controls\n').join('# step: ai-live-controls\nexit 0\n'));
  const linked = join(scratch, 'linked-RELEASE.md'); if (!existsSync(linked)) symlinkSync(resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'), linked);
  for (const [planFile, got] of [[noOp, 'digest-mismatch'], [linked, 'missing-or-not-regular']] as const) {
    // A receipt the real validator refuses: a no-op validator would let it through.
    const f = fixture(); f.put('proof/ordinary-before.json', '{}');
    const r = f.run(['ai-w3-preflight'], 'W3', { PLAN_FILE: planFile });
    stopped(r, `FAIL ai-w3-preflight: PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got ${got}; STOP`);
    stopped(r, 'FAIL ai-w3-preflight: retained before receipts expected valid got refused; STOP');
    assert.doesNotMatch(r.stdout, /PASS live authenticated/); assert.ok(!r.calls.some(c => c[0] === 'cp' || c[0] === 'docker'));
  }
});
test('ordinary-paths-unchanged / open-receipts-retained: W3 preflight refuses without the retained pre-W1 consent copy', () => {
  const good = fixture(); pass(good.run(['ai-w3-preflight']));
  const f = fixture(); unlinkSync(join(f.proof, 'consent-pre-W1.json'));
  const result = f.run(['ai-w3-preflight']);
  stopped(result, 'FAIL ai-w3-preflight: retained consent receipt expected consent-pre-W1.json got missing; STOP');
  assert.ok(!result.calls.some(c => c[0] === 'cp' || c[0] === 'docker')); assert.ok(!existsSync(join(f.root, 'oauth/releases', sha)));
});
// Former statement-level `A && B` guards: each half now refuses on its own line.
test('release-plan-contract / ai-open-proof-dir-and-archive-guards: refuses an existing or symlinked PROOF_DIR and a missing or symlinked archive', () => {
  openGood('W1', 'pre-W1');
  const admitted = (r: ReturnType<ReturnType<typeof fixture>['run']>) => !r.calls.some(c => ['mkdir', 'install', 'mktemp', 'cp', 'date'].includes(c[0]!));
  { const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1'); mkdirSync(o.proof);
    const r = o.open(text, live); stopped(r, 'FAIL ai-open: PROOF_DIR expected absent got present; STOP');
    assert.ok(admitted(r)); assert.deepEqual(readdirSync(o.proof), [], 'existing proof directory untouched'); }
  { const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1'); const other = join(o.f.root, 'elsewhere'); mkdirSync(other);
    symlinkSync(other, o.proof); const r = o.open(text, live); stopped(r, 'FAIL ai-open: PROOF_DIR expected absent got present; STOP');
    assert.ok(admitted(r)); assert.deepEqual(readdirSync(other), []); }
  { const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1');
    symlinkSync(join(o.f.root, 'absent-target'), o.proof); const r = o.open(text, live);
    stopped(r, 'FAIL ai-open: PROOF_DIR expected not-symlink got symlink; STOP'); assert.ok(admitted(r)); assert.ok(!existsSync(join(o.f.root, 'absent-target'))); }
  { const o = openFixture('W1'), { text, live } = openPair('W1', 'pre-W1'); const archive = join(o.f.root, 'archive', `admin-issuance-${sha}-${openId}.tar`);
    const moved = join(o.f.root, 'moved.tar'); renameSync(archive, moved);
    let r = o.open(text, live); stopped(r, 'FAIL ai-open: BOX_ARCHIVE_PATH expected regular-file got missing; STOP'); assert.ok(admitted(r)); assert.ok(!existsSync(o.proof));
    symlinkSync(moved, archive); r = o.open(text, live);
    stopped(r, 'FAIL ai-open: BOX_ARCHIVE_PATH expected not-symlink got symlink; STOP'); assert.ok(admitted(r)); assert.ok(!existsSync(o.proof)); }
});
test('release-plan-contract / ai-db-session-open-close-guards: refuses without open.txt or after closed.txt', () => {
  // Positive control: both guards admit and the block reaches its first credential command.
  const good = fixture(); good.put('proof/open.txt', 'open\n');
  const reached = good.run(['ai-db-session'], 'W2');
  assert.equal(reached.status, 97, reached.stderr); assert.ok(reached.calls.some(c => c[0] === 'node'));
  const missing = fixture(); const r1 = missing.run(['ai-db-session'], 'W2');
  stopped(r1, 'FAIL ai-db-session: open.txt expected present got missing; STOP'); assert.ok(!r1.calls.some(c => c[0] === 'node'));
  const closed = fixture(); closed.put('proof/open.txt', 'open\n'); closed.put('proof/closed.txt', 'closed\n');
  const r2 = closed.run(['ai-db-session'], 'W2');
  stopped(r2, 'FAIL ai-db-session: closed.txt expected absent got present; STOP'); assert.ok(!r2.calls.some(c => c[0] === 'node'));
});
test('release-plan-contract / w3-new-oauth-release-guards: refuses an existing or symlinked new OAuth release directory before copying, with the exact recovery', () => {
  const good = fixture(); pass(good.run(['ai-w3-preflight'])); assert.ok(existsSync(join(good.root, 'oauth/releases', sha)));
  const present = fixture(); mkdirSync(join(present.root, 'oauth/releases', sha));
  let r = present.run(['ai-w3-preflight']);
  stopped(r, 'FAIL ai-w3-preflight: new OAuth release directory expected absent got present; a W3 at this release left it without a completed rollback: run ai-w3-rollback in this window (it moves the tree to /home/commonswarm/oauth/failed-attempts/<release_sha>-W3-<this window_id>), close recovered, then open a new W3 window; STOP'.split('/home/commonswarm/oauth').join(join(present.root, 'oauth')));
  assert.ok(!r.calls.some(c => c[0] === 'cp')); assert.deepEqual(readdirSync(join(present.root, 'oauth/releases', sha)), []);
  const linked = fixture(); symlinkSync(join(linked.root, 'absent-release'), join(linked.root, 'oauth/releases', sha));
  r = linked.run(['ai-w3-preflight']); stopped(r, 'FAIL ai-w3-preflight: new OAuth release directory expected not-symlink got symlink; STOP');
  assert.ok(!r.calls.some(c => c[0] === 'cp')); assert.ok(!existsSync(join(linked.root, 'absent-release')));
});
test('same-version retry / w3-stale-other-release-tree-ignored-with-evidence: a tree of an earlier release is recorded, never moved', () => {
  const f = fixture(); const stale = 'a5cb82518488afcf4d5cb35de8272e08c6172dfb'; mkdirSync(join(f.root, 'oauth/releases', stale));
  pass(f.run(['ai-w3-preflight']));
  assert.ok(existsSync(join(f.root, 'oauth/releases', stale)), 'the earlier release tree stays');
  const inventory = JSON.parse(readFileSync(join(f.proof, 'oauth-releases-inventory.json'), 'utf8'));
  assert.deepEqual(inventory, { baseline, release: sha, current: baseline, other_releases_ignored: [stale] });
  // A current that is not the baseline STOPs before any copy.
  const moved = fixture(); unlinkSync(join(moved.root, 'oauth/current')); mkdirSync(join(moved.root, 'oauth/releases', stale));
  symlinkSync(join(moved.root, 'oauth/releases', stale), join(moved.root, 'oauth/current'));
  const r = moved.run(['ai-w3-preflight']); stopped(r, 'FAIL ai-w3-preflight: OAuth release inventory expected current-on-baseline got other; STOP');
  assert.ok(!r.calls.some(c => c[0] === 'cp')); assert.ok(!existsSync(join(moved.root, 'oauth/releases', sha)));
});
// ai_run evals the plan's own ai-release-aside block, remapped like every other block.
const asideShim = `# test shim: ai_run runs the plan's own ai-release-aside block (the box's ai_run evals it the same way)
ai_run() { test "$1" = ai-release-aside || return 1; eval "$(cat "$FIXTURE_ROOT/aside.sh")"; }`;
function rollbackFixture(config: Record<string, unknown> = {}) {
  const f = fixture({ running_image: baselineImage, ...config }); f.put('aside.sh', f.remap(block('ai-release-aside')));
  // The failed attempt: preflight copied the tree, apply switched current to it.
  mkdirSync(join(f.root, 'oauth/releases', sha, 'deploy/mcp-auth'), { recursive: true }); f.put(`oauth/releases/${sha}/RELEASE_SHA`, sha + '\n');
  unlinkSync(join(f.root, 'oauth/current')); symlinkSync(join(f.root, 'oauth/releases', sha), join(f.root, 'oauth/current'));
  f.put('etc/commonswarm-oauth/compose.env', 'MCP_OAUTH_IMAGE=' + image + '\n');
  return f;
}
const W3_ENV = { WINDOW_ID: 'Fix123' };
test('same-version retry / w3-rollback-moves-tree-aside: rollback restores the baseline, then moves the failed tree to failed-attempts with evidence', () => {
  const f = rollbackFixture(); const r = f.run([asideShim, 'ai-w3-rollback'], 'W3', W3_ENV); pass(r);
  const dest = join(f.root, 'oauth/failed-attempts', `${sha}-W3-Fix123`);
  assert.ok(!existsSync(join(f.root, 'oauth/releases', sha)), 'no tree at this release');
  assert.equal(readFileSync(join(dest, 'RELEASE_SHA'), 'utf8'), sha + '\n', 'evidence kept');
  assert.equal(statSync(join(f.root, 'oauth/failed-attempts')).mode & 0o777, 0o700);
  assert.equal(realpathSync(join(f.root, 'oauth/current')), join(f.root, 'oauth/releases', baseline));
  assert.equal(readFileSync(join(f.root, 'etc/commonswarm-oauth/compose.env'), 'utf8'), 'MCP_OAUTH_IMAGE=baseline\n');
  const record = JSON.parse(readFileSync(join(f.proof, 'oauth-aside.json'), 'utf8'));
  assert.deepEqual({ ...record, at: 'x' }, { part: 'oauth', release_sha: sha, window: 'W3', window_id: 'Fix123', from: join(f.root, 'oauth/releases', sha), to: dest, moved: true, at: 'x' });
  assert.equal(readFileSync(join(f.proof, 'W3-rollback.txt'), 'utf8'), 'PASS W3 rollback: baseline image and current restored; release tree aside or absent\n');
  // Then the same-version retry preflight finds its one admissible state.
  pass(f.run(['ai-w3-preflight'])); assert.ok(existsSync(join(f.root, 'oauth/releases', sha, 'deploy/mcp-auth/compose.yaml')));
  // A rerun of the rollback is idempotent: the record and the moved tree are consistent.
  const again = rollbackFixture(); pass(again.run([asideShim, 'ai-w3-rollback'], 'W3', W3_ENV));
  const second = again.run([asideShim, 'ai-w3-rollback'], 'W3', W3_ENV); pass(second); assert.match(second.stdout, /already done/);
  // Nothing at this release (failure before the preflight copy): no move, a moved:false record.
  const none = rollbackFixture(); rmSync(join(none.root, 'oauth/releases', sha), { recursive: true });
  pass(none.run([asideShim, 'ai-w3-rollback'], 'W3', W3_ENV));
  assert.equal(JSON.parse(readFileSync(join(none.proof, 'oauth-aside.json'), 'utf8')).moved, false);
});
test('same-version retry / w3-rollback-aside-refusals: a live, symlinked or colliding tree is never moved; every step fails explicitly', () => {
  const modelled = (step: string) => '# modelled ignored errexit (left side of ||)\n( ' + block(step).replace('set -euo pipefail', 'set +e') + '\n) || { printf "CALLER: rollback failure seen\\n" >&2; exit 1; }';
  const cases: Array<[string, Record<string, unknown>, (f: ReturnType<typeof fixture>) => void, string]> = [
    ['container still on the failed tree', { working_dir: 'TREE' }, () => undefined, 'FAIL ai-release-aside: live container working directory expected baseline-not-the-failed-tree got failed-tree; STOP'],
    ['tree is a symlink', {}, f => { rmSync(join(f.root, 'oauth/releases', sha), { recursive: true }); mkdirSync(join(f.root, 'elsewhere')); symlinkSync(join(f.root, 'elsewhere'), join(f.root, 'oauth/releases', sha)); }, 'FAIL ai-release-aside: failed-attempt tree expected directory got symlink; STOP'],
    ['destination exists', {}, f => mkdirSync(join(f.root, 'oauth/failed-attempts', `${sha}-W3-Fix123`), { recursive: true }), 'FAIL ai-release-aside: aside destination expected absent got present; STOP'],
    ['parent not root-owned', { aside_owner: '501 20' }, () => undefined, 'FAIL ai-release-aside: failed-attempts mode expected 700-0-0 got other; STOP'],
    ['parent is a symlink', {}, f => { mkdirSync(join(f.root, 'elsewhere')); symlinkSync(join(f.root, 'elsewhere'), join(f.root, 'oauth/failed-attempts')); }, 'FAIL ai-release-aside: failed-attempts expected not-symlink got symlink; STOP'],
    ['baseline compose up fails', { rollback_compose_failed: true }, () => undefined, 'FAIL ai-w3-rollback: baseline compose up expected success got failure; STOP'],
    ['running image is not the baseline', { running_image: image }, () => undefined, 'FAIL ai-w3-rollback: running image expected baseline got other; STOP'],
  ];
  for (const [name, config, setup, message] of cases) for (const mode of ['as written', 'modelled ignored errexit']) {
    const f = rollbackFixture(config.working_dir === 'TREE' ? { ...config, working_dir: '' } : config);
    if (config.working_dir === 'TREE') { const c = JSON.parse(readFileSync(join(f.root, 'commands.json'), 'utf8')); f.put('commands.json', { ...c, working_dir: join(f.root, 'oauth/releases', sha, 'deploy/mcp-auth') }); }
    setup(f);
    const r = f.run([asideShim, mode === 'as written' ? 'ai-w3-rollback' : modelled('ai-w3-rollback')], 'W3', W3_ENV);
    stopped(r, message); if (mode !== 'as written') assert.match(r.stderr, /CALLER: rollback failure seen/, name);
    assert.ok(!existsSync(join(f.proof, 'W3-rollback.txt')), `${name} ${mode}: no PASS receipt`);
    if (name !== 'tree is a symlink') assert.ok(existsSync(join(f.root, 'oauth/releases', sha)), `${name} ${mode}: tree not moved`);
    if (name === 'baseline compose up fails') assert.ok(!r.calls.some(c => c[0] === 'ln'), `${name}: nothing after the failed compose`);
  }
});
test('same-version retry / w6-issuer-live: W6 re-verifies the installed issuer credential live, whichever release its W2b ran at', () => {
  const live = (config: Record<string, unknown> = {}, setup: (f: ReturnType<typeof fixture>) => void = () => undefined) => {
    const f = fixture(config); f.put('etc/commonswarm-oauth/admin-issuer-database-credentials', JSON.stringify({ user: 'commonswarm_admin_issuer', password: 'd'.repeat(64) }));
    setup(f); return { f, r: f.run(['ai-w6-issuer-live'], 'W6') };
  };
  const good = live(); pass(good.r);
  assert.equal(readFileSync(join(good.f.proof, 'issuer-live.txt'), 'utf8'), 'PASS W6 issuer live: LOGIN with password, credential 0440 root:986, TLS login as the issuer, five forward catalogs true\n');
  assert.match(readFileSync(join(good.f.root, 'stage/issuer-live-service.conf'), 'utf8'), /^user=commonswarm_admin_issuer$/m);
  assert.equal(statSync(join(good.f.root, 'stage/issuer-live-pass')).mode & 0o777, 0o600);
  assert.equal(good.r.calls.filter(c => c[0] === 'ai_ro' && c.includes('/proof/catalog.sql')).length, 5);
  assert.doesNotMatch(good.r.stdout + good.r.stderr, /d{64}/, 'the password is never printed');
  const C = 'etc/commonswarm-oauth/admin-issuer-database-credentials';
  const bad: Array<[string, Record<string, unknown>, (f: ReturnType<typeof fixture>) => void, string]> = [
    ['credential missing', {}, f => rmSync(join(f.root, C)), 'FAIL ai-w6-issuer-live: issuer credential file expected regular-file got missing; STOP'],
    ['credential symlink', {}, f => { rmSync(join(f.root, C)); symlinkSync(join(f.root, 'etc/commonswarm-oauth/protected-sibling'), join(f.root, C)); }, 'FAIL ai-w6-issuer-live: issuer credential file expected not-symlink got symlink; STOP'],
    ['credential mode', { credential_mode: '644 0 0' }, () => undefined, 'FAIL ai-w6-issuer-live: issuer credential mode expected 440-0-986 got other; STOP'],
    ['role NOLOGIN', { issuer_login: 'f' }, () => undefined, 'FAIL ai-w6-issuer-live: issuer role expected LOGIN-with-password got other; STOP'],
    ['credential for another user', {}, f => f.put(C, JSON.stringify({ user: 'postgres', password: 'd'.repeat(64) })), 'FAIL ai-w6-issuer-live: login files from the installed credential expected prepared got refused; STOP'],
    ['TLS login fails', { tls_failed: true }, () => undefined, 'FAIL ai-w6-issuer-live: TLS psql login with the installed credential expected exit 0 got failure; STOP'],
    ['login measures another role', { login: 'f' }, () => undefined, 'FAIL ai-w6-issuer-live: dedicated-role measurement expected t got non-t; STOP'],
    ['forward catalog false', { catalog_ok: { '20261003000004': 'f' } }, () => undefined, 'FAIL ai-w6-issuer-live: forward catalog 20261003000004 expected t got other; STOP'],
  ];
  for (const [name, config, setup, message] of bad) {
    const { f, r } = live(config, setup); stopped(r, message); assert.ok(!existsSync(join(f.proof, 'issuer-live.txt')), name);
    assert.doesNotMatch(r.stdout + r.stderr, /d{64}/, name);
  }
  // The activation checks call it right after the W2b provenance, before any release identity check.
  assert.match(block('ai-w6-activation-checks'), /printf '%s\\n' "\$W2B_BINDING" >"\$PROOF_DIR\/issuer-provenance.json"\n# The provenance is a record; the credential itself is re-verified live, now.\n\( ai_run ai-w6-issuer-live \) \|\| \{ printf 'FAIL ai-w6-activation-checks: issuer credential expected live LOGIN/);
});
test('admin-issuer-credential-provisioning / failed-provisioning-nologin-clear-password-guarded-file-removal: fails closed when guarded cleanup refuses', () => {
  for (const refused of [false, true]) {
    const f = fixture({ cleanup_refused: refused }); f.put('etc/commonswarm-oauth/admin-issuer-database-credentials', 'synthetic fixture');
    f.put('proof/issuer-provisioning-attempted.txt', '2026-10-05T00:00:00Z\n');
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
  f.put('proof/issuer-provisioning-attempted.txt', '2026-10-05T00:00:00Z\n');
  const result = f.run(['ai-w2-issuer-rollback'], 'W2'); assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some(c => c[0] === 'rm')); assert.ok(!existsSync(join(f.proof, 'issuer-rollback.txt')));
  assert.equal(readFileSync(target, 'utf8'), 'must survive');
});

test('admin-issuer-credential-provisioning / rollback-fails-explicitly: every rollback step fails on its own, also where errexit is ignored', () => {
  const C = 'etc/commonswarm-oauth/admin-issuer-database-credentials';
  // bash ignores errexit for ( ai_run ai-w2-issuer-rollback ) || ... (Ubuntu bash 5 even inside the block's own set -e).
  // The mini's /bin/bash is 3.2, so that context is MODELLED here: the block runs with errexit off, under ||.
  const modelled = '# modelled ignored errexit (left side of ||)\n( ' + block('ai-w2-issuer-rollback').replace('set -euo pipefail', 'set +e') + '\n) || { printf "CALLER: rollback failure seen\\n" >&2; exit 1; }';
  const cases: Array<[string, Record<string, unknown>, (f: ReturnType<typeof fixture>) => void, string]> = [
    ['ALTER ROLE fails', { alter_failed: true }, f => f.put(C, 'synthetic fixture'), 'FAIL ai-w2-issuer-rollback: issuer ALTER ROLE expected success got failure; STOP'],
    ['readback false', { readback: 'f' }, f => f.put(C, 'synthetic fixture'), 'FAIL ai-w2-issuer-rollback: issuer role readback expected no-login-and-no-password got other; STOP'],
    ['readback query fails', { readback_failed: true }, () => undefined, 'FAIL ai-w2-issuer-rollback: issuer role readback expected success got failure; STOP'],
    ['credential is a directory', {}, f => mkdirSync(join(f.root, C)), 'FAIL ai-w2-issuer-rollback: issuer credential file expected regular-file got other; STOP'],
    ['credential is a symlink', {}, f => symlinkSync(join(f.root, 'etc/commonswarm-oauth/protected-sibling'), join(f.root, C)), 'FAIL ai-w2-issuer-rollback: issuer credential file expected not-symlink got symlink; STOP'],
  ];
  for (const [name, config, setup, message] of cases) for (const [mode, steps] of [['as written', ['ai-w2-issuer-rollback']], ['modelled ignored errexit', [modelled]]] as const) {
    const f = fixture(config); setup(f);
    f.put('proof/issuer-provisioning-attempted.txt', '2026-10-05T00:00:00Z\n');
    const result = f.run([...steps], 'W2b');
    assert.notEqual(result.status, 0, `${name} ${mode}`); stopped(result, message);
    if (mode !== 'as written') assert.match(result.stderr, /CALLER: rollback failure seen/, name);
    assert.ok(!existsSync(join(f.proof, 'issuer-rollback.txt')), `${name} ${mode}: no PASS receipt`);
    assert.equal(readFileSync(join(f.root, 'etc/commonswarm-oauth/protected-sibling'), 'utf8'), 'must survive');
    if (name === 'ALTER ROLE fails') assert.ok(!result.calls.some(c => c[0] === 'rm' || c[0] === 'ai_ro'), `${name} ${mode}: nothing after the failed ALTER`);
  }
  // Positive control in both modes.
  for (const steps of [['ai-w2-issuer-rollback'], [modelled]]) {
    const f = fixture(); f.put(C, 'synthetic fixture'); f.put('proof/issuer-provisioning-attempted.txt', '2026-10-05T00:00:00Z\n'); pass(f.run(steps, 'W2b'));
    assert.equal(readFileSync(join(f.proof, 'issuer-rollback.txt'), 'utf8'), 'PASS issuer login disabled; additive roles/grants retained\n');
  }
  // Without this window's marker the live issuer is left untouched.
  {
    const f = fixture(); f.put(C, 'synthetic fixture');
    const result = f.run(['ai-w2-issuer-rollback'], 'W2b');
    assert.notEqual(result.status, 0);
    stopped(result, 'FAIL ai-w2-issuer-rollback: this window did not own issuer provisioning; live issuer left untouched; STOP');
    assert.ok(existsSync(join(f.root, C)));
    assert.ok(!existsSync(join(f.proof, 'issuer-rollback.txt')));
    assert.ok(!result.calls.some(c => c[0] === 'ai_db' || c[0] === 'rm'));
  }
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
  assert.ok(existsSync(join(good.proof, 'issuer-provisioning-attempted.txt')));
  // libpq's service-file parser takes key=value only (5f64fab4 W2 RGLqZX failed on configparser's "key = value").
  const service = readFileSync(join(good.root, 'stage/issuer-service.conf'), 'utf8');
  assert.match(service, /^sslmode=verify-full$/m);
  assert.match(service, /^user=commonswarm_admin_issuer$/m);
  assert.doesNotMatch(service, / = | =|= /);
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
test('admin-issuer-credential-provisioning / scram-readback-before-login: an ALTER that never reached the database STOPs before the login', () => {
  // The W2b 67aAId failure: the ALTER ran nowhere (stdin into a docker run without -i). The readback must stop it.
  const f = fixture({ secret_file_noop: true }), result = f.run(['ai-w2-issuer-credential'], 'W2');
  stopped(result, "FAIL ai-w2-issuer-credential: issuer LOGIN with this attempt's SCRAM-SHA-256 verifier expected t got f (ALTER ROLE not applied); STOP");
  assert.ok(!result.calls.some(c => c[0] === 'docker' || c[0] === 'install'), 'no install or login test after a failed readback');
  assert.ok(!existsSync(join(f.proof, 'issuer-credential.txt')));
  // A STALE verifier from an earlier attempt (still in the database) plus a no-op ALTER: the exact-verifier readback STOPs.
  const stale = fixture({ secret_file_noop: true });
  stale.put('applied.sql', "ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD 'SCRAM-SHA-256$4096:c3RhbGVzdGFsZXN0YWxlc3Q=$c3RhbGU=:c3RhbGU=';\n");
  const staleRun = stale.run(['ai-w2-issuer-credential'], 'W2');
  stopped(staleRun, "FAIL ai-w2-issuer-credential: issuer LOGIN with this attempt's SCRAM-SHA-256 verifier expected t got f (ALTER ROLE not applied); STOP");
  assert.ok(!staleRun.calls.some(c => c[0] === 'install' || c[0] === 'docker'));
  // The mutation boundary: a role that already has LOGIN or a password STOPs before any secret is generated.
  const used = fixture({ readback: 'f' }), usedRun = used.run(['ai-w2-issuer-credential'], 'W2');
  stopped(usedRun, 'FAIL ai-w2-issuer-credential: issuer role expected fresh-without-password before the credential got other; run ai-w2-issuer-rollback first; STOP');
  assert.ok(!usedRun.calls.some(c => ['openssl', 'ai_db_secret_file', 'install', 'docker'].includes(c[0]!)));
  // The positive path calls the mounted-file helper with the stage file, never ai_db on stdin.
  const good = fixture(), ok = good.run(['ai-w2-issuer-credential'], 'W2'); pass(ok);
  assert.ok(ok.calls.some(c => c[0] === 'ai_db_secret_file' && c[1]!.endsWith('/issuer.sql')));
  // Only the SCRAM verifier reaches the database; the plaintext stays in issuer.json and issuer-pass.
  const applied = readFileSync(join(good.root, 'applied.sql'), 'utf8');
  assert.match(applied, /^ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=';\n$/);
  assert.ok(!applied.includes('d'.repeat(64)), 'the plaintext never goes to the database');
  assert.ok(!ok.calls.some(c => c[0] === 'ai_db' && c.includes('-')), 'no stdin SQL');
});
test('admin-issuer-credential-provisioning / libpq-service-file-bytes: refuses a service file line that is not key=value before any credential is installed', () => {
  const f = fixture();
  f.put('stage/service.conf', '[target]\nhost=db.commonswarm.internal\nsslmode=verify-full\nsslrootcert=/etc/ssl/yulan-internal-ca.pem\nuser=fixture\noptions=\n');
  const result = f.run(['ai-w2-issuer-credential'], 'W2');
  stopped(result, 'FAIL ai-w2-issuer-credential: issuer-service.conf line expected key=value got other; STOP');
  assert.ok(!result.calls.some(c => c[0] === 'install' || c[0] === 'docker' || c[0] === 'ai_db'), 'no ALTER ROLE, install or login after a refused service file');
  assert.ok(!existsSync(join(f.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials')));
  assert.ok(!existsSync(join(f.proof, 'issuer-credential.txt')));
});
test('admin-issuer-credential-provisioning / w2b-shared-issuer-block: W2b runs the same issuer block and rollback; any other window refuses', () => {
  const missing = fixture(); const refused = missing.run(['ai-w2-issuer-credential'], 'W2b');
  stopped(refused, 'FAIL ai-w2-issuer-credential: W2b w2b-preconditions.txt expected present got missing; STOP');
  assert.ok(!refused.calls.some(c => c[0] === 'openssl'));
  const good = fixture(); good.put('proof/w2b-preconditions.txt', 'PASS'); validGate(good, 'W2b');
  const positive = good.run([gateShim, 'ai-w2-issuer-credential'], 'W2b'); pass(positive);
  // Backup admission at the W2b mutation boundary: a malformed, stale, wrong-window or missing receipt STOPs before any credential.
  for (const [name, mutate] of [
    ['malformed', (f: ReturnType<typeof fixture>) => f.put('proof/backup-gate.json', 'PASS')],
    ['missing', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'proof/backup-gate.json'))],
    ['stale backup', (f: ReturnType<typeof fixture>) => validGate(f, 'W2b', { backup_verified_at: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') })],
    ['wrong window', (f: ReturnType<typeof fixture>) => validGate(f, 'W2b', { window: 'W4' })],
  ] as const) {
    const f = fixture(); f.put('proof/w2b-preconditions.txt', 'PASS'); validGate(f, 'W2b'); mutate(f);
    const r = f.run([gateShim, 'ai-w2-issuer-credential'], 'W2b');
    stopped(r, 'FAIL ai-w2-issuer-credential: W2b backup-gate.json expected valid-bound-fresh-receipt got refused; STOP');
    assert.ok(!r.calls.some(c => ['openssl', 'ai_db', 'install', 'docker'].includes(c[0]!)), name);
  }
  assert.ok(existsSync(join(good.proof, 'issuer-credential.txt')));
  assert.match(readFileSync(join(good.root, 'stage/issuer-service.conf'), 'utf8'), /^user=commonswarm_admin_issuer$/m);
  for (const window of ['W1', 'W3', 'W6']) {
    const f = fixture(); f.put('proof/w2b-preconditions.txt', 'PASS');
    stopped(f.run(['ai-w2-issuer-credential'], window), 'FAIL ai-w2-issuer-credential: window expected W2-or-W2b got other; STOP');
    stopped(f.run(['ai-w2-issuer-rollback'], window), 'FAIL ai-w2-issuer-rollback: window expected W2-or-W2b got other; STOP');
  }
  const rollback = fixture(); rollback.put('etc/commonswarm-oauth/admin-issuer-database-credentials', '{}');
  rollback.put('proof/issuer-provisioning-attempted.txt', '2026-10-05T00:00:00Z\n');
  pass(rollback.run(['ai-w2-issuer-rollback'], 'W2b'));
  assert.ok(!existsSync(join(rollback.root, 'etc/commonswarm-oauth/admin-issuer-database-credentials')));
  assert.ok(existsSync(join(rollback.proof, 'issuer-rollback.txt')));
});
test('release-plan-contract / w2b-preflight-bound-w2: W2b needs its backup gate, the validated W2 proofs, exact checksums and forward catalogs', () => {
  const w2sha = 'e'.repeat(40), w2id = 'RGLqZX';
  const old = ['20260928000003', '20261001000001', '20261002000001'];
  const five = [1, 2, 3, 4, 5].map(i => `2026100300000${i}`);
  // ai_run models only the shared validator's verdict here; its content checks run from plan bytes in admin-release-plan.test.ts.
  const shim = `# test shim: the shared W2 proof validator's verdict
ai_run() { if test "$1" = ai-backup-gate-check; then eval "$(cat "$FIXTURE_ROOT/gate-check.sh")"; return; fi
  test "$1" = ai-w2b-proof-check || return 1; test "$PROOF_CHECK_KIND" = W2 || return 1; cat "$FIXTURE_ROOT/proof-check.out"; return "$(cat "$FIXTURE_ROOT/proof-check.status")"; }`;
  const setup = (change: (f: ReturnType<typeof fixture>, rows: string[], ledger: string[]) => void = () => undefined, config: Record<string, unknown> = {}) => {
    const rows: string[] = [], ledger = [...old, ...five];
    for (const v of old) rows.push(`${v}|${'1'.repeat(64)}|backfill|${'c'.repeat(40)}`);
    const files: Record<string, string> = {};
    five.forEach((v, i) => { const body = `-- migration ${v}\n`; files[v] = body; rows.push(`${v}|${digest(body)}|${i < 3 ? 'backfill' : 'release'}|${w2sha}`); });
    const f = fixture({ catalog_failed: {}, ...config });
    for (const v of five) { mkdirSync(join(f.root, 'release/supabase/migrations'), { recursive: true }); f.put(`release/supabase/migrations/${v}_m.sql`, files[v]!); }
    const inputs = JSON.parse(readFileSync(join(f.root, 'inputs.json'), 'utf8')) as Record<string, unknown>;
    f.put('inputs.json', { ...inputs, window: 'W2b', w2_release_sha: w2sha, w2_window_id: w2id });
    f.put('proof/ordinary-before.json', liveReceipt('W2b', 'fixture', 'before', f.preText));
    validGate(f, 'W2b');
    f.put('proof-check.out', JSON.stringify({ closed_at: '2026-10-04T09:00:00Z', kind: 'W2', release_sha: w2sha, result: 'recovered', window_id: w2id }) + '\n');
    f.put('proof-check.status', '0');
    change(f, rows, ledger);
    const cfg = JSON.parse(readFileSync(join(f.root, 'commands.json'), 'utf8'));
    f.put('commands.json', { ...cfg, w2b_ledger: ledger.join('\n'), w2b_checksums: rows.join('\n') });
    return { f, result: f.run([shim, 'ai-w2b-preflight'], 'W2b') };
  };
  const good = setup(); pass(good.result);
  assert.match(good.result.stdout, /PASS ai-w2b-preflight: bound W2 proofs valid: \{"closed_at":"2026-10-04T09:00:00Z","kind":"W2"/);
  assert.match(good.result.stdout, /PASS ai-w2b-preflight: 8 checksum rows match the ledger; five W2 rows equal this release archive/);
  assert.equal(readFileSync(join(good.f.proof, 'w2b-preconditions.txt'), 'utf8'), 'PASS W2b preconditions: backup gate, bound W2 proofs, ledger, checksums and forward catalogs exact; issuer NOLOGIN without password; credential absent; issuance OFF\n');
  assert.equal(JSON.parse(readFileSync(join(good.f.proof, 'w2-binding.json'), 'utf8')).window_id, w2id);
  for (const v of five) assert.ok(good.result.calls.some(c => c[0] === 'ai_ro' && c.join(' ').includes('/proof/catalog.sql')), v);
  // 0002's only failing forward row may be the issuer LOGIN the W2 rollback removed.
  pass(setup(() => undefined, { catalog_failed: { '20261003000002': '20261003000002-001-commonswarm_admin_issuer' } }).result);
  const bad: Array<[string, (f: ReturnType<typeof fixture>, rows: string[], ledger: string[]) => void, Record<string, unknown>, string]> = [
    ['no backup gate', f => rmSync(join(f.root, 'proof/backup-gate.json')), {}, 'FAIL ai-w2b-preflight: W2b: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP'],
    ['backup receipt not JSON', f => f.put('proof/backup-gate.json', 'PASS'), {}, 'FAIL ai-w2b-preflight: W2b: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP'],
    ['backup receipt of another release', f => validGate(f, 'W2b', { release_sha: 'f'.repeat(40) }), {}, 'FAIL ai-w2b-preflight: W2b: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP'],
    ['W2 proofs refused', f => f.put('proof-check.status', '1'), {}, 'FAIL ai-w2b-preflight: bound W2 proofs expected valid got refused; STOP'],
    ['credential file present', f => f.put('etc/commonswarm-oauth/admin-issuer-database-credentials', '{}'), {}, 'FAIL ai-w2b-preflight: issuer credential file expected absent got present; STOP'],
    ['database preconditions false', () => undefined, { w2b: 'f' }, 'FAIL ai-w2b-preflight: ledger five-20261003-nothing-later and NOLOGIN issuer without password expected t got other; STOP'],
    ['wrong checksum', (_f, rows) => { rows[5] = rows[5]!.replace(/\|[0-9a-f]{64}\|/, '|' + '9'.repeat(64) + '|'); }, {}, 'FAIL ai-w2b-preflight: 20261003000003 checksum row expected release-file-sha256-backfill-at-w2_release_sha got other; STOP'],
    ['checksum at another release', (_f, rows) => { rows[7] = rows[7]!.replace(w2sha, 'f'.repeat(40)); }, {}, 'FAIL ai-w2b-preflight: 20261003000005 checksum row expected release-file-sha256-release-at-w2_release_sha got other; STOP'],
    ['wrong checksum source', (_f, rows) => { rows[3] = rows[3]!.replace('|backfill|', '|release|'); }, {}, 'FAIL ai-w2b-preflight: 20261003000001 checksum row expected release-file-sha256-backfill-at-w2_release_sha got other; STOP'],
    ['ledger version without checksum', (_f, _rows, ledger) => { ledger.splice(1, 0, '20260930000001'); }, {}, 'FAIL ai-w2b-preflight: checksum rows expected one-per-ledger-version got other; STOP'],
    ['changed migration file', f => f.put('release/supabase/migrations/20261003000004_m.sql', '-- changed\n'), {}, 'FAIL ai-w2b-preflight: 20261003000004 checksum row expected release-file-sha256-release-at-w2_release_sha got other; STOP'],
    ['forward catalog row false', () => undefined, { catalog_failed: { '20261003000001': '20261003000001-003-anything' } }, 'FAIL ai-w2b-preflight: forward catalog 20261003000001 expected all-rows-true (0002: only the issuer LOGIN row) got failed checks 20261003000001-003-anything; STOP'],
    ['0002 other row false', () => undefined, { catalog_failed: { '20261003000002': '20261003000002-001-commonswarm_admin_issuer,20261003000002-002-issuer-memberships' } }, 'FAIL ai-w2b-preflight: forward catalog 20261003000002 expected all-rows-true (0002: only the issuer LOGIN row) got failed checks 20261003000002-001-commonswarm_admin_issuer,20261003000002-002-issuer-memberships; STOP'],
    ['issuance on', () => undefined, { readonly: 'f' }, 'FAIL ai-w2b-preflight: admin issuance expected OFF got other; STOP'],
  ];
  for (const [name, change, config, message] of bad) {
    const { f, result } = setup(change, config);
    assert.notEqual(result.status, 0, name); stopped(result, message);
    assert.ok(!existsSync(join(f.proof, 'w2b-preconditions.txt')), name);
  }
  const unbound = fixture(); unbound.put('proof/ordinary-before.json', liveReceipt('W3', 'fixture', 'before', unbound.preText));
  stopped(unbound.run(['ai-w2b-preflight'], 'W3'), 'FAIL ai-w2b-preflight: window expected W2b got other; STOP');
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
