import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHomeServer, HomeCommandRefused } from './home/client.ts';
import { FIXED_NOW, HOME_FIXTURES, IDS } from './home/fixtures.ts';

const { workspaces: W, todos: T, agents: A, users: U, offers: O } = IDS;
const session = { access_token: 'fixture-token', user: { id: U.tom } };

// Literal wire expectations: the operation inventory is the frozen HomeServer contract.
const cases = [
  {
    method: 'activity', args: [W.home, FIXED_NOW, 20],
    command: { kind: 'household_activity', since: FIXED_NOW, limit: 20 },
    response: { status: 'ok', items: [] },
    unknown: 'The activity could not be loaded. Reload to try again.',
  },
  {
    method: 'listTodos', args: [W.home, { scope: 'open', assignee: { kind: 'user', id: U.tom }, offset: 2, limit: 25 }],
    command: { kind: 'household_tool', tool: 'todo_list', arguments: { seat: 'seat_0000000000000000000000', scope: 'open', assignee: { kind: 'user', id: U.tom }, offset: 2, limit: 25 } },
    response: { status: 'ok', todos: [], next_offset: null },
    unknown: 'The to-dos could not be loaded. Reload to try again.',
  },
  {
    method: 'readTodo', args: [W.home, T.claudeDoing, 4],
    command: { kind: 'household_tool', tool: 'todo_read', arguments: { seat: 'seat_0000000000000000000000', todo_id: T.claudeDoing, comment_offset: 4 } },
    response: { status: 'ok', todo: HOME_FIXTURES.todosByWorkspace[W.home].find(row => row.todo_id === T.claudeDoing), comments: [], next_comment_offset: null },
    unknown: 'The to-do could not be loaded. Reload to try again.',
  },
  {
    method: 'listComments', args: [W.home, { kind: 'todo', id: T.claudeDoing }, 3, 20],
    command: { kind: 'household_tool', tool: 'comment_list', arguments: { seat: 'seat_0000000000000000000000', target: { kind: 'todo', id: T.claudeDoing }, offset: 3, limit: 20 } },
    response: { status: 'ok', comments: [], next_offset: null },
    unknown: 'The comments could not be loaded. Reload to try again.',
  },
  {
    method: 'agentQueue', args: [W.home, A.claude, { section: 'up_next', offset: 2, limit: 3 }],
    command: { kind: 'household_tool', tool: 'todo_queue', arguments: { seat: 'seat_0000000000000000000000', principal_id: A.claude, section: 'up_next', offset: 2, limit: 3 } },
    response: { status: 'ok', queue: HOME_FIXTURES.queues[A.claude] },
    unknown: 'The line could not be loaded. Reload to try again.',
  },
  {
    method: 'createTodo', args: [W.home, { title: 'Buy oat milk', notes: 'Two cartons', due_on: '2026-10-06', assign: { to: { kind: 'agent', id: A.claude }, start: 'now' } }, 'req-create-1'],
    command: { kind: 'household_tool', tool: 'todo_create', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-create-1', title: 'Buy oat milk', notes: 'Two cartons', due_on: '2026-10-06', assign: { to: { kind: 'agent', id: A.claude }, start: 'now' } } },
    unknown: 'The to-do may or may not have been saved. Reload to check.',
  },
  {
    method: 'updateTodo', args: [W.home, { todo_id: T.assignedTom, base_version: 2, title: 'Renew registration', notes: '', due_on: null }, 'req-update-1'],
    command: { kind: 'household_tool', tool: 'todo_update', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-update-1', todo_id: T.assignedTom, base_version: 2, title: 'Renew registration', notes: '', due_on: null } },
    unknown: 'The to-do may or may not have been updated. Reload to check.',
  },
  {
    method: 'assignTodo', args: [W.home, { todo_id: T.openUnassigned, base_version: 1, to: { kind: 'user', id: U.nikki }, start: 'queue', gate: { kind: 'hold', note: 'Wait for a reply' } }, 'req-assign-1'],
    command: { kind: 'household_tool', tool: 'todo_assign', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-assign-1', todo_id: T.openUnassigned, base_version: 1, to: { kind: 'user', id: U.nikki }, start: 'queue', gate: { kind: 'hold', note: 'Wait for a reply' } } },
    unknown: 'The assignment may or may not have changed. Reload to check.',
  },
  {
    method: 'setTodoState', args: [W.home, { todo_id: T.assignedTom, base_version: 2, state: 'done' }, 'req-state-1'],
    command: { kind: 'household_tool', tool: 'todo_set_state', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-state-1', todo_id: T.assignedTom, base_version: 2, state: 'done' } },
    unknown: 'The to-do state may or may not have changed. Reload to check.',
  },
  {
    method: 'startTodo', args: [W.home, { todo_id: T.claudeUp1 }, 'req-start-1'],
    command: { kind: 'household_tool', tool: 'todo_start', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-start-1', todo_id: T.claudeUp1 } },
    unknown: 'The to-do may or may not be in Doing. Reload to check.',
  },
  {
    method: 'answerRequest', args: [W.home, { todo_id: T.requestClaude, offer_id: O.claude, answer: 'accept' }, 'req-answer-1'],
    command: { kind: 'household_todo_answer', todo_id: T.requestClaude, offer_id: O.claude, answer: 'accept' },
    unknown: 'The request may or may not have been answered. Reload to check.',
  },
  {
    method: 'steerQueue', args: [W.home, { todo_id: T.claudeUp2, base_version: 2, action: { kind: 'move', after_todo_id: T.claudeUp1 } }, 'req-steer-1'],
    command: { kind: 'household_todo_steer', todo_id: T.claudeUp2, base_version: 2, action: { kind: 'move', after_todo_id: T.claudeUp1 } },
    unknown: 'The line may or may not have changed. Reload to check.',
  },
  {
    method: 'setWorkPolicy', args: [W.home, { principal_id: A.claude, accepts_from: 'owner' }, 'req-policy-1'],
    command: { kind: 'household_agent_work_policy', principal_id: A.claude, accepts_from: 'owner' },
    unknown: 'Who can give this agent work may or may not have changed. Reload to check.',
  },
  {
    method: 'comment', args: [W.home, { target: { kind: 'todo', id: T.assignedTom }, body: 'Looks good', mentions: [{ kind: 'user', id: U.nikki }] }, 'req-comment-1'],
    command: { kind: 'household_tool', tool: 'todo_comment', arguments: { seat: 'seat_0000000000000000000000', request_id: 'req-comment-1', target: { kind: 'todo', id: T.assignedTom }, body: 'Looks good', mentions: [{ kind: 'user', id: U.nikki }] } },
    unknown: 'The comment may or may not have been posted. Reload to check.',
  },
];

for (const row of cases) {
  test(`createHomeServer ${row.method} builds its literal command envelope`, async () => {
    const calls = [];
    const server = createHomeServer(session, {
      postCommand: async (caller, commandId, command, extra, unknownOutcome) => {
        calls.push({ caller, commandId, command, extra, unknownOutcome });
        return { status: 200, body: row.response ?? { status: 'committed', value: {}, notices: [], replayed: false } };
      },
      client: () => null,
    });
    await server[row.method](...row.args);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.caller, session);
    assert.deepEqual(call.command, row.command);
    assert.deepEqual(call.extra, { workspace_id: W.home, stream: { kind: 'workspace' } });
    assert.equal(call.unknownOutcome, row.unknown);
    if (row.response) assert.match(call.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    else assert.equal(call.commandId, row.args.at(-1));
  });

}

test('refusals use stable codes and conflicts retain the current to-do', async () => {
  const current = HOME_FIXTURES.todosByWorkspace[W.home][0];
  let result = { status: 200, body: { status: 'refused', reason: 'owner_only' } };
  const server = createHomeServer(session, { postCommand: async () => result, client: () => null });
  const write = () => server.updateTodo(W.home, { todo_id: T.openUnassigned, base_version: 1 }, 'stable-request');
  assert.deepEqual(await write(), { status: 'refused', reason: 'owner_only' });
  await assert.rejects(() => server.readTodo(W.home, T.openUnassigned), error => error instanceof HomeCommandRefused && error.reason === 'owner_only');
  result = { status: 200, body: { status: 'conflict', current } };
  assert.deepEqual(await write(), { status: 'conflict', current });
  result = { status: 200, body: { status: 'committed', value: current, notices: [{ to: [{ kind: 'user', id: U.nikki }], status: 'not_sent', reason: 'signal_rate_limited' }], replayed: true } };
  assert.deepEqual(await write(), result.body);
  for (const reason of ['some server sentence', 'owner_only ', '', null, 403]) {
    result = { status: 200, body: { status: 'refused', reason } };
    await assert.rejects(write);
    await assert.rejects(() => server.readTodo(W.home, T.openUnassigned), error => !(error instanceof HomeCommandRefused));
  }
  result = { status: 500, body: { status: 'committed', value: current, notices: [], replayed: false } };
  await assert.rejects(write);
  result = { status: 500, body: { status: 'ok', todos: [], next_offset: null } };
  await assert.rejects(() => server.listTodos(W.home, { scope: 'all', offset: 0, limit: 25 }));
});
