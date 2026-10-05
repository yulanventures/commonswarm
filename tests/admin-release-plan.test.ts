/** Release contract: execute the plan's input/refusal blocks; never operate the box. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

const directory = resolve('docs/evidence/2026-10-03-admin-issuance-release');
const planPath = join(directory, 'RELEASE.md');
const plan = readFileSync(planPath, 'utf8');
// Anchored closing fence: embedded strings cannot silently truncate a block.
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const block = (id: string) => {
  const matches = blocks.filter(s => s.startsWith(`# step: ${id}\n`));
  assert.equal(matches.length, 1, `one complete ${id} block`);
  return matches[0]!;
};
// Inputs binding the in-repository plan bytes, for blocks that run ai_run.
const releasedPlanInputs = (dir: string) => { const file = join(dir, 'released-plan-inputs.json'); writeFileSync(file, JSON.stringify({ plan_sha256: digest(plan) })); return file; };
const run = (source: string, env: Record<string, string> = {}) => spawnSync('/bin/bash', [], {
  input: source, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000,
});
// Nonsecret fixtures are retained under the task's temporary root; no HOME change/deletion.
const scratch = mkdtempSync(join(tmpdir(), 'admin-plan-contract-'));
// Valid-looking substituted plans: the executed validators become no-ops (digest differs).
const substitutedPlan = join(scratch, 'substituted-RELEASE.md');
writeFileSync(substitutedPlan, plan.split('# step: ai-edge-receipt\n').join('# step: ai-edge-receipt\nexit 0\n')
  .split('# step: ai-live-controls\n').join('# step: ai-live-controls\nexit 0\n').split('# step: ai-gates\n').join('# step: ai-gates\nexit 0\n'));
const linkedPlan = join(scratch, 'linked-RELEASE.md'); symlinkSync(planPath, linkedPlan);
const planRefusal = (step: string, label: string, got: string) => `FAIL ${step}: ${label} expected absolute-regular-file-with-input-plan_sha256 got ${got}; STOP`;
const receiptFile = join(scratch, 'receipt.json');
writeFileSync(receiptFile, '{}\n');
const sha = 'a'.repeat(40), hex = 'b'.repeat(64);

// Portable fixtures. Production plan blocks pin the macOS secret window
// /private/tmp/anvil-secret.XXXXXX and the Mac pointer path; neither exists on
// Linux, and a test must never write under the real home. Tests create the same
// fresh 0700 anvil-secret.XXXXXX stage under a task-owned parent in the OS
// temporary root and execute blocks whose two path literals are rewritten to
// that parent, exactly and countably. RELEASE.md itself is unchanged (pinned by
// the static test below), so its digest and production rule do not move.
const temporaryRoot = realpathSync(tmpdir()), realHome = realpathSync(homedir());
const outsideHome = (path: string) => path !== realHome && !path.startsWith(realHome + sep);
const secretRoot = mkdtempSync(join(temporaryRoot, 'admin-plan-secret-root.'));
const pointerDir = join(realpathSync(scratch), 'dcr-rt'); mkdirSync(pointerDir, { mode: 0o700 });
const fixturePointer = join(pointerDir, 'c1-smoke.pointer');
assert.ok(outsideHome(secretRoot) && outsideHome(realpathSync(scratch)) && outsideHome(pointerDir), 'test fixtures resolve under the real home');
assert.match(secretRoot, /^[A-Za-z0-9/_.-]+$/, 'fixture root must be a plain path inside a Python raw string');
const PRODUCTION_STAGE_RE = "r'/private/tmp/anvil-secret\\.";
const FIXTURE_STAGE_RE = `r'${secretRoot.replace(/[.-]/g, '\\$&')}/anvil-secret\\.`;
const PRODUCTION_POINTER = '/Users/yulanbot/work/dcr-rt/c1-smoke.pointer';
const PRODUCTION_PLAN_PATH = '"$RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md"';
function portable(source: string, expected: { stage: number; pointer: number }) {
  assert.equal(source.split(PRODUCTION_STAGE_RE).length - 1, expected.stage, 'production secret-window regex count');
  assert.equal(source.split(PRODUCTION_POINTER).length - 1, expected.pointer, 'production pointer literal count');
  const result = source.split(PRODUCTION_STAGE_RE).join(FIXTURE_STAGE_RE).split(PRODUCTION_POINTER).join(fixturePointer);
  assert.ok(!result.includes('/private/tmp/anvil-secret\\.') && !result.includes(PRODUCTION_POINTER));
  return result;
}
const STAGE_NAME = /^anvil-secret\.[A-Za-z0-9]{6}$/;
function guardStage(stage: string) {
  const stat = lstatSync(stage);
  assert.ok(dirname(stage) === secretRoot && STAGE_NAME.test(basename(stage)) && realpathSync(stage) === stage, `unexpected stage ${stage}`);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && outsideHome(stage), `unsafe stage ${stage}`);
}
function makeStage() { const stage = mkdtempSync(join(secretRoot, 'anvil-secret.')); guardStage(stage); return stage; }
// Remove only the exact stage this file created, after re-checking it.
function removeStage(stage: string) { guardStage(stage); rmSync(stage, { recursive: true }); }
after(() => {
  assert.ok(dirname(secretRoot) === temporaryRoot && /^admin-plan-secret-root\.[A-Za-z0-9]{6}$/.test(basename(secretRoot)));
  rmSync(secretRoot, { recursive: true });
});
const base = () => ({
  release_sha: sha, plan_sha256: digest(plan), archive_sha256: hex,
  window: 'W1', window_id: 'Abc123', window_end_utc: new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  baseline_oauth_sha: 'c'.repeat(40), baseline_oauth_image: `sha256:${hex}`,
  baseline_edge_sha: 'd'.repeat(40), baseline_edge_image: `sha256:${hex}`,
  baseline_stack_sha: 'e'.repeat(40), baseline_postgres_image: `sha256:${hex}`,
  baseline_site_sha: 'f'.repeat(40), baseline_site_target: '/srv/commonswarm/site/releases/20261003T120000Z-ffffffffffff-abcdef0123456789',
  baseline_mcp_caddy_sha256: hex, baseline_api_caddy_sha256: hex, baseline_caddyfile_sha256: hex,
  baseline_ledger_sha256: hex, gate_receipt_sha256: digest('{}\n'), rollback_decision: 'retain-additive',
  approval: null, legacy_fence_approval: null,
  edge_recycle_service: 'fixture-edge-recycle.service', edge_recycle_timer: 'fixture-edge-recycle.timer', edge_recycle_sha256: hex,
});
type Input = Record<string, unknown>;
const inputFile = (input: Input) => {
  const path = join(scratch, 'inputs.json');
  writeFileSync(path, JSON.stringify(input));
  return path;
};
const validate = (input: Input) => run(block('ai-inputs'), {
  INPUTS_FILE: inputFile(input), PLAN_FILE: planPath, GATE_RECEIPT_FILE: receiptFile,
});
function approval(input: Input, action: string): Input {
  return { approver: 'HezLead', action, release_sha: input.release_sha,
    window_id: input.window_id, plan_sha256: input.plan_sha256, prompt_ref: 'task/explicit-approval' };
}

test('admin release plan: every complete marked block parses in Bash 3.2 and embedded Python compiles', () => {
  assert.ok(blocks.length >= 30, 'unexpectedly incomplete extraction');
  const seen = new Set<string>();
  for (const source of blocks) {
    const lines = source.split('\n');
    assert.match(lines[0]!, /^# step: ai-[a-z0-9-]+$/);
    assert.match(lines[1]!, /^# readonly: (yes|probe|no)$/);
    assert.ok(!seen.has(lines[0]!), 'duplicate step marker'); seen.add(lines[0]!);
    const shell = spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(shell.status, 0, `${lines[0]}: ${shell.stderr}`);
    for (const match of source.matchAll(/^python3[^\n]*<<'PY'\n([\s\S]*?)^PY$/gm)) {
      const python = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<plan-python>", "exec")'], {
        input: match[1], encoding: 'utf8',
      });
      assert.equal(python.status, 0, `${lines[0]} Python: ${python.stderr}`);
    }
    for (const match of source.matchAll(/^node[^\n]*<<'JS'\n([\s\S]*?)^JS$/gm)) {
      const javascript = spawnSync('node', ['--check', '--input-type=module'], { input: match[1], encoding: 'utf8' });
      assert.equal(javascript.status, 0, `${lines[0]} JavaScript: ${javascript.stderr}`);
    }
  }
  // A known multi-heredoc block must remain intact through its final receipt.
  assert.match(block('ai-w4-apply'), /W4 switched and measured/);
  assert.match(block('ai-db-session'), /PASS ai-db-session/);
});

test('admin release plan: production secret window and pointer stay pinned; fixtures are portable rewrites only', () => {
  // The executed fixtures rewrite these literals; the plan must still carry them.
  assert.equal(plan.split(PRODUCTION_STAGE_RE).length - 1, 10, 'every secret-window check keeps /private/tmp/anvil-secret (W2 probe and revoke readers each check it)');
  assert.equal(plan.split('$(mktemp -d /private/tmp/anvil-secret.XXXXXX)').length - 1, 4, 'every stage is a fresh /private/tmp/anvil-secret.XXXXXX');
  assert.match(block('ai-w6-pointer'), /assert str\(pointer\)=='\/Users\/yulanbot\/work\/dcr-rt\/c1-smoke\.pointer'/);
  assert.match(block('ai-close'), /re\.fullmatch\(r'\/private\/tmp\/anvil-secret\\\.\[A-Za-z0-9\]\{6\}',str\(p\)\)/);
  assert.match(block('ai-w2-between-probes'), /re\.fullmatch\(r'\/private\/tmp\/anvil-secret\\\.\[A-Za-z0-9\]\{6\}',str\(stage\)\)/);
  assert.equal(block('ai-db-session').split(PRODUCTION_PLAN_PATH).length - 1, 1, 'dispatcher reads the released plan');
  assert.ok(outsideHome(secretRoot) && outsideHome(fixturePointer));
});

test('admin release plan: full baseline inputs pass; omissions, prefixes, malformed values and digest drift refuse', () => {
  const good = validate(base());
  assert.equal(good.status, 0, good.stderr);
  for (const key of Object.keys(base())) {
    const missing: Input = base(); delete missing[key];
    const refused = validate(missing);
    assert.notEqual(refused.status, 0, `missing ${key} was accepted`);
    assert.match(refused.stderr, /required input keys/);
  }
  const bad: Array<[string, unknown]> = [
    ['baseline_oauth_sha', 'abc1234'], ['baseline_edge_sha', 'Z'.repeat(40)],
    ['baseline_stack_sha', 'a'.repeat(39)], ['baseline_site_sha', 123],
    ['baseline_oauth_image', 'oauth:latest'], ['baseline_edge_image', 'sha256:abcd'],
    ['baseline_postgres_image', 'postgres:17'], ['baseline_ledger_sha256', 'abc'],
    ['baseline_api_caddy_sha256', 'x'.repeat(64)], ['baseline_mcp_caddy_sha256', null],
    ['baseline_caddyfile_sha256', 'abc'], ['archive_sha256', 'no'],
    ['window_end_utc', '2020-01-01T00:00:00Z'], ['window_id', '../bad'],
    ['baseline_site_target', '/srv/commonswarm/site/current'], ['window', 'W8'],
    ['edge_recycle_service','../evil.service'], ['edge_recycle_timer','fixture.service'], ['edge_recycle_sha256','bad'],
    ['rollback_decision', 'drop-history'], ['plan_sha256', hex], ['gate_receipt_sha256', hex],
  ];
  for (const [key, value] of bad) {
    const result = validate({ ...base(), [key]: value });
    assert.notEqual(result.status, 0, `${key} malformed input accepted`);
    assert.match(result.stderr, /FAIL ai-inputs/);
  }
});

test('admin release plan: W2b inputs bind the earlier W2 by w2_release_sha and w2_window_id; only W6 may name a W2b', () => {
  const w2b: Input = { ...base(), window: 'W2b', w2_release_sha: 'b'.repeat(40), w2_window_id: 'RGLqZX' };
  const good = validate(w2b); assert.equal(good.status, 0, good.stderr);
  for (const key of ['w2_release_sha', 'w2_window_id']) {
    const missing: Input = { ...w2b }; delete missing[key];
    const refused = validate(missing); assert.notEqual(refused.status, 0, key); assert.match(refused.stderr, new RegExp(`FAIL ai-inputs: W2b ${key}; STOP`));
  }
  for (const [key, value] of [['w2_release_sha', 'b'.repeat(39)], ['w2_release_sha', 'B'.repeat(40)], ['w2_window_id', '../bad'], ['w2_window_id', 'RGLqZ']] as const) {
    const refused = validate({ ...w2b, [key]: value }); assert.notEqual(refused.status, 0, `${key}=${value}`); assert.match(refused.stderr, /FAIL ai-inputs: W2b w2_/);
  }
  const decision = validate({ ...w2b, rollback_decision: 'restore-service' }); assert.notEqual(decision.status, 0); assert.match(decision.stderr, /rollback decision/);
  const approved = validate({ ...w2b, approval: approval(w2b, 'activate-admin-issuance-and-smoke') }); assert.notEqual(approved.status, 0); assert.match(approved.stderr, /no implicit activation approval/);
  const probe = validate({ ...w2b, probe_workspace_id: '00000000-0000-4000-8000-000000000000' }); assert.notEqual(probe.status, 0); assert.match(probe.stderr, /probe_workspace_id is W2-only/);
  for (const window of ['W1', 'W2', 'W3']) {
    const input: Input = { ...base(), window, rollback_decision: window === 'W3' ? 'restore-service' : 'retain-additive', w2_release_sha: 'b'.repeat(40), w2_window_id: 'RGLqZX' };
    if (window === 'W2') input.probe_workspace_id = '00000000-0000-4000-8000-000000000000';
    const refused = validate(input); assert.notEqual(refused.status, 0, window); assert.match(refused.stderr, /w2_release_sha\/w2_window_id are W2b-only/);
  }
  // W6 binds the W2b by w2b_release_sha and w2b_window_id; that W2b may be at an EARLIER release (yYGHEd ran at a5cb8251). No other window may.
  const w6: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_release_sha: 'd'.repeat(40), w2b_window_id: 'Xyz789' };
  w6.approval = approval(w6, 'activate-admin-issuance-and-smoke');
  const w6good = validate(w6); assert.equal(w6good.status, 0, w6good.stderr);
  // Required for W6: at the W3-W7 release the issuer credential exists only through W2b.
  for (const value of ['bad id', 'Xyz78', 7, null]) {
    const w6bad = validate({ ...w6, w2b_window_id: value }); assert.notEqual(w6bad.status, 0, String(value)); assert.match(w6bad.stderr, /FAIL ai-inputs: W6 w2b_window_id; STOP/);
  }
  const w6missing: Input = { ...w6 }; delete w6missing.w2b_window_id;
  const absent = validate(w6missing); assert.notEqual(absent.status, 0); assert.match(absent.stderr, /FAIL ai-inputs: W6 w2b_window_id; STOP/);
  for (const value of [undefined, 'a'.repeat(39), 'A'.repeat(40), 7, null]) {
    const bad: Input = { ...w6, w2b_release_sha: value }; if (value === undefined) delete bad.w2b_release_sha;
    const r = validate(bad); assert.notEqual(r.status, 0, String(value)); assert.match(r.stderr, /FAIL ai-inputs: W6 w2b_release_sha; STOP/);
  }
  // The W2b release may differ from the W6 release (the frozen release F binds the a5cb8251 W2b).
  assert.notEqual(w6.w2b_release_sha, w6.release_sha); assert.equal(w6good.status, 0);
  const w5sha = validate({ ...base(), window: 'W5', rollback_decision: 'restore-service', w2b_release_sha: 'd'.repeat(40) }); assert.notEqual(w5sha.status, 0); assert.match(w5sha.stderr, /w2b_release_sha\/w2b_window_id are W6-only/);
  const w5 = validate({ ...base(), window: 'W5', rollback_decision: 'restore-service', w2b_window_id: 'Xyz789' }); assert.notEqual(w5.status, 0); assert.match(w5.stderr, /w2b_release_sha\/w2b_window_id are W6-only/);
  const w2bSelf = validate({ ...w2b, w2b_window_id: 'Xyz789' }); assert.notEqual(w2bSelf.status, 0); assert.match(w2bSelf.stderr, /w2b_release_sha\/w2b_window_id are W6-only/);
  // Window order: W2b is followed by W3 and only then W4; nothing in W2b or the W6 binding reads W3 or W4 state.
  for (const id of ['ai-w2b-preflight', 'ai-w2-issuer-credential']) assert.doesNotMatch(block(id), /W3-probes|W4-readback|-W3-|-W4-/, id);
  assert.match(plan, /The order is W2b, W3, then W4, W5, W6, W7/);
});

test('admin release plan: W6 and W7 approval is action/release/window/plan bound; activation refuses absent approval before any operation', () => {
  for (const [window, action, id] of [
    ['W6', 'activate-admin-issuance-and-smoke', 'ai-w6-activation-approval'],
    ['W7', 'retire-legacy-admin-mint', 'ai-w7-approval'],
  ]) {
    const input: Input = { ...base(), window, rollback_decision: 'close-and-reconcile', ...(window === 'W6' ? { w2b_release_sha: 'd'.repeat(40), w2b_window_id: 'Xyz789' } : { w6_window_id: 'W6win1' }) };
    const noApproval = run(block(id!), { INPUTS_FILE: inputFile(input) });
    assert.notEqual(noApproval.status, 0);
    assert.match(noApproval.stderr, /explicit .* approval required/);
    input.approval = approval(input, action!);
    assert.equal(validate(input).status, 0);
    const positive = run(block(id!), { INPUTS_FILE: inputFile(input) });
    assert.equal(positive.status, 0, positive.stderr);
    for (const [key, bad] of [['action', 'some-other-action'], ['release_sha', 'b'.repeat(40)],
      ['window_id', 'Other1'], ['plan_sha256', hex], ['approver', 'Maker'], ['prompt_ref', '']] as const) {
      const changed = { ...input, approval: { ...(input.approval as Input), [key]: bad } };
      assert.notEqual(validate(changed).status, 0, `unbound ${window} ${key}`);
      assert.notEqual(run(block(id!), { INPUTS_FILE: inputFile(changed) }).status, 0);
    }
    if (window === 'W6') {
      const apply = run(block('ai-w6-activation-apply'), { INPUTS_FILE: inputFile({ ...input, approval: null }) });
      assert.notEqual(apply.status, 0);
      assert.match(apply.stderr, /activation approval required; STOP/);
    }
  }
  assert.match(block('ai-w7-proof'), /ai_run ai-w7-approval/);
  assert.match(block('ai-w7-proof'), /ai_run ai-w7-preflight/);
});

test('admin release plan: W4 requires separate terminal fence approval and W6 refuses absent approval inputs', () => {
  const edge: Input = { ...base(), window: 'W4', rollback_decision: 'restore-service' };
  assert.match(validate(edge).stderr, /terminal-legacy-db-fence approval required/);
  edge.legacy_fence_approval = approval(edge, 'terminal-legacy-db-fence');
  assert.equal(validate(edge).status, 0);
  const smoke: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_release_sha: 'd'.repeat(40), w2b_window_id: 'Xyz789' };
  smoke.approval = approval(smoke, 'activate-admin-issuance-and-smoke');
  assert.equal(validate(smoke).status, 0);
  const result = run(block('ai-w6-preflight'), { INPUTS_FILE: inputFile(smoke) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /C1 approval inputs absent; STOP/);
});

test('admin release plan: no operational SHA literals, secret output, HOME changes or guard bypasses', () => {
  assert.doesNotMatch(plan, /\b[0-9a-f]{40}\b/);
  for (const source of blocks) {
    assert.doesNotMatch(source, /(?:^|[;\s])(?:export\s+|env\s+)?HOME=/m);
    assert.doesNotMatch(source, /(?:^|[\s;"'])\/(?:usr\/)?bin\/rm\b|command rm\b|find[^\n]*-delete/m);
    assert.doesNotMatch(source, /gh\s+(?:workflow\s+run|run\s+rerun)|open -a|\/Applications\/Google Chrome/);
    assert.doesNotMatch(source, /set -x|print\(.*(?:password|access_token|refresh_token)/);
  }
});

test('admin release plan: reserves are verbatim and all lane gates own retained positive/negative proof contracts', () => {
  for (let i = 1; i <= 5; i++) {
    const name = `2026100300000${i}-rollback.sql`;
    assert.deepEqual(readFileSync(join(directory, 'reserve', name)), readFileSync(join('supabase/admin-delegation-reserve', name)));
  }
  const contract = JSON.parse(readFileSync(join(directory, 'GATES.json'), 'utf8')) as {
    gates: Record<string, string[]>; windows: Record<string, string[]>;
  };
  const names = new Set(contract.windows.W6);
  // The specification, rather than a copied implementation list, owns these requirements.
  const spec = readFileSync('docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md', 'utf8');
  const lanes = spec.split('## Build lanes: ordered reviewable commits')[1]!.split('## Release sequence')[0]!;
  for (const m of lanes.matchAll(/`((?:admin-|legacy-|as-dpop-|edge-dpop-|mcp-refresh-|mcp-interaction-|full-account-)[a-z-]+)`/g)) {
    assert.ok(names.has(m[1]!), `spec gate ${m[1]} not required by W6`);
  }
  for (const required of Object.values(contract.windows)) {
    for (const name of required) assert.ok(contract.gates[name]?.length, `unowned gate ${name}`);
  }
});

test('admin release plan: checker receipt validates exact build, controls and retained file digests', () => {
  const contract = JSON.parse(readFileSync(join(directory, 'GATES.json'), 'utf8'));
  const evidence = join(scratch, 'control.txt'); writeFileSync(evidence, 'independent nonsecret control\n');
  const receipt: { release_sha: string; evidence_root: string; gates: Record<string, unknown> } = {
    release_sha: sha, evidence_root: scratch, gates: {},
  };
  for (const name of contract.windows.W1) receipt.gates[name] = {
    status: 'PASS', controls: contract.gates[name], file: 'control.txt',
    sha256: digest(readFileSync(evidence)),
  };
  const path = join(scratch, 'full-receipt.json');
  const check = () => {
    writeFileSync(path, JSON.stringify(receipt));
    return run(block('ai-gates'), { INPUTS_FILE: inputFile(base()), GATE_RECEIPT_FILE: path, PLAN_FILE: planPath });
  };
  assert.equal(check().status, 0);
  receipt.release_sha = 'b'.repeat(40);
  assert.match(check().stderr, /same-build receipt/);
  receipt.release_sha = sha;
  const name = contract.windows.W1[0]; const gate = receipt.gates[name] as Record<string, unknown>;
  gate.status = 'FAIL'; assert.match(check().stderr, /PASS/); gate.status = 'PASS';
  gate.controls = []; assert.match(check().stderr, /positive\/negative controls/); gate.controls = contract.gates[name];
  gate.file = '../outside'; assert.match(check().stderr, /relative file/); gate.file = 'control.txt';
  gate.sha256 = 'c'.repeat(64); assert.match(check().stderr, /evidence digest/);
});


// W2 owns transaction admission/ordering at the executable plan boundary. Old
// refusal coverage cannot prove the new split. Fake transport/database sinks
// retain emitted SQL and derive ledger/checksum state from those INSERTs; no
// product export or test-only plan flag is needed.
const w2Versions = [1, 2, 3, 4, 5].map(i => `2026100300000${i}`);
const w2Tables = ['commonswarm_oauth.interactions', 'swarm.admin_grants', 'swarm.hosted_mcp_grants',
  'commonswarm_oauth.provider_artifacts', 'swarm.users', 'swarm.admin_accounts', 'swarm.admin_consents',
  'swarm.admin_events', 'swarm.admin_credentials', 'commonswarm_oauth.refresh_family_tombstones',
  'supabase_migrations.schema_migrations'];
function w2Fixture() {
  const root = mkdtempSync(join(scratch, 'w2-'));
  const proof = join(root, 'proof'), shims = join(root, 'shims'); mkdirSync(proof); mkdirSync(shims);
  const stage = makeStage();
  // Synthetic probe credentials (contract shape) still obey the secret-window rules.
  writeFileSync(join(stage, 'ordinary-probes.json'), JSON.stringify({
    release_sha: sha, window_id: 'Abc123', workspace_id: '11111111-1111-1111-1111-111111111111', mcp_client_id: 'dcr-probe-client',
    mcp_refresh_token: 'rt-0', mcp_resource: 'https://mcp.commonswarm.com/mcp', human_access_token: 'synthetic-human',
    human_token_exp: Math.floor(Date.now() / 1000) + 3600,
  }), { mode: 0o600 });
  writeFileSync(join(proof, 'oauth-state.json'), JSON.stringify({ current: 'rt-0', access: null, n: 0, revoked: false, calls: {} }));
  writeFileSync(join(proof, 'probe-staged.txt'), '2026-10-04T00:00:00Z\n'); // written by the ai-w2-stage-probes upload
  const migrations = w2Versions.map(version => {
    const filename = readdirSync('supabase/migrations').find(name => name.startsWith(version + '_'))!;
    return { version, file: filename, sha256: digest(readFileSync(join('supabase/migrations', filename))) };
  });
  const old = ['20260928000003', '20261001000001'].map(version => {
    const file = 'supabase/migrations/' + readdirSync('supabase/migrations').find(name => name.startsWith(version + '_'))!;
    return { version, evidence_kind: 'release-record', released_sha: 'c'.repeat(40), file, sha256: digest(readFileSync(file)) };
  });
  writeFileSync(join(proof, 'new-migrations.json'), JSON.stringify(migrations));
  writeFileSync(join(proof, 'backfill.json'), JSON.stringify(old));
  writeFileSync(join(proof, 'db-ledger'), old.map(r => r.version).sort().join('\n') + '\n');
  writeFileSync(join(proof, 'db-checksums'), '');
  // The SQL sink models COMMIT atomicity/response loss, not migration semantics.
  writeFileSync(join(root, 'db.py'), `import os,pathlib,re,sys
p=pathlib.Path(os.environ['PROOF_DIR']); args=' '.join(sys.argv[1:])
if sys.argv[1]=='read':
    if 'SELECT version FROM' in args: print((p/'db-ledger').read_text(),end='')
    elif 'to_regclass' in args: print('t' if '20261003000004' in (p/'db-ledger').read_text() else 'f')
    elif 'SELECT version,sha256' in args: print((p/'db-checksums').read_text(),end='')
    else:
        assert "SET lock_timeout='3s';" in args and "SET statement_timeout='60s';" in args and "SET transaction_timeout='60s';" in args, 'measurement timeout missing'
        table=re.search(r'FROM ([a-z_]+\\.[a-z_]+);',args).group(1)
        print(os.environ.get('OBSERVED_ROWS','1')+'|'+os.environ.get('OBSERVED_BYTES','1024'))
else:
    v=os.environ['VERSION']; sql=(p/('apply-'+v+'.sql')).read_text()
    with (p/'submitted.sql').open('a') as f: f.write(sql)
    if os.environ.get('FAIL_VERSION')==v: sys.exit(1)
    versions=re.findall(r"INSERT INTO supabase_migrations.schema_migrations\\(version\\) VALUES \\('([0-9]+)'\\);",sql)
    ledger=(p/'db-ledger').read_text().splitlines()+versions
    (p/'db-ledger').write_text('\\n'.join(sorted(ledger))+'\\n')
    rows=re.findall(r"INSERT INTO commonswarm_ops.migration_checksums\\(version,sha256,source,released_sha\\) VALUES \\('([^']+)','([^']+)','([^']+)','([^']+)'\\);",sql)
    existing=(p/'db-checksums').read_text().splitlines()+['|'.join(r) for r in rows]
    (p/'db-checksums').write_text('\\n'.join(sorted(existing))+('\\n' if existing else ''))
    if os.environ.get('LOST_COMMIT_VERSION')==v: sys.exit(1)
`);
  // Intercept only HTTP at the external boundary; execute the real probe code.
  // External OAuth/MCP/API boundary: a stateful issuer model (rotation, revocation,
  // invalid_grant) records every call; the plan's real probe code runs unchanged.
  writeFileSync(join(shims, 'sitecustomize.py'), `import io,json,os,pathlib,urllib.error,urllib.parse,urllib.request
P=pathlib.Path(os.environ['PROOF_DIR']); I='https://mcp.commonswarm.com'
def load(): return json.loads((P/'oauth-state.json').read_text())
def save(s): (P/'oauth-state.json').write_text(json.dumps(s))
def count(s,name): s['calls'][name]=s['calls'].get(name,0)+1
class Response:
    def __init__(self,data,status=200): self.data=data; self.status=status
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,n): return json.dumps(self.data).encode()
def refuse(url,status,data): raise urllib.error.HTTPError(url,status,'fixture',{},io.BytesIO(json.dumps(data).encode()))
class Opener:
    def open(self,req,timeout):
        url=req.full_url; point=os.environ.get('VERSION') or 'prefence'
        with open(P/'http-calls','a') as f: f.write(url+'\\n')
        if os.environ.get('FAIL_PROBE_VERSION') and os.environ.get('FAIL_PROBE_VERSION')==os.environ.get('VERSION'): raise OSError('synthetic ingress failure')
        s=load()
        if url==I+'/health': return Response({'ok':True})
        if url.endswith('oauth-authorization-server'):
            return Response({'issuer':I,'token_endpoint':I+'/token'})  # like the live issuer: no revocation_endpoint
        if url.endswith('oauth-protected-resource/mcp'): return Response({'resource':I+'/mcp'})
        if url==I+'/token':
            # oidc-provider 9.12.2 refresh_token grant: rotation consumes; a consumed token is destroyed,
            # its whole grant revoked and invalid_grant returned; any token of a revoked grant is invalid_grant.
            form=dict(urllib.parse.parse_qsl(req.data.decode())); count(s,'refresh')
            phase=(P/'dcr-probe-revoke-attempted.txt').exists()
            count(s,'revoke-step' if phase else 'refresh:'+point); save(s)
            if os.environ.get('TRANSPORT_ON_REFRESH')==str(s['calls']['refresh']): raise urllib.error.URLError('synthetic lost response')
            assert form['grant_type']=='refresh_token' and form['client_id']=='dcr-probe-client' and form['resource']==I+'/mcp'
            t=form['refresh_token']; s.setdefault('consumed',[]); s.setdefault('destroyed',[])
            if s['revoked'] or t in s['destroyed']: refuse(url,400,{'error':'invalid_grant'})
            if t in s['consumed']:
                if os.environ.get('REPLAY_200'):
                    s['n']+=1; s['current']='rt-'+str(s['n']); s['access']='at-'+str(s['n']); save(s)
                    return Response({'token_type':'Bearer','access_token':s['access'],'refresh_token':s['current'],'expires_in':300,'scope':'mcp'})
                if not os.environ.get('REPLAY_NO_REVOKE'): s['destroyed'].append(t); s['revoked']=True
                save(s); refuse(url,400,{'error':'invalid_grant'})
            if t!=s['current'] or (os.environ.get('REFRESH_FAIL_POINT')==point and not phase): refuse(url,400,{'error':'invalid_grant'})
            if os.environ.get('ROTATION_OFF'):
                s['access']='at-same'; save(s)
                return Response({'token_type':'Bearer','access_token':s['access'],'refresh_token':t,'expires_in':300,'scope':'mcp'})
            s['consumed'].append(t)
            s['n']+=1; s['current']='rt-'+str(s['n']); s['access']='at-'+str(s['n']); save(s)
            return Response({'token_type':'Bearer','access_token':s['access'],'refresh_token':s['current'],'expires_in':300,'scope':'mcp'})
        if url==I+'/mcp':
            count(s,'initialize'); save(s)
            if os.environ.get('INIT_TRANSPORT_FAIL_ONCE') and not s.get('init_failed'):
                s['init_failed']=True; save(s); raise urllib.error.URLError('synthetic timeout')
            assert req.get_header('Authorization')=='Bearer '+s['access'], 'stale access token used'
            stored=json.loads((pathlib.Path(os.environ['SECRET_STAGE'])/'ordinary-probes.json').read_text())
            with open(P/'persist-order','a') as f: f.write(('persisted' if stored['mcp_refresh_token']==s['current'] else 'not-persisted')+'\\n')
            return Response({'id':1,'result':{'serverInfo':{'name':'ordinary'}}})
        if url.endswith('/functions/v1/read'):
            assert req.get_header('Authorization')=='Bearer synthetic-human'
            assert json.loads(req.data)['resource']=='pending_access'; return Response({'pending':[]})
        raise AssertionError('unmodelled '+url)
urllib.request.build_opener=lambda *args: Opener()
`);
  // The dispatcher extracts nested blocks from the plan on disk; give it the
  // portable rewrite of the whole plan (only the secret-window regex changes).
  const planCopy = join(root, 'RELEASE.md');
  writeFileSync(planCopy, portable(plan, { stage: 10, pointer: 9 }));
  const released = block('ai-db-session').split('ai_run() {\n')[1]!.split('\nai_deadline() {')[0]!;
  assert.equal(released.split(PRODUCTION_PLAN_PATH).length - 1, 1);
  const dispatcher = released.split(PRODUCTION_PLAN_PATH).join(`'${planCopy}'`);
  const harness = `export VERSION\nai_deadline() { :; }\nai_ro() { python3 '${root}/db.py' read "$@"; }\nai_db() { python3 '${root}/db.py' apply "$@"; }\nai_run() {\n${dispatcher}\n`;
  // ai_run extracts only from plan bytes whose sha256 equals INPUTS plan_sha256.
  const planInputs = join(root, 'plan-inputs.json'); writeFileSync(planInputs, JSON.stringify({ plan_sha256: digest(readFileSync(planCopy)) }));
  const env = { WINDOW: 'W2', PROOF_DIR: proof, SECRET_STAGE: stage, RELEASE_ROOT: resolve('.'), RELEASE_SHA: sha, INPUTS_FILE: planInputs,
    PYTHONPATH: shims, PATH: '/Users/yulanbot/.local/bin:' + process.env.PATH };
  return { proof, stage, env, harness, migrations, old,
    clean: () => removeStage(stage) };
}

test('admin release plan: W2 measures every live lock target; row/size limits refuse and measurements size capped timeouts', () => {
  const f = w2Fixture();
  try {
    const positive = run(f.harness + block('ai-w2-measure'), f.env);
    assert.equal(positive.status, 0, positive.stderr);
    const measured = JSON.parse(readFileSync(join(f.proof, 'lock-measurements.json'), 'utf8'));
    assert.deepEqual(measured.tables.map((t: { table: string }) => t.table), w2Tables);
    const interactions = measured.tables.find((t: { table: string }) => t.table === w2Tables[0]);
    assert.equal(interactions.max_rows, 100000); assert.equal(interactions.max_bytes, 256 * 1024 ** 2);
    const small = measured.budgets.map((b: { timeout_seconds: number }) => b.timeout_seconds);
    for (const l of measured.tables) {
      // Independent admission controls: above EITHER bound refuses, at equality passes.
      const text = block('ai-w2-measure');
      const measuring = text.split('python3 - "$PROOF_DIR" <<\'PY\'')[2]!;
      const validator = measuring.split('\nPY')[0]!;
      const baseline = readFileSync(join(f.proof, 'table-measurements.txt'), 'utf8');
      for (const [rows, bytes, pass] of [[l.max_rows, l.max_bytes, true], [l.max_rows + 1, 1024, false], [1, l.max_bytes + 1, false]] as const) {
        const values = baseline.split('\n').map(line => line.startsWith(l.table + '|') ? `${l.table}|${rows}|${bytes}|0` : line).join('\n');
        writeFileSync(join(f.proof, 'table-measurements.txt'), values);
        const result = spawnSync('python3', ['-c', validator, f.proof], { encoding: 'utf8' });
        assert.equal(result.status === 0, pass, `${l.table}: ${result.stderr}`);
        if (!pass) assert.match(result.stderr, /live table refuse bounds/);
      }
      writeFileSync(join(f.proof, 'table-measurements.txt'), baseline);
    }
    assert.equal(run(f.harness + block('ai-w2-measure'), { ...f.env, OBSERVED_ROWS: '10000', OBSERVED_BYTES: String(16 * 1024 ** 2) }).status, 0);
    const large = JSON.parse(readFileSync(join(f.proof, 'lock-measurements.json'), 'utf8'));
    assert.ok(large.budgets.some((b: { timeout_seconds: number }, i: number) => b.timeout_seconds > small[i]!));
    assert.ok(large.budgets.every((b: { timeout_seconds: number }) => b.timeout_seconds <= 60));
  } finally { f.clean(); }
});

test('admin release plan: W2 commits five independent ledger transactions; M4 backfills all earlier bytes; probes separate commits and rerun refuses', () => {
  const f = w2Fixture();
  try {
    assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
    const result = run(f.harness + block('ai-w2-apply'), f.env);
    assert.equal(result.status, 0, result.stderr);
    for (const [index, version] of w2Versions.entries()) {
      const sql = readFileSync(join(f.proof, `apply-${version}.sql`), 'utf8');
      assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
      assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
      assert.equal((sql.match(/^\\i \/release\/supabase\/migrations\//gm) ?? []).length, 1);
      assert.equal((sql.match(/INSERT INTO supabase_migrations.schema_migrations\(version\)/g) ?? []).length, 1);
      assert.match(sql, /SET LOCAL lock_timeout='3s';/);
      assert.match(sql, /SET LOCAL statement_timeout='(?:[1-5][0-9]|60)s';/);
      assert.match(sql, /SET transaction_timeout='(?:[1-5][0-9]|60)s';\nBEGIN;/);
      assert.match(sql, /unexpected ledger prefix/);
      const measured = JSON.parse(readFileSync(join(f.proof, 'lock-measurements.json'), 'utf8'));
      for (const table of measured.tables.filter((t: { migrations: number[] }) => t.migrations.includes(index + 1))) {
        assert.ok(sql.includes(`(SELECT count(*) FROM ${table.table})>${table.max_rows} OR pg_total_relation_size('${table.table}'::regclass)>${table.max_bytes}`), `${version}: under-lock row/size bound for ${table.table}`);
      }
      const rows = [...sql.matchAll(/INSERT INTO commonswarm_ops.migration_checksums\(version,sha256,source,released_sha\) VALUES \('([^']+)','([^']+)','([^']+)','([^']+)'\);/g)].map(r => r.slice(1));
      const expected = index < 3 ? [] : [[version, f.migrations[index]!.sha256, 'release', sha]];
      if (index === 3) {
        expected.push(...f.old.map(r => [r.version, r.sha256, 'backfill', r.released_sha]));
        expected.push(...f.migrations.slice(0, 3).map(r => [r.version, r.sha256, 'backfill', sha]));
      }
      assert.deepEqual(rows, expected, `${version} checksum source/version/hash/sha contract`);
      assert.ok(sql.indexOf('INSERT INTO supabase_migrations') < sql.indexOf('COMMIT;'));
      if (index >= 3) {
        assert.match(sql, /SET LOCAL ROLE commonswarm_admin_release;/);
        assert.match(sql, /RESET ROLE;\nGRANT commonswarm_admin_release TO supabase_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;\nCOMMIT;/);
      }
      assert.ok(existsSync(join(f.proof, `between-${version}.json`)));
    }
    const prefix = JSON.parse(readFileSync(join(f.proof, 'schema-prefix.json'), 'utf8'));
    assert.deepEqual(prefix.committed, w2Versions); assert.equal(prefix.complete, true);
    assert.ok(existsSync(join(f.proof, 'schema-committed.txt')));
    // Pre-fence + five probes (health, two discoveries, refresh, initialize, human read) + replay revoke (three discoveries, three refreshes).
    assert.equal(readFileSync(join(f.proof, 'http-calls'), 'utf8').trim().split('\n').length, 42);
    assert.ok(existsSync(join(f.proof, 'between-prefence.json')));
    const submitted = readFileSync(join(f.proof, 'submitted.sql'), 'utf8');
    assert.notEqual(run(f.harness + block('ai-w2-apply'), f.env).status, 0);
    assert.equal(readFileSync(join(f.proof, 'submitted.sql'), 'utf8'), submitted, 'rerun reached database');
  } finally { f.clean(); }
});

test('admin release plan: W2 query/probe failures stop before next migration; uncertain COMMIT reconciles the ledger with or without M4', () => {
  const faults: Array<Record<string, string>> = [{ FAIL_VERSION: w2Versions[1]! }, { FAIL_PROBE_VERSION: w2Versions[1]! },
    { LOST_COMMIT_VERSION: w2Versions[1]! }, { LOST_COMMIT_VERSION: w2Versions[3]! }];
  for (const fault of faults) {
    const f = w2Fixture();
    try {
      assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
      const result = run(f.harness + block('ai-w2-apply'), { ...f.env, ...fault });
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(join(f.proof, 'schema-committed.txt')));
      const committed = 'FAIL_VERSION' in fault ? 1 : 'LOST_COMMIT_VERSION' in fault && fault.LOST_COMMIT_VERSION === w2Versions[3] ? 4 : 2;
      const reconcile = run(f.harness + block('ai-w2-reconcile'), f.env);
      assert.notEqual(reconcile.status, 0); assert.match(reconcile.stderr, /incomplete committed prefix reconciled/);
      const prefix = JSON.parse(readFileSync(join(f.proof, 'schema-prefix.json'), 'utf8'));
      assert.deepEqual(prefix.committed, w2Versions.slice(0, committed)); assert.equal(prefix.rerun_allowed, false);
      assert.ok(!existsSync(join(f.proof, `apply-${w2Versions[committed + ('FAIL_VERSION' in fault ? 1 : 0)]}.sql`)));
    } finally { f.clean(); }
  }
});

test('admin release plan: timer guard restores and verifies on success, failure, explicit exit, INT and TERM; failed recovery refuses', () => {
  const root = mkdtempSync(join(scratch, 'timer-guard-'));
  const state = join(root, 'timer-state'), calls = join(root, 'calls');
  writeFileSync(join(root, 'systemctl'), `#!/bin/bash
printf '%s\\n' "$1" >>"$TIMER_CALLS"
case "$1" in
 stop) printf inactive >"$TIMER_STATE";;
 start) test "\${TIMER_RECOVERY_FAIL:-0}" != 1 || exit 1; printf active >"$TIMER_STATE";;
 is-active) test "$(cat "$TIMER_STATE")" = active;;
 *) exit 64;;
esac
`, { mode: 0o700 });
  const session = block('ai-db-session');
  const harness = session.slice(session.indexOf('ai_run() {'), session.indexOf('ai_deadline() {'));
  const execute = (body: string, guard = block('ai-timer-guard'), fail = false) => {
    writeFileSync(state, 'active'); writeFileSync(calls, '');
    return run(harness + guard + '\nsystemctl stop "$EDGE_RECYCLE_TIMER"\n' + body, {
      PATH: root + ':' + process.env.PATH, EDGE_RECYCLE_TIMER: 'fixture.timer',
      TIMER_STATE: state, TIMER_CALLS: calls, TIMER_RECOVERY_FAIL: fail ? '1' : '0',
      RELEASE_ROOT: resolve('.'), SECRET_STAGE: root, INPUTS_FILE: releasedPlanInputs(root),
    });
  };
  for (const [body, status] of [[':', 0], ['false', 1], ['exit 42', 42], ['kill -INT "$$"', 130], ['kill -TERM "$$"', 143]] as const) {
    const result = execute(body);
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(state, 'utf8'), 'active');
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['stop', 'start', 'is-active']);
  }
  const failed = execute(':', undefined, true);
  assert.equal(failed.status, 1); assert.match(failed.stderr, /FAIL timer recovery; window remains open/);
  assert.equal(readFileSync(state, 'utf8'), 'inactive');
  // Remove the real EXIT trap: the same failure must leave the timer inactive.
  const unguarded = block('ai-timer-guard').replace(/^trap .* EXIT\n/m, '');
  assert.notEqual(unguarded, block('ai-timer-guard'));
  const mutation = execute('false', unguarded);
  assert.equal(mutation.status, 1); assert.equal(readFileSync(state, 'utf8'), 'inactive');
});

test('admin release plan: every timer-owning body recovers after stop failure or its first subsequent failure', () => {
  // Exercise the actual stop-to-exit region; preflight paths are covered elsewhere.
  // The only external commands that can run are the fixture systemctl and marked recovery.
  const root = mkdtempSync(join(scratch, 'timer-bodies-'));
  const state = join(root, 'state'), calls = join(root, 'calls');
  writeFileSync(join(root, 'systemctl'), `#!/bin/bash
printf '%s\\n' "$1" >>"$TIMER_CALLS"
case "$1" in
 stop) printf inactive >"$TIMER_STATE"; test "$FAIL_STOP" != 1;;
 start) printf active >"$TIMER_STATE";;
 is-active) test "$(cat "$TIMER_STATE")" = active;;
 show) printf 'active\\n';;
 *) exit 64;;
esac
`, { mode: 0o700 });
  const session = block('ai-db-session');
  const dispatcher = session.slice(session.indexOf('ai_run() {'), session.indexOf('ai_deadline() {'));
  // A failed database call in the real nested rollback stops before touching files/services.
  const harness = 'ai_db() { return 42; }\n' + dispatcher;
  // Every stop owner is known. W4's two use ai-timer-guard (tested here); ai-edge-refresh, ai-w6-activation-apply and
  // ai-w6-finish own their own re-arm traps (tested in tests/admin-release-w6-ready.test.ts).
  const stopOwners = blocks.filter(source => /systemctl stop /.test(source)).map(source => source.split('\n')[0]).sort();
  assert.deepEqual(stopOwners, ['# step: ai-edge-refresh', '# step: ai-w4-apply', '# step: ai-w4-rollback', '# step: ai-w6-activation-apply', '# step: ai-w6-finish'], 'unexpected stop owner');
  const owners = blocks.filter(source => /systemctl stop /.test(source) && /^ai_run ai-timer-guard(?:\n| \|\|)/m.test(source));
  assert.equal(owners.length, 2, 'unexpected unguarded stop owner');
  for (const source of owners) {
    assert.match(source, /^\(\nset -euo pipefail/m, 'guard lifetime must be a subshell');
    const start = source.indexOf('ai_run ai-timer-guard');
    assert.ok(start >= 0 && start < source.indexOf('systemctl stop '), source.split('\n')[0]);
    const body = '(\nset -euo pipefail\n' + source.slice(start);
    for (const failStop of [false, true]) {
      writeFileSync(state, 'active'); writeFileSync(calls, '');
      const result = run(harness + body, {
        PATH: root + ':' + process.env.PATH, EDGE_RECYCLE_TIMER: 'fixture.timer', EDGE_RECYCLE_SERVICE: 'fixture.service',
        TIMER_STATE: state, TIMER_CALLS: calls, FAIL_STOP: failStop ? '1' : '0',
        RELEASE_ROOT: resolve('.'), SECRET_STAGE: root, INPUTS_FILE: releasedPlanInputs(root),
      });
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(readFileSync(state, 'utf8'), 'active', source.split('\n')[0]);
      const trace = readFileSync(calls, 'utf8').trim().split('\n');
      assert.equal(trace[0], 'stop'); assert.deepEqual(trace.slice(-2), ['start', 'is-active']);
      assert.equal(trace.filter(call => call === 'start').length, 1, 'recovery must run once');
    }
  }
  assert.doesNotMatch(block('ai-recycle-rollback'), /systemctl stop /, 'nested rollback cannot own a second stop');
});

test('admin release plan: C1 owner inputs and exact workspace name refuse when absent', () => {
  const input: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_release_sha: 'd'.repeat(40), w2b_window_id: 'Xyz789' };
  input.approval = approval(input, 'activate-admin-issuance-and-smoke');
  const c1 = { release_sha: input.release_sha, window_id: input.window_id, plan_sha256: input.plan_sha256,
    owner_user_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', smoke_workspace_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    verification_version: 1, metadata_digest: hex, target_file: receiptFile, state_directory: scratch,
    smoke_workspace_name: 'C1 exact existing workspace' };
  const c1File = join(scratch, 'c1-inputs.json');
  const check = (c: Input) => {
    writeFileSync(c1File, JSON.stringify(c));
    const body = block('ai-w6-preflight').match(/^python3 - "\$INPUTS_FILE" "\$C1_INPUTS_FILE" <<'PY'\n([\s\S]*?)^PY$/m)![1]!;
    return spawnSync('python3', ['-', inputFile(input), c1File], {input: body, encoding:'utf8'});
  };
  assert.equal(check(c1).status, 0, 'positive C1 input control');
  for (const key of Object.keys(c1)) {
    const missing: Input = { ...c1 }; delete missing[key];
    assert.notEqual(check(missing).status, 0, `missing C1 ${key} accepted`);
  }
  assert.match(check({ ...c1, smoke_workspace_name: '' }).stderr, /exact smoke workspace name/);
});

test('admin release plan: credential material is file/stdin only and generating it emits nothing', () => {
  const source = block('ai-w2-issuer-credential');
  assert.match(source, /openssl rand -hex 32 >"\$SECRET_STAGE\/issuer-password"/);
  assert.match(source, /^ai_db_secret_file "\$SECRET_STAGE\/issuer.sql"/m);
  assert.doesNotMatch(source, /--file -/, 'no SQL on stdin: docker run has no -i');
  assert.match(source, /install -o root -g 986 -m 0440/);
  assert.doesNotMatch(source, /echo\b|set -x|cat "\$SECRET_STAGE\/issuer-password"|--password|PGPASSWORD=/);
  assert.match(block('ai-w2-issuer-rollback'), /NOLOGIN PASSWORD NULL/);
  // Execute the actual secret-producing Python body with synthetic on-box inputs.
  const stage = makeStage();
  assert.match(basename(stage), /^anvil-secret\.[A-Za-z0-9]{6}$/);
  try {
    writeFileSync(join(stage, 'issuer-password'), 'a'.repeat(64)+'\n', { mode: 0o600 });
    writeFileSync(join(stage, 'service.conf'), '[target]\nhost=db.commonswarm.internal\nport=5432\ndbname=postgres\nuser=supabase_admin\n', { mode: 0o600 });
    writeFileSync(join(stage, 'pass'), 'db.commonswarm.internal:5432:postgres:supabase_admin:fixture\n', { mode: 0o600 });
    const python = source.match(/^python3[^\n]*<<'PY'\n([\s\S]*?)^PY$/m)![1]!;
    const result = spawnSync('python3', ['-', stage], { input: python, encoding: 'utf8' });
    assert.ok(result.status===0, 'credential producer failed');
    assert.ok(result.stdout.length===0 && result.stderr.length===0, 'credential producer emitted output');
    const credential = JSON.parse(readFileSync(join(stage, 'issuer.json'), 'utf8'));
    assert.ok(credential.user==='commonswarm_admin_issuer' && credential.password==='a'.repeat(64), 'AS credential contract');
    assert.ok(readFileSync(join(stage, 'issuer.sql'),'utf8').includes("ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD '"), 'password SQL not staged');
  } finally {
    removeStage(stage);
  }
});

test('admin release plan: recycle invalidates before restart, remeasures after and has drop-in rollback', () => {
  const install = block('ai-recycle-install'), hook = block('ai-recycle-hook'), rollback = block('ai-recycle-rollback');
  assert.match(install, /ExecStartPre=\/usr\/local\/libexec\/commonswarm-admin-edge-recycle before/);
  assert.match(install, /ExecStartPost=\/usr\/local\/libexec\/commonswarm-admin-edge-recycle after/);
  assert.match(hook, /invalidated_at=statement_timestamp\(\),release_generation=release_generation\+1/);
  assert.match(hook, /measured_generation=release_generation/);
  assert.match(hook, /tarfile.open\(archive\)/);
  assert.match(hook, /State.*Health/);
  assert.match(rollback, /rm -- "\$RECYCLE_DROPIN"/);
  assert.ok(rollback.indexOf('admin_issuance_enabled=false') < rollback.indexOf('rm -- "$RECYCLE_DROPIN"'), 'close before removing hook');
  assert.match(rollback, /systemctl daemon-reload/);
  assert.match(block('ai-w6-activation-rollback'), /MCP_OAUTH_ADMIN_ISSUANCE_ENABLED/);
  assert.doesNotMatch(block('ai-w6-activation-rollback'), /-f "\$OAUTH_TARGET\/deploy\/mcp-auth\/compose.admin-issuer.yaml"/);
});

// Observable release admission: missing/stale readiness refuses before ai-open can create files.
const readinessRoot = join(scratch, 'w5'); mkdirSync(readinessRoot);
const closeFile = join(readinessRoot, 'closed.txt'), readyFile = join(readinessRoot, 'BROWSER-READY');
const closedAt = new Date(Date.now()-60_000);
writeFileSync(closeFile, closedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')+'\n');
writeFileSync(join(readinessRoot, 'inputs.json'), JSON.stringify({...base(), window:'W5'}));
writeFileSync(join(readinessRoot, 'W5-closed.json'), '{"state":"closed"}');
const readinessEnv = () => ({INPUTS_FILE:inputFile({...base(),window:'W6'}),W5_CLOSED_FILE:closeFile,BROWSER_READY_FILE:readyFile});

test('admin release plan: W6 absent or stale BROWSER-READY refuses before opening; fresh W5-bound marker passes', () => {
  let result=run(block('ai-open'), readinessEnv());
  assert.notEqual(result.status,0); assert.match(result.stderr,/fresh BROWSER-READY required/);
  writeFileSync(readyFile,'nonsecret readiness\n'); utimesSync(readyFile,new Date(0),new Date(0));
  result=run(block('ai-open'),readinessEnv());
  assert.notEqual(result.status,0); assert.match(result.stderr,/newer than W5 close/);
  utimesSync(readyFile,new Date(),new Date());
  result=run(block('ai-w6-readiness'),readinessEnv()); assert.equal(result.status,0,result.stderr);
  writeFileSync(join(readinessRoot,'W5-closed.json'),'{"state":"open"}');
  assert.notEqual(run(block('ai-w6-readiness'),readinessEnv()).status,0);
  writeFileSync(join(readinessRoot,'W5-closed.json'),'{"state":"closed"}');
  const activation=run(`ai_run() { if test "$1" = ai-w6-readiness; then\n${block('ai-w6-readiness')}\nfi; }\n${block('ai-w6-activation-apply')}`, {
    ...readinessEnv(), WINDOW:'W6', INPUTS_FILE: inputFile({...base(),window:'W6',approval:approval({...base(),window:'W6'},'activate-admin-issuance-and-smoke')}), BROWSER_READY_FILE:join(scratch,'absent'),
  });
  assert.notEqual(activation.status,0); assert.match(activation.stderr,/fresh BROWSER-READY required/);
});

test('admin release plan: keep-open defaults false and requires its own exact activation/window approval', () => {
  const input: Input={...base(),window:'W6',rollback_decision:'close-and-reconcile',w2b_release_sha:'d'.repeat(40),w2b_window_id:'Xyz789'};
  input.approval=approval(input,'activate-admin-issuance-and-smoke');
  assert.equal(validate(input).status,0);
  assert.notEqual(validate({...input,keep_open:true}).status,0);
  assert.notEqual(validate({...input,keep_open:'true'}).status,0);
  assert.equal(validate({...input,keep_open:true,keep_open_approval:approval(input,'keep-admin-issuance-open')}).status,0);
  assert.notEqual(validate({...input,keep_open:true,keep_open_approval:approval(input,'activate-admin-issuance-and-smoke')}).status,0);
});

test('admin release plan: W6 default runs deactivation and proves CLOSED; explicit keep-open proves OPEN', () => {
  const proof=join(scratch,'finish'); mkdirSync(proof); writeFileSync(join(proof,'C1-fence.txt'),'PASS'); writeFileSync(join(proof,'client-withdraw.json'),JSON.stringify({status:'PASS',withdrawn_at:'2026-10-03T12:02:00Z'})); writeFileSync(join(proof,'agent-final.json'),JSON.stringify({ok:true,refused_after_fence:{http_status:403,refusal_code:'grant_revoked'}}));
  // Fake ingress is the external boundary; its body follows the deactivation operation.
  const shim=join(scratch,'shims'); mkdirSync(shim);
  const pythonPath=spawnSync('which',['python3'],{encoding:'utf8'}).stdout.trim();
  writeFileSync(join(shim,'python3'),`#!/bin/bash\nif test "$#" = 1 && test "$1" = -; then\n exec '${pythonPath}' -c 'import sys,types; m=types.ModuleType("urllib.request"); R=type("R",(),{"__enter__":lambda s:s,"__exit__":lambda *a:None,"read":lambda s,n:b"{\\"state\\":\\"closed\\"}" if s.method=="GET" else b"","status":200,"headers":{"Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}}); m.Request=lambda url,method,headers:method; m.urlopen=lambda method,timeout:type("Response",(R,),{"method":method})(); import urllib; urllib.request=m; sys.modules["urllib.request"]=m; exec(sys.stdin.read())'\nelse\n exec '${pythonPath}' "$@"\nfi\n`,{mode:0o700});
  const calls=join(proof,'calls'), timer=join(proof,'timer');
  // Fixture systemctl: the recycle timer W6 holds since apply (inactive at finish start).
  writeFileSync(join(shim,'systemctl'),`#!/bin/bash\nprintf 'systemctl %s\\n' "$1" >>"$PROOF_DIR/calls"\ncase "$1" in stop) printf inactive >"$TIMER";; start) printf active >"$TIMER";; is-active) test "$(cat "$TIMER")" = active;; *) exit 64;; esac\n`,{mode:0o700});
  const harness=`ai_run() { case "$1" in ai-inputs) :;; ai-w6-activation-rollback) printf '%s\\n' "$1" >>"$PROOF_DIR/calls"; systemctl start; printf active >"$TIMER";;
 ai-w6-activation-probes) printf '%s\\n' "$1" >>"$PROOF_DIR/calls";; ai-w6-closed-gate-probe) printf '%s\\n' "$1" >>"$PROOF_DIR/calls"; eval "$CLOSED_PROBE";; ai-edge-remeasure) printf 'ai-edge-remeasure %s\\n' "$(cat "$TIMER")" >>"$PROOF_DIR/calls"; printf '{}\\n' >"$EDGE_MEASUREMENT_OUT";; *) return 1;; esac; }
ai_ro() { printf 't\\n'; }\n`;
  const finish=(keep:boolean|undefined,after='')=>{ writeFileSync(timer,'inactive'); writeFileSync(calls,''); rmSync(join(proof,'edge-measurement-final.json'),{force:true});
    return run(harness+block('ai-w6-finish')+after,{WINDOW:'W6',PROOF_DIR:proof,TIMER:timer,EDGE_RECYCLE_TIMER:'fixture.timer',CLOSED_PROBE:block('ai-w6-closed-gate-probe'),INPUTS_FILE:inputFile({...base(),...(keep===undefined?{}:{keep_open:keep})}),PATH:shim+':'+process.env.PATH}); };
  // ai-close's timer line runs next IN THE SAME SHELL (ai_run is eval): the finish's own subshell re-armed it already.
  const closeLine=block('ai-close').split('\n').find(l=>l.startsWith('systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" ||'))!;
  assert.ok(closeLine); const sameShellClose=`\n${closeLine}\nprintf 'close-timer-ok\\n'\n`;
  const trace=()=>readFileSync(calls,'utf8').trim().split('\n');
  let result=finish(undefined,sameShellClose); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/close-timer-ok/);
  assert.deepEqual(JSON.parse(readFileSync(join(proof,'C1-finish.json'),'utf8')),{state:'closed',explicit_keep_open:false});
  // Default: rollback (re-arms), stop again, remeasure the closed state with the timer held, then re-arm on exit.
  assert.deepEqual(trace().filter(l=>!l.startsWith('systemctl is-active')),['ai-w6-activation-rollback','systemctl start','systemctl stop','ai-edge-remeasure inactive','ai-w6-closed-gate-probe','systemctl start']);
  assert.equal(readFileSync(timer,'utf8'),'active'); assert.ok(existsSync(join(proof,'edge-measurement-final.json')));
  result=finish(true,sameShellClose); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/close-timer-ok/);
  assert.deepEqual(JSON.parse(readFileSync(join(proof,'C1-finish.json'),'utf8')),{state:'open',explicit_keep_open:true});
  // Keep open: remeasure with the timer still held (reopens only through the measured path), probe OPEN, re-arm on exit.
  assert.deepEqual(trace().filter(l=>!l.startsWith('systemctl is-active')),['ai-edge-remeasure inactive','ai-w6-activation-probes','systemctl start']);
  assert.equal(readFileSync(timer,'utf8'),'active');
  // Control: the same block WITHOUT its own subshell (the 04d09c3d form) leaves the timer stopped for the close.
  const body=block('ai-w6-finish'), open=body.indexOf('\n(\n');
  assert.ok(open>0 && body.trimEnd().endsWith('\n)'));
  const unwrapped=body.slice(0,open)+'\n'+body.slice(open+'\n(\n'.length,body.trimEnd().length-1);
  writeFileSync(timer,'inactive'); writeFileSync(calls,''); rmSync(join(proof,'edge-measurement-final.json'),{force:true});
  const old=run(harness+`set +e\n( eval "$UNWRAPPED"\n${closeLine}\nprintf 'close-timer-ok\\n' )`,{WINDOW:'W6',PROOF_DIR:proof,TIMER:timer,EDGE_RECYCLE_TIMER:'fixture.timer',UNWRAPPED:unwrapped,CLOSED_PROBE:block('ai-w6-closed-gate-probe'),INPUTS_FILE:inputFile({...base(),keep_open:true}),PATH:shim+':'+process.env.PATH});
  assert.notEqual(old.status,0); assert.doesNotMatch(old.stdout,/close-timer-ok/); assert.match(old.stderr,/FAIL ai-close: recycle timer expected active got inactive/);
  // Former `A && B` guard: each receipt now refuses on its own line before any probe.
  for(const file of ['C1-fence.txt','client-withdraw.json']) {
    const saved=readFileSync(join(proof,file)); rmSync(join(proof,file)); if(existsSync(join(proof,'C1-finish.json'))) rmSync(join(proof,'C1-finish.json'));
    result=finish(undefined); assert.notEqual(result.status,0);
    assert.match(result.stderr,new RegExp(`FAIL ai-w6-finish: ${file.replace('.','\\.')} expected present got missing; STOP`));
    // A failed finish still re-arms the held timer (HezLead ruling); nothing else ran.
    assert.deepEqual(trace().filter(l=>!l.startsWith('systemctl is-active')),['systemctl start']); assert.equal(readFileSync(timer,'utf8'),'active');
    assert.ok(!existsSync(join(proof,'C1-finish.json')));
    writeFileSync(join(proof,file),saved);
  }
});

test('admin release plan: D8 pointer emits only paths, consent choices and UTC expiry; secret-shaped name refuses', () => {
  // Never the real Mac pointer: the fixture pointer is under this file's scratch.
  const pointer=fixturePointer, source=portable(block('ai-w6-pointer'),{stage:1,pointer:2});
  assert.ok(!existsSync(pointer),'refuse to touch an existing smoke pointer'); assert.ok(outsideHome(pointer));
  const stage=makeStage();
  const c1=join(scratch,'pointer-input.json');
  const removePointer=()=>{ assert.equal(lstatSync(pointer).isFile(),true); assert.equal(dirname(pointer),pointerDir); rmSync(pointer); };
  try {
    writeFileSync(c1,JSON.stringify({smoke_workspace_name:'C1 exact workspace'}));
    // Controls: the rewritten window and pointer checks still execute.
    const other=mkdtempSync(join(secretRoot,'other-secret.'));
    try {
      const wrongStage=run(source,{C1_SECRET_STAGE:other,C1_POINTER:pointer,C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
      assert.notEqual(wrongStage.status,0,'stage outside the anvil-secret window accepted'); assert.ok(!existsSync(pointer));
    } finally { assert.equal(dirname(other),secretRoot); rmSync(other,{recursive:true}); }
    const wrongPointer=run(source,{C1_SECRET_STAGE:stage,C1_POINTER:join(pointerDir,'other.pointer'),C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
    assert.notEqual(wrongPointer.status,0,'non-pinned pointer path accepted'); assert.ok(!existsSync(join(pointerDir,'other.pointer')));
    rmSync(join(stage,'request-plan.json'),{force:true});
    const result=run(source,{C1_SECRET_STAGE:stage,C1_POINTER:pointer,C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
    assert.equal(result.status,0,result.stderr);
    assert.equal(statSync(pointer).mode & 0o777,0o600);
    const r=JSON.parse(readFileSync(pointer,'utf8'));
    assert.deepEqual(Object.keys(r).sort(),['authorize_url_file','callback_file','consent_choices','expires_at']);
    assert.equal(r.authorize_url_file,join(stage,'authorize.url')); assert.equal(r.callback_file,join(stage,'callback.url'));
    assert.equal(r.consent_choices.workspace_name,'C1 exact workspace'); assert.equal(r.consent_choices.home,false); assert.equal(r.consent_choices.full_account,true);
    const canonical=JSON.parse(spawnSync('node',['scripts/admin-smoke.mjs','--dry-run'],{encoding:'utf8'}).stdout);
    assert.deepEqual(r.consent_choices.scopes,canonical.scope.split(' ').filter((s:string)=>!['openid','offline_access'].includes(s)));
    assert.doesNotMatch(JSON.stringify(r),/https?:|eyJ|access_token|refresh_token|code_verifier|Bearer/);
    const pointerBytes=readFileSync(pointer);
    const stale=run(source,{C1_SECRET_STAGE:stage,C1_POINTER:pointer,C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
    assert.notEqual(stale.status,0);
    assert.ok(stale.stderr.includes("FAIL ai-w6-pointer: smoke pointer expected absent got present; an earlier W6 left it: run ai-w6-secret-close with that window's C1_PROOF_DIR, then retry; STOP"),stale.stderr);
    assert.deepEqual(readFileSync(pointer),pointerBytes,'a stale pointer is retained for its window cleanup');
    removePointer();
    symlinkSync(join(pointerDir,'missing-pointer-target'),pointer);
    const dangling=run(source,{C1_SECRET_STAGE:stage,C1_POINTER:pointer,C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
    assert.notEqual(dangling.status,0); assert.match(dangling.stderr,/FAIL ai-w6-pointer: smoke pointer expected absent got present;/);
    assert.ok(lstatSync(pointer).isSymbolicLink()); rmSync(pointer);
    writeFileSync(c1,JSON.stringify({smoke_workspace_name:'Bearer synthetic-secret-shaped-fixture'}));
    const refused=run(source,{C1_SECRET_STAGE:stage,C1_POINTER:pointer,C1_INPUTS_FILE:c1,INPUTS_FILE:inputFile(base())});
    assert.notEqual(refused.status,0); assert.match(refused.stderr,/secret-shaped pointer/); assert.ok(!existsSync(pointer));
  } finally {
    if(existsSync(pointer)) removePointer();
    removeStage(stage);
  }
});

test('admin release plan: C1 report requires ordered approval/withdrawal/revoke timestamps and actual refused call', () => {
  const report=(changes: Record<string,unknown>={})=> {
    const root=mkdtempSync(join(scratch,'report-'));
    const files:Record<string,unknown>={
      'agent.json':{ok:true,refused_after_fence:{http_status:403,refusal_code:'grant_revoked'},workspace:{accepted_residue:true,name:'c1-smoke-fixture (test, archive me)'}},
      'C1-audit.json':{audit_counts:{init:1,list:1,read:1,action:1}},
      'human-revoke.json':{state:'revoked',revoked_at:'2026-10-03T12:02:00Z'},
      'client-approve.json':{approval_at:'2026-10-03T12:01:00Z'},
      'client-withdraw.json':{status:'PASS',withdrawn_at:'2026-10-03T12:03:00Z'},
      'C1-finish.json':{state:'closed',explicit_keep_open:false}, ...changes,
    };
    for(const [name,value] of Object.entries(files)) writeFileSync(join(root,name),JSON.stringify(value));
    writeFileSync(join(root,'C1-cleanup.txt'),'PASS'); writeFileSync(join(root,'C1-fence.txt'),'PASS');
    const result=run(block('ai-w6-report'),{C1_PROOF_DIR:root,INPUTS_FILE:inputFile(base())});
    return {result,root};
  };
  const good=report(); assert.equal(good.result.status,0,good.result.stderr);
  const receipt=JSON.parse(readFileSync(join(good.root,'C1.json'),'utf8'));
  assert.equal(receipt.approval_scope,'account-wide owner/client/version');
  // F3 order: the human revoke fences the grant first; the approval withdrawal follows it.
  assert.equal(receipt.approval_at,'2026-10-03T12:01:00Z'); assert.equal(receipt.revoked_at,'2026-10-03T12:02:00Z'); assert.equal(receipt.withdrawn_at,'2026-10-03T12:03:00Z');
  assert.deepEqual(receipt.refused_follow_up,{http_status:403,refusal_code:'grant_revoked'}); assert.equal(receipt.final_gate,'closed');
  for(const changes of [
    {'client-approve.json':{}}, {'client-withdraw.json':{status:'PASS'}}, {'human-revoke.json':{state:'revoked'}},
    {'client-withdraw.json':{status:'PASS',withdrawn_at:'2026-10-03T12:01:30Z'}},
    {'human-revoke.json':{state:'revoked',revoked_at:'2026-10-03T12:00:30Z'}},
    {'agent.json':{ok:true,refused_after_fence:{http_status:200,refusal_code:'grant_revoked'},workspace:{accepted_residue:true}}},
    {'C1-finish.json':{state:'open',explicit_keep_open:true}},
  ]) { const bad=report(changes); assert.notEqual(bad.result.status,0); assert.ok(!existsSync(join(bad.root,'C1.json'))); }
});

test('admin release plan: W1-W5 need no activation or consent approval; W4 binds the terminal fence', () => {
  for(const window of ['W1','W2','W3','W4','W5']) {
    const input:Input={...base(),window,rollback_decision:['W1','W2'].includes(window)?'retain-additive':'restore-service'};
    if(window==='W4') input.legacy_fence_approval=approval(input,'terminal-legacy-db-fence');
    if(window==='W2') {
      // W2 alone names the probe workspace; it is required there and refused elsewhere.
      assert.notEqual(validate(input).status,0,'W2 without probe_workspace_id');
      assert.notEqual(validate({...input,probe_workspace_id:'not-a-uuid'}).status,0);
      input.probe_workspace_id='c2ea0541-f56d-4c73-bf71-56c5405c4934';
    } else assert.notEqual(validate({...input,probe_workspace_id:'c2ea0541-f56d-4c73-bf71-56c5405c4934'}).status,0,`${window} refuses probe_workspace_id`);
    assert.equal(validate(input).status,0,`${window} closed preparation inputs`);
    assert.notEqual(validate({...input,approval:approval(input,'activate-admin-issuance-and-smoke')}).status,0);
  }
});

test('admin release plan: W6 close requires cleanup only after Mac start, rejects symlinks, and removes its private window', () => {
  const stage=makeStage(), proof=join(scratch,'close'), close=portable(block('ai-close'),{stage:2,pointer:0}); mkdirSync(proof);
  // Valid retained receipts: ai-close re-runs ai-live-controls on them, producer from the verified archive.
  const producerFile=join(scratch,'close-producer.mjs'), archive=join(scratch,'close-release.tar');
  writeFileSync(producerFile,'export const closeFixture = "live-ordinary-controls";\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producerFile],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const producerSha=digest(readFileSync(producerFile)), archiveSha=digest(readFileSync(archive));
  const controls={hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true};
  const consentFor=(phase:string)=>JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:phase,measured_at:new Date(Date.now()-60_000).toISOString(),
    producer_sha256:producerSha,controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['dcr-close-own'],
    cleanup:phase==='pre-W1'?null:{grants_revoked:true,dcr_clients_expiring:[{client_id:'dcr-close-earlier',expires_after:new Date(Date.now()+30*86400_000).toISOString()}]}});
  const liveFor=(window:string,phase:string,consentText:string)=>JSON.stringify({release_sha:sha,window_id:'Abc123',window,phase,controls,
    consent_receipt_sha256:digest(consentText),producer_sha256:producerSha,dcr_client_ids:['dcr-close-window']});
  const post=consentFor('post-W5');
  writeFileSync(join(proof,'consent-post-W5.json'),post);
  writeFileSync(join(proof,'ordinary-after.json'),liveFor('W6','after',post)); writeFileSync(join(proof,'ordinary-recovery.json'),liveFor('W6','recovery',post));
  for(const file of ['C1.json','C1-cleanup.txt','C1-finish.json']) writeFileSync(join(proof,file),'{}');
  const w6Inputs=join(scratch,'close-inputs-W6.json'); writeFileSync(w6Inputs,JSON.stringify({...base(),window:'W6',archive_sha256:archiveSha}));
  writeFileSync(join(proof,'secret-stage.path'),stage+'\n');
  const closeState=(started:boolean)=>JSON.stringify({release_sha:sha,window_id:'Abc123',plan_sha256:digest(plan),started});
  writeFileSync(join(proof,'C1-close-state.json'),closeState(true));
  const shim=join(scratch,'close-shims'); mkdirSync(shim);
  writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  try {
    // Read-only database boundary starts CLOSED: opening-state checks must fail.
    const harness=`ai_ro() { case "$*" in *'SELECT NOT admin_issuance_enabled'*) printf 't\\n';; *) printf 'f\\n';; esac; }\n`;
    const env={WINDOW:'W6',SECRET_STAGE:stage,PROOF_DIR:proof,EDGE_RECYCLE_TIMER:'fixture.timer',INPUTS_FILE:w6Inputs,PLAN_FILE:planPath,BOX_ARCHIVE_PATH:archive,PATH:shim+':/Users/yulanbot/.local/bin:'+process.env.PATH};
    writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 1\n',{mode:0o700});
    for(const outcome of ['success','recovered']) {
      const refused=run(harness+close,{...env,CLOSE_RESULT:outcome});
      assert.notEqual(refused.status,0,`inactive timer allowed ${outcome} W6 close`);
      assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    }
    writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    // The W6 close requires the retained post-W5 consent receipt copy.
    rmSync(join(proof,'consent-post-W5.json'));
    const unbound=run(harness+close,{...env,CLOSE_RESULT:'success'});
    assert.notEqual(unbound.status,0); assert.match(unbound.stderr,/FAIL ai-close: retained consent receipt expected consent-post-W5\.json got missing; STOP/);
    assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    writeFileSync(join(proof,'consent-post-W5.json'),post);
    // Finding 1: the retained close pair is re-validated in full, never only for presence.
    for(const [bytes,inner] of [
      ['{}','FAIL ai-live-controls: live receipt keys expected exact-schema-set got other-set; STOP'],
      [liveFor('W6','before',post),'FAIL ai-live-controls: live phase expected after got before; STOP'],
      [liveFor('W7','after',post),'FAIL ai-live-controls: live window expected input-window got mismatch; STOP'],
      [liveFor('W6','after',consentFor('post-W5')+' '),'FAIL ai-live-controls: live consent_receipt_sha256 expected sha256-of-CONSENT_RECEIPT_FILE got mismatch; STOP'],
    ] as const) {
      writeFileSync(join(proof,'ordinary-after.json'),bytes);
      const invalid=run(harness+close,{...env,CLOSE_RESULT:'success'});
      assert.notEqual(invalid.status,0); assert.ok(invalid.stderr.includes(inner),invalid.stderr);
      assert.match(invalid.stderr,/FAIL ai-close: retained close receipts expected valid got refused; STOP/);
      assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    }
    writeFileSync(join(proof,'ordinary-after.json'),liveFor('W6','after',post));
    // The producer is re-derived from the verified archive at close: replaced archive bytes refuse.
    { const saved=readFileSync(archive); writeFileSync(archive,'not the verified archive');
      const swapped=run(harness+close,{...env,CLOSE_RESULT:'success'});
      assert.notEqual(swapped.status,0); assert.match(swapped.stderr,/FAIL ai-live-controls: BOX_ARCHIVE_PATH bytes expected input-archive_sha256 got mismatch; STOP/);
      assert.ok(!existsSync(join(proof,'closed.txt'))); writeFileSync(archive,saved); }
    // Former `A && B` case-arm guards: each forward-close receipt refuses on its own.
    rmSync(join(proof,'C1-cleanup.txt'));
    const noCleanup=run(harness+close,{...env,CLOSE_RESULT:'success'});
    assert.notEqual(noCleanup.status,0); assert.match(noCleanup.stderr,/FAIL ai-close: W6 C1-cleanup\.txt expected present got missing; STOP/);
    assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    writeFileSync(join(proof,'C1-client-check.txt'),'PASS');
    const recoveryWithoutCleanup=run(harness+close,{...env,CLOSE_RESULT:'recovered'});
    assert.notEqual(recoveryWithoutCleanup.status,0);
    assert.ok(recoveryWithoutCleanup.stderr.includes('FAIL ai-close: recovered W6 C1-cleanup.txt expected regular-non-symlink after secret-stage.path in C1_PROOF_DIR got missing-or-other; run ai-w6-secret-close with C1_PROOF_DIR from this window and upload C1-cleanup.txt, then retry; STOP'),recoveryWithoutCleanup.stderr);
    assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    writeFileSync(join(proof,'C1-cleanup.txt'),'{}');
    for(const file of ['C1-client-check.txt','C1-cleanup.txt','C1-close-state.json','C1.json','C1-finish.json']) for(const dangling of [false,true]) {
      const saved=readFileSync(join(proof,file)); rmSync(join(proof,file));
      const target=join(scratch,`close-link-${file}`); if(!dangling) writeFileSync(target,saved);
      else if(existsSync(target)) rmSync(target);
      symlinkSync(target,join(proof,file));
      const linked=run(harness+close,{...env,CLOSE_RESULT:'recovered'});
      assert.notEqual(linked.status,0); assert.ok(linked.stderr.includes(`FAIL ai-close: recovered W6 ${file} expected regular-non-symlink got other; STOP`),linked.stderr);
      assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
      rmSync(join(proof,file)); writeFileSync(join(proof,file),saved);
    }
    // W2 arm: its own valid W2 after pair (pre-W1 consent) in a separate proof directory.
    const proof2=join(scratch,'close-w2'); mkdirSync(proof2); const pre=consentFor('pre-W1');
    writeFileSync(join(proof2,'consent-pre-W1.json'),pre); writeFileSync(join(proof2,'ordinary-after.json'),liveFor('W2','after',pre));
    writeFileSync(join(proof2,'schema-committed.txt'),'PASS'); writeFileSync(join(proof2,'issuer-credential.txt'),'PASS');
    const w2Inputs=join(scratch,'close-inputs-W2.json'); writeFileSync(w2Inputs,JSON.stringify({...base(),window:'W2',archive_sha256:archiveSha}));
    const w2=run(harness+close,{...env,WINDOW:'W2',PROOF_DIR:proof2,INPUTS_FILE:w2Inputs,CLOSE_RESULT:'success'});
    assert.notEqual(w2.status,0); assert.match(w2.stderr,/FAIL ai-close: W2 W2-probes\.txt expected present got missing; STOP/);
    assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    // A guarded rm that reports success but leaves the stage must not close the window.
    const fakeRm=join(scratch,'close-fake-rm'); mkdirSync(fakeRm); writeFileSync(join(fakeRm,'rm'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    const kept=run(harness+close,{...env,CLOSE_RESULT:'success',PATH:shim+':'+fakeRm+':'+process.env.PATH});
    assert.notEqual(kept.status,0); assert.match(kept.stderr,/FAIL ai-close: removed SECRET_STAGE expected absent got present; STOP/);
    assert.ok(existsSync(stage)); assert.ok(!existsSync(join(proof,'closed.txt')));
    const result=run(harness+close,{...env,CLOSE_RESULT:'success'});
    assert.equal(result.status,0,result.stderr); assert.ok(existsSync(join(proof,'closed.txt'))); assert.ok(!existsSync(stage));
    for(const started of [false,true]) {
      const recoveryStage=makeStage(), recoveryProof=mkdtempSync(join(scratch,'close-recovered-w6-'));
      try {
        for(const file of readdirSync(proof)) {
          if(['closed.txt','close-result.json','secret-stage.path','C1-client-check.txt','C1-cleanup.txt','C1-close-state.json','C1-no-start.txt'].includes(file)) continue;
          writeFileSync(join(recoveryProof,file),readFileSync(join(proof,file)));
        }
        writeFileSync(join(recoveryProof,'secret-stage.path'),recoveryStage+'\n');
        writeFileSync(join(recoveryProof,'C1-close-state.json'),closeState(started));
        writeFileSync(join(recoveryProof,'C1-client-check.txt'),'PASS');
        if(started) writeFileSync(join(recoveryProof,'C1-cleanup.txt'),'PASS');
        const recovered=run(harness+close,{...env,SECRET_STAGE:recoveryStage,PROOF_DIR:recoveryProof,CLOSE_RESULT:'recovered'});
        assert.equal(recovered.status,0,recovered.stderr); assert.ok(existsSync(join(recoveryProof,'closed.txt'))); assert.ok(!existsSync(recoveryStage));
        assert.equal(existsSync(join(recoveryProof,'C1-no-start.txt')),!started);
      } finally { if(existsSync(recoveryStage)) removeStage(recoveryStage); }
    }
  } finally {
    if(existsSync(stage)) removeStage(stage);
  }
});


test('admin release plan: W2b close needs its backup gate, preconditions and issuer credential, or a recovered state without issuer login', () => {
  const root=mkdtempSync(join(scratch,'w2b-close-'));
  const producerFile=join(root,'producer.mjs'), archive=join(root,'release.tar');
  writeFileSync(producerFile,'export const closeFixture = "live-ordinary-controls";\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producerFile],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const producerSha=digest(readFileSync(producerFile)), archiveSha=digest(readFileSync(archive));
  const controls={hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true};
  const pre=JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:'pre-W1',measured_at:new Date(Date.now()-60_000).toISOString(),
    producer_sha256:producerSha,controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['dcr-close-own'],cleanup:null});
  const liveFor=(phase:string,window='W2b')=>JSON.stringify({release_sha:sha,window_id:'Abc123',window,phase,controls,
    consent_receipt_sha256:digest(pre),producer_sha256:producerSha,dcr_client_ids:['dcr-close-window']});
  const inputs=join(root,'inputs.json'), w4Inputs=join(root,'inputs-w4.json');
  writeFileSync(w4Inputs,JSON.stringify({...base(),window:'W4',rollback_decision:'restore-service',archive_sha256:archiveSha}));
  writeFileSync(inputs,JSON.stringify({...base(),window:'W2b',archive_sha256:archiveSha,w2_release_sha:'e'.repeat(40),w2_window_id:'RGLqZX'}));
  const shim=join(root,'shims'); mkdirSync(shim); writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  // Filesystem boundary remap only: the box credential path moves into this test's directory.
  const etc=join(root,'etc'); mkdirSync(etc);
  const close=portable(block('ai-close'),{stage:2,pointer:0}).split('/etc/commonswarm-oauth/').join(etc+'/');
  const gateFile=join(root,'gate-check.sh'); writeFileSync(gateFile,block('ai-backup-gate-check'));
  const harness=(role:string)=>`ai_ro() { case "$*" in *'SELECT NOT admin_issuance_enabled'*) printf 't\\n';; *'FROM pg_catalog.pg_authid'*) printf '${role}\\n';; *) printf 'f\\n';; esac; }\n`
    +`ai_run() { test "$1" = ai-backup-gate-check || return 1; eval "$(cat '${gateFile}')"; }\n`;
  const stamp=(ms:number)=>new Date(Date.now()-ms).toISOString().replace(/\.\d{3}Z$/,'Z');
  // backup-gate.json exactly as ai-w1-backup-gate writes it, bound to the window's inputs.json.
  const gateReceipt=(window:string,change:Record<string,unknown>={})=>{
    const receipt:Record<string,unknown>={status:'PASS',release_sha:sha,window,window_id:'Abc123',backup_verified_at:stamp(600_000),restore_completed_at:stamp(86400_000),
      destination:'r2:yulan-vps-1-backups/000-commonswarm-postgres/fixture',gate_at:stamp(60_000),...change};
    return '{'+Object.keys(receipt).sort().map(k=>JSON.stringify(k)+': '+JSON.stringify(receipt[k])).join(', ')+'}\n';
  };
  const FORWARD='PASS W2b forward catalogs: all five true after the issuer credential\n';
  const attempt=(outcome:string,files:string[],role='t',window='W2b',gate?:string)=>{
    const stage=makeStage(), proof=mkdtempSync(join(root,'proof-'));
    writeFileSync(join(proof,'secret-stage.path'),stage+'\n'); writeFileSync(join(proof,'consent-pre-W1.json'),pre);
    writeFileSync(join(proof,'ordinary-after.json'),liveFor('after',window)); writeFileSync(join(proof,'ordinary-recovery.json'),liveFor('recovery',window));
    writeFileSync(join(proof,'inputs.json'),readFileSync(window==='W4'?w4Inputs:inputs)); writeFileSync(join(proof,'open.txt'),stamp(300_000)+'\n');
    for(const file of files) writeFileSync(join(proof,file),file==='backup-gate.json'?(gate??gateReceipt(window)):file==='w2b-forward-catalogs.txt'?FORWARD:'PASS');
    const result=run(harness(role)+close,{WINDOW:window,SECRET_STAGE:stage,PROOF_DIR:proof,EDGE_RECYCLE_TIMER:'fixture.timer',INPUTS_FILE:window==='W4'?w4Inputs:inputs,PLAN_FILE:planPath,
      BOX_ARCHIVE_PATH:archive,CLOSE_RESULT:outcome,PATH:shim+':'+process.env.PATH});
    const closed=existsSync(join(proof,'closed.txt'));
    const record=existsSync(join(proof,'close-result.json'))?readFileSync(join(proof,'close-result.json'),'utf8'):'';
    const closedAt=closed?readFileSync(join(proof,'closed.txt'),'utf8').trim():'';
    if(existsSync(stage)) removeStage(stage);
    return {result,closed,record,closedAt};
  };
  const W2B_OK=['backup-gate.json','w2b-forward-catalogs.txt','w2b-preconditions.txt','issuer-credential.txt'];
  let r=attempt('success',W2B_OK); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  // The explicit terminal record W6 reads: exact sorted JSON bound to the window, at the closed.txt time.
  assert.deepEqual(JSON.parse(r.record),{closed_at:r.closedAt,release_sha:sha,result:'success',window:'W2b',window_id:'Abc123'});
  assert.equal(r.record,'{'+Object.entries({closed_at:r.closedAt,release_sha:sha,result:'success',window:'W2b',window_id:'Abc123'}).map(([k,v])=>JSON.stringify(k)+': '+JSON.stringify(v)).join(', ')+'}\n');
  // Backup admission validates the receipt, not its presence: missing, not JSON, stale, other window or release STOP.
  for(const [name,files,gate] of [['missing',W2B_OK.slice(1),undefined],['not JSON',W2B_OK,'PASS'],['PASS object only',W2B_OK,'{"status": "PASS"}\n'],
    ['stale backup at gate',W2B_OK,gateReceipt('W2b',{backup_verified_at:stamp(3600_000)})],['old restore drill',W2B_OK,gateReceipt('W2b',{restore_completed_at:stamp(9*86400_000)})],
    ['other window',W2B_OK,gateReceipt('W4')],['other release',W2B_OK,gateReceipt('W2b',{release_sha:'f'.repeat(40)})],['other window id',W2B_OK,gateReceipt('W2b',{window_id:'Other1'})],
    ['gate before open',W2B_OK,gateReceipt('W2b',{gate_at:stamp(900_000),backup_verified_at:stamp(1000_000)})],['wrong destination',W2B_OK,gateReceipt('W2b',{destination:'r2:other/x'})]] as const) {
    r=attempt('success',[...files],'t','W2b',gate); assert.notEqual(r.result.status,0,name); assert.ok(!r.closed,name);
    assert.match(r.result.stderr,/FAIL ai-close: W2b: backup-gate\.json expected valid-bound-fresh-receipt got refused; STOP/,name);
  }
  // The post-credential forward catalogs proof is required with its exact line.
  r=attempt('success',['backup-gate.json','w2b-preconditions.txt','issuer-credential.txt']); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W2b w2b-forward-catalogs\.txt expected exact-PASS-line got missing-or-other; STOP/);
  r=attempt('success',['backup-gate.json','w2b-forward-catalogs.txt','w2b-preconditions.txt']); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W2b issuer-credential\.txt expected present got missing; STOP/);
  r=attempt('success',['backup-gate.json','w2b-forward-catalogs.txt','issuer-credential.txt']); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W2b w2b-preconditions\.txt expected present got missing; STOP/);
  r=attempt('recovered',[]); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  r=attempt('recovered',[],'f'); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: recovered W2b issuer role expected NOLOGIN-without-password got other; STOP/);
  writeFileSync(join(etc,'admin-issuer-database-credentials'),'{}');
  r=attempt('recovered',[]); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: recovered W2b credential file expected absent got present; STOP/);
  // W4 shares the backup gate: its success close needs backup-gate.json as well as its readback.
  r=attempt('success',['backup-gate.json','W4-readback.txt'],'t','W4'); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  assert.equal(JSON.parse(r.record).window,'W4');
  for(const gate of [undefined,'PASS',gateReceipt('W2b'),gateReceipt('W4',{backup_verified_at:stamp(3600_000)})]) {
    r=attempt('success',gate===undefined?['W4-readback.txt']:['backup-gate.json','W4-readback.txt'],'t','W4',gate); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
    assert.match(r.result.stderr,/FAIL ai-close: W4: backup-gate\.json expected valid-bound-fresh-receipt got refused; STOP/);
  }
  r=attempt('success',['backup-gate.json'],'t','W4'); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W4 W4-readback\.txt expected present got missing; STOP/);
});

test('same-version retry / w3-recovered-close: a recovered W3 closes only with the baseline current and image and no tree at this release', () => {
  const root=mkdtempSync(join(scratch,'w3-close-'));
  const producerFile=join(root,'producer.mjs'), archive=join(root,'release.tar');
  writeFileSync(producerFile,'export const closeFixture = "live-ordinary-controls";\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producerFile],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const producerSha=digest(readFileSync(producerFile)), archiveSha=digest(readFileSync(archive));
  const controls={hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true};
  const pre=JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:'pre-W1',measured_at:new Date(Date.now()-60_000).toISOString(),
    producer_sha256:producerSha,controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['dcr-close-own'],cleanup:null});
  const recovery=JSON.stringify({release_sha:sha,window_id:'Abc123',window:'W3',phase:'recovery',controls,consent_receipt_sha256:digest(pre),producer_sha256:producerSha,dcr_client_ids:['dcr-close-window']});
  const oldSha='b'.repeat(40), baselineImage='sha256:'+'e'.repeat(64), inputs=join(root,'inputs.json');
  writeFileSync(inputs,JSON.stringify({...base(),window:'W3',rollback_decision:'restore-service',archive_sha256:archiveSha,baseline_oauth_sha:oldSha,baseline_oauth_image:baselineImage}));
  const shim=join(root,'shims'); mkdirSync(shim); writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const attempt=(setup:(oauth:string)=>void,image=baselineImage)=>{
    const oauth=realpathSync(mkdtempSync(join(root,'oauth-'))); mkdirSync(join(oauth,'releases',oldSha),{recursive:true}); symlinkSync(join(oauth,'releases',oldSha),join(oauth,'current'));
    setup(oauth);
    writeFileSync(join(shim,'docker'),`#!/bin/sh\ntest "$*" = "inspect --format {{.Image}} commonswarm-oauth-oauth-1" || exit 9\nprintf '%s\\n' '${image}'\n`,{mode:0o700});
    const close=portable(block('ai-close'),{stage:2,pointer:0}).split('/home/commonswarm/oauth').join(oauth);
    const stage=makeStage(), proof=mkdtempSync(join(root,'proof-'));
    writeFileSync(join(proof,'secret-stage.path'),stage+'\n'); writeFileSync(join(proof,'consent-pre-W1.json'),pre);
    writeFileSync(join(proof,'ordinary-recovery.json'),recovery); writeFileSync(join(proof,'inputs.json'),readFileSync(inputs));
    const result=run(`ai_ro() { printf 't\\n'; }\n`+close,{WINDOW:'W3',SECRET_STAGE:stage,PROOF_DIR:proof,EDGE_RECYCLE_TIMER:'fixture.timer',INPUTS_FILE:inputs,PLAN_FILE:planPath,
      BOX_ARCHIVE_PATH:archive,CLOSE_RESULT:'recovered',PATH:shim+':'+process.env.PATH});
    const closed=existsSync(join(proof,'closed.txt')); if(existsSync(stage)) removeStage(stage);
    return {result,closed};
  };
  let r=attempt(()=>undefined); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  // An aside tree of this release and other releases' trees do not block the close.
  r=attempt(o=>{ mkdirSync(join(o,'failed-attempts',sha+'-W3-Abc123'),{recursive:true}); mkdirSync(join(o,'releases','f'.repeat(40))); }); assert.equal(r.result.status,0,r.result.stderr);
  const refusal=/FAIL ai-close: recovered W3 oauth current expected baseline and release tree expected absent got other; run ai-w3-rollback; STOP/;
  r=attempt(o=>mkdirSync(join(o,'releases',sha))); assert.notEqual(r.result.status,0); assert.ok(!r.closed); assert.match(r.result.stderr,refusal); assert.doesNotMatch(r.result.stderr,/Traceback/);
  r=attempt(o=>symlinkSync(join(o,'nowhere'),join(o,'releases',sha))); assert.notEqual(r.result.status,0); assert.ok(!r.closed); assert.match(r.result.stderr,refusal);
  r=attempt(o=>{ mkdirSync(join(o,'releases',sha)); rmSync(join(o,'current')); symlinkSync(join(o,'releases',sha),join(o,'current')); }); assert.notEqual(r.result.status,0); assert.ok(!r.closed); assert.match(r.result.stderr,refusal);
  r=attempt(()=>undefined,'sha256:'+'c'.repeat(64)); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: recovered W3 running image expected baseline got other; STOP/);
});
test('same-version retry / w4-recovered-close: a recovered W4 closes only with the baseline edge, baseline Caddy bytes, no drop-in and no tree at this release', () => {
  const root=realpathSync(mkdtempSync(join(scratch,'w4-close-')));
  const producerFile=join(root,'producer.mjs'), archive=join(root,'release.tar');
  writeFileSync(producerFile,'export const closeFixture = "live-ordinary-controls";\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producerFile],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const producerSha=digest(readFileSync(producerFile)), archiveSha=digest(readFileSync(archive));
  const controls={hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true};
  const pre=JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:'pre-W1',measured_at:new Date(Date.now()-60_000).toISOString(),
    producer_sha256:producerSha,controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['dcr-close-own'],cleanup:null});
  const recovery=JSON.stringify({release_sha:sha,window_id:'Abc123',window:'W4',phase:'recovery',controls,consent_receipt_sha256:digest(pre),producer_sha256:producerSha,dcr_client_ids:['dcr-close-window']});
  const oldSha='b'.repeat(40), bytes={mcp:'mcp baseline\n',api:'api baseline\n',file:'import sites\n'}, inputs=join(root,'inputs.json');
  writeFileSync(inputs,JSON.stringify({...base(),window:'W4',rollback_decision:'restore-service',archive_sha256:archiveSha,baseline_edge_sha:oldSha,
    baseline_mcp_caddy_sha256:digest(bytes.mcp),baseline_api_caddy_sha256:digest(bytes.api),baseline_caddyfile_sha256:digest(bytes.file)}));
  const shim=join(root,'shims'); mkdirSync(shim); writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const attempt=(setup:(box:string)=>void)=>{
    const box=realpathSync(mkdtempSync(join(root,'box-'))), edge=join(box,'edge'), caddy=join(box,'caddy'), systemd=join(box,'systemd');
    mkdirSync(join(edge,'releases',oldSha),{recursive:true}); symlinkSync(join(edge,'releases',oldSha),join(edge,'current'));
    mkdirSync(join(caddy,'sites'),{recursive:true}); writeFileSync(join(caddy,'sites/20-commonswarm-mcp.caddy'),bytes.mcp);
    writeFileSync(join(caddy,'sites/10-commonswarm-api.caddy'),bytes.api); writeFileSync(join(caddy,'Caddyfile'),bytes.file); mkdirSync(join(systemd,'fixture.service.d'),{recursive:true});
    setup(box);
    const close=portable(block('ai-close'),{stage:2,pointer:0}).split('/home/commonswarm/edge').join(edge).split('/etc/caddy').join(caddy).split('/etc/systemd/system').join(systemd);
    const stage=makeStage(), proof=mkdtempSync(join(root,'proof-'));
    writeFileSync(join(proof,'secret-stage.path'),stage+'\n'); writeFileSync(join(proof,'consent-pre-W1.json'),pre);
    writeFileSync(join(proof,'ordinary-recovery.json'),recovery); writeFileSync(join(proof,'inputs.json'),readFileSync(inputs));
    const result=run(`ai_ro() { printf 't\\n'; }\n`+close,{WINDOW:'W4',SECRET_STAGE:stage,PROOF_DIR:proof,EDGE_RECYCLE_TIMER:'fixture.timer',EDGE_RECYCLE_SERVICE:'fixture.service',
      INPUTS_FILE:inputs,PLAN_FILE:planPath,BOX_ARCHIVE_PATH:archive,CLOSE_RESULT:'recovered',PATH:shim+':'+process.env.PATH});
    const closed=existsSync(join(proof,'closed.txt')); if(existsSync(stage)) removeStage(stage);
    return {result,closed};
  };
  let r=attempt(()=>undefined); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  r=attempt(b=>mkdirSync(join(b,'edge/failed-attempts',sha+'-W4-Abc123'),{recursive:true})); assert.equal(r.result.status,0,r.result.stderr);
  const refusal=/FAIL ai-close: recovered W4 edge current, Caddy bytes, drop-in and release tree expected baseline-baseline-absent-absent got other; run ai-w4-rollback; STOP/;
  for(const [name,setup] of [
    ['tree at this release',(b:string)=>mkdirSync(join(b,'edge/releases',sha))],
    ['current on the new tree',(b:string)=>{ mkdirSync(join(b,'edge/releases',sha)); rmSync(join(b,'edge/current')); symlinkSync(join(b,'edge/releases',sha),join(b,'edge/current')); }],
    ['candidate Caddy left live',(b:string)=>writeFileSync(join(b,'caddy/sites/20-commonswarm-mcp.caddy'),'candidate\n')],
    ['Caddyfile changed',(b:string)=>writeFileSync(join(b,'caddy/Caddyfile'),'other\n')],
    ['drop-in left',(b:string)=>writeFileSync(join(b,'systemd/fixture.service.d/50-admin-measurement.conf'),'[Service]\n')],
  ] as const) {
    r=attempt(setup); assert.notEqual(r.result.status,0,name); assert.ok(!r.closed,name); assert.match(r.result.stderr,refusal,name); assert.doesNotMatch(r.result.stderr,/Traceback/,name);
  }
  // The rollback derives its paths from INPUTS and moves the tree aside only after current is back on the baseline.
  const rollback=block('ai-w4-rollback');
  assert.ok(rollback.indexOf('OLD_EDGE=/home/commonswarm/edge/releases/$W4_BASELINE_EDGE_SHA')<rollback.indexOf('ln -sfT "$OLD_EDGE"'));
  assert.ok(rollback.indexOf('test "$(readlink -f /home/commonswarm/edge/current)" = "$OLD_EDGE" ||')<rollback.indexOf('RELEASE_ASIDE_PART=edge\n( ai_run ai-release-aside ) ||'));
});
// ---- shared W2/W2b proof validator (ai-w2b-proof-check), run from plan bytes; paths remapped only ----
const pyJson = (value: Record<string, unknown>) => '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ': ' + JSON.stringify(value[k])).join(', ') + '}\n';
const W2B_PRECONDITIONS_LINE = 'PASS W2b preconditions: backup gate, bound W2 proofs, ledger, checksums and forward catalogs exact; issuer NOLOGIN without password; credential absent; issuance OFF\n';
const ISSUER_CREDENTIAL_LINE = 'PASS issuer login; credential 0440 root:986; password stays on box\n';
function proofCheckFixture(kind: 'W2' | 'W2b', bound?: { sha: string; id: string }) {
  const root = realpathSync(mkdtempSync(join(scratch, `proof-check-${kind}-`)));
  const target = bound ?? (kind === 'W2' ? { sha: 'e'.repeat(40), id: 'RGLqZX' } : { sha, id: 'Xyz789' });
  const producerFile = join(root, 'producer.mjs'); writeFileSync(producerFile, 'export const proofCheck = "live-ordinary-controls";\n');
  const archive = join(root, `archive-${target.sha}-${target.id}.tar`);
  const tar = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")', archive, producerFile], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const producerSha = digest(readFileSync(producerFile));
  const dir = join(root, 'admin-issuance/release-proofs', `${target.sha}-${kind}-${target.id}`); mkdirSync(dir, { recursive: true });
  const consent = JSON.stringify({ kind: 'c1-consent', release_sha: target.sha, consent_phase: 'pre-W1', measured_at: new Date(Date.now() - 60_000).toISOString(),
    producer_sha256: producerSha, controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dcr-own'], cleanup: null });
  const controls = { hosted_mcp_consent_refresh: true, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true };
  const live = (phase: string, change: Record<string, unknown> = {}) => JSON.stringify({ release_sha: target.sha, window_id: target.id, window: kind, phase, controls,
    consent_receipt_sha256: digest(consent), producer_sha256: producerSha, dcr_client_ids: ['dcr-window'], ...change });
  const put = (name: string, value: string) => writeFileSync(join(dir, name), value);
  put('inputs.json', JSON.stringify({ release_sha: target.sha, window: kind, window_id: target.id, archive_sha256: digest(readFileSync(archive)) }));
  put('consent-pre-W1.json', consent); put('closed.txt', '2026-10-04T09:00:00Z\n');
  if (kind === 'W2') {
    put('ordinary-recovery.json', live('recovery'));
    put('schema-committed.txt', 'all five ledger rows, M4/M5 checksums and complete backfills exact\n'); put('W2-probes.txt', 'PASS\n');
    put('dcr-probe-revoked.json', pyJson({ client_id: 'dcr-probe-client', revoked: true, proof: 'refresh rejected' }));
  } else {
    put('close-result.json', pyJson({ release_sha: target.sha, window: 'W2b', window_id: target.id, result: 'success', closed_at: '2026-10-04T09:00:00Z' }));
    put('ordinary-after.json', live('after')); put('w2b-preconditions.txt', W2B_PRECONDITIONS_LINE); put('issuer-credential.txt', ISSUER_CREDENTIAL_LINE);
    put('w2b-forward-catalogs.txt', 'PASS W2b forward catalogs: all five true after the issuer credential\n');
  }
  const checking: Input = kind === 'W2' ? { ...base(), window: 'W2b', w2_release_sha: target.sha, w2_window_id: target.id }
    : { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_release_sha: target.sha, w2b_window_id: target.id };
  const inputs = join(root, 'checking-inputs.json'); writeFileSync(inputs, JSON.stringify(checking));
  const source = block('ai-w2b-proof-check').split('/home/commonswarm/admin-issuance').join(join(root, 'admin-issuance')).split('/tmp/admin-issuance-').join(join(root, 'archive-'));
  const check = (env: Record<string, string> = {}) => run(source, { PLAN_FILE: planPath, INPUTS_FILE: inputs, PROOF_CHECK_KIND: kind, ...env });
  return { root, dir, target, put, live, consent, archive, check, inputs };
}

test('admin release plan: the shared proof validator accepts exact W2 and W2b proofs and prints the binding', () => {
  const w2 = proofCheckFixture('W2'); let r = w2.check();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { kind: 'W2', release_sha: 'e'.repeat(40), window_id: 'RGLqZX', result: 'recovered', closed_at: '2026-10-04T09:00:00Z' });
  // A W2 with an explicit close record uses it.
  w2.put('close-result.json', pyJson({ release_sha: 'e'.repeat(40), window: 'W2', window_id: 'RGLqZX', result: 'recovered', closed_at: '2026-10-04T09:00:00Z' }));
  r = w2.check(); assert.equal(r.status, 0, r.stderr);
  const w2b = proofCheckFixture('W2b'); r = w2b.check();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { kind: 'W2b', release_sha: sha, window_id: 'Xyz789', result: 'success', closed_at: '2026-10-04T09:00:00Z' });
  // Validator constants are the writers' exact bytes (no retyped drift).
  assert.ok(block('ai-w2b-preflight').includes(`printf '${W2B_PRECONDITIONS_LINE.trimEnd()}\\n' >"$PROOF_DIR/w2b-preconditions.txt"`));
  assert.ok(block('ai-w2-issuer-credential').includes(`printf '${ISSUER_CREDENTIAL_LINE.trimEnd()}\\n' >"$PROOF_DIR/issuer-credential.txt"`));
  assert.ok(block('ai-w2-reconcile').includes(`(p/'schema-committed.txt').write_text('all five ledger rows, M4/M5 checksums and complete backfills exact\\n')`));
  assert.ok(block('ai-w2-probes').includes(`printf 'PASS\\n' >"$PROOF_DIR/W2-probes.txt"`));
  assert.ok(block('ai-w2b-forward-catalogs').includes(`printf 'PASS W2b forward catalogs: all five true after the issuer credential\\n' >"$PROOF_DIR/w2b-forward-catalogs.txt"`));
  assert.ok(block('ai-close').includes(`pathlib.Path(sys.argv[4]).write_text(json.dumps({'release_sha':d['release_sha'],'window':d['window'],'window_id':d['window_id'],'result':sys.argv[2],'closed_at':sys.argv[3]},sort_keys=True)+'\\n')`));
  // Both consumers call the one validator through ai_run.
  assert.match(block('ai-w2b-preflight'), /PROOF_CHECK_KIND=W2\nW2_BINDING=\$\(ai_run ai-w2b-proof-check\)/);
  assert.match(block('ai-w6-activation-checks'), /PROOF_CHECK_KIND=W2b\nW2B_BINDING=\$\(ai_run ai-w2b-proof-check\)/);
});

test('admin release plan: the shared proof validator refuses invalid CONTENT in every W2 proof file', () => {
  const recovery = (f: ReturnType<typeof proofCheckFixture>, change: Record<string, unknown>) => f.put('ordinary-recovery.json', f.live('recovery', change));
  const cases: Array<[string, (f: ReturnType<typeof proofCheckFixture>) => void, RegExp]> = [
    ['inputs.json other window', f => f.put('inputs.json', JSON.stringify({ release_sha: f.target.sha, window: 'W3', window_id: f.target.id })), /W2 inputs\.json expected window-W2-bound-release-and-window-id got mismatch/],
    ['inputs.json other id', f => f.put('inputs.json', JSON.stringify({ release_sha: f.target.sha, window: 'W2', window_id: 'Other1' })), /W2 inputs\.json expected window-W2-bound-release-and-window-id got mismatch/],
    ['inputs.json not JSON', f => f.put('inputs.json', '{'), /W2 inputs\.json expected/],
    ['closed.txt object', f => f.put('closed.txt', '{}'), /W2 closed\.txt expected one-UTC-close-time-line got other/],
    ['closed.txt two lines', f => f.put('closed.txt', '2026-10-04T09:00:00Z\n2026-10-04T09:00:01Z\n'), /W2 closed\.txt expected one-UTC-close-time-line got other/],
    ['close-result.json object', f => f.put('close-result.json', '{}\n'), /W2 close-result\.json binding expected exact-keys-bound-to-inputs got other/],
    ['close-result.json unsorted', f => f.put('close-result.json', JSON.stringify({ window: 'W2', release_sha: f.target.sha, window_id: f.target.id, result: 'recovered', closed_at: '2026-10-04T09:00:00Z' }) + '\n'), /W2 close-result\.json bytes expected exact-sorted-JSON-line got other/],
    ['close-result.json other time', f => f.put('close-result.json', pyJson({ release_sha: f.target.sha, window: 'W2', window_id: f.target.id, result: 'recovered', closed_at: '2026-10-04T10:00:00Z' })), /W2 close-result\.json result expected success-or-recovered-at-closed\.txt got other/],
    ['both receipts without record', f => f.put('ordinary-after.json', f.live('after')), /W2 close receipt expected exactly-one-of-after-or-recovery got 2/],
    ['no receipt', f => rmSync(join(f.dir, 'ordinary-recovery.json')), /W2 close receipt expected exactly-one-of-after-or-recovery got 0/],
    ['receipt object', f => f.put('ordinary-recovery.json', '{}'), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['receipt other window id', f => recovery(f, { window_id: 'Other1' }), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['receipt control false', f => recovery(f, { controls: { hosted_mcp_consent_refresh: false, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true } }), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['receipt phase after', f => recovery(f, { phase: 'after' }), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['consent object', f => f.put('consent-pre-W1.json', '{}'), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['archive missing', f => rmSync(f.archive), /W2 ordinary-recovery\.json expected valid-bound-live-controls-receipt got refused/],
    ['schema-committed object', f => f.put('schema-committed.txt', '{}'), /W2 schema-committed\.txt expected exact-reconcile-line got other/],
    ['W2-probes object', f => f.put('W2-probes.txt', '{}'), /W2 W2-probes\.txt expected exact-PASS-line got other/],
    ['revoke proof object', f => f.put('dcr-probe-revoked.json', '{}\n'), /W2 dcr-probe-revoked\.json expected client_id-refresh-rejected-revoked-true got other/],
    ['revoke proof not revoked', f => f.put('dcr-probe-revoked.json', pyJson({ client_id: 'c', revoked: false, proof: 'refresh rejected' })), /W2 dcr-probe-revoked\.json expected client_id-refresh-rejected-revoked-true got other/],
    ['revoke proof other proof', f => f.put('dcr-probe-revoked.json', pyJson({ client_id: 'c', revoked: true, proof: 'assumed' })), /W2 dcr-probe-revoked\.json expected client_id-refresh-rejected-revoked-true got other/],
    ['revoke proof compact bytes', f => f.put('dcr-probe-revoked.json', JSON.stringify({ client_id: 'c', proof: 'refresh rejected', revoked: true }) + '\n'), /W2 dcr-probe-revoked\.json bytes expected exact-sorted-JSON-line got other/],
    ['revoke proof missing', f => rmSync(join(f.dir, 'dcr-probe-revoked.json')), /W2 dcr-probe-revoked\.json expected regular-file got missing-or-not-regular/],
  ];
  for (const [name, change, message] of cases) {
    const f = proofCheckFixture('W2'); change(f); const r = f.check();
    assert.notEqual(r.status, 0, name); assert.match(r.stderr, message, `${name}: ${r.stderr}`); assert.equal(r.stdout, '', name);
  }
  const wrongKind = proofCheckFixture('W2'); const r = wrongKind.check({ PROOF_CHECK_KIND: 'W3' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /PROOF_CHECK_KIND expected W2-or-W2b got other/);
});

test('admin release plan: the shared proof validator refuses a W2b that did not close success with exact proofs, or whose issuer rollback ran', () => {
  const record = (f: ReturnType<typeof proofCheckFixture>, change: Record<string, unknown>) =>
    f.put('close-result.json', pyJson({ release_sha: f.target.sha, window: 'W2b', window_id: f.target.id, result: 'success', closed_at: '2026-10-04T09:00:00Z', ...change }));
  const cases: Array<[string, (f: ReturnType<typeof proofCheckFixture>) => void, RegExp]> = [
    ['no close record', f => rmSync(join(f.dir, 'close-result.json')), /W2b close-result\.json expected regular-file got missing-or-not-regular/],
    ['recovered close', f => { record(f, { result: 'recovered' }); f.put('ordinary-recovery.json', f.live('recovery')); }, /W2b close result expected success got recovered/],
    ['record at another release', f => record(f, { release_sha: 'f'.repeat(40) }), /W2b close-result\.json binding expected exact-keys-bound-to-inputs got other/],
    ['record other window', f => record(f, { window: 'W3' }), /W2b close-result\.json binding expected exact-keys-bound-to-inputs got other/],
    ['closed.txt object', f => f.put('closed.txt', '{}'), /W2b closed\.txt expected one-UTC-close-time-line got other/],
    ['inputs at another release', f => f.put('inputs.json', JSON.stringify({ release_sha: 'f'.repeat(40), window: 'W2b', window_id: f.target.id })), /W2b inputs\.json expected window-W2b-bound-release-and-window-id got mismatch/],
    ['after receipt object', f => f.put('ordinary-after.json', '{}'), /W2b ordinary-after\.json expected valid-bound-live-controls-receipt got refused/],
    ['after receipt phase before', f => f.put('ordinary-after.json', f.live('before')), /W2b ordinary-after\.json expected valid-bound-live-controls-receipt got refused/],
    ['after receipt window W2', f => f.put('ordinary-after.json', f.live('after', { window: 'W2' })), /W2b ordinary-after\.json expected valid-bound-live-controls-receipt got refused/],
    ['after receipt missing', f => rmSync(join(f.dir, 'ordinary-after.json')), /W2b ordinary-after\.json expected regular-file got missing-or-not-regular/],
    ['preconditions object', f => f.put('w2b-preconditions.txt', '{}'), /W2b w2b-preconditions\.txt expected exact-preconditions-line got other/],
    ['preconditions older text', f => f.put('w2b-preconditions.txt', 'PASS W2b preconditions: bound W2 closed, ledger exact, issuer NOLOGIN without password, credential absent, issuance OFF\n'), /W2b w2b-preconditions\.txt expected exact-preconditions-line got other/],
    ['issuer credential object', f => f.put('issuer-credential.txt', '{}'), /W2b issuer-credential\.txt expected exact-issuer-login-line got other/],
    ['issuer credential missing', f => rmSync(join(f.dir, 'issuer-credential.txt')), /W2b issuer-credential\.txt expected regular-file got missing-or-not-regular/],
    ['issuer rollback ran', f => f.put('issuer-rollback.txt', 'PASS issuer login disabled; additive roles/grants retained\n'), /W2b issuer-rollback\.txt expected absent got present/],
    ['forward catalogs object', f => f.put('w2b-forward-catalogs.txt', '{}'), /W2b w2b-forward-catalogs\.txt expected exact-forward-catalogs-line got other/],
    ['forward catalogs missing', f => rmSync(join(f.dir, 'w2b-forward-catalogs.txt')), /W2b w2b-forward-catalogs\.txt expected regular-file got missing-or-not-regular/],
  ];
  for (const [name, change, message] of cases) {
    const f = proofCheckFixture('W2b'); change(f); const r = f.check();
    assert.notEqual(r.status, 0, name); assert.match(r.stderr, message, `${name}: ${r.stderr}`); assert.equal(r.stdout, '', name);
  }
  // W6 inputs without the binding refuse before reading anything.
  for (const key of ['w2b_window_id', 'w2b_release_sha']) {
    const f = proofCheckFixture('W2b'); const input = JSON.parse(readFileSync(f.inputs, 'utf8')); delete input[key];
    writeFileSync(f.inputs, JSON.stringify(input)); const r = f.check();
    assert.notEqual(r.status, 0, key); assert.match(r.stderr, /INPUTS W2b binding expected full-sha-and-window-id got missing-or-other/, key);
  }
  // The W6 release does not select the W2b: inputs naming another W2b release find no proof directory.
  const other = proofCheckFixture('W2b'); const moved = JSON.parse(readFileSync(other.inputs, 'utf8')); moved.w2b_release_sha = 'f'.repeat(40);
  writeFileSync(other.inputs, JSON.stringify(moved)); const r = other.check();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /W2b proof directory expected directory got missing-or-symlink/);
});

test('admin release plan: the shared backup receipt check accepts only a bound, fresh, well-formed receipt', () => {
  const stamp = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const receipt = (window: string, change: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { status: 'PASS', release_sha: sha, window, window_id: 'Abc123', backup_verified_at: stamp(600_000), restore_completed_at: stamp(86400_000),
      destination: 'r2:yulan-vps-1-backups/000-commonswarm-postgres/fixture', gate_at: stamp(60_000), ...change };
    return '{' + Object.keys(r).sort().map(k => JSON.stringify(k) + ': ' + JSON.stringify(r[k])).join(', ') + '}\n';
  };
  const check = (window: string, gate: string | null, change: (dir: string) => void = () => undefined) => {
    const dir = realpathSync(mkdtempSync(join(scratch, 'gate-check-')));
    writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...base(), window }));
    writeFileSync(join(dir, 'open.txt'), stamp(300_000) + '\n');
    if (gate !== null) writeFileSync(join(dir, 'backup-gate.json'), gate);
    change(dir);
    return run(block('ai-backup-gate-check'), { BACKUP_GATE_DIR: dir });
  };
  for (const window of ['W1', 'W2b', 'W4']) {
    const ok = check(window, receipt(window)); assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`^PASS ai-backup-gate-check: ${window} Abc123 backup and restore fresh at gate `));
  }
  const atEnd = stamp(60_000); // one exact instant used as both gate_at and window_end_utc
  const cases: Array<[string, string | null, RegExp, (dir: string) => void]> = [
    ['missing', null, /backup-gate\.json expected regular-file got missing-or-not-regular/, () => undefined],
    ['not JSON', 'PASS', /backup-gate\.json expected JSON-object got malformed/, () => undefined],
    ['status only', '{"status": "PASS"}\n', /backup-gate\.json keys expected exact-PASS-receipt got other/, () => undefined],
    ['extra key', receipt('W4', { extra: 1 }), /backup-gate\.json keys expected exact-PASS-receipt got other/, () => undefined],
    ['status FAIL', receipt('W4', { status: 'FAIL' }), /backup-gate\.json keys expected exact-PASS-receipt got other/, () => undefined],
    ['other window', receipt('W2b'), /backup-gate\.json binding expected same-release-window-and-window-id-as-inputs got other/, () => undefined],
    ['other release', receipt('W4', { release_sha: 'f'.repeat(40) }), /backup-gate\.json binding expected same-release-window-and-window-id-as-inputs got other/, () => undefined],
    ['other window id', receipt('W4', { window_id: 'Other1' }), /backup-gate\.json binding expected same-release-window-and-window-id-as-inputs got other/, () => undefined],
    ['W3 receipt', receipt('W3'), /backup-gate\.json binding expected same-release-window-and-window-id-as-inputs got other/, dir => writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...base(), window: 'W3' }))],
    ['stale backup', receipt('W4', { backup_verified_at: stamp(1900_000) }), /backup verified_at at gate time expected at-most-1800s-old got stale-or-future/, () => undefined],
    ['backup after gate', receipt('W4', { backup_verified_at: stamp(0) }), /backup verified_at at gate time expected at-most-1800s-old got stale-or-future/, () => undefined],
    ['old restore drill', receipt('W4', { restore_completed_at: stamp(9 * 86400_000) }), /restore drill completed_at at gate time expected at-most-8-days-old got stale-or-future/, () => undefined],
    ['bad time', receipt('W4', { gate_at: 'yesterday' }), /gate_at expected aware-UTC-ISO-8601-time got other/, () => undefined],
    ['wrong destination', receipt('W4', { destination: 'r2:other/x' }), /backup destination expected reviewed-r2-prefix got other/, () => undefined],
    ['gate before open', receipt('W4', { gate_at: stamp(900_000), backup_verified_at: stamp(1000_000) }), /gate_at expected inside-this-window got before-open-after-end-or-future/, () => undefined],
    ['gate in future', receipt('W4', { gate_at: stamp(-120_000), backup_verified_at: stamp(0) }), /gate_at expected inside-this-window got before-open-after-end-or-future/, () => undefined],
    ['gate after window end', receipt('W4'), /gate_at expected inside-this-window got before-open-after-end-or-future/,
      dir => writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...base(), window: 'W4', window_end_utc: stamp(120_000) }))],
    ['gate at window end', receipt('W4', { gate_at: atEnd }), /gate_at expected inside-this-window got before-open-after-end-or-future/,
      dir => writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...base(), window: 'W4', window_end_utc: atEnd }))],
    ['no window end', receipt('W4'), /window inputs window_end_utc expected aware-UTC-ISO-8601-time got other/,
      dir => { const i: Input = { ...base(), window: 'W4' }; delete i.window_end_utc; writeFileSync(join(dir, 'inputs.json'), JSON.stringify(i)); }],
    ['no open.txt', receipt('W4'), /window open\.txt expected regular-file got missing/, dir => rmSync(join(dir, 'open.txt'))],
  ];
  for (const [name, gate, message, change] of cases) {
    const r = check('W4', gate, change); assert.notEqual(r.status, 0, name); assert.match(r.stderr, message, `${name}: ${r.stderr}`); assert.equal(r.stdout, '', name);
  }
  const unset = run(block('ai-backup-gate-check'), {}); assert.notEqual(unset.status, 0); assert.match(unset.stderr, /BACKUP_GATE_DIR expected window-proof-directory got unset/);
  // Every consumer runs the one check (in a subshell, so bash 3.2 cannot exit past the caller's STOP message).
  for (const [id, n] of [['ai-w1-backup-gate', 1], ['ai-w2-preflight', 1], ['ai-w2b-preflight', 1], ['ai-w2-issuer-credential', 1], ['ai-w4-preflight', 1], ['ai-w4-apply', 1], ['ai-close', 3]] as const) {
    assert.equal(block(id).split('ai_run ai-backup-gate-check').length - 1, n, id);
  }
  const apply = block('ai-w4-apply');
  assert.ok(apply.indexOf('ai_run ai-backup-gate-check') < apply.indexOf('ai_db -q'), 'W4: the check precedes the first database mutation');
  const issuer = block('ai-w2-issuer-credential');
  assert.ok(issuer.indexOf('ai_run ai-backup-gate-check') < issuer.indexOf('openssl rand'), 'W2b: the check precedes the credential');
});

test('admin release plan: W2b post-credential forward catalogs: all five unmodified must be true; a false one runs the issuer rollback and STOPs', () => {
  const source = block('ai-w2b-forward-catalogs');
  const attempt = (answers: Record<string, string>) => {
    const proof = mkdtempSync(join(scratch, 'w2b-forward-'));
    writeFileSync(join(proof, 'issuer-credential.txt'), 'PASS issuer login; credential 0440 root:986; password stays on box\n');
    const harness = `ai_deadline() { :; }
ai_ro() { local v; v=$(sed -n 's#^\\\\i /release/deploy/release-proofs/item-ai/\\(2026100300000[1-5]\\)-catalog\\.sql$#\\1#p' "$PROOF_DIR/catalog.sql"); grep -qx "SELECT :'catalog_ok'::boolean;" "$PROOF_DIR/catalog.sql" || return 9; printf '%s\\n' "$v" >>"$PROOF_DIR/asked.txt"; case "$v" in ${Object.entries(answers).map(([k, a]) => `${k}) printf '${a}\\n';;`).join(' ')} *) printf 't\\n';; esac; }
ai_run() { test "$1" = ai-w2-issuer-rollback || return 1; printf 'rollback\\n' >"$PROOF_DIR/rollback-ran.txt"; }
`;
    const result = run(harness + source, { WINDOW: 'W2b', PROOF_DIR: proof });
    const read = (name: string) => existsSync(join(proof, name)) ? readFileSync(join(proof, name), 'utf8') : null;
    return { result, proof: read('w2b-forward-catalogs.txt'), rollback: read('rollback-ran.txt'), asked: read('asked.txt') };
  };
  let r = attempt({}); assert.equal(r.result.status, 0, r.result.stderr);
  assert.equal(r.proof, 'PASS W2b forward catalogs: all five true after the issuer credential\n'); assert.equal(r.rollback, null);
  assert.equal(r.asked, [1, 2, 3, 4, 5].map(i => `2026100300000${i}\n`).join(''), 'all five unmodified catalogs, catalog_ok only');
  // No accepted failure: the 0002 issuer row that W2b preflight tolerated must now be true.
  for (const [version, answer] of [['20261003000002', 'f'], ['20261003000005', 'f'], ['20261003000003', '']] as const) {
    r = attempt({ [version]: answer }); assert.notEqual(r.result.status, 0, version);
    assert.match(r.result.stderr, new RegExp(`FAIL ai-w2b-forward-catalogs: forward catalog ${version} expected t got other; running ai-w2-issuer-rollback; STOP`));
    assert.equal(r.rollback, 'rollback\n', `${version}: the issuer rollback ran`); assert.equal(r.proof, null, `${version}: no proof, so no success close`);
  }
  const wrong = run('ai_deadline() { :; }\n' + source, { WINDOW: 'W2', PROOF_DIR: mkdtempSync(join(scratch, 'w2b-forward-')) });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /FAIL ai-w2b-forward-catalogs: window expected W2b got other; STOP/);
  const noCredential = run('ai_deadline() { :; }\n' + source, { WINDOW: 'W2b', PROOF_DIR: mkdtempSync(join(scratch, 'w2b-forward-')) });
  assert.notEqual(noCredential.status, 0); assert.match(noCredential.stderr, /issuer-credential\.txt expected present got missing/);
});

test('admin release plan: a false post-credential catalog reaches the REAL issuer rollback; a failed ALTER or false readback is reported and writes no PASS', () => {
  const forward = block('ai-w2b-forward-catalogs');
  const attempt = (opts: { alter?: number; readback?: string; modelled?: boolean }) => {
    const root = realpathSync(mkdtempSync(join(scratch, 'fwd-rollback-')));
    const proof = join(root, 'proof'), etc = join(root, 'etc'); mkdirSync(proof); mkdirSync(etc);
    writeFileSync(join(proof, 'issuer-credential.txt'), 'PASS issuer login; credential 0440 root:986; password stays on box\n');
    writeFileSync(join(etc, 'admin-issuer-database-credentials'), '{"user":"commonswarm_admin_issuer","password":"synthetic"}\n');
    // The plan's own rollback block (credential path remapped into this test's directory). "modelled" runs it with
    // errexit off, as bash 5 does on the left of || (the mini's /bin/bash 3.2 cannot show that context itself).
    let rollback = block('ai-w2-issuer-rollback').split('/etc/commonswarm-oauth/').join(etc + '/');
    if (opts.modelled) rollback = rollback.replace('set -euo pipefail', 'set +e');
    writeFileSync(join(root, 'rollback.sh'), rollback);
    const harness = `ai_deadline() { :; }
ai_ro() { case "$*" in *catalog.sql*) case "$(cat "$PROOF_DIR/catalog.sql")" in *20261003000002-catalog*) printf 'f\\n';; *) printf 't\\n';; esac;;
  *pg_authid*) printf '%s\\n' '${opts.readback ?? 't'}';; *) return 7;; esac; }
ai_db() { printf '%s\\n' "$*" >>"$PROOF_DIR/ai_db.log"; return ${opts.alter ?? 0}; }
ai_run() { test "$1" = ai-w2-issuer-rollback || return 1; eval "$(cat '${join(root, 'rollback.sh')}')"; }
`;
    const result = run(harness + forward, { WINDOW: 'W2b', PROOF_DIR: proof });
    return { result, proof, etc, rollback: existsSync(join(proof, 'issuer-rollback.txt')), forwardProof: existsSync(join(proof, 'w2b-forward-catalogs.txt')),
      credential: existsSync(join(etc, 'admin-issuer-database-credentials')), dbLog: existsSync(join(proof, 'ai_db.log')) ? readFileSync(join(proof, 'ai_db.log'), 'utf8') : '' };
  };
  for (const modelled of [false, true]) {
    const ok = attempt({ modelled }); assert.notEqual(ok.result.status, 0);
    assert.match(ok.result.stderr, /FAIL ai-w2b-forward-catalogs: forward catalog 20261003000002 expected t got other; running ai-w2-issuer-rollback; STOP/);
    assert.doesNotMatch(ok.result.stderr, /issuer rollback expected PASS got failure/);
    assert.ok(ok.rollback && !ok.credential && !ok.forwardProof, `rollback applied (modelled=${modelled})`);
    assert.match(ok.dbLog, /ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;/);
    for (const [name, opts, message] of [
      ['ALTER fails', { alter: 1 }, /FAIL ai-w2-issuer-rollback: issuer ALTER ROLE expected success got failure; STOP/],
      ['readback false', { readback: 'f' }, /FAIL ai-w2-issuer-rollback: issuer role readback expected no-login-and-no-password got other; STOP/],
    ] as const) {
      const r = attempt({ ...opts, modelled }); assert.notEqual(r.result.status, 0, name);
      assert.match(r.result.stderr, message, `${name} modelled=${modelled}`);
      assert.match(r.result.stderr, /FAIL ai-w2b-forward-catalogs: issuer rollback expected PASS got failure; STOP/, `${name}: the caller reports the rollback failure`);
      assert.ok(!r.rollback, `${name} modelled=${modelled}: no issuer-rollback.txt PASS`); assert.ok(!r.forwardProof);
      if (name === 'ALTER fails') assert.ok(r.credential, 'nothing after the failed ALTER: the credential file is untouched');
    }
  }
});

test('admin release plan: W6 activation requires enabled env, issuer overlay and opened database cutover', () => {
  const apply = block('ai-w6-activation-apply');
  assert.match(apply, /rows\+\['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1'\]/, 'activation must explicitly opt in');
  assert.match(apply, /install .*"\$SECRET_STAGE\/service\.active\.env" \/etc\/commonswarm-oauth\/service\.env/);
  assert.match(apply, /docker compose[^;]*-f "\$OAUTH_TARGET\/deploy\/mcp-auth\/compose\.admin-issuer\.yaml"[^;]*up -d/, 'activation must mount the dedicated issuer credential');
  assert.match(apply, /UPDATE commonswarm_oauth\.admin_cutover_state SET lane8_evidence_digest=.*admin_issuance_enabled=true WHERE singleton/);
  assert.match(apply, /ai_db -q --file \/proof\/activate\.sql/, 'the generated DB cutover must actually be applied');
});

test('admin release plan: failed recycle restart remains closed; healthy restart remeasures before reopening', () => {
  const root = join(realpathSync(scratch), 'recycle-execution'); mkdirSync(root);
  const configDir = join(root, 'config'); mkdirSync(configDir);
  const edgeRoot = join(root, 'edge'), target = join(edgeRoot, 'releases', sha);
  mkdirSync(target, { recursive: true });
  const releaseRoot = join(root, 'release', sha); mkdirSync(releaseRoot, { recursive: true });
  const archive = join(root, `admin-issuance-${sha}-Abc123.tar`);
  writeFileSync(join(target, 'tracked.txt'), 'reviewed edge bytes\n');
  // Actual archive/byte verification still runs; only OS/daemon/DB boundaries are substituted.
  const tar = spawnSync('python3', ['-c', 'import sys,tarfile; t=tarfile.open(sys.argv[1],"w"); t.add(sys.argv[2],arcname="tracked.txt"); t.close()', archive, join(target, 'tracked.txt')], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const current = join(edgeRoot, 'current');
  const link = spawnSync('ln', ['-s', target, current], { encoding: 'utf8' }); assert.equal(link.status, 0, link.stderr);
  const config = join(configDir, 'recycle.json'), stateFile = join(root, 'database.json');
  writeFileSync(config, JSON.stringify({ release_sha: sha, target, image_digest: `sha256:${hex}`,
    artifact_digest: digest(readFileSync(archive)), archive, postgres_image: `sha256:${hex}`, release_root: releaseRoot }), { mode: 0o600 });
  const shim = join(root, 'bin'); mkdirSync(shim);
  const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  const boundary = `
from types import SimpleNamespace
fixture_state = pathlib.Path(os.environ['RECYCLE_FIXTURE_STATE'])
original_stat = pathlib.Path.stat
def fixture_stat(p, *args, **kwargs):
    value = original_stat(p, *args, **kwargs)
    if str(p) == os.environ['RECYCLE_FIXTURE_CONFIG']:
        return SimpleNamespace(st_uid=0, st_mode=value.st_mode)
    return value
pathlib.Path.stat = fixture_stat
def fixture_run(args, **kwargs):
    if args[:3] == ['logger', '-t', 'commonswarm-admin-recycle']:
        with open(os.environ['RECYCLE_FIXTURE_JOURNAL'], 'a') as journal: journal.write(args[-1] + '\\n')
        return SimpleNamespace(returncode=0)
    assert args[0] == 'node'
    env = kwargs['env']
    pathlib.Path(env['PG_SERVICE_OUTPUT']).write_text('synthetic service fixture')
    pathlib.Path(env['PG_PASS_OUTPUT']).write_text('synthetic pass fixture')
    return SimpleNamespace(returncode=0)
def fixture_output(args, **kwargs):
    if args[:2] == ['docker', 'inspect']:
        if os.environ.get('RECYCLE_FIXTURE_FAILURE') == '1':
            raise subprocess.CalledProcessError(1, ['docker', 'inspect'])
        r = json.loads(pathlib.Path(os.environ['RECYCLE_FIXTURE_CONFIG']).read_text())
        target = r['target']
        return json.dumps([{'Image': r['image_digest'], 'State': {'Health': {'Status': 'healthy'}},
          'Config': {'Labels': {'com.docker.compose.project.working_dir': target+'/deploy/edge-runtime'}},
          'HostConfig': {'NetworkMode': 'commonswarm-net', 'Memory': 2147483648},
          'Mounts': [{'Destination': dst, 'Source': target+'/'+rel, 'RW': False} for dst,rel in
            [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]]}]).encode()
    # docker run has no -i: the SQL is a read-only mounted file, never stdin.
    assert args[:2] == ['docker', 'run'] and args[-2:] == ['--file', '/run/statement.sql'] and 'input' not in kwargs and kwargs.get('stdin') == subprocess.DEVNULL
    mount = [args[i+1] for i in range(len(args)-1) if args[i] == '--volume' and args[i+1].endswith(':/run/statement.sql:ro')]
    assert len(mount) == 1
    sql = pathlib.Path(mount[0].split(':')[0]).read_text(); state = json.loads(fixture_state.read_text()); prior = state['enabled']
    if 'SELECT lane8_evidence_digest IS NOT NULL' in sql: return 't'
    if sql.startswith('SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL'):
        if os.environ.get('RECYCLE_FIXTURE_READBACK_FAILS') == '1': raise subprocess.CalledProcessError(2, ['docker', 'run'])
        return 't' if not state['enabled'] and state['invalidated'] else 'f'
    if os.environ.get('RECYCLE_FIXTURE_CLOSE_FAILS') == '1' and sql.endswith('release_generation=release_generation+1 WHERE singleton; COMMIT;'):
        raise subprocess.CalledProcessError(3, ['docker', 'run'])
    enable = re.search(r'admin_issuance_enabled=(true|false)', sql)
    if enable: state['enabled'] = enable[1] == 'true'
    if 'release_generation=release_generation+1' in sql:
        state['generation'] += 1; state['invalidated'] = True
    if 'measured_generation=release_generation' in sql:
        state['measured_generation'] = state['generation']; state['invalidated'] = False
    fixture_state.write_text(json.dumps(state))
    # The reopen COMMITS, then the response is lost.
    if os.environ.get('RECYCLE_FIXTURE_LOSE_REOPEN') == '1' and 'admin_issuance_enabled=true' in sql: raise subprocess.CalledProcessError(1, ['docker', 'run'])
    return ('t' if prior else 'f')+'\\n'+str(state['generation']) if 'RETURNING release_generation' in sql else ''
subprocess.run = fixture_run
subprocess.check_output = fixture_output
`;
  writeFileSync(join(shim, 'python3'), `#!/bin/bash\nexec '${python}' "$@"\n`, { mode: 0o700 });
  let source = portable(block('ai-recycle-hook'), { stage: 1, pointer: 0 });
  // Remap the complete hook's paths to the owned fixture; no live path is used.
  for (const [from, to] of [
    ['/etc/commonswarm-admin-release', configDir], ['/home/commonswarm/edge', edgeRoot],
    ['/home/commonswarm/admin-issuance/releases', join(root, 'release')],
    ['/tmp/admin-issuance-', join(root, 'admin-issuance-')], ['/var/lib/commonswarm-release', join(root, 'var-lib')],
    ['$(mktemp -d /private/tmp/anvil-secret.XXXXXX)', `$(mktemp -d ${secretRoot}/anvil-secret.XXXXXX)`],
  ]) source = source.split(from).join(to);
  const imports = 'import hashlib,json,os,pathlib,re,stat,subprocess,sys,tarfile,time\n';
  assert.equal(source.split(imports).length - 1, 1);
  source = source.replace(imports, imports + boundary);
  const hook = (mode: string, failed = false, extra: Record<string, string> = {}) => run(`set -- ${mode}\n${source}`, {
    PATH: `${shim}:${process.env.PATH}`, RECYCLE_FIXTURE_STATE: stateFile, RECYCLE_FIXTURE_CONFIG: config,
    RECYCLE_FIXTURE_FAILURE: failed ? '1' : '0', RECYCLE_FIXTURE_JOURNAL: journalFile, COMMONSWARM_RECYCLE_UNIT: 'fixture-recycle.service', ...extra,
  });
  const journalFile = join(root, 'journal.log'), markerFile = join(root, 'var-lib', 'admin-issuance-closed.log');
  const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const initial = { enabled: true, generation: 7, measured_generation: 7, invalidated: false };
  for (const failed of [true, false]) {
    writeFileSync(stateFile, JSON.stringify(initial));
    const before = hook('before'); assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(state(), { enabled: false, generation: 8, measured_generation: 7, invalidated: true });
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'recycle-intent.json'), 'utf8')), { reopen: true, generation: 8 });
    const after = hook('after', failed);
    if (failed) {
      assert.notEqual(after.status, 0); assert.match(after.stderr, /FAIL recycle hook; issuance CLOSED \(confirmed by readback\)/);
      assert.deepEqual(state(), { enabled: false, generation: 8, measured_generation: 7, invalidated: true });
      // One NONSECRET marker line in the journal and in the 0644 append-only log, after the close.
      const marker = lines(markerFile); assert.equal(marker.length, 1); assert.deepEqual(lines(journalFile), marker);
      const m = JSON.parse(marker[0]!);
      assert.deepEqual(Object.keys(m).sort(), ['approved_edge_release_sha', 'at', 'event', 'measured_edge_release_sha', 'reason', 'unit']);
      assert.match(m.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepEqual({ ...m, at: 'x' }, { at: 'x', unit: 'fixture-recycle.service', event: 'admin-issuance-closed-needs-reactivation',
        approved_edge_release_sha: sha, measured_edge_release_sha: null, reason: 'edge-measurement-failed' });
      assert.equal(statSync(markerFile).mode & 0o777, 0o644);
      assert.doesNotMatch(marker[0]!, /pass|token|secret|postgres(?:ql)?:\/\//i);
    } else {
      assert.equal(after.status, 0, after.stderr);
      assert.equal(lines(markerFile).length, 1, 'a good recycle writes no marker'); assert.equal(lines(journalFile).length, 1);
      assert.deepEqual(state(), { enabled: true, generation: 8, measured_generation: 8, invalidated: false });
    }
    assert.equal(readdirSync(secretRoot).length, 0, 'the complete shell hook cleans each private stage');
  }
  // An ordinary measurement failure whose readback is impossible is UNKNOWN, never CLOSED.
  { writeFileSync(stateFile, JSON.stringify(initial)); const markersBefore = lines(markerFile).length;
    assert.equal(hook('before').status, 0);
    const after = hook('after', true, { RECYCLE_FIXTURE_READBACK_FAILS: '1' });
    assert.notEqual(after.status, 0); assert.match(after.stderr, /issuance state UNKNOWN \(no confirming readback; may be OPEN\)/);
    assert.doesNotMatch(after.stderr, /CLOSED|stays closed/);
    const added = lines(markerFile).slice(markersBefore); assert.equal(added.length, 1); assert.equal(JSON.parse(added[0]!).event, 'admin-issuance-state-unknown'); }
  // The reopen COMMITS but its response is lost: the hook closes again and claims CLOSED only after the readback.
  for (const closeFails of [false, true]) {
    writeFileSync(stateFile, JSON.stringify(initial)); const markersBefore = lines(markerFile).length;
    assert.equal(hook('before').status, 0);
    const after = hook('after', false, { RECYCLE_FIXTURE_LOSE_REOPEN: '1', RECYCLE_FIXTURE_CLOSE_FAILS: closeFails ? '1' : '0' });
    assert.notEqual(after.status, 0);
    const added = lines(markerFile).slice(markersBefore); assert.equal(added.length, 1);
    if (closeFails) {
      assert.match(after.stderr, /FAIL recycle hook; issuance state UNKNOWN \(may be OPEN\); run ai-emergency-close/);
      assert.doesNotMatch(after.stderr, /stays closed|closed again/);
      assert.equal(state().enabled, true, 'the modelled refused close leaves the committed reopen OPEN');
      assert.equal(JSON.parse(added[0]!).event, 'admin-issuance-state-unknown');
    } else {
      assert.match(after.stderr, /FAIL recycle hook; reopen not confirmed; issuance closed again \(confirmed by readback\)/);
      assert.deepEqual({ enabled: state().enabled, invalidated: state().invalidated }, { enabled: false, invalidated: true });
      assert.equal(JSON.parse(added[0]!).event, 'admin-issuance-closed-needs-reactivation');
    }
  }
});


// Receipt admission owns stale-proof refusal. Only the remote DB/SSH boundary
// supplies observations; the complete plan validator and its callers execute.
test('edge-release-measurement-paths: stale-receipt-cannot-open; current receipt admits W5/W6 and later reopen', () => {
  const root = mkdtempSync(join(scratch, 'edge-admission-'));
  const shim = join(root, 'bin'); mkdirSync(shim);
  const observed = join(root, 'observed.json'), receipt = join(root, 'edge-measurement.json');
  const queries = join(root, 'queries.txt');
  const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  const imports = 'import json,os,pathlib,re,shlex,subprocess,sys\n';
  const boundary = `
def observe(args, **kwargs):
    query = kwargs['input']
    assert 'SET default_transaction_read_only=on;' in query
    assert 'release_generation,measured_generation,invalidated_at' in query
    remote = os.environ.get('EDGE_RECEIPT_REMOTE') == '1'
    assert args[:2] == (['ssh','-o'] if remote else ['/bin/bash','-s'])
    with open(os.environ['EDGE_QUERY_LOG'],'a') as log: log.write(('remote' if remote else 'box')+'\\n')
    return pathlib.Path(os.environ['EDGE_OBSERVED']).read_text()
subprocess.check_output = observe
`;
  // Wrapper substitutes observations only in the receipt block, including when
  // a caller extracts it from the actual plan. No fixture implements refusal.
  const wrapper = join(root, 'observe.py');
  writeFileSync(wrapper, `import sys\nsys.argv=sys.argv[1:]\nsource=sys.stdin.read()\nanchor=${JSON.stringify(imports)}\nboundary=${JSON.stringify(boundary)}\nexec(compile(source.replace(anchor,anchor+boundary),"<receipt-fixture>","exec"))\n`);
  writeFileSync(join(shim, 'python3'), `#!/bin/bash\nif test "$1" = -; then\nexec '${python}' '${wrapper}' "$@"\nelse\nexec '${python}' "$@"\nfi\n`, { mode: 0o700 });
  const target = '/home/commonswarm/edge/releases/'+sha;
  const current = { release_sha: sha, target, mount: target, image_digest: `sha256:${hex}`, artifact_digest: hex,
    generation: 8, invalidated_at: null };
  const row = { release_generation: 8, measured_generation: 8, invalidated_at: null,
    approved_edge_release_sha: sha, measured_edge_release_sha: sha, measured_edge_target: target,
    measured_mount: target, measured_image_digest: current.image_digest, measured_artifact_digest: hex };
  writeFileSync(observed, JSON.stringify(row));
  // Positive runs stop at the first operation after admission, through external
  // shell boundaries. They never create box paths or execute live operations.
  const stop = `printf 'ADMITTED\\n'; exit 0`;
  // The W5 site path's first operation after admission is its verified site-plan extraction;
  // the stub returns the stop as the extracted block, which the plan then evaluates.
  const harness = `ai_run() { case "$1" in ai-w6-readiness) :;; *) ${stop};; esac; }\ntest() { case "$*" in *'/home/commonswarm/admin-issuance/release-proofs/'*) ${stop};; *) builtin test "$@";; esac; }\ngit() { printf 'ADMITTED\\n' >&2; exit 0; }\npython3() { case "$1:$2" in -c:*SITE-RELEASE.md*) printf '%s\\n' "${stop}";; *) command python3 "$@";; esac; }\n`;
  writeFileSync(readyFile, 'nonsecret readiness\n'); utimesSync(readyFile, new Date(), new Date());
  const admissions: Array<[string, string, string]> = [
    ['W5 common open', 'ai-open', 'W5'], ['W6 open', 'ai-open', 'W6'], ['later reopen', 'ai-open', 'W7'],
    ['W5 site open', 'ai-w5-reference', 'W5'],
    ['W6 activation checks', 'ai-w6-activation-checks', 'W6'], ['W6 activation apply', 'ai-w6-activation-apply', 'W6'],
  ];
  for (const [name, step, window] of admissions) {
    const input: Input = { ...base(), window };
    if (window === 'W6') input.approval = approval(input, 'activate-admin-issuance-and-smoke');
    const env = { INPUTS_FILE: inputFile(input), PLAN_FILE: planPath, EDGE_MEASUREMENT_FILE: receipt,
      EDGE_OBSERVED: observed, EDGE_QUERY_LOG: queries, PATH: shim+':'+process.env.PATH,
      WINDOW: window, W5_CLOSED_FILE: closeFile, BROWSER_READY_FILE: readyFile,
      SITE_STEP: 'site2-01', SITE_RELEASE_REPO: root, PREP_DIR: root, SITE_RELEASE_SHA: sha };
    writeFileSync(receipt, JSON.stringify(current)); writeFileSync(queries, '');
    const positive = run(harness+block(step), env);
    // The stub stops right after admission. A status-contract block (ai-w6-activation-apply) did not run to its end,
    // so its trap reports that stop as UNKNOWN (2), never as success.
    assert.equal(positive.status, step === 'ai-w6-activation-apply' ? 2 : 0, `${name}: ${positive.stderr}`);
    assert.match(positive.stdout+positive.stderr, /ADMITTED/, name);
    assert.equal(readFileSync(queries,'utf8').trim(), step === 'ai-w5-reference' ? 'remote' : 'box', `${name} must re-read the box`);
    for (const [change, field] of [
      [{ generation: 7 }, 'generation'], [{ invalidated_at: '2026-10-03T12:00:00Z' }, 'invalidated_at'],
    ] as const) {
      writeFileSync(receipt, JSON.stringify({ ...current, ...change })); writeFileSync(queries, '');
      const negative = run(harness+block(step), env);
      assert.notEqual(negative.status, 0, `${name} accepted stale ${field}`);
      assert.ok(negative.stderr.includes(field), `${name} must name ${field}: ${negative.stderr}`);
      assert.doesNotMatch(negative.stdout, /ADMITTED/, `${name} operated after refusal`);
      assert.ok(readFileSync(queries,'utf8').trim(), `${name} refusal must use a fresh observation`);
    }
    // The edge-receipt runner executes only verified plan bytes: a substituted or symlinked plan stops first.
    writeFileSync(receipt, JSON.stringify(current));
    for (const [planFile, got] of [[substitutedPlan, 'digest-mismatch'], [linkedPlan, 'missing-or-not-regular']] as const) {
      writeFileSync(queries, '');
      const refused = run(harness+block(step), { ...env, PLAN_FILE: planFile });
      assert.notEqual(refused.status, 0, `${name} ran plan text from ${planFile}`);
      assert.ok(refused.stderr.includes(planRefusal(step, 'PLAN_FILE', got)), `${name}: ${refused.stderr}`);
      assert.doesNotMatch(refused.stdout + refused.stderr, /ADMITTED/); assert.equal(readFileSync(queries,'utf8'), '', `${name} read the box after refusal`);
    }
  }
  // A current-looking receipt is refused when the hook invalidated the box row.
  writeFileSync(receipt, JSON.stringify(current));
  const env = { INPUTS_FILE: inputFile(base()), EDGE_MEASUREMENT_FILE: receipt, EDGE_OBSERVED: observed,
    EDGE_QUERY_LOG: queries, PATH: shim+':'+process.env.PATH };
  for (const [change, field] of [
    [{ invalidated_at: '2026-10-03T12:00:00Z' }, 'invalidated_at'],
    [{ release_generation: 9, measured_generation: 9 }, 'generation'],
    [{ measured_generation: 7 }, 'generation'], [{ measured_edge_target: '/wrong' }, 'target'],
    [{ measured_edge_release_sha: 'c'.repeat(40) }, 'release_sha'],
  ] as const) {
    writeFileSync(observed, JSON.stringify({ ...row, ...change }));
    const refused = run(block('ai-edge-receipt'), env);
    assert.notEqual(refused.status, 0, `box drift ${field} admitted`);
    assert.ok(refused.stderr.includes(field), refused.stderr);
  }
  writeFileSync(observed, JSON.stringify(row));
  assert.equal(run(block('ai-edge-receipt'), env).status, 0);
});

// Execute the receipt-writing portions against independent DB observations;
// verify the emitted activation transaction binds that specific generation.
test('edge-release-measurement-paths: W4 records generation and W6 binds the freshly remeasured activation receipt', () => {
  const root = mkdtempSync(join(scratch, 'generation-write-'));
  const receipt = join(root, 'edge-measurement.json');
  const target = '/home/commonswarm/edge/releases/'+sha;
  const measured = { release_sha: sha, target, mount: target, image_digest: `sha256:${hex}`, artifact_digest: hex };
  const w4 = block('ai-w4-apply');
  const start = w4.indexOf('EDGE_MEASUREMENT_GENERATION=');
  const end = w4.indexOf('cmp -s /etc/caddy/sites/', start);
  assert.ok(start > 0 && end > start);
  const source = w4.slice(start, end);
  writeFileSync(receipt, JSON.stringify(measured));
  const env = { PROOF_DIR: root, OBSERVED_GENERATION: '14' };
  const read = `ai_ro() { printf '%s\\n' "$OBSERVED_GENERATION"; }\n`;
  const recorded = run('set -euo pipefail\n'+read+source, env);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { ...measured, generation: 14, invalidated_at: null });
  assert.notEqual(run('set -euo pipefail\n'+read+source, { ...env, OBSERVED_GENERATION: '' }).status, 0);
  const apply = block('ai-w6-activation-apply');
  // W6 apply's receipt now comes only from the shared ai-edge-remeasure (tested in admin-release-w6-ready.test.ts).
  const refreshStart = apply.indexOf('EDGE_MEASUREMENT_OUT=$PROOF_DIR/edge-measurement.json');
  const refreshEnd = apply.indexOf('python3 - "$SECRET_STAGE/service.env"', refreshStart);
  const sqlStart = apply.indexOf('python3 - "$INPUTS_FILE" "$PROOF_DIR/activate.sql"');
  const sqlEnd = apply.indexOf('ai_db -q --file /proof/activate.sql', sqlStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart && sqlStart > refreshEnd && sqlEnd > sqlStart);
  assert.doesNotMatch(apply, /commonswarm-admin-edge-recycle (?:before|after)/, 'W6 apply runs the hook only through ai-edge-remeasure');
  const supplied = join(root, 'supplied.json'); writeFileSync(supplied, readFileSync(receipt));
  rmSync(receipt);
  const remeasure = `ai_run() { test "$1" = ai-edge-remeasure || return 1; python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); m.update(generation=int(sys.argv[3]),invalidated_at=None); open(sys.argv[2],"x").write(json.dumps(m,sort_keys=True)+"\\n")' "$EDGE_MEASUREMENT_FILE" "$EDGE_MEASUREMENT_OUT" "$OBSERVED_GENERATION"; }\n`;
  const result = run('set -euo pipefail\n'+read+remeasure+apply.slice(refreshStart, refreshEnd)+apply.slice(sqlStart, sqlEnd), {
    ...env, OBSERVED_GENERATION: '15', EDGE_MEASUREMENT_FILE: supplied, INPUTS_FILE: inputFile(base()),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { ...measured, generation: 15, invalidated_at: null });
  assert.equal(JSON.parse(readFileSync(supplied, 'utf8')).generation, 14, 'prior receipt is retained');
  const sql = readFileSync(join(root, 'activate.sql'), 'utf8');
  assert.match(sql, /PERFORM 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE; IF/,
    'hold the generation row lock from receipt comparison through activation UPDATE');
  assert.match(sql, /AND release_generation=15 AND measured_generation=release_generation AND invalidated_at IS NULL/,
    'a completed recycle after the receipt was read must refuse the final activation transaction');
});

test('admin release plan: ai-extract and ai_run extract only from plan bytes bound to INPUTS plan_sha256', () => {
  const prep = mkdtempSync(join(scratch, 'extract-')), inputs = inputFile(base());
  const extract = (planFile: string) => run(block('ai-extract'), { PLAN_FILE: planFile, STEP_ID: 'ai-gates', PREP_DIR: prep, INPUTS_FILE: inputs });
  const good = extract(planPath); assert.equal(good.status, 0, good.stderr);
  assert.equal(readFileSync(join(prep, 'step.sh'), 'utf8'), block('ai-gates')); rmSync(join(prep, 'step.sh'));
  for (const [planFile, got] of [[substitutedPlan, 'digest-mismatch'], [linkedPlan, 'missing-or-not-regular']] as const) {
    const refused = extract(planFile); assert.notEqual(refused.status, 0);
    assert.ok(refused.stderr.includes(planRefusal('ai-extract', 'PLAN_FILE', got)), refused.stderr);
    assert.ok(!existsSync(join(prep, 'step.sh')), 'no extracted step after refusal');
  }
  // ai_run (ai-db-session) reads the released plan copy; it must match the same digest.
  const session = block('ai-db-session'), dispatcher = session.slice(session.indexOf('ai_run() {'), session.indexOf('ai_deadline() {'));
  const stage = mkdtempSync(join(scratch, 'airun-')), released = mkdtempSync(join(scratch, 'released-'));
  const releasedPlan = join(released, 'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
  mkdirSync(dirname(releasedPlan), { recursive: true });
  const callGates = () => run(dispatcher + 'ai_run ai-gates\n', { RELEASE_ROOT: released, SECRET_STAGE: stage, INPUTS_FILE: inputs });
  writeFileSync(releasedPlan, readFileSync(substitutedPlan));
  let r = callGates(); assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(planRefusal('ai_run', 'released RELEASE.md', 'digest-mismatch')), r.stderr);
  assert.ok(!existsSync(join(stage, 'step-ai-gates.sh')), 'substituted step never written or sourced');
  assert.doesNotMatch(r.stderr, /GATE_RECEIPT_FILE/, 'substituted plan text never evaluated');
  rmSync(releasedPlan); symlinkSync(planPath, releasedPlan);
  r = callGates(); assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(planRefusal('ai_run', 'released RELEASE.md', 'missing-or-not-regular')), r.stderr);
  assert.ok(!existsSync(join(stage, 'step-ai-gates.sh')));
  // Positive control: the verified ai-gates block is evaluated from memory (it then refuses
  // on its own unset GATE_RECEIPT_FILE); no staged step file is written or reread.
  rmSync(releasedPlan); writeFileSync(releasedPlan, plan);
  r = callGates(); assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE_RECEIPT_FILE/); assert.doesNotMatch(r.stderr, /FAIL ai_run/);
  assert.deepEqual(readdirSync(stage), [], 'nothing staged');
});

test('admin release plan: ai-extract refuses a symlinked step target or a FIFO plan; reads by one non-following fd', () => {
  const prep = mkdtempSync(join(scratch, 'extract-fd-')), inputs = inputFile(base());
  const extract = (planFile: string) => run(block('ai-extract'), { PLAN_FILE: planFile, STEP_ID: 'ai-gates', PREP_DIR: prep, INPUTS_FILE: inputs });
  const good = extract(planPath); assert.equal(good.status, 0, good.stderr);
  assert.equal(readFileSync(join(prep, 'step.sh'), 'utf8'), block('ai-gates')); rmSync(join(prep, 'step.sh'));
  // A symlink swapped in at the staged path is never followed or written through.
  const victim = join(prep, 'victim.txt'); writeFileSync(victim, 'must survive\n'); symlinkSync(victim, join(prep, 'step.sh'));
  let r = extract(planPath); assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('FAIL ai-extract: step.sh expected writable-regular-file got symlink-or-unwritable; STOP'), r.stderr);
  assert.equal(readFileSync(victim, 'utf8'), 'must survive\n'); rmSync(join(prep, 'step.sh'));
  // A FIFO plan is refused without blocking (O_NONBLOCK + fstat S_ISREG).
  const fifo = join(prep, 'plan.fifo'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  r = extract(fifo); assert.notEqual(r.status, 0); assert.equal(r.signal, null);
  assert.ok(r.stderr.includes(planRefusal('ai-extract', 'PLAN_FILE', 'missing-or-not-regular')), r.stderr);
  assert.ok(!existsSync(join(prep, 'step.sh')));
});

test('admin release plan: W5 companion site plan comes only from the verified release archive and is evaluated from memory', () => {
  const root = mkdtempSync(join(scratch, 'site-ref-')), prep = join(root, 'prep'), repoDir = join(root, 'site-repo');
  mkdirSync(prep); const sitePath = 'docs/evidence/2026-10-02-site-release/SITE-RELEASE.md';
  const fence = '```';
  const sitePlan = `# Site fixture\n\n${fence}sh\n# step: site-release-shared-preflight\nW5_SITE_MARK=shared-preflight\n${fence}\n\n${fence}sh\n# step: site2-plan-inputs\nW5_SITE_MARK=from-archive\n${fence}\n\n${fence}sh\n# step: site2-02 — fixture\nprintf 'site2-02 ran\\n'\n${fence}\n`;
  const staging = join(root, 'tree'); mkdirSync(dirname(join(staging, sitePath)), { recursive: true }); writeFileSync(join(staging, sitePath), sitePlan);
  mkdirSync(dirname(join(repoDir, sitePath)), { recursive: true }); writeFileSync(join(repoDir, sitePath), sitePlan);
  const tar = join(prep, 'release.tar');
  const made = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname=sys.argv[3])', tar, join(staging, sitePath), sitePath], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const inputs = join(root, 'inputs.json'); writeFileSync(inputs, JSON.stringify({ ...base(), window: 'W5', archive_sha256: digest(readFileSync(tar)) }));
  const reference = (step: string) => run(block('ai-w5-reference') + '\nprintf "mark=%s\\n" "${W5_SITE_MARK:-unset}"\n',
    { SITE_STEP: step, SITE_RELEASE_REPO: repoDir, PREP_DIR: prep, INPUTS_FILE: inputs, SITE_RELEASE_SHA: sha });
  // Positive: the archive block is evaluated in this shell (its variable persists).
  let r = reference('site-release-shared-preflight'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /mark=shared-preflight/);
  r = reference('site2-plan-inputs'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /mark=from-archive/);
  r = reference('site2-02'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /site2-02 ran/);
  assert.deepEqual(readdirSync(prep).sort(), ['release.tar'], 'no staged site-plan.md or site-step.sh');
  const refused = (out: ReturnType<typeof run>, text: string) => {
    assert.notEqual(out.status, 0); assert.ok(out.stderr.includes(text), out.stderr);
    assert.doesNotMatch(out.stdout, /mark=|site2-02 ran|substituted/);
  };
  // Substituted companion bytes in the archive: digest mismatch stops before any block runs.
  const saved = readFileSync(tar);
  writeFileSync(tar, saved.toString('latin1').replace('W5_SITE_MARK=from-archive', 'printf substituted;:     '), 'latin1');
  refused(reference('site2-plan-inputs'), 'FAIL ai-w5-reference: PREP_DIR/release.tar bytes expected input-archive_sha256 got mismatch; STOP');
  writeFileSync(tar, saved);
  // A symlinked archive is never followed.
  const moved = join(root, 'moved.tar'); writeFileSync(moved, saved); rmSync(tar); symlinkSync(moved, tar);
  refused(reference('site2-plan-inputs'), 'FAIL ai-w5-reference: PREP_DIR/release.tar expected absolute-regular-file got missing-or-not-regular; STOP');
  rmSync(tar); writeFileSync(tar, saved);
  // After source checkout the repository copy must equal the archive bytes; a substituted or symlinked copy stops.
  writeFileSync(join(repoDir, sitePath), sitePlan.replace("site2-02 ran", 'substituted'));
  refused(reference('site2-02'), 'FAIL ai-w5-reference: SITE_RELEASE_REPO SITE-RELEASE.md expected archive-bytes got different-or-unreadable; STOP');
  rmSync(join(repoDir, sitePath)); writeFileSync(join(root, 'real-site.md'), sitePlan); symlinkSync(join(root, 'real-site.md'), join(repoDir, sitePath));
  refused(reference('site2-02'), 'FAIL ai-w5-reference: SITE_RELEASE_REPO SITE-RELEASE.md expected archive-bytes got different-or-unreadable; STOP');
});

// Deterministic pathname-replacement regression for the shared plan reader. The harness
// swaps the path for a symlink to substituted bytes immediately after the reader's first
// metadata check (os.fstat for the fd reader; Path.is_file for the old pathname reader).
const READER_SWAP_HARNESS = String.raw`
import json,os,pathlib,stat,sys
helper,target,other,mode=sys.argv[1:5]
state={'swapped':False}
def swap():
    if mode!='swap' or state['swapped']: return
    state['swapped']=True
    os.rename(target,target+'.orig')   # the original inode survives under another name
    os.symlink(other,target)
real_fstat=os.fstat
def fstat(fd):
    result=real_fstat(fd); swap(); return result
os.fstat=fstat
real_is_file=pathlib.Path.is_file
def is_file(self):
    result=real_is_file(self); swap(); return result
pathlib.Path.is_file=is_file
ns={'os':os,'stat':stat,'pathlib':pathlib}
exec(open(helper).read(),ns)
out=ns['read_regular'](target)
print(json.dumps({'swapped':state['swapped'],'result':None if out is None else out.decode()}))
`;
// The pre-round-3 reader shape, kept only as the regression's negative control.
const OLD_PATHNAME_READER = `def read_regular(name):
    p=pathlib.Path(name); ok=p.is_absolute() and not p.is_symlink() and p.is_file()
    return p.read_bytes() if ok else None
`;
test('admin release plan: shared plan reader survives a path swap after its metadata check; the old pathname reader does not', () => {
  // Every site carries the same reader (quote style aside).
  const readers = [...plan.matchAll(/^def read_regular\(name\):\n(?: {4}.*\n)+/gm)].map(m => m[0].replace(/"/g, "'"));
  assert.equal(readers.length, 22, 'one shared reader at all 22 sites (21 plan-text sites, including the W5 recovered-close validator, ai-w2b-preflight, ai-w2b-proof-check, ai-edge-remeasure, ai-edge-refresh and ai-w6-fence-driver, and ai-w2-backfill)');
  assert.equal(new Set(readers).size, 1, 'all readers identical');
  const dir = mkdtempSync(join(scratch, 'reader-swap-'));
  const shared = join(dir, 'shared-reader.py'); writeFileSync(shared, readers[0]!);
  const old = join(dir, 'old-reader.py'); writeFileSync(old, OLD_PATHNAME_READER);
  const harness = join(dir, 'harness.py'); writeFileSync(harness, READER_SWAP_HARNESS);
  const attempt = (reader: string, mode: string) => {
    const case_ = mkdtempSync(join(dir, 'case-')), target = join(case_, 'RELEASE.md'), other = join(case_, 'substituted.md');
    writeFileSync(target, 'verified plan bytes\n'); writeFileSync(other, 'substituted plan bytes\n');
    const r = spawnSync('python3', [harness, reader, target, other, mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) as { swapped: boolean; result: string | null };
  };
  // Positive control: no swap, the shared reader returns the file's bytes.
  assert.deepEqual(attempt(shared, 'none'), { swapped: false, result: 'verified plan bytes\n' });
  // Swap after the metadata check: the single fd still reads the verified inode.
  const swapped = attempt(shared, 'swap'); assert.equal(swapped.swapped, true, 'the hook fired');
  assert.ok(swapped.result === 'verified plan bytes\n' || swapped.result === null, `shared reader followed the swap: ${JSON.stringify(swapped)}`);
  // Negative control: the old is_symlink/is_file/read_bytes reader follows the swap, so this
  // same assertion would fail if that sequence were restored.
  const regressed = attempt(old, 'swap'); assert.equal(regressed.swapped, true);
  assert.equal(regressed.result, 'substituted plan bytes\n', 'old pathname reader reads through the swapped-in symlink');
});

// ---- W2 backfill evidence kinds (ai-w2-backfill) ----
// Real production ledger statement arrays (read-only measurement, public migration SQL)
// with the file text at the commit the matcher selected.
type LedgerFixture = { version: string; matched_sha: string; file: string; file_at_matched_sha: string; statements: string[] };
const ledgerFixtures = (JSON.parse(readFileSync(resolve('tests/fixtures/c1-ledger-statements.json'), 'utf8')) as { rows: LedgerFixture[] }).rows;
const ATTESTATION = 'HezLead fixture attestation: no release record and no recorded ledger statements; file bytes at RELEASE_SHA adopted as the UNVERIFIED drift baseline; does not claim the applied SQL equals the file.';
const MEANING = 'attested-baseline: no release record and no recorded statements; file bytes at RELEASE_SHA adopted as UNVERIFIED drift baseline';
function backfillPython() {
  const source = block('ai-w2-backfill'); return source.split("<<'PY'\n")[1]!.split('\nPY\n')[0]!;
}
function coverFunction() {
  const py = backfillPython();
  return py.slice(py.indexOf('def verbatim_cover('), py.indexOf('def tar_member('));
}
function covers(cases: Array<[string, string[]]>) {
  const r = spawnSync('python3', ['-c', 'import json,sys\nexec(sys.argv[1])\nprint(json.dumps([verbatim_cover(t.encode(),s) for t,s in json.loads(sys.stdin.read())]))', coverFunction()],
    { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) as boolean[];
}
test('admin release plan: W2 ledger-statements match is an ordered verbatim cover, proven on real recorded arrays', () => {
  // Positive: real production arrays are covered by their files (identical to RELEASE_SHA's).
  assert.deepEqual(covers(ledgerFixtures.map(r => [r.file_at_matched_sha, r.statements] as [string, string[]])), ledgerFixtures.map(() => true));
  for (const r of ledgerFixtures) assert.equal(readFileSync(r.file, 'utf8'), r.file_at_matched_sha, `${r.version} file at this checkout equals the covered bytes`);
  const multi = ledgerFixtures.find(r => r.statements.length >= 3)!;
  const [s0, s1, ...rest] = multi.statements as [string, string, ...string[]];
  const file = multi.file_at_matched_sha;
  const results = covers([
    [file, [s1, s0, ...rest]],                                      // a statement reordered
    [file, [s0.slice(0, -1) + (s0.endsWith('x') ? 'y' : 'x'), s1, ...rest]], // one byte changed
    [file.replace(s1, '-- injected comment\n' + s1), multi.statements], // a comment in a gap
    [file.replace(s1, 'SELECT 1;\n' + s1), multi.statements],           // other text in a gap
    [file, [s0, ...rest]],                                           // a stored statement missing (its text left uncovered)
    [file, [...multi.statements, 'SELECT 1']],                       // an extra stored statement
    [file, [s0, '', s1, ...rest]],                                   // an empty stored statement
    ['\n;  ' + file + '\n;;\n', multi.statements],                   // only whitespace/semicolons around: still a cover
  ]);
  assert.deepEqual(results, [false, false, false, false, false, false, false, true]);
});

function backfillFixture() {
  const root = mkdtempSync(join(scratch, 'backfill-')), proof = join(root, 'proof'), archives = join(root, 'historical'), tree = join(root, 'tree');
  mkdirSync(proof); mkdirSync(archives); mkdirSync(join(tree, 'supabase/migrations'), { recursive: true });
  const repoFile = (v: string) => 'supabase/migrations/' + readdirSync('supabase/migrations').find(n => n.startsWith(v + '_'))!;
  const tar = (out: string, files: Record<string, string | Buffer>) => {
    const dir = mkdtempSync(join(root, 'tar-'));
    for (const [name, bytes] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), bytes); }
    const made = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    [t.add(sys.argv[2]+"/"+m,arcname=m) for m in sys.argv[3:]]', out, dir, ...Object.keys(files)], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  };
  const [loop, queue, bucket] = ledgerFixtures as [LedgerFixture, LedgerFixture, LedgerFixture];
  const historicalSha = 'c'.repeat(40);
  const relRelease = repoFile('20261001000001'), relAttested = repoFile('20260928000003');
  // Release archive (RELEASE_SHA): files read for matched_sha==RELEASE_SHA and attested rows.
  const releaseArchive = join(root, 'release.tar');
  const releaseFiles: Record<string, string | Buffer> = { [loop.file]: loop.file_at_matched_sha, [queue.file]: queue.file_at_matched_sha, [bucket.file]: bucket.file_at_matched_sha, [relAttested]: readFileSync(relAttested) };
  tar(releaseArchive, releaseFiles);
  tar(join(archives, historicalSha + '.tar'), { [relRelease]: readFileSync(relRelease) });
  const rows: Record<string, unknown>[] = [
    { version: '20261001000001', evidence_kind: 'release-record', released_sha: historicalSha, sha256: digest(readFileSync(relRelease)), file: relRelease },
    { version: loop.version, evidence_kind: 'ledger-statements', file: loop.file, matched_sha: sha, sha256: digest(loop.file_at_matched_sha) },
    { version: queue.version, evidence_kind: 'ledger-statements', file: queue.file, matched_sha: sha, sha256: digest(queue.file_at_matched_sha) },
    { version: bucket.version, evidence_kind: 'ledger-statements', file: bucket.file, matched_sha: sha, sha256: digest(bucket.file_at_matched_sha) },
    { version: '20260928000003', evidence_kind: 'attested-baseline', file: relAttested, sha256: digest(readFileSync(relAttested)), attested_by: 'HezLead', attested_at: '2026-10-03T20:00:00Z', reason: ATTESTATION },
  ];
  const statements: Record<string, string[] | null> = { '20261001000001': null, [loop.version]: loop.statements, [queue.version]: queue.statements, [bucket.version]: bucket.statements, '20260928000003': null };
  const inputs = join(root, 'inputs.json'); writeFileSync(inputs, JSON.stringify({ archive_sha256: digest(readFileSync(releaseArchive)) }));
  function run_(change: { rows?: Record<string, unknown>[]; statements?: Record<string, string[] | null> } = {}) {
    const useRows = change.rows ?? rows, useStatements = change.statements ?? statements;
    for (const name of ['backfill.json', 'backfill-evidence.json']) if (existsSync(join(proof, name))) rmSync(join(proof, name));
    writeFileSync(join(root, 'backfill.json'), JSON.stringify(useRows));
    const versions = Object.keys(useStatements).sort();
    writeFileSync(join(proof, 'ledger-before.txt'), versions.join('\n') + '\n');
    writeFileSync(join(root, 'ledger.jsonl'), versions.map(v => JSON.stringify({ version: v, statements: useStatements[v] })).join('\n') + '\n');
    // Read-only database boundary: the stub answers only the statements query.
    const harness = `ai_ro() { case "$*" in *"json_build_object('version',version,'statements',statements)"*) cat '${join(root, 'ledger.jsonl')}';; *) return 1;; esac; }\n`;
    return run(harness + block('ai-w2-backfill'), { WINDOW: 'W2', PROOF_DIR: proof, BACKFILL_FILE: join(root, 'backfill.json'), HISTORICAL_ARCHIVES_DIR: archives,
      RELEASE_SHA: sha, BOX_ARCHIVE_PATH: releaseArchive, INPUTS_FILE: inputs, RELEASE_ROOT: resolve('.') });
  }
  // Rebuild the verified release archive (and its input digest) with replaced files.
  const releaseWith = (files: Record<string, string | Buffer>) => { tar(releaseArchive, { ...releaseFiles, ...files }); writeFileSync(inputs, JSON.stringify({ archive_sha256: digest(readFileSync(releaseArchive)) })); };
  return { root, proof, archives, rows, statements, run: run_, tar, queue, releaseWith, releaseFiles };
}
test('admin release plan: W2 backfill validates release-record, ledger-statements and attested-baseline rows; refuses bad evidence', () => {
  const f = backfillFixture();
  // Positive (all three kinds): every row validates; per-version provenance and per-kind counts
  // are retained in backfill-evidence.json and its digest is printed in the PASS line.
  const mixed = f.run();
  assert.equal(mixed.status, 0, mixed.stderr);
  const evidenceBytes = readFileSync(join(f.proof, 'backfill-evidence.json'));
  const evidence = JSON.parse(evidenceBytes.toString());
  assert.deepEqual(evidence.counts, { 'release-record': 1, 'ledger-statements': 3, 'attested-baseline': 1 });
  assert.equal(evidence.versions['20260928000003'].reason, ATTESTATION, 'the row reason is retained verbatim');
  assert.equal(evidence.versions[f.queue.version].match, 'ordered-verbatim-cover');
  assert.equal(evidence.attested_meaning, MEANING);
  assert.ok(mixed.stdout.includes('20260928000003 ' + MEANING), 'the plan prints its own fixed meaning line');
  assert.ok(mixed.stdout.includes('PASS ai-w2-backfill: release-record=1, ledger-statements=3, attested-baseline=1; backfill-evidence.json sha256=' + digest(evidenceBytes)));
  // Positive (release-record only): unchanged rule passes.
  const only = f.run({ rows: [f.rows[0]!], statements: { '20261001000001': null } });
  assert.equal(only.status, 0, only.stderr); assert.match(only.stdout, /PASS ai-w2-backfill/);
  assert.equal(JSON.parse(readFileSync(join(f.proof, 'backfill.json'), 'utf8')).length, 1);
  const refused = (out: ReturnType<typeof run>, text: string) => {
    assert.notEqual(out.status, 0); assert.ok(out.stderr.includes(text), `${text}\n${out.stderr}`); assert.doesNotMatch(out.stderr, /Traceback/);
    assert.ok(!existsSync(join(f.proof, 'backfill.json')) && !existsSync(join(f.proof, 'backfill-evidence.json')), 'no proof after refusal');
  };
  const withRow = (i: number, change: Record<string, unknown>) => f.rows.map((r, j) => j === i ? { ...r, ...change } : r);
  // Wrong bytes at matched_sha: the verified release archive's file no longer covers the ledger.
  const wrongText = f.queue.file_at_matched_sha.replace(/;\s*$/, ';\nSELECT 1;\n');
  f.releaseWith({ [f.queue.file]: wrongText });
  refused(f.run({ rows: withRow(2, { sha256: digest(wrongText) }) }), `FAIL ai-w2-backfill: ledger statements for ${f.queue.version} expected ordered-verbatim-cover-by-file-at-RELEASE_SHA got mismatch; STOP`);
  f.releaseWith({});
  refused(f.run({ rows: withRow(2, { sha256: 'f'.repeat(64) }) }), `FAIL ai-w2-backfill: sha256 of ${f.queue.file} at matched_sha expected row-sha256 got mismatch; STOP`);
  refused(f.run({ rows: withRow(2, { matched_sha: '9'.repeat(40) }) }), `FAIL ai-w2-backfill: matched_sha for ${f.queue.version} expected RELEASE_SHA got other; STOP`);
  refused(f.run({ statements: { ...f.statements, [f.queue.version]: null } }), `FAIL ai-w2-backfill: ledger statements for ${f.queue.version} expected non-empty got null-or-empty; STOP`);
  // Kind (c) with non-empty recorded statements must be kind (b).
  refused(f.run({ statements: { ...f.statements, '20260928000003': ['SELECT 1'] } }), 'FAIL ai-w2-backfill: ledger statements for attested-baseline 20260928000003 expected null-or-empty got non-empty; the row must be ledger-statements; STOP');
  refused(f.run({ rows: withRow(4, { attested_by: 'Tom' }) }), 'FAIL ai-w2-backfill: attested_by for 20260928000003 expected HezLead got other; STOP');
  for (const reason of ['', '   ', 'two\nlines', 'tab\there', 'x'.repeat(2001), 7])
    refused(f.run({ rows: withRow(4, { reason }) }), 'FAIL ai-w2-backfill: reason for 20260928000003 expected non-empty-single-line-at-most-2000-chars got other; STOP');
  for (const attested_at of [new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), '2026-10-03T20:00:00.000Z', '2026-13-40T99:00:00Z', null])
    refused(f.run({ rows: withRow(4, { attested_at }) }), 'FAIL ai-w2-backfill: attested_at for 20260928000003 expected UTC-Z-not-future got other; STOP');
  refused(f.run({ rows: withRow(4, { sha256: 'f'.repeat(64) }) }), 'FAIL ai-w2-backfill: sha256 of ' + (f.rows[4] as { file: string }).file + ' at RELEASE_SHA expected row-sha256 got mismatch; STOP');
  // Set-level refusals.
  refused(f.run({ statements: { ...f.statements, '20261002000001': null } }), 'FAIL ai-w2-backfill: backfill rows expected every-ledger-version got missing-1; STOP');
  refused(f.run({ rows: [...f.rows, f.rows[1]!] }), `FAIL ai-w2-backfill: backfill row ${f.queue.version === (f.rows[1] as { version: string }).version ? f.queue.version : (f.rows[1] as { version: string }).version} expected one-row got duplicate; STOP`);
  refused(f.run({ rows: withRow(0, { evidence_kind: 'guess' }) }), 'FAIL ai-w2-backfill: evidence_kind for 20261001000001 expected release-record|ledger-statements|attested-baseline got unknown; STOP');
  refused(f.run({ rows: withRow(0, { matched_sha: 'c'.repeat(40) }) }), 'FAIL ai-w2-backfill: release-record row keys for 20261001000001 expected exact-kind-keys got other-set; STOP');
  refused(f.run({ rows: [...f.rows, { ...f.rows[0]!, version: '20260101000001' }] }), 'FAIL ai-w2-backfill: backfill row 20260101000001 expected ledger-version got not-in-ledger; STOP');
  // Kind (a) drift STOP is kept: the historical bytes must equal the current file.
  f.tar(join(f.archives, 'c'.repeat(40) + '.tar'), { [(f.rows[0] as { file: string }).file]: 'drifted\n' });
  refused(f.run({ rows: withRow(0, { sha256: digest('drifted\n') }) }), 'FAIL historical/current migration drift; STOP');
});

test('admin release plan: W2 M4 records ledger-statements/attested-baseline backfills at RELEASE_SHA and refuses unknown kinds', () => {
  const f = w2Fixture();
  try {
    assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
    const [first, second] = f.old as unknown as [Record<string, string>, Record<string, string>];
    const statementRow = { version: first.version, evidence_kind: 'ledger-statements', file: first.file, matched_sha: sha, sha256: first.sha256 };
    writeFileSync(join(f.proof, 'backfill.json'), JSON.stringify([statementRow, second]));
    const result = run(f.harness + block('ai-w2-apply'), f.env);
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(join(f.proof, 'db-checksums'), 'utf8').trim().split('\n');
    assert.ok(rows.includes([first.version, first.sha256, 'backfill', sha].join('|')), 'ledger-statements row recorded at RELEASE_SHA');
    assert.ok(rows.includes([second.version, second.sha256, 'backfill', second.released_sha].join('|')), 'release-record row keeps its released_sha');
    assert.ok(existsSync(join(f.proof, 'schema-committed.txt')), 'reconcile accepts the recorded convention');
  } finally { f.clean(); }
  const g = w2Fixture();
  try {
    assert.equal(run(g.harness + block('ai-w2-measure'), g.env).status, 0);
    writeFileSync(join(g.proof, 'backfill.json'), JSON.stringify([{ ...g.old[0], evidence_kind: 'guess' }, g.old[1]]));
    const refused = run(g.harness + block('ai-w2-apply'), g.env);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /FAIL ai-w2-apply: backfill evidence_kind expected known-kind got other; STOP/);
    assert.ok(!existsSync(join(g.proof, 'submitted.sql')), 'no SQL submitted');
  } finally { g.clean(); }
});


// End to end with the final W2 evidence picture: 68 ledger versions = 20 release-record,
// 46 ledger-statements (real recorded statements as byte spans of the file at RELEASE_SHA)
// and 2 attested-baseline rows (HezLead's real attestations).
test('admin release plan: W2 backfill end to end on the real 68-version ledger (20/46/2)', () => {
  type Ledger = { version: string; file: string; file_sha256: string; statement_spans: Array<[number, number]> | null };
  const picture = JSON.parse(readFileSync(resolve('tests/fixtures/c1-backfill-w2.json'), 'utf8')) as {
    release_sha: string; release_records: Record<string, string>; attested_baseline: string[];
    attestations: Array<{ version: string; attested_by: string; attested_at: string; reason: string }>; ledger: Ledger[] };
  const root = mkdtempSync(join(scratch, 'backfill-e2e-')), proof = join(root, 'proof'), archives = join(root, 'historical');
  mkdirSync(proof); mkdirSync(archives);
  const bytes = (file: string) => readFileSync(file);
  for (const l of picture.ledger) assert.equal(digest(bytes(l.file)), l.file_sha256, `${l.file} equals the file at RELEASE_SHA`);
  const tarFiles = (out: string, files: string[]) => {
    const made = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    [t.add(m,arcname=m) for m in sys.argv[2:]]', out, ...files], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  };
  const releaseArchive = join(root, 'release.tar'); tarFiles(releaseArchive, picture.ledger.map(l => l.file));
  const bySha: Record<string, string[]> = {};
  for (const l of picture.ledger) { const r = picture.release_records[l.version]; if (r) (bySha[r] ??= []).push(l.file); }
  for (const [commit, files] of Object.entries(bySha)) tarFiles(join(archives, commit + '.tar'), files);
  const attestation = Object.fromEntries(picture.attestations.map(a => [a.version, a]));
  const rows = picture.ledger.map(l => {
    if (picture.release_records[l.version]) return { version: l.version, evidence_kind: 'release-record', released_sha: picture.release_records[l.version], sha256: l.file_sha256, file: l.file };
    if (l.statement_spans) return { version: l.version, evidence_kind: 'ledger-statements', file: l.file, matched_sha: picture.release_sha, sha256: l.file_sha256 };
    const a = attestation[l.version]!; return { version: l.version, evidence_kind: 'attested-baseline', file: l.file, sha256: l.file_sha256, attested_by: a.attested_by, attested_at: a.attested_at, reason: a.reason };
  });
  const statements = Object.fromEntries(picture.ledger.map(l => [l.version, l.statement_spans ? l.statement_spans.map(([a, b]) => bytes(l.file).subarray(a, b).toString('utf8')) : null]));
  const inputs = join(root, 'inputs.json'); writeFileSync(inputs, JSON.stringify({ archive_sha256: digest(readFileSync(releaseArchive)) }));
  const go = (useRows: Record<string, unknown>[], useStatements: Record<string, string[] | null> = statements) => {
    for (const name of ['backfill.json', 'backfill-evidence.json']) if (existsSync(join(proof, name))) rmSync(join(proof, name));
    writeFileSync(join(root, 'backfill.json'), JSON.stringify(useRows));
    const versions = Object.keys(useStatements).sort();
    writeFileSync(join(proof, 'ledger-before.txt'), versions.join('\n') + '\n');
    writeFileSync(join(root, 'ledger.jsonl'), versions.map(v => JSON.stringify({ version: v, statements: useStatements[v] })).join('\n') + '\n');
    const harness = `ai_ro() { case "$*" in *"json_build_object('version',version,'statements',statements)"*) cat '${join(root, 'ledger.jsonl')}';; *) return 1;; esac; }\n`;
    return run(harness + block('ai-w2-backfill'), { WINDOW: 'W2', PROOF_DIR: proof, BACKFILL_FILE: join(root, 'backfill.json'), HISTORICAL_ARCHIVES_DIR: archives,
      RELEASE_SHA: picture.release_sha, BOX_ARCHIVE_PATH: releaseArchive, INPUTS_FILE: inputs, RELEASE_ROOT: resolve('.') });
  };
  assert.equal(picture.ledger.length, 68);
  const result = go(rows);
  assert.equal(result.status, 0, result.stderr);
  const record = readFileSync(join(proof, 'backfill-evidence.json'));
  const evidence = JSON.parse(record.toString());
  assert.deepEqual(evidence.counts, { 'release-record': 20, 'ledger-statements': 46, 'attested-baseline': 2 });
  assert.deepEqual(Object.keys(evidence.versions).sort(), picture.ledger.map(l => l.version).sort());
  assert.equal(evidence.versions['20260928000003'].evidence_kind, 'release-record', 'the W6-required 20260928000003 has a release record');
  for (const v of picture.attested_baseline) { assert.ok(result.stdout.includes(v + ' ' + MEANING)); assert.equal(evidence.versions[v].reason, attestation[v]!.reason); }
  assert.ok(result.stdout.includes('PASS ai-w2-backfill: release-record=20, ledger-statements=46, attested-baseline=2; backfill-evidence.json sha256=' + digest(record)));
  // The real mix still refuses set-level and per-kind defects.
  const bad = (out: ReturnType<typeof run>, text: string) => { assert.notEqual(out.status, 0); assert.ok(out.stderr.includes(text), out.stderr); assert.ok(!existsSync(join(proof, 'backfill-evidence.json'))); };
  bad(go(rows.slice(1)), 'FAIL ai-w2-backfill: backfill rows expected every-ledger-version got missing-1; STOP');
  const ls = rows.find(r => r.evidence_kind === 'ledger-statements')!;
  bad(go([...rows, ls]), `FAIL ai-w2-backfill: backfill row ${ls.version} expected one-row got duplicate; STOP`);
  const firstStatement = picture.ledger.find(l => l.version === ls.version)!;
  bad(go(rows, { ...statements, [ls.version]: [...statements[ls.version]!].reverse() }), `FAIL ai-w2-backfill: ledger statements for ${ls.version} expected ordered-verbatim-cover-by-file-at-RELEASE_SHA got mismatch; STOP`);
  const att = picture.attested_baseline[0]!;
  bad(go(rows, { ...statements, [att]: ['SELECT 1'] }), `FAIL ai-w2-backfill: ledger statements for attested-baseline ${att} expected null-or-empty got non-empty; the row must be ledger-statements; STOP`);
  assert.ok(firstStatement.statement_spans!.length >= 1);
});

// ---- W2 probe credentials: refresh-per-probe, retry policy, pre-fence probe, revoke ----
const oauthState = (f: ReturnType<typeof w2Fixture>) => JSON.parse(readFileSync(join(f.proof, 'oauth-state.json'), 'utf8'));
test('admin release plan: W2 probes refresh per call, persist the rotated token before use, and revoke the DCR family', () => {
  const f = w2Fixture();
  try {
    assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
    const result = run(f.harness + block('ai-w2-apply'), f.env); assert.equal(result.status, 0, result.stderr);
    const state = oauthState(f);
    assert.equal(state.calls.refresh, 9, 'one refresh per probe (6) plus the three replay-revoke steps');
    assert.equal(state.calls['revoke-step'], 3, 'rotate, replay, proof: exactly one call each');
    for (const point of ['prefence', ...w2Versions]) assert.equal(state.calls['refresh:' + point], 1, point);
    assert.deepEqual(readFileSync(join(f.proof, 'persist-order'), 'utf8').trim().split('\n'), Array(6).fill('persisted'), 'rotated token on disk before each use');
    assert.equal(state.revoked, true, 'the consumed-token replay revoked the grant');
    assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoked.json'), 'utf8')), { client_id: 'dcr-probe-client', revoked: true, proof: 'refresh rejected' });
    const stored = JSON.parse(readFileSync(join(f.stage, 'ordinary-probes.json'), 'utf8'));
    assert.equal(stored.mcp_refresh_token, state.current, 'the newest rotated token is retained');
    assert.equal(statSync(join(f.stage, 'ordinary-probes.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.stage).sort(), ['ordinary-probes.json'], 'no temporary token file left');
    const pre = JSON.parse(readFileSync(join(f.proof, 'between-prefence.json'), 'utf8'));
    assert.equal(pre.rotation, true); assert.equal(pre.refreshed, true);
    for (const text of [result.stdout, result.stderr]) { assert.doesNotMatch(text, /rt-\d|at-\d|synthetic-human/); }
    for (const name of readdirSync(f.proof)) if (name !== 'oauth-state.json' && name !== 'http-calls' && name !== 'persist-order') assert.doesNotMatch(readFileSync(join(f.proof, name), 'utf8'), /rt-\d|at-\d|synthetic-human/, `${name} holds a secret`);
  } finally { f.clean(); }
});
test('admin release plan: W2 refresh failure stops before the next migration without retry; initialize transport error retries once', () => {
  const f = w2Fixture();
  try {
    assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
    const result = run(f.harness + block('ai-w2-apply'), { ...f.env, REFRESH_FAIL_POINT: w2Versions[1]! });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`FAIL ai-w2-between-probes: ${w2Versions[1]} refresh grant expected HTTP-200-Bearer-rotation got HTTP-400; STOP before next migration`));
    assert.equal(oauthState(f).calls['refresh:' + w2Versions[1]], 1, 'the refresh grant is never retried');
    assert.ok(!existsSync(join(f.proof, `apply-${w2Versions[2]}.sql`)), 'no later migration');
    assert.ok(existsSync(join(f.proof, 'dcr-probe-revoked.json')), 'the EXIT guard revoked the family');
  } finally { f.clean(); }
  const g = w2Fixture();
  try {
    assert.equal(run(g.harness + block('ai-w2-measure'), g.env).status, 0);
    const result = run(g.harness + block('ai-w2-apply'), { ...g.env, INIT_TRANSPORT_FAIL_ONCE: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(oauthState(g).calls.initialize, 7, 'one retry of the failed initialize, none elsewhere');
    assert.ok(existsSync(join(g.proof, 'schema-committed.txt')));
  } finally { g.clean(); }
});
test('admin release plan: W2 pre-fence probe proves the revoke preconditions (refresh 200 with rotation) or stops before apply-started', () => {
  for (const [fault, text] of [
    [{ REFRESH_FAIL_POINT: 'prefence' }, 'FAIL ai-w2-between-probes: prefence refresh grant expected HTTP-200-Bearer-rotation got HTTP-400; STOP before the apply-started fence'],
    [{ ROTATION_OFF: '1' }, 'FAIL ai-w2-between-probes: prefence refresh rotation expected new-refresh-token got same-refresh-token; STOP before the apply-started fence'],
  ] as const) {
    const f = w2Fixture();
    try {
      assert.equal(run(f.harness + block('ai-w2-measure'), f.env).status, 0);
      const result = run(f.harness + block('ai-w2-apply'), { ...f.env, ...fault });
      assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(text), result.stderr);
      assert.ok(!existsSync(join(f.proof, 'apply-started.txt')), 'no fence'); assert.ok(!existsSync(join(f.proof, 'submitted.sql')), 'nothing applied');
      if ('REFRESH_FAIL_POINT' in fault) assert.ok(existsSync(join(f.proof, 'dcr-probe-revoked.json')), 'revoked on the pre-fence exit');
      else {
        // Without rotation the replay revocation cannot work: the exit revoke is REVOKE-UNPROVEN, never a partial apply.
        assert.match(result.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: step 1 rotation refresh expected HTTP-200-new-token-or-400-invalid_grant got HTTP-200/);
        assert.match(result.stderr, /FAIL ai-w2-apply: DCR probe grant revoke on exit expected proven got failed; STOP/);
      }
    } finally { f.clean(); }
  }
});

// ai-w2-stage-probes (Mac): validation before any write, one ssh upload, digest-only check, guarded removal.
test('admin release plan: W2 stage-probes validates the credential file, uploads it once and removes the local copy', () => {
  // A fresh fixture root per case: the test itself never deletes plan-owned files.
  const block_ = block('ai-w2-stage-probes');
  const stageCase = (creds: Record<string, unknown> | string, mode = 0o600, env: Record<string, string> = {}) => {
    const root = mkdtempSync(join(scratch, 'stage-probes-')), work = join(root, 'c1-run'), shim = join(root, 'shim'), box = join(root, 'box'), pyShim = join(root, 'pyshim');
    for (const d of [work, shim, box, pyShim]) mkdirSync(d);
    // ssh: the upload installs stdin and writes the probe-staged marker; the proof write records the box proof.
    writeFileSync(join(shim, 'ssh'), `#!/bin/bash
printf '%s\\n' "$*" >>'${join(root, 'ssh-calls')}'
case "\${@: -1}" in
 *ordinary-probes.json*install*/dev/stdin*)
  if test -n "\${SSH_FAIL:-}"; then cat >/dev/null; exit 255; fi
  cat >'${join(box, 'ordinary-probes.json')}'; date >'${join(box, 'probe-staged.txt')}'
  if test -n "\${BOX_CORRUPT:-}"; then printf x >>'${join(box, 'ordinary-probes.json')}'; fi
  printf '600 %s\\n' "$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' '${join(box, 'ordinary-probes.json')}')";;
 *dcr-probe-revoked.json*) python3 -c 'import json,sys; c=sys.argv[1].split(" ")[-1]; print("box proof write recorded")' "$*" >/dev/null; printf 'written\\n' >'${join(box, 'proof-write')}';;
 *) exit 9;;
esac
`, { mode: 0o700 });
    // Deletion guard stand-in, as the dry-run fixtures stub the host guard: only the exact local
    // credential path, only "--", never -r/-f; it can be told to refuse.
    writeFileSync(join(shim, 'rm'), `#!/bin/bash
printf '%s\\n' "$*" >>'${join(root, 'rm-calls')}'
if test -n "\${RM_REFUSE:-}"; then printf 'rm guard refused %s\\n' "$2" >&2; exit 1; fi
if test "$#" != 2 || test "$1" != -- || test "$2" != '${join(work, 'probe-credentials-W2-Abc123.json')}'; then printf 'rm guard refused unexpected operands\\n' >&2; exit 1; fi
exec /bin/rm -- "$2"
`, { mode: 0o700 });
    writeFileSync(join(pyShim, 'sitecustomize.py'), `import io,json,os,urllib.error,urllib.parse,urllib.request
LOG=${JSON.stringify(join(root, 'issuer-calls'))}; I='https://mcp.commonswarm.com'
class R:
    def __init__(self,data,status=200,raw=None): self.data=data; self.status=status; self.raw=raw
    def __enter__(self): return self
    def __exit__(self,*a): pass
    def read(self,n): return self.raw if self.raw is not None else json.dumps(self.data).encode()
class O:
    def open(self,req,timeout):
        url=req.full_url; form=dict(urllib.parse.parse_qsl(req.data.decode())) if req.data else {}
        with open(LOG,'a') as f: f.write(url+'\\n')
        revoked=os.path.exists(LOG+'.revoked')
        if url.endswith('oauth-authorization-server'):
            if os.environ.get('DISCOVERY_MALFORMED'): return R(None,200,b'not json')
            return R({'issuer':I,'token_endpoint':I+'/token'})
        if url==I+'/token':
            st=json.load(open(LOG+'.state')) if os.path.exists(LOG+'.state') else {'current':'rt-secret','consumed':[],'revoked':False,'n':0}
            t=form['refresh_token']
            def done(): json.dump(st,open(LOG+'.state','w'))
            def bad(): done(); raise urllib.error.HTTPError(url,400,'x',{},io.BytesIO(b'{"error":"invalid_grant"}'))
            if st['revoked']: bad()
            if t in st['consumed']:
                if os.environ.get('REPLAY_200'):
                    st['n']+=1; st['current']='rt-local-'+str(st['n']); done()
                    return R({'token_type':'Bearer','access_token':'at-new','refresh_token':st['current'],'expires_in':300,'scope':'mcp'})
                st['revoked']=True; bad()
            if t!=st['current']: bad()
            st['consumed'].append(t); st['n']+=1; st['current']='rt-local-'+str(st['n']); done()
            return R({'token_type':'Bearer','access_token':'at-new','refresh_token':st['current'],'expires_in':300,'scope':'mcp'})
        raise AssertionError('unmodelled '+url)
urllib.request.build_opener=lambda *a: O()
`);
    const input = { ...base(), window: 'W2', rollback_decision: 'retain-additive', probe_workspace_id: 'c2ea0541-f56d-4c73-bf71-56c5405c4934' };
    const inputs = join(root, 'inputs.json'); writeFileSync(inputs, JSON.stringify(input));
    const file = join(work, 'probe-credentials-W2-Abc123.json');
    const end = Math.floor(Date.parse(input.window_end_utc as string) / 1000);
    const value = typeof creds === 'string' ? creds : JSON.stringify({ ...goodCreds(end), ...creds });
    writeFileSync(file, value, { mode }); chmodSync(file, mode);
    const source = block_.split('/Users/yulanbot/.local/bin/rm').join(join(shim, 'rm')).split('/Users/yulanbot/work/c1-run/').join(work + '/');
    assert.ok(!source.includes('/Users/yulanbot/'), 'fixture rewrites every Mac literal');
    const out = run(source, { INPUTS_FILE: inputs, PLAN_FILE: planPath, PATH: shim + ':' + process.env.PATH, PYTHONPATH: pyShim, ...env });
    const lines = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n') : [];
    return { out, root, box, file, end, lines, issuer: () => lines('issuer-calls').map(l => l.replace('https://mcp.commonswarm.com', '')) };
  };
  const goodCreds = (end: number) => ({ release_sha: sha, window_id: 'Abc123', workspace_id: 'c2ea0541-f56d-4c73-bf71-56c5405c4934', mcp_client_id: 'dcr-probe-client',
    mcp_refresh_token: 'rt-secret', mcp_resource: 'https://mcp.commonswarm.com/mcp', human_access_token: 'human-secret', human_token_exp: end + 300 });
  // Positive: one ssh call, bytes and marker on the box, local copy removed through the guard.
  const ok = stageCase({}); assert.equal(ok.out.status, 0, ok.out.stderr);
  assert.match(ok.out.stdout, /PASS ai-w2-stage-probes/); assert.ok(!existsSync(ok.file), 'local copy removed');
  assert.equal(ok.lines('ssh-calls').length, 1, 'one ssh call'); assert.deepEqual(ok.lines('rm-calls'), ['-- ' + ok.file], 'deleted only through the guard');
  assert.deepEqual(JSON.parse(readFileSync(join(ok.box, 'ordinary-probes.json'), 'utf8')), goodCreds(ok.end)); assert.ok(existsSync(join(ok.box, 'probe-staged.txt')));
  assert.doesNotMatch(ok.lines('ssh-calls').join('\n') + ok.out.stdout + ok.out.stderr, /rt-secret|human-secret/, 'no secret in argv or output');
  // Validation failures: nothing written, no revoke (the token was never used), local file kept.
  const refused = (c: ReturnType<typeof stageCase>, text: string) => {
    assert.notEqual(c.out.status, 0); assert.ok(c.out.stderr.includes(text), c.out.stderr);
    assert.deepEqual(c.lines('ssh-calls'), [], 'no W2 write before validation passes'); assert.ok(existsSync(c.file), 'local file retained');
  };
  refused(stageCase({ extra: 1 }), 'FAIL ai-w2-stage-probes: probe credentials keys expected probe-contract-keys got other-set; STOP before any W2 write');
  refused(stageCase({}, 0o644), 'FAIL ai-w2-stage-probes: probe credentials file expected 0600-regular-file-owned-by-caller got other-mode-or-owner; STOP before any W2 write');
  refused(stageCase({ release_sha: 'e'.repeat(40) }), 'FAIL ai-w2-stage-probes: probe credentials release_sha expected input-release-sha got mismatch; STOP before any W2 write');
  refused(stageCase({ window_id: 'Zzz999' }), 'FAIL ai-w2-stage-probes: probe credentials window_id expected input-window-id got mismatch; STOP before any W2 write');
  refused(stageCase({ workspace_id: '11111111-1111-1111-1111-111111111111' }), 'FAIL ai-w2-stage-probes: probe credentials workspace_id expected input-probe-workspace-id got mismatch; STOP before any W2 write');
  { const c = stageCase({ human_token_exp: 0 }); refused(c, 'FAIL ai-w2-stage-probes: human_token_exp expected window_end_utc-plus-300s got shorter; STOP before any W2 write'); }
  { const c = stageCase({ human_token_exp: '9999999999' }); refused(c, 'FAIL ai-w2-stage-probes: human_token_exp expected window_end_utc-plus-300s got shorter; STOP before any W2 write'); }
  // Every post-validation failure revokes by replay (rotate, replay, proof: one call each) and removes the local copy.
  for (const [env, reason] of [[{ BOX_CORRUPT: '1' }, 'box ordinary-probes.json expected 0600-and-same-sha256 got mismatch'], [{ SSH_FAIL: '1' }, 'ssh upload expected success got failure']] as const) {
    const c = stageCase({}, 0o600, env);
    assert.notEqual(c.out.status, 0); assert.ok(c.out.stderr.includes(`FAIL ai-w2-stage-probes: ${reason}; revoking the probe grant; STOP`), c.out.stderr);
    assert.match(c.out.stderr, /STOP ai-w2-stage-probes: probe grant revoked and local copy removed; a retry needs a new DCR grant/);
    assert.deepEqual(c.issuer(), ['/.well-known/oauth-authorization-server', '/token', '/token', '/token']);
    assert.ok(!existsSync(c.file)); assert.deepEqual(c.lines('rm-calls'), ['-- ' + c.file]);
    if ('BOX_CORRUPT' in env) assert.ok(existsSync(join(c.box, 'proof-write')), 'box proof recorded for the uploaded copy');
    assert.doesNotMatch(c.out.stdout + c.out.stderr, /rt-secret|human-secret/);
  }
  // Finding 1: a guarded-rm refusal AFTER a matching upload still revokes before STOP.
  { const c = stageCase({}, 0o600, { RM_REFUSE: '1' });
    assert.notEqual(c.out.status, 0);
    assert.ok(c.out.stderr.includes('FAIL ai-w2-stage-probes: guarded rm of local probe credentials refused; revoking the probe grant; STOP'), c.out.stderr);
    assert.deepEqual(c.issuer(), ['/.well-known/oauth-authorization-server', '/token', '/token', '/token'], 'revoked from the local copy');
    assert.ok(existsSync(join(c.box, 'proof-write')), 'the box copy is recorded as revoked');
    assert.match(c.out.stderr, /FAIL ai-w2-stage-probes: guarded rm of the \(revoked\) local probe credentials refused/);
    assert.ok(existsSync(c.file), 'the guard kept the (now revoked) file'); }
  // Unproven revoke: REVOKE-UNPROVEN, rotated token kept 0600, one attempt only (a rerun refuses at once).
  { const c = stageCase({}, 0o600, { BOX_CORRUPT: '1', REPLAY_200: '1' });
    assert.notEqual(c.out.status, 0); assert.match(c.out.stderr, /REVOKE-UNPROVEN ai-w2-stage-probes: local revoke step 2 consumed-token replay expected HTTP-400-invalid_grant got HTTP-200; local file retained 0600 for HezLead; never retried automatically; STOP/);
    assert.deepEqual(c.issuer(), ['/.well-known/oauth-authorization-server', '/token', '/token'], 'one call per step, no retry');
    assert.ok(existsSync(c.file)); assert.equal(statSync(c.file).mode & 0o777, 0o600); assert.equal(JSON.parse(readFileSync(c.file, 'utf8')).mcp_refresh_token, 'rt-local-2', 'newest issued token kept');
    assert.deepEqual(c.lines('rm-calls'), [], 'no deletion while the grant may be live');
    assert.ok(existsSync(c.file + '.revoke-attempted'), 'single-attempt marker'); }
  // Finding 4: a malformed HTTP-200 discovery body is not retried; nothing is revoked or deleted.
  { const c = stageCase({}, 0o600, { BOX_CORRUPT: '1', DISCOVERY_MALFORMED: '1' });
    assert.notEqual(c.out.status, 0); assert.match(c.out.stderr, /FAIL ai-w2-stage-probes: local revoke discovery expected HTTP-200-issuer-metadata got other; STOP/);
    assert.deepEqual(c.issuer(), ['/.well-known/oauth-authorization-server'], 'exactly one discovery request');
    assert.ok(!existsSync(c.file + '.revoke-attempted')); assert.ok(existsSync(c.file)); }
});


test('admin release plan: W2 replay revoke: normal path proven; step-1 invalid_grant and server misbehavior unproven; one call per step', () => {
  const revoke = (f: ReturnType<typeof w2Fixture>, env: Record<string, string> = {}) => run(f.harness + portable(block('ai-w2-revoke-probes'), { stage: 1, pointer: 0 }), { ...f.env, ...env });
  const proofOf = (f: ReturnType<typeof w2Fixture>) => JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoked.json'), 'utf8'));
  // Normal: rotate (200, new token persisted), replay the consumed token (400, grant revoked), new token rejected (proof).
  { const f = w2Fixture();
    try {
      const result = revoke(f); assert.equal(result.status, 0, result.stderr);
      const state = oauthState(f);
      assert.equal(state.calls['revoke-step'], 3); assert.equal(state.revoked, true);
      assert.equal(JSON.parse(readFileSync(join(f.stage, 'ordinary-probes.json'), 'utf8')).mcp_refresh_token, state.current, 'rotated token persisted');
      assert.deepEqual(proofOf(f), { client_id: 'dcr-probe-client', revoked: true, proof: 'refresh rejected' });
      assert.doesNotMatch(result.stdout + result.stderr, /rt-\d/);
    } finally { f.clean(); } }
  // Step 1 invalid_grant never proves anything: neither after a lost rotation (held token consumed)
  // nor when the held token is unknown while the family is still live. REVOKE-UNPROVEN, no proof.
  for (const [label, state, held] of [
    ['lost rotation', { current: 'rt-5', access: 'at-5', n: 5, revoked: false, consumed: ['rt-0', 'rt-1', 'rt-2', 'rt-3', 'rt-4'], destroyed: [], calls: {} }, 'rt-4'],
    ['unknown held token, family live', { current: 'rt-5', access: 'at-5', n: 5, revoked: false, consumed: [], destroyed: [], calls: {} }, 'rt-unknown'],
  ] as const) {
    const f = w2Fixture();
    try {
      writeFileSync(join(f.proof, 'oauth-state.json'), JSON.stringify(state));
      const creds = JSON.parse(readFileSync(join(f.stage, 'ordinary-probes.json'), 'utf8'));
      writeFileSync(join(f.stage, 'ordinary-probes.json'), JSON.stringify({ ...creds, mcp_refresh_token: held }), { mode: 0o600 });
      const result = revoke(f); assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: step 1 rotation refresh got HTTP-400-invalid_grant; the held token cannot prove the family revoked; STOP/);
      assert.equal(oauthState(f).calls['revoke-step'], 1, `${label}: step 1 only, the same token is never presented twice`);
      assert.ok(!existsSync(join(f.proof, 'dcr-probe-revoked.json')), `${label}: no proof`);
      assert.equal(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoke-unproven.json'), 'utf8')).status, 'REVOKE-UNPROVEN');
      if (label === 'unknown held token, family live') {
        assert.equal(oauthState(f).revoked, false, 'the live family survived: a proof here would have been false');
        // Negative control: the live family's own token still refreshes at the issuer.
        assert.equal(oauthState(f).current, 'rt-5');
      }
    } finally { f.clean(); } }
  const unproven = (env: Record<string, string>, reason: string, steps: number) => {
    const f = w2Fixture();
    try {
      const result = revoke(f, env); assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes('REVOKE-UNPROVEN ai-w2-revoke-probes: ' + reason + '; STOP'), result.stderr);
      assert.equal(oauthState(f).calls['revoke-step'], steps, 'exactly one call per step, no retry');
      assert.ok(!existsSync(join(f.proof, 'dcr-probe-revoked.json')));
      assert.equal(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoke-unproven.json'), 'utf8')).reason, reason);
      const stored = JSON.parse(readFileSync(join(f.stage, 'ordinary-probes.json'), 'utf8'));
      assert.equal(stored.mcp_refresh_token, oauthState(f).current, 'the newest token the server issued is kept for HezLead');
    } finally { f.clean(); }
  };
  // The server did not revoke on replay (replay returns 200).
  unproven({ REPLAY_200: '1' }, 'step 2 consumed-token replay expected HTTP-400-invalid_grant got HTTP-200', 2);
  // The replay was rejected but the grant survived: the proof refresh returns 200.
  unproven({ REPLAY_NO_REVOKE: '1' }, 'step 3 proof refresh expected HTTP-400-invalid_grant got HTTP-200', 3);
});


test('admin release plan: W2 revoke is one durable attempt; an unproven revoke is REVOKE-UNPROVEN and never re-run', () => {
  const f = w2Fixture();
  try {
    const revoke = () => run(f.harness + portable(block('ai-w2-revoke-probes'), { stage: 1, pointer: 0 }), { ...f.env, TRANSPORT_ON_REFRESH: '1' });
    const first = revoke();
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: step 1 rotation refresh got transport-error-not-retried; STOP; HezLead revokes the DCR probe grant by client_id; never retried automatically/);
    assert.ok(existsSync(join(f.proof, 'dcr-probe-revoke-attempted.txt')) && !existsSync(join(f.proof, 'dcr-probe-revoked.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoke-unproven.json'), 'utf8')), { client_id: 'dcr-probe-client', revoked: false, status: 'REVOKE-UNPROVEN', reason: 'step 1 rotation refresh got transport-error-not-retried' });
    const calls = readFileSync(join(f.proof, 'http-calls'), 'utf8');
    const again = revoke();
    assert.notEqual(again.status, 0); assert.match(again.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: a started revoke is never re-run/);
    assert.equal(readFileSync(join(f.proof, 'http-calls'), 'utf8'), calls, 'no request on a started revoke');
    assert.equal(oauthState(f).calls['revoke-step'], 1, 'one grant request in total');
  } finally { f.clean(); }
  // In ai-w2-apply the EXIT guard does not re-run the started revoke.
  const g = w2Fixture();
  try {
    assert.equal(run(g.harness + block('ai-w2-measure'), g.env).status, 0);
    // Six probe refreshes succeed; the seventh refresh (revoke step 1) loses its response.
    const result = run(g.harness + block('ai-w2-apply'), { ...g.env, TRANSPORT_ON_REFRESH: '7' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: step 1 rotation refresh got transport-error-not-retried/);
    assert.match(result.stderr, /REVOKE-UNPROVEN ai-w2-revoke-probes: a started revoke is never re-run/);
    assert.match(result.stderr, /FAIL ai-w2-apply: DCR probe grant revoke on exit expected proven got failed; STOP/);
    assert.equal(oauthState(g).calls['revoke-step'], 1, 'the guard made no second grant request');
  } finally { g.clean(); }
});
test('admin release plan: W2 probe-staged marker makes preflight, early apply and open-abort exits revoke or refuse', () => {
  // Preflight STOP right after staging (missing BACKFILL_FILE): the preflight EXIT guard revokes.
  const f = w2Fixture();
  try {
    const result = run(f.harness + portable(block('ai-w2-preflight'), { stage: 0, pointer: 0 }), f.env);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /BACKFILL_FILE/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoked.json'), 'utf8')), { client_id: 'dcr-probe-client', revoked: true, proof: 'refresh rejected' });
    assert.equal(oauthState(f).revoked, true);
  } finally { f.clean(); }
  // Early ai-w2-apply STOP (no lock measurements): the apply guard revokes before anything else.
  const g = w2Fixture();
  try {
    const result = run(g.harness + block('ai-w2-apply'), g.env);
    assert.notEqual(result.status, 0); assert.ok(!existsSync(join(g.proof, 'apply-started.txt')));
    assert.ok(existsSync(join(g.proof, 'dcr-probe-revoked.json')), 'revoked on the early apply exit');
  } finally { g.clean(); }
  // Without the marker nothing is staged: the guard passes without any grant request.
  const h = w2Fixture();
  try {
    rmSync(join(h.proof, 'probe-staged.txt'));
    const result = run(h.harness + block('ai-w2-apply'), h.env);
    assert.notEqual(result.status, 0); assert.match(result.stdout, /PASS ai-w2-revoke-probes: no DCR probe grant was staged/);
    assert.ok(!existsSync(join(h.proof, 'http-calls')), 'no request without a staged grant');
  } finally { h.clean(); }
  // ai-open-abort refuses once a probe grant was staged (the recovered ai-close revokes it).
  const root = mkdtempSync(join(scratch, 'abort-')); writeFileSync(join(root, 'probe-staged.txt'), 'x\n');
  const abort = run(block('ai-open-abort'), { PROOF_DIR: root });
  assert.notEqual(abort.status, 0); assert.match(abort.stderr, /FAIL ai-open-abort: a W2 DCR probe grant was staged; use the recovered ai-close, which revokes it; STOP/);
});

test('admin release plan: W2 ai-close revokes a staged DCR probe grant before CLOSE_RESULT is checked', () => {
  const f = w2Fixture();
  try {
    const close = portable(block('ai-close'), { stage: 2, pointer: 0 });
    const env: Record<string, string> = { ...f.env }; delete env.CLOSE_RESULT;
    const result = run(f.harness + close, env);
    assert.notEqual(result.status, 0, 'close still stops without CLOSE_RESULT');
    assert.match(result.stderr, /CLOSE_RESULT/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'dcr-probe-revoked.json'), 'utf8')), { client_id: 'dcr-probe-client', revoked: true, proof: 'refresh rejected' });
    assert.equal(oauthState(f).revoked, true); assert.ok(!existsSync(join(f.proof, 'closed.txt')));
  } finally { f.clean(); }
});

// ---- W2 before-apply catalogs must not depend on objects W2 creates (production W2 yPolVl, release 835b7ae8) ----
const W2_VERSIONS = ['20261003000001', '20261003000002', '20261003000003', '20261003000004', '20261003000005'] as const;
const itemAiProof = (name: string) => readFileSync(resolve('deploy/release-proofs/item-ai', name), 'utf8');
// One catalog row: its label and its exact text, from the row opener to the last character before the separator.
const catalogRows = (sql: string) => {
  const body = sql.split('WITH checks(label,ok) AS (VALUES\n')[1]!.split('\n)\nSELECT ')[0]!;
  return new Map(body.split(/\n(?= {1,2}\('2026100300000[1-5]-)/).map(row => {
    const text = row.replace(/,$/, '');
    return [/^ {1,2}\('([^']+)'/.exec(text)![1]!, text] as const;
  }));
};
// Reverse rows that assert what a reserve KEEPS: they can never hold before apply.
const RESERVE_KEPT: Record<string, RegExp> = {
  '20261003000002': /^20261003000002-rollback-0(?:2[6-9]|3[0-3])-/,
  '20261003000005': /^20261003000005-private-tables$/,
};
const BEFORE_ADDED: Record<string, string[]> = {
  '20261003000002': ['20261003000002-before-026-commonswarm_admin_issuer-absent'],
  '20261003000005': ['20261003000005-before-private-tables-absent'],
};

test('admin release plan: W2 preflight reads one reviewed before-apply catalog per version from the release archive', () => {
  const pre = block('ai-w2-preflight');
  const start = pre.indexOf('for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do\n BEFORE_CATALOG=');
  assert.ok(start > 0, 'the before loop covers all five versions');
  const loop = pre.slice(start, pre.indexOf('\ndone\n', start) + 6);
  assert.match(loop, /^ BEFORE_CATALOG=\/release\/deploy\/release-proofs\/item-ai\/\$VERSION-before-catalog\.sql$/m);
  assert.match(loop, /SELECT :\\x27before_ok\\x27::boolean;/);
  assert.doesNotMatch(pre, /rollback-catalog|before-20261003000002|\/proof\/before-/, 'no derived or reverse catalog in the before proof');
  assert.doesNotMatch(loop, /if test "\$VERSION"/, 'no per-version special case');
  // The loop STOPs with its own message for the first before-apply catalog that is not true.
  const dir = mkdtempSync(join(scratch, 'before-loop-'));
  const runLoop = (falseFor: string) => run(`set -euo pipefail\nai_ro() { case "$(cat "$PROOF_DIR/catalog.sql")" in *${falseFor}-before-catalog.sql*) printf 'f\\n';; *-before-catalog.sql*) printf 't\\n';; *) printf 'unexpected\\n';; esac; }\n${loop}`, { PROOF_DIR: dir });
  assert.equal(runLoop('none').status, 0);
  for (const v of W2_VERSIONS) {
    const stop = runLoop(v); assert.notEqual(stop.status, 0, v);
    assert.match(stop.stderr, new RegExp(`FAIL ai-w2-preflight: before-apply catalog for ${v} expected t got other; STOP`));
  }
});

test('admin release plan: each W2 before-apply catalog keeps the reverse rows byte for byte except the reserve-kept rows', () => {
  for (const v of W2_VERSIONS) {
    const before = catalogRows(itemAiProof(`${v}-before-catalog.sql`)), reverse = catalogRows(itemAiProof(`${v}-rollback-catalog.sql`));
    const expectedShared = [...reverse.keys()].filter(label => !RESERVE_KEPT[v]?.test(label));
    assert.deepEqual([...before.keys()], [...expectedShared, ...(BEFORE_ADDED[v] ?? [])], v);
    for (const label of expectedShared) assert.equal(before.get(label), reverse.get(label), `${label} row text`);
    for (const label of BEFORE_ADDED[v] ?? []) assert.ok(label.startsWith(`${v}-before-`), label);
    assert.ok(itemAiProof(`${v}-before-catalog.sql`).endsWith(`SELECT :'before_ok_checks_ok'::boolean AS before_ok\n\\gset\n`), v);
  }
  // Control: the exclusion pattern removes exactly the reserve-kept rows, no more.
  assert.equal([...catalogRows(itemAiProof('20261003000002-rollback-catalog.sql')).keys()].filter(l => RESERVE_KEPT['20261003000002']!.test(l)).length, 8);
  assert.equal([...catalogRows(itemAiProof('20261003000005-rollback-catalog.sql')).keys()].filter(l => RESERVE_KEPT['20261003000005']!.test(l)).length, 1);
});

test('admin release plan: W2 before and reverse catalogs never raise on a missing W2 role, schema or object', () => {
  // Name casts and name-based privilege calls raise when the name does not exist. Only builtins
  // and roles that exist before W2 may be named that way; everything else goes through to_reg* or catalog joins.
  const castAllowed = new Set(["'pg_authid'::regclass", "'jsonb'::regtype"]);
  const preW2Roles = new Set(['swarm_read', 'authenticated', 'anon']);
  const lint = (sql: string) => {
    const problems: string[] = [];
    for (const [cast] of sql.matchAll(/'[^']*'::reg[a-z]+/g)) if (!castAllowed.has(cast)) problems.push(cast);
    // Up to two levels of nested parentheses: has_function_privilege(r.oid,to_regprocedure('f(x)'),'EXECUTE').
    const calls = [...sql.matchAll(/has_[a-z_]+_privilege\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)];
    // Coverage: every privilege call is linted, none is skipped by the pattern.
    if (calls.length !== (sql.match(/has_[a-z_]+_privilege\(/g) ?? []).length) problems.push('unlinted privilege call');
    for (const [call, args] of calls) {
      // A name inside to_reg*() is NULL-safe; only the call's own quoted arguments are name lookups that raise.
      const direct = args!.replace(/to_reg[a-z]+\('[^']*'\)/g, '');
      if ([...direct.matchAll(/'([^']*)'/g)].some(([, name]) => !/^[A-Z ,]+$/.test(name!) && !preW2Roles.has(name!))) problems.push(call);
    }
    return problems;
  };
  for (const v of W2_VERSIONS) for (const kind of ['before', 'rollback']) {
    assert.deepEqual(lint(itemAiProof(`${v}-${kind}-catalog.sql`)), [], `${v}-${kind}-catalog.sql`);
  }
  // Controls: the 835b7ae8 row shapes that raised before W2 are rejected.
  assert.equal(lint("NOT has_schema_privilege('commonswarm_admin_release','commonswarm_ops','USAGE')").length, 1);
  assert.equal(lint("WHERE member='commonswarm_admin_issuer'::regrole").length, 1);
  assert.equal(lint("NOT has_function_privilege('anon','swarm_read.admin_recovery_page(text,uuid,integer,text)','EXECUTE')").length, 1);
  assert.deepEqual(lint("has_table_privilege('swarm_read',c.oid,'SELECT') AND p.prorettype='jsonb'::regtype"), []);
  assert.equal(lint("has_function_privilege('commonswarm_admin_issuer',to_regprocedure('f(text)'),'EXECUTE')").length, 1, 'a nested call is linted');
  // The real 0005 reverse row (two nesting levels) is reached by the lint, not skipped.
  const reverse5 = itemAiProof('20261003000005-rollback-catalog.sql');
  assert.ok(reverse5.includes("has_function_privilege(r.oid,to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)'),'EXECUTE')"));
  assert.equal(lint(reverse5.replace("has_function_privilege(r.oid,", "has_function_privilege('commonswarm_admin_issuer',")).length, 1);
});

test('admin release plan: W2 before-apply 20261003000002 catalog proves absence without casting to the missing issuer role', () => {
  const sql = itemAiProof('20261003000002-before-catalog.sql');
  assert.doesNotMatch(sql, /::regrole/, 'no cast to a role the window creates');
  // Minimal evaluator for exactly the predicate forms this catalog may contain.
  const evaluate = (present: Set<string>) => [...sql.matchAll(/\('([^']+)', COALESCE\(\(\n([\s\S]*?)\n  \),false\)\)/g)].map(([, label, body]) => {
    const text = body!.split('\n').filter(l => !l.trim().startsWith('--')).join(' ').trim();
    let m = /^to_reg(?:class|procedure|type|role)\('([^']+)'\) IS (NOT )?NULL$/.exec(text);
    if (m) return [label!, m[2] ? present.has(m[1]!) : !present.has(m[1]!)] as const;
    m = /^NOT EXISTS\(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass\('([^']+)'\) AND tgname='([^']+)' AND NOT tgisinternal\)$/.exec(text);
    if (m) return [label!, !(present.has(m[1]!) && present.has(m[1]! + '#' + m[2]!))] as const;
    throw new Error(`unmodelled predicate in ${label}: ${text}`);
  });
  const beforeW2 = new Set(['swarm.admin_events', 'swarm.admin_grants', 'commonswarm_oauth.refresh_family_tombstones']);
  const ok = evaluate(beforeW2);
  assert.equal(ok.length, 26); assert.ok(ok.every(([, v]) => v), 'role absent before apply: PASS');
  const withIssuer = evaluate(new Set([...beforeW2, 'commonswarm_admin_issuer']));
  assert.deepEqual(withIssuer.filter(([, v]) => !v).map(([l]) => l), ['20261003000002-before-026-commonswarm_admin_issuer-absent'], 'role present before apply: STOP');
});

// ---- W2 close after a pre-fence STOP (production W2 yPolVl) ----
test('admin release plan: W2 pre-fence close proves an empty ledger and needs a ruling for an unproven started revoke', () => {
  const setup = () => {
    const stage = makeStage(), proof = mkdtempSync(join(scratch, 'w2-close-')), close = portable(block('ai-close'), { stage: 2, pointer: 0 });
    const producerFile = join(proof, '..', basename(proof) + '-producer.mjs'), archive = join(proof, '..', basename(proof) + '-release.tar');
    writeFileSync(producerFile, 'export const w2CloseFixture = "live-ordinary-controls";\n');
    const tar = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")', archive, producerFile], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const producerSha = digest(readFileSync(producerFile));
    const consent = JSON.stringify({ kind: 'c1-consent', release_sha: sha, consent_phase: 'pre-W1', measured_at: new Date(Date.now() - 60_000).toISOString(),
      producer_sha256: producerSha, controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dcr-close-own'], cleanup: null });
    const live = JSON.stringify({ release_sha: sha, window_id: 'Abc123', window: 'W2', phase: 'recovery',
      controls: { hosted_mcp_consent_refresh: true, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true },
      consent_receipt_sha256: digest(consent), producer_sha256: producerSha, dcr_client_ids: ['dcr-close-window'] });
    writeFileSync(join(proof, 'consent-pre-W1.json'), consent); writeFileSync(join(proof, 'ordinary-recovery.json'), live);
    writeFileSync(join(proof, 'secret-stage.path'), stage + '\n');
    // Pre-fence STOP state: staged, revoke started but not proven, nothing applied.
    for (const [name, value] of [['probe-staged.txt', 'x\n'], ['dcr-probe-revoke-attempted.txt', 'started\n'],
      ['dcr-probe-revoke-unproven.json', JSON.stringify({ client_id: 'dcr-probe-client', revoked: false, status: 'REVOKE-UNPROVEN', reason: 'step 1 rotation refresh got transport-error-not-retried' })]] as const) writeFileSync(join(proof, name), value);
    const inputs = join(proof, '..', basename(proof) + '-inputs.json'); writeFileSync(inputs, JSON.stringify({ ...base(), window: 'W2', archive_sha256: digest(readFileSync(archive)) }));
    const shim = mkdtempSync(join(scratch, 'w2-close-shim-')); writeFileSync(join(shim, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const calls = join(proof, '..', basename(proof) + '-ai-ro');
    // Read-only database boundary: only the ledger query is modelled; admin_cutover_state must not be queried.
    const harness = `ai_ro() { printf '%s\\n' "$*" >>'${calls}'; case "$*" in *"version LIKE '20261003%'"*) test -z "\${MUTATE_RULING:-}" || chmod 0666 "\${MUTATE_RULING}"; printf '%s\\n' "\${LEDGER_COUNT:-0}";; *) printf 'UNEXPECTED\\n'; return 1;; esac; }\n`;
    const env = { WINDOW: 'W2', CLOSE_RESULT: 'recovered', SECRET_STAGE: stage, PROOF_DIR: proof, EDGE_RECYCLE_TIMER: 'fixture.timer', INPUTS_FILE: inputs, PLAN_FILE: planPath,
      BOX_ARCHIVE_PATH: archive, PATH: shim + ':' + process.env.PATH };
    // A HezLead ruling file bound to this window, release, plan digest and staged client_id.
    const rulingDir = mkdtempSync(join(realpathSync(tmpdir()), 'w2-ruling-'));
    const ruling = (change: Record<string, unknown> = {}, mode = 0o600) => {
      const file = join(rulingDir, `ruling-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify({ action: 'accept-unproven-dcr-revoke', approver: 'HezLead', release_sha: sha, window_id: 'Abc123',
        plan_sha256: digest(plan), client_id: 'dcr-probe-client', at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), ...change }), { mode });
      chmodSync(file, mode); return file;
    };
    const cleanRulings = () => rmSync(rulingDir, { recursive: true, force: true });
    return { stage, proof, close, harness, env, calls, ruling, rulingDir, cleanRulings };
  };
  // No ruling: REVOKE-UNPROVEN naming the client_id, and the close stops.
  { const c = setup();
    c.cleanRulings();
    try {
      const out = run(c.harness + c.close, c.env);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /REVOKE-UNPROVEN ai-close: DCR probe grant client_id dcr-probe-client is not proven revoked; ruling file expected absolute-path got missing; HezLead revokes it and supplies W2_REVOKE_UNPROVEN_ACCEPTED=<absolute ruling file> to close; STOP/);
      assert.ok(!existsSync(join(c.proof, 'closed.txt')) && existsSync(c.stage));
    } finally { if (existsSync(c.stage)) removeStage(c.stage); } }
  // With the ruling: recorded, ledger proven empty without admin_cutover_state, window closed.
  { const c = setup();
    try {
      const file = c.ruling();
      const out = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: file });
      assert.equal(out.status, 0, out.stderr);
      const accepted = JSON.parse(readFileSync(join(c.proof, 'dcr-probe-revoke-accepted.json'), 'utf8'));
      assert.equal(accepted.status, 'REVOKE-UNPROVEN-ACCEPTED'); assert.equal(accepted.ruling.client_id, 'dcr-probe-client');
      assert.equal(accepted.ruling.window_id, 'Abc123'); assert.equal(accepted.ruling_sha256, digest(readFileSync(file)));
      assert.ok(existsSync(join(c.proof, 'closed.txt')) && !existsSync(c.stage));
      assert.doesNotMatch(readFileSync(c.calls, 'utf8'), /admin_cutover_state/, 'no query of a relation W2 creates');
    } finally { if (existsSync(c.stage)) removeStage(c.stage); c.cleanRulings(); } }
  // Ruling present but something was applied: the pre-fence close refuses.
  { const c = setup();
    try {
      const out = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: c.ruling(), LEDGER_COUNT: '1' });
      assert.notEqual(out.status, 0); assert.match(out.stderr, /FAIL ai-close: pre-fence W2 ledger expected no 20261003 version got other; STOP/);
      assert.ok(!existsSync(join(c.proof, 'closed.txt')));
      assert.ok(!existsSync(join(c.proof, 'dcr-probe-revoke-accepted.json')), 'no acceptance record on a refused close');
      // A valid ruling with CLOSE_RESULT withheld: the close refuses and records no acceptance.
      const env: Record<string, string> = { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: c.ruling() }; delete env.CLOSE_RESULT;
      const withheld = run(c.harness + c.close, env);
      assert.notEqual(withheld.status, 0); assert.match(withheld.stderr, /CLOSE_RESULT/);
      assert.ok(!existsSync(join(c.proof, 'dcr-probe-revoke-accepted.json')) && !existsSync(join(c.proof, 'closed.txt')));
    } finally { if (existsSync(c.stage)) removeStage(c.stage); c.cleanRulings(); } }
  // The ruling changes between the first check and the final validation (the stub flips its mode
  // during the ledger query): refused BEFORE the stage is removed; a retry with a valid ruling closes.
  { const c = setup();
    try {
      const changing = c.ruling();
      const out = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: changing, MUTATE_RULING: changing });
      assert.notEqual(out.status, 0); assert.ok(out.stderr.includes('ruling file expected regular-0600-or-0644 got other'), out.stderr);
      assert.ok(!existsSync(join(c.proof, 'dcr-probe-revoke-accepted.json')) && !existsSync(join(c.proof, 'closed.txt')));
      assert.ok(existsSync(c.stage), 'stage preserved: the close stays retryable');
      const retry = c.ruling();
      const again = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: retry });
      assert.equal(again.status, 0, again.stderr);
      assert.ok(existsSync(join(c.proof, 'closed.txt')) && !existsSync(c.stage));
      assert.equal(JSON.parse(readFileSync(join(c.proof, 'dcr-probe-revoke-accepted.json'), 'utf8')).ruling_sha256, digest(readFileSync(retry)));
    } finally { if (existsSync(c.stage)) removeStage(c.stage); c.cleanRulings(); } }
  // Receipt-validation refusal control: a valid ruling with an invalid retained receipt records no acceptance.
  { const c = setup();
    try {
      writeFileSync(join(c.proof, 'ordinary-recovery.json'), '{}');
      const out = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: c.ruling() });
      assert.notEqual(out.status, 0); assert.match(out.stderr, /FAIL ai-close: retained close receipts expected valid got refused; STOP/);
      assert.ok(!existsSync(join(c.proof, 'dcr-probe-revoke-accepted.json')) && !existsSync(join(c.proof, 'closed.txt')) && existsSync(c.stage));
    } finally { if (existsSync(c.stage)) removeStage(c.stage); c.cleanRulings(); } }
  // Every binding of the ruling is checked; each refusal leaves the window open with no acceptance record.
  { const c = setup();
    try {
      const refusals: Array<[string, string]> = [
        [c.ruling({ window_id: 'yPolVl' }), 'window_id expected input-window-id got mismatch'],
        [c.ruling({ release_sha: 'e'.repeat(40) }), 'release_sha expected input-release-sha got mismatch'],
        [c.ruling({ plan_sha256: 'f'.repeat(64) }), 'plan_sha256 expected input-plan-sha256 got mismatch'],
        [c.ruling({ client_id: 'dcr-other-client' }), 'client_id expected staged-client-id got mismatch'],
        [c.ruling({ extra: 1 }), 'keys expected exact-ruling-keys got other-set'],
        [c.ruling({ approver: 'Tom' }), 'approver expected HezLead got other'],
        [c.ruling({ action: 'accept' }), 'action expected accept-unproven-dcr-revoke got other'],
        [c.ruling({ at: '2999-01-01T00:00:00Z' }), 'at expected UTC-Z-not-future got other'],
        [c.ruling({}, 0o666), 'file expected regular-0600-or-0644 got other'],
        [join(c.rulingDir, 'absent.json'), 'file expected regular-non-symlink got missing-or-symlink'],
        ['relative/ruling.json', 'file expected absolute-path got missing'],
      ];
      const linked = join(c.rulingDir, 'linked.json'); symlinkSync(c.ruling(), linked);
      refusals.push([linked, 'file expected regular-non-symlink got missing-or-symlink']);
      const keys = c.ruling(); writeFileSync(keys, JSON.stringify({ action: 'accept-unproven-dcr-revoke' }), { mode: 0o600 });
      refusals.push([keys, 'keys expected exact-ruling-keys got other-set']);
      // The bound ruling padded to exactly 65536 bytes, then a trailing conflicting document.
      const trailing = c.ruling(); const bound = readFileSync(trailing, 'utf8');
      writeFileSync(trailing, bound + ' '.repeat(65536 - Buffer.byteLength(bound)) + JSON.stringify({ window_id: 'yPolVl' }), { mode: 0o600 });
      refusals.push([trailing, 'file expected at-most-65536-bytes got larger']);
      const trailingSmall = c.ruling(); writeFileSync(trailingSmall, readFileSync(trailingSmall, 'utf8') + '\n' + JSON.stringify({ window_id: 'yPolVl' }), { mode: 0o600 });
      refusals.push([trailingSmall, 'keys expected exact-ruling-keys got other-set']);
      const oversized = c.ruling(); writeFileSync(oversized, ' '.repeat(70000) + readFileSync(oversized, 'utf8'), { mode: 0o600 });
      refusals.push([oversized, 'file expected at-most-65536-bytes got larger']);
      for (const [file, reason] of refusals) {
        const out = run(c.harness + c.close, { ...c.env, W2_REVOKE_UNPROVEN_ACCEPTED: file });
        assert.notEqual(out.status, 0, reason);
        assert.ok(out.stderr.includes(`ruling ${reason}; HezLead revokes it`), `${reason}: ${out.stderr}`);
        assert.ok(!existsSync(join(c.proof, 'dcr-probe-revoke-accepted.json')) && !existsSync(join(c.proof, 'closed.txt')));
      }
    } finally { if (existsSync(c.stage)) removeStage(c.stage); c.cleanRulings(); } }
});

// ---------------- box-written times (release Z): the EXACT box formats, one shared strict parser ----------------
// Real box samples (nonsecret, HezLead 2026-10-04): status.json verified_at and restore-status.json at, as written.
const BOX_TIME = { verified_at: '2026-10-04T22:12:09.199316+00:00', retention_policy_observed_at: '2026-09-18T00:13:29.059720+00:00',
  restore_at: '2026-10-04T04:48:05.055995+00:00' };
const boxTimeDir = resolve('tests/fixtures/box-time');

test('box times: every box_utc copy is identical; it accepts the exact box samples and Z, and refuses other offsets, naive and 7 digits', () => {
  const copies = [...plan.matchAll(/^def box_utc\(value\):\n(?: {4}.*\n)+/gm)].map(m => m[0]);
  assert.equal(copies.length, 7, 'producer, check, W2 status and W1/W5 closed.txt readers');
  assert.equal(new Set(copies).size, 1, 'all copies identical');
  const parser = join(scratch, 'box-utc.py');
  writeFileSync(parser, `import datetime,json,re,sys\n${copies[0]}print(json.dumps([None if (t:=box_utc(v)) is None else t.isoformat() for v in json.loads(sys.argv[1])]))\n`);
  const parse = (values: unknown[]) => JSON.parse(spawnSync('python3', [parser, JSON.stringify(values)], { encoding: 'utf8' }).stdout) as (string | null)[];
  assert.deepEqual(parse([BOX_TIME.verified_at, BOX_TIME.retention_policy_observed_at, BOX_TIME.restore_at]),
    ['2026-10-04T22:12:09.199316+00:00', '2026-09-18T00:13:29.059720+00:00', '2026-10-04T04:48:05.055995+00:00']);
  // The plan's own writers: date -u (Z, no fraction), the receipt gate_at (Z, 6 digits), python isoformat (+00:00).
  assert.deepEqual(parse(['2026-10-04T22:05:00Z', '2026-10-04T22:20:00.000000Z', '2026-10-04T22:20:00.5Z', '2026-10-04T22:20:00+00:00']),
    ['2026-10-04T22:05:00+00:00', '2026-10-04T22:20:00+00:00', '2026-10-04T22:20:00.500000+00:00', '2026-10-04T22:20:00+00:00']);
  // Negatives: another offset, naive, 7 fraction digits, -00:00, a space separator, non-ISO, non-string, impossible date.
  assert.deepEqual(parse(['2026-10-04T22:12:09.199316+01:00', '2026-10-04T22:12:09.199316', '2026-10-04T22:12:09.1993161+00:00',
    '2026-10-04T22:12:09-00:00', '2026-10-04 22:12:09+00:00', 'yesterday', 1791151929, '2026-02-30T00:00:00Z']), [null, null, null, null, null, null, null, null]);
});

test('box times: the plan\'s ai-w1-backup-gate and ai-backup-gate-check PASS on the exact box status.json and restore-status.json', () => {
  const run1 = (statusFile: string, restoreFile: string, gateBlock = block('ai-backup-gate-check')) => {
    const dir = mkdtempSync(join(scratch, 'box-time-')), backups = join(dir, 'backups'), proof = join(dir, 'proof');
    mkdirSync(backups); mkdirSync(proof);
    writeFileSync(join(backups, 'status.json'), readFileSync(statusFile)); writeFileSync(join(backups, 'restore-status.json'), readFileSync(restoreFile));
    const inputs = { ...base(), window: 'W2b', window_id: 'Abc123', window_end_utc: '2026-10-04T22:50:00Z' };
    writeFileSync(join(proof, 'inputs.json'), JSON.stringify(inputs)); writeFileSync(join(proof, 'open.txt'), '2026-10-04T22:05:00Z\n');
    writeFileSync(join(dir, 'check.sh'), gateBlock);
    const producer = block('ai-w1-backup-gate').split('/var/backups/commonswarm-postgres').join(backups);
    const r = run(`ai_deadline() { :; }\nai_run() { test "$1" = ai-backup-gate-check || return 1; eval "$(cat '${join(dir, 'check.sh')}')"; }\n${producer}`,
      { WINDOW: 'W2b', PROOF_DIR: proof, INPUTS_FILE: join(proof, 'inputs.json'), PYTHONPATH: boxTimeDir, C1_TEST_FIXED_NOW: '2026-10-04T22:20:00Z' });
    return { r, proof };
  };
  const good = run1(join(boxTimeDir, 'status.json'), join(boxTimeDir, 'restore-status.json'));
  assert.equal(good.r.status, 0, good.r.stderr);
  assert.match(good.r.stdout, /^PASS ai-backup-gate-check: W2b Abc123 backup and restore fresh at gate 2026-10-04T22:20:00\.000000Z$/m);
  const receipt = JSON.parse(readFileSync(join(good.proof, 'backup-gate.json'), 'utf8'));
  assert.equal(receipt.backup_verified_at, BOX_TIME.verified_at, 'the receipt keeps the box string as written');
  assert.equal(receipt.restore_completed_at, BOX_TIME.restore_at);
  // Negative control: the released check (origin/main 14bf1604, Z-only) refuses the same real receipt.
  const present = spawnSync('git', ['cat-file', '-e', '14bf1604^{commit}']);
  assert.equal(present.status, 0, 'commit 14bf1604 is absent from this clone: fetch it (fetch-depth: 0)');
  const oldPlan = spawnSync('git', ['show', '14bf1604:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'], { encoding: 'utf8' }).stdout;
  const oldCheck = [...oldPlan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!).find(b => b.startsWith('# step: ai-backup-gate-check\n'))!;
  const old = run1(join(boxTimeDir, 'status.json'), join(boxTimeDir, 'restore-status.json'), oldCheck);
  assert.notEqual(old.r.status, 0); assert.match(old.r.stderr, /backup_verified_at expected UTC-ISO-8601-Z-time got other/);
  // Negatives on the producer: the same sample with another offset, naive, or 7 fraction digits.
  const status = JSON.parse(readFileSync(join(boxTimeDir, 'status.json'), 'utf8'));
  for (const bad of ['2026-10-04T22:12:09.199316+01:00', '2026-10-04T22:12:09.199316', '2026-10-04T22:12:09.1993161+00:00']) {
    const file = join(scratch, `status-${digest(bad).slice(0, 8)}.json`); writeFileSync(file, JSON.stringify({ ...status, verified_at: bad }));
    const r = run1(file, join(boxTimeDir, 'restore-status.json'));
    assert.notEqual(r.r.status, 0, bad); assert.match(r.r.stderr, /FAIL backup verified_at expected aware-UTC-ISO-8601-time got other; STOP/, bad);
    assert.ok(!existsSync(join(r.proof, 'backup-gate.json')), `${bad}: no receipt`);
  }
  const restore = JSON.parse(readFileSync(join(boxTimeDir, 'restore-status.json'), 'utf8'));
  const naiveRestore = join(scratch, 'restore-naive.json'); writeFileSync(naiveRestore, JSON.stringify({ ...restore, at: '2026-10-04T04:48:05.055995' }));
  const nr = run1(join(boxTimeDir, 'status.json'), naiveRestore);
  assert.notEqual(nr.r.status, 0); assert.match(nr.r.stderr, /FAIL restore at expected aware-UTC-ISO-8601-time got other; STOP/);
});

// Real Y W2b PLWaBd proofs, verbatim (HezLead 2026-10-04): one receipt mixes the box's +00:00 copies with the plan's own
// ...Z gate_at; open.txt, closed.txt and close-result.json are the plan's date -u writers.
const Y_W2B_RECEIPT = '{"backup_verified_at": "2026-10-04T22:12:09.199316+00:00", "destination": "r2:yulan-vps-1-backups/000-commonswarm-postgres/20261004T220618Z-a5fa66a8632e456d990c534f5be959e5", "gate_at": "2026-10-04T22:18:24.257697Z", "release_sha": "14bf1604f3299885070a01b46c610c6dda02db0e", "restore_completed_at": "2026-10-04T04:48:05.055995+00:00", "status": "PASS", "window": "W2b", "window_id": "PLWaBd"}';
const Y_OLD_W1_RECEIPT = '{"status": "PASS", "backup_verified_at": "2026-10-04T13:16:05.296063+00:00", "restore_at": "2026-10-04T04:48:05.055995+00:00"}';
const Y_CLOSE_RESULT = '{"closed_at": "2026-10-04T22:29:52Z", "release_sha": "14bf1604f3299885070a01b46c610c6dda02db0e", "result": "recovered", "window": "W2b", "window_id": "PLWaBd"}';

test('box times: the exact Y W2b receipt (mixed +00:00 and Z) passes ai-backup-gate-check; the old W1 shape and the old check refuse', () => {
  const check = (receipt: string, gateBlock = block('ai-backup-gate-check')) => {
    const dir = realpathSync(mkdtempSync(join(scratch, 'y-receipt-')));
    writeFileSync(join(dir, 'backup-gate.json'), receipt + '\n');
    writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ ...base(), release_sha: '14bf1604f3299885070a01b46c610c6dda02db0e', window: 'W2b', window_id: 'PLWaBd', window_end_utc: '2026-10-04T22:47:31Z' }));
    writeFileSync(join(dir, 'open.txt'), '2026-10-04T22:17:31Z\n');
    return run(gateBlock, { BACKUP_GATE_DIR: dir, PYTHONPATH: boxTimeDir, C1_TEST_FIXED_NOW: '2026-10-04T22:20:00Z' });
  };
  const good = check(Y_W2B_RECEIPT); assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^PASS ai-backup-gate-check: W2b PLWaBd backup and restore fresh at gate 2026-10-04T22:18:24\.257697Z$/m);
  const oldPlan = spawnSync('git', ['show', '14bf1604:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'], { encoding: 'utf8' }).stdout;
  const oldCheck = [...oldPlan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!).find(b => b.startsWith('# step: ai-backup-gate-check\n'))!;
  const old = check(Y_W2B_RECEIPT, oldCheck); assert.notEqual(old.status, 0);
  assert.match(old.stderr, /backup_verified_at expected UTC-ISO-8601-Z-time got other/, 'the release Y refusal, reproduced');
  // The 5f64fab4 W1 receipt shape: refused on its keys (not on its times); only W2's consumer ever read that shape.
  const shape = check(Y_OLD_W1_RECEIPT); assert.notEqual(shape.status, 0); assert.match(shape.stderr, /backup-gate\.json keys expected exact-PASS-receipt got other/);
});

test('box times: the exact Y W2b closed.txt and close-result.json bytes parse; the shared proof validator decides on the result', () => {
  const y = { sha: '14bf1604f3299885070a01b46c610c6dda02db0e', id: 'PLWaBd' };
  const f = proofCheckFixture('W2b', y);
  f.put('closed.txt', '2026-10-04T22:29:52Z\n'); f.put('close-result.json', Y_CLOSE_RESULT + '\n');
  const recovered = f.check(); assert.notEqual(recovered.status, 0);
  assert.match(recovered.stderr, /W2b close result expected success got recovered/, 'refused on the result, after the time strings and record bytes were accepted');
  // The same real time strings in a success record pass.
  f.put('close-result.json', Y_CLOSE_RESULT.replace('"recovered"', '"success"') + '\n');
  const success = f.check(); assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).closed_at, '2026-10-04T22:29:52Z');
});

// ---------------- release Z2: SQL never travels on stdin (docker run has no -i) ----------------
test('stdin SQL: the plan\'s ai_db refuses every stdin form before docker runs; ai_db_secret_file mounts the file read-only', () => {
  const session = block('ai-db-session');
  const fns = session.slice(session.indexOf('ai_db_grammar() {'), session.indexOf('\npython3 - "$MIGRATE/lib.sh"'));
  assert.ok(fns.includes('ai_db_secret_file() {'));
  const dir = realpathSync(mkdtempSync(join(scratch, 'stdin-sql-'))), stage = join(dir, 'stage'), calls = join(dir, 'calls');
  mkdirSync(stage, { mode: 0o700 }); writeFileSync(calls, '');
  const harness = `docker() { printf '%s\\n' "$*" >>'${calls}'; cat >/dev/null <&- 2>/dev/null; return 0; }\n${fns}\n`;
  const env = { SECRET_STAGE: stage, PGSERVICE_FILE: join(stage, 'service.conf'), PGPASS_FILE: join(stage, 'pass'), PSQL_IMAGE: 'fixture', RELEASE_ROOT: dir, PROOF_DIR: dir };
  const call = (args: string) => { writeFileSync(calls, ''); const r = run(`${harness}${args}\nprintf 'status=%s\\n' "$?"`, env); return { r, docker: readFileSync(calls, 'utf8').trim() }; };
  // Every form outside the plan's exact grammar, including the refute's bypasses, is refused before docker.
  for (const form of ['ai_db -q --file -', 'ai_db -q -f -', 'ai_db -q --file=-', 'ai_db -q -f-', 'ai_db -q --file /dev/stdin', 'ai_db -qf -',
    "ai_db -qf - --command 'SELECT 1;'", 'ai_ro -qf -', 'ai_ro -Atq', 'ai_db -q', 'ai_db -q --file /dev/fd/0', 'ai_db -q --file /proc/self/fd/0',
    'ai_db -q --fil /proof/x.sql', "ai_db -q -c 'SELECT 1;'", 'ai_db -q --file /tmp/x.sql', 'ai_db -q --file /proof/../x.sql', 'ai_db -q --file /proof/x.txt',
    "ai_db -Aqt --command 'SELECT 1;'", "ai_db --command ''"]) {
    const { r, docker } = call(`${form} </dev/null`);
    assert.match(r.stdout, /status=2/, form); assert.equal(docker, '', `${form}: no docker run`);
    assert.match(r.stderr, /^FAIL ai_(?:db|ro): arguments expected the plan grammar/m, form);
  }
  const ok = call(`ai_db -Atq --command 'SELECT 1;'`); assert.match(ok.r.stdout, /status=0/); assert.match(ok.docker, /^run --rm /);
  assert.doesNotMatch(ok.docker, /(^| )(-i|--interactive)( |$)/, 'never -i');
  const ro = call(`ai_ro -Atq --file /proof/x.sql`); assert.match(ro.r.stdout, /status=0/);
  // Every option form the plan's own callers use is inside the grammar.
  for (const form of ["ai_db --command 'SELECT 1;'", "ai_db -q --command 'SELECT 1;'", 'ai_db -q --file /proof/apply-20261003000001.sql', 'ai_ro -Atq --file /release/deploy/x.sql', "ai_ro -Atq --command 'SELECT 1;'", 'ai_ro -q --file /proof/identity.sql']) {
    const r = call(form); assert.match(r.r.stdout, /status=0/, form);
  }
  // The secret-file helper: a non-empty regular file in SECRET_STAGE, mounted read-only and run with --file.
  writeFileSync(join(stage, 'issuer.sql'), "ALTER ROLE x LOGIN PASSWORD 'fixture-not-a-secret';\n", { mode: 0o600 });
  const helper = call(`ai_db_secret_file '${join(stage, 'issuer.sql')}'`);
  assert.match(helper.r.stdout, /status=0/);
  assert.ok(helper.docker.includes(`--volume ${join(stage, 'issuer.sql')}:/run/secret.sql:ro`) && helper.docker.endsWith("--command SET log_statement=none; SET log_min_error_statement=panic; --file /run/secret.sql"), helper.docker);
  assert.doesNotMatch(helper.docker, /fixture-not-a-secret|(^| )(-i|--interactive)( |$)/, 'no SQL text in argv, never -i');
  // Resolved containment, regular, this user's, 0600, non-empty: outside, traversal, symlinked directory, symlink,
  // wrong mode and empty files are refused before docker.
  writeFileSync(join(dir, 'outside.sql'), 'SELECT 1;\n', { mode: 0o600 }); writeFileSync(join(stage, 'empty.sql'), '', { mode: 0o600 });
  writeFileSync(join(stage, 'wide.sql'), 'SELECT 1;\n', { mode: 0o644 }); chmodSync(join(stage, 'wide.sql'), 0o644);
  symlinkSync(join(dir, 'outside.sql'), join(stage, 'link.sql')); symlinkSync(dir, join(stage, 'up'));
  for (const path of [join(dir, 'outside.sql'), join(stage, '..', 'outside.sql'), join(stage, 'up', 'outside.sql'), join(stage, 'link.sql'), join(stage, 'wide.sql'), join(stage, 'empty.sql'), 'relative.sql']) {
    const bad = call(`ai_db_secret_file '${path}'`); assert.match(bad.r.stdout, /status=2/, path); assert.equal(bad.docker, '', path);
    assert.match(bad.r.stderr, /FAIL ai_db_secret_file: SQL file expected non-empty 0600 regular file of this user resolved inside SECRET_STAGE got other/, path);
  }
  // No plan block sends SQL on stdin or runs docker interactively.
  assert.match('ai_db -q --file - <"$X"', /\bai_(?:db|ro) [^\n]*--file -(?:\s|$)|'--file','-'/, 'scan control');
  for (const b of blocks) {
    const code = b.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bai_(?:db|ro) [^\n]*--file -(?:\s|$)|'--file','-'/, b.split('\n')[0]);
    assert.doesNotMatch(code.replace(/printf '[^']*'/g, ''), /docker run[^\n]*(?:\s-i\s|\s--interactive\s|\s-it\s)/, b.split('\n')[0]);
  }
});

test('issuer SCRAM verifier: the plan\'s client-side derivation verifies the RFC 7677 SCRAM-SHA-256 exchange', () => {
  const issuer = block('ai-w2-issuer-credential');
  const fn = issuer.match(/^def scram_verifier\(password,salt,iterations=4096\):\n(?: {4}.*\n)+/m)?.[0];
  assert.ok(fn, 'scram_verifier is defined in the issuer preparation');
  // RFC 7677 section 3: user "user", password "pencil"; the server checks the client proof with StoredKey and
  // signs with ServerKey, exactly the two keys the verifier carries.
  const check = `import base64,hashlib,hmac,sys
${fn}
salt=base64.b64decode('W22ZaJ0SNY7soEsUEjb6gQ==')
v=scram_verifier('pencil',salt)
head,keys=v.split('$',1)[1],v.split('$')[2]
assert v.startswith('SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$')
stored,server=(base64.b64decode(x) for x in keys.split(':'))
auth=b'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
proof=base64.b64decode('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=')
signature=hmac.new(stored,auth,hashlib.sha256).digest()
client_key=bytes(a^b for a,b in zip(proof,signature))
assert hashlib.sha256(client_key).digest()==stored, 'client proof verifies against StoredKey'
assert base64.b64encode(hmac.new(server,auth,hashlib.sha256).digest()).decode()=='6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=', 'server signature'
print('ok')
`;
  const r = spawnSync('python3', ['-c', check], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'ok');
  // Control: a wrong password fails the same check.
  const bad = spawnSync('python3', ['-c', check.replace("scram_verifier('pencil',salt)", "scram_verifier('pencil2',salt)")], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('recovered W6 start state measures the Mac marker and refuses regular and dangling receipt symlinks', () => {
  const dir=mkdtempSync(join(scratch,'mac-close-state-'));
  const input=join(dir,'inputs.json'); const d={...base(),window:'W6'}; writeFileSync(input,JSON.stringify(d));
  const execute=()=>run(block('ai-w6-close-state'),{C1_PROOF_DIR:dir,INPUTS_FILE:input});
  writeFileSync(join(dir,'C1-client-check.txt'),'PASS');
  let r=execute(); assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir,'C1-close-state.json'),'utf8')).started,false,'client-check alone never starts a runner');
  writeFileSync(join(dir,'secret-stage.path'),'/private/tmp/synthetic-stage\n'); writeFileSync(join(dir,'runner.pid'),'2147483646\n');
  r=execute(); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(readFileSync(join(dir,'C1-close-state.json'),'utf8')).started,true);
  for(const file of ['secret-stage.path','runner.pid','C1-client-check.txt','C1-cleanup.txt']) for(const dangling of [false,true]) {
    const path=join(dir,file), target=join(dir,'link-target');
    const saved=existsSync(path)?readFileSync(path):null; if(saved) rmSync(path);
    if(existsSync(target)) rmSync(target); if(!dangling) writeFileSync(target,'PASS');
    symlinkSync(target,path); r=execute(); assert.notEqual(r.status,0);
    assert.ok(r.stderr.includes(`FAIL ai-w6-close-state: ${file} expected regular-non-symlink got other; STOP`),r.stderr);
    rmSync(path); if(saved) writeFileSync(path,saved);
  }
  writeFileSync(join(dir,'runner.pid'),String(process.pid));
  r=execute(); assert.notEqual(r.status,0); assert.match(r.stderr,/runner expected stopped got active/);
});

test('W5 recovered close requires companion closure, bound rollback/reconciliation and the original baseline current', () => {
  const root=realpathSync(mkdtempSync(join(scratch,'w5-recovered-'))), site=join(root,'site'), bin=join(root,'bin'); mkdirSync(bin);
  writeFileSync(join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const original=join(site,'releases','20261003T120000Z-'+base().baseline_site_sha.slice(0,12)+'-'+'1'.repeat(16));
  mkdirSync(join(original,'app'),{recursive:true}); writeFileSync(join(original,'app/index.html'),'baseline'); symlinkSync(original,join(site,'current'));
  const producer=join(root,'producer.mjs'), archive=join(root,'release.tar'); writeFileSync(producer,'export const fixture = true;\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producer],{encoding:'utf8'}); assert.equal(tar.status,0,tar.stderr);
  const consent=JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:'post-W5',measured_at:new Date(Date.now()-60_000).toISOString(),producer_sha256:digest(readFileSync(producer)),controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['w5-recovery-own'],cleanup:{grants_revoked:true,dcr_clients_expiring:[{client_id:'earlier-client',expires_after:new Date(Date.now()+86400_000).toISOString()}]}});
  const live=JSON.stringify({release_sha:sha,window_id:'Abc123',window:'W5',phase:'recovery',controls:{hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true},consent_receipt_sha256:digest(consent),producer_sha256:digest(readFileSync(producer)),dcr_client_ids:['window-client']});
  const fixture=(outcome:string)=>{
    const proof=mkdtempSync(join(root,'proof-')), evidence=join(proof,'site-recovery'); mkdirSync(evidence);
    const input=join(proof,'inputs.json'); writeFileSync(input,JSON.stringify({...base(),window:'W5',baseline_site_target:original,archive_sha256:digest(readFileSync(archive))}));
    writeFileSync(join(proof,'ordinary-recovery.json'),live); writeFileSync(join(proof,'consent-post-W5.json'),consent);
    writeFileSync(join(evidence,'previous.original'),original+'\n'); writeFileSync(join(evidence,'site2-07-pin-close.txt'),`pin_released=yes\nOUTCOME=${outcome}\n`);
    if(outcome==='rolled-back') { writeFileSync(join(evidence,'rollback-auto.txt'),'rollback_reason=public-control-failure\nrestored_release=/srv/commonswarm/site/releases/.site-window-pin-fixture\n'); writeFileSync(join(evidence,'site2-06-rollback-verify.txt'),'ROLLBACK_PUBLIC_BYTES=PASS\nuser_agent=curl/8.7.1\n'); }
    else writeFileSync(join(evidence,'site2-04-reconciliation.txt'),'DEPLOYMENT=failed-before-switch\nRETRY=forbidden\n');
    const seal=()=>{
      const names=readdirSync(evidence).filter(n=>!['CLOSE.txt','manifest.json'].includes(n));
      const manifest=JSON.stringify(names.map(path=>({path,sha256:digest(readFileSync(join(evidence,path)))}))); writeFileSync(join(evidence,'manifest.json'),manifest);
      writeFileSync(join(evidence,'CLOSE.txt'),`CLOSED=yes\nOUTCOME=${outcome}\nPIN_RELEASED=yes\nMANIFEST_SHA256=${digest(manifest)}\n`);
    }; seal();
    const execute=()=>run(block('ai-close').replaceAll('/srv/commonswarm/site',site),{WINDOW:'W5',CLOSE_RESULT:'recovered',INPUTS_FILE:input,PLAN_FILE:planPath,PROOF_DIR:proof,BOX_ARCHIVE_PATH:archive,SITE_RECOVERY_EVIDENCE:evidence,PATH:bin+':'+process.env.PATH});
    return {proof,evidence,execute,seal};
  };
  for(const outcome of ['rolled-back','failed-before-switch']) {
    const good=fixture(outcome), r=good.execute(); assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/CLOSED-RECOVERED W5/); assert.equal(JSON.parse(readFileSync(join(good.proof,'close-result.json'),'utf8')).result,'recovered');
  }
  for(const fault of ['missing-close','cleanup-failed','wrong-current','wrong-baseline','receipt-missing','receipt-altered','pin-partial','forward-outcome','receipt-symlink','bad-controls']) {
    const f=fixture(fault==='receipt-missing'?'failed-before-switch':'rolled-back');
    if(fault==='missing-close') rmSync(join(f.evidence,'CLOSE.txt'));
    if(fault==='cleanup-failed') writeFileSync(join(f.evidence,'CLOSE.txt'),'CLOSED=no\n');
    if(fault==='wrong-current') { rmSync(join(site,'current')); symlinkSync(site,join(site,'current')); }
    if(fault==='wrong-baseline') { const input=join(f.proof,'inputs.json'); const d=JSON.parse(readFileSync(input,'utf8')); d.baseline_site_sha='0'.repeat(40); writeFileSync(input,JSON.stringify(d)); }
    if(fault==='receipt-missing') { rmSync(join(f.evidence,'site2-04-reconciliation.txt')); f.seal(); }
    if(fault==='receipt-altered') writeFileSync(join(f.evidence,'rollback-auto.txt'),'changed');
    if(fault==='pin-partial') { writeFileSync(join(f.evidence,'site2-07-pin-close.txt'),'pin_released=no\n'); f.seal(); }
    if(fault==='forward-outcome') writeFileSync(join(f.evidence,'CLOSE.txt'),readFileSync(join(f.evidence,'CLOSE.txt'),'utf8').replace('OUTCOME=rolled-back','OUTCOME=released'));
    if(fault==='receipt-symlink') { const path=join(f.evidence,'rollback-auto.txt'); rmSync(path); symlinkSync(join(root,'absent'),path); }
    if(fault==='bad-controls') writeFileSync(join(f.proof,'ordinary-recovery.json'),'{}');
    const r=f.execute(); assert.notEqual(r.status,0,fault); assert.ok(!existsSync(join(f.proof,'closed.txt')),fault); assert.ok(!existsSync(join(f.proof,'close-result.json')),fault);
    assert.match(r.stderr,fault==='bad-controls'?/retained close receipts expected valid got refused/:/recovered W5 site close, recovery receipt and current expected closed-recovered-baseline got other/);
    if(fault==='wrong-current') { rmSync(join(site,'current')); symlinkSync(original,join(site,'current')); }
  }
});
