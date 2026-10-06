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
// Extra calls: three negative probes, a second claim/identity/check and an
// object readback and a to-do version refresh after commenting. The remaining
// calls cover each advertised tool once.
const exerciseCallCount = HOSTED_TOOL_TABLE.length + 8;

test('release probe explicit inventory matches the registry-driven hosted catalog', () => {
  const source = readFileSync(script, 'utf8');
  const inventory = source.match(/const TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/u);
  assert.ok(inventory, 'release probe keeps its explicit inventory');
  const names = [...inventory[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]);
  assert.equal(names.length, 23, 'eight core tools, five object tools and ten to-do/comment tools');
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
  assert.equal(calls.length, 31, 'the release probe calls all 23 tools plus eight dependency/negative probes');
  const negatives = new Set([0, 1, 6]);
  const positives = calls.filter((_, i) => !negatives.has(i));
  assert.deepEqual(new Set(positives.map(c => c.name)), new Set(HOSTED_TOOL_TABLE.map(t => t.name)));
  for (const call of positives) validateHostedToolArguments(call.name, call.arguments);
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
  const update = calls.find(c => c.name === 'object_update')!;
  assert.deepEqual(update.arguments.base, { workspace_id: workspace, object_id: update.arguments.object_id, token: 'r'.repeat(32) });
  assert.ok(!calls.some(c => ['file_read', 'file_upload_begin', 'file_upload_commit'].includes(c.name)));
  assert.ok(calls.filter(c => c.name === 'check').every(c => !('ack' in c.arguments)));
  const todoCreate = calls.find(c => c.name === 'todo_create')!;
  const todoRead = calls.find(c => c.name === 'todo_read')!;
  const todoComment = calls.find(c => c.name === 'todo_comment')!;
  const todoAssign = calls.find(c => c.name === 'todo_assign')!;
  const todoDone = calls.find(c => c.name === 'todo_set_state')!;
  assert.equal(todoCreate.arguments.seat, todoRead.arguments.seat);
  assert.equal(todoComment.arguments.target.id, todoRead.arguments.todo_id);
  assert.equal(todoAssign.arguments.todo_id, todoRead.arguments.todo_id);
  assert.equal(todoAssign.arguments.to.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(todoAssign.arguments.start, 'queue', 'agent assignment avoids human-only front placement');
  assert.equal(todoDone.arguments.todo_id, todoRead.arguments.todo_id);
  assert.equal(todoDone.arguments.state, 'done');
  assert.equal(todoDone.arguments.base_version, 5, 'comment, update, assign and start each advance the created version');
  assert.ok(receipt.tool_calls.some((r: any) => r.tool === 'todo_set_state' && r.ok));
  assert.deepEqual(receipt.tool_calls.find((r: any) => r.tool === 'todo_queue').result_shape, ['queue', 'status']);
  const ids = positives.map(c => c.arguments.request_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  for (const value of positives.flatMap(c => {
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
    [-32602, 'hosted_seat_forbidden', -32602]);
  assert.ok(receipt.tool_calls.some((r: any) => r.result_shape.includes('[redacted-key]')));
});

test('exercise refreshes the to-do version after comments before changing details', async () => {
  const result = await run('comment_version_advanced');
  assert.equal(result.code, 0);
  assert.equal(result.receipt.ok, true);
  const updateIndex = result.calls.findIndex(c => c.name === 'todo_update');
  assert.equal(result.calls[updateIndex - 1].name, 'todo_read');
  assert.equal(result.calls[updateIndex].arguments.base_version, 3, 'two committed comments advance the created version');
  assert.equal(result.calls.find(c => c.name === 'todo_set_state')!.arguments.base_version, 6);
});

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
