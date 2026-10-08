/** Owns the executable edge-release lifecycle contract; no Docker/network/box. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
const scratch = mkdtempSync('/private/tmp/edge-release-contract-');
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
function passed(r: ReturnType<typeof spawnSync>) { assert.equal(r.status, 0, String(r.stderr)); }
function stopped(r: ReturnType<typeof spawnSync>, pattern = /FAIL.*STOP/s) {
  assert.notEqual(r.status, 0, String(r.stdout)); assert.match(String(r.stderr), pattern);
}

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
test('every block and persisted helper parses; embedded Python compiles; heredoc substitutions refuse', () => {
  assert.equal(blocks.length, [...plan.matchAll(/^```sh$/gm)].length);
  const seen = new Set<string>();
  for (const source of [...blocks, helpers]) {
    if (source !== helpers) {
      const [step, readonly, host] = source.split('\n');
      assert.match(step!, /^# step: edge-[a-z0-9-]+$/);
      assert.match(readonly!, /^# readonly: (yes|no|probe)$/); assert.match(host!, /^# host: /);
      assert.ok(!seen.has(step!)); seen.add(step!);
    }
    passed(spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8' }));
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
  const root = mkdtempSync(join(scratch, 'lifecycle-')), proof = join(root, 'proof'), home = join(root, 'home');
  mkdirSync(proof); const d = fixture();
  const old = join(home, 'edge/releases', d.baseline_edge_sha), fresh = join(home, 'edge/releases', d.release_sha), helper = join(home, 'admin-issuance/releases', d.release_sha);
  mkdirSync(old, { recursive: true });
  if (trees) { mkdirSync(fresh, { recursive: true }); mkdirSync(helper, { recursive: true }); }
  writeFileSync(join(old, 'baseline.txt'), 'immutable baseline');
  const current = join(home, 'edge/current'); symlinkSync(old, current);
  const binding = join(root, 'recycle.json');
  const baseline = Buffer.from(' { "release_sha":"' + d.baseline_edge_sha + '", "target":"' + old + '", "image_digest":"' + d.baseline_edge_image + '", "artifact_digest":"' + d.recycle_archive_sha256 + '", "archive":"/tmp/admin-issuance-baseline.tar", "postgres_image":"' + d.baseline_postgres_image + '", "release_root":"/retained/baseline-helper" }\n');
  writeFileSync(binding, baseline, { mode: 0o600 }); writeFileSync(join(proof, 'recycle.baseline.json'), baseline);
  writeFileSync(join(proof, 'plan.md'), plan);
  writeFileSync(join(proof, 'inputs.json'), JSON.stringify({ ...d, plan_sha256: hash(plan), recycle_json_sha256: hash(baseline) }));
  writeFileSync(join(proof, 'open.txt'), 'PASS\n'); writeFileSync(join(proof, 'opened.txt'), clock);
  writeFileSync(join(proof, 'preflight.txt'), 'PASS\n');
  const stage = join(root, 'anvil-secret.Abc123'), lock = join(root, 'OPEN');
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
 if str(self)==os.environ['FIXTURE_BINDING'] or self.name=='failed-attempts' or str(self)==os.environ['FIXTURE_STAGE']:
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
 if args==['docker','inspect','commonswarm-edge-edge-runtime-1']:
  return json.dumps([{'Config':{'Labels':{'com.docker.compose.project.working_dir':os.environ['FIXTURE_OLD_EDGE']+'/deploy/edge-runtime'}}}]).encode()
 return real_check_output(args,*a,**kw)
subprocess.check_output=check_output
exec(compile(sys.stdin.read(),'<extracted-plan-python>','exec'))
`);
  const mapped = helpers.replaceAll('/home/commonswarm', home);
  const session = `
PROOF_DIR=${JSON.stringify(proof)}
INPUTS_FILE="$PROOF_DIR/inputs.json"
RELEASE_SHA=${d.release_sha}
WINDOW_ID=${d.window_id}
OLD_EDGE=${JSON.stringify(old)}
NEW_EDGE=${JSON.stringify(fresh)}
NEW_HELPER=${JSON.stringify(helper)}
RECYCLE_JSON=${JSON.stringify(binding)}
SECRET_STAGE=${JSON.stringify(stage)}
LOCK=${JSON.stringify(lock)}
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${d.release_sha}-${d.window_id}.tar
EDGE_RECYCLE_TIMER=commonswarm-edge-recycle.timer
EDGE_RECYCLE_SERVICE=commonswarm-edge-recycle.service
${mapped}
python3() { ${JSON.stringify(spawnSync('which',['python3'],{encoding:'utf8'}).stdout.trim())} ${JSON.stringify(wrapper)} "$@"; }
# Mac fixture maps only the Linux rename primitive; lifecycle stays extracted.
mv() { test "$1" = -Tf; /usr/bin/python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$2" "$3"; }
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
  return { root, proof, home, current, binding, baseline, old, fresh, helper, stage, run(source: string, extra: Record<string,string> = {}) {
    return spawnSync('/bin/bash', ['-s'], { input: source.replaceAll('/home/commonswarm', home).replaceAll('/tmp/anvil-secret', root + '/anvil-secret'), encoding: 'utf8', env: { ...process.env, PROOF_DIR: proof, FIXTURE_BINDING: binding, FIXTURE_CLOCK: clock, FIXTURE_STAGE: stage, FIXTURE_OLD_EDGE: old, ...extra } });
  }, append(source: string) { writeFileSync(join(proof, 'session.sh'), readFileSync(join(proof, 'session.sh'), 'utf8') + '\n' + source); } };
}

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
  assert.equal(existsSync(join(f.root, 'OPEN')), false);
  assert.equal(existsSync(join(f.proof, 'events')), false);
  assert.deepEqual(readFileSync(f.binding), f.baseline);
  }
  // Positive apply control reaches the same actual admission before its mutation.
  const control = lifecycle(); passed(control.run(block('edge-apply')));
  const attempted = lifecycle(); writeFileSync(join(attempted.proof, 'edge-attempted.txt'), clock);
  stopped(attempted.run(block('edge-abort')), /attempt present.*STOP/);
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


test('extracted route probes accept real unauthorized response shape and refuse a _meta parameter error', () => {
  const source = python(/^edge_route_probes\(\) \{[\s\S]*?^\}/m.exec(helpers)![0]);
  const harness = `
import http.client,json,ssl,sys
ssl.create_default_context=lambda **kw: object()
class Response:
 def __init__(self,status,data,headers=None): self.status=status; self.data=data; self.headers=headers or {}
 def read(self,n): return self.data
 def getheaders(self): return list(self.headers.items())
class Connection:
 def __init__(self,host,**kw): self.host=host
 def request(self,method,path,body,headers): self.method,self.path,self.body=method,path,body
 def close(self): pass
 def getresponse(self):
  path=self.path
  if path=='/admin/gate': return Response(200,b'{"state":"closed"}' if self.method=='GET' else b'',{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'})
  if path=='/admin': return Response(401,b'{"error":"unauthorized"}')
  if path=='/.well-known/oauth-protected-resource/admin':
   if self.method=='HEAD': return Response(405,b'{}')
   return Response(200,b'{"resource":"https://api.commonswarm.com/admin","authorization_servers":["https://mcp.commonswarm.com"]}')
  if path=='/.well-known/oauth-authorization-server': return Response(200,b'{"issuer":"https://mcp.commonswarm.com"}')
  if path=='/.well-known/oauth-protected-resource': return Response(200,b'{}')
  assert path=='/mcp'
  params=json.loads(self.body)['params']
  if '_meta' in params and sys.argv[2]=='bad': return Response(401,b'{"error":{"code":-32602}}')
  return Response(401,b'{"error":"unauthorized"}')
http.client.HTTPSConnection=Connection
exec(compile(sys.stdin.read(),'<extracted-local-caddy-probes>','exec'))
`;
  passed(spawnSync('python3',['-c',harness,'unused-public-ca','good'],{input:source,encoding:'utf8'}));
  const bad = spawnSync('python3',['-c',harness,'unused-public-ca','bad'],{input:source,encoding:'utf8'});
  assert.notEqual(bad.status,0); assert.match(bad.stderr,/AssertionError/);
});
