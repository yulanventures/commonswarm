/** Release contract: execute the plan's input/refusal blocks; never operate the box. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
const run = (source: string, env: Record<string, string> = {}) => spawnSync('/bin/bash', [], {
  input: source, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000,
});
// Nonsecret fixtures are retained under the task's temporary root; no HOME change/deletion.
const scratch = mkdtempSync(join(tmpdir(), 'admin-plan-contract-'));
const receiptFile = join(scratch, 'receipt.json');
writeFileSync(receiptFile, '{}\n');
const sha = 'a'.repeat(40), hex = 'b'.repeat(64);
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
  assert.match(block('ai-w3-apply'), /PASS W3 switched and measured/);
  assert.match(block('ai-db-session'), /PASS ai-db-session/);
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

test('admin release plan: W5 and W7 approval is action/release/window/plan bound; activation refuses absent approval before any operation', () => {
  for (const [window, action, id] of [
    ['W5', 'activate-admin-issuance', 'ai-w5-approval'],
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
    if (window === 'W5') {
      const apply = run(block('ai-w5-apply'), { INPUTS_FILE: inputFile({ ...input, approval: null }) });
      assert.notEqual(apply.status, 0);
      assert.match(apply.stderr, /activation approval required; STOP/);
    }
  }
  assert.match(block('ai-w7-proof'), /ai_run ai-w7-approval/);
  assert.match(block('ai-w7-proof'), /ai_run ai-w7-preflight/);
});

test('admin release plan: W3 requires separate terminal fence approval and W6 refuses absent approval inputs', () => {
  const edge: Input = { ...base(), window: 'W3', rollback_decision: 'restore-service' };
  assert.match(validate(edge).stderr, /terminal-legacy-db-fence approval required/);
  edge.legacy_fence_approval = approval(edge, 'terminal-legacy-db-fence');
  assert.equal(validate(edge).status, 0);
  const smoke: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile' };
  smoke.approval = approval(smoke, 'admin-smoke-human-consent');
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
  const names = new Set(contract.windows.W5);
  // The specification, rather than a copied implementation list, owns these requirements.
  const spec = readFileSync('docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md', 'utf8');
  const lanes = spec.split('## Build lanes: ordered reviewable commits')[1]!.split('## Release sequence')[0]!;
  for (const m of lanes.matchAll(/`((?:admin-|legacy-|as-dpop-|edge-dpop-|mcp-refresh-|mcp-interaction-|full-account-)[a-z-]+)`/g)) {
    assert.ok(names.has(m[1]!), `spec gate ${m[1]} not required by W5`);
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


test('admin release plan: C1 owner approval inputs and explicit conflict rulings refuse when absent', () => {
  const input: Input = { ...base(), window: 'W6', rollback_decision: 'close-and-reconcile' };
  input.approval = approval(input, 'admin-smoke-human-consent');
  const c1 = { release_sha: input.release_sha, window_id: input.window_id, plan_sha256: input.plan_sha256,
    owner_user_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', smoke_workspace_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    verification_version: 1, metadata_digest: hex, target_file: receiptFile, state_directory: scratch,
    path_revision_approval: 'task/path-correction', account_approval_revision: 'task/account-scope-ruling' };
  const c1File = join(scratch, 'c1-inputs.json');
  const check = (c: Input) => {
    writeFileSync(c1File, JSON.stringify(c));
    return run(block('ai-w6-preflight'), { INPUTS_FILE: inputFile(input), C1_INPUTS_FILE: c1File });
  };
  assert.equal(check(c1).status, 0, 'positive C1 input control');
  for (const key of Object.keys(c1)) {
    const missing: Input = { ...c1 }; delete missing[key];
    assert.notEqual(check(missing).status, 0, `missing C1 ${key} accepted`);
  }
  for (const key of ['path_revision_approval', 'account_approval_revision']) {
    const refused = check({ ...c1, [key]: '' });
    assert.match(refused.stderr, new RegExp(`${key} required; STOP`));
  }
});

test('admin release plan: credential material is file/stdin only and generating it emits nothing', () => {
  const source = block('ai-w1-issuer-credential');
  assert.match(source, /openssl rand -hex 32 >"\$SECRET_STAGE\/issuer-password"/);
  assert.match(source, /ai_db -q --file - <"\$SECRET_STAGE\/issuer.sql"/);
  assert.match(source, /install -o root -g 986 -m 0440/);
  assert.doesNotMatch(source, /echo\b|set -x|cat "\$SECRET_STAGE\/issuer-password"|--password|PGPASSWORD=/);
  assert.match(block('ai-w1-issuer-rollback'), /NOLOGIN PASSWORD NULL/);
  // Execute the actual secret-producing Python body with synthetic on-box inputs.
  const made = spawnSync('mktemp', ['-d', '/private/tmp/anvil-secret.XXXXXX'], { encoding: 'utf8' });
  assert.equal(made.status, 0); const stage = made.stdout.trim();
  assert.match(stage, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]{6}$/);
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
    const cleanup = spawnSync('/Users/yulanbot/.local/bin/rm', ['-r', '--', stage], { encoding: 'utf8' });
    assert.equal(cleanup.status, 0, `guarded fixture cleanup refused ${stage}: ${cleanup.stderr}`);
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
  assert.match(block('ai-w5-rollback'), /MCP_OAUTH_ADMIN_ISSUANCE_ENABLED/);
  assert.doesNotMatch(block('ai-w5-rollback'), /-f "\$OAUTH_TARGET\/deploy\/mcp-auth\/compose.admin-issuer.yaml"/);
});
