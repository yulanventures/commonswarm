import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// @ts-expect-error TS5097: Deno source extension is required.
import { HOSTED_TOOL_TABLE, validateHostedToolArguments } from '../../supabase/functions/mcp/tools.ts';
// @ts-ignore Standalone dependency-free Node script.
import { redactedReceipt } from '../../scripts/dcr-roundtrip.mjs';

const script = fileURLToPath(new URL('../../scripts/dcr-roundtrip.mjs', import.meta.url));
const fixture = new URL('../support/dcr-exercise-fixture.ts', import.meta.url).href;
const workspace = '12345678-1234-4234-8234-123456789abc';
const privateValue = 'PRIVATE_RESPONSE_CONTENT_TOKEN_abcdefgh';
// Three negative probes plus a second claim, identity and inbox check;
// close_session exercises the phase 2 unavailable scaffold.
const exerciseCallCount = 15;

test('release probe explicit inventory matches the registry-driven hosted catalog', () => {
  const source = readFileSync(script, 'utf8');
  const inventory = source.match(/const TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/u);
  assert.ok(inventory, 'release probe keeps its explicit inventory');
  const names = [...inventory[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]);
  assert.equal(names.length, 9, 'the nine core coordination and session tools');
  assert.deepEqual(new Set(names), new Set(HOSTED_TOOL_TABLE.map(tool => tool.name)));
});
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

test('exercise CLI calls every live tool with schema-valid arguments and synthetic dependency order', async () => {
  const { code, receipt, calls } = await run();
  assert.equal(code, 0);
  assert.equal(receipt.ok, true);
  assert.equal(calls.length, exerciseCallCount);
  assert.equal(calls.length, 15, 'nine core tools plus six dependency/negative probes');
  const negatives = new Set([0, 1, 6]);
  const validCalls = calls.filter((_, i) => !negatives.has(i));
  assert.deepEqual(new Set(validCalls.map(c => c.name)), new Set(HOSTED_TOOL_TABLE.map(t => t.name)));
  for (const call of validCalls) validateHostedToolArguments(call.name, call.arguments);
  const claims = calls.filter(c => c.name === 'claim_seat');
  assert.equal(claims.length, 2);
  assert.ok(claims.every(c => c.arguments.workspace_id === workspace));
  assert.notEqual(claims[0].arguments.name, claims[1].arguments.name);
  assert.equal(calls[7].name, 'members');
  const ask = calls[8], inboxB = calls[9], reply = calls[10], inboxA = calls[11];
  assert.equal(ask.name, 'ask'); assert.equal(inboxB.name, 'check');
  assert.equal(reply.name, 'reply'); assert.equal(inboxA.name, 'check');
  assert.equal(ask.arguments.seat, inboxA.arguments.seat);
  assert.equal(reply.arguments.seat, inboxB.arguments.seat);
  assert.notEqual(ask.arguments.seat, inboxB.arguments.seat);
  assert.equal(ask.arguments.recipients[0].id, '00000000-0000-4000-8000-000000000002');
  assert.equal(reply.arguments.signal_id, '00000000-0000-4000-8000-000000000010');
  assert.deepEqual(calls[12].arguments.recipients, ask.arguments.recipients);
  assert.equal(calls[14].name, 'close_session');
  assert.equal(calls[14].arguments.seat, ask.arguments.seat);
  assert.ok(calls.filter(c => c.name === 'check').every(c => !('ack' in c.arguments)));
  const ids = validCalls.map(c => c.arguments.request_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  for (const value of validCalls.flatMap(c => {
    const schema = HOSTED_TOOL_TABLE.find(t => t.name === c.name)!.inputSchema as any;
    // Public enum words (for example "up_next") can also be safe shape keys.
    return Object.entries(c.arguments).filter(([key, value]) => typeof value === 'string' &&
      !schema.properties[key]?.enum?.includes(value)).map(([, value]) => value);
  })) {
    assert.ok(!JSON.stringify(receipt).includes(value as string), 'receipt must omit full handles, IDs and content');
  }
  for (const row of receipt.tool_calls) {
    assert.deepEqual(Object.keys(row).sort(), ['duration_ms', 'error_code', 'ok', 'result_shape', 'tool']);
    assert.equal(typeof row.duration_ms, 'number');
    assert.ok(Array.isArray(row.result_shape));
  }
  assert.deepEqual(receipt.tool_calls.filter((r: any) => !r.ok).map((r: any) => r.error_code),
    [-32602, 'hosted_seat_forbidden', -32602, 'upgrade_required']);
  assert.ok(receipt.tool_calls.some((r: any) => r.result_shape.includes('[redacted-key]')));
});

for (const [scenario, reason, maxCalls] of [
  ['wrong_workspace', 'exercise_workspace_failed', 3],
  ['schema_changed', 'exercise_schema_failed', 2],
  ['negative_succeeds', 'exercise_unexpected_outcome', 1],
  ['transport_failure', 'request_or_runtime_failed', 13],
  ['close_succeeds', 'exercise_unexpected_outcome', 15],
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
