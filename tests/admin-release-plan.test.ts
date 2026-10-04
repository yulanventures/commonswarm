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
  // W6 may bind the same-release W2b by w2b_window_id; no other window may.
  const w6: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile', w2b_window_id: 'Xyz789' };
  w6.approval = approval(w6, 'activate-admin-issuance-and-smoke');
  const w6good = validate(w6); assert.equal(w6good.status, 0, w6good.stderr);
  const w6bad = validate({ ...w6, w2b_window_id: 'bad id' }); assert.notEqual(w6bad.status, 0); assert.match(w6bad.stderr, /w2b_window_id is W6-only/);
  const w5 = validate({ ...base(), window: 'W5', rollback_decision: 'restore-service', w2b_window_id: 'Xyz789' }); assert.notEqual(w5.status, 0); assert.match(w5.stderr, /w2b_window_id is W6-only/);
  const w2bSelf = validate({ ...w2b, w2b_window_id: 'Xyz789' }); assert.notEqual(w2bSelf.status, 0); assert.match(w2bSelf.stderr, /w2b_window_id is W6-only/);
  // Window order: W2b is followed by W3 and only then W4; nothing in W2b or the W6 binding reads W3 or W4 state.
  for (const id of ['ai-w2b-preflight', 'ai-w2-issuer-credential']) assert.doesNotMatch(block(id), /W3-probes|W4-readback|-W3-|-W4-/, id);
  assert.match(plan, /The order is W2b, W3, then W4, W5, W6, W7/);
});

test('admin release plan: W6 and W7 approval is action/release/window/plan bound; activation refuses absent approval before any operation', () => {
  for (const [window, action, id] of [
    ['W6', 'activate-admin-issuance-and-smoke', 'ai-w6-activation-approval'],
    ['W7', 'retire-legacy-admin-mint', 'ai-w7-approval'],
  ]) {
    const input: Input = { ...base(), window, rollback_decision: 'close-and-reconcile' };
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
  const smoke: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile' };
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
  writeFileSync(planCopy, portable(plan, { stage: 10, pointer: 5 }));
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
  const owners = blocks.filter(source => /systemctl stop /.test(source));
  assert.equal(owners.length, 3, 'unexpected unguarded stop owner');
  for (const source of owners) {
    assert.match(source, /^\(\nset -euo pipefail/m, 'guard lifetime must be a subshell');
    const start = source.indexOf('ai_run ai-timer-guard\n');
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
  const input: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile' };
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
  assert.match(source, /ai_db -q --file - <"\$SECRET_STAGE\/issuer.sql"/);
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
  const input: Input={...base(),window:'W6',rollback_decision:'close-and-reconcile'};
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
  const calls=join(proof,'calls');
  const harness=`ai_run() { case "$1" in ai-inputs) :;; ai-w6-activation-rollback|ai-w6-activation-probes) printf '%s\\n' "$1" >>"$PROOF_DIR/calls";; *) return 1;; esac; }\n`;
  const finish=(keep:boolean|undefined)=>run(harness+block('ai-w6-finish'),{WINDOW:'W6',PROOF_DIR:proof,INPUTS_FILE:inputFile({...base(),...(keep===undefined?{}:{keep_open:keep})}),PATH:shim+':'+process.env.PATH});
  let result=finish(undefined); assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(proof,'C1-finish.json'),'utf8')),{state:'closed',explicit_keep_open:false});
  assert.equal(readFileSync(calls,'utf8').trim(),'ai-w6-activation-rollback');
  writeFileSync(calls,''); result=finish(true); assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(proof,'C1-finish.json'),'utf8')),{state:'open',explicit_keep_open:true});
  assert.equal(readFileSync(calls,'utf8').trim(),'ai-w6-activation-probes');
  // Former `A && B` guard: each receipt now refuses on its own line before any probe.
  for(const file of ['C1-fence.txt','client-withdraw.json']) {
    const saved=readFileSync(join(proof,file)); rmSync(join(proof,file)); writeFileSync(calls,''); if(existsSync(join(proof,'C1-finish.json'))) rmSync(join(proof,'C1-finish.json'));
    result=finish(undefined); assert.notEqual(result.status,0);
    assert.match(result.stderr,new RegExp(`FAIL ai-w6-finish: ${file.replace('.','\\.')} expected present got missing; STOP`));
    assert.equal(readFileSync(calls,'utf8'),''); assert.ok(!existsSync(join(proof,'C1-finish.json')));
    writeFileSync(join(proof,file),saved);
  }
});

test('admin release plan: D8 pointer emits only paths, consent choices and UTC expiry; secret-shaped name refuses', () => {
  // Never the real Mac pointer: the fixture pointer is under this file's scratch.
  const pointer=fixturePointer, source=portable(block('ai-w6-pointer'),{stage:1,pointer:1});
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
    removePointer();
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
      'human-revoke.json':{state:'revoked',revoked_at:'2026-10-03T12:03:00Z'},
      'client-approve.json':{approval_at:'2026-10-03T12:01:00Z'},
      'client-withdraw.json':{status:'PASS',withdrawn_at:'2026-10-03T12:02:00Z'},
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
  assert.equal(receipt.approval_at,'2026-10-03T12:01:00Z'); assert.equal(receipt.withdrawn_at,'2026-10-03T12:02:00Z'); assert.equal(receipt.revoked_at,'2026-10-03T12:03:00Z');
  assert.deepEqual(receipt.refused_follow_up,{http_status:403,refusal_code:'grant_revoked'}); assert.equal(receipt.final_gate,'closed');
  for(const changes of [
    {'client-approve.json':{}}, {'client-withdraw.json':{status:'PASS'}}, {'human-revoke.json':{state:'revoked'}},
    {'client-withdraw.json':{status:'PASS',withdrawn_at:'2026-10-03T12:00:00Z'}},
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

test('admin release plan: W6 forward close accepts default CLOSED and removes its private window', () => {
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
    writeFileSync(join(proof,'C1-cleanup.txt'),'{}');
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
  } finally {
    if(existsSync(stage)) removeStage(stage);
  }
});


test('admin release plan: W2b close needs its preconditions and issuer credential, or a recovered state without issuer login', () => {
  const root=mkdtempSync(join(scratch,'w2b-close-'));
  const producerFile=join(root,'producer.mjs'), archive=join(root,'release.tar');
  writeFileSync(producerFile,'export const closeFixture = "live-ordinary-controls";\n');
  const tar=spawnSync('python3',['-c','import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs")',archive,producerFile],{encoding:'utf8'});
  assert.equal(tar.status,0,tar.stderr);
  const producerSha=digest(readFileSync(producerFile)), archiveSha=digest(readFileSync(archive));
  const controls={hosted_mcp_consent_refresh:true,dcr_registration_consent:true,cimd_consent:true,human_recovery:true,worker_command_read:true};
  const pre=JSON.stringify({kind:'c1-consent',release_sha:sha,consent_phase:'pre-W1',measured_at:new Date(Date.now()-60_000).toISOString(),
    producer_sha256:producerSha,controls:{cimd_consent:true,dcr_registration_consent:true},dcr_client_ids:['dcr-close-own'],cleanup:null});
  const liveFor=(phase:string)=>JSON.stringify({release_sha:sha,window_id:'Abc123',window:'W2b',phase,controls,
    consent_receipt_sha256:digest(pre),producer_sha256:producerSha,dcr_client_ids:['dcr-close-window']});
  const inputs=join(root,'inputs.json');
  writeFileSync(inputs,JSON.stringify({...base(),window:'W2b',archive_sha256:archiveSha,w2_release_sha:'e'.repeat(40),w2_window_id:'RGLqZX'}));
  const shim=join(root,'shims'); mkdirSync(shim); writeFileSync(join(shim,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  // Filesystem boundary remap only: the box credential path moves into this test's directory.
  const etc=join(root,'etc'); mkdirSync(etc);
  const close=portable(block('ai-close'),{stage:2,pointer:0}).split('/etc/commonswarm-oauth/').join(etc+'/');
  const harness=(role:string)=>`ai_ro() { case "$*" in *'SELECT NOT admin_issuance_enabled'*) printf 't\\n';; *'FROM pg_catalog.pg_authid'*) printf '${role}\\n';; *) printf 'f\\n';; esac; }\n`;
  const attempt=(outcome:string,files:string[],role='t')=>{
    const stage=makeStage(), proof=mkdtempSync(join(root,'proof-'));
    writeFileSync(join(proof,'secret-stage.path'),stage+'\n'); writeFileSync(join(proof,'consent-pre-W1.json'),pre);
    writeFileSync(join(proof,'ordinary-after.json'),liveFor('after')); writeFileSync(join(proof,'ordinary-recovery.json'),liveFor('recovery'));
    for(const file of files) writeFileSync(join(proof,file),'PASS');
    const result=run(harness(role)+close,{WINDOW:'W2b',SECRET_STAGE:stage,PROOF_DIR:proof,EDGE_RECYCLE_TIMER:'fixture.timer',INPUTS_FILE:inputs,PLAN_FILE:planPath,
      BOX_ARCHIVE_PATH:archive,CLOSE_RESULT:outcome,PATH:shim+':'+process.env.PATH});
    const closed=existsSync(join(proof,'closed.txt'));
    if(existsSync(stage)) removeStage(stage);
    return {result,closed};
  };
  let r=attempt('success',['w2b-preconditions.txt','issuer-credential.txt']); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  r=attempt('success',['w2b-preconditions.txt']); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W2b issuer-credential\.txt expected present got missing; STOP/);
  r=attempt('success',['issuer-credential.txt']); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: W2b w2b-preconditions\.txt expected present got missing; STOP/);
  r=attempt('recovered',[]); assert.equal(r.result.status,0,r.result.stderr); assert.ok(r.closed);
  r=attempt('recovered',[],'f'); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: recovered W2b issuer role expected NOLOGIN-without-password got other; STOP/);
  writeFileSync(join(etc,'admin-issuer-database-credentials'),'{}');
  r=attempt('recovered',[]); assert.notEqual(r.result.status,0); assert.ok(!r.closed);
  assert.match(r.result.stderr,/FAIL ai-close: recovered W2b credential file expected absent got present; STOP/);
});

test('admin release plan: W6 activation checks bind the issuer credential to a closed same-release W2b when w2b_window_id is given', () => {
  const source=block('ai-w6-activation-checks');
  const start=`python3 - "$INPUTS_FILE" "$PROOF_DIR/issuer-provenance.txt" <<'PY'\n`;
  assert.equal(source.split(start).length,2,'one provenance check');
  const root=realpathSync(mkdtempSync(join(scratch,'w6-w2b-')));
  const python=source.split(start)[1]!.split('\nPY\n')[0]!.split('/home/commonswarm/admin-issuance').join(join(root,'admin-issuance'));
  const out=join(root,'provenance.txt');
  const dir=join(root,'admin-issuance/release-proofs',`${sha}-W2b-Xyz789`); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'inputs.json'),JSON.stringify({window:'W2b',release_sha:sha,window_id:'Xyz789'}));
  for(const file of ['closed.txt','ordinary-after.json','w2b-preconditions.txt','issuer-credential.txt']) writeFileSync(join(dir,file),'PASS');
  const check=(input:Input)=>spawnSync('python3',['-c',python,inputFile(input),out],{encoding:'utf8'});
  let r=check({...base(),window:'W6',w2b_window_id:'Xyz789'}); assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(out,'utf8'),`issuer credential provenance: W2b Xyz789 closed success at ${sha}\n`);
  r=check({...base(),window:'W6'}); assert.equal(r.status,0,r.stderr); assert.match(readFileSync(out,'utf8'),/W2 of this release \(no w2b_window_id input\)/);
  for(const file of ['closed.txt','ordinary-after.json','w2b-preconditions.txt','issuer-credential.txt']) {
    const saved=readFileSync(join(dir,file)); rmSync(join(dir,file));
    r=check({...base(),window:'W6',w2b_window_id:'Xyz789'}); assert.notEqual(r.status,0,file);
    assert.match(r.stderr,new RegExp(`FAIL ai-w6-activation-checks: W2b ${file.replace(/\./g,'\\.')} expected regular-file got missing-or-not-regular; STOP`));
    writeFileSync(join(dir,file),saved);
  }
  for(const other of [{window:'W2b',release_sha:'f'.repeat(40),window_id:'Xyz789'},{window:'W2',release_sha:sha,window_id:'Xyz789'},{window:'W2b',release_sha:sha,window_id:'Other1'}]) {
    writeFileSync(join(dir,'inputs.json'),JSON.stringify(other));
    r=check({...base(),window:'W6',w2b_window_id:'Xyz789'}); assert.notEqual(r.status,0);
    assert.match(r.stderr,/FAIL ai-w6-activation-checks: W2b inputs\.json expected window-W2b-same-release-and-id got mismatch; STOP/);
  }
  r=check({...base(),window:'W6',w2b_window_id:'Nope00'}); assert.notEqual(r.status,0);
  assert.match(r.stderr,/FAIL ai-w6-activation-checks: W2b proof directory expected directory got missing-or-symlink; STOP/);
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
    assert args[:2] == ['docker', 'run'] and args[-1] == '-'
    sql = kwargs['input']; state = json.loads(fixture_state.read_text()); prior = state['enabled']
    if 'SELECT lane8_evidence_digest IS NOT NULL' in sql: return 't'
    enable = re.search(r'admin_issuance_enabled=(true|false)', sql)
    if enable: state['enabled'] = enable[1] == 'true'
    if 'release_generation=release_generation+1' in sql:
        state['generation'] += 1; state['invalidated'] = True
    if 'measured_generation=release_generation' in sql:
        state['measured_generation'] = state['generation']; state['invalidated'] = False
    fixture_state.write_text(json.dumps(state))
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
    ['/tmp/admin-issuance-', join(root, 'admin-issuance-')],
    ['$(mktemp -d /private/tmp/anvil-secret.XXXXXX)', `$(mktemp -d ${secretRoot}/anvil-secret.XXXXXX)`],
  ]) source = source.split(from).join(to);
  const imports = 'import hashlib,json,os,pathlib,re,subprocess,sys,tarfile,time\n';
  assert.equal(source.split(imports).length - 1, 1);
  source = source.replace(imports, imports + boundary);
  const hook = (mode: string, failed = false) => run(`set -- ${mode}\n${source}`, {
    PATH: `${shim}:${process.env.PATH}`, RECYCLE_FIXTURE_STATE: stateFile, RECYCLE_FIXTURE_CONFIG: config,
    RECYCLE_FIXTURE_FAILURE: failed ? '1' : '0',
  });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const initial = { enabled: true, generation: 7, measured_generation: 7, invalidated: false };
  for (const failed of [true, false]) {
    writeFileSync(stateFile, JSON.stringify(initial));
    const before = hook('before'); assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(state(), { enabled: false, generation: 8, measured_generation: 7, invalidated: true });
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'recycle-intent.json'), 'utf8')), { reopen: true, generation: 8 });
    const after = hook('after', failed);
    if (failed) {
      assert.notEqual(after.status, 0); assert.match(after.stderr, /FAIL recycle hook; issuance stays closed/);
      assert.deepEqual(state(), { enabled: false, generation: 8, measured_generation: 7, invalidated: true });
    } else {
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(state(), { enabled: true, generation: 8, measured_generation: 8, invalidated: false });
    }
    assert.equal(readdirSync(secretRoot).length, 0, 'the complete shell hook cleans each private stage');
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
    assert.equal(positive.status, 0, `${name}: ${positive.stderr}`);
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
  const refreshStart = apply.indexOf('ACTIVATION_GENERATION=');
  const refreshEnd = apply.indexOf('python3 - "$SECRET_STAGE/service.env"', refreshStart);
  const sqlStart = apply.indexOf('python3 - "$INPUTS_FILE" "$PROOF_DIR/activate.sql"');
  const sqlEnd = apply.indexOf('ai_db -q --file /proof/activate.sql', sqlStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart && sqlStart > refreshEnd && sqlEnd > sqlStart);
  const supplied = join(root, 'supplied.json'); writeFileSync(supplied, readFileSync(receipt));
  const result = run('set -euo pipefail\n'+read+apply.slice(refreshStart, refreshEnd)+apply.slice(sqlStart, sqlEnd), {
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
  const sitePlan = `# Site fixture\n\n${fence}sh\n# step: site2-plan-inputs\nW5_SITE_MARK=from-archive\n${fence}\n\n${fence}sh\n# step: site2-02 — fixture\nprintf 'site2-02 ran\\n'\n${fence}\n`;
  const staging = join(root, 'tree'); mkdirSync(dirname(join(staging, sitePath)), { recursive: true }); writeFileSync(join(staging, sitePath), sitePlan);
  mkdirSync(dirname(join(repoDir, sitePath)), { recursive: true }); writeFileSync(join(repoDir, sitePath), sitePlan);
  const tar = join(prep, 'release.tar');
  const made = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t: t.add(sys.argv[2],arcname=sys.argv[3])', tar, join(staging, sitePath), sitePath], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const inputs = join(root, 'inputs.json'); writeFileSync(inputs, JSON.stringify({ ...base(), window: 'W5', archive_sha256: digest(readFileSync(tar)) }));
  const reference = (step: string) => run(block('ai-w5-reference') + '\nprintf "mark=%s\\n" "${W5_SITE_MARK:-unset}"\n',
    { SITE_STEP: step, SITE_RELEASE_REPO: repoDir, PREP_DIR: prep, INPUTS_FILE: inputs, SITE_RELEASE_SHA: sha });
  // Positive: the archive block is evaluated in this shell (its variable persists).
  let r = reference('site2-plan-inputs'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /mark=from-archive/);
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
  assert.equal(readers.length, 17, 'one shared reader at all 17 sites (16 plan-text sites, including ai-w2b-preflight, and ai-w2-backfill)');
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
