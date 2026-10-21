/** Hosted list contracts exercise core admission, paging and stale writes. The
 * independently built snapshot of main before #68 (432948ef) pins all existing catalog bytes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HOUSEHOLD_TOOLS, HOSTED_TODO_LIST_TOOLS, HOUSEHOLD_LIST_TOOL_REGISTRY, HOUSEHOLD_TOOL_REGISTRY,
  householdToolInvocation, validateHostedTodoListToolArguments, boundHouseholdListResult } from '../src/protocol/household-tool-registry.js';
import { MCP_TOOLS } from '../src/mcp/tools.js';
import { emptyHouseholdObjectState, decideHouseholdObject, reduceHouseholdObjectStream, readHouseholdObjects,
  type HouseholdObjectCommand, type HouseholdVerifiedContent } from '../src/protocol/household-objects.js';
import type { HouseholdContent, HouseholdObjectState } from '../src/protocol/household-object-events.js';
import type { HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';

const seat = `seat_${'a'.repeat(22)}`, workspace = 'household', host = { workspace_id: workspace };
const access: HouseholdAccessFacts = { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
  actor: { user_id: 'alex', principal_id: null, run_id: null }, credential: { kind: 'human' },
  member: { user_id: 'alex', workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: 'yes' } };
const list: HouseholdContent = { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', order: 0, checked: false }] };
function artifact(object_id: string, content: HouseholdContent): HouseholdVerifiedContent {
  const bytes = JSON.stringify(content);
  return { workspace_id: workspace, object_id, revision: null, content,
    blob: { storage_key: `${workspace}/${object_id}/bytes`, size_bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } };
}
function decide(state: HouseholdObjectState, command: HouseholdObjectCommand, prepared: HouseholdVerifiedContent, contents: HouseholdVerifiedContent[] = []) {
  const n = state.last_seq + 2;
  return decideHouseholdObject(command, state, { access, now: 100, command_id: `request_${n}`, seq: n - 1,
    request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), event_id: `event_${n}`,
    revision_token: `revision_${String(n).padStart(24, '0')}`, draft_id: `draft_${n}`, prepared, contents,
    other_storage_bytes: 0, other_object_count: 0, identity_write_attempts: 0, workspace_write_attempts: 0 });
}
function seed() {
  let state = emptyHouseholdObjectState(workspace, 'stream');
  for (const [id, content] of [['shopping', list], ['doc', { kind: 'doc', markdown: 'Notes' }],
    ['file', { kind: 'file', name: 'notes.txt', media_type: 'text/plain' }]] as [string, HouseholdContent][]) {
    const result = decide(state, { kind: 'create_household_object', object_id: id, title: id, content }, artifact(id, content));
    assert.equal(result.outcome.status, 'committed'); state = reduceHouseholdObjectStream(result.events, state);
  }
  return state;
}
test('list admission refuses doc/file reads, history, patches and comment targets beside list controls', () => {
  const state = seed();
  for (const name of ['list_read', 'list_history']) for (const id of ['shopping', 'doc', 'file']) {
    const call = householdToolInvocation(name, { seat, object_id: id, ...(name === 'list_history' ? { offset: 0, limit: 1 } : {}) }, host);
    assert.ok('query' in call && !call.query.kind.startsWith('todo') && 'object_id' in call.query);
    const result = readHouseholdObjects(call.query as Parameters<typeof readHouseholdObjects>[0], state, access, 100);
    assert.equal(result.status, id === 'shopping' ? 'ok' : 'refused');
    if (result.status === 'refused') assert.equal(result.reason, 'object_type_mismatch');
  }
  for (const name of ['comment_list', 'todo_comment']) for (const kind of ['todo', 'list', 'doc', 'file']) {
    const args = { seat, target: { kind, id: kind === 'todo' ? '00000000-0000-4000-8000-000000000001' : 'shopping' },
      ...(name === 'todo_comment' ? { request_id: 'request_1', body: 'Hello' } : {}) };
    if (kind === 'todo' || kind === 'list') validateHostedTodoListToolArguments(name, args);
    else assert.throws(() => validateHostedTodoListToolArguments(name, args));
  }
  const patch = { kind: 'list', operations: [] };
  for (const id of ['shopping', 'doc', 'file']) {
    const base = state.objects[id]!.history[0]!.revision;
    const call = householdToolInvocation('list_update', { seat, request_id: 'request_1', object_id: id, base, patch }, host);
    assert.ok('command' in call);
    const original = artifact(id, id === 'shopping' ? list : id === 'doc' ? { kind: 'doc', markdown: 'Notes' } : { kind: 'file', name: 'notes.txt', media_type: 'text/plain' });
    const outcome: ReturnType<typeof decideHouseholdObject>['outcome'] = decide(state, call.command as HouseholdObjectCommand, { ...artifact(id, list), revision: base }, [{ ...original, revision: base }]).outcome;
    assert.equal(outcome.status, id === 'shopping' ? 'committed' : 'refused');
  }
  for (const content of [{ kind: 'doc', markdown: 'x' }, { kind: 'file', name: 'x', media_type: 'text/plain' }])
    assert.throws(() => validateHostedTodoListToolArguments('list_create', { seat, request_id: 'request_1', object_id: 'new', title: 'New', content }));
});
test('paging filters before offsets, bounds counts and bytes, and refuses oversized singleton content', () => {
  for (const name of ['list_list', 'list_history']) {
    const args = { seat, offset: 0, limit: 50, ...(name === 'list_history' ? { object_id: 'shopping' } : {}) };
    validateHostedTodoListToolArguments(name, args);
    for (const limit of [0, 51, 1.5]) assert.throws(() => validateHostedTodoListToolArguments(name, { ...args, limit }));
    assert.throws(() => validateHostedTodoListToolArguments(name, { ...args, offset: -1 }));
  }
  const call = householdToolInvocation('list_list', { seat, offset: 0, limit: 1 }, host);
  assert.ok('query' in call);
  const result = readHouseholdObjects(call.query as Parameters<typeof readHouseholdObjects>[0], seed(), access, 100);
  assert.ok(result.status === 'ok' && result.kind === 'object_list'); assert.deepEqual(result.objects.map(o => o.object_id), ['shopping']);
  const rows = [{ title: '\\"'.repeat(3000) }, { title: '\\"'.repeat(3000) }];
  const page = boundHouseholdListResult({ status: 'ok', objects: rows, next_offset: null }, 5);
  assert.equal((page.objects as unknown[]).length, 1); assert.equal(page.next_offset, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(page))) <= 28 * 1024);
  assert.deepEqual(boundHouseholdListResult({ status: 'ok', content: { kind: 'list', items: [{ text: 'x'.repeat(65536) }] } }),
    { status: 'refused', reason: 'list_response_too_large' });
});
test('stale list base retains the existing conflict shape and draft', () => {
  let state = seed(); const base = state.objects.shopping!.history[0]!.revision;
  const original = { ...artifact('shopping', list), revision: base };
  const args = { seat, request_id: 'request_1', object_id: 'shopping', base, patch: { kind: 'list', operations: [] } };
  const call = householdToolInvocation('list_update', args, host); assert.ok('command' in call);
  const wrong = householdToolInvocation('list_update', { ...args, patch: { kind: 'list', operations: [{ kind: 'set', item_id: 'milk', before_text: 'Wrong', before_checked: false, text: 'Milk', checked: true }] } }, host);
  assert.ok('command' in wrong);
  const changed = { ...artifact('shopping', { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', order: 0, checked: true }] }), revision: base };
  assert.deepEqual(decide(state, wrong.command as HouseholdObjectCommand, changed, [original]).outcome, { status: 'refused', reason: 'patch_base_mismatch' });
  const exact = { ...wrong.command, patch: { kind: 'list', operations: [{ kind: 'set', item_id: 'milk', before_text: 'Milk', before_checked: false, text: 'Milk', checked: true }] } } as HouseholdObjectCommand;
  assert.equal(decide(state, exact, changed, [original]).outcome.status, 'committed');
  state = reduceHouseholdObjectStream(decide(state, call.command as HouseholdObjectCommand, original, [original]).events, state);
  const result = decide(state, call.command as HouseholdObjectCommand, original, [original]);
  assert.deepEqual(result.outcome, { status: 'conflict', object_id: 'shopping', current: state.objects.shopping!.history.at(-1)!.revision, draft_id: 'draft_5' });
  assert.equal(result.events[0]!.type, 'HouseholdDraftPreserved');
});
test('hosted inventory and unchanged local catalog match independently built pre-#68 main bytes', async () => {
  // Pinned to main before the hosted list tools (#68); origin/main moves and would compare the change with itself.
  const snapshot = execFileSync('git', ['show', '432948ef104a827269f447b64549c1723f2bb66f:src/protocol/household-tool-registry.ts'], { encoding: 'utf8' });
  const built = await build({ entryPoints: ['src/mcp/tools.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'main-snapshot', setup(builder) { builder.onLoad({ filter: /household-tool-registry\.ts$/ }, () => ({ contents: snapshot, loader: 'ts', resolveDir: resolve('src/protocol') })); } }] });
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`);
  assert.equal(JSON.stringify(MCP_TOOLS.filter(t => t.name !== 'object_draft_read')), JSON.stringify(baseline.MCP_TOOLS)); assert.equal(MCP_TOOLS.length, 28);
  assert.equal(JSON.stringify(HOUSEHOLD_TOOLS.filter(t => t.name !== 'object_draft_read')), JSON.stringify(baseline.MCP_TOOLS.slice(-18)));
  assert.deepEqual(HOSTED_TODO_LIST_TOOLS.map(t => t.name), [...HOUSEHOLD_TOOLS.filter(t => t.name.startsWith('todo_') || t.name === 'comment_list').map(t => t.name), ...HOUSEHOLD_LIST_TOOL_REGISTRY.map(t => t.name)]);
  assert.equal(HOSTED_TODO_LIST_TOOLS.length, 16);
  assert.ok(HOUSEHOLD_LIST_TOOL_REGISTRY.every(tool => HOUSEHOLD_TOOL_REGISTRY.some(row => row.name === tool.name)));
  for (const tool of HOSTED_TODO_LIST_TOOLS.slice(-6)) assert.deepEqual(tool.annotations, { title: tool.title,
    readOnlyHint: ['list_list', 'list_read', 'list_history', 'list_draft_read'].includes(tool.name), destructiveHint: ['list_create', 'list_update'].includes(tool.name), idempotentHint: true, openWorldHint: false });
});
