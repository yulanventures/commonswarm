/** Agent read provenance (semantic layer C1): sources, query, row_count and
 * truncated come only from the result already returned, and adding them never
 * turns a result that fit the MCP byte cap into one that does not. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { householdReadProvenance, messageReadProvenance, PROVENANCE_TITLE_MAX } from '../src/protocol/read-provenance.js';
import { HOUSEHOLD_LOCAL_SEAT } from '../src/protocol/household-tool-registry.js';
import { createHouseholdMcpTools } from '../src/mcp/household-tools.js';
import { capFreshCheck, capMcpResult, mapCachedCheck, mapCheck, MCP_RESULT_MAX_BYTES } from '../src/mcp/tools.js';
import type { SignalRecord } from '../src/cloud/command-client.js';
import type { HouseholdObjectClient } from '../src/cloud/household-objects.js';
import type { AgentCheckResult } from '../src/cloud/agent-check.js';

const WS = '11111111-1111-4111-8111-111111111111';
const ref = (id: string) => ({ workspace_id: WS, object_id: id, token: 'tok_' + id.padEnd(22, 'x') });
const object = (i: number, title = `List ${i}`) => ({ object_id: `obj-${i}`, kind: 'list', title, revision: ref(`obj-${i}`) });

test('object and list reads name their sources and selecting query only', () => {
  const result = { status: 'ok', kind: 'object_list', objects: [object(1), object(2)], next_offset: 2 };
  const args = { seat: HOUSEHOLD_LOCAL_SEAT, offset: 0, limit: 2, request_id: 'never-echoed' };
  assert.deepEqual(householdReadProvenance('object_list', args, result), {
    sources: [
      { kind: 'list', id: 'obj-1', title: 'List 1', revision: ref('obj-1').token },
      { kind: 'list', id: 'obj-2', title: 'List 2', revision: ref('obj-2').token },
    ],
    query: { tool: 'object_list', offset: 0, limit: 2 }, row_count: 2, truncated: true,
  });
  const hosted = householdReadProvenance('list_list', { seat: 'seat_x', offset: 0 }, { ...result, next_offset: null })!;
  assert.deepEqual(hosted.query, { tool: 'list_list', offset: 0, kind_filter: 'list' });
  assert.equal(hosted.truncated, false);
});

test('a list read counts its items; a doc read is one row; long titles are cut', () => {
  const long = 'é'.repeat(PROVENANCE_TITLE_MAX + 10);
  const revision = { revision: ref('obj-9'), title: long, kind: 'list' };
  const list = householdReadProvenance('list_read', { seat: 's', object_id: 'obj-9', revision: ref('obj-9') },
    { status: 'ok', kind: 'object_read', revision, live: true,
      content: { kind: 'list', items: [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'c' }] } })!;
  assert.equal(list.row_count, 3);
  assert.equal(list.truncated, false);
  assert.equal(list.query.revision, ref('obj-9').token);
  assert.equal(Array.from(list.sources![0]!.title!).length, PROVENANCE_TITLE_MAX);
  const doc = householdReadProvenance('object_read', { seat: 's', object_id: 'obj-9' },
    { status: 'ok', kind: 'object_read', revision: { ...revision, kind: 'doc' }, live: true, content: { kind: 'doc', markdown: '# x' } })!;
  assert.equal(doc.row_count, 1);
  assert.equal(doc.sources![0]!.kind, 'doc');
});

test('to-do reads: list, read with comments, and queue truncation by asked section', () => {
  const todo = (id: string) => ({ todo_id: id, title: `Todo ${id}` });
  assert.deepEqual(householdReadProvenance('todo_read', { seat: 's', todo_id: 't1' },
    { status: 'ok', todo: todo('t1'), comments: [{ comment_id: 'c1', body: 'secret body' }], next_comment_offset: null }), {
    sources: [{ kind: 'todo', id: 't1', title: 'Todo t1' }, { kind: 'comment', id: 'c1' }],
    query: { tool: 'todo_read', todo_id: 't1' }, row_count: 2, truncated: false,
  });
  const queue = { working: [todo('w')], up_next: [], not_yet: [], requests: [],
    next_offset: { working: null, up_next: 0, not_yet: 0, requests: 0 } };
  // Sections the agent did not ask for report 0, which is not "more rows".
  assert.equal(householdReadProvenance('todo_queue', { seat: 's', section: 'working' }, { status: 'ok', queue })!.truncated, false);
  assert.equal(householdReadProvenance('todo_queue', { seat: 's' }, { status: 'ok', queue })!.truncated, true);
});

test('refusals and writes carry no provenance', () => {
  assert.equal(householdReadProvenance('object_list', {}, { status: 'refused', reason: 'x' }), null);
  assert.equal(householdReadProvenance('todo_create', {}, { status: 'ok' }), null);
});

test('messages name id, sender and time, never the body', () => {
  const p = messageReadProvenance([{ id: 'm1', from: 'Ana', body: 'hello', created_at: new Date(0) }], { tool: 'check' }, false);
  assert.deepEqual(p.sources, [{ kind: 'message', id: 'm1', from: 'Ana', created_at: '1970-01-01T00:00:00.000Z' }]);
  assert.equal(p.row_count, 1);
});

test('local household results that fit before still fit, with provenance shrinking first', async () => {
  const fitsWithout = (result: object) =>
    Buffer.byteLength(JSON.stringify({ isError: false, content: [{ type: 'text', text: JSON.stringify({ ...result, next_action: null }) }] })) <= MCP_RESULT_MAX_BYTES;
  let sawFull = false, sawSmaller = false;
  for (let n = 60; n <= 140; n++) {
    const result = { status: 'ok', kind: 'object_list', objects: Array.from({ length: n }, (_, i) => object(i, 'T'.repeat(60) + i)), next_offset: null };
    const client = { prepare: () => ({ send: async () => result }) } as unknown as HouseholdObjectClient;
    const response = await createHouseholdMcpTools(client).call('object_list', { seat: HOUSEHOLD_LOCAL_SEAT, offset: 0, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MCP_RESULT_MAX_BYTES);
    if (!fitsWithout(result)) continue;
    const output = JSON.parse(response.content[0]!.text);
    assert.equal(response.isError, false, `n=${n} fit before and must still fit`);
    assert.equal(output.objects.length, n);
    if (output.provenance?.sources?.[0]?.title) sawFull = true;
    else sawSmaller = true;
  }
  assert.ok(sawFull && sawSmaller, 'the sweep covers both the full and the reduced forms');
});

test('check withholds no message for provenance', () => {
  const message = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, from: 'Ana', from_kind: 'user',
    sender_owner_relation: 'owner', kind: 'note', body: 'b'.repeat(500), truncated: false, attachment_count: 0,
    created_at: '2026-11-03T00:00:00.000Z' }) as AgentCheckResult['messages'][number];
  const result: AgentCheckResult = { checked: true, cached: false, messages: Array.from({ length: 80 }, (_, i) => message(i)),
    has_more: false, next_action: null, workspace_id: WS, workspace_name: 'W' };
  const { output } = capFreshCheck(result) as { output: { messages: unknown[]; provenance?: { row_count: number; truncated: boolean } } };
  // Same page size as the bare messages (no provenance) would allow.
  let bare = result.messages.length;
  while (Buffer.byteLength(JSON.stringify(mapCheck({ ...result, messages: result.messages.slice(0, bare), has_more: true }, null))) > MCP_RESULT_MAX_BYTES) bare--;
  assert.ok(bare < result.messages.length, 'the page is cut by the cap');
  assert.equal(output.messages.length, bare);
  assert.equal(output.provenance?.truncated, true);
  assert.equal(output.provenance?.row_count, output.messages.length);
});

test('a cached full-text check near the cap is never cut for provenance', () => {
  const row = (body: string) => ({ id: '00000000-0000-4000-8000-000000000001', from: 'Ana', from_kind: 'user', kind: 'note',
    body, created_at: '2026-11-03T00:00:00.000Z' }) as unknown as SignalRecord;
  const bareBytes = (body: string) => Buffer.byteLength(JSON.stringify({ checked: true, cached: true, messages: [{ id: row(body).id,
    from: 'Ana', from_kind: 'user', sender_owner_relation: 'unknown', kind: 'note', body, created_at: '2026-11-03T00:00:00.000Z' }] }));
  // Escaped control characters make an 8,000-character body large; pad to just under the cap.
  let body = '\u0001'.repeat(5000);
  body += 'x'.repeat(MCP_RESULT_MAX_BYTES - bareBytes(body) - 50);
  assert.ok(bareBytes(body) <= MCP_RESULT_MAX_BYTES && bareBytes(body) > MCP_RESULT_MAX_BYTES - 100);
  const capped = capMcpResult(mapCachedCheck(row(body))) as { messages?: { body: string }[]; truncated?: boolean };
  assert.equal(capped.truncated, undefined);
  assert.equal(capped.messages?.[0]?.body, body);
  const small = mapCachedCheck(row('hi')) as { provenance?: { sources: unknown[] } };
  assert.deepEqual(small.provenance?.sources, [{ kind: 'message', id: row('hi').id, from: 'Ana', created_at: '2026-11-03T00:00:00.000Z' }]);
});
