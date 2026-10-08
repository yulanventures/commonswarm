/** Owns the executable edge-release lifecycle contract; no Docker/network/box. */
import assert from 'node:assert/strict';
import { spawnSync as nodeSpawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createMcpProtocolHandler } from '../supabase/functions/mcp/protocol.ts';

// Enforce a portable per-argument budget even on macOS, where Linux's
// MAX_ARG_STRLEN would otherwise remain untested. Large payloads use stdin.
const maxArgBytes = 64 * 1024;
function spawnSync(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  for (const [index, arg] of args.entries()) {
    const bytes = Buffer.byteLength(arg, 'utf8');
    assert.ok(bytes <= maxArgBytes, `${command} argv[${index}] is ${bytes} bytes; limit is ${maxArgBytes}; use stdin or a file`);
  }
  return nodeSpawnSync(command, args, options);
}

test('all helper spawns enforce a 64 KiB argv budget measured in UTF-8 bytes', () => {
  const args = ['-e', 'process.stdout.write("ok")'];
  const control = spawnSync(process.execPath, [...args, 'x'.repeat(maxArgBytes)], { encoding: 'utf8' });
  passed(control); assert.equal(control.stdout, 'ok');
  for (const payload of ['x'.repeat(maxArgBytes + 1), 'é'.repeat(maxArgBytes / 2 + 1)]) {
    assert.throws(() => spawnSync(process.execPath, [...args, payload], { encoding: 'utf8' }), /argv\[2\].*limit is 65536; use stdin or a file/);
  }
});

// Existing OAuth/C1 tests do not execute this post-W4 binding lifecycle. Tests
// below protect release safety, admission and shell execution, without adding
// a fixture switch to the operator plan. Infra stubs only own unavailable I/O;
// binding, traps, attempt admission and switches come from extracted blocks.
const plan = readFileSync(resolve('deploy/edge-runtime/EDGE-RELEASE.md'), 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
function block(id: string) {
  const found = blocks.filter(s => s.startsWith(`# step: ${id}\n`));
  assert.equal(found.length, 1, id); return found[0]!;
}
function python(source: string) {
  const match = /^[ \t]*python3[^\n]*<<'PY'\n([\s\S]*?)^PY$/m.exec(source);
  assert.ok(match); return match[1]!;
}
const validator = python(block('edge-open'));
const helpers = /cat >>"\$PROOF_DIR\/session.sh" <<'SH'\n([\s\S]*?)^SH$/m.exec(block('edge-open'))![1]!;
const partialHelpers = /cat >"\$PROOF_DIR\/partial-session.sh" <<'PARTIAL_SH'\n([\s\S]*?)^PARTIAL_SH$/m.exec(block('edge-open'))![1]!;
// The extracted plan checks canonical paths; TMPDIR may point through a symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'edge-release-contract-')));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const clock = '2031-02-03T12:00:00Z';
const fixture = () => ({
  release_sha: 'a'.repeat(40), baseline_edge_sha: 'b'.repeat(40), baseline_oauth_sha: 'c'.repeat(40), baseline_stack_sha: 'd'.repeat(40), baseline_site_sha: 'e'.repeat(40),
  archive_sha256: 'a'.repeat(64), plan_sha256: 'b'.repeat(64), checker_sha256: 'c'.repeat(64),
  baseline_edge_image: `sha256:${'d'.repeat(64)}`, baseline_oauth_image: `sha256:${'e'.repeat(64)}`, baseline_postgres_image: `sha256:${'f'.repeat(64)}`,
  target: 'production', box_hostname: 'yulan-vps-1', window_id: 'Abc123', window_end_utc: '2031-02-03T12:30:00Z', rollback_approved: 'yes',
  baseline_site_target: '/srv/commonswarm/site/releases/20310203T110000Z-eeeeeeeeeeee-aaaaaaaaaaaaaaaa',
  edge_env_sha256: '1'.repeat(64), override_sha256: '2'.repeat(64), caddyfile_sha256: '3'.repeat(64), api_caddy_sha256: '4'.repeat(64), mcp_caddy_sha256: '5'.repeat(64), caddy_ca_sha256: '6'.repeat(64),
  edge_recycle_timer: 'commonswarm-edge-recycle.timer', edge_recycle_service: 'commonswarm-edge-recycle.service',
  recycle_unit_sha256: '7'.repeat(64), recycle_timer_sha256: '8'.repeat(64), recycle_hook_sha256: '9'.repeat(64), recycle_dropin_sha256: '0'.repeat(64), recycle_json_sha256: 'a'.repeat(64), recycle_archive_sha256: 'b'.repeat(64), baseline_cutover_sha256: 'c'.repeat(64), baseline_ledger_sha256: 'd'.repeat(64),
});
let serial = 0;
type Options = { now?: string; host?: string; marker?: string; root?: boolean; mode?: number; raw?: string };
function validate(input: unknown, opts: Options = {}) {
  const n = serial++, inputs = join(scratch, `inputs-${n}.json`), marker = join(scratch, `marker-${n}`);
  writeFileSync(inputs, opts.raw ?? JSON.stringify(input), { mode: 0o600 });
  if (opts.marker !== undefined) { writeFileSync(marker, opts.marker, { mode: opts.mode ?? 0o600 }); chmodSync(marker, opts.mode ?? 0o600); }
  const harness = `
import datetime,os,pathlib,sys
real_datetime=datetime.datetime
class Clock(real_datetime):
 @classmethod
 def now(cls,tz=None): return real_datetime.fromisoformat(sys.argv[4].replace('Z','+00:00'))
datetime.datetime=Clock
real_stat=pathlib.Path.stat
def stat(self,*a,**kw):
 s=real_stat(self,*a,**kw)
 if str(self)==sys.argv[2]:
  fields=list(s); fields[4]=fields[5]=0 if sys.argv[5]=='root' else 501; return os.stat_result(fields)
 return s
pathlib.Path.stat=stat
exec(compile(sys.stdin.read(),'<extracted-edge-validator>','exec'))
`;
  return spawnSync('python3', ['-c', harness, inputs, marker, opts.host ?? 'yulan-vps-1', opts.now ?? clock, opts.root ? 'root' : 'nonroot'], { input: validator, encoding: 'utf8' });
}
function passed(r: ReturnType<typeof spawnSync>) {
  assert.ifError(r.error);
  assert.equal(r.status, 0, String(r.stderr));
}
function stopped(r: ReturnType<typeof spawnSync>, pattern = /FAIL.*STOP/s) {
  assert.notEqual(r.status, 0, String(r.stdout)); assert.match(String(r.stderr), pattern);
}
// Match the box's data-filter extraction API; macOS /usr/bin/python3 is 3.9.
const archivePython = ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(path =>
  spawnSync(path, ['-c', 'import tarfile; assert hasattr(tarfile,"data_filter")'], { encoding: 'utf8' }).status === 0);
assert.ok(archivePython, 'archive admission requires Python with tarfile.data_filter');
const pythonPath = spawnSync(archivePython, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
passed(pythonPath);
const quotedPythonExecutable = "'" + pythonPath.stdout.trim().replaceAll("'", "'\\''") + "'";
function bashVersion(path: string) {
  const r = spawnSync(path, ['-c', 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : undefined;
}
const bash5 = ['/bin/bash', 'bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(path => /^5\./.test(bashVersion(path) ?? ''));

test('every block and persisted helper parses in Bash 5', t => {
  if (!bash5 && process.platform === 'darwin') {
    t.skip('Bash 5 is not installed on this Mac; Linux CI requires it'); return;
  }
  assert.ok(bash5, 'Bash 5 is required for the Linux release-plan check');
  for (const source of [...blocks, helpers, partialHelpers]) passed(spawnSync(bash5, ['-n'], { input: source, encoding: 'utf8' }));
});

test('every block and persisted helper parses in macOS /bin/bash 3.2', {
  skip: process.platform !== 'darwin' || bashVersion('/bin/bash') !== '3.2'
    ? 'macOS /bin/bash 3.2 is not present; Bash 5 is checked separately' : false,
}, () => {
  for (const source of [...blocks, helpers, partialHelpers]) passed(spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8' }));
});

// Same parser as the OAuth contract: tracks command substitutions, skips
// heredoc bodies. Its positive/negative controls exercise the scope detector.
function unsafeSubstitution(source: string) {
  type Frame = { quote: string; depth: number };
  const frames: Frame[] = [{ quote: '', depth: 0 }];
  let delimiter: string | undefined;
  for (const line of source.split('\n')) {
    if (delimiter) { if (line === delimiter) delimiter = undefined; continue; }
    for (let i = 0; i < line.length; i++) {
      const frame = frames[frames.length - 1]!;
      const char = line[i]!;
      if (char === '\\' && frame.quote !== "'") { i++; continue; }
      if (char === "'") {
        if (!frame.quote) frame.quote = "'";
        else if (frame.quote === "'") frame.quote = '';
        continue;
      }
      if (frame.quote === "'") continue;
      if (char === '"') { frame.quote = frame.quote === '"' ? '' : '"'; continue; }
      if (char === '$' && line[i + 1] === '(') {
        frames.push({ quote: '', depth: 1 }); i++; continue;
      }
      if (frame.quote) continue;
      if (char === '#' && (i === 0 || /\s/.test(line[i - 1]!))) break;
      if (char === '<' && line[i + 1] === '<') {
        if (frames.length > 1) return true;
        const match = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line.slice(i));
        if (match) { delimiter = match[1]; i += match[0].length - 1; }
      }
      if (frames.length > 1) {
        if (char === '(') frame.depth++;
        if (char === ')') { frame.depth--; if (frame.depth === 0) frames.pop(); }
      }
    }
  }
  return false;
}
test('every block is labeled; embedded Python compiles; heredoc substitutions refuse', () => {
  assert.equal(blocks.length, [...plan.matchAll(/^```sh$/gm)].length);
  const seen = new Set<string>();
  for (const source of [...blocks, helpers, partialHelpers]) {
    if (blocks.includes(source)) {
      const [step, readonly, host] = source.split('\n');
      assert.match(step!, /^# step: edge-[a-z0-9-]+$/);
      assert.match(readonly!, /^# readonly: (yes|no|probe)$/); assert.match(host!, /^# host: /);
      assert.ok(!seen.has(step!)); seen.add(step!);
    }
    assert.equal(unsafeSubstitution(source), false, source.split('\n')[0]);
    for (const m of source.matchAll(/^[ \t]*python3[^\n]*<<'([A-Z_]+)'[^\n]*\n([\s\S]*?)^\1$/gm)) {
      passed(spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(),"<edge-python>","exec")'], { input: m[2]!, encoding: 'utf8' }));
    }
  }
  assert.equal(unsafeSubstitution("v=$(python3 - <<'PY'\nprint(1)\nPY\n)"), true);
  assert.equal(unsafeSubstitution("python3 - \"$(hostname)\" <<'PY'\nprint(1)\nPY"), false);
});

test('inputs require the exact measured set and grammar; table agrees with enforcing validator', () => {
  const valid = fixture(); passed(validate(valid));
  const keys = [...plan.split('Staging is snapshot M')[0]!.matchAll(/^\| ([a-z_0-9]+) \|/gm)].map(m => m[1]!);
  assert.deepEqual(keys.sort(), Object.keys(valid).sort(), 'documented input set');
  for (const k of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[k];
    stopped(validate(missing), /exact input keys.*STOP/);
    stopped(validate({ ...valid, [k]: 123 }), /must be strings.*STOP/);
    stopped(validate({ ...valid, [k]: 'malformed/input' }));
  }
  for (const value of [null, [], {}, { ...valid, extra: true }]) stopped(validate(value));
  stopped(validate(valid, { raw: '{' }));
  stopped(validate(valid, { raw: JSON.stringify(valid).replace('"release_sha":', '"release_sha":"duplicate","release_sha":') }));
  stopped(validate({ ...valid, release_sha: valid.baseline_edge_sha }));
  stopped(validate({ ...valid, window_end_utc: '2031-02-30T12:10:00Z' }));
});

test('staging requires its host, root marker bytes and mode; production rejects staging layout', () => {
  const staging = { ...fixture(), target: 'staging', box_hostname: 'c1-staging-20261006', window_id: 'stg123' };
  const opts = { host: staging.box_hostname, marker: 'c1-staging-disposable-no-production', root: true };
  passed(validate(staging, opts));
  stopped(validate(staging, { ...opts, host: 'yulan-vps-1' }));
  stopped(validate(staging, { host: staging.box_hostname }));
  stopped(validate(staging, { ...opts, marker: opts.marker + '\n' }));
  stopped(validate(staging, { ...opts, root: false }));
  stopped(validate(staging, { ...opts, mode: 0o644 }));
  stopped(validate({ ...staging, window_id: 'Abc123' }, opts));
  stopped(validate(fixture(), { marker: opts.marker, root: true }));
  passed(validate(fixture()));
});

test('OAuth timing rule refuses opening at or within 35 minutes before every recycle', () => {
  for (const hour of [3, 9, 15, 21]) {
    const recycle = new Date(`2031-02-03T${String(hour).padStart(2, '0')}:30:00Z`);
    const at = (seconds: number) => new Date(+recycle + seconds * 1000).toISOString().replace('.000Z', 'Z');
    for (const seconds of [-2100, -1800, -600, 0]) {
      stopped(validate({ ...fixture(), window_end_utc: at(seconds + 600) }, { now: at(seconds) }), /35 minutes before recycle.*STOP/);
    }
    passed(validate({ ...fixture(), window_end_utc: at(-601) }, { now: at(-2101) }));
    passed(validate({ ...fixture(), window_end_utc: at(601) }, { now: at(1) }));
  }
  stopped(validate({ ...fixture(), window_end_utc: clock }));
  stopped(validate({ ...fixture(), window_end_utc: '2031-02-03T12:30:01Z' }));
  passed(validate(fixture()));
});

test('run-order rows 0..8 and R0..R4 refer only to executable steps', () => {
  const rows = [...plan.matchAll(/^\| (\d+|R\d+) \| (edge-[a-z-]+) \|/gm)];
  assert.deepEqual(rows.map(m => m[1]).sort(), ['0','1','2','3','4','5','6','7','8','R0','R1','R2','R3','R4'].sort());
  for (const r of rows) block(r[2]!);
});

// Run extracted lifecycle blocks against real fixture files. Paths are mapped
// into one test-owned root. Python supplies root uid/gid only for recycle.json;
// bytes, modes, atomic rename, receipt ordering and current links remain real.
function lifecycle(trees = true) {
  const root = mkdtempSync(join(scratch, 'lifecycle-')), home = join(root, 'home'), d = fixture();
  const proof = join(home, 'edge/release-proofs', d.release_sha + '-' + d.window_id);
  mkdirSync(proof, { recursive: true, mode: 0o700 });
  const old = join(home, 'edge/releases', d.baseline_edge_sha), fresh = join(home, 'edge/releases', d.release_sha), helper = join(home, 'admin-issuance/releases', d.release_sha);
  mkdirSync(old, { recursive: true });
  if (trees) { mkdirSync(fresh, { recursive: true }); mkdirSync(helper, { recursive: true }); }
  writeFileSync(join(old, 'baseline.txt'), 'immutable baseline');
  // Real files/links back the partial-open checks; only host APIs are stubbed.
  const fileInputs: Array<[string, keyof typeof d]> = [
    [join(home, '.env'), 'edge_env_sha256'],
    [join(old, 'deploy/edge-runtime/compose.override.yaml'), 'override_sha256'],
    [join(root, 'etc/caddy/Caddyfile'), 'caddyfile_sha256'],
    [join(root, 'etc/caddy/sites/10-commonswarm-api.caddy'), 'api_caddy_sha256'],
    [join(root, 'etc/caddy/sites/20-commonswarm-mcp.caddy'), 'mcp_caddy_sha256'],
    [join(root, 'libexec/commonswarm-admin-edge-recycle'), 'recycle_hook_sha256'],
    [join(root, 'etc/systemd/system', d.edge_recycle_service + '.d/50-admin-measurement.conf'), 'recycle_dropin_sha256'],
  ];
  for (const [path, key] of fileInputs) {
    mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, 'baseline ' + key); d[key] = hash('baseline ' + key);
  }
  for (const surface of ['oauth', 'stack'] as const) {
    const target = join(home, surface, 'releases', d[`baseline_${surface}_sha`]);
    mkdirSync(target, { recursive: true }); symlinkSync(target, join(home, surface, 'current'));
  }
  d.baseline_site_target = join(root, 'srv/commonswarm/site/releases', d.baseline_site_target.split('/').pop()!);
  mkdirSync(d.baseline_site_target, { recursive: true }); symlinkSync(d.baseline_site_target, join(root, 'srv/commonswarm/site/current'));
  d.recycle_unit_sha256 = hash('baseline service'); d.recycle_timer_sha256 = hash('baseline timer');
  const current = join(home, 'edge/current'); symlinkSync(old, current);
  const binding = join(root, 'recycle.json');
  const baseline = Buffer.from(' { "release_sha":"' + d.baseline_edge_sha + '", "target":"' + old + '", "image_digest":"' + d.baseline_edge_image + '", "artifact_digest":"' + d.recycle_archive_sha256 + '", "archive":"/tmp/admin-issuance-baseline.tar", "postgres_image":"' + d.baseline_postgres_image + '", "release_root":"/retained/baseline-helper" }\n');
  writeFileSync(binding, baseline, { mode: 0o600 }); writeFileSync(join(proof, 'recycle.baseline.json'), baseline);
  writeFileSync(join(proof, 'plan.md'), plan);
  const checker = JSON.stringify({ release_sha: d.release_sha, plan_sha256: hash(plan), archive_sha256: d.archive_sha256, result: 'PASS', server_suite: 'PASS', meta_regression: 'PASS' });
  writeFileSync(join(proof, 'checker.json'), checker);
  writeFileSync(join(proof, 'inputs.json'), JSON.stringify({ ...d, plan_sha256: hash(plan), checker_sha256: hash(checker), recycle_json_sha256: hash(baseline) }));
  writeFileSync(join(proof, 'open.txt'), 'PASS\n'); writeFileSync(join(proof, 'opened.txt'), clock);
  writeFileSync(join(proof, 'preflight.txt'), 'PASS\n');
  writeFileSync(join(proof, 'override.json'), JSON.stringify({ archive_sha256: d.override_sha256, baseline_sha256: d.override_sha256, copied_sha256: d.override_sha256, archive_matched_baseline: true }));
  const stage = join(root, 'anvil-secret.Abc123'), lock = join(home, 'edge/release-proofs/OPEN');
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(lock);
  writeFileSync(join(lock, 'proof.path'), proof + '\n');
  writeFileSync(join(proof, 'secret-stage.path'), stage + '\n');
  for (const [path, kind] of (trees ? [[fresh, 'edge'], [helper, 'helper']] : [])) {
    writeFileSync(join(proof, kind + '-tree-created.json'), JSON.stringify({ path, release_sha: d.release_sha, window_id: d.window_id }));
  }
  writeFileSync(join(proof, 'ready.txt'), 'PASS\n'); writeFileSync(join(proof, 'timer'), 'active');
  const wrapper = join(root, 'python-wrapper.py');
  writeFileSync(wrapper, `
import datetime,json,os,pathlib,subprocess,sys
sys.argv=sys.argv[1:]
real_datetime=datetime.datetime
class Clock(real_datetime):
 @classmethod
 def now(cls,tz=None): return real_datetime.fromisoformat(os.environ['FIXTURE_CLOCK'].replace('Z','+00:00'))
datetime.datetime=Clock
actual=pathlib.Path.stat
def stat(self,*a,**kw):
 s=actual(self,*a,**kw)
 if str(self)==os.environ['FIXTURE_BINDING'] or self.name in ('failed-attempts','releases') or str(self)==os.environ['FIXTURE_STAGE'] or str(self)==os.environ['PROOF_DIR']:
  fields=list(s); fields[4]=fields[5]=0; return os.stat_result(fields)
 return s
pathlib.Path.stat=stat
actual_chown=os.fchown
def chown(fd,uid,gid):
 if (uid,gid)==(0,0): return actual_chown(fd,os.getuid(),os.getgid())
 return actual_chown(fd,uid,gid)
os.fchown=chown
real_check_output=subprocess.check_output
def check_output(args,*a,**kw):
 if args[:2]==['docker','inspect']:
  d=json.loads((pathlib.Path(os.environ['PROOF_DIR'])/'inputs.json').read_bytes())
  key={'commonswarm-edge-edge-runtime-1':'baseline_edge_image','commonswarm-oauth-oauth-1':'baseline_oauth_image','commonswarm-postgres':'baseline_postgres_image'}[args[2]]
  return json.dumps([{'Image':d[key],'State':{'Running':True,'Health':{'Status':'healthy'}},'Config':{'Labels':{'com.docker.compose.project.working_dir':os.environ['FIXTURE_OLD_EDGE']+'/deploy/edge-runtime'}}}]).encode()
 if args[:2]==['systemctl','cat']: return b'baseline timer' if args[2].endswith('.timer') else b'baseline service'
 if args[:2]==['systemctl','show']: return 'inactive\\n'
 if args[0] in ('docker','systemctl'): raise AssertionError('host mutation is forbidden in fixture')
 return real_check_output(args,*a,**kw)
subprocess.check_output=check_output
real_run=subprocess.run
def run(args,*a,**kw):
 if args[:3]==['systemctl','is-active','--quiet']:
  status=0 if (pathlib.Path(os.environ['PROOF_DIR'])/'timer').read_text()=='active' else 1
  if kw.get('check') and status: raise subprocess.CalledProcessError(status,args)
  return subprocess.CompletedProcess(args,status)
 if args[0] in ('docker','systemctl'): raise AssertionError('host mutation is forbidden in fixture')
 return real_run(args,*a,**kw)
subprocess.run=run
exec(compile(sys.stdin.read(),'<extracted-plan-python>','exec'))
`);
  const mapped = helpers.replaceAll('/home/commonswarm', home);
  const session = `
PROOF_DIR=${JSON.stringify(proof)}
INPUTS_FILE="$PROOF_DIR/inputs.json"
RELEASE_SHA=${d.release_sha}
WINDOW_ID=${d.window_id}
OLD_EDGE=${JSON.stringify(old)}
OLD_HELPER=/retained/baseline-helper
NEW_EDGE=${JSON.stringify(fresh)}
NEW_HELPER=${JSON.stringify(helper)}
RECYCLE_JSON=${JSON.stringify(binding)}
SECRET_STAGE=${JSON.stringify(stage)}
LOCK=${JSON.stringify(lock)}
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${d.release_sha}-${d.window_id}.tar
EDGE_RECYCLE_TIMER=commonswarm-edge-recycle.timer
EDGE_RECYCLE_SERVICE=commonswarm-edge-recycle.service
${mapped}
python3() { if test "$1" = -c; then ${quotedPythonExecutable} "$@"; else ${quotedPythonExecutable} ${JSON.stringify(wrapper)} "$@"; fi; }
${process.platform === 'darwin' ? `# Mac fixture maps only the Linux rename primitive; Linux uses real mv -Tf.
mv() { test "$1" = -Tf; ${quotedPythonExecutable} -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$2" "$3"; }` : ''}
edge_invariants() { :; }
edge_render() { :; }
edge_readback() { :; }
edge_tree_check() { :; }
edge_route_probes() { :; }
edge_db_state() { cp "$PROOF_DIR/baseline.cutover.json" "$1.cutover.json"; }
edge_db() { printf 'invalidation-commit\\n' >>"$PROOF_DIR/events"; }
edge_ro() { printf 't\\n'; }
edge_measure() { printf 'measurement %s\\n' "$1" >>"$PROOF_DIR/events"; }
edge_identity() { test "$(readlink ${JSON.stringify(current)})" = "$1"; }
edge_recreate() { printf 'recreate %s\\n' "$1" >>"$PROOF_DIR/events"; }
systemctl() {
 case "$1" in
  stop) printf inactive >"$PROOF_DIR/timer";;
  start) printf active >"$PROOF_DIR/timer";;
  is-active) test "$(cat "$PROOF_DIR/timer")" = active;;
  show) if test "\${@: -1}" = "$EDGE_RECYCLE_TIMER"; then cat "$PROOF_DIR/timer"; else printf inactive; fi;;
  *) return 1;;
 esac
}
`;
  writeFileSync(join(proof, 'session.sh'), session); writeFileSync(join(proof, 'baseline.cutover.json'), '{"closed":true}\n');
  const partial = partialHelpers.replaceAll('/home/commonswarm', home).replaceAll('/tmp/anvil-secret', root + '/anvil-secret')
    .replaceAll('/etc/commonswarm-admin-release/recycle.json', binding).replaceAll('/etc/', root + '/etc/')
    .replaceAll('/usr/local/libexec/', root + '/libexec/').replaceAll('/srv/commonswarm/', root + '/srv/commonswarm/');
  writeFileSync(join(proof, 'partial-session.sh'), `python3() { ${quotedPythonExecutable} ${JSON.stringify(wrapper)} "$@"; }\n${partial}\n`);
  return { root, proof, home, current, binding, baseline, old, fresh, helper, stage, lock, run(source: string, extra: Record<string,string> = {}) {
    return spawnSync('/bin/bash', ['-s'], { input: source.replaceAll('/home/commonswarm', home).replaceAll('/tmp/anvil-secret', root + '/anvil-secret'), encoding: 'utf8', env: { ...process.env, PROOF_DIR: proof, FIXTURE_BINDING: binding, FIXTURE_CLOCK: clock, FIXTURE_STAGE: stage, FIXTURE_OLD_EDGE: old, ...extra } });
  }, append(source: string) { writeFileSync(join(proof, 'session.sh'), readFileSync(join(proof, 'session.sh'), 'utf8') + '\n' + source); } };
}

// Archive admission owns a distinct packaging risk: the lifecycle fixtures above
// do not extract release artifacts. Execute the complete preflight and its real
// tree checker; only root-parent metadata and unavailable host I/O are supplied.
const overridePath = 'deploy/edge-runtime/compose.override.yaml';
const c1PlanPath = 'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md';
const c1Plan = readFileSync(resolve(c1PlanPath), 'utf8');
const hookBlocks = [...c1Plan.matchAll(/^```sh\n(# step: ai-recycle-hook\n[\s\S]*?)^```$/gm)];
assert.equal(hookBlocks.length, 1);
const reviewedHook = '#!/bin/bash\n' + hookBlocks[0]![1];
const repoOverride = readFileSync(resolve(overridePath), 'utf8');
const repoCompose = readFileSync(resolve('deploy/edge-runtime/compose.yaml'), 'utf8');
function archiveLifecycle(options: { archiveOverride?: string; baseline?: string; realArchive?: boolean } = {}) {
  const f = lifecycle(false), archive = join(f.root, 'release.tar');
  const baseline = options.baseline ?? repoOverride;
  writeFileSync(join(f.old, overridePath), baseline); chmodSync(join(f.old, overridePath), 0o640);
  writeFileSync(join(f.old, 'deploy/edge-runtime/compose.yaml'), repoCompose);
  const hook = join(f.root, 'libexec/commonswarm-admin-edge-recycle');
  writeFileSync(hook, reviewedHook);
  if (options.realArchive) {
    passed(spawnSync('git', ['archive', '--format=tar', 'HEAD', '-o', archive], { encoding: 'utf8' }));
  } else {
    const files: Record<string, string> = {
      [overridePath]: options.archiveOverride ?? repoOverride,
      'deploy/edge-runtime/compose.yaml': repoCompose,
      'deploy/edge-runtime/bootstrap.sh': '#!/bin/bash\n',
      'deploy/edge-runtime/h0-deno.json': '{}\n',
      'deploy/edge-runtime/main/index.ts': '// fixture router\n',
      'supabase/functions/command/index.ts': '// fixture function\n',
      'src/protocol/index.ts': '// fixture core\n',
      'deploy/supabase-stack/migrate/make-pg-service.mjs': '// fixture helper\n',
      [c1PlanPath]: c1Plan,
      'site/AGENTS.md': 'fixture site instructions\n',
    };
    passed(spawnSync('python3', ['-c', `
import io,json,pathlib,sys,tarfile
files=json.load(sys.stdin); dirs=set()
for name in files:
 dirs.update(str(p) for p in pathlib.PurePosixPath(name).parents if str(p)!='.')
with tarfile.open(sys.argv[1],'w') as t:
 for name in sorted(dirs):
  m=tarfile.TarInfo(name+'/'); m.type=tarfile.DIRTYPE; m.mode=0o755; t.addfile(m)
 for name,data in files.items():
  raw=data.encode(); m=tarfile.TarInfo(name); m.size=len(raw); m.mode=0o644; t.addfile(m,io.BytesIO(raw))
 m=tarfile.TarInfo('site/CLAUDE.md'); m.type=tarfile.SYMTYPE; m.linkname='AGENTS.md'; t.addfile(m)
`, archive], { input: JSON.stringify(files), encoding: 'utf8' }));
  }
  const input = join(f.proof, 'inputs.json'), d = JSON.parse(readFileSync(input, 'utf8'));
  if (options.realArchive) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }); passed(head);
    // Match the release marker to the actual artifact SHA and root names.
    d.release_sha = head.stdout.trim();
  }
  const fresh = join(resolve(f.fresh, '..'), d.release_sha), helper = join(resolve(f.helper, '..'), d.release_sha);
  d.archive_sha256 = hash(readFileSync(archive)); d.override_sha256 = hash(baseline);
  const checker = JSON.stringify({ release_sha: d.release_sha, plan_sha256: d.plan_sha256, archive_sha256: d.archive_sha256, result: 'PASS', server_suite: 'PASS', meta_regression: 'PASS' });
  writeFileSync(join(f.proof, 'checker.json'), checker); d.checker_sha256 = hash(checker);
  writeFileSync(input, JSON.stringify(d));
  writeFileSync(archive.replace(/\.tar$/, '.ancestry.json'), JSON.stringify({ release_sha: d.release_sha, origin_main_sha: d.release_sha, is_ancestor: true, baseline_site_sha: d.baseline_site_sha, measured_at: clock }));
  const treeChecker = /^edge_tree_check\(\) \{[\s\S]*?^\}/m.exec(helpers)![0];
  f.append(`RELEASE_SHA=${d.release_sha}\nNEW_EDGE=${JSON.stringify(fresh)}\nNEW_HELPER=${JSON.stringify(helper)}\nBOX_ARCHIVE_PATH=${JSON.stringify(archive)}\nRECYCLE_HOOK=${JSON.stringify(hook)}\n${treeChecker}`);
  return { ...f, fresh, helper, archive, d };
}

test('archive override is admitted, baseline bytes and metadata win, and both trees are verified', () => {
  for (const archiveOverride of [repoOverride, repoOverride + '# archive-only drift\n']) {
    const f = archiveLifecycle({ archiveOverride });
    passed(f.run(block('edge-preflight')));
    assert.equal(readFileSync(join(f.fresh, overridePath), 'utf8'), repoOverride);
    assert.equal(readFileSync(join(f.helper, overridePath), 'utf8'), archiveOverride);
    const old = lstatSync(join(f.old, overridePath)), fresh = lstatSync(join(f.fresh, overridePath));
    assert.deepEqual([fresh.uid, fresh.gid, fresh.mode & 0o777], [old.uid, old.gid, old.mode & 0o777]);
    const receipt = JSON.parse(readFileSync(join(f.proof, 'override.json'), 'utf8'));
    assert.equal(receipt.archive_matched_baseline, archiveOverride === repoOverride);
    assert.equal(receipt.archive_sha256, hash(archiveOverride));
    assert.equal(receipt.baseline_sha256, hash(repoOverride));
    assert.equal(receipt.copied_sha256, hash(repoOverride));
    // The unchanged C1 recycle hook still compares live files to archive bytes.
    // Refuse forward work before any recreation if that hook would later fail.
    if (archiveOverride === repoOverride) passed(f.run(block('edge-ready')));
    else stopped(f.run(block('edge-ready')), /recycle hook.*archive.*override.*STOP/);
    assert.equal(existsSync(join(f.proof, 'edge-attempted.txt')), false);
    // Only the edge override may use baseline bytes; helper files stay exact.
    const checkTree = '. "$PROOF_DIR/session.sh"\nedge_tree_check ';
    writeFileSync(join(f.helper, overridePath), 'unverified helper drift\n');
    stopped(f.run(checkTree + '"$NEW_HELPER" "$BOX_ARCHIVE_PATH" ' + f.d.archive_sha256), /AssertionError/);
    writeFileSync(join(f.helper, overridePath), archiveOverride);
    passed(f.run(checkTree + '"$NEW_HELPER" "$BOX_ARCHIVE_PATH" ' + f.d.archive_sha256));
    writeFileSync(join(f.fresh, overridePath), 'unverified edge drift\n');
    stopped(f.run(checkTree + '"$NEW_EDGE" "$BOX_ARCHIVE_PATH" ' + f.d.archive_sha256), /baseline override digest.*STOP/);
  }
});

test('missing, symlinked or changed baseline override refuses before creating release trees', () => {
  for (const kind of ['missing', 'symlink', 'changed']) {
    const f = archiveLifecycle(), path = join(f.old, overridePath);
    if (kind === 'changed') writeFileSync(path, 'changed baseline\n');
    else {
      passed(spawnSync('mv', [path, path + '.retained'], { encoding: 'utf8' }));
      if (kind === 'symlink') symlinkSync(path + '.retained', path);
    }
    stopped(f.run(block('edge-preflight')), /baseline override.*STOP/);
    for (const path of [f.fresh, f.helper, join(f.proof, 'edge-tree-created.json'), join(f.proof, 'helper-tree-created.json')]) assert.equal(existsSync(path), false);
  }
  passed(archiveLifecycle().run(block('edge-preflight')));
});

test('real git archive of repository HEAD passes archive admission and exact helper/edge content checks', () => {
  const f = archiveLifecycle({ realArchive: true });
  passed(f.run(block('edge-preflight')));
  for (const root of [f.fresh, f.helper]) {
    assert.equal(readFileSync(join(root, 'RELEASE_SHA'), 'utf8'), f.d.release_sha + '\n');
    assert.equal(readlinkSync(join(root, 'site/CLAUDE.md')), 'AGENTS.md');
    assert.deepEqual(readFileSync(join(root, 'deploy/supabase-stack/migrate/make-pg-service.mjs')), readFileSync(resolve('deploy/supabase-stack/migrate/make-pg-service.mjs')));
  }
});

test('abort runs R0 → R2 → R4 with baseline probes, no deadline or recreate, and refuses further forward work', () => {
  for (const trees of [true, false]) {
  const f = lifecycle(trees); const expired = { FIXTURE_CLOCK: '2031-02-03T13:00:00Z' };
  passed(f.run(block('edge-abort'), expired));
  assert.deepEqual(readFileSync(f.binding), f.baseline);
  assert.equal(readlinkSync(f.current), f.old);
  assert.equal(existsSync(join(f.proof, 'events')), false);
  assert.equal(readFileSync(join(f.proof, 'aborted-before-attempt.txt'), 'utf8'), 'PASS\n');
  assert.equal(readFileSync(join(f.proof, 'probes-aborted-before-attempt.txt'), 'utf8'), 'PASS\n');
  for (const step of ['edge-apply', 'edge-ready', 'edge-preflight']) stopped(f.run(block(step)));
  assert.equal(existsSync(join(f.proof, 'edge-attempted.txt')), false);
  passed(f.run(block('edge-release-aside'), expired));
  assert.equal(existsSync(f.fresh), false); assert.equal(existsSync(f.helper), false);
  const aside = JSON.parse(readFileSync(join(f.proof, 'aside.json'), 'utf8'));
  assert.deepEqual(aside.map((r: { moved: boolean }) => r.moved), [trees, trees]);
  passed(f.run(block('edge-close'), { ...expired, CLOSE_RESULT: 'aborted' }));
  assert.equal(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).result, 'aborted');
  assert.equal(existsSync(join(f.proof, 'closed.txt')), true);
  assert.equal(existsSync(f.stage), false);
  assert.equal(existsSync(f.lock), false);
  assert.equal(existsSync(join(f.proof, 'events')), false);
  assert.deepEqual(readFileSync(f.binding), f.baseline);
  }
  // Positive apply control reaches the same actual admission before its mutation.
  const control = lifecycle(); passed(control.run(block('edge-apply')));
  const attempted = lifecycle(); writeFileSync(join(attempted.proof, 'edge-attempted.txt'), clock);
  stopped(attempted.run(block('edge-abort')), /attempt present.*STOP/);
});

test('partial open recovers by R0 → R4 without session, routes, DB or service mutations', () => {
  const partial = () => {
    const f = lifecycle(false);
    for (const name of ['open.txt', 'preflight.txt', 'ready.txt', 'session.sh', 'baseline.cutover.json']) {
      passed(spawnSync('mv', [join(f.proof, name), join(f.proof, 'retained-' + name)], { encoding: 'utf8' }));
    }
    return f;
  };
  const expired = { FIXTURE_CLOCK: '2031-02-03T13:00:00Z' };
  const f = partial();
  stopped(f.run(block('edge-close'), { ...expired, CLOSE_RESULT: 'aborted' }));
  assert.equal(existsSync(join(f.proof, 'closed.txt')), false, 'R0 is required');
  passed(f.run(block('edge-abort'), expired));
  const receipt = JSON.parse(readFileSync(join(f.proof, 'partial-open-aborted.json'), 'utf8'));
  assert.equal(receipt.proof_dir, f.proof); assert.equal(receipt.lock, f.lock);
  assert.equal(receipt.secret_stage, f.stage);
  assert.equal(receipt.routes, 'skipped-partial-open');
  assert.equal(existsSync(f.stage), false); assert.equal(existsSync(f.lock), true);
  passed(f.run(block('edge-abort'), expired)); // Retry also works after cleanup.
  stopped(f.run(block('edge-close'), { ...expired, CLOSE_RESULT: 'success' }));
  writeFileSync(join(f.proof, 'timer'), 'inactive');
  stopped(f.run(block('edge-close'), { ...expired, CLOSE_RESULT: 'aborted' }));
  assert.equal(existsSync(join(f.proof, 'closed.txt')), false);
  writeFileSync(join(f.proof, 'timer'), 'active');
  passed(f.run(block('edge-close'), { ...expired, CLOSE_RESULT: 'aborted' }));
  const closed = JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8'));
  assert.equal(closed.result, 'aborted'); assert.equal(closed.admin_gate, 'not-verified-partial-open');
  assert.equal(existsSync(f.lock), false); assert.equal(existsSync(join(f.proof, 'events')), false);
  assert.deepEqual(readFileSync(f.binding), f.baseline); assert.equal(readlinkSync(f.current), f.old);
  for (const name of ['open.txt', 'edge-attempted.txt', 'preflight.txt', 'rollback.txt', 'closed.txt', 'edge-tree-created.json']) {
    const bad = partial();
    symlinkSync(join(bad.root, 'absent'), join(bad.proof, name));
    stopped(bad.run(block('edge-abort')));
    assert.equal(existsSync(bad.stage), true); assert.equal(existsSync(bad.lock), true);
    assert.equal(existsSync(join(bad.proof, 'partial-open-aborted.json')), false);
  }
  const drift = partial(); writeFileSync(join(drift.proof, 'plan.md'), 'changed');
  stopped(drift.run(block('edge-abort'))); assert.equal(existsSync(drift.stage), true);
  const bindingDrift = partial(); writeFileSync(bindingDrift.binding, 'changed binding');
  stopped(bindingDrift.run(block('edge-abort'))); assert.equal(existsSync(bindingDrift.stage), true);
  const noStage = partial();
  passed(spawnSync('mv', [join(noStage.proof, 'secret-stage.path'), join(noStage.proof, 'retained-stage.path')], { encoding: 'utf8' }));
  passed(spawnSync('rm', ['-r', '--', noStage.stage], { encoding: 'utf8' }));
  passed(noStage.run(block('edge-abort'))); passed(noStage.run(block('edge-close'), { CLOSE_RESULT: 'aborted' }));
});

test('apply rebinds new identity and rollback restores exact JSON bytes and baseline tree', () => {
  const f = lifecycle(); passed(f.run(block('edge-apply')));
  const applied = JSON.parse(readFileSync(f.binding, 'utf8'));
  assert.equal(applied.release_sha, fixture().release_sha);
  assert.equal(applied.release_root, f.helper);
  assert.equal(applied.archive, `/tmp/admin-issuance-${fixture().release_sha}-${fixture().window_id}.tar`);
  assert.equal(applied.artifact_digest, fixture().archive_sha256);
  assert.equal(applied.postgres_image, fixture().baseline_postgres_image);
  assert.equal(readlinkSync(f.current), f.fresh);
  assert.equal(readFileSync(join(f.proof, 'timer'), 'utf8'), 'active');
  passed(f.run(block('edge-rollback')));
  assert.deepEqual(readFileSync(f.binding), f.baseline, 'restore formatting, order and whitespace too');
  assert.equal(readlinkSync(f.current), f.old);
  assert.equal(readFileSync(join(f.old, 'baseline.txt'), 'utf8'), 'immutable baseline');
  assert.equal(readFileSync(join(f.proof, 'timer'), 'utf8'), 'active');
  assert.deepEqual(readFileSync(join(f.proof, 'events'), 'utf8').trim().split('\n'), [
    'invalidation-commit', `recreate ${f.fresh}`, `measurement ${fixture().release_sha}`,
    'invalidation-commit', `recreate ${f.old}`, `measurement ${fixture().baseline_edge_sha}`,
  ]);
  passed(f.run(block('edge-release-aside')));
  passed(f.run(block('edge-probes'), { PROBE_PHASE: 'recovery', FIXTURE_CLOCK: '2031-02-03T13:00:00Z' }));
  passed(f.run(block('edge-close'), { CLOSE_RESULT: 'rolled-back', FIXTURE_CLOCK: '2031-02-03T13:00:00Z' }));
  assert.equal(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).result, 'rolled-back');

});

test('real forward admission refuses missing open, terminal receipts and changed plan bytes before mutation', () => {
  for (const step of ['edge-apply', 'edge-ready', 'edge-preflight']) {
    for (const receipt of ['open.txt', 'aborted-before-attempt.txt', 'rollback.txt', 'closed.txt', 'close-result.json', 'plan.md']) {
      const f = lifecycle();
      if (receipt === 'open.txt') {
        passed(spawnSync('mv', [join(f.proof, receipt), join(f.proof, 'retained-open.txt')], { encoding: 'utf8' }));
      } else writeFileSync(join(f.proof, receipt), 'fixture terminal or drift\n');
      stopped(f.run(block(step)));
      assert.equal(existsSync(join(f.proof, 'events')), false);
      assert.equal(existsSync(join(f.proof, 'edge-attempted.txt')), false);
      assert.deepEqual(readFileSync(f.binding), f.baseline);
      assert.equal(readlinkSync(f.current), f.old);
    }
  }
  for (const receipt of ['aborted-before-attempt.txt', 'rollback.txt', 'closed.txt', 'close-result.json']) {
    const f = lifecycle(); symlinkSync(join(f.root, 'absent'), join(f.proof, receipt));
    stopped(f.run(block('edge-apply')));
    assert.equal(existsSync(join(f.proof, 'events')), false, 'dangling receipt must also refuse');
  }
  const control = lifecycle(); passed(control.run(block('edge-ready'))); passed(control.run(block('edge-apply')));
});

test('second apply refuses the existing regular attempt without overwriting it or recreating', () => {
  const f = lifecycle(); passed(f.run(block('edge-apply')));
  const attempt = readFileSync(join(f.proof, 'edge-attempted.txt'));
  const events = readFileSync(join(f.proof, 'events'));
  const binding = readFileSync(f.binding);
  stopped(f.run(block('edge-apply')));
  assert.deepEqual(readFileSync(join(f.proof, 'edge-attempted.txt')), attempt);
  assert.deepEqual(readFileSync(join(f.proof, 'events')), events);
  assert.deepEqual(readFileSync(f.binding), binding);
});

test('real forward deadline rechecks the OAuth boundary and expiry before an attempt', () => {
  for (const hour of [3, 9, 15, 21]) {
    const recycle = new Date(`2031-02-03T${String(hour).padStart(2, '0')}:30:00Z`);
    const at = (seconds: number) => new Date(+recycle + seconds * 1000).toISOString().replace('.000Z', 'Z');
    for (const seconds of [-2101, -2100, -1800, -1, 0, 1]) {
      const f = lifecycle();
      const d = JSON.parse(readFileSync(join(f.proof, 'inputs.json'), 'utf8'));
      d.window_end_utc = at(seconds + 600);
      writeFileSync(join(f.proof, 'inputs.json'), JSON.stringify(d));
      writeFileSync(join(f.proof, 'opened.txt'), at(seconds));
      const r = f.run(block('edge-apply'), { FIXTURE_CLOCK: at(seconds) });
      if (seconds === -2101 || seconds === 1) passed(r);
      else {
        stopped(r, /35 minutes before recycle.*STOP/);
        assert.equal(existsSync(join(f.proof, 'edge-attempted.txt')), false);
      }
    }
  }
  // OAuth permits a correctly opened window to continue inside the opening margin.
  const continuing = lifecycle();
  const d = JSON.parse(readFileSync(join(continuing.proof, 'inputs.json'), 'utf8'));
  d.window_end_utc = '2031-02-03T09:24:00Z';
  writeFileSync(join(continuing.proof, 'inputs.json'), JSON.stringify(d));
  writeFileSync(join(continuing.proof, 'opened.txt'), '2031-02-03T08:54:00Z');
  passed(continuing.run(block('edge-apply'), { FIXTURE_CLOCK: '2031-02-03T09:00:00Z' }));
  const f = lifecycle();
  stopped(f.run(block('edge-apply'), { FIXTURE_CLOCK: fixture().window_end_utc }), /deadline.*STOP/);
  assert.equal(existsSync(join(f.proof, 'edge-attempted.txt')), false);
});

test('a failed complete block stops its work and preserves a parent shell with inherited errexit', () => {
  const f = lifecycle(); f.append('edge_recreate() { false; printf "UNREACHABLE\\n"; }');
  const r = f.run('set -eEuo pipefail\n' + block('edge-apply') + '\nstatus=$?\nprintf "PARENT-ALIVE status=%s\\n" "$status"\n');
  passed(r); assert.match(r.stderr, /FAIL edge-apply.*STOP/);
  assert.match(r.stdout, /PARENT-ALIVE status=1/); assert.doesNotMatch(r.stdout, /UNREACHABLE/);
  assert.equal(readFileSync(join(f.proof, 'timer'), 'utf8'), 'active');
  const control = lifecycle();
  passed(control.run('set -eEuo pipefail\n' + block('edge-apply') + '\nprintf "PARENT-ALIVE status=%s\\n" "$?"\n'));
});

test('success close refuses an inactive timer before cleaning or recording close', () => {
  const f = lifecycle(); passed(f.run(block('edge-apply')));
  writeFileSync(join(f.proof, 'timer'), 'inactive');
  stopped(f.run(block('edge-close'), { CLOSE_RESULT: 'success' }), /timer inactive.*STOP/);
  assert.equal(existsSync(join(f.proof, 'closed.txt')), false);
  assert.equal(existsSync(join(f.proof, 'close-result.json')), false);
  // Same extracted close admission with an active timer must advance beyond it.
  writeFileSync(join(f.proof, 'timer'), 'active');
  const admission = block('edge-close').slice(0, block('edge-close').indexOf('case "${CLOSE_RESULT')) + '\nprintf "ADMITTED\\n"\n)\n';
  const control = f.run(admission); passed(control); assert.match(control.stdout, /ADMITTED/);
});

test('ERR in an extracted-block function prints FAIL STOP, stops work and restores the timer', () => {
  const f = lifecycle();
  f.append('edge_recreate() { false; printf "UNREACHABLE\\n"; }');
  const r = f.run(block('edge-apply')); stopped(r, /FAIL edge-apply: line \d+; STOP/);
  assert.doesNotMatch(r.stdout, /UNREACHABLE/);
  assert.equal(readFileSync(join(f.proof, 'timer'), 'utf8'), 'active');
  assert.equal(existsSync(join(f.proof, 'applied.txt')), false);
  assert.deepEqual(readFileSync(f.binding), f.baseline);
  // Control proves the same call reaches successful completion when it works.
  const control = lifecycle(); passed(control.run(block('edge-apply')));
});

test('binding rejects baseline tampering and unrelated live drift before a restart', () => {
  for (const path of ['snapshot','live']) {
    const f = lifecycle();
    if (path === 'snapshot') writeFileSync(join(f.proof, 'recycle.baseline.json'), '{"tampered":true}\n');
    else writeFileSync(f.binding, '{"unrelated":true}\n');
    const r = f.run('(\nset -eEuo pipefail\ntrap \'printf "FAIL binding: STOP\\n" >&2\' ERR\n. "$PROOF_DIR/session.sh"\nedge_binding restore\n)\n');
    stopped(r); assert.equal(existsSync(join(f.proof, 'events')), false);
  }
  const control = lifecycle(); passed(control.run(block('edge-apply'))); passed(control.run(block('edge-rollback')));
});

test('real legacy-fence SQL refuses restored swarm_read SELECT plus a permissive policy and every canonical fence drift', () => {
  const migration = readFileSync(resolve('supabase/migrations/20261003000003_admin_oauth_cutover.sql'), 'utf8');
  // Independent inventory: the migration owns the roles whose privileges were revoked.
  const roles = /REVOKE ALL ON swarm\.admin_credentials FROM ([^;]+);/.exec(migration)![1]!.split(',');
  const fence = /^edge_fence\(\) \{[\s\S]*?^\}/m.exec(helpers)![0];
  const runner = join(scratch, 'fence-sql.py');
  writeFileSync(runner, `
import json,os,sqlite3,sys
fixture=json.loads(os.environ['FIXTURE_FENCE_STATE']); sql=sys.argv[sys.argv.index('--command')+1]
if 'FROM commonswarm_oauth.admin_cutover_state' in sql: print('t'); raise SystemExit
if 'commonswarm_ops.migration_checksum_failures()' in sql: print('0'); raise SystemExit
db=sqlite3.connect(':memory:')
db.executescript("ATTACH DATABASE ':memory:' AS swarm; CREATE TABLE swarm.admin_credentials(revoked_at TEXT); CREATE TABLE swarm.admin_grants(registry_version INTEGER,state TEXT); CREATE TABLE pg_class(oid INTEGER,relrowsecurity INTEGER,relforcerowsecurity INTEGER); CREATE TABLE pg_policy(polrelid INTEGER);")
db.execute('INSERT INTO swarm.admin_credentials VALUES(?)',(None if fixture.get('unrevoked') else 'fixture-revoked',))
db.execute('INSERT INTO swarm.admin_grants VALUES(1,?)',('active' if fixture.get('active') else 'revoked',))
db.execute('INSERT INTO pg_class VALUES(1,?,?)',(not fixture.get('rls_disabled'),not fixture.get('force_disabled')))
if fixture.get('policy'): db.execute('INSERT INTO pg_policy VALUES(1)')
def privilege(role,table,requested,kind):
 assert table=='swarm.admin_credentials'
 grants=fixture.get(kind,{})
 effective=set(grants.get(role,[]))|set(grants.get('PUBLIC',[]))
 return bool(effective & set(requested.split(',')))
db.create_function('has_table_privilege',3,lambda *a: privilege(*a,'table'))
db.create_function('has_any_column_privilege',3,lambda *a: privilege(*a,'column'))
# SQLite executes the extracted predicate; only PostgreSQL's regclass resolution
# and catalog/privilege APIs are represented by fixture data, no predicate stub.
sql=sql.replace("'swarm.admin_credentials'::regclass",'1')
print('t' if db.execute(sql).fetchone()[0] else 'f')
`);
  const check = (fixture: unknown) => spawnSync('/bin/bash', ['-s'], {
    input: `(
set -eEuo pipefail
trap 'printf "FAIL fixture-fence: STOP\\n" >&2' ERR
edge_ro() { python3 ${JSON.stringify(runner)} "$@"; }
${fence}
edge_fence
)\n`, encoding: 'utf8', env: { ...process.env, FIXTURE_FENCE_STATE: JSON.stringify(fixture) },
  });
  passed(check({}));
  stopped(check({ table: { swarm_read: ['SELECT'] }, policy: true }));
  for (const role of roles) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      stopped(check({ table: { [role]: [privilege] } }));
    }
    stopped(check({ column: { [role]: ['SELECT'] } }));
  }
  for (const drift of ['unrevoked', 'active', 'policy', 'rls_disabled', 'force_disabled']) stopped(check({ [drift]: true }));
  passed(check({ table: { unrelated_role: ['SELECT'] } }));
});


// Parse the deployed Caddy shape from its owners: the base files, the MCP
// activation transform, then W4's actual candidate generator. No probe paths
// are copied into this parser or its matchers.
type CaddyNode = { words: string[]; children: CaddyNode[] };
function parseCaddy(source: string): CaddyNode[] {
  const root: CaddyNode = { words: [], children: [] }, stack = [root];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === '}') { assert.ok(stack.length > 1); stack.pop(); continue; }
    const nested = trimmed.endsWith(' {');
    const words = (nested ? trimmed.slice(0, -2) : trimmed).match(/"(?:\\.|[^"\\])*"|\S+/g)!;
    const node = { words, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (nested) stack.push(node);
  }
  assert.equal(stack.length, 1); return root.children;
}
function deployedCaddy() {
  const stage = mkdtempSync(join(scratch, 'caddy-'));
  writeFileSync(join(stage, 'mcp.off.caddy'), readFileSync(resolve('deploy/supabase-stack/commonswarm-mcp.caddy')));
  writeFileSync(join(stage, 'api.caddy'), readFileSync(resolve('deploy/supabase-stack/commonswarm-api.caddy')));
  const activationPlan = readFileSync(resolve('docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md'), 'utf8');
  const activation = /^(text=\(stage\/'mcp.off.caddy'\)[\s\S]*?^\(stage\/'mcp.on.caddy'\)[^\n]*)/m.exec(activationPlan)![1]!;
  passed(spawnSync('python3', ['-', stage], { input: 'import os,pathlib,re,sys\nstage=pathlib.Path(sys.argv[1])\n' + activation, encoding: 'utf8' }));
  writeFileSync(join(stage, 'mcp.caddy'), readFileSync(join(stage, 'mcp.on.caddy')));
  const w4 = readFileSync(resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'), 'utf8');
  const candidate = /# step: ai-w4-caddy-candidate\n[\s\S]*?^```/m.exec(w4)![0];
  passed(spawnSync('python3', ['-', stage], { input: python(candidate), encoding: 'utf8' }));
  return parseCaddy(readFileSync(join(stage, 'api.new.caddy'), 'utf8') + '\n' + readFileSync(join(stage, 'mcp.new.caddy'), 'utf8'));
}
function caddyRoute(config: CaddyNode[], host: string, path: string, method: string) {
  const snippets = new Map(config.filter(n => n.words[0]!.startsWith('(')).map(n => [n.words[0]!.slice(1, -1), n.children]));
  function expand(nodes: CaddyNode[]): CaddyNode[] {
    return nodes.flatMap(n => n.words[0] === 'import'
      ? expand(snippets.get(n.words[1]!)!)
      : [{ ...n, children: expand(n.children) }]);
  }
  const site = config.find(n => n.words[0] === host); assert.ok(site, host);
  const nodes = expand(site.children), matchers = new Map<string, string[][]>(), handles: CaddyNode[] = [];
  function walk(nodes: CaddyNode[]) {
    for (const node of nodes) {
      if (node.words[0]!.startsWith('@')) matchers.set(node.words[0]!, node.children.length ? node.children.map(n => n.words) : [node.words.slice(1)]);
      if (node.words[0] === 'handle') handles.push(node);
      else if (node.words[0] !== 'handle_errors') walk(node.children);
    }
  }
  walk(nodes);
  const matches = (pattern: string) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(path);
  for (const handle of handles) {
    const selector = handle.words[1];
    const rules = selector?.startsWith('@') ? matchers.get(selector)! : selector ? [['path', selector]] : [];
    assert.ok(rules, selector);
    if (!rules.every(([kind, ...values]) => kind === 'path' ? values.some(matches) : kind === 'method' ? values.includes(method) : assert.fail('unsupported Caddy matcher ' + kind))) continue;
    return handle.children.find(n => n.words[0] === 'reverse_proxy' || n.words[0] === 'respond')!;
  }
  assert.fail(`no Caddy route for ${method} ${host}${path}`);
}
type ProbeRequest = [host: string, path: string, method: string, body: string | null, headers: Record<string, string>];
function probeRequests(source: string): ProbeRequest[] {
  const extractor = `
import ast,http.client,json,ssl,sys
ssl.create_default_context=lambda **kw: object()
calls=[]
class Response:
 status=200
 def read(self,n): return b'{}'
 def getheaders(self): return []
class Connection:
 def __init__(self,host,**kw): self.host=host
 def request(self,method,path,body,headers): calls.append([self.host,path,method,body,headers])
 def getresponse(self): return Response()
 def close(self): pass
http.client.HTTPSConnection=Connection
class Extract(ast.NodeTransformer):
 def visit_Assert(self,node): return None
tree=ast.fix_missing_locations(Extract().visit(ast.parse(sys.stdin.read())))
exec(compile(tree,'<probe-request-inventory>','exec'))
print(json.dumps(calls))
`;
  const r = spawnSync('python3', ['-c', extractor, 'unused-ca'], { input: source, encoding: 'utf8' }); passed(r);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}
test('every extracted probe request has a route in parsed deployed Caddy; bare metadata fails', () => {
  const config = deployedCaddy();
  const source = python(/^edge_route_probes\(\) \{[\s\S]*?^\}/m.exec(helpers)![0]);
  const verify = (source: string) => {
    const calls = probeRequests(source);
    assert.equal(calls.length, 9); assert.equal(new Set(calls.map(c => JSON.stringify(c.slice(0, 3)))).size, 8);
    for (const [host, path, method] of calls) {
      const route = caddyRoute(config, host, path, method);
      assert.ok(route.words[0] === 'reverse_proxy' || (method === 'HEAD' && route.words.at(-1) === '405'), `${method} ${host}${path}: ${route.words.join(' ')}`);
    }
  };
  verify(source);
  const old = source.replace("'/.well-known/oauth-protected-resource/mcp',headers=discovery_headers", "'/.well-known/oauth-protected-resource',headers=discovery_headers");
  assert.notEqual(old, source);
  assert.throws(() => verify(old), /GET mcp.commonswarm.com\/\.well-known\/oauth-protected-resource: respond.*404/);
  verify(source);
});

test('extracted route probes use real MCP origin/auth checks; refuse injected Origin, metadata drift and _meta error', async () => {
  const source = python(/^edge_route_probes\(\) \{[\s\S]*?^\}/m.exec(helpers)![0]);
  const harness = `
import http.client,json,ssl,sys
payload=json.load(sys.stdin); rows=payload['rows']
ssl.create_default_context=lambda **kw: object()
class Response:
 def __init__(self,status,data,headers=None): self.status=status; self.data=data; self.headers=headers or {}
 def read(self,n): return self.data
 def getheaders(self): return list(self.headers.items())
class Connection:
 def __init__(self,host,**kw): self.host=host
 def request(self,method,path,body,headers): self.method,self.path,self.body,self.headers=method,path,body,headers
 def close(self): pass
 def getresponse(self):
  path=self.path
  if path=='/admin/gate': return Response(200,b'{"state":"closed"}' if self.method=='GET' else b'',{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'})
  if path=='/admin': return Response(401,b'{"error":"unauthorized"}')
  if path=='/.well-known/oauth-protected-resource/admin':
   if self.method=='HEAD': return Response(405,b'{}')
   return Response(200,b'{"resource":"https://api.commonswarm.com/admin","authorization_servers":["https://mcp.commonswarm.com"]}')
  if path=='/.well-known/oauth-authorization-server': return Response(200,b'{"issuer":"https://mcp.commonswarm.com"}')
  if path=='/.well-known/oauth-protected-resource/mcp' or path=='/mcp':
   # Replay responses from the real TS handler for the exact captured request.
   row=next(r for r in rows if r['request']==[self.host,path,self.method,self.body,self.headers])
   doc=json.loads(row['body'])
   if sys.argv[2]=='bad-metadata': doc['resource']='https://mcp.commonswarm.com/wrong'
   if path=='/mcp' and '_meta' in json.loads(self.body)['params'] and sys.argv[2]=='bad': doc={'error':{'code':-32602}}
   return Response(row['status'],json.dumps(doc).encode(),row['headers'])
  raise AssertionError('unexpected probe route')
http.client.HTTPSConnection=Connection
exec(compile(payload['source'],'<extracted-local-caddy-probes>','exec'))
`;
  const run = async (probeSource: string, allowedOrigins: string[], kind = 'good') => {
    const handle = createMcpProtocolHandler({
      issuer: 'https://mcp.commonswarm.com', resource: 'https://mcp.commonswarm.com/mcp', publicEnabled: true,
      allowedOrigins: new Set(allowedOrigins),
      limits: { maxBodyBytes: 4096, maxResponseBytes: 65536, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
      verifyToken: async () => assert.fail('credential-free probes must not verify a token'),
      executeTool: async () => assert.fail('credential-free probes must not execute a tool'),
    });
    const rows = [];
    for (const request of probeRequests(probeSource)) {
      const [host, path, method, body, headers] = request;
      if (path !== '/mcp' && path !== '/.well-known/oauth-protected-resource/mcp') continue;
      const response = await handle(new Request(`https://${host}${path}`, { method, body, headers }));
      rows.push({ request, status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) });
    }
    return { rows, result: spawnSync('python3', ['-c', harness, 'unused-public-ca', kind], { input: JSON.stringify({ rows, source: probeSource }), encoding: 'utf8' }) };
  };
  const call = "request('mcp.commonswarm.com','/mcp','POST',body,headers=mcp_headers)";
  const injectedOrigin = source.replace(call, call.replace('headers=mcp_headers', "headers={**mcp_headers,'Origin':'https://commonswarm.com'}"));
  assert.notEqual(injectedOrigin, source);
  for (const origins of [[], ['https://claude.ai']]) {
    passed((await run(source, origins)).result);
    const bad = await run(injectedOrigin, origins);
    assert.deepEqual(bad.rows.filter(r => r.request[1] === '/mcp').map(r => [r.status, JSON.parse(r.body)]),
      [[403, { error: 'origin_not_allowed' }], [403, { error: 'origin_not_allowed' }]]);
    assert.notEqual(bad.result.status, 0); assert.match(bad.result.stderr, /AssertionError/);
    passed((await run(source, origins)).result);
  }
  for (const kind of ['bad', 'bad-metadata']) {
    const { result: bad } = await run(source, [], kind);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /AssertionError/);
  }
});
