import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { HouseholdObjectClient } from '../../src/cloud/household-objects.js';
import { createHouseholdHttpTransport, LOCAL_HOUSEHOLD_SEAT as seat } from '../../src/cloud/household-http.js';
import { createHouseholdMcpTools } from '../../src/mcp/household-tools.js';
import { MCP_RESULT_MAX_BYTES } from '../../src/mcp/tools.js';
import { HOUSEHOLD_TOOL_REGISTRY } from '../../src/protocol/household-tool-registry.js';
import { decideTodo, emptyHouseholdTodoState, reduceTodoEvents, type Todo, type TodoCommand } from '../../src/protocol/household-todos.js';
import type { HouseholdAccessFacts } from '../../src/protocol/household-object-policy.js';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1), user = uid(2), principal = uid(3), todoId = uid(4), commentId = uid(5);
const at = '2026-10-05T12:00:00.000Z';
const author = { user_id: user, principal_id: principal };
function storedTodo(extra: Partial<Todo> = {}): Todo {
  return { workspace_id: workspace, todo_id: todoId, version: 1, title: 'Buy milk', notes: '', state: 'open', due_on: null,
    created_by: author, created_at: at, assignee: null, assigned_by: null, assigned_at: null, offer: null,
    gate: { kind: 'none' }, gate_set_by: null, queue_rank: null, state_by: author, state_at: at, comment_count: 0, ...extra };
}
const detail = (todo = storedTodo()) => ({ ...todo, gate_clear: true, queue_position: todo.assignee ? 1 : null });
const summary = (todo = storedTodo()) => ({ todo_id: todo.todo_id, version: todo.version, title: todo.title, state: todo.state,
  due_on: todo.due_on, assignee: todo.assignee, offer: null, gate: { kind: 'none', clear: true },
  queue_position: todo.assignee ? 1 : null, comment_count: todo.comment_count, state_at: todo.state_at });
const comment = (body = 'Thanks') => ({ comment_id: commentId, target: { kind: 'todo', id: todoId }, author, body, mentions: [], created_at: at });
const queue = (up_next: unknown[] = []) => ({ workspace_id: workspace, principal_id: principal, owner_user_id: user,
  accepts_from: 'owner', content_access: 'read_write', read_at: at,
  status: { work: 'idle', facts: { transport: 'local', turn_only: false, connection: 'live', last_activity_at: at,
    messages_waiting_since: null, doing: null, working_on: null } },
  working: [], up_next, not_yet: [], requests: [], next_offset: { working: null, up_next: null, not_yet: null, requests: null } });
const clientFor = (response: unknown) => new HouseholdObjectClient({ execute: async () => response }, workspace);
const payload = (result: { content: readonly { text: string }[] }) => JSON.parse(result.content[0]!.text);

test('local HTTP and MCP round trip creates, assigns, queues, starts and completes through the real reducer', async () => {
  let state = emptyHouseholdTodoState(workspace, uid(10));
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let lost = false;
  const access: HouseholdAccessFacts = { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
    actor: { ...author, run_id: uid(6) }, member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: uid(7) },
    credential: { kind: 'agent', connection: { principal_id: principal, owner_user_id: user, workspace_id: workspace,
      connection_id: uid(8), grant_id: uid(9), revoked_at: null, expires_at: Date.parse(at) + 10000, operations: ['read', 'create', 'update'], purpose: 'shared' } } };
  // No sockets: injected fetch runs the actual write decider/reducer. Reads use
  // the independently specified server wire shape, including its missing kind.
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.workspace_id, workspace);
    const wire = body.resource ? body : body.command;
    assert.equal(String(url).endsWith(body.resource ? '/read' : '/command'), true);
    const { seat: local, request_id, ...fields } = wire.arguments;
    assert.equal(local, seat);
    calls.push({ tool: wire.tool, args: fields });
    let response: unknown;
    if (body.resource) {
      const todo = state.todos[todoId]!;
      response = wire.tool === 'todo_queue' ? { status: 'ok', queue: queue([summary(todo)]) }
        : wire.tool === 'todo_list' ? { status: 'ok', todos: [summary(todo)], next_offset: null }
        : wire.tool === 'comment_list' ? { status: 'ok', comments: Object.values(state.comments), next_offset: null }
        : { status: 'ok', todo: detail(todo), comments: Object.values(state.comments), next_comment_offset: null };
    } else {
      assert.equal(body.command_id, request_id);
      assert.equal(wire.kind, 'household_tool');
      const command = { kind: wire.tool, ...fields } as TodoCommand;
      const decision = decideTodo(state, command, { access, now: Date.parse(at), command_id: request_id,
        request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), seq: state.last_seq + 1,
        event_ids: Array.from({ length: 10 }, (_, i) => uid(100 + (state.last_seq + 1) * 10 + i)), todo_id: todoId,
        comment_id: commentId, offer_id: uid(20), members: [{ user_id: user, workspace_id: workspace, revoked_at: null, role: 'member' }],
        agents: [{ principal_id: principal, owner_user_id: user, workspace_id: workspace, revoked_at: null }], objects: [],
        identity_write_attempts: 0, workspace_write_attempts: 0 });
      state = reduceTodoEvents(state, decision.events);
      response = { ...decision.outcome, request_id, notices: decision.notices.map(n => ({ to: n.to, status: 'sent', signal_id: uid(30) })), replayed: decision.replayed };
      if (lost) { lost = false; throw new Error('synthetic private transport text'); }
    }
    return new Response(JSON.stringify(response));
  };
  const client = new HouseholdObjectClient(createHouseholdHttpTransport({ target: { url: 'https://example.invalid', anonKey: 'synthetic', profileId: 'test' },
    authenticate: async () => ({ credential: 'synthetic', fetcher }) }), workspace);
  const tools = createHouseholdMcpTools(client);
  const create = tools.prepare('todo_create', { seat, request_id: 'create_001', title: 'Buy milk' });
  lost = true;
  assert.deepEqual(await create.send(), { status: 'unknown', request_id: 'create_001', reason: 'transport_interrupted' });
  const created = payload(await tools.retry(create));
  assert.equal(created.status, 'committed'); assert.equal(created.value.todo_id, todoId); assert.equal(created.replayed, true);
  assert.equal(state.last_seq, 0, 'recovery does not create a second event');
  const count = calls.length;
  await tools.retry(create); assert.equal(calls.length, count, 'known writes are not repeated');
  const assigned = payload(await tools.call('todo_assign', { seat, request_id: 'assign_001', todo_id: todoId, base_version: 1, to: { kind: 'agent', id: principal } }));
  assert.equal(assigned.status, 'committed'); assert.equal(assigned.value.version, 2); assert.equal(assigned.value.state, 'open');
  assert.deepEqual(assigned.notices, [{ to: [{ kind: 'agent', id: principal }], status: 'sent', signal_id: uid(30) }]);
  const queued = payload(await tools.call('todo_queue', { seat }));
  assert.equal(queued.status, 'ok'); assert.deepEqual(queued.queue.up_next.map((t: any) => t.todo_id), [todoId]);
  assert.equal('notes' in queued.queue.up_next[0], false);
  const started = payload(await tools.call('todo_start', { seat, request_id: 'start_001' }));
  assert.equal(started.status, 'committed'); assert.equal(started.value.state, 'doing'); assert.equal(started.value.version, 3);
  const done = payload(await tools.call('todo_set_state', { seat, request_id: 'done_0001', todo_id: todoId, base_version: 3, state: 'done' }));
  assert.equal(done.status, 'committed'); assert.equal(done.value.state, 'done'); assert.equal(state.todos[todoId]!.state, 'done');
  const edited = payload(await tools.call('todo_update', { seat, request_id: 'update_001', todo_id: todoId, base_version: 4, notes: 'Keep cold' }));
  assert.equal(edited.status, 'committed'); assert.equal(edited.value.notes, 'Keep cold');
  const commented = payload(await tools.call('todo_comment', { seat, request_id: 'comment_001', target: { kind: 'todo', id: todoId }, body: 'Thanks' }));
  assert.equal(commented.status, 'committed'); assert.equal(commented.value.body, 'Thanks');
  assert.equal(payload(await tools.call('comment_list', { seat, target: { kind: 'todo', id: todoId } })).comments[0].body, 'Thanks');
  assert.equal(payload(await tools.call('todo_read', { seat, todo_id: todoId })).todo.comment_count, 1);
  assert.equal(payload(await tools.call('todo_list', { seat, scope: 'all' })).todos[0].state, 'done');
  assert.deepEqual(calls.filter(c => c.tool === 'todo_start')[0]!.args, {}, 'omitted ID stays omitted');
});

test('HTTP refusal mapping uses stable codes with non-JSON and unsafe-code controls', async () => {
  for (const [body, status, expected] of [
    [JSON.stringify({ error: 'content_consent_required', message: 'Do not show private text' }), 403, 'content_consent_required'],
    [JSON.stringify({ status: 'refused', reason: 'not_assignee' }), 409, 'not_assignee'],
    [JSON.stringify({ code: 'todo_write_rate_limited' }), 429, 'todo_write_rate_limited'],
    [JSON.stringify({ error: 'https://secret.invalid' }), 403, 'request_refused'],
    ['<html>Private text</html>', 403, 'request_refused'],
  ] as const) {
    const client = new HouseholdObjectClient(createHouseholdHttpTransport({ target: { url: 'https://example.invalid', anonKey: 'synthetic', profileId: 'test' },
      authenticate: async () => ({ credential: 'synthetic', fetcher: async () => new Response(body, { status }) }) }), workspace);
    assert.deepEqual(await client.prepare('todo_list', { seat, scope: 'open' }).send(), { status: 'refused', reason: expected });
  }
});

test('to-do conflicts name the current version and never suggest blob-draft recovery', async () => {
  const tools = createHouseholdMcpTools(clientFor({ status: 'conflict', current: storedTodo({ version: 2 }) }));
  const result = await tools.call('todo_update', { seat, request_id: 'update_001', todo_id: todoId, base_version: 1, title: 'Tea' });
  assert.equal(result.isError, true); assert.equal(payload(result).current.version, 2);
  assert.match(payload(result).next_action, /current version/); assert.doesNotMatch(payload(result).next_action, /draft|revision/);
});

test('paged summaries strip private fields and preserve AM14 cursors under the escaped local MCP cap', async () => {
  for (const title of ['😀'.repeat(200), '"'.repeat(200), '\\'.repeat(200)]) {
    const rows = Array.from({ length: 50 }, (_, n) => ({ ...summary(storedTodo({ todo_id: uid(1000 + n), title })), notes: 'PRIVATE', secret: 'PRIVATE' }));
    // Independent wire budget from AM13. Build the largest server-sized page.
    while (Buffer.byteLength(JSON.stringify(JSON.stringify({ status: 'ok', todos: rows, next_offset: rows.length }))) > 28 * 1024) rows.pop();
    const result = await createHouseholdMcpTools(clientFor({ status: 'ok', todos: rows, next_offset: rows.length })).call('todo_list', { seat, scope: 'open', limit: 50 });
    assert.equal(result.isError, false); assert.ok(rows.length > 0);
    assert.equal(payload(result).todos.length, rows.length); assert.equal(payload(result).next_offset, rows.length);
    assert.equal(result.content[0]!.text.includes('PRIVATE'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MCP_RESULT_MAX_BYTES);
  }
  const page = { ...queue([summary()]), next_offset: { working: null, up_next: 1, not_yet: 0, requests: 0 } };
  const first = payload(await createHouseholdMcpTools(clientFor({ status: 'ok', queue: page })).call('todo_queue', { seat }));
  assert.deepEqual(first.queue.next_offset, { working: null, up_next: 1, not_yet: 0, requests: 0 });
  let requested: unknown;
  const client = new HouseholdObjectClient({ execute: async invocation => { requested = 'query' in invocation ? invocation.query : null; return { status: 'ok', queue: { ...queue(), not_yet: [summary()], next_offset: { working: 0, up_next: 0, not_yet: null, requests: 0 } } }; } }, workspace);
  assert.equal((await client.prepare('todo_queue', { seat, section: 'not_yet', offset: 0, limit: 1 }).send()).status, 'ok');
  assert.deepEqual(requested, { kind: 'todo_queue', section: 'not_yet', offset: 0, limit: 1 });
});

test('maximum detail and comment pages fit MCP without losing pagination or the write outcome', async () => {
  for (const body of ['"'.repeat(4000), '\\'.repeat(4000), '\n'.repeat(4000), '😀'.repeat(4000)]) {
    const response = { status: 'ok', todo: detail(storedTodo({ notes: body })), comments: [], next_comment_offset: 0 };
    const read = await createHouseholdMcpTools(clientFor(response)).call('todo_read', { seat, todo_id: todoId });
    assert.equal(read.isError, false); assert.equal(payload(read).todo.notes, body); assert.equal(payload(read).next_comment_offset, 0);
    const comments = Array.from({ length: 20 }, () => comment(body));
    while (Buffer.byteLength(JSON.stringify(JSON.stringify({ status: 'ok', comments, next_offset: comments.length }))) > 28 * 1024) comments.pop();
    assert.ok(comments.length > 0 && comments.length < 20, 'the independent page budget cuts the page and still advances');
    const result = await createHouseholdMcpTools(clientFor({ status: 'ok', comments, next_offset: comments.length })).call('comment_list', { seat, target: { kind: 'todo', id: todoId }, limit: 20 });
    assert.equal(result.isError, false); assert.equal(payload(result).next_offset, comments.length);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MCP_RESULT_MAX_BYTES);
    const committed = await createHouseholdMcpTools(clientFor({ status: 'committed', value: storedTodo({ notes: body }), notices: [], replayed: false })).call('todo_create', { seat, request_id: 'create_001', title: 'Buy milk', notes: body });
    assert.equal(committed.isError, false); assert.equal(payload(committed).status, 'committed'); assert.equal(payload(committed).value.notes, body);
  }
});

test('malformed and foreign to-do responses are unknown, paired with valid controls', async () => {
  const args = { seat, todo_id: todoId };
  const valid = { status: 'ok', todo: detail(), comments: [comment()], next_comment_offset: null };
  const cases = [valid, { ...valid, todo: detail(storedTodo({ workspace_id: uid(99) })) },
    { ...valid, todo: detail(storedTodo({ todo_id: uid(99) })) }, { ...valid, todo: { ...detail(), version: 0 } },
    { ...valid, comments: [{ ...comment(), target: { kind: 'todo', id: uid(99) } }] }, { ...valid, next_comment_offset: -1 },
    { ...valid, comments: Array.from({ length: 21 }, () => comment()) }];
  for (const [index, response] of cases.entries()) assert.equal((await clientFor(response).prepare('todo_read', args).send()).status, index === 0 ? 'ok' : 'unknown');
  for (const [index, response] of [{ status: 'committed', value: storedTodo(), notices: [], replayed: false },
    { status: 'committed', value: storedTodo(), notices: [], replayed: false, request_id: 'wrong_001' },
    { status: 'committed', value: storedTodo({ workspace_id: uid(99) }), notices: [], replayed: false }].entries()) {
    assert.equal((await clientFor(response).prepare('todo_create', { seat, title: 'Buy milk', request_id: 'create_001' }).send()).status, index === 0 ? 'committed' : 'unknown');
  }
  for (const [index, response] of [{ status: 'ok', queue: queue() }, { status: 'ok', queue: { ...queue(), principal_id: uid(99) } },
    { status: 'ok', queue: { ...queue(), workspace_id: uid(99) } }].entries()) {
    assert.equal((await clientFor(response).prepare('todo_queue', { seat, principal_id: principal }).send()).status, index === 0 ? 'ok' : 'unknown');
  }
});

test('source CLI help lists every registry command with its JSON input route without building', () => {
  const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'object', '--help'], { encoding: 'utf8' });
  const advertised = [...help.matchAll(/cswarm object (\w+) --input-file <path>/g)].map(match => match[1]);
  assert.deepEqual(advertised.sort(), HOUSEHOLD_TOOL_REGISTRY.map(row => row.name).sort());
  for (const row of HOUSEHOLD_TOOL_REGISTRY) assert.match(help, new RegExp(`cswarm object ${row.name} .*\\[--json\\]`));
});
