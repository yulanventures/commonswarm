/** Execute extracted plan boundaries with fixtures; never contact Docker, SSH or a box. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// These tests own the executable plan contract: shell portability, exact inputs,
// staging isolation, recycle refusal and run-order referential integrity. A bad
// fence, permissive validator or boundary error is not covered by the C1 tests.
// Fixtures execute extracted code, with no production flag/export/test seam.
const plan = readFileSync(resolve('deploy/mcp-auth/OAUTH-RELEASE.md'), 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
function block(id: string) {
  const found = blocks.filter(s => s.startsWith(`# step: ${id}\n`));
  assert.equal(found.length, 1, `one complete ${id} block`);
  return found[0]!;
}
function python(source: string, delimiter = 'PY') {
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^python3[^\\n]*<<'${escaped}'[^\\n]*\\n([\\s\\S]*?)^${escaped}$`, 'm').exec(source);
  assert.ok(match, `embedded Python ${delimiter}`);
  return match[1]!;
}
const validator = python(block('oauth-open'));
const helpers = /cat >>"\$PROOF_DIR\/session.sh" <<'SH'\n([\s\S]*?)^SH$/m.exec(block('oauth-open'))![1]!;
// No HOME changes and no recursive deletion. Retain small nonsecret fixtures in
// this test-owned temporary root; their paths appear only in failure diagnostics.
const scratch = mkdtempSync(join(tmpdir(), 'oauth-release-contract-'));
// Read exact reviewed release sources from local Git objects; no network.
function releaseSource(path: string) {
  const result = spawnSync('git', ['show', `2ab464ae:${path}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const releaseConfig = releaseSource('services/mcp-auth/src/config.js');
const releaseCatalog = releaseSource('services/mcp-auth/src/auth-provider-catalog.js');
const providerKeyNames = ['MCP_OAUTH_GOTRUE_PROVIDER', 'MCP_OAUTH_GOTRUE_PROVIDERS'];
function releaseTree(f: { fresh: string }) {
  const dir = join(f.fresh, 'services', 'mcp-auth', 'src'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.js'), releaseConfig);
  writeFileSync(join(dir, 'auth-provider-catalog.js'), releaseCatalog);
}
const clock = '2031-02-03T12:00:00Z';
const fixture = () => ({
  release_sha: 'a'.repeat(40), archive_sha256: 'b'.repeat(64), window_id: 'Abc123',
  window_end_utc: '2031-02-03T12:30:00Z', baseline_oauth_sha: 'c'.repeat(40),
  baseline_oauth_image: `sha256:${'d'.repeat(64)}`, compose_env_sha256: 'e'.repeat(64),
  service_env_sha256: 'f'.repeat(64), target: 'production',
});
type Options = { now?: string; hostname?: string; marker?: string; rootMarker?: boolean; markerMode?: number; inputMode?: number };
let serial = 0;
function validate(input: unknown, options: Options = {}, raw?: string) {
  const suffix = String(serial++);
  const inputFile = join(scratch, `inputs-${suffix}.json`), marker = join(scratch, `marker-${suffix}`);
  writeFileSync(inputFile, raw ?? JSON.stringify(input), { mode: options.inputMode ?? 0o600 });
  if (options.marker !== undefined) {
    writeFileSync(marker, options.marker, { mode: options.markerMode ?? 0o600 });
    chmodSync(marker, options.markerMode ?? 0o600);
  }
  // Pin datetime without adding a clock override to the production plan. Only
  // fixture marker ownership is supplied as metadata: a non-root Mac cannot
  // create root-owned files. File type, mode and contents are real filesystem
  // checks; separate cases exercise the owner refusal as well.
  const harness = `
import datetime,os,pathlib,sys
_real_datetime=datetime.datetime
class FixedClock(_real_datetime):
    @classmethod
    def now(cls,tz=None):
        value=_real_datetime.fromisoformat(sys.argv[4].replace('Z','+00:00'))
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)
datetime.datetime=FixedClock
_real_stat=pathlib.Path.stat
_marker=sys.argv[2]
_root=sys.argv[5]=='root'
def fixture_stat(self,*args,**kwargs):
    result=_real_stat(self,*args,**kwargs)
    if str(self)==_marker:
        fields=list(result); fields[4]=0 if _root else 12345; fields[5]=0 if _root else 12345
        return os.stat_result(fields)
    return result
pathlib.Path.stat=fixture_stat
exec(compile(sys.stdin.read(),'<extracted-oauth-open>','exec'))
`;
  return spawnSync('python3', ['-c', harness, inputFile, marker, options.hostname ?? 'yulan-vps-1', options.now ?? clock, options.rootMarker ? 'root' : 'nonroot'], {
    input: validator, encoding: 'utf8', timeout: 10_000,
  });
}
function accepts(input: unknown, options: Options = {}) {
  const result = validate(input, options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS exact inputs, target and timing/);
}
function refuses(input: unknown, label: string, options: Options = {}, raw?: string) {
  const result = validate(input, options, raw);
  assert.notEqual(result.status, 0, label);
  assert.match(result.stderr, /FAIL oauth-open: .*; STOP/, `${label}: ${result.stderr}`);
  return result.stderr;
}

test('every complete release block parses in Bash, and embedded Python compiles', () => {
  assert.ok(blocks.length > 0);
  assert.equal([...plan.matchAll(/^```sh$/gm)].length, blocks.length, 'all shell fences extracted');
  const seen = new Set<string>();
  for (const source of blocks) {
    const [step, readonly, host] = source.split('\n');
    assert.match(step!, /^# step: oauth-[a-z0-9-]+$/);
    assert.match(readonly!, /^# readonly: (yes|no|probe)$/);
    assert.match(host!, /^# host: /);
    assert.ok(!seen.has(step!), `duplicate ${step}`); seen.add(step!);
    const result = spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, `${step}: ${result.stderr}`);
    for (const match of source.matchAll(/^[ \t]*python3[^\n]*<<'([A-Z_]+)'[^\n]*\n([\s\S]*?)^\1$/gm)) {
      const compiled = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<release-python>", "exec")'], { input: match[2]!, encoding: 'utf8' });
      assert.equal(compiled.status, 0, `${step}: ${compiled.stderr}`);
    }
  }
  // Bash treats the persisted session helper as heredoc data at open. Parse it
  // separately because later blocks source it as executable shell.
  const session = spawnSync('/bin/bash', ['-n'], { input: helpers, encoding: 'utf8' });
  assert.equal(session.status, 0, session.stderr);
});

// Parse shell command-substitution scope while skipping quoted text and heredoc
// bodies. A heredoc after a closed $(hostname) is allowed; one inside it is not.
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
test('shell blocks refuse heredocs inside command substitutions', () => {
  for (const source of blocks) assert.equal(unsafeSubstitution(source), false, source.split('\n')[0]);
  assert.equal(unsafeSubstitution(helpers), false, 'persisted session helpers');
  assert.equal(unsafeSubstitution("v=$(python3 - <<'PY'\nprint(1)\nPY\n)"), true);
  assert.equal(unsafeSubstitution("v=$(\npython3 - <<'PY'\nprint(1)\nPY\n)"), true);
  assert.equal(unsafeSubstitution('python3 - "$(hostname)" <<\'PY\'\nprint(1)\nPY'), false);
  assert.equal(unsafeSubstitution("python3 - <<'PY'\nprint('$(literal)')\nPY"), false);
});

test('extracted input validator rejects missing, extra, duplicate and malformed keys', () => {
  const valid = fixture(); accepts(valid);
  for (const key of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[key];
    assert.match(refuses(missing, `missing ${key}`), /exact input keys/);
    assert.match(refuses({ ...valid, [key]: 123 }, `wrong type ${key}`), /must be strings/);
  }
  refuses({ ...valid, unexpected: true }, 'extra key');
  refuses([], 'array'); refuses(null, 'null'); refuses({}, 'empty');
  refuses(valid, 'malformed JSON', {}, '{');
  refuses(valid, 'duplicate JSON key', {}, JSON.stringify(valid).replace('"release_sha":', `"release_sha":"${valid.release_sha}","release_sha":`));
  for (const [key, value] of [
    ['release_sha', 'a'.repeat(39)], ['release_sha', 'A'.repeat(40)],
    ['baseline_oauth_sha', 'z'.repeat(40)], ['baseline_oauth_sha', valid.release_sha],
    ['archive_sha256', 'b'.repeat(63)], ['compose_env_sha256', 'g'.repeat(64)],
    ['service_env_sha256', '0'.repeat(65)], ['baseline_oauth_image', 'oauth:latest'],
    ['window_id', 'abc12'], ['window_id', 'abc/12'], ['window_id', 'abcdefg'],
    ['window_end_utc', '2031-02-03T12:30:00+00:00'], ['window_end_utc', '2031-02-30T12:30:00Z'],
    ['target', 'other'],
  ]) refuses({ ...valid, [key!]: value }, `malformed ${key}`);
  refuses(valid, 'loose input mode', { inputMode: 0o644 });
});

test('extracted target gate isolates staging markers, hostname and window IDs', () => {
  const valid = fixture(); accepts(valid);
  const staged = { ...valid, target: 'staging', window_id: 'STG123' };
  const staging = { hostname: 'c1-staging-20261006', marker: 'c1-staging-disposable-no-production', rootMarker: true };
  accepts(staged, staging);
  accepts({ ...staged, window_id: 'stg123' }, staging);
  refuses(staged, 'staging on production');
  refuses(staged, 'staging missing marker', { hostname: staging.hostname });
  refuses(staged, 'staging wrong hostname', { ...staging, hostname: 'yulan-vps-1' });
  refuses(staged, 'malformed staging marker', { ...staging, marker: staging.marker + '\n' });
  refuses(staged, 'non-root staging marker', { ...staging, rootMarker: false });
  refuses(staged, 'loose staging marker mode', { ...staging, markerMode: 0o644 });
  refuses({ ...staged, window_id: 'Abc123' }, 'staging ID unreserved', staging);
  refuses({ ...valid, window_id: 'sTg123' }, 'staging ID on production');
  refuses(valid, 'production with staging marker', staging);
});

test('extracted clock gate refuses every recycle band and boundary, with positive controls', () => {
  const base = fixture(); accepts(base);
  const iso = (value: Date) => value.toISOString().replace('.000Z', 'Z');
  for (const hour of [3, 9, 15, 21]) {
    const recycle = new Date(`2031-02-03T${String(hour).padStart(2, '0')}:30:00Z`);
    for (const seconds of [2100, 2099, 60, 1, 0]) {
      const now = new Date(recycle.getTime() - seconds * 1000);
      const end = new Date(now.getTime() + 30_000);
      assert.match(refuses({ ...base, window_end_utc: iso(end) }, `recycle ${hour}, -${seconds}s`, { now: iso(now) }), /within 35 minutes/);
    }
    const before = new Date(recycle.getTime() - 2101_000);
    accepts({ ...base, window_end_utc: iso(new Date(before.getTime() + 1800_000)) }, { now: iso(before) });
    const after = new Date(recycle.getTime() + 1000);
    accepts({ ...base, window_end_utc: iso(new Date(after.getTime() + 1800_000)) }, { now: iso(after) });
  }
  // The end-at-recycle rule is redundant with the 35-minute/30-minute gates;
  // test their combined refusal, never claim an unreachable independent branch.
  refuses({ ...base, window_end_utc: '2031-02-03T15:30:00Z' }, 'end reaches recycle', { now: '2031-02-03T15:00:00Z' });
  refuses({ ...base, window_end_utc: clock }, 'end equals now');
  refuses({ ...base, window_end_utc: '2031-02-03T11:59:59Z' }, 'past end');
  refuses({ ...base, window_end_utc: '2031-02-03T12:30:01Z' }, 'window longer than 30 minutes');
  // Midnight rolls the next recycle onto the next day.
  accepts({ ...base, window_end_utc: '2031-02-04T00:29:59Z' }, { now: '2031-02-03T23:59:59Z' });
});

test('run-order table names only complete steps and covers every block', () => {
  const ids = new Set(blocks.map(s => /^# step: (\S+)/.exec(s)![1]!));
  const rows = [...plan.matchAll(/^\| (\d+|R\d+) \| (oauth-[a-z0-9-]+) \| (box|Mac) \| (.+) \| (.+) \|$/gm)];
  assert.ok(rows.length > 0, 'run-order rows present');
  assert.equal(rows[0]![2], 'oauth-root-shell', 'root access must be checked before the first root block');
  for (const row of rows) assert.ok(ids.has(row[2]!), `unknown table step ${row[2]}`);
  assert.deepEqual(new Set(rows.map(r => r[2]!)), ids, 'every executable block is in the run order');
  const list = readFileSync(resolve('tests/lists/test.txt'), 'utf8').split('\n');
  assert.equal(list.filter(name => name === 'tests/oauth-release-plan.test.ts').length, 1, 'literal test gate includes this owner once');
});

// Execute the lifecycle boundaries from the document. Docker identity and env
// ownership have their existing independent contracts; fixture shims isolate
// them here. curl supplies transport responses only: the real probe helper
// chooses routes/CA, checks response contents and writes its own receipts.
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function lifecycle(options: { failure?: string; failedTree?: 'directory' | 'symlink'; attempt?: boolean; snapshots?: boolean; providers?: unknown; service?: string; enabled?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(scratch, 'lifecycle-'));
  const proof = join(root, 'proof'), stage = join(root, 'stage'), env = join(root, 'env');
  const old = join(root, 'releases', fixture().baseline_oauth_sha);
  const fresh = join(root, 'releases', fixture().release_sha);
  for (const dir of [proof, stage, env, old]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (options.failedTree === 'directory') mkdirSync(fresh);
  if (options.failedTree === 'symlink') symlinkSync(join(root, 'absent'), fresh);
  const compose = `MCP_OAUTH_IMAGE=${fixture().baseline_oauth_image}\n`;
  const service = options.service ?? 'FIXTURE_PUBLIC_SETTING=unchanged\n';
  const input = { ...fixture(), compose_env_sha256: digest(compose), service_env_sha256: digest(service),
    ...('providers' in options ? { service_env_provider_list: options.providers } : {}) };
  writeFileSync(join(proof, 'inputs.json'), JSON.stringify(input));
  writeFileSync(join(proof, 'opened.txt'), clock + '\n');
  writeFileSync(join(proof, 'port.txt'), '3490\n');
  writeFileSync(join(proof, 'oauth-image.id'), `sha256:${'1'.repeat(64)}\n`);
  writeFileSync(join(proof, 'caddy-ca.pem'), 'fixture public CA\n');
  writeFileSync(join(proof, 'probe-failure.txt'), options.failure ?? '');
  for (const dir of [env, stage]) {
    if (dir === stage && options.snapshots === false) continue;
    writeFileSync(join(dir, 'compose.env'), compose, { mode: 0o600 });
    writeFileSync(join(dir, 'service.env'), service, { mode: 0o600 });
  }
  for (const dir of [old, fresh]) {
    // An absent candidate must stay absent for recovered close. Only apply
    // fixtures create both Compose trees, after these close cases finish.
    if (dir === fresh && !options.failedTree) continue;
    if (dir === fresh && options.failedTree === 'symlink') continue;
    mkdirSync(join(dir, 'deploy', 'mcp-auth'), { recursive: true });
    for (const file of ['compose.yaml', 'compose.management.yaml']) writeFileSync(join(dir, 'deploy', 'mcp-auth', file), 'services: {}\n');
  }
  if (options.attempt) writeFileSync(join(proof, 'oauth-attempted.txt'), clock);
  const transport = join(root, 'curl.py');
  writeFileSync(transport, `
import json,pathlib,sys
proof=pathlib.Path(sys.argv[1]); args=sys.argv[2:]; url=args[-1]
with (proof/'transport.jsonl').open('a') as f: f.write(json.dumps(args)+'\\n')
def opt(k): return args[args.index(k)+1]
if url.startswith('https:'):
    assert opt('--cacert')==str(proof/'caddy-ca.pem')
    assert opt('--resolve')=='mcp.commonswarm.com:443:127.0.0.1'
    assert opt('--noproxy')=='*' and '-k' not in args
    assert not any('authorization:' in a.lower() for a in args)
    route={'.well-known/oauth-authorization-server':'metadata','jwks':'jwks','mcp':'mcp'}[url.removeprefix('https://mcp.commonswarm.com/')]
else:
    assert url=='http://127.0.0.1:3490/admin/gate'; route='gate'
failure=(proof/'probe-failure.txt').read_text()
if failure=='ca': raise SystemExit(60)
if failure==route: raise SystemExit(22)
body={'metadata':{'issuer':'https://mcp.commonswarm.com','jwks_uri':'https://mcp.commonswarm.com/jwks'},'jwks':{'keys':[{'kty':'RSA','n':'public-fixture','e':'AQAB'}]},'mcp':{},'gate':{'state':'closed'}}[route]
if failure=='open-gate' and route=='gate': body={'state':'open'}
if failure=='private-jwks' and route=='jwks': body={'keys':[{'kty':'RSA','d':'private-fixture'}]}
pathlib.Path(opt('--output')).write_text(json.dumps(body))
if '--dump-header' in args:
    pathlib.Path(opt('--dump-header')).write_text('www-authenticate: Bearer realm="mcp"\\n' if route=='mcp' and failure!='challenge' else '')
if route=='mcp':
    assert opt('--request')=='POST'
    assert json.loads(opt('--data-binary'))['method']=='initialize'
if '--write-out' in args: print('401' if route=='mcp' else '200',end='')
`);
  const session = `
PROOF_DIR=${quote(proof)}
SECRET_STAGE=${quote(stage)}
OLD_OAUTH=${quote(old)}
NEW_OAUTH=${quote(fresh)}
INPUTS_FILE=${quote(join(proof, 'inputs.json'))}
CADDY_CA_FILE=${quote(join(proof, 'caddy-ca.pem'))}
BASELINE_IMAGE=${quote(input.baseline_oauth_image)}
RELEASE_SHA=${quote(input.release_sha)}
WINDOW_ID=${quote(input.window_id)}
id() { printf '0\\n'; }
${helpers}
# Identity/env checks are stubbed only to keep this lifecycle fixture service-free.
oauth_identity() { printf 'identity %s %s\\n' "$1" "$2" >>"$PROOF_DIR/calls.txt"; }
oauth_env() { printf 'env %s\\n' "$1" >>"$PROOF_DIR/calls.txt"; }
oauth_deadline() { :; }
oauth_compose() { printf 'recreate\\n' >>"$PROOF_DIR/calls.txt"; return 91; }
oauth_health() { :; }
curl() { python3 ${quote(transport)} "$PROOF_DIR" "$@"; }
install() {
 if test "$1" != -d; then printf 'copy %s\\n' "\${@: -1}" >>"$PROOF_DIR/calls.txt"; fi
 local -a args; args=()
 while test "$#" -gt 0; do
  case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac
 done
 /usr/bin/install "\${args[@]}"
}
docker() {
 if test "$1" = image && test "$2" = inspect; then printf '%s\\n' "$RELEASE_SHA";
 else printf 'unexpected Docker call\\n' >>"$PROOF_DIR/calls.txt"; return 92; fi
}
`;
  writeFileSync(join(proof, 'session.sh'), session.replaceAll('/etc/commonswarm-oauth/', env + '/'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  // Supply only the public GoTrue transport response; the extracted helper
  // validates the route, selected providers, bytes, metadata and receipts.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env python3
import json,pathlib,sys
a=sys.argv[1:]
assert a[-1]=='https://api.commonswarm.com/auth/v1/settings'
assert a[a.index('--resolve')+1]=='api.commonswarm.com:443:127.0.0.1'
assert a[a.index('--cacert')+1]==${JSON.stringify(join(proof, 'caddy-ca.pem'))}
assert a[a.index('--noproxy')+1]=='*' and '-k' not in a
assert not any('authorization:' in x.lower() for x in a)
pathlib.Path(${JSON.stringify(join(proof, 'settings-requested.txt'))}).write_text('settings measured\\n')
pathlib.Path(a[a.index('--output')+1]).write_text(json.dumps({'external':json.loads(${JSON.stringify(JSON.stringify(options.enabled ?? { google: true, github: true }))})}))
`, { mode: 0o700 });
  const run = (source: string, vars: Record<string, string> = {}) => spawnSync('/bin/bash', [], {
    input: Object.entries({ PROOF_DIR: proof, ...vars }).map(([k, v]) => `${k}=${quote(v)}\n`).join('') + source.replaceAll('/etc/commonswarm-oauth/', env + '/'),
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: bin + ':' + process.env.PATH },
  });
  return { root, proof, stage, env, old, fresh, run };
}
function passed(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr));
}
function rejected(result: ReturnType<typeof spawnSync>, message: RegExp) {
  assert.notEqual(result.status, 0, String(result.stdout));
  assert.match(String(result.stderr), message);
}
// Close admission and its actual JSON writer run together. The separately
// guarded root-only scratch deletion is omitted: this worker does not create
// root-owned box scratch or run a document's rm command on the Mac.
function closeAdmission() {
  const source = block('oauth-close');
  const start = source.indexOf('# Guard proof:');
  const end = source.indexOf('python3 - "$INPUTS_FILE" "$CLOSE_RESULT" "$PROOF_DIR"', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(0, start) + source.slice(end);
}
function openBaseline() {
  const source = block('oauth-open');
  const tail = source.lastIndexOf('. "$PROOF_DIR/session.sh"');
  assert.ok(tail > 0);
  // Keep the actual open shell flags/trap and final baseline/snapshot/probe tail.
  return source.slice(0, source.indexOf('umask 077')) + source.slice(tail);
}
function applyAdmission() {
  const source = block('oauth-apply');
  const end = source.indexOf('install -o root -g root -m 0600 "$SECRET_STAGE/compose.new.env"');
  assert.ok(end > 0);
  return source.slice(0, end) + "printf 'PASS attempt admitted\\n'\n)\n";
}

// Exercise OPEN from the validated-input boundary through its first file writes.
// All absolute box paths are redirected into this fixture; owner options alone
// are stripped by the shared install shim.
test('open refuses every existing release path before any file change, with absent-path control', () => {
  const source = block('oauth-open');
  const start = source.indexOf('RELEASE_SHA=');
  const end = source.indexOf('SECRET_STAGE=$(mktemp');
  assert.ok(start > 0 && end > start);
  for (const kind of ['directory', 'file', 'symlink', 'dangling', undefined]) {
    const f = lifecycle();
    if (kind === 'directory') mkdirSync(f.fresh);
    if (kind === 'file') writeFileSync(f.fresh, 'retained release fixture\n');
    if (kind === 'symlink' || kind === 'dangling') symlinkSync(kind === 'symlink' ? f.old : join(f.root, 'absent'), f.fresh);
    const result = f.run(source.slice(0, source.indexOf('umask 077')) +
      '. "$PROOF_DIR/session.sh"\n' + source.slice(start, end).replaceAll('/home/commonswarm/oauth', f.root) + ')\n');
    const newProof = join(f.root, 'release-proofs', `${fixture().release_sha}-${fixture().window_id}`);
    if (kind) {
      rejected(result, /FAIL oauth-open: release tree already exists; STOP/);
      assert.equal(existsSync(join(f.root, 'release-proofs')), false, 'no proof parent created');
      assert.equal(existsSync(join(f.proof, 'calls.txt')), false, 'no install called');
      assert.ok(lstatSync(f.fresh), 'existing path is untouched, including dangling symlinks');
    } else {
      passed(result);
      assert.ok(existsSync(join(newProof, 'inputs.json')), 'absent path reaches real file writes');
    }
  }
});

type Lifecycle = ReturnType<typeof lifecycle>;
function prepareTree(f: Lifecycle) {
  const archive = join(f.root, 'release.tar');
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(f.proof, 'opened.txt'), now + '\n');
  passed(spawnSync('python3', ['-c', `
import hashlib,io,json,pathlib,sys,tarfile
archive,inputs,now=sys.argv[1:4]; p=pathlib.Path(inputs); d=json.loads(p.read_bytes())
with tarfile.open(archive,'w',format=tarfile.PAX_FORMAT,pax_headers={'comment':d['release_sha']}) as t:
 for name in ('compose.yaml','compose.management.yaml'):
  b=b'services: {}\\n'; member=tarfile.TarInfo('deploy/mcp-auth/'+name); member.size=len(b); t.addfile(member,io.BytesIO(b))
d['archive_sha256']=hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest(); p.write_text(json.dumps(d))
pathlib.Path(archive.removesuffix('.tar')+'.ancestry.json').write_text(json.dumps({'release_sha':d['release_sha'],'origin_main_sha':d['release_sha'],'is_ancestor':True,'measured_at':now}))
`, archive, join(f.proof, 'inputs.json'), now], { encoding: 'utf8' }));
  writeFileSync(join(f.proof, 'probes-baseline.txt'), 'PASS\n');
  const source = block('oauth-preflight');
  const extraction = source.indexOf('    t.extractall(new,filter=');
  assert.ok(extraction > 0);
  // Run real archive admission, receipt writing and mkdir. Extraction is outside
  // this contract and needs the box's newer Python (the Mac has Python 3.9).
  // Observe the actual mkdir boundary: a crash here must already have a receipt.
  const observer = `
_mkdir=pathlib.Path.mkdir
def observed_mkdir(self,*args,**kwargs):
    if str(self)==${JSON.stringify(f.fresh)}:
        assert pathlib.Path(${JSON.stringify(join(f.proof, 'oauth-tree-created.txt'))}).read_text()==str(self)+'\\n'
    return _mkdir(self,*args,**kwargs)
pathlib.Path.mkdir=observed_mkdir
`;
  const boundary = source.slice(0, extraction).replace('import datetime,hashlib,json,os,pathlib,re,sys,tarfile\n', 'import datetime,hashlib,json,os,pathlib,re,sys,tarfile\n' + observer);
  assert.ok(boundary.includes(observer));
  passed(f.run(boundary + 'PY\n)\n', { BOX_ARCHIVE_PATH: archive }));
  assert.equal(readFileSync(join(f.proof, 'oauth-tree-created.txt'), 'utf8'), f.fresh + '\n');
  assert.ok(lstatSync(f.fresh).isDirectory(), 'preflight created its recorded tree');
}
function runAside(f: Lifecycle) {
  const parent = join(f.root, 'failed-attempts');
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const aside = python(block('oauth-release-aside')).replaceAll('/home/commonswarm/oauth/failed-attempts', parent);
  // Only root-owner metadata is supplied; receipt, tree, move and record are real.
  const owner = `import os,pathlib\n_original=pathlib.Path.stat\ndef root_stat(self,*a,**kw):\n s=_original(self,*a,**kw)\n if str(self)==${JSON.stringify(parent)}:\n  fields=list(s); fields[4]=fields[5]=0; return os.stat_result(fields)\n return s\npathlib.Path.stat=root_stat\n`;
  return spawnSync('python3', ['-c', owner + aside, f.fresh, fixture().window_id, f.proof], { encoding: 'utf8' });
}

test('rolled-back close requires absence only for a receipt-backed tree, with absent-tree controls', () => {
  for (const created of [false, true]) {
    for (const failedTree of [undefined, 'directory', 'symlink'] as const) {
      const f = lifecycle({ failedTree, attempt: true });
      if (created) writeFileSync(join(f.proof, 'oauth-tree-created.txt'), f.fresh + '\n');
      for (const name of ['rollback.txt', 'probes-recovery.txt']) writeFileSync(join(f.proof, name), 'PASS\n');
      writeFileSync(join(f.proof, 'oauth-aside.json'), '{"moved":false}\n');
      const result = f.run(closeAdmission(), { CLOSE_RESULT: 'rolled-back' });
      if (failedTree && created) {
        rejected(result, /FAIL .*failed tree.*; STOP/);
        assert.equal(existsSync(join(f.proof, 'close-result.json')), false);
      } else {
        passed(result);
        assert.equal(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).result, 'rolled-back');
      }
    }
  }
});

test('abort-before-attempt closes as aborted without recreate or rollback', () => {
  for (const prepared of [false, true]) {
    const f = lifecycle({ snapshots: false });
    passed(f.run(openBaseline()));
    if (prepared) prepareTree(f);
    // A deadline or archive/pull stop leaves this path: no attempt and no rollback.
    passed(f.run(block('oauth-abort')));
    assert.equal(readFileSync(join(f.proof, 'aborted-before-attempt.txt'), 'utf8'), 'PASS\n');
    assert.equal(existsSync(join(f.proof, 'rollback.txt')), false);
    for (let retry = 0; retry < 2; retry++) passed(runAside(f));
    assert.equal(existsSync(f.fresh), false);
    const asideRecord = JSON.parse(readFileSync(join(f.proof, 'oauth-aside.json'), 'utf8'));
    assert.equal(asideRecord.moved, prepared);
    if (asideRecord.moved) assert.equal(existsSync(asideRecord.to), true, 'prepared candidate retained aside');
    passed(f.run(closeAdmission(), { CLOSE_RESULT: 'aborted' }));
    const record = JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8'));
    assert.equal(record.result, 'aborted');
    assert.equal(existsSync(join(f.proof, 'oauth-attempted.txt')), false);
    assert.equal(existsSync(join(f.proof, 'rollback.txt')), false);
    assert.doesNotMatch(readFileSync(join(f.proof, 'calls.txt'), 'utf8'), /recreate|unexpected Docker/);
  }

  // Same entry points with an attempt present must refuse the no-op branch.
  const attempted = lifecycle({ attempt: true });
  rejected(attempted.run(block('oauth-abort')), /FAIL .*attempt present.*; STOP/);
  rejected(attempted.run(closeAdmission(), { CLOSE_RESULT: 'aborted' }), /FAIL .*attempt present.*; STOP/);
  // Rollback itself must refuse an absent attempt before touching live state.
  const unattempted = lifecycle();
  rejected(unattempted.run(block('oauth-rollback')), /FAIL .*no regular attempt receipt.*STOP/);
  assert.equal(existsSync(join(unattempted.proof, 'calls.txt')), false);
});

test('aside and recovered close leave unrecorded trees untouched, and reject unsafe receipts', () => {
  for (const failedTree of ['directory', 'symlink'] as const) {
    const f = lifecycle({ failedTree });
    passed(f.run(block('oauth-abort')));
    for (let retry = 0; retry < 2; retry++) passed(runAside(f));
    assert.ok(lstatSync(f.fresh), 'unrecorded tree remains');
    assert.equal(JSON.parse(readFileSync(join(f.proof, 'oauth-aside.json'), 'utf8')).moved, false);
    passed(f.run(closeAdmission(), { CLOSE_RESULT: 'aborted' }));
    assert.ok(lstatSync(f.fresh), 'close leaves unrecorded tree in place');
  }
  for (const receipt of ['wrong-path', 'symlink', 'directory']) {
    const f = lifecycle({ failedTree: 'directory' });
    const path = join(f.proof, 'oauth-tree-created.txt');
    if (receipt === 'wrong-path') writeFileSync(path, f.old + '\n');
    if (receipt === 'symlink') symlinkSync(join(f.root, 'absent'), path);
    if (receipt === 'directory') mkdirSync(path);
    rejected(runAside(f), /FAIL oauth-release-aside: .*receipt.*; STOP/);
    assert.ok(existsSync(f.fresh), 'unsafe receipt cannot authorize a move');
    assert.equal(existsSync(join(f.proof, 'oauth-aside.json')), false);
  }
});

test('baseline probe failures refuse open and apply before the attempt; forward and recovery reuse the probes', () => {
  for (const failure of ['ca', 'metadata', 'jwks', 'mcp', 'gate', 'open-gate', 'private-jwks', 'challenge', undefined]) {
    const f = lifecycle({ failure, snapshots: false });
    const opened = f.run(openBaseline());
    if (failure) {
      rejected(opened, /FAIL .*; STOP/);
      assert.doesNotMatch(opened.stdout, /PASS open;/);
      assert.equal(existsSync(join(f.proof, 'probes-baseline.txt')), false);
      for (const file of ['compose.env', 'service.env']) assert.equal(existsSync(join(f.stage, file)), false, 'failed probes leave no secret copy');
      rejected(f.run(applyAdmission()), /FAIL .*baseline probe receipt.*; STOP/);
      assert.equal(existsSync(join(f.proof, 'oauth-attempted.txt')), false);
    } else {
      passed(opened);
      assert.equal(readFileSync(join(f.proof, 'probes-baseline.txt'), 'utf8'), 'PASS\n');
      for (const file of ['compose.env', 'service.env']) assert.equal(readFileSync(join(f.stage, file), 'utf8'), readFileSync(join(f.env, file), 'utf8'));
      mkdirSync(join(f.fresh, 'deploy', 'mcp-auth'), { recursive: true });
      for (const file of ['compose.yaml', 'compose.management.yaml']) writeFileSync(join(f.fresh, 'deploy', 'mcp-auth', file), 'services: {}\n');
      passed(f.run(applyAdmission()));
      assert.equal(existsSync(join(f.proof, 'oauth-attempted.txt')), true);
      writeFileSync(join(f.proof, 'applied.txt'), 'PASS\n');
      passed(f.run(block('oauth-probes'), { PROBE_PHASE: 'forward' }));
      writeFileSync(join(f.proof, 'rollback.txt'), 'PASS\n');
      writeFileSync(join(f.proof, 'oauth-aside.json'), '{}\n');
      passed(f.run(block('oauth-probes'), { PROBE_PHASE: 'recovery' }));
      const calls = readFileSync(join(f.proof, 'transport.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      assert.equal(calls.length, 12, 'the same four transport probes ran for each phase');
      assert.deepEqual(calls.slice(4, 8), calls.slice(0, 4));
      assert.deepEqual(calls.slice(8, 12), calls.slice(0, 4));
      for (const phase of ['forward', 'recovery']) assert.equal(readFileSync(join(f.proof, `probes-${phase}.txt`), 'utf8'), 'PASS\n');
    }
  }
});

test('ERR inside a helper function prints FAIL and STOP in every trapped block', () => {
  for (const source of blocks) {
    const trap = source.indexOf("trap '");
    assert.ok(trap > 0);
    const lineEnd = source.indexOf('\n', trap);
    // Run each real block's options and trap; inject a minimal failing helper at
    // that boundary. No body command from a box or Mac release step is run.
    const result = spawnSync('/bin/bash', [], {
      input: source.slice(0, lineEnd + 1) + 'fixture_failure() { false; }\nfixture_failure\n)\n', encoding: 'utf8',
    });
    rejected(result, /FAIL .*; STOP/);
  }
});

test('Compose helper preserves Docker client settings and clears file-derived interpolation overrides', () => {
  const f = lifecycle();
  for (const file of ['compose.yaml', 'compose.management.yaml']) {
    writeFileSync(join(f.old, 'deploy', 'mcp-auth', file), '${MCP_OAUTH_IMAGE:?required} ${FIXTURE_OTHER_KEY:-default}\n');
  }
  const compose = /^oauth_compose\(\) \([\s\S]*?^\)$/m.exec(helpers)![0];
  // Use the actual helper, with only the docker process replaced. Test values
  // are public fixtures; no client credential environment is read or printed.
  const source = `(
set -euo pipefail
set -E
trap 'printf "FAIL fixture-compose: line %s; STOP\\n" "$LINENO" >&2' ERR
. "$PROOF_DIR/session.sh"
${compose}
docker() {
 test -z "\${MCP_OAUTH_IMAGE+x}"
 test -z "\${FIXTURE_OTHER_KEY+x}"
 test "$DOCKER_CONFIG" = fixture-config
 test "$1" = compose
}
oauth_compose "$OLD_OAUTH" up -d --force-recreate oauth
)\n`;
  const vars = { MCP_OAUTH_IMAGE: 'fixture-override', FIXTURE_OTHER_KEY: 'fixture-other', DOCKER_CONFIG: 'fixture-config' };
  passed(f.run(source, vars));
  // The checker's mutation reintroduces an override after the helper unsets it.
  // Both independent checks must stop, especially the former first && member.
  const unset = 'for name in $keys; do unset "$name"; done';
  assert.ok(source.includes(unset), 'mutation reaches the real unset loop');
  for (const key of ['MCP_OAUTH_IMAGE', 'FIXTURE_OTHER_KEY']) {
    rejected(f.run(source.replace(unset, unset + `\n ${key}=fixture-reset`), vars), /FAIL fixture-compose: .*; STOP/);
  }
});

test('every Mac-side ssh that does not feed a heredoc uses -n, so a pipe-fed operator shell keeps its own stdin', () => {
  const plan = readFileSync(new URL('../deploy/mcp-auth/OAUTH-RELEASE.md', import.meta.url), 'utf8');
  const offenders = plan.split('\n').filter((line) => /\bssh\s/.test(line) && !/<<'?[A-Z]+'?\s*$/.test(line) && !/\bssh\s+-n\b/.test(line) && !/^\s*#/.test(line) && !/`ssh/.test(line));
  assert.deepEqual(offenders, []);
});

// New owner-boundary cases protect exact env bytes and restart ordering. An
// unconditional edit, permissive list/provider check, drift overwrite, or late
// rollback restore fails here; the original lifecycle tests have no env edits.
// Only transport and host operations are replaced, with no production seam.
function executableApply(f: Lifecycle) {
  releaseTree(f);
  mkdirSync(join(f.fresh, 'deploy', 'mcp-auth'), { recursive: true });
  for (const file of ['compose.yaml', 'compose.management.yaml']) {
    writeFileSync(join(f.fresh, 'deploy', 'mcp-auth', file), 'services: {}\n');
  }
  writeFileSync(join(f.proof, 'session.sh'), readFileSync(join(f.proof, 'session.sh'), 'utf8') + `
# Observe the exact live bytes at the real restart boundary.
oauth_compose() {
 python3 - "$PROOF_DIR" ${quote(join(f.env, 'service.env'))} "$1" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); raw=pathlib.Path(sys.argv[2]).read_bytes()
r={'tree':sys.argv[3],'service_sha256':hashlib.sha256(raw).hexdigest(),
   'step_complete':(p/'service-env-step.json').is_file()}
with (p/'restarts.jsonl').open('a') as out: out.write(json.dumps(r)+'\\n')
PY
}
# Symlink operations belong to the box; keep their lifecycle boundaries local.
ln() { :; }
mv() { :; }
`);
}
function serviceAction(f: Lifecycle, action: string) {
  return f.run(`(
set -euo pipefail
set -E
trap 'printf "FAIL fixture-service: line %s; STOP\\n" "$LINENO" >&2' ERR
. "$PROOF_DIR/session.sh"
${action === 'apply' ? 'oauth_service_env validate\n' : ''}oauth_service_env ${action}
)\n`);
}
function restartRecords(f: Lifecycle) {
  return readFileSync(join(f.proof, 'restarts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function serviceBytes(f: Lifecycle) { return readFileSync(join(f.env, 'service.env')); }
function metadata(path: string) {
  const s = statSync(path); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o777 };
}

test('optional provider input accepts absent/null and ordered IDs, and rejects invalid or duplicate lists', () => {
  accepts(fixture()); accepts({ ...fixture(), service_env_provider_list: null });
  for (const value of ['google,github', 'github,google']) {
    accepts({ ...fixture(), service_env_provider_list: value });
  }
  for (const value of ['', 'Google', 'google,', ',github', 'google, github', 'a'.repeat(65), 'a\ngithub', 1, [], false]) {
    assert.match(refuses({ ...fixture(), service_env_provider_list: value }, 'invalid provider list'), /invalid provider list/);
  }
  assert.match(refuses({ ...fixture(), service_env_provider_list: 'google,google' }, 'duplicate provider'), /duplicate provider/);
});

test('absent/null provider step preserves release-1 bytes and never queries settings; close records no step', () => {
  for (const options of [{}, { providers: null }]) {
    const f = lifecycle(options); passed(f.run(openBaseline())); executableApply(f);
    const before = serviceBytes(f), meta = metadata(join(f.env, 'service.env'));
    passed(f.run(block('oauth-apply')));
    assert.deepEqual(serviceBytes(f), before);
    assert.deepEqual(metadata(join(f.env, 'service.env')), meta);
    assert.equal(existsSync(join(f.proof, 'settings-requested.txt')), false);
    assert.equal(existsSync(join(f.proof, 'service-env-attempted.json')), false);
    assert.equal(existsSync(join(f.proof, 'service-env-step.json')), false);
    assert.equal(restartRecords(f)[0].service_sha256, digest(before.toString()));
    passed(f.run(block('oauth-probes'), { PROBE_PHASE: 'forward' }));
    passed(f.run(closeAdmission(), { CLOSE_RESULT: 'success' }));
    assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).service_env,
      { ran: false, key_names: providerKeyNames, before_sha256: digest(before.toString()), after_sha256: digest(before.toString()) });
  }
});

test('provider switch removes the singular line and adds exactly one ordered list before restart, with proof and close', () => {
  const f = lifecycle({ providers: 'github,google', service: '# fixture heading\nMCP_OAUTH_GOTRUE_PROVIDER=github\nFIXTURE_PUBLIC_SETTING=unchanged\n' });
  passed(f.run(openBaseline())); executableApply(f);
  const before = serviceBytes(f), meta = metadata(join(f.env, 'service.env'));
  const result = f.run(block('oauth-apply')); passed(result);
  const expected = Buffer.from('# fixture heading\nFIXTURE_PUBLIC_SETTING=unchanged\nMCP_OAUTH_GOTRUE_PROVIDERS=github,google\n');
  assert.deepEqual(serviceBytes(f), expected);
  assert.deepEqual(readFileSync(join(f.stage, 'service.env')), before, 'open snapshot stays byte-identical');
  assert.deepEqual(metadata(join(f.env, 'service.env')), meta);
  assert.match(result.stdout, /^\+MCP_OAUTH_GOTRUE_PROVIDERS=github,google$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_PUBLIC_SETTING/);
  assert.deepEqual(restartRecords(f), [{ tree: f.fresh, service_sha256: digest(expected.toString()), step_complete: true }]);
  const proof = JSON.parse(readFileSync(join(f.proof, 'service-env-step.json'), 'utf8'));
  assert.equal(proof.before_sha256, digest(before.toString())); assert.equal(proof.after_sha256, digest(expected.toString()));
  assert.equal(proof.added_line, 'MCP_OAUTH_GOTRUE_PROVIDERS=github,google');
  assert.deepEqual(proof.enabled_providers, ['github', 'google']);
  assert.equal(proof.removed_singular, true); assert.deepEqual(proof.key_names, providerKeyNames);
  passed(f.run(block('oauth-probes'), { PROBE_PHASE: 'forward' }));
  passed(f.run(closeAdmission(), { CLOSE_RESULT: 'success' }));
  assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).service_env,
    { ran: true, key_names: providerKeyNames, before_sha256: digest(before.toString()), after_sha256: digest(expected.toString()), apply_after_sha256: digest(expected.toString()) });
});

test('identical provider assignment is a byte and inode no-op with enabled-provider evidence', () => {
  const f = lifecycle({ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDERS=google,github\nFIXTURE_PUBLIC_SETTING=unchanged\n' });
  passed(f.run(openBaseline())); executableApply(f);
  const before = serviceBytes(f), inode = statSync(join(f.env, 'service.env')).ino;
  passed(f.run(block('oauth-apply')));
  assert.deepEqual(serviceBytes(f), before); assert.equal(statSync(join(f.env, 'service.env')).ino, inode);
  assert.equal(JSON.parse(readFileSync(join(f.proof, 'service-env-step.json'), 'utf8')).added, false);
  assert.equal(existsSync(join(f.proof, 'settings-requested.txt')), true);
});

test('provider validation refuses conflicts, invalid lists, catalog and GoTrue failures before attempt; R0 stays available', () => {
  for (const [options, reason] of [
    [{ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDERS=google\n' }, /existing provider value/],
    [{ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDERS=google,github\nMCP_OAUTH_GOTRUE_PROVIDERS=google,github\n' }, /existing provider value/],
    [{ providers: 'google,github', service: 'export MCP_OAUTH_GOTRUE_PROVIDERS=google,github\n' }, /existing provider value/],
    [{ providers: 'google,github', service: 'FIXTURE_PUBLIC_SETTING=unchanged' }, /final newline/],
    [{ providers: 'google', service: 'MCP_OAUTH_GOTRUE_PROVIDER=github\n' }, /singular provider not in list/],
    [{ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDER=github\nMCP_OAUTH_GOTRUE_PROVIDER=github\n' }, /singular provider.*ambiguous/],
    [{ providers: 'google,email', enabled: { google: true, email: true } }, /outside release catalog/],
    [{ providers: 'google,' }, /invalid provider list/],
    [{ providers: 'google,,github' }, /invalid provider list/],
    [{ providers: 'Google' }, /invalid provider list/],
    [{ providers: 'google,google' }, /duplicate provider/],
    [{ providers: 'google,github', enabled: { google: true, github: false } }, /provider not enabled/],
    [{ providers: 'google,github', enabled: { google: true } }, /provider not enabled/],
    [{ providers: 'google,github', enabled: { google: true, github: 'true' } }, /provider not enabled/],
  ] as const) {
    const f = lifecycle(options); passed(f.run(openBaseline())); executableApply(f);
    const before = serviceBytes(f), meta = metadata(join(f.env, 'service.env'));
    rejected(f.run(block('oauth-apply')), reason);
    assert.deepEqual(serviceBytes(f), before); assert.deepEqual(metadata(join(f.env, 'service.env')), meta);
    assert.equal(existsSync(join(f.proof, 'restarts.jsonl')), false);
    assert.equal(existsSync(join(f.proof, 'service-env-step.json')), false);
    assert.equal(existsSync(join(f.proof, 'oauth-attempted.txt')), false, 'all refusal checks precede attempt receipt');
    assert.equal(existsSync(join(f.proof, 'service-env-attempted.json')), false);
    passed(f.run(block('oauth-abort')));
    assert.deepEqual(serviceBytes(f), before);
    assert.equal(existsSync(join(f.proof, 'restarts.jsonl')), false, 'R0 leaves the healthy baseline running');
    passed(runAside(f));
    passed(f.run(closeAdmission(), { CLOSE_RESULT: 'aborted' }));
    assert.equal(JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).service_env.ran, false);
  }
  const control = lifecycle({ providers: 'google,github' }); passed(control.run(openBaseline())); executableApply(control);
  passed(control.run(block('oauth-apply')));
  assert.equal(restartRecords(control).length, 1, 'same restart path with enabled-provider control');
});

test('unrelated service.env differences stop switch, forward proof, rollback and close without overwriting drift', () => {
  for (const action of ['apply', 'forward', 'restore', 'close-success', 'close-recovered']) {
    const f = lifecycle({ providers: 'google,github' }); passed(f.run(openBaseline())); executableApply(f);
    if (action !== 'apply') passed(f.run(block('oauth-apply')));
    else writeFileSync(join(f.proof, 'oauth-attempted.txt'), clock);
    const drift = Buffer.concat([serviceBytes(f), Buffer.from('FIXTURE_OTHER_KEY=drift\n')]);
    writeFileSync(join(f.env, 'service.env'), drift);
    rejected(serviceAction(f, action), /extra service.env difference/);
    assert.deepEqual(serviceBytes(f), drift);
    assert.equal(existsSync(join(f.proof, 'service-env-close.json')), false);
  }
  const control = lifecycle({ providers: 'google,github' }); passed(control.run(openBaseline())); executableApply(control);
  passed(control.run(block('oauth-apply'))); passed(serviceAction(control, 'forward'));
});

test('rollback restores exact snapshot and open digest before baseline restart; recovered close records the step', () => {
  for (const providers of [undefined, null, 'google,github']) {
    const f = lifecycle({ ...(providers === undefined ? {} : { providers }), service: 'FIXTURE_PUBLIC_SETTING=unchanged\nMCP_OAUTH_GOTRUE_PROVIDER=github\n' });
    passed(f.run(openBaseline())); executableApply(f);
    const before = serviceBytes(f), meta = metadata(join(f.env, 'service.env'));
    passed(f.run(block('oauth-apply'))); const applied = serviceBytes(f);
    passed(f.run(block('oauth-rollback')));
    assert.deepEqual(serviceBytes(f), before); assert.deepEqual(metadata(join(f.env, 'service.env')), meta);
    assert.deepEqual(restartRecords(f).map(r => r.service_sha256), [digest(applied.toString()), digest(before.toString())]);
    assert.equal(restartRecords(f)[1].tree, f.old);
    if (providers) assert.equal(JSON.parse(readFileSync(join(f.proof, 'service-env-restored.json'), 'utf8')).sha256, digest(before.toString()));
    passed(runAside(f)); passed(f.run(block('oauth-probes'), { PROBE_PHASE: 'recovery' }));
    passed(f.run(closeAdmission(), { CLOSE_RESULT: 'rolled-back' }));
    const r = JSON.parse(readFileSync(join(f.proof, 'close-result.json'), 'utf8')).service_env;
    assert.equal(r.ran, !!providers); assert.equal(r.before_sha256, digest(before.toString())); assert.equal(r.after_sha256, digest(before.toString()));
    if (providers) assert.equal(r.apply_after_sha256, digest(applied.toString()));
  }
});

test('snapshot tampering stops provider switch and rollback before restarting', () => {
  for (const applied of [false, true]) {
    const f = lifecycle({ providers: 'google,github' }); passed(f.run(openBaseline())); executableApply(f);
    if (applied) passed(f.run(block('oauth-apply')));
    else writeFileSync(join(f.proof, 'oauth-attempted.txt'), clock);
    const before = serviceBytes(f);
    writeFileSync(join(f.stage, 'service.env'), 'FIXTURE_PUBLIC_SETTING=tampered\n');
    rejected(applied ? f.run(block('oauth-rollback')) : serviceAction(f, 'apply'), /snapshot.*digest mismatch/);
    assert.deepEqual(serviceBytes(f), before);
    assert.equal(existsSync(join(f.proof, 'restarts.jsonl')), applied);
    if (applied) assert.equal(restartRecords(f).length, 1, 'no baseline restart after invalid snapshot');
  }
  const control = lifecycle({ providers: 'google,github' }); passed(control.run(openBaseline())); executableApply(control);
  passed(control.run(block('oauth-apply'))); passed(control.run(block('oauth-rollback')));
});


test('atomic provider write preserves a non-default fixture mode and replaces its inode', () => {
  const f = lifecycle({ providers: 'google,github', attempt: true }); releaseTree(f);
  const path = join(f.env, 'service.env'); chmodSync(path, 0o640);
  const before = serviceBytes(f), meta = metadata(path), inode = statSync(path).ino;
  passed(serviceAction(f, 'apply'));
  assert.deepEqual(serviceBytes(f), Buffer.concat([before, Buffer.from('MCP_OAUTH_GOTRUE_PROVIDERS=google,github\n')]));
  assert.deepEqual(metadata(path), meta);
  assert.notEqual(statSync(path).ino, inode, 'completed temp file replaces original inode');
  passed(serviceAction(f, 'restore'));
  assert.deepEqual(serviceBytes(f), before); assert.deepEqual(metadata(path), meta);
});


// The real env helper owns post-apply digest acceptance and drift refusal.
// Only root ownership is supplied: the Mac cannot create root-owned fixtures.
function realEnv(f: Lifecycle) {
  const helper = /^oauth_env\(\) \{[\s\S]*?^\}/m.exec(helpers)![0];
  const owner = `
_original_stat=pathlib.Path.stat
class RootMetadata:
    def __init__(self,s): self.s=s; self.st_uid=self.st_gid=0
    def __getattr__(self,k): return getattr(self.s,k)
def fixture_stat(self,*a,**kw):
    s=_original_stat(self,*a,**kw)
    return RootMetadata(s) if str(self) in ${JSON.stringify([join(f.env, 'compose.env'), join(f.env, 'service.env')])} else s
pathlib.Path.stat=fixture_stat
`;
  const actual = helper.replace('import hashlib,json,pathlib,re,stat,sys\n', 'import hashlib,json,pathlib,re,stat,sys\n' + owner)
    .replaceAll('/etc/commonswarm-oauth/', f.env + '/');
  const session = join(f.proof, 'session.sh'); writeFileSync(session, readFileSync(session, 'utf8') + '\n' + actual + '\n');
}

test('real oauth_env accepts the switched digest and refuses unrelated service.env drift', () => {
  const f = lifecycle({ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDER=github\nFIXTURE_PUBLIC_SETTING=unchanged\n' });
  passed(f.run(openBaseline())); executableApply(f); realEnv(f);
  passed(f.run(block('oauth-apply'))); // Reverting the digest condition fails here.
  writeFileSync(join(f.env, 'service.env'), Buffer.concat([serviceBytes(f), Buffer.from('FIXTURE_OTHER_KEY=drift\n')]));
  // Removing oauth_env's service-env call leaves this real boundary permissive.
  rejected(f.run('(\nset -euo pipefail\n. "$PROOF_DIR/session.sh"\noauth_env "$(cat "$PROOF_DIR/oauth-image.id")"\n)\n'), /extra service.env difference/);
});

test('switched env passes the exact 2ab464ae provider parser; retaining the singular key refuses startup providers', () => {
  const f = lifecycle({ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDER=github\nFIXTURE_PUBLIC_SETTING=unchanged\n' });
  passed(f.run(openBaseline())); executableApply(f); passed(f.run(block('oauth-apply')));
  const dir = join(f.root, 'parser'); mkdirSync(dir);
  writeFileSync(join(dir, 'auth-provider-catalog.mjs'), releaseCatalog);
  const start = releaseConfig.indexOf('function required('), end = releaseConfig.indexOf('function positiveInteger(', start);
  assert.ok(start > 0 && end > start);
  writeFileSync(join(dir, 'config.mjs'), 'import { AUTH_PROVIDER_CATALOG } from "./auth-provider-catalog.mjs";\n' + releaseConfig.slice(start, end));
  const harness = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGoTrueProviders } from './config.mjs';
const env=Object.fromEntries(readFileSync(process.argv[2],'utf8').trim().split('\\n').filter(x=>!x.startsWith('#')).map(x=>{const n=x.indexOf('=');return [x.slice(0,n),x.slice(n+1)];}));
assert.deepEqual(parseGoTrueProviders(env),['google','github']);
assert.throws(()=>parseGoTrueProviders({...env,MCP_OAUTH_GOTRUE_PROVIDER:'github'}),/disagree/);
assert.throws(()=>parseGoTrueProviders({...env,MCP_OAUTH_GOTRUE_PROVIDERS:'google,email'}),/distinct supported/);
`;
  writeFileSync(join(dir, 'run.mjs'), harness);
  passed(spawnSync('node', [join(dir, 'run.mjs'), join(f.env, 'service.env')], { encoding: 'utf8' }));
});

test('release catalog must be readable and recognized before receipt; catalog IDs come from the release tree', () => {
  for (const kind of ['unreadable', 'syntax', 'parser', 'changed-id']) {
    const f = lifecycle({ providers: 'google,github' }); passed(f.run(openBaseline())); executableApply(f);
    const src = join(f.fresh, 'services', 'mcp-auth', 'src');
    if (kind === 'unreadable') {
      // Move the public source, no deletion or guard bypass.
      passed(spawnSync('mv', [join(src, 'auth-provider-catalog.js'), join(src, 'retained-catalog.js')], { encoding: 'utf8' }));
    } else if (kind === 'parser') writeFileSync(join(src, 'config.js'), '// unsupported parser fixture\n');
    else writeFileSync(join(src, 'auth-provider-catalog.js'), kind === 'syntax' ? 'export const AUTH_PROVIDER_CATALOG=[];' : releaseCatalog.replaceAll('"github"', '"fixture-id"'));
    rejected(f.run(block('oauth-apply')), /release (provider catalog|parser catalog)|outside release catalog/);
    assert.equal(existsSync(join(f.proof, 'oauth-attempted.txt')), false);
    assert.equal(existsSync(join(f.proof, 'settings-requested.txt')), false);
  }
  const f = lifecycle({ providers: 'google,fixture-id', enabled: { google: true, 'fixture-id': true } });
  passed(f.run(openBaseline())); executableApply(f);
  writeFileSync(join(f.fresh, 'services', 'mcp-auth', 'src', 'auth-provider-catalog.js'), releaseCatalog.replaceAll('"github"', '"fixture-id"'));
  passed(f.run(block('oauth-apply'))); // A hardcoded second allowlist would fail.
});

test('switched provider step rerun is a byte and inode no-op', () => {
  const f = lifecycle({ providers: 'google,github', service: 'MCP_OAUTH_GOTRUE_PROVIDER=github\nFIXTURE_PUBLIC_SETTING=unchanged\n' });
  passed(f.run(openBaseline())); executableApply(f); passed(f.run(block('oauth-apply')));
  const before = serviceBytes(f), inode = statSync(join(f.env, 'service.env')).ino;
  passed(serviceAction(f, 'apply'));
  assert.deepEqual(serviceBytes(f), before); assert.equal(statSync(join(f.env, 'service.env')).ino, inode);
  assert.equal(restartRecords(f).length, 1);
});

test('atomic write failure before rename removes the same-directory secret temp and prints only its path', () => {
  const f = lifecycle({ providers: 'google,github', attempt: true }); releaseTree(f);
  const before = serviceBytes(f), session = join(f.proof, 'session.sh');
  const injection = `
def refused_replace(*a): raise OSError('fixture rename failure')
os.replace=refused_replace
`;
  const source = readFileSync(session, 'utf8');
  const anchor = 'import datetime,hashlib,json,os,pathlib,re,stat,subprocess,sys,tempfile\n';
  assert.ok(source.includes(anchor)); writeFileSync(session, source.replace(anchor, anchor + injection));
  const result = serviceAction(f, 'apply'); rejected(result, /fixture rename failure/);
  assert.deepEqual(serviceBytes(f), before);
  assert.deepEqual(readdirSync(f.env).filter(x => x.startsWith('.service.env.oauth-')), []);
  assert.match(result.stdout.trim(), new RegExp('^' + f.env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\.service\\.env\\.oauth-[^\\n]+$'));
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_PUBLIC_SETTING/);
  assert.equal(existsSync(join(f.proof, 'service-env-step.json')), false);
  writeFileSync(session, source); passed(serviceAction(f, 'restore'));
  const control = lifecycle({ providers: 'google,github', attempt: true }); releaseTree(control); passed(serviceAction(control, 'apply'));
});
