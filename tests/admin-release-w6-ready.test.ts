/**
 * W6/W7 readiness (lane/w6-ready): shared edge remeasure and refresh, the held recycle timer, the reviewed C1
 * verification row, the fence driver (R7 timing), the audit watcher, the W7 binding to its W6 and the W6 90-minute
 * window. Every block runs from the plan bytes; only filesystem boundaries are remapped to test-owned paths and
 * external commands (systemctl, docker, ssh, scp, the recycle hook, the owner CLI) are fixture stubs.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { canonicalAdminJson } from '../src/protocol/admin-policy.js';

const planPath = resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
const plan = readFileSync(planPath, 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const block = (id: string, source = blocks) => {
  const matches = source.filter(s => s.startsWith(`# step: ${id}\n`));
  assert.equal(matches.length, 1, `one complete ${id} block`);
  return matches[0]!;
};
const run = (source: string, env: Record<string, string> = {}, timeout = 20_000) => spawnSync('/bin/bash', [], {
  input: source, encoding: 'utf8', env: { ...process.env, ...env }, timeout,
});
const root = realpathSync(mkdtempSync(join(tmpdir(), 'admin-w6-ready-')));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = 'a'.repeat(40), hex = 'b'.repeat(64);
const base = () => ({
  release_sha: sha, plan_sha256: digest(plan), archive_sha256: hex,
  window: 'W1', window_id: 'Abc123', window_end_utc: new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  baseline_oauth_sha: 'c'.repeat(40), baseline_oauth_image: `sha256:${hex}`, baseline_edge_sha: 'd'.repeat(40), baseline_edge_image: `sha256:${hex}`,
  baseline_stack_sha: 'e'.repeat(40), baseline_postgres_image: `sha256:${hex}`, baseline_site_sha: 'f'.repeat(40),
  baseline_site_target: '/srv/commonswarm/site/releases/20261003T120000Z-ffffffffffff-abcdef0123456789',
  baseline_mcp_caddy_sha256: hex, baseline_api_caddy_sha256: hex, baseline_caddyfile_sha256: hex, baseline_ledger_sha256: hex,
  gate_receipt_sha256: digest('{}\n'), rollback_decision: 'retain-additive', approval: null, legacy_fence_approval: null,
  edge_recycle_service: 'fixture-edge-recycle.service', edge_recycle_timer: 'fixture-edge-recycle.timer', edge_recycle_sha256: hex,
} as Record<string, unknown>);
let inputCount = 0;
const inputFile = (input: Record<string, unknown>) => { const p = join(root, `inputs-${++inputCount}.json`); writeFileSync(p, JSON.stringify(input)); return p; };
const approval = (input: Record<string, unknown>, action: string) => ({ approver: 'HezLead', action, release_sha: input.release_sha,
  window_id: input.window_id, plan_sha256: input.plan_sha256, prompt_ref: 'delegated-by-Tom:2026-10-04T14:55Z:HezLead-chat' });
const stamp = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------- W6 window cap and the W7 binding input ----------------
test('W6 inputs: the window may last 90 minutes (W6 only); W7 requires w6_window_id, no other window accepts it', () => {
  const receipt = join(root, 'receipt.json'); writeFileSync(receipt, '{}\n');
  const validate = (input: Record<string, unknown>) => run(block('ai-inputs'), { INPUTS_FILE: inputFile(input), PLAN_FILE: planPath, GATE_RECEIPT_FILE: receipt });
  const w6: Record<string, unknown> = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_window_id: 'Xyz789', window_end_utc: stamp(80 * 60_000) };
  w6.approval = approval(w6, 'activate-admin-issuance-and-smoke');
  assert.equal(validate(w6).status, 0, validate(w6).stderr);
  for (const minutes of [91, 120]) {
    const late = { ...w6, window_end_utc: stamp(minutes * 60_000) };
    const r = validate(late); assert.notEqual(r.status, 0, `${minutes} min`); assert.match(r.stderr, /fresh deadline/);
  }
  for (const window of ['W1', 'W4', 'W5']) {
    const r = validate({ ...base(), window, rollback_decision: window === 'W1' ? 'retain-additive' : 'restore-service', window_end_utc: stamp(40 * 60_000),
      ...(window === 'W4' ? { legacy_fence_approval: approval({ ...base(), window }, 'terminal-legacy-db-fence') } : {}) });
    assert.notEqual(r.status, 0, window); assert.match(r.stderr, /fresh deadline/);
  }
  const w7: Record<string, unknown> = { ...base(), window: 'W7', rollback_decision: 'close-and-reconcile', w6_window_id: 'W6win1' };
  w7.approval = approval(w7, 'retire-legacy-admin-mint');
  assert.equal(validate(w7).status, 0, validate(w7).stderr);
  const missing = { ...w7 }; delete missing.w6_window_id;
  assert.match(validate(missing).stderr, /W7 w6_window_id/);
  assert.match(validate({ ...w7, w6_window_id: 'bad id' }).stderr, /W7 w6_window_id/);
  assert.match(validate({ ...w6, w6_window_id: 'W6win1' }).stderr, /w6_window_id is W7-only/);
});

// ---------------- shared edge remeasure / refresh ----------------
/** A plan copy whose box paths point into one fixture root, with matching INPUTS. */
function edgeFixture(opts: { row?: Record<string, unknown>; hookAfterFails?: boolean; timerActive?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(root, 'edge-')));
  const bin = join(dir, 'bin'), etc = join(dir, 'etc'), home = join(dir, 'home'), secret = join(dir, 'secret'), hook = join(dir, 'hook');
  for (const d of [bin, etc, home, secret]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const target = join(home, 'edge/releases', sha);
  const copy = plan.split('/private/tmp/anvil-secret').join(join(secret, 'anvil-secret')).split('/etc/commonswarm-admin-release').join(etc)
    .split('/usr/local/libexec/commonswarm-admin-edge-recycle').join(hook).split('/home/commonswarm').join(home);
  const planCopy = join(dir, 'RELEASE.md'); writeFileSync(planCopy, copy);
  const recycle = { release_sha: sha, target, image_digest: `sha256:${hex}`, artifact_digest: hex };
  writeFileSync(join(etc, 'recycle.json'), JSON.stringify(recycle), { mode: 0o600 });
  const row = { release_generation: 7, measured_generation: 7, invalidated_at: null, approved_edge_release_sha: sha, measured_edge_release_sha: sha,
    measured_edge_target: target, measured_mount: target, measured_image_digest: `sha256:${hex}`, measured_artifact_digest: hex, ...opts.row };
  writeFileSync(join(dir, 'row.json'), JSON.stringify(row));
  writeFileSync(join(dir, 'timer'), opts.timerActive ? 'active' : 'inactive');
  writeFileSync(join(dir, 'calls'), '');
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  stub('systemctl', `printf 'systemctl %s\\n' "$1" >>"${dir}/calls"\ncase "$1" in stop) printf inactive >"${dir}/timer";; start) printf active >"${dir}/timer";; is-active) test "$(cat "${dir}/timer")" = active;; show) printf 'inactive\\n';; *) exit 64;; esac`);
  stub('docker', `cat "${dir}/row.json"`);
  stub('node', `: >"$PG_SERVICE_OUTPUT"; : >"$PG_PASS_OUTPUT"`);
  writeFileSync(hook, `#!/bin/bash\nprintf 'hook %s\\n' "$1" >>"${dir}/calls"\n${opts.hookAfterFails ? 'test "$1" != after || exit 3' : ''}\nexit 0\n`, { mode: 0o700 });
  const inputs = inputFile({ ...base(), window: 'W6', plan_sha256: digest(copy) });
  const env = { PATH: `${bin}:${process.env.PATH}`, PLAN_FILE: planCopy, INPUTS_FILE: inputs };
  return { dir, planCopy, copy, inputs, env, target, trace: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean),
    timer: () => readFileSync(join(dir, 'timer'), 'utf8') };
}

test('ai-edge-remeasure: hook pair, row read with the receipt query bytes, a fresh receipt validated by ai-edge-receipt', () => {
  const f = edgeFixture();
  const out = join(f.dir, 'edge-measurement.json');
  const ok = run(block('ai-edge-remeasure', [...f.copy.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!)), { ...f.env, EDGE_MEASUREMENT_OUT: out });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASS ai-edge-remeasure: hook pair measured generation 7; fresh edge-measurement.json validated/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { release_sha: sha, target: f.target, mount: f.target, image_digest: `sha256:${hex}`, artifact_digest: hex, generation: 7, invalidated_at: null });
  assert.deepEqual(f.trace().filter(c => c.startsWith('hook')), ['hook before', 'hook after']);
  const remeasure = (g: ReturnType<typeof edgeFixture>) => run(block('ai-edge-remeasure', [...g.copy.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!)),
    { ...g.env, EDGE_MEASUREMENT_OUT: join(g.dir, 'edge-measurement.json') });
  const cases: Array<[string, Parameters<typeof edgeFixture>[0], RegExp]> = [
    ['timer still active', { timerActive: true }, /recycle timer expected stopped-by-caller got active/],
    ['failed measurement', { hookAfterFails: true }, /recycle hook after expected measured got failure; issuance stays closed/],
    ['stale generation', { row: { measured_generation: 6 } }, /measured generation expected measured-and-not-invalidated got stale-or-invalidated/],
    ['invalidated', { row: { invalidated_at: '2026-10-04T00:00:00Z' } }, /measured generation expected measured-and-not-invalidated got stale-or-invalidated/],
    ['other release approved', { row: { approved_edge_release_sha: 'c'.repeat(40) } }, /approved\/measured edge release expected this-release got other/],
    ['image differs from recycle.json', { row: { measured_image_digest: `sha256:${'9'.repeat(64)}` } }, /measured_image_digest expected recycle.json image_digest got other/],
  ];
  for (const [name, opts, message] of cases) {
    const g = edgeFixture(opts); const r = remeasure(g);
    assert.notEqual(r.status, 0, name); assert.match(r.stderr, message, `${name}: ${r.stderr}`);
    assert.ok(!existsSync(join(g.dir, 'edge-measurement.json')), `${name}: no receipt`);
  }
  const again = remeasure(f); assert.notEqual(again.status, 0); assert.match(again.stderr, /EDGE_MEASUREMENT_OUT expected absent got present/);
});

test('ai-edge-refresh: stops the recycle timer for the remeasure and re-arms it on success and on failure', () => {
  for (const [name, opts, ok] of [['success', {}, true], ['failed measurement', { hookAfterFails: true }, false]] as const) {
    const f = edgeFixture({ ...opts, timerActive: true });
    const out = join(f.dir, 'refreshed.json');
    const r = run(block('ai-edge-refresh', [...f.copy.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!)), { ...f.env, EDGE_MEASUREMENT_OUT: out });
    assert.equal(r.status === 0, ok, `${name}: ${r.stderr}`);
    if (!ok) assert.match(r.stderr, /FAIL ai-edge-refresh: edge remeasure expected PASS got failure; STOP/);
    assert.equal(f.timer(), 'active', `${name}: timer re-armed`);
    const systemd = f.trace().filter(c => c.startsWith('systemctl stop') || c.startsWith('systemctl start'));
    assert.deepEqual(systemd, ['systemctl stop', 'systemctl start'], name);
    assert.equal(existsSync(out), ok, name);
  }
});

// ---------------- the recycle timer W6 holds from apply until finish ----------------
function timerStub() {
  const dir = realpathSync(mkdtempSync(join(root, 'timer-')));
  writeFileSync(join(dir, 'systemctl'), `#!/bin/bash\nprintf '%s\\n' "$1" >>"${dir}/calls"\ncase "$1" in stop) printf inactive >"${dir}/state";; start) test "\${FAIL_START:-0}" = 1 && exit 5; printf active >"${dir}/state";; is-active) test "$(cat "${dir}/state")" = active;; show) printf 'inactive\\n';; *) exit 64;; esac\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'state'), 'active'); writeFileSync(join(dir, 'calls'), '');
  return { dir, env: { PATH: `${dir}:${process.env.PATH}`, EDGE_RECYCLE_TIMER: 'fixture.timer', EDGE_RECYCLE_SERVICE: 'fixture.service' },
    state: () => readFileSync(join(dir, 'state'), 'utf8'), calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(l => l && l !== 'show') };
}

test('W6 apply holds the recycle timer after success and re-arms it at once when the apply fails', () => {
  const apply = block('ai-w6-activation-apply');
  const start = apply.indexOf('w6_apply_exit() {'), end = apply.indexOf('unset EDGE_MEASUREMENT_OUT\n') + 'unset EDGE_MEASUREMENT_OUT\n'.length;
  assert.ok(start > 0 && end > start);
  const recovery = block('ai-w4-timer-recovery');
  for (const [name, remeasureOk] of [['success', true], ['failed remeasure', false]] as const) {
    const t = timerStub(); const proof = join(t.dir, 'proof'); mkdirSync(proof);
    writeFileSync(join(t.dir, 'recovery.sh'), recovery);
    const harness = `ai_run() { case "$1" in ai-w4-timer-recovery) eval "$(cat '${join(t.dir, 'recovery.sh')}')";; ai-edge-remeasure) ${remeasureOk ? 'printf "{}\\n" >"$EDGE_MEASUREMENT_OUT"' : 'return 1'};; *) return 1;; esac; }\n`;
    const r = run(`(\nset -euo pipefail\n${harness}${apply.slice(start, end)})`, { ...t.env, PROOF_DIR: proof });
    if (remeasureOk) {
      assert.equal(r.status, 0, r.stderr); assert.equal(t.state(), 'inactive', 'timer HELD until ai-w6-finish');
      assert.deepEqual(t.calls(), ['stop']);
    } else {
      assert.notEqual(r.status, 0); assert.match(r.stderr, /FAIL ai-w6-activation-apply: edge remeasure expected PASS got failure; STOP/);
      assert.equal(t.state(), 'active', 'failed apply re-arms the timer'); assert.deepEqual(t.calls(), ['stop', 'start', 'is-active']);
    }
  }
});

test('W6 emergency path: the activation rollback re-arms the timer and fails explicitly when it cannot; every close checks it', () => {
  const rollback = block('ai-w6-activation-rollback');
  const tail = rollback.slice(rollback.indexOf('# Re-arm the recycle timer W6 held'));
  for (const [name, failStart] of [['re-armed', false], ['start fails', true]] as const) {
    const t = timerStub(); writeFileSync(join(t.dir, 'state'), 'inactive'); const proof = join(t.dir, 'proof'); mkdirSync(proof);
    // Modelled errexit-ignored context (emergency close runs it under ai_run): the failure must still be explicit.
    const r = run(`( set +e\n${tail}\n) || exit 9`, { ...t.env, PROOF_DIR: proof, FAIL_START: failStart ? '1' : '0' });
    if (failStart) {
      assert.equal(r.status, 9); assert.match(r.stderr, /FAIL ai-w6-activation-rollback: recycle timer start expected success got failure; STOP/);
      assert.ok(!existsSync(join(proof, 'activation-rollback.txt')), 'no PASS receipt without an active timer');
    } else {
      assert.equal(r.status, 0, r.stderr); assert.equal(t.state(), 'active');
      assert.match(readFileSync(join(proof, 'activation-rollback.txt'), 'utf8'), /recycle timer active/);
    }
  }
  assert.match(block('ai-emergency-close'), /ai_run ai-w6-activation-rollback/);
  const close = block('ai-close');
  const line = close.split('\n').find(l => l.startsWith('systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" ||'))!;
  assert.ok(line, 'ai-close checks the timer on every close (success and recovered)');
  const t = timerStub(); writeFileSync(join(t.dir, 'state'), 'inactive');
  const r = run(`set -euo pipefail\n${line}\necho closed`, t.env);
  assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /closed/);
  assert.match(r.stderr, /FAIL ai-close: recycle timer expected active got inactive; re-arm with ai-w4-timer-recovery and report to HezLead; STOP/);
});

// ---------------- the reviewed C1 verification row ----------------
const C1_DOC = readFileSync(resolve('site/public/oauth/c1-smoke/client.json'));
function verification(change: { doc?: Buffer | string; digest?: string; version?: unknown; inputs?: Record<string, unknown> } = {}) {
  const dir = realpathSync(mkdtempSync(join(root, 'verify-')));
  const bound: Record<string, unknown> = { ...base(), window: 'W6' }, input = { ...bound, ...change.inputs };
  const c1 = { release_sha: bound.release_sha, window_id: bound.window_id, plan_sha256: bound.plan_sha256,
    verification_version: change.version ?? 1, metadata_digest: change.digest ?? digest(canonicalAdminJson(JSON.parse(C1_DOC.toString()))) };
  writeFileSync(join(dir, 'C1-inputs.json'), JSON.stringify(c1));
  writeFileSync(join(dir, 'c1-client-document.json'), change.doc ?? C1_DOC);
  const body = block('ai-w6-client-verification').match(/^python3 - "\$C1_INPUTS_FILE" "\$INPUTS_FILE" "\$PROOF_DIR\/c1-client-document.json" "\$PROOF_DIR\/client-verification.sql" <<'PY'\n([\s\S]*?)^PY$/m)![1]!;
  const r = spawnSync('python3', ['-', join(dir, 'C1-inputs.json'), inputFile(input), join(dir, 'c1-client-document.json'), join(dir, 'client-verification.sql')], { input: body, encoding: 'utf8' });
  return { r, sql: existsSync(join(dir, 'client-verification.sql')) ? readFileSync(join(dir, 'client-verification.sql'), 'utf8') : null };
}

test('W6 client verification: canonical digest equals canonicalAdminJson; the release-role insert carries the reviewed constants', () => {
  const ok = verification(); assert.equal(ok.r.status, 0, ok.r.stderr);
  const sql = ok.sql!;
  assert.match(sql, /^BEGIN; SET LOCAL ROLE commonswarm_admin_release; DO \$c1\$/);
  assert.match(sql, /WHERE singleton AND NOT admin_issuance_enabled FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'C1 verification requires issuance closed'/);
  assert.match(sql, /RAISE EXCEPTION 'existing C1 verification differs'/); assert.match(sql, /RAISE EXCEPTION 'another active C1 verification version'/);
  assert.ok(sql.includes(`'${digest(canonicalAdminJson(JSON.parse(C1_DOC.toString())))}'`));
  assert.ok(sql.includes("ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[]"));
  assert.ok(sql.includes("'web','cimd'") && sql.includes("ARRAY['https://commonswarm.com/oauth/c1-smoke/callback']::text[]"));
  assert.ok(sql.includes(`'gates:${digest('{}\n')}:admin-c1-smoke+admin-consent-client-policy','HezLead',true`));
  const docObject = JSON.parse(C1_DOC.toString());
  const cases: Array<[string, Parameters<typeof verification>[0], RegExp]> = [
    ['wrong digest', { digest: 'c'.repeat(64) }, /canonical document digest expected C1 metadata_digest got other/],
    ['byte digest instead of canonical', { digest: digest(C1_DOC) }, /canonical document digest expected C1 metadata_digest got other/],
    ['non-ASCII document', { doc: JSON.stringify({ ...docObject, client_name: 'C1 smoke é' }) }, /client document expected ASCII got non-ASCII/],
    ['second redirect', { doc: JSON.stringify({ ...docObject, redirect_uris: [...docObject.redirect_uris, 'https://commonswarm.com/other'] }) }, /client document fields expected reviewed-C1-client got other/],
    ['other client', { doc: JSON.stringify({ ...docObject, client_id: 'https://example.com/c.json' }) }, /client document fields expected reviewed-C1-client got other/],
    ['float', { doc: JSON.stringify({ ...docObject, extra: 1.5 }) }, /client document expected no-floats got float/],
    ['bad version', { version: 0 }, /C1 verification_version\/metadata_digest expected positive-integer-and-64-hex got other/],
    ['other window', { inputs: { window_id: 'Other1' } }, /C1 inputs binding expected this-window got other/],
  ];
  for (const [name, change, message] of cases) {
    const v = verification(change); assert.notEqual(v.r.status, 0, name); assert.match(v.r.stderr, message, `${name}: ${v.r.stderr}`); assert.equal(v.sql, null, name);
  }
  // Order: the row exists before activation and before the client check.
  assert.match(block('ai-w6-activation-apply'), /test -f "\$PROOF_DIR\/C1-client-verification.txt"/);
  assert.match(block('ai-w6-client-check'), /test -f "\$PROOF_DIR\/C1-client-verification.txt"/);
});

// ---------------- W7 binds its W6 ----------------
test('W7 preflight binds the closed-success W6 of this release by w6_window_id and measures the C1 digest', () => {
  const pre = block('ai-w7-preflight');
  const make = (change: { record?: Record<string, unknown> | null; report?: Record<string, unknown>; inputs?: Record<string, unknown>; closed?: string } = {}) => {
    const dir = realpathSync(mkdtempSync(join(root, 'w7-')));
    const w6 = join(dir, 'admin-issuance/release-proofs', `${sha}-W6-W6win1`); mkdirSync(w6, { recursive: true });
    const closed = change.closed ?? '2026-10-04T12:00:00Z';
    writeFileSync(join(w6, 'inputs.json'), JSON.stringify({ window: 'W6', release_sha: sha, window_id: 'W6win1', ...change.inputs }));
    writeFileSync(join(w6, 'closed.txt'), '2026-10-04T12:00:00Z\n');
    if (change.record !== null) {
      const r = { release_sha: sha, window: 'W6', window_id: 'W6win1', result: 'success', closed_at: closed, ...change.record };
      writeFileSync(join(w6, 'close-result.json'), '{' + Object.keys(r).sort().map(k => JSON.stringify(k) + ': ' + JSON.stringify((r as Record<string, unknown>)[k])).join(', ') + '}\n');
    }
    const report = { release_sha: sha, status: 'PASS', cleanup: true, audit_kinds: ['init', 'list', 'read', 'action'], grant_revoked: true, refresh_family_tombstoned: true,
      live_access_refused: true, client_approval_withdrawn: true, final_gate: 'open', ...change.report };
    writeFileSync(join(w6, 'C1.json'), JSON.stringify(report, null, 2) + '\n');
    const input = { ...base(), window: 'W7', w6_window_id: 'W6win1' };
    const r = run(pre.split('/home/commonswarm/admin-issuance').join(join(dir, 'admin-issuance')), { INPUTS_FILE: inputFile(input) });
    return { r, report: readFileSync(join(w6, 'C1.json')) };
  };
  const ok = make(); assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.deepEqual(JSON.parse(ok.r.stdout), { w6_window_id: 'W6win1', c1_report: JSON.parse(ok.r.stdout).c1_report, c1_report_sha256: digest(ok.report), final_gate: 'open' });
  const cases: Array<[string, Parameters<typeof make>[0], RegExp]> = [
    ['no close record', { record: null }, /W6 inputs.json\/closed.txt\/close-result.json\/C1.json expected regular-files got missing-or-not-regular/],
    ['recovered W6', { record: { result: 'recovered' } }, /W6 close result expected success-at-closed.txt got other/],
    ['record at another time', { closed: '2026-10-04T13:00:00Z' }, /W6 close result expected success-at-closed.txt got other/],
    ['W6 at another release', { inputs: { release_sha: 'c'.repeat(40) } }, /W6 inputs.json binding expected W6-same-release-and-id got mismatch/],
    ['incomplete C1', { report: { grant_revoked: false } }, /W6 C1.json evidence expected complete got incomplete/],
    ['C1 of another release', { report: { release_sha: 'c'.repeat(40) } }, /W6 C1.json release\/status\/cleanup expected this-release-PASS-cleanup got other/],
  ];
  for (const [name, change, message] of cases) {
    const c = make(change); assert.notEqual(c.r.status, 0, name); assert.match(c.r.stderr, message, `${name}: ${c.r.stderr}`);
  }
  assert.match(block('ai-w7-proof'), /W7_C1_BINDING=\$\(ai_run ai-w7-preflight\) \|\|/);
});

// ---------------- audit watcher and fence driver (R7 timing) ----------------
test('ai-w6-audit-watch runs the audit once agent.json arrives and refuses at the window end without it', () => {
  const dir = realpathSync(mkdtempSync(join(root, 'watch-')));
  const harness = `ai_deadline() { test ! -e "$PROOF_DIR/expired"; }\nai_run() { test "$1" = ai-w6-audit || return 1; test "$C1_AGENT_RECEIPT" = "$PROOF_DIR/agent.json"; printf '{"grant_id":"g"}\\n' >"$PROOF_DIR/C1-audit.json"; }\n`;
  writeFileSync(join(dir, 'agent.json'), '{}');
  const ok = run(harness + block('ai-w6-audit-watch'), { WINDOW: 'W6', PROOF_DIR: dir });
  assert.equal(ok.status, 0, ok.stderr); assert.ok(existsSync(join(dir, 'C1-audit.json')));
  const late = realpathSync(mkdtempSync(join(root, 'watch-'))); writeFileSync(join(late, 'expired'), '');
  const r = run(harness + block('ai-w6-audit-watch'), { WINDOW: 'W6', PROOF_DIR: late });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /FAIL ai-w6-audit-watch: agent.json expected before window end got none; STOP/);
});

test('ai-w6-fence-driver: agent receipt, upload, audit, download and human revoke inside the fence budget (R7, stubbed latency)', { timeout: 120_000 }, async () => {
  const LATENCY = Number(process.env.C1_FENCE_LATENCY_SECONDS ?? '1.5'); // conservative per ssh/scp round trip
  const dir = realpathSync(mkdtempSync(join(root, 'fence-')));
  const bin = join(dir, 'bin'), secret = join(dir, 'secret'), boxRoot = join(dir, 'box'), proof = join(dir, 'c1-proof');
  for (const d of [bin, secret, boxRoot, proof]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(secret, 'anvil-secret.')); chmodSync(stage, 0o700);
  const pointer = join(dir, 'c1-smoke.pointer');
  const copy = plan.split('/private/tmp/anvil-secret').join(join(secret, 'anvil-secret')).split('/Users/yulanbot/work/dcr-rt/c1-smoke.pointer').join(pointer);
  const planCopy = join(dir, 'RELEASE.md'); writeFileSync(planCopy, copy);
  const inputs = inputFile({ ...base(), window: 'W6', plan_sha256: digest(copy) });
  const boxProof = join(boxRoot, `home/commonswarm/admin-issuance/release-proofs/${sha}-W6-Abc123`); mkdirSync(boxProof, { recursive: true });
  const calls = join(dir, 'calls');
  // ssh/scp stubs: one latency per call; the box side maps /home/commonswarm and /tmp under boxRoot. When agent.json
  // is installed, the box audit watcher (modelled) writes C1-audit.json after AUDIT_SECONDS.
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
sleep ${LATENCY}; cmd="\${@: -1}"; printf 'ssh %s\\n' "$cmd" >>"${calls}"
cmd="\${cmd//\\/home\\/commonswarm/${boxRoot.replace(/\//g, '\\/')}\\/home\\/commonswarm}"; cmd="\${cmd//\\/tmp\\//${boxRoot.replace(/\//g, '\\/')}\\/tmp\\/}"
cmd="\${cmd//sudo -n /}"; cmd="\${cmd//install -o root -g root/install}"; mkdir -p "${boxRoot}/tmp"
case "$cmd" in install*agent.json) eval "$cmd" || exit 1; ( sleep 2; printf '{"grant_id":"11111111-1111-4111-8111-111111111111","provider_grant_id":"family","audit_counts":{"init":1,"list":1,"read":1,"action":1}}\\n' >"${boxProof}/C1-audit.json" ) & exit 0;; esac
eval "$cmd"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'scp'), `#!/bin/bash\nsleep ${LATENCY}; printf 'scp\\n' >>"${calls}"; dest="\${@: -1}"; dest="\${dest#ops@100.115.66.74:}"; mkdir -p "${boxRoot}/tmp"; cp "\${@: -2:1}" "${boxRoot}\${dest}"\n`, { mode: 0o700 });
  const realNode = spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'node'), `#!/bin/bash
case " $* " in *" src/cli.ts admin revoke "*) printf 'node revoke\\n' >>"${calls}"; printf '{"grant_id":"11111111-1111-4111-8111-111111111111","request_id":"r","state":"revoked"}\\n';;
 *" --input-type=module - "*) cat >/dev/null; printf 'node owner-check\\n' >>"${calls}";;
 *) exec '${realNode}' "$@";; esac\n`, { mode: 0o700 });
  const runId = '0123456789abcdef';
  const receipt = (ok: boolean) => JSON.stringify({ ok, run_id: runId, workspace: { name: 'c1-smoke-x (test, archive me)', accepted_residue: true },
    steps: { read_metadata_after_refresh: { result: 'pass' }, create_workspace: { result: 'pass', command_id: `c1_${runId}_create_workspace` } },
    refused_after_fence: ok ? { http_status: 403, refusal_code: 'grant_inactive', rpc_code: null, command_id: `c1_${runId}_verify_fenced` } : null, failed_step: null, failure_code: null });
  writeFileSync(join(stage, 'agent.json'), receipt(false));
  // The runner: waits for the fence file with the run ID, then records the refused follow-up and exits.
  const runner = spawn('/bin/bash', ['-c', `until test -f '${stage}/fenced'; do sleep 0.2; done; test "$(cat '${stage}/fenced')" = '${runId}' || exit 7; printf '%s' '${receipt(true)}' >'${stage}/agent.json'`], { stdio: 'ignore' });
  writeFileSync(join(proof, 'secret-stage.path'), stage + '\n'); writeFileSync(join(proof, 'runner.pid'), `${runner.pid}\n`);
  writeFileSync(join(proof, 'C1-inputs.json'), JSON.stringify({ owner_user_id: '22222222-2222-4222-8222-222222222222', state_directory: '/x' }));
  writeFileSync(join(stage, 'agent-status.log'), 'agent_steps_complete_awaiting_human_fence\n');
  const started = Date.now();
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn('/bin/bash', [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLAN_FILE: planCopy, INPUTS_FILE: inputs, C1_PROOF_DIR: proof,
      C1_INPUTS_FILE: join(proof, 'C1-inputs.json') } });
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => done({ status, stdout, stderr }));
    child.stdin.end(block('ai-w6-fence-driver', [...copy.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!)));
  });
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const seconds = Number(readFileSync(join(proof, 'fence-seconds.txt'), 'utf8'));
  const trace = readFileSync(calls, 'utf8').trim().split('\n');
  const roundTrips = trace.filter(l => l.startsWith('ssh') || l === 'scp').length;
  process.stdout.write(`R7 fence chain: ${seconds} s (wall ${elapsed.toFixed(1)} s) with ${roundTrips} ssh/scp round trips at ${LATENCY} s each; budget 240 s, target < 200 s\n`);
  assert.ok(seconds < 200 && elapsed < 200, `fence chain ${seconds} s`);
  // Order: upload agent.json, poll for the audit, download it, then the owner check and the human revoke; no withdrawal.
  const firstInstall = trace.findIndex(l => l.includes('install') && l.includes('agent.json'));
  const download = trace.findIndex(l => l.includes('cat') && l.includes('C1-audit.json'));
  const revoke = trace.indexOf('node revoke');
  assert.ok(firstInstall >= 0 && download > firstInstall && revoke > download, trace.join('\n'));
  assert.ok(!trace.some(l => l.includes('client-withdraw')), 'no approval withdrawal inside the fence window');
  assert.deepEqual(JSON.parse(readFileSync(join(proof, 'C1-audit.json'), 'utf8')).grant_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(JSON.parse(readFileSync(join(proof, 'human-revoke.json'), 'utf8')).state, 'revoked');
  assert.equal(readFileSync(join(stage, 'fenced'), 'utf8'), `${runId}\n`);
  assert.equal(JSON.parse(readFileSync(join(proof, 'agent.json'), 'utf8')).ok, false, 'the fence-window receipt precedes the runner result');
});

test('ai-w6-human-revoke refuses an approval withdrawal made before it (withdrawal itself fences the family)', () => {
  const dir = realpathSync(mkdtempSync(join(root, 'revoke-order-')));
  writeFileSync(join(dir, 'client-withdraw.json'), '{}'); writeFileSync(join(dir, 'secret-stage.path'), '/nonexistent\n'); writeFileSync(join(dir, 'runner.pid'), '1\n');
  const r = run(block('ai-w6-human-revoke'), { C1_PROOF_DIR: dir, C1_INPUTS_FILE: join(dir, 'c1.json') });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /FAIL ai-w6-human-revoke: client-withdraw.json expected absent-before-revoke got present; STOP/);
  assert.match(block('ai-w6-owner-client-command'), /withdraw: AFTER ai-w6-fence-driver/);
});

// ---------------- G4: the recycle archive before activation ----------------
test('W6 activation checks require the retained recycle archive with its digest (G4)', () => {
  const checks = block('ai-w6-activation-checks');
  const body = checks.match(/^python3 - "\$RELEASE_SHA" "\$INPUTS_FILE" <<'PY'\n([\s\S]*?)^PY$/m)![1]!;
  const make = (change: { archive?: string | null; recycle?: Record<string, unknown>; mode?: number } = {}) => {
    const dir = realpathSync(mkdtempSync(join(root, 'g4-')));
    const tmpRoot = join(dir, 'tmp'); mkdirSync(tmpRoot);
    const archiveBytes = 'release archive bytes';
    const archive = join(tmpRoot, `admin-issuance-${sha}-W4abcd.tar`);
    if (change.archive !== null) writeFileSync(archive, change.archive ?? archiveBytes);
    writeFileSync(join(dir, 'recycle.json'), JSON.stringify({ release_sha: sha, artifact_digest: digest(archiveBytes), archive, ...change.recycle }), { mode: change.mode ?? 0o600 });
    const source = body.split('/etc/commonswarm-admin-release').join(dir).split("r'/tmp/admin-issuance-'").join(`r'${tmpRoot}/admin-issuance-'`);
    return spawnSync('python3', ['-', sha, inputFile({ ...base(), archive_sha256: digest(archiveBytes) })], { input: source, encoding: 'utf8' });
  };
  assert.equal(make().status, 0, make().stderr);
  for (const [name, change, message] of [
    ['archive missing', { archive: null }, /recycle archive expected retained-regular-file got missing/],
    ['archive changed', { archive: 'other bytes' }, /recycle archive digest expected recycle.json artifact_digest got mismatch/],
    ['other release', { recycle: { release_sha: 'c'.repeat(40) } }, /recycle.json release\/artifact expected this-release-archive got other/],
    ['loose mode', { mode: 0o644 }, /recycle.json expected 0600-regular-file got other/],
  ] as const) {
    const r = make(change as Parameters<typeof make>[0]); assert.notEqual(r.status, 0, name); assert.match(r.stderr, message, `${name}: ${r.stderr}`);
  }
});
