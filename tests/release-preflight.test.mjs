import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { test } from 'node:test';

const repo = process.cwd();
const tool = join(repo, 'scripts/release-preflight.py');
const plans = ['edge-mcp-release/RELEASE.md', 'mcp-auth-release/RELEASE.md', 'site-release/SITE-RELEASE.md', 'dcr-release/RELEASE-V2.md'].map(s => 'docs/evidence/2026-10-02-' + s);
function shellBlocks(text) {
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map(m => m[1]);
}
function contract(text) { return JSON.parse(text.match(/^```release-contract\n([\s\S]*?)^```$/m)[1]); }
function replaceContract(text, value) { return text.replace(/^```release-contract\n[\s\S]*?^```$/m, '```release-contract\n' + JSON.stringify(value) + '\n```'); }
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}
function git(args, cwd) {
  const result = run('git', args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cleanup(root) {
  assert.equal(resolve(root, '..'), '/private/tmp');
  assert.match(root, /^\/private\/tmp\/release-preflight-test\.[\w]+$/);
  const result = run('rm', ['-rf', '--', root]);
  assert.equal(result.status, 0, `guard refused ${root}: ${result.stderr}`);
}
function fixture(file) {
  const root = realpathSync(mkdtempSync('/private/tmp/release-preflight-test.'));
  const text = readFileSync(file, 'utf8');
  const c = contract(text);
  const gitRepo = join(root, 'repo'); mkdirSync(gitRepo);
  // Only repository inputs are staged. The object database, not current files,
  // determines existence; dependency plan bodies are the reviewed real bytes.
  for (const p of [...c.repo_paths].sort((a, b) => a.length - b.length)) {
    const target = join(gitRepo, p);
    if (existsSync(target)) continue;
    if (existsSync(p) && !readableFile(p)) {
      mkdirSync(target, { recursive: true }); writeFileSync(join(target, '.fixture'), 'tree');
    } else {
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, existsSync(p) ? readFileSync(p) : 'fixture');
    }
  }
  for (const r of Object.values(c.references ?? {})) {
    const target = join(gitRepo, r.plan); mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(r.plan));
  }
  git(['init', '-q'], gitRepo); git(['add', '.'], gitRepo);
  git(['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture.local', 'commit', '-qm', 'fixture'], gitRepo);
  const sha = git(['rev-parse', 'HEAD'], gitRepo);
  const inputs = {};
  for (const [key, rule] of Object.entries(c.inputs)) {
    const fmt = rule.format;
    let value;
    if (fmt === 'sha40') value = key === c.release_input ? sha : 'e'.repeat(40);
    else if (fmt === 'digest') value = 'sha256:' + 'd'.repeat(64);
    else if (fmt === 'decimal-positive') value = '120';
    else if (fmt === 'schema-set') value = '20261002000001,20260916000001';
    else if (fmt === 'utc-window') value = new Date(Date.now() + 1200000).toISOString().slice(0, 19) + 'Z';
    else if (fmt.startsWith('literal:')) value = fmt.slice(8);
    else if (fmt === 'op-reference') value = 'op://Yulan Ventures Infra/Test/document';
    else {
      value = join(root, key);
      if (fmt === 'empty-dir') mkdirSync(value, { mode: rule.mode ?? 0o700 });
      else writeFileSync(value, '{}', { mode: rule.mode ?? 0o600 });
    }
    inputs[key] = value;
  }
  const plan = inputs[c.plan_input]; writeFileSync(plan, text);
  if (c.gate_receipts) writeFileSync(inputs.GATE_EVIDENCE_FILE, JSON.stringify({ sha, gates: Object.fromEntries(c.gate_receipts[0].gates.map(g => [g, 'PASS'])), note: 'Labels and prose are immaterial.' }));
  const inputFile = join(root, 'inputs.json');
  const check = (values = inputs, source = text) => {
    writeFileSync(plan, source); writeFileSync(inputFile, JSON.stringify(values));
    return run('python3', [tool, plan, inputFile, gitRepo]);
  };
  return { root, c, text, sha, gitRepo, plan, inputFile, inputs, check };
}
function readableFile(p) {
  try { readFileSync(p); return true; } catch (e) { if (e.code === 'EISDIR') return false; throw e; }
}

for (const file of plans) {
  test(`${file}: Bash 3.2 syntax and first marked preflight`, () => {
    const text = readFileSync(file, 'utf8'); const blocks = shellBlocks(text);
    assert.match(blocks[0], /^# step: [\w-]+-release-shared-preflight\n# readonly: yes/);
    for (const source of blocks) {
      const parsed = run('/bin/bash', ['-n'], { input: source });
      assert.equal(parsed.status, 0, source.split('\n')[0] + ': ' + parsed.stderr);
    }
  });
  test(`${file}: preflight aggregates input, path, dependency, cleanup and box-read problems`, () => {
    const f = fixture(file);
    try {
      const positive = f.check(); assert.equal(positive.status, 0, positive.stdout + positive.stderr); assert.equal(positive.stdout.trim(), 'PASS');
      for (const key of Object.keys(f.c.inputs)) {
        for (const value of [undefined, 'invalid']) {
          const result = f.check({ ...f.inputs, [key]: value });
          assert.notEqual(result.status, 0, `${key} ${value}`);
          assert.ok(result.stdout.includes('field ' + key + ':'), result.stdout);
        }
      }
      const c = structuredClone(f.c); c.repo_paths.push('missing-at-release.txt');
      // A worktree-only file cannot satisfy exact-SHA repository identity.
      writeFileSync(join(f.gitRepo, 'missing-at-release.txt'), 'uncommitted');
      const first = c.routes.normal[0];
      c.steps[first].consumes = ['$PROOF_DIR/future-file.json'];
      const last = c.routes.normal.at(-1);
      c.steps[last].creates = [...(c.steps[last].creates ?? []), '$PROOF_DIR/future-file.json'];
      c.steps[last].cleanup = [...(c.steps[last].cleanup ?? []), '/unowned/cleanup'];
      const measuring = Object.keys(c.steps).find(s => c.steps[s].reads.length);
      const missingRead = c.steps[measuring].reads[0];
      c.steps[measuring].reads = c.steps[measuring].reads.slice(1);
      const result = f.check({ ...f.inputs, [Object.keys(f.c.inputs)[0]]: '' }, replaceContract(f.text, c));
      assert.notEqual(result.status, 0); assert.match(result.stdout, /missing at RELEASE_SHA/);
      assert.match(result.stdout, /consumer has no earlier producer\/input/);
      assert.match(result.stdout, /cleanup target not created/);
      assert.ok(result.stdout.includes('box measurement not listed as read: ' + missingRead), result.stdout);
      const lexical = f.check(f.inputs, f.text.replace('set -euo pipefail', 'set -euo pipefail\ncat scripts/unlisted-release-file.json'));
      assert.notEqual(lexical.status, 0); assert.match(lexical.stdout, /repo path absent from inventory/);
      assert.match(lexical.stdout, /block changed/);
      const cleanupContract = structuredClone(f.c);
      const cleanupStep = Object.keys(cleanupContract.steps).find(s => Object.keys(cleanupContract.steps[s].cleanup_owners ?? {}).length);
      cleanupContract.steps[cleanupStep].cleanup_owners = {};
      const unowned = f.check(f.inputs, replaceContract(f.text, cleanupContract));
      assert.notEqual(unowned.status, 0); assert.match(unowned.stdout, /cleanup target not created by plan/);
      const pathField = Object.keys(f.c.inputs).find(k => f.c.inputs[k].mode === 0o600);
      if (pathField) {
        chmodSync(f.inputs[pathField], 0o644);
        const loose = f.check(); assert.notEqual(loose.status, 0); assert.ok(loose.stdout.includes('field ' + pathField + ':'));
        chmodSync(f.inputs[pathField], 0o600);
      }
      const shared = shellBlocks(f.text)[0];
      // Reset mutation before this real first-block invocation.
      f.check();
      const final = run('/bin/bash', ['-euo', 'pipefail'], { cwd: f.gitRepo, input: shared + '\ntest "$' + f.c.release_input + '" = "' + f.sha + '"\n', env: { ...process.env, [f.c.plan_input]: f.plan, RELEASE_INPUTS_JSON: f.inputFile } });
      assert.equal(final.status, 0, final.stdout + final.stderr);
    } finally { cleanup(f.root); }
  });
  test(`${file}: closure catches copy-back/cleanup failures without rollback`, () => {
    const closeBlocks = shellBlocks(readFileSync(file, 'utf8')).filter(s => s.includes('release_close_exit() {'));
    assert.ok(closeBlocks.length);
    for (const b of closeBlocks) {
      const handler = b.match(/release_close_exit\(\) \{[\s\S]*?\n\}\ntrap release_close_exit EXIT/)[0];
      for (const operation of ['scp', 'rm']) {
        const script = `set -euo pipefail\n${handler}\nRELEASE_LIVE_STATE='ON source=verified-sha timer=active lock=held'\nrollback() { printf 'ROLLBACK_CALLED'; }\n${operation}() { printf 'injected failure' >&2; return 23; }\n${operation} task-owned-evidence\n`;
        const failure = run('/bin/bash', ['-euo', 'pipefail'], { input: script });
        assert.equal(failure.status, 23); assert.match(failure.stderr, /CLOSE_FAILED/);
        assert.match(failure.stderr, /LIVE_STATE=ON source=verified-sha/);
        assert.doesNotMatch(failure.stdout + failure.stderr, /ROLLBACK_CALLED/);
      }
      const success = run('/bin/bash', ['-euo', 'pipefail'], { input: 'set -euo pipefail\n' + handler + '\ntrue\n' });
      assert.equal(success.status, 0); assert.doesNotMatch(success.stderr, /CLOSE_FAILED/);
    }
  });
}

test('JSON gate identity tolerates prose and field order, rejects wrong/missing/failed fields', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/release-preflight-test.'));
  try {
    const file = join(root, 'receipt.json'), sha = 'a'.repeat(40);
    const runGate = value => { writeFileSync(file, JSON.stringify(value)); return run('python3', [tool, 'gate', file, sha, 'build', 'CI']); };
    assert.equal(runGate({ note: 'No prescribed English text.', gates: { CI: 'PASS', build: 'PASS' }, sha }).status, 0);
    for (const value of [{ sha: 'b'.repeat(40), gates: { build: 'PASS', CI: 'PASS' } }, { sha, gates: { build: 'PASS' } }, { sha, gates: { build: 'FAIL', CI: 'PASS' } }]) assert.notEqual(runGate(value).status, 0);
    writeFileSync(file, `  SHA=${sha} plus prose\nPUBLIC_BYTES=PASS user_agent=changed-agent/2\n`);
    assert.equal(run('python3', [tool, 'fields', file, 'PUBLIC_BYTES=PASS']).status, 0);
    writeFileSync(file, 'PUBLIC_BYTES=PASS\nPUBLIC_BYTES=PASS\n');
    assert.notEqual(run('python3', [tool, 'fields', file, 'PUBLIC_BYTES=PASS']).status, 0);
  } finally { cleanup(root); }
});

test('site deletion evidence runs genuine guard refusal and positive controls without HOME changes', () => {
  const result = run('python3', [tool, 'deletion-controls', repo]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('JWKS route checks accept JSON base types with only an optional charset', () => {
  for (const file of [plans[1], plans[3]]) {
    const source = readFileSync(file, 'utf8');
    const assertion = source.match(/if path=='\/jwks':\n([\s\S]*?)\n\s+else:/)[1];
    const lines = assertion.split('\n');
    const indent = lines[0].match(/^\s*/)[0].length;
    const check = lines.map(line => '  ' + line.slice(indent)).join('\n');
    const result = run('python3', ['-'], { input: `import re\nfrom email.message import Message\nclass Response: pass\nresponse=Response()\nfacts='fixture'\nfor media,ok in [('Application/JWK-SET+JSON',True),('application/json',True),('application/json; charset="UTF-8"',True),('application/jwk-set+json ; CHARSET=utf-8',True),('application/jwk-set+json; profile=x',False),('application/json; charset=UTF-8; profile=x',False),('application/json; version=1',False),('text/html',False),('application/not-jwks+json',False)]:\n response.headers=Message();response.headers['Content-Type']=media\n content_type=media\n try:\n${check}\n except AssertionError:\n  assert not ok,media\n else:\n  assert ok,media\n` });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('site public-byte, rollback and MCP receipt gates require the release probe UA', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/release-preflight-test.'));
  try {
    const source = readFileSync(plans[2], 'utf8');
    for (const step of ['site2-00-a-close-ingest', 'site2-03-go-record', 'site2-05', 'site2-06']) {
      const producer = shellBlocks(source).find(b => b.startsWith(`# step: ${step} `) || b.startsWith(`# step: ${step}\n`));
      assert.equal(JSON.parse(producer.match(/^UA\s*=\s*("[^"]+")/m)[1]), 'curl/8.7.1', `${step} must send and record the required UA`);
    }
    const gates = [...source.matchAll(/^\s*(python3 "\$RELEASE_PREFLIGHT_TOOL" fields "\$SITE_EVIDENCE\/([^"\n]+)" (PUBLIC_BYTES|ROLLBACK_PUBLIC_BYTES|MCP_LIVE)=PASS[^\n]*)$/gm)];
    assert.equal(gates.length, 5, 'all five release receipt consumers must be exercised');
    for (const [, command, name, key] of gates) {
      const check = receipt => {
        writeFileSync(join(root, name), receipt);
        return run('/bin/bash', ['-euo', 'pipefail'], { input: command, env: { ...process.env, RELEASE_PREFLIGHT_TOOL: tool, SITE_EVIDENCE: root } });
      };
      assert.equal(check(`${key}=PASS user_agent=curl/8.7.1\n`).status, 0, command);
      for (const receipt of [`${key}=PASS user_agent=wrong-agent\n`, `${key}=PASS\n`, `${key}=PASS user_agent=curl/8.7.1 user_agent=wrong-agent\n`, `${key}=FAIL user_agent=curl/8.7.1\n`]) {
        assert.notEqual(check(receipt).status, 0, `${command}: accepted ${receipt}`);
      }
    }
  } finally { cleanup(root); }
});

test('edge close classifies an already-closed budget failure as closure, and failed verification as deployment', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/release-preflight-test.'));
  try {
    const source = shellBlocks(readFileSync(plans[0], 'utf8')).find(b => b.startsWith('# step: edge-mcp-close\n'));
    // Only remap the box state file; run the real phase assignments and branches.
    const script = source.replace('. "/home/commonswarm/edge/release-proofs/${1:?}-${2:?}/state.sh"', '. "$CLOSE_TEST_STATE"');
    assert.notEqual(script, source);
    const state = join(root, 'state.sh');
    writeFileSync(state, `PROOF_DIR="$CLOSE_TEST_PROOF"\nNEW_EDGE=/fixture/verified-edge\nPREVIOUS_EDGE=/fixture/baseline-edge\nreadlink() { printf '%s\\n' "$NEW_EDGE"; }\nedge_check() { echo VERIFICATION_REACHED; return "$CLOSE_TEST_VERIFY_STATUS"; }\nedge_probes() { echo PROBES_REACHED; }\nexternal_check() { echo EXTERNAL_REACHED; }\ncmp() { return 0; }\nsystemctl() { echo TIMER_REACHED; return 23; }\n`);
    for (const [name, closed, budget, verification, status, phase, action] of [
      ['closed-success', true, 'yes', '0', 0, null, null],
      ['closed-budget-failure', true, 'no', '0', 1, 'CLOSE_FAILED', 'retain-verified-bytes'],
      ['verification-failure', false, 'yes', '23', 23, 'DEPLOY_FAILED', 'run-marked-recovery'],
      ['timer-failure-after-verification', false, 'yes', '0', 23, 'CLOSE_FAILED', 'retain-verified-bytes'],
    ]) {
      const proof = join(root, name); mkdirSync(proof);
      writeFileSync(join(proof, 'mcp-503-receipt.txt'), `budget_met=${budget}\n`);
      if (closed) writeFileSync(join(proof, 'closed.txt'), 'closed\n');
      const result = run('/bin/bash', ['-euo', 'pipefail'], { input: script, env: { ...process.env, CLOSE_TEST_STATE: state, CLOSE_TEST_PROOF: proof, CLOSE_TEST_VERIFY_STATUS: verification } });
      assert.equal(result.status, status, name + ': ' + result.stderr);
      if (phase) {
        assert.match(result.stderr, new RegExp(`${phase} step=edge-mcp-close`));
        assert.match(result.stderr, new RegExp(`ACTION=${action}`));
      } else assert.doesNotMatch(result.stderr, /CLOSE_FAILED|DEPLOY_FAILED/);
      if (closed) assert.doesNotMatch(result.stdout, /VERIFICATION_REACHED/);
      else assert.match(result.stdout, /VERIFICATION_REACHED/);
      if (verification === '23') assert.doesNotMatch(result.stdout, /PROBES_REACHED|TIMER_REACHED/);
      if (!closed && verification === '0') assert.match(result.stdout, /TIMER_REACHED/);
    }
  } finally { cleanup(root); }
});

test('site assertions passing before a daemon/copy-back failure cannot request rollback', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/release-preflight-test.'));
  try {
    const source = shellBlocks(readFileSync(plans[2], 'utf8')).find(b => b.startsWith('# step: site2-05-browser-acceptance '));
    const classifier = source.match(/python3 - "\$SITE_EVIDENCE" site2-05-browser-acceptance "\$branch" "\$browser_status" <<'PY'\n([\s\S]*?)\nPY/)[1];
    const label = 'site2-05-browser-acceptance';
    writeFileSync(join(root, label + '-assertions-started.txt'), 'ASSERTIONS_STARTED\n');
    for (const [reason, json, expected] of [['STEP 10 (Connected apps assertions)', false, 'yes'], ['STEP 14 (receipt write)', false, 'no'], ['STEP 10 (Connected apps assertions)', true, 'no']]) {
      writeFileSync(join(root, label + '-summary.txt'), label + ': ' + reason + '; exit code 23\n');
      if (json) writeFileSync(join(root, 'site2-05-browser.json'), '{"branch":"FULL-CONTROL","identity":"PASS"}');
      const result = run('python3', ['-', root, label, 'FULL-CONTROL', '23'], { input: classifier });
      assert.equal(result.status, 0, result.stderr);
      const receipt = readFileSync(join(root, label + '-receipt.txt'), 'utf8');
      assert.ok(receipt.includes('blocking=' + expected), receipt);
      if (expected === 'no') assert.match(result.stderr, /CLOSE_FAILED/);
      else assert.doesNotMatch(result.stderr, /CLOSE_FAILED/);
    }
  } finally { cleanup(root); }
});
