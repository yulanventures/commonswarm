import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  decideTodo, emptyHouseholdTodoState, evaluateGate, reduceTodoEvents,
  type Todo, type TodoCommand, type HouseholdTodoState, type DecideTodoContext, type TodoEvent, type TodoDecision,
} from '../src/protocol/household-todos.js';
import { agentWorkState, type AgentWorkFacts } from '../src/protocol/household-todo-policy.js';
import { StreamIntegrityError, UnknownEventTypeError } from '../src/protocol/reducer.js';
import type { HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';

// The fixtures supply recorded facts only. Expected decisions are literal
// contracts from SERVER-PLAN C; no fixture implements permission or acceptance.
const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alice = uid(1), bob = uid(2), carol = uid(3), admin = uid(4), agentA = uid(11), agentB = uid(12);
const first = uid(101), second = uid(102), third = uid(103);
const at = '2026-10-05T12:00:00.000Z';
const now = Date.parse(at);
function access(user = alice, principal: string | null = null): HouseholdAccessFacts {
  return { workspace_id: 'home', archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: user, principal_id: principal, run_id: principal ? 'run' : null },
    member: { user_id: user, workspace_id: 'home', revoked_at: null, content_role: 'editor', content_consent_id: 'consent' },
    credential: principal ? { kind: 'agent', connection: { principal_id: principal, owner_user_id: user, workspace_id: 'home',
      connection_id: 'connection', grant_id: 'approval', revoked_at: null, expires_at: now + 10000, operations: ['read', 'create', 'update'], purpose: 'shared' } } : { kind: 'human' } };
}
function todo(todoId = first, extra: Partial<Todo> = {}): Todo {
  return { workspace_id: 'home', todo_id: todoId, version: 1, title: 'Buy milk', notes: '', due_on: null,
    state: 'open', created_by: { user_id: alice, principal_id: null }, created_at: at,
    assignee: null, assigned_by: null, assigned_at: null, offer: null, gate: { kind: 'none' }, gate_set_by: null,
    queue_rank: null, state_by: { user_id: alice, principal_id: null }, state_at: at, comment_count: 0, ...extra };
}
function state(...todos: Todo[]): HouseholdTodoState {
  return { ...emptyHouseholdTodoState('home', 'stream'), todos: Object.fromEntries(todos.map(t => [t.todo_id, t])) };
}
function context(s: HouseholdTodoState, command: TodoCommand, user = alice, principal: string | null = null): DecideTodoContext {
  return { access: access(user, principal), now, seq: s.last_seq + 1, command_id: `command-${s.last_seq + 1}`,
    request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    event_ids: Array.from({ length: 10 }, (_, i) => uid(500000 + (s.last_seq + 1) * 10 + i)),
    todo_id: uid(100000), offer_id: uid(300000), comment_id: uid(400000),
    members: [alice, bob, carol, admin].map(user_id => ({ user_id, workspace_id: 'home', revoked_at: null, role: user_id === admin ? 'admin' : 'member' })),
    agents: [{ principal_id: agentA, owner_user_id: alice, workspace_id: 'home', revoked_at: null },
      { principal_id: agentB, owner_user_id: bob, workspace_id: 'home', revoked_at: null }],
    objects: [{ kind: 'doc', id: 'recipes' }], identity_write_attempts: 0, workspace_write_attempts: 0 };
}
function run(s: HouseholdTodoState, command: TodoCommand, user = alice, principal: string | null = null): TodoDecision {
  return decideTodo(s, command, context(s, command, user, principal));
}
function value(d: TodoDecision): Todo {
  assert.equal(d.outcome.status, 'committed');
  assert.ok(d.outcome.status === 'committed' && 'todo_id' in d.outcome.value);
  return d.outcome.value as Todo;
}
function refused(d: TodoDecision, reason: string): void {
  assert.deepEqual(d.outcome, { status: 'refused', reason });
  assert.deepEqual(d.events, []);
  assert.deepEqual(d.notices, []);
}
const assignedA = (todoId = first, extra: Partial<Todo> = {}): Todo => todo(todoId, { assignee: { kind: 'agent', id: agentA }, queue_rank: 1, ...extra });
const assign = (to: { kind: 'agent' | 'user'; id: string }, start: 'queue' | 'now' = 'queue'): TodoCommand =>
  ({ kind: 'todo_assign', todo_id: first, base_version: 1, to, start });

test('AM16 refuses controls in notes and comments, while newline and tab remain plain content', () => {
  const s = state(todo());
  for (const code of [0, 1, 8, 11, 13, 31, 127, 128, 159]) {
    const bad = `Text${String.fromCodePoint(code)}`;
    refused(run(state(), { kind: 'todo_create', title: 'Notes', notes: bad }), 'notes_invalid');
    refused(run(s, { kind: 'todo_update', todo_id: first, base_version: 1, notes: bad }), 'notes_invalid');
    refused(run(s, { kind: 'todo_comment', target: { kind: 'todo', id: first }, body: bad }), 'comment_invalid');
    assert.equal(value(run(state(), { kind: 'todo_create', title: 'Notes', notes: 'Text\n\t' })).notes, 'Text\n\t');
    assert.equal(value(run(s, { kind: 'todo_update', todo_id: first, base_version: 1, notes: 'Text\n\t' })).notes, 'Text\n\t');
    const comment = run(s, { kind: 'todo_comment', target: { kind: 'todo', id: first }, body: 'Text\n\t' }).outcome;
    assert.equal(comment.status, 'committed');
    assert.ok(comment.status === 'committed' && 'body' in comment.value);
    assert.equal(comment.value.body, 'Text\n\t');
  }
});

test('creation stores plain content, attribution and deadline without starting work', () => {
  const initial = state();
  const command: TodoCommand = { kind: 'todo_create', title: '<img src=x>', notes: 'Untrusted text', due_on: '2028-02-29' };
  const d = run(initial, command, alice, agentA);
  assert.deepEqual(value(d), todo(uid(100000), { title: '<img src=x>', notes: 'Untrusted text', due_on: '2028-02-29',
    created_by: { user_id: alice, principal_id: agentA }, state_by: { user_id: alice, principal_id: agentA } }));
  assert.deepEqual(d.events.map(e => e.type), ['TodoCreated']);
  assert.deepEqual(initial.todos, {});
  assert.equal(d.events[0]!.schema_version, 1);
  assert.equal(d.events[0]!.actor_run, 'run');
});

test('acceptance matrix: self, own agent, other person, owner policy and anyone policy', () => {
  const cases = [
    { to: { kind: 'user', id: alice } as const, user: alice, policy: 'owner', start: 'queue', accepted: true },
    { to: { kind: 'user', id: bob } as const, user: alice, policy: 'anyone', start: 'queue', accepted: false },
    { to: { kind: 'agent', id: agentA } as const, user: alice, policy: 'owner', start: 'queue', accepted: true },
    { to: { kind: 'agent', id: agentA } as const, user: alice, policy: 'owner', start: 'now', accepted: true },
    { to: { kind: 'agent', id: agentA } as const, user: bob, policy: 'owner', start: 'queue', accepted: false },
    { to: { kind: 'agent', id: agentA } as const, user: bob, policy: 'anyone', start: 'queue', accepted: true },
    { to: { kind: 'agent', id: agentA } as const, user: bob, policy: 'anyone', start: 'now', accepted: false },
  ] as const;
  for (const row of cases) {
    const s = state(todo());
    if (row.policy === 'anyone') s.policies = { [agentA]: { principal_id: agentA, accepts_from: 'anyone', set_by_user: alice, set_at: at } };
    const d = run(s, assign(row.to, row.start), row.user);
    const result = value(d);
    assert.equal(result.state, 'open');
    assert.deepEqual(result.assignee, row.accepted ? row.to : null);
    assert.equal(result.offer?.decider_user_id ?? null, row.accepted ? null : row.to.kind === 'user' ? bob : alice);
    assert.equal(result.offer?.start ?? null, row.accepted ? null : row.start);
    assert.equal(d.notices.length, row.to.kind === 'user' && row.accepted ? 0 : 1);
    if (row.accepted && row.to.kind === 'agent') assert.equal(d.notices[0]!.body, row.start === 'now'
      ? 'Please start the to-do at the front of your queue.' : 'Added a to-do to your queue.');
    if (!row.accepted) assert.equal(d.notices[0]!.body, row.to.kind === 'user' ? 'Asks you to take a to-do.' : 'Asks for a to-do for your agent.');
  }
  assert.deepEqual(value(run(state(todo()), assign({ kind: 'agent', id: agentA }), alice, agentA)).assignee, { kind: 'agent', id: agentA });
});

test('accepted gated work joins the back and emits no ready notice', () => {
  const s = state(todo(), assignedA(second, { queue_rank: 9 }));
  const d = run(s, { kind: 'todo_assign', todo_id: first, base_version: 1, to: { kind: 'agent', id: agentA }, gate: { kind: 'hold', note: 'Wait for groceries' } });
  assert.equal(value(d).queue_rank, 10);
  assert.deepEqual(value(d).gate, { kind: 'hold', note: 'Wait for groceries' });
  assert.deepEqual(d.notices, []);
});

test('AM1 only the human owner can assign now, including on creation and with anyone policy', () => {
  const commands: TodoCommand[] = [
    { kind: 'todo_create', title: 'Buy milk', assign: { to: { kind: 'agent', id: agentA }, start: 'now' } },
    assign({ kind: 'agent', id: agentA }, 'now'),
  ];
  for (const command of commands) {
    for (const policy of ['owner', 'anyone'] as const) {
      const s = state(todo(), assignedA(second, { queue_rank: 4 }));
      s.policies = { [agentA]: { principal_id: agentA, accepts_from: policy, set_by_user: alice, set_at: at } };
      for (const principal of [agentA, agentB]) {
        const credential = context(s, command, alice, principal);
        credential.agents = credential.agents.map(a => ({ ...a, owner_user_id: alice }));
        const offered = decideTodo(s, command, credential);
        const result = value(offered);
        assert.deepEqual(result.assignee, null);
        assert.equal(result.queue_rank, null);
        assert.deepEqual(result.offer, {
          offer_id: uid(300000), to: { kind: 'agent', id: agentA }, decider_user_id: alice,
          start: 'now', gate: { kind: 'none' }, by: { user_id: alice, principal_id: principal }, at,
        });
        assert.deepEqual(offered.events.map(e => e.type), command.kind === 'todo_create'
          ? ['TodoCreated', 'TodoOffered'] : ['TodoOffered']);
        assert.equal(reduceTodoEvents(s, offered.events).todos[second]!.queue_rank, 4);
        assert.deepEqual(offered.notices, [{ kind: 'ask', to: [{ kind: 'user', id: alice }],
          about: `todo:${command.kind === 'todo_create' ? uid(100000) : first}`, body: 'Asks for a to-do for your agent.' }]);
      }

      const human = run(s, command);
      assert.deepEqual(value(human).assignee, { kind: 'agent', id: agentA });
      assert.equal(value(human).offer, null);
      assert.equal(value(human).queue_rank, 1);
      assert.equal(reduceTodoEvents(s, human.events).todos[second]!.queue_rank, 2);
      assert.deepEqual(human.events.map(e => e.type), command.kind === 'todo_create'
        ? ['TodoCreated', 'TodoAssigned', 'TodoQueueOrdered', 'TodoStartAsked']
        : ['TodoAssigned', 'TodoQueueOrdered', 'TodoStartAsked']);
    }
  }
});

test('human owner assignment now clears an omitted gate and permits the agent to start', () => {
  for (const gate of [{ kind: 'hold', note: 'Ask first' },
    { kind: 'at', at: '2026-10-06T12:00:00.000Z' }, { kind: 'after', todo_id: third }] as const) {
    const s = state(assignedA(first, { queue_rank: 5, gate, gate_set_by: bob }),
      assignedA(second), todo(third));
    const start: TodoCommand = { kind: 'todo_start', todo_id: first };
    refused(run(s, start, alice, agentA), 'gate_invalid');
    const command = assign({ kind: 'agent', id: agentA }, 'now');
    const asked = run(s, command);
    assert.deepEqual(value(asked).gate, { kind: 'none' });
    assert.equal(value(asked).gate_set_by, null);
    assert.equal(value(asked).state, 'open');
    assert.equal(value(asked).queue_rank, 1);
    assert.deepEqual(asked.notices, [{ kind: 'ask', to: [{ kind: 'agent', id: agentA }],
      about: `todo:${first}`, body: 'Please start the to-do at the front of your queue.' }]);
    const ready = reduceTodoEvents(s, asked.events);
    assert.equal(ready.todos[second]!.queue_rank, 2);
    assert.equal(value(run(ready, start, alice, agentA)).state, 'doing');

    // Explicit gates still apply, and an agent's offer retains the existing gate.
    const explicit = run(s, { ...command, gate });
    assert.deepEqual(value(explicit).gate, gate);
    assert.equal(value(explicit).gate_set_by, alice);
    refused(run(reduceTodoEvents(s, explicit.events), start, alice, agentA), 'gate_invalid');
    const offered = run(s, command, alice, agentA);
    assert.deepEqual(value(offered).offer!.gate, gate);
    assert.deepEqual(value(offered).gate, gate);
    assert.equal(value(offered).gate_set_by, bob);
    assert.equal(value(offered).queue_rank, 5);
  }
  const s = state(assignedA(second, { queue_rank: 4 }));
  const created = run(s, { kind: 'todo_create', title: 'Buy milk',
    assign: { to: { kind: 'agent', id: agentA }, start: 'now' } });
  assert.deepEqual(value(created).gate, { kind: 'none' });
  assert.equal(value(created).gate_set_by, null);
  assert.equal(value(created).queue_rank, 1);
  assert.equal(value(created).state, 'open');
  assert.equal(value(run(reduceTodoEvents(s, created.events),
    { kind: 'todo_start', todo_id: uid(100000) }, alice, agentA)).state, 'doing');
});

test('agent credentials add queued or gated work only as allowed by the acceptance policy', () => {
  for (const gate of [{ kind: 'none' }, { kind: 'hold', note: 'Ask first' }] as const) {
    const s = state(todo(), assignedA(second, { queue_rank: 4 }));
    const command: TodoCommand = { kind: 'todo_assign', todo_id: first, base_version: 1,
      to: { kind: 'agent', id: agentA }, start: 'queue', gate };
    const offered = run(s, command, bob, agentB);
    assert.equal(value(offered).assignee, null);
    assert.equal(value(offered).queue_rank, null);
    assert.equal(value(offered).offer!.decider_user_id, alice);
    assert.deepEqual(value(offered).offer!.gate, gate);
    assert.equal(reduceTodoEvents(s, offered.events).todos[second]!.queue_rank, 4);

    s.policies = { [agentA]: { principal_id: agentA, accepts_from: 'anyone', set_by_user: alice, set_at: at } };
    const accepted = run(s, command, bob, agentB);
    assert.deepEqual(value(accepted).assignee, { kind: 'agent', id: agentA });
    assert.equal(value(accepted).offer, null);
    assert.equal(value(accepted).queue_rank, 5);
    assert.deepEqual(value(accepted).gate, gate);
    assert.equal(reduceTodoEvents(s, accepted.events).todos[second]!.queue_rank, 4);
  }
});

test('reassignment preserves an omitted gate and its setter; an explicit gate replaces it', () => {
  for (const gate of [{ kind: 'hold', note: 'Ask first' },
    { kind: 'at', at: '2026-10-06T12:00:00.000Z' }, { kind: 'after', todo_id: second }] as const) {
    const s = state(assignedA(first, { gate, gate_set_by: bob }), todo(second));
    for (const to of [{ kind: 'agent', id: agentA }, { kind: 'user', id: alice }, null] as const) {
      const command: TodoCommand = { kind: 'todo_assign', todo_id: first, base_version: 1, to };
      const preserved = run(s, command);
      assert.deepEqual(value(preserved).gate, gate);
      assert.equal(value(preserved).gate_set_by, bob);
      assert.deepEqual(reduceTodoEvents(s, preserved.events).todos[first]!.gate, gate);

      const cleared = run(s, { ...command, gate: { kind: 'none' } });
      assert.deepEqual(value(cleared).gate, { kind: 'none' });
      assert.equal(value(cleared).gate_set_by, null);
    }
    const offer = run(s, assign({ kind: 'user', id: carol }));
    assert.deepEqual(value(offer).gate, gate);
    assert.equal(value(offer).gate_set_by, bob);
    assert.deepEqual(value(offer).offer!.gate, gate);
    const offeredState = reduceTodoEvents(s, offer.events);
    const accepted = run(offeredState, { kind: 'household_todo_answer', todo_id: first,
      offer_id: uid(300000), answer: 'accept' }, carol);
    assert.deepEqual(value(accepted).gate, gate);
    const changed = run(s, { kind: 'todo_assign', todo_id: first, base_version: 1,
      to: { kind: 'agent', id: agentA }, gate: { kind: 'hold', note: 'New hold' } });
    assert.deepEqual(value(changed).gate, { kind: 'hold', note: 'New hold' });
    assert.equal(value(changed).gate_set_by, alice);
  }
});

test('offer decisions require the named human, and acceptance applies the offered gate', () => {
  const s0 = state(todo());
  const d = run(s0, { kind: 'todo_assign', todo_id: first, base_version: 1, to: { kind: 'user', id: bob }, gate: { kind: 'hold', note: null } });
  const s = reduceTodoEvents(s0, d.events);
  const answer: TodoCommand = { kind: 'household_todo_answer', todo_id: first, offer_id: uid(300000), answer: 'accept' };
  refused(run(s, answer, carol), 'not_decider');
  refused(run(s, answer, bob, agentB), 'human_confirmation_required');
  const accepted = run(s, answer, bob);
  assert.deepEqual(value(accepted).assignee, { kind: 'user', id: bob });
  assert.deepEqual(value(accepted).gate, { kind: 'hold', note: null });
  assert.equal(value(accepted).gate_set_by, alice);
  assert.equal(reduceTodoEvents(s, accepted.events).todos[first]!.gate_set_by, alice);
  assert.equal(value(accepted).offer, null);
  assert.equal(value(accepted).state, 'open');
  assert.deepEqual(accepted.notices, [{ kind: 'note', to: [{ kind: 'user', id: alice }], about: `todo:${first}`, body: 'Accepted your to-do request.' }]);
  refused(run(s, { ...answer, offer_id: uid(999) }, bob), 'offer_not_pending');
  assert.equal(value(run(s, { ...answer, answer: 'decline' }, bob)).offer, null);
  assert.equal(run(s, { ...answer, answer: 'decline' }, bob).notices[0]!.body, 'Declined your to-do request.');
  refused(run(s, { ...answer, answer: 'withdraw' }, carol), 'not_decider');
  assert.equal(value(run(s, { ...answer, answer: 'withdraw' }, alice)).offer, null);
  assert.equal(value(run(s, { ...answer, answer: 'withdraw' }, admin)).offer, null);
});

test('accepted agent-authored offers keep the gate author and reject forged setters on replay', () => {
  for (const row of [
    { gate: { kind: 'none' }, setter: null },
    { gate: { kind: 'hold', note: 'Ask first' }, setter: alice },
    { gate: { kind: 'at', at: '2026-10-06T12:00:00.000Z' }, setter: alice },
    { gate: { kind: 'after', todo_id: third }, setter: alice },
  ] as const) {
    const initial = state(todo(), todo(third));
    const offered = run(initial, { kind: 'todo_assign', todo_id: first, base_version: 1,
      to: { kind: 'agent', id: agentB }, gate: row.gate }, alice, agentA);
    const pending = reduceTodoEvents(initial, offered.events);
    const accepted = run(pending, { kind: 'household_todo_answer', todo_id: first,
      offer_id: uid(300000), answer: 'accept' }, bob);
    assert.deepEqual(value(accepted).gate, row.gate);
    assert.equal(value(accepted).gate_set_by, row.setter);
    assert.deepEqual(value(accepted).assigned_by, { user_id: bob, principal_id: null });
    assert.equal(reduceTodoEvents(pending, accepted.events).todos[first]!.gate_set_by, row.setter);
    assert.equal(reduceTodoEvents(initial, [...offered.events, ...accepted.events]).todos[first]!.gate_set_by, row.setter);

    for (const setter of [bob, carol]) {
      const forged = structuredClone(accepted.events);
      const assignment = forged.find(e => e.type === 'TodoAssigned');
      assert.ok(assignment?.type === 'TodoAssigned');
      assignment.payload.todo.gate_set_by = setter;
      delete assignment.payload.receipt;
      assert.throws(() => reduceTodoEvents(pending, forged), StreamIntegrityError);
    }
  }
});

test('reassignment replaces an offer and accepted reassignment returns Doing to Open', () => {
  const original = state(todo());
  const offered = run(original, assign({ kind: 'user', id: bob }));
  const s = reduceTodoEvents(original, offered.events);
  const d = run(s, { kind: 'todo_assign', todo_id: first, base_version: 2, to: { kind: 'agent', id: agentA } });
  assert.deepEqual(d.events.map(e => e.type), ['TodoOfferAnswered', 'TodoAssigned']);
  assert.equal(d.events[0]!.type === 'TodoOfferAnswered' && d.events[0]!.payload.answer, 'replaced');
  assert.equal(value(d).version, 4);
  assert.equal(value(d).offer, null);
  const doing = state(assignedA(first, { state: 'doing' }));
  assert.equal(value(run(doing, assign({ kind: 'agent', id: agentA }))).state, 'open');
  assert.equal(value(run(doing, assign({ kind: 'user', id: bob }))).state, 'open');
  assert.equal(value(run(doing, { kind: 'todo_assign', todo_id: first, base_version: 1, to: null })).assignee, null);
});

test('accepting an agent now offer puts it first and sends one start ask to that agent', () => {
  const initial = state(todo(), assignedA(second, { queue_rank: 4 }));
  const request = run(initial, assign({ kind: 'agent', id: agentA }, 'now'), bob);
  const s = reduceTodoEvents(initial, request.events);
  const command: TodoCommand = { kind: 'household_todo_answer', todo_id: first, offer_id: uid(300000), answer: 'accept' };
  refused(run(s, command, admin), 'not_decider');
  const accepted = run(s, command);
  assert.equal(value(accepted).queue_rank, 1);
  assert.equal(value(accepted).state, 'open');
  assert.deepEqual(accepted.notices, [{ kind: 'ask', to: [{ kind: 'agent', id: agentA }], about: `todo:${first}`, body: 'Please start the to-do at the front of your queue.' }]);
  assert.equal(reduceTodoEvents(s, accepted.events).todos[second]!.queue_rank, 2);
});

test('state transition matrix allows only explicit lifecycle changes', () => {
  const allowed: Record<string, string[]> = { open: ['doing', 'done', 'dropped'], doing: ['open', 'done', 'dropped'], done: ['open'], dropped: ['open'] };
  for (const from of ['open', 'doing', 'done', 'dropped'] as const) {
    const s = state(todo(first, { state: from }));
    assert.equal(value(run(s, { kind: 'todo_set_state', todo_id: first, base_version: 1, state: allowed[from]![0] as 'open' | 'doing' | 'done' })).state, allowed[from]![0]);
    for (const to of ['open', 'doing', 'done', 'dropped'] as const) {
      const d = run(s, { kind: 'todo_set_state', todo_id: first, base_version: 1, state: to });
      if (allowed[from]!.includes(to)) assert.equal(value(d).state, to);
      else refused(d, 'invalid_transition');
    }
  }
});

test('only the assignee starts; finishing and reopening accept creator, assignee side and admin', () => {
  const s = state(assignedA());
  const start: TodoCommand = { kind: 'todo_start', todo_id: first };
  refused(run(s, start), 'not_assignee');
  refused(run(s, start, admin), 'not_assignee');
  assert.equal(value(run(s, start, alice, agentA)).state, 'doing');
  const finish: TodoCommand = { kind: 'todo_set_state', todo_id: first, base_version: 1, state: 'done' };
  refused(run(s, finish, carol), 'not_permitted');
  for (const [user, principal] of [[alice, null], [alice, agentA], [admin, null]] as const) assert.equal(value(run(s, finish, user, principal)).state, 'done');
  const ownedByBob = state(todo(first, { created_by: { user_id: carol, principal_id: null }, assignee: { kind: 'agent', id: agentB }, queue_rank: 1 }));
  assert.equal(value(run(ownedByBob, finish, bob)).state, 'done');
  assert.equal(value(run(ownedByBob, finish, carol, uid(13))).state, 'done');
  const person = state(todo(first, { assignee: { kind: 'user', id: bob } }));
  refused(run(person, start, alice, agentA), 'not_assignee');
  assert.equal(value(run(person, start, bob)).state, 'doing');
  const unassigned = value(run(state(todo()), start, bob));
  assert.deepEqual(unassigned.assignee, { kind: 'user', id: bob });
  assert.equal(unassigned.state, 'doing');
});

test('gates clear at the server time or terminal dependency, while cycles fail closed', () => {
  const dependency = todo(second);
  const todos = { [second]: dependency };
  assert.equal(evaluateGate({ kind: 'none' }, todos, now), true);
  assert.equal(evaluateGate({ kind: 'hold', note: 'Ask first' }, todos, now), false);
  assert.equal(evaluateGate({ kind: 'at', at }, todos, now - 1), false);
  assert.equal(evaluateGate({ kind: 'at', at }, todos, now), true);
  assert.equal(evaluateGate({ kind: 'after', todo_id: second }, todos, now), false);
  for (const terminal of ['done', 'dropped'] as const) assert.equal(evaluateGate({ kind: 'after', todo_id: second }, { [second]: todo(second, { state: terminal }) }, now), true);
  assert.equal(evaluateGate({ kind: 'after', todo_id: third }, todos, now), false);
  assert.equal(evaluateGate({ kind: 'at', at: 'wrong' }, todos, now), false);
  assert.equal(evaluateGate({ kind: 'none' }, todos, NaN), false);
  const cycle = { [first]: todo(first, { gate: { kind: 'after', todo_id: second } }), [second]: todo(second, { state: 'done', gate: { kind: 'after', todo_id: first } }) };
  assert.equal(evaluateGate({ kind: 'after', todo_id: first }, cycle, now), false);
  const s = state(assignedA(first), todo(second, { gate: { kind: 'after', todo_id: first } }));
  const gate: TodoCommand = { kind: 'household_todo_steer', todo_id: first, base_version: 1, action: { kind: 'gate', gate: { kind: 'after', todo_id: second } } };
  refused(run(s, gate), 'gate_cycle');
  assert.deepEqual(value(run(s, { ...gate, action: { kind: 'gate', gate: { kind: 'at', at } } })).gate, { kind: 'at', at });
  refused(run(s, { ...gate, action: { kind: 'gate', gate: { kind: 'after', todo_id: third } } }), 'gate_invalid');
  refused(run(s, { ...gate, action: { kind: 'gate', gate: { kind: 'at', at: '2026-02-30T12:00:00Z' } } }), 'gate_invalid');
  const held = state(assignedA(first, { gate: { kind: 'hold', note: null } }));
  refused(run(held, { kind: 'todo_start', todo_id: first }, alice, agentA), 'gate_invalid');
  assert.equal(value(run(state(assignedA()), { kind: 'todo_start', todo_id: first }, alice, agentA)).state, 'doing');
});

test('steering belongs to the human owner; moving renumbers exactly that line without version changes', () => {
  const s = state(assignedA(first, { queue_rank: 10 }), assignedA(second, { queue_rank: 50 }), assignedA(third, { queue_rank: 80 }),
    todo(uid(104), { assignee: { kind: 'agent', id: agentB }, queue_rank: 7 }));
  const move: TodoCommand = { kind: 'household_todo_steer', todo_id: third, base_version: 1, action: { kind: 'move', after_todo_id: first } };
  refused(run(s, move, admin), 'owner_only');
  refused(run(s, move, alice, agentA), 'human_confirmation_required');
  const d = run(s, move);
  assert.deepEqual(d.events.map(e => e.type), ['TodoQueueOrdered']);
  const next = reduceTodoEvents(s, d.events);
  assert.deepEqual([first, third, second, uid(104)].map(i => [next.todos[i]!.queue_rank, next.todos[i]!.version]), [[1, 1], [2, 1], [3, 1], [7, 1]]);
  refused(run(s, { ...move, action: { kind: 'move', after_todo_id: uid(104) } }), 'not_in_queue');
  refused(run(state(todo()), { ...move, todo_id: first }), 'not_in_queue');
  const startNow: TodoCommand = { ...move, action: { kind: 'start_now' } };
  const asked = run(s, startNow);
  assert.equal(value(asked).state, 'open');
  assert.equal(value(asked).queue_rank, 1);
  assert.equal(asked.notices[0]!.body, 'Please start the to-do at the front of your queue.');
  refused(run(s, startNow, bob), 'owner_only');
});

test('R7 reserves hold release to the human owner, including when someone else set the gate', () => {
  const s = state(assignedA(first, { gate: { kind: 'hold', note: null }, gate_set_by: bob }));
  const release: TodoCommand = { kind: 'household_todo_steer', todo_id: first, base_version: 1, action: { kind: 'gate', gate: { kind: 'none' } } };
  refused(run(s, release, carol), 'owner_only');
  refused(run(s, release, bob), 'owner_only');
  assert.deepEqual(value(run(s, release)).gate, { kind: 'none' });
  refused(run(s, { ...release, action: { kind: 'move', after_todo_id: null } }, bob), 'owner_only');
  assert.equal(value(run(s, { ...release, action: { kind: 'start_now' } })).state, 'open');
  assert.deepEqual(value(run(s, { ...release, action: { kind: 'start_now' } })).gate, { kind: 'none' });
});

test('the human owner starting now clears each gate before the agent starts', () => {
  for (const gate of [{ kind: 'hold', note: 'Ask first' },
    { kind: 'at', at: '2026-10-06T12:00:00.000Z' }, { kind: 'after', todo_id: third }] as const) {
    const s = state(assignedA(first, { queue_rank: 5, gate, gate_set_by: bob }),
      assignedA(second), todo(third));
    const start: TodoCommand = { kind: 'todo_start', todo_id: first };
    refused(run(s, start, alice, agentA), 'gate_invalid');
    const steer: TodoCommand = { kind: 'household_todo_steer', todo_id: first,
      base_version: 1, action: { kind: 'start_now' } };
    refused(run(s, steer, bob), 'owner_only');
    refused(run(s, steer, alice, agentA), 'human_confirmation_required');
    const asked = run(s, steer);
    assert.deepEqual(value(asked).gate, { kind: 'none' });
    assert.equal(value(asked).gate_set_by, null);
    assert.equal(value(asked).state, 'open');
    assert.equal(value(asked).queue_rank, 1);
    assert.deepEqual(asked.events.map(e => e.type), ['TodoGateSet', 'TodoQueueOrdered', 'TodoStartAsked']);
    const ready = reduceTodoEvents(s, asked.events);
    assert.equal(ready.todos[second]!.queue_rank, 2);
    assert.equal(value(run(ready, start, alice, agentA)).state, 'doing');
  }
});

test('start without an ID selects the first clear Open item, skipping Doing and Not yet', () => {
  const s = state(assignedA(first, { state: 'doing', queue_rank: 1 }), assignedA(second, { gate: { kind: 'hold', note: null }, queue_rank: 2 }), assignedA(third, { queue_rank: 3 }));
  assert.equal(value(run(s, { kind: 'todo_start' }, alice, agentA)).todo_id, third);
  refused(run(state(assignedA(first, { gate: { kind: 'hold', note: null } })), { kind: 'todo_start' }, alice, agentA), 'queue_empty');
  refused(run(s, { kind: 'todo_start' }), 'queue_empty');
  assert.equal(value(run(state(todo()), { kind: 'todo_start', todo_id: first })).state, 'doing');
});

test('only a human owner changes standing acceptance policy', () => {
  const s = state();
  const command: TodoCommand = { kind: 'household_agent_work_policy', principal_id: agentA, accepts_from: 'anyone' };
  refused(run(s, command, admin), 'owner_only');
  refused(run(s, command, alice, agentA), 'human_confirmation_required');
  const d = run(s, command);
  assert.deepEqual(d.outcome, { status: 'committed', value: { principal_id: agentA, accepts_from: 'anyone', set_by_user: alice, set_at: at } });
  assert.equal(reduceTodoEvents(s, d.events).policies[agentA]!.accepts_from, 'anyone');
});

test('comment target, text and mentions are validated; tagged comments emit one fixed notice', () => {
  const s = state(todo());
  const command: TodoCommand = { kind: 'todo_comment', target: { kind: 'todo', id: first }, body: '<b>Check this</b>', mentions: [{ kind: 'user', id: bob }, { kind: 'agent', id: agentA }] };
  const d = run(s, command);
  assert.equal(d.outcome.status, 'committed');
  const next = reduceTodoEvents(s, d.events);
  assert.equal(next.todos[first]!.comment_count, 1);
  assert.equal(next.todos[first]!.version, 2);
  assert.equal(next.comments[uid(400000)]!.body, '<b>Check this</b>');
  assert.deepEqual(d.notices, [{ kind: 'note', to: [{ kind: 'user', id: bob }, { kind: 'agent', id: agentA }], about: `todo:${first}`, body: 'Mentioned you in a comment.' }]);
  refused(run(s, { ...command, target: { kind: 'todo', id: third } }), 'target_not_found');
  refused(run(s, { ...command, body: ' ' }), 'comment_invalid');
  refused(run(s, { ...command, mentions: Array(9).fill({ kind: 'user', id: bob }) }), 'mentions_invalid');
  refused(run(s, { ...command, mentions: [{ kind: 'agent', id: uid(999) }] }), 'mentions_invalid');
  const object = run(s, { ...command, target: { kind: 'doc', id: 'recipes' } });
  assert.equal(object.outcome.status, 'committed');
  assert.equal(object.notices[0]!.about, 'object:recipes');
});

test('field validation and optimistic conflicts leave all projections unchanged', () => {
  const s = state(todo());
  const update: TodoCommand = { kind: 'todo_update', todo_id: first, base_version: 1, title: 'Bread', notes: 'Remember', due_on: '2026-11-01' };
  assert.deepEqual([value(run(s, update)).title, value(run(s, update)).notes, value(run(s, update)).due_on], ['Bread', 'Remember', '2026-11-01']);
  for (const title of ['', ' '.repeat(3), 'x'.repeat(201), 'bad\nname']) refused(run(s, { ...update, title }), 'title_invalid');
  refused(run(s, { ...update, notes: 'x'.repeat(4001) }), 'notes_invalid');
  refused(run(s, { ...update, due_on: '2026-02-29' }), 'due_invalid');
  refused(run(s, { ...update, todo_id: third }), 'todo_not_found');
  const conflict = run(s, { ...update, base_version: 2 });
  assert.deepEqual(conflict.outcome, { status: 'conflict', current: todo() });
  assert.deepEqual(conflict.events, []);
  assert.equal(s.todos[first]!.version, 1);
  assert.equal(value(run(s, { ...update, title: '🐄'.repeat(200) })).title, '🐄'.repeat(200));
  const unchanged = run(s, { ...update, title: 'Buy milk', notes: '', due_on: null });
  assert.equal(value(unchanged).version, 1);
  assert.deepEqual(unchanged.events, []);
});

test('foreign, missing and removed assignees are refused against current membership facts', () => {
  const s = state(todo());
  const command = assign({ kind: 'agent', id: agentA });
  assert.deepEqual(value(run(s, command)).assignee, { kind: 'agent', id: agentA });
  const missing = context(s, command); missing.agents = [];
  refused(decideTodo(s, command, missing), 'assignee_not_member');
  const foreign = context(s, command); foreign.agents = [{ principal_id: agentA, owner_user_id: alice, workspace_id: 'elsewhere', revoked_at: null }];
  refused(decideTodo(s, command, foreign), 'assignee_not_member');
  const removed = context(s, command); removed.agents = [{ principal_id: agentA, owner_user_id: alice, workspace_id: 'home', revoked_at: now }];
  refused(decideTodo(s, command, removed), 'assignee_removed');
  refused(run(s, assign({ kind: 'user', id: uid(999) })), 'assignee_not_member');
});

test('existing content checks protect writes, including replay', () => {
  const s = state(todo());
  const command: TodoCommand = { kind: 'todo_update', todo_id: first, base_version: 1, title: 'Bread' };
  assert.equal(value(run(s, command)).title, 'Bread');
  const cases: [string, (ctx: DecideTodoContext) => void][] = [
    ['workspace_access_refused', c => { c.access.workspace_id = 'elsewhere'; }],
    ['content_consent_required', c => { c.access.member!.content_consent_id = null; }],
    ['content_read_only', c => { c.access.member!.content_role = 'reader'; }],
    ['connection_access_refused', c => { c.access.actor.principal_id = agentA; }],
  ];
  for (const [reason, change] of cases) {
    const c = context(s, command); change(c); refused(decideTodo(s, command, c), reason);
  }
  const d = run(s, command);
  const next = reduceTodoEvents(s, d.events);
  const retry = { ...context(next, command), command_id: d.receipt!.command_id };
  retry.access.member!.content_consent_id = null;
  refused(decideTodo(next, command, retry), 'content_consent_required');
  retry.access.member!.content_consent_id = 'consent';
  const replay = decideTodo(next, command, retry);
  assert.equal(replay.replayed, true);
  assert.equal(value(replay).title, 'Bread');
});

test('200 per-agent and 1000 open-workspace caps include Doing and gated work, exclude terminal work', () => {
  const agentItems = Array.from({ length: 200 }, (_, i) => assignedA(uid(1000 + i), { queue_rank: i + 1, state: i === 0 ? 'doing' : 'open', gate: { kind: 'hold', note: null } }));
  const command = assign({ kind: 'agent', id: agentA });
  refused(run(state(todo(), ...agentItems), command), 'queue_full');
  assert.equal(value(run(state(todo(), ...agentItems.slice(0, 199)), command)).queue_rank, 200);
  const open = Array.from({ length: 1000 }, (_, i) => todo(uid(2000 + i), { state: i === 0 ? 'doing' : 'open' }));
  const create: TodoCommand = { kind: 'todo_create', title: 'Extra' };
  refused(run(state(...open), create), 'todo_limit_reached');
  assert.equal(value(run(state(...open.slice(0, 999)), create)).state, 'open');
  assert.equal(value(run(state(...open.slice(0, 999), todo(first, { state: 'dropped' })), create)).state, 'open');
  const reopen: TodoCommand = { kind: 'todo_set_state', todo_id: first, base_version: 1, state: 'open' };
  refused(run(state(...open, todo(first, { state: 'done' })), reopen), 'todo_limit_reached');
  assert.equal(value(run(state(...open.slice(0, 999), todo(first, { state: 'done' })), reopen)).state, 'open');
});

test('write limits charge new attempts but replay does not charge again', () => {
  const s = state(todo());
  const command: TodoCommand = { kind: 'todo_update', todo_id: first, base_version: 1, notes: 'Updated' };
  for (const [identity, workspace] of [[600, 0], [0, 2000], [-1, 0]]) {
    const c = context(s, command); c.identity_write_attempts = identity; c.workspace_write_attempts = workspace;
    refused(decideTodo(s, command, c), 'todo_write_rate_limited');
  }
  const c = context(s, command); c.identity_write_attempts = 599; c.workspace_write_attempts = 1999;
  const d = decideTodo(s, command, c);
  assert.equal(value(d).notes, 'Updated');
  const next = reduceTodoEvents(s, d.events);
  const retry = { ...context(next, command), command_id: c.command_id, identity_write_attempts: 600, workspace_write_attempts: 2000 };
  assert.equal(decideTodo(next, command, retry).replayed, true);
});

test('receipt replay returns the original value with no second event or notice; changed digest is refused', () => {
  const s = state(todo());
  const command = assign({ kind: 'agent', id: agentA }, 'now');
  const c = context(s, command);
  const d = decideTodo(s, command, c);
  assert.equal(d.notices.length, 1);
  const next = reduceTodoEvents(s, d.events);
  const retry = { ...context(next, command), command_id: c.command_id };
  const replay = decideTodo(next, command, retry);
  assert.equal(value(replay).state, 'open');
  assert.equal(value(replay).queue_rank, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.notices, []);
  refused(decideTodo(next, command, c), 'invalid_command_context');
  refused(decideTodo(next, command, { ...retry, request_digest: 'a'.repeat(64) }), 'request_id_reused');
  // Refusals are durable receipts without a fictitious refusal event.
  const bad: TodoCommand = { kind: 'todo_update', todo_id: first, base_version: 1, title: '' };
  const rejected = run(s, bad);
  refused(rejected, 'title_invalid');
  const saved = { ...s, receipts: { [JSON.stringify([alice, rejected.receipt!.command_id])]: rejected.receipt! } };
  const recovered = run(saved, bad);
  assert.equal(recovered.replayed, true);
  refused(recovered, 'title_invalid');
});

test('invalid command IDs, digests and sequences return a stable refusal without a receipt', () => {
  const s = { ...state(todo()), last_seq: 8 };
  const command: TodoCommand = { kind: 'todo_update', todo_id: first, base_version: 1, title: 'Bread' };
  const valid = context(s, command);
  const changes: Partial<DecideTodoContext>[] = [
    { command_id: '' }, { request_digest: '' }, { request_digest: 'a'.repeat(63) },
    { request_digest: 'a'.repeat(65) }, { request_digest: 'A'.repeat(64) },
    { seq: -1 }, { seq: 8 }, { seq: 8.5 }, { seq: NaN }, { seq: Infinity }, { seq: 9007199254740992 },
  ];
  for (const change of changes) {
    assert.deepEqual(decideTodo(s, command, { ...valid, ...change }), {
      outcome: { status: 'refused', reason: 'invalid_command_context' },
      events: [], receipt: null, notices: [], replayed: false,
    });
  }
  const accepted = decideTodo(s, command, valid);
  assert.equal(value(accepted).title, 'Bread');
  assert.equal(accepted.events[0]!.seq, 9);
  const next = reduceTodoEvents(s, accepted.events);
  assert.deepEqual(decideTodo(next, command, { ...valid, seq: 9 }), {
    outcome: { status: 'refused', reason: 'invalid_command_context' },
    events: [], receipt: null, notices: [], replayed: false,
  });
  const replay = decideTodo(next, command, { ...valid, seq: 10 });
  assert.equal(value(replay).title, 'Bread');
  assert.equal(replay.replayed, true);
});

// This input is hand-written, not output from decideTodo. It protects the event
// contract and proves replay without relying on the decider's event serializer.
const golden: TodoEvent = { type: 'TodoCreated', workspace_id: 'home', stream_id: 'stream', seq: 0,
  event_id: uid(700000), command_id: 'golden', schema_version: 1, actor_user: alice,
  actor_agent_principal: null, actor_run: null, occurred_at_server: now,
  payload: { todo: todo(), receipt: { principal: alice, command_id: 'golden', request_digest: 'b'.repeat(64), outcome: { status: 'committed', value: todo() } } } };
test('golden event replay is deterministic, immutable and rejects wrong stream/schema/size/type/order', () => {
  for (let i = 0; i < 2; i++) {
    const next = reduceTodoEvents(state(), [structuredClone(golden)]);
    assert.deepEqual(next.todos, { [first]: todo() });
    assert.equal(next.last_seq, 0);
    assert.equal(next.receipts[JSON.stringify([alice, 'golden'])]!.outcome.status, 'committed');
  }
  assert.deepEqual(state().todos, {});
  for (const changed of [{ ...golden, workspace_id: 'elsewhere' }, { ...golden, schema_version: 2 }, { ...golden, seq: -1 },
    { ...golden, padding: 'x'.repeat(65536) }]) assert.throws(() => reduceTodoEvents(state(), [changed as TodoEvent]), StreamIntegrityError);
  assert.throws(() => reduceTodoEvents(state(), [{ ...golden, type: 'Invented' } as unknown as TodoEvent]), UnknownEventTypeError);
  assert.throws(() => reduceTodoEvents(state(), [golden, golden]), StreamIntegrityError);
  const next = reduceTodoEvents(state(), [golden]); next.todos[first]!.title = 'Changed view';
  assert.equal(golden.payload.todo.title, 'Buy milk');
});

test('replay rejects forged receipts, unrelated field edits and incomplete queue orders', () => {
  assert.equal(reduceTodoEvents(state(), [golden]).todos[first]!.title, 'Buy milk');
  const forged = structuredClone(golden);
  forged.payload.receipt!.outcome = { status: 'committed', value: todo(first, { title: 'A different receipt' }) };
  assert.throws(() => reduceTodoEvents(state(), [forged]), StreamIntegrityError);
  const edit: TodoEvent = { ...golden, type: 'TodoDetailsChanged', payload: { todo: todo(first, { version: 2, title: 'Bread' }) } };
  assert.equal(reduceTodoEvents(state(todo()), [edit]).todos[first]!.title, 'Bread');
  assert.throws(() => reduceTodoEvents(state(todo()), [{ ...edit, payload: { todo: todo(first, { version: 2, created_by: { user_id: bob, principal_id: null } }) } }]), StreamIntegrityError);
  const s = state(assignedA(), assignedA(second, { queue_rank: 5 }));
  const order: TodoEvent = { ...golden, type: 'TodoQueueOrdered', payload: { principal_id: agentA, todo_ids: [second, first] } };
  assert.equal(reduceTodoEvents(s, [order]).todos[second]!.queue_rank, 1);
  assert.throws(() => reduceTodoEvents(s, [{ ...order, payload: { principal_id: agentA, todo_ids: [second] } }]), StreamIntegrityError);
});

test('agent work status table uses credential facts and recent server activity, never waiting messages', () => {
  const base: AgentWorkFacts = { transport: 'hosted_mcp', turn_only: true, connection: 'live',
    last_activity_at: at, messages_waiting_since: '2026-10-01T00:00:00Z', doing: null, working_on: null };
  const doing = { todo_id: first, title: null, since: at };
  const claim = { signal_id: uid(800), at, until: '2026-10-06T12:00:00Z' };
  const rows: [Partial<AgentWorkFacts>, number, string][] = [
    [{}, now, 'idle'], [{ doing }, now, 'working'], [{ working_on: claim }, now, 'working'],
    [{ doing }, now + 1800000, 'working'], [{ doing }, now + 1800001, 'idle'],
    [{ doing, last_activity_at: null }, now, 'idle'], [{ working_on: claim, last_activity_at: '2026-10-05T09:00:00Z' }, now, 'idle'],
    [{ working_on: { ...claim, until: at } }, now, 'idle'], [{ doing, last_activity_at: 'invalid' }, now, 'idle'],
    [{ doing, last_activity_at: '2026-10-05T12:01:00Z' }, now, 'idle'],
    [{ transport: 'local', turn_only: false }, now, 'idle'], [{ doing }, NaN, 'idle'],
  ];
  for (const connection of ['removed', 'key_off', 'key_ended', 'paused'] as const) rows.push([{ connection, doing, working_on: claim }, now, 'disconnected']);
  for (const [facts, time, expected] of rows) assert.equal(agentWorkState({ ...base, ...facts }, time), expected);
});
