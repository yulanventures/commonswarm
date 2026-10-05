import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandOutcomeUnknown } from './commonswarm.ts';
import { createFixtureHomeServer, createHomeServer, HomeCommandRefused } from './home/client.ts';
import { FIXED_NOW, HOME_FIXTURES, IDS, gateClearAt } from './home/fixtures.ts';

const { workspaces: W, todos: T, agents: A, users: U, offers: O } = IDS;
const session = { access_token: 'fixture-token', user: { id: U.tom } };

function todoStates(rows) {
  return new Map(rows.map((row) => [row.todo_id, row.state]));
}

test('fixtures keep agent queue positions contiguous from one', () => {
  for (const queue of Object.values(HOME_FIXTURES.queues)) {
    queue.up_next.forEach((row, index) => assert.equal(row.queue_position, index + 1, row.todo_id));
  }
  const dotQueue = HOME_FIXTURES.queues[A.dot];
  assert.equal(dotQueue.up_next.length, 1);
  assert.equal(dotQueue.up_next[0].todo_id, T.dotDisconnected);
});

test('fixtures keep gate_clear aligned with FIXED_NOW and referenced to-do states', () => {
  for (const rows of Object.values(HOME_FIXTURES.todosByWorkspace)) {
    const states = todoStates(rows);
    for (const row of rows) {
      const expected = row.gate.kind === 'none'
        || (row.gate.kind === 'at' && Date.parse(row.gate.at) <= Date.parse(FIXED_NOW))
        || (row.gate.kind === 'after' && ['done', 'dropped'].includes(states.get(row.gate.todo_id)));
      assert.equal(row.gate_clear, expected, row.todo_id);
      assert.equal(gateClearAt(row.gate, states, FIXED_NOW), expected, row.todo_id);
    }
  }
});

test('fixtures give every pending offer a decider', () => {
  for (const rows of Object.values(HOME_FIXTURES.todosByWorkspace)) {
    for (const row of rows) {
      if (!row.offer) continue;
      assert.equal(typeof row.offer.decider_user_id, 'string');
      assert.ok(row.offer.decider_user_id.length > 0);
    }
  }
});

test('fixtures keep pending offers unassigned until acceptance', () => {
  for (const rows of Object.values(HOME_FIXTURES.todosByWorkspace)) {
    for (const row of rows) {
      if (!row.offer) continue;
      assert.equal(row.assignee, null);
      assert.equal(row.assigned_by, null);
      assert.equal(row.assigned_at, null);
    }
  }
});

test('fixtures keep needs_you to-do references on real rows', () => {
  const home = HOME_FIXTURES.overview.workspaces.find((row) => row.workspace_id === W.home);
  assert.ok(home);
  const titles = new Map(HOME_FIXTURES.todosByWorkspace[W.home].map((row) => [row.todo_id, row.title]));
  for (const row of [...home.needs_you.assigned, ...home.needs_you.waiting]) {
    assert.equal(titles.get(row.todo_id), row.title);
  }
});

test('fixtures keep needs_you waiting kinds on the right to-dos', () => {
  const home = HOME_FIXTURES.overview.workspaces.find((row) => row.workspace_id === W.home);
  assert.ok(home);
  const waiting = new Map(home.needs_you.waiting.map((row) => [row.reason, row.todo_id]));
  assert.equal(waiting.get('request'), T.requestClaude);
  assert.equal(waiting.get('hold'), T.gateHold);
  assert.equal(waiting.get('after'), T.gateAfterBlocked);
  assert.equal(waiting.get('agent_removed'), T.orphanRemoved);
  assert.ok(![...waiting.values()].includes(T.dotDisconnected));
  const assigned = new Set(home.needs_you.assigned.map((row) => row.todo_id));
  assert.ok(assigned.has(T.tomAfterBlocked));
  for (const row of home.needs_you.waiting) {
    assert.ok(!assigned.has(row.todo_id), row.todo_id);
  }
});

test('createFixtureHomeServer refuses content reads without consent', async () => {
  const server = createFixtureHomeServer(HOME_FIXTURES);
  const refused = (error) => error instanceof HomeCommandRefused && error.reason === 'content_consent_required';
  await assert.rejects(
    () => server.listTodos(W.paperwork, { scope: 'open', offset: 0, limit: 25 }),
    refused,
  );
  await assert.rejects(
    () => server.readTodo(W.paperwork, T.paperOpen),
    refused,
  );
  await assert.rejects(
    () => server.listComments(W.paperwork, { kind: 'todo', id: T.paperOpen }, 0, 25),
    refused,
  );
  await assert.rejects(
    () => server.activity(W.paperwork, FIXED_NOW, 20),
    refused,
  );
  await assert.rejects(
    () => server.agentQueue(W.paperwork, A.claude),
    refused,
  );
});

test('createFixtureHomeServer refuses all content reads when overview content is null', async () => {
  const overview = structuredClone(HOME_FIXTURES.overview);
  const home = overview.workspaces.find((row) => row.workspace_id === W.home);
  assert.ok(home);
  home.content = null;
  const fixtures = { ...HOME_FIXTURES, overview };
  const server = createFixtureHomeServer(fixtures);
  const refused = (error) => error instanceof HomeCommandRefused && error.reason === 'content_consent_required';
  await assert.rejects(() => server.listTodos(W.home, { scope: 'open', offset: 0, limit: 25 }), refused);
  await assert.rejects(() => server.readTodo(W.home, T.claudeDoing), refused);
  await assert.rejects(
    () => server.listComments(W.home, { kind: 'todo', id: T.claudeDoing }, 0, 25),
    refused,
  );
  await assert.rejects(() => server.activity(W.home, FIXED_NOW, 20), refused);
  await assert.rejects(() => server.agentQueue(W.home, A.claude), refused);
});

test('createFixtureHomeServer keeps agent queues workspace-scoped', async () => {
  const server = createFixtureHomeServer(HOME_FIXTURES);
  const homeQueue = await server.agentQueue(W.home, A.claude);
  assert.equal(homeQueue.workspace_id, W.home);
  await assert.rejects(
    () => server.agentQueue(W.trip, A.claude),
    (error) => error instanceof HomeCommandRefused && error.reason === 'target_not_found',
  );
});

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

  test(`createHomeServer ${row.method} reports its own operation when the response is lost`, async () => {
    let called = false;
    const server = createHomeServer(session, {
      postCommand: async (_caller, _id, _command, _extra, unknownOutcome) => {
        called = true;
        // Emulate postCommand's failed-fetch boundary. It chooses the fifth argument,
        // otherwise it uses its legacy workspace-create error.
        throw new CommandOutcomeUnknown(unknownOutcome ?? 'Cannot tell whether the workspace was created.');
      },
      client: () => null,
    });
    await assert.rejects(() => server[row.method](...row.args), error => {
      assert.ok(error instanceof CommandOutcomeUnknown);
      assert.equal(error.message, row.unknown);
      return true;
    });
    assert.equal(called, true);
  });
}

test('overview calls the literal schema and RPC and rejects missing results', async () => {
  const calls = [];
  let result = { data: HOME_FIXTURES.overview, error: null };
  const server = createHomeServer(session, {
    postCommand: async () => { throw new Error('unexpected command'); },
    client: () => ({ schema: name => ({ rpc: async rpc => { calls.push([name, rpc]); return result; } }) }),
  });
  assert.deepEqual(await server.overview(), HOME_FIXTURES.overview);
  assert.deepEqual(calls, [['swarm_read', 'home_overview']]);
  for (const bad of [{ data: null, error: null }, { data: {}, error: null }, { data: null, error: { code: 'failed' } }]) {
    result = bad;
    await assert.rejects(() => server.overview());
  }
});

for (const row of cases.filter(row => row.response)) {
  test(`${row.method} rejects a successful response with missing read data`, async () => {
    let body = row.response;
    const server = createHomeServer(session, { postCommand: async () => ({ status: 200, body }), client: () => null });
    await server[row.method](...row.args); // Positive control with the same transport.
    body = { status: 'ok' };
    await assert.rejects(() => server[row.method](...row.args));
    for (const key of Object.keys(row.response).filter(key => key !== 'status')) {
      body = structuredClone(row.response);
      delete body[key];
      await assert.rejects(() => server[row.method](...row.args), key);
    }
  });
}

test('agentQueue removes transport status and retains agent work facts', async () => {
  const server = createHomeServer(session, {
    postCommand: async () => ({ status: 200, body: { status: 'ok', queue: HOME_FIXTURES.queues[A.claude] } }),
    client: () => null,
  });
  const result = await server.agentQueue(W.home, A.claude);
  assert.equal(result.status.work, 'working');
  assert.equal(result.status.facts.transport, 'hosted_mcp');
  assert.equal('queue' in result, false);
});

test('fixture catch-up counts own agents and other authors after the receipt window, excluding own human posts', () => {
  const viewer = HOME_FIXTURES.overview.viewer_user_id;
  for (const workspace of HOME_FIXTURES.overview.workspaces) {
    // The server counts visible messages except the viewer's human posts strictly AFTER
    // last_seen_at (or within seven days for a first visit), capped at 99.
    const since = Date.parse(workspace.last_seen_at ?? FIXED_NOW) - (workspace.last_seen_at ? 0 : 7 * 86400000);
    if (workspace.content) {
      assert.deepEqual(Object.keys(workspace.content).sort(), ['docs', 'files', 'lists', 'open_todos']);
    }
    const messages = HOME_FIXTURES.messagesByWorkspace[workspace.workspace_id];
    const visibleOtherMessages = messages.filter(row => (row.author.user_id !== viewer || row.author.principal_id !== null)
      && Date.parse(row.created_at) > since
      && (row.recipients === null || row.recipients.some(party => party.kind === 'user' && party.id === viewer)));
    assert.equal(workspace.new_messages, Math.min(99, visibleOtherMessages.length), workspace.name);
  }
  assert.deepEqual(HOME_FIXTURES.overview.workspaces.map(row => row.new_messages), [4, 0, 12]);
});

test('fixtures distinguish a disabled chat-app connection from a removed agent and a disabled local key', () => {
  const home = HOME_FIXTURES.overview.workspaces.find(row => row.workspace_id === W.home);
  const hosted = home.people.find(row => row.user_id === U.priya).agents[0].status;
  assert.deepEqual([hosted.work, hosted.facts.transport, hosted.facts.connection], ['disconnected', 'hosted_mcp', 'connection_off']);
  assert.equal(HOME_FIXTURES.otherAgents.find(row => row.principal_id === A.orphan).status.facts.connection, 'removed');
  assert.equal(HOME_FIXTURES.queues[A.dot].status.facts.connection, 'key_off');
});

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

test('summary pages hide details and expose a literal summary row', async () => {
  const server = createFixtureHomeServer(HOME_FIXTURES);
  const result = await server.listTodos(W.home, { scope: 'all', offset: 7, limit: 1 });
  assert.deepEqual(result, {
    todos: [{ todo_id: T.gateHold, version: 1, title: 'Wait for Tom to approve paint colors', state: 'open', due_on: null,
      assignee: { kind: 'agent', id: A.claude }, offer: null,
      gate: { kind: 'hold', clear: false, todo_id: null, at: null },
      queue_position: null, comment_count: 0, state_at: '2026-10-05T17:00:00.000Z' }],
    next_offset: 8,
  });
  const request = await server.listTodos(W.home, { scope: 'all', offset: 15, limit: 1 });
  assert.deepEqual(request.todos[0].offer, {
    offer_id: O.claude, to: { kind: 'agent', id: A.claude }, decider_user_id: U.tom, start: 'now',
  });
  const queue = await server.agentQueue(W.home, A.claude, { section: 'up_next', offset: 2, limit: 2 });
  assert.deepEqual(queue.up_next.map(row => [row.todo_id, row.queue_position]), [[T.claudeUp3, 3], [T.gateAfterClear, 4]]);
  assert.deepEqual(queue.next_offset, { working: 0, up_next: 4, not_yet: 0, requests: 0 });
  for (const rows of [result.todos, ...Object.values(HOME_FIXTURES.queues).flatMap(q => [q.working, q.up_next, q.not_yet, q.requests])]) {
    for (const row of rows) {
      assert.equal('notes' in row, false);
      assert.equal('comments' in row, false);
      assert.equal('note' in row.gate, false);
      if (row.offer) assert.equal('gate' in row.offer, false);
    }
  }
  const details = await server.readTodo(W.home, T.gateHold);
  assert.equal(details.todo.gate.note, 'Hold until the samples arrive');
});

test('client caps list and queue requests at fifty and sends queue defaults', async () => {
  const calls = [];
  const server = createHomeServer(session, {
    postCommand: async (_s, _id, command) => {
      calls.push(command);
      return { status: 200, body: command.tool === 'todo_list'
        ? { status: 'ok', todos: [], next_offset: null }
        : { status: 'ok', queue: HOME_FIXTURES.queues[A.claude] } };
    }, client: () => null,
  });
  await server.listTodos(W.home, { scope: 'all', offset: 0, limit: 100 });
  await server.agentQueue(W.home, A.claude, { limit: 100 });
  await server.agentQueue(W.home, A.claude);
  assert.deepEqual(calls, [
    { kind: 'household_tool', tool: 'todo_list', arguments: { seat: 'seat_0000000000000000000000', scope: 'all', offset: 0, limit: 50 } },
    { kind: 'household_tool', tool: 'todo_queue', arguments: { seat: 'seat_0000000000000000000000', principal_id: A.claude, offset: 0, limit: 50 } },
    { kind: 'household_tool', tool: 'todo_queue', arguments: { seat: 'seat_0000000000000000000000', principal_id: A.claude, offset: 0, limit: 50 } },
  ]);
});

const transportBytes = value => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), 'utf8');

for (const character of ['界', '"', '\\']) {
  test(`fixture lists and queues page escaped or multibyte titles (${JSON.stringify(character)})`, async () => {
    const fixtures = structuredClone(HOME_FIXTURES);
    const template = fixtures.todosByWorkspace[W.home].find(row => row.todo_id === T.claudeUp1);
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...template, todo_id: `large-${index}`, title: character.repeat(200), notes: 'Details only', queue_position: index + 1 }));
    fixtures.todosByWorkspace[W.home] = rows;
    const summaryTemplate = fixtures.queues[A.claude].up_next[0];
    fixtures.queues[A.claude] = {
      ...fixtures.queues[A.claude], working: [],
      up_next: rows.map(row => ({ ...summaryTemplate, todo_id: row.todo_id, title: row.title, queue_position: row.queue_position })),
      not_yet: [{ ...summaryTemplate, todo_id: 'later-section', queue_position: null }], requests: [],
    };
    const server = createFixtureHomeServer(fixtures);
    const seenList = [], seenQueue = [];
    let offset = 0;
    do {
      const page = await server.listTodos(W.home, { scope: 'all', offset, limit: 100 });
      assert.ok(page.todos.length > 0 && page.todos.length < 50);
      assert.ok(transportBytes({ status: 'ok', ...page }) <= 28 * 1024);
      seenList.push(...page.todos.map(row => row.todo_id));
      if (offset === 0) assert.ok(page.next_offset !== null);
      if (page.next_offset !== null) assert.equal(page.next_offset, offset + page.todos.length);
      offset = page.next_offset;
    } while (offset !== null);
    offset = 0;
    do {
      const page = await server.agentQueue(W.home, A.claude, { section: 'up_next', offset, limit: 100 });
      assert.ok(page.up_next.length > 0 && page.up_next.length < 50);
      assert.ok(transportBytes({ status: 'ok', queue: page }) <= 28 * 1024);
      seenQueue.push(...page.up_next.map(row => row.todo_id));
      if (offset === 0) assert.ok(page.next_offset.up_next !== null);
      if (page.next_offset.up_next !== null) assert.equal(page.next_offset.up_next, offset + page.up_next.length);
      offset = page.next_offset.up_next;
    } while (offset !== null);
    assert.deepEqual(seenList, rows.map(row => row.todo_id));
    assert.deepEqual(seenQueue, rows.map(row => row.todo_id));
    const combined = await server.agentQueue(W.home, A.claude);
    assert.ok(combined.next_offset.up_next > 0);
    assert.deepEqual(combined.not_yet, []);
    assert.equal(combined.next_offset.not_yet, 0);
    assert.equal(combined.next_offset.requests, 0);
    assert.ok(transportBytes({ status: 'ok', queue: combined }) <= 28 * 1024);
  });
}

test('combined queue budgets sections in order and resumes a section that returned no rows', async () => {
  const fixtures = structuredClone(HOME_FIXTURES);
  const template = fixtures.queues[A.claude].up_next[0];
  const rows = Array.from({ length: 200 }, (_, index) => ({ ...template, todo_id: `section-${index}`, title: '"'.repeat(200), queue_position: index + 1 }));
  fixtures.queues[A.claude] = { ...fixtures.queues[A.claude], working: rows.slice(0, 20), up_next: rows.slice(20, 50), not_yet: rows.slice(50, 100), requests: rows.slice(100) };
  const server = createFixtureHomeServer(fixtures);
  const page = await server.agentQueue(W.home, A.claude);
  assert.equal(page.working.length, 20);
  assert.equal(page.next_offset.working, null);
  assert.ok(page.up_next.length < 30);
  assert.equal(page.next_offset.up_next, page.up_next.length);
  assert.deepEqual(page.not_yet, []);
  assert.equal(page.next_offset.not_yet, 0);
  assert.deepEqual(page.requests, []);
  assert.equal(page.next_offset.requests, 0);
  assert.ok(transportBytes({ status: 'ok', queue: page }) <= 28 * 1024);
  const resumed = await server.agentQueue(W.home, A.claude, { section: 'not_yet', offset: page.next_offset.not_yet, limit: 50 });
  assert.ok(resumed.not_yet.length > 0);
  assert.equal(resumed.not_yet[0].todo_id, 'section-50');
});

for (const text of ['"'.repeat(4000), '\\'.repeat(4000), '\n'.repeat(4000), '😀'.repeat(2000)]) {
  test(`fixture detail and comment pages stay under the transport budget (${JSON.stringify(text[0])})`, async () => {
    const fixtures = structuredClone(HOME_FIXTURES);
    const todo = fixtures.todosByWorkspace[W.home].find(row => row.todo_id === T.claudeDoing);
    todo.notes = text;
    const template = fixtures.commentsByWorkspace[W.home][0];
    fixtures.commentsByWorkspace[W.home] = Array.from({ length: 20 }, (_, index) => ({ ...template, comment_id: `comment-${index}`, body: text }));
    todo.comment_count = 20;
    const server = createFixtureHomeServer(fixtures);
    const page = await server.readTodo(W.home, T.claudeDoing);
    assert.equal(page.todo.notes, text);
    assert.ok(page.comments.length <= 20);
    assert.ok(page.next_comment_offset !== null); // Positive control: budget cut this page.
    assert.ok(transportBytes({ status: 'ok', ...page }) <= 28 * 1024);
    const seen = [];
    let offset = 0;
    do {
      const comments = await server.listComments(W.home, { kind: 'todo', id: T.claudeDoing }, offset, 20);
      assert.ok(comments.comments.length > 0);
      assert.ok(transportBytes({ status: 'ok', ...comments }) <= 28 * 1024);
      seen.push(...comments.comments.map(row => row.comment_id));
      offset = comments.next_offset;
    } while (offset !== null);
    assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => `comment-${index}`));
  });
}

test('readTodo pages small comments at twenty even when the budget has room', async () => {
  const fixtures = structuredClone(HOME_FIXTURES);
  const template = fixtures.commentsByWorkspace[W.home][0];
  fixtures.commentsByWorkspace[W.home] = Array.from({ length: 21 }, (_, index) => ({ ...template, comment_id: `small-${index}` }));
  const server = createFixtureHomeServer(fixtures);
  const first = await server.readTodo(W.home, T.claudeDoing);
  assert.equal(first.comments.length, 20);
  assert.equal(first.next_comment_offset, 20);
  const second = await server.readTodo(W.home, T.claudeDoing, 20);
  assert.equal(second.comments.length, 1);
  assert.equal(second.next_comment_offset, null);
});

test('sample reads distinguish missing membership and sort activity newest first', async () => {
  const fixtures = structuredClone(HOME_FIXTURES);
  fixtures.activityByWorkspace[W.home].reverse();
  const server = createFixtureHomeServer(fixtures);
  await assert.rejects(() => server.listTodos('missing-workspace', { scope: 'all', offset: 0, limit: 20 }), error => error instanceof HomeCommandRefused && error.reason === 'workspace_access_refused');
  const activity = await server.activity(W.home, '2026-10-03T00:00:00.000Z', 20);
  assert.deepEqual(activity.map(row => row.event), ['started', 'requested', 'assigned', 'done', 'updated']);
});
