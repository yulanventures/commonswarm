import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// @ts-ignore Standalone dependency-free Node script.
import { redactedReceipt } from '../../scripts/dcr-roundtrip.mjs';

const script = fileURLToPath(new URL('../../scripts/dcr-roundtrip.mjs', import.meta.url));
const fixture = new URL('../support/dcr-exercise-fixture.ts', import.meta.url).href;
const workspace = '12345678-1234-4234-8234-123456789abc';
const privateValue = 'PRIVATE_RESPONSE_CONTENT_TOKEN_abcdefgh';
// Three negative probes plus a second claim, identity and inbox check.

async function run(scenario = 'success') {
  const preload = 'data:text/javascript,' + encodeURIComponent(
    `globalThis.__exerciseScenario = ${JSON.stringify(scenario)}; await import(${JSON.stringify(fixture)});`);
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, script,
    '--exercise-tools', '--test-workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', sent = false;
  let calls: any[] = [];
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.on('message', (message: any) => { calls = message.calls; });
  child.stderr!.on('data', data => { stderr += data; });
  child.stdout!.on('data', data => {
    stdout += data;
    if (sent || !stdout.includes('\n')) return;
    sent = true;
    const authorization = new URL(stdout.slice(0, stdout.indexOf('\n')));
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'synthetic-private-code');
    child.stdin!.write(callback.href + '\n'); // Keep producer open to test stdin lifecycle.
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    assert.ok(!stdout.includes(privateValue) && !stderr.includes(privateValue));
    assert.ok(!stdout.includes('synthetic-private-code'));
    return { code, stderr, receipt: JSON.parse(stdout.slice(stdout.indexOf('\n') + 1)), calls };
  } finally { clearTimeout(timer); child.stdin!.destroy(); child.kill('SIGKILL'); }
}

for (const [scenario, reason, maxCalls] of [
  ['wrong_workspace', 'exercise_workspace_failed', 3],
  ['schema_changed', 'exercise_schema_failed', 2],
  ['negative_succeeds', 'exercise_unexpected_outcome', 1],
  ['transport_failure', 'request_or_runtime_failed', 13],
  ['unexpected_tool', 'exercise_catalog_failed', 0],
  ['missing_tool', 'exercise_catalog_failed', 0],
] as const) {
  test(`exercise CLI fails closed on ${scenario} and retains redacted partial receipts`, async () => {
    const result = await run(scenario);
    assert.equal(result.code, 1);
    assert.equal(result.receipt.ok, false);
    assert.match(result.stderr, new RegExp(reason));
    assert.equal(result.calls.length, maxCalls);
    assert.equal(result.receipt.tool_calls.length, maxCalls);
  });
}

test('every tool receipt field projects hostile values onto safe allowlists', () => {
  const receipt = redactedReceipt({ toolCalls: [{ tool: privateValue, ok: privateValue,
    error_code: privateValue, duration_ms: privateValue, result_shape: [privateValue, 'handle'],
    token: privateValue, arguments: { seat: privateValue } }] });
  assert.deepEqual(receipt.tool_calls, [{ tool: 'other', ok: false, error_code: 'other',
    duration_ms: null, result_shape: ['[redacted-key]', 'handle'] }]);
  assert.ok(!JSON.stringify(receipt).includes(privateValue));
});

test('exercise requires an explicit TEST workspace and dry-run never calls fetch', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent(
    "globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };");
  for (const args of [['--exercise-tools'], ['--test-workspace', workspace],
    ['--exercise-tools', '--test-workspace', privateValue], ['--exercise-tools', '--exercise-tools'],
    ['--exercise-tools', '--test-workspace', '00000000-0000-4000-8000-000000000000']]) {
    const result = spawnSync(process.execPath, ['--import', preload, script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Usage:/u);
    assert.ok(!result.stderr.includes(privateValue));
  }
  const result = spawnSync(process.execPath, ['--import', preload, script, '--dry-run', '--exercise-tools',
    '--test-workspace', workspace], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.requests.at(-1).rpc, 'tools/call');
  assert.equal(plan.requests.at(-1).workspace_id_prefix, '12345678');
  assert.ok(!result.stdout.includes(workspace));
});
