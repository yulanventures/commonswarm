/** Unit tests for #742 Approve Action on To-Dos (R4):
 * Covers approval creation & origin scope, household_todo_decide authorization & notes,
 * Condition 1 (freeze, reopen, decider reassignment, dependent gate evaluation & preservation
 * on start_now / ownerStartNow / self-claim), Condition 3 (mandatory base_version on
 * household_todo_answer, offer freeze/replacement, own-agent wake fix), MCP catalog exclusion,
 * summary()/view() projections, and replay reauthorization in todos.write. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decideTodo, emptyHouseholdTodoState, evaluateGate, reduceTodoEvents,
  type Todo, type TodoCommand, type HouseholdTodoState, type DecideTodoContext, type TodoEvent, type TodoDecision,
} from '../src/protocol/household-todos.js';
import {
  TODO_DECISION_NOTE_LIMIT, TODO_NOTICE_BODIES,
} from '../src/protocol/household-todo-policy.js';
import * as todoPolicy from '../src/protocol/household-todo-policy.js';
import * as todosCore from '../src/protocol/household-todos.js';
import * as accessPolicy from '../src/protocol/household-object-policy.js';
import {
  HOUSEHOLD_TOOLS, HOSTED_TODO_LIST_TOOLS, HouseholdToolInputError,
  householdToolInvocation, validateHouseholdHumanCommand, validateHouseholdToolArguments,
} from '../src/protocol/household-tool-registry.js';
import { StreamIntegrityError } from '../src/protocol/reducer.js';
import type { HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';
import { createHouseholdTodoStore } from '../supabase/functions/command/household-todos.js';
import { HOUSEHOLD_SURFACE_KINDS } from '../supabase/functions/command/household-integration.js';

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(9999);
const alice = uid(1), bob = uid(2), carol = uid(3), admin = uid(4);
const agentA = uid(11), agentB = uid(12);
const first = uid(101), second = uid(102), third = uid(103);
const chOne = uid(201), convDm = uid(202), convGroup = uid(203);
const at = '2026-11-25T12:00:00.000Z';
const now = Date.parse(at);

function access(user = alice, principal: string | null = null): HouseholdAccessFacts {
  return {
    workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: user, principal_id: principal, run_id: principal ? 'run' : null },
    member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: 'consent' },
    credential: principal
      ? {
          kind: 'agent',
          connection: {
            principal_id: principal, owner_user_id: user, workspace_id: workspace,
            connection_id: 'connection', grant_id: 'approval', revoked_at: null,
            expires_at: now + 10000, operations: ['read', 'create', 'update'], purpose: 'shared',
          },
        }
      : { kind: 'human' },
  };
}

function todo(todoId = first, extra: Partial<Todo> = {}): Todo {
  return {
    workspace_id: workspace, todo_id: todoId, version: 1, kind: 'task',
    title: 'Buy milk', notes: '', due_on: null, state: 'open',
    created_by: { user_id: alice, principal_id: null }, created_at: at,
    assignee: null, assigned_by: null, assigned_at: null, offer: null,
    gate: { kind: 'none' }, gate_set_by: null, queue_rank: null,
    state_by: { user_id: alice, principal_id: null }, state_at: at, comment_count: 0,
    decision_status: null, decision_by_user: null, decision_at: null, decision_note: null,
    origin_placement: 'workspace', origin_channel_id: null, origin_conversation_id: null,
    ...extra,
  };
}

function state(...todos: Todo[]): HouseholdTodoState {
  return { ...emptyHouseholdTodoState(workspace, 'stream'), todos: Object.fromEntries(todos.map(t => [t.todo_id, t])) };
}

function context(s: HouseholdTodoState, command: TodoCommand, user = alice, principal: string | null = null, extra: Partial<DecideTodoContext> = {}): DecideTodoContext {
  return {
    access: access(user, principal), now, seq: s.last_seq + 1, command_id: `command-${s.last_seq + 1}`,
    request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    event_ids: Array.from({ length: 10 }, (_, i) => uid(500000 + (s.last_seq + 1) * 10 + i)),
    todo_id: uid(100000), offer_id: uid(300000), comment_id: uid(400000),
    members: [alice, bob, carol, admin].map(user_id => ({ user_id, workspace_id: workspace, revoked_at: null, role: user_id === admin ? 'admin' : 'member' })),
    agents: [
      { principal_id: agentA, owner_user_id: alice, workspace_id: workspace, revoked_at: null },
      { principal_id: agentB, owner_user_id: bob, workspace_id: workspace, revoked_at: null },
    ],
    objects: [], identity_write_attempts: 0, workspace_write_attempts: 0,
    ...extra,
  };
}

function run(s: HouseholdTodoState, command: TodoCommand, user = alice, principal: string | null = null, extra: Partial<DecideTodoContext> = {}): TodoDecision {
  return decideTodo(s, command, context(s, command, user, principal, extra));
}

function value(d: TodoDecision): Todo {
  assert.equal(d.outcome.status, 'committed', `expected committed, got ${JSON.stringify(d.outcome)}`);
  assert.ok(d.outcome.status === 'committed' && 'todo_id' in d.outcome.value);
  return d.outcome.value as Todo;
}

function refused(d: TodoDecision, reason: string): void {
  assert.deepEqual(d.outcome, { status: 'refused', reason });
  assert.deepEqual(d.events, []);
  assert.deepEqual(d.notices, []);
}

test('approval creation requires live human assignee, assigns directly without offer, emits approval_ask, and enforces v1 workspace/general origin scope', () => {
  // Agent (alice's own agent) creates approval assigned to alice -> direct assignment, no offer, emits approval_ask notice.
  const ownAgentCreate = run(state(), {
    kind: 'todo_create', title: 'Approve roof quote', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } },
  }, alice, agentA);
  const created = value(ownAgentCreate);
  assert.equal(created.kind, 'approval');
  assert.equal(created.state, 'open');
  assert.equal(created.offer, null);
  assert.deepEqual(created.assignee, { kind: 'user', id: alice });
  assert.equal(created.decision_status, null);
  assert.equal(created.origin_placement, 'workspace');
  assert.deepEqual(ownAgentCreate.events.map(e => e.type), ['TodoCreated', 'TodoAssigned']);
  assert.deepEqual(ownAgentCreate.notices, [{
    kind: 'ask', to: [{ kind: 'user', id: alice }],
    about: `todo:${created.todo_id}`, body: TODO_NOTICE_BODIES.approval_ask,
  }]);
  assert.equal(reduceTodoEvents(state(), ownAgentCreate.events).todos[created.todo_id]!.kind, 'approval');

  // Cross-member human creation for bob -> also direct assignment (no offer), emits approval_ask to bob, allows 'general'.
  const crossCreate = run(state(), {
    kind: 'todo_create', title: 'Approve contractor', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: bob } }, origin_placement: 'general',
  }, alice);
  const crossTodo = value(crossCreate);
  assert.equal(crossTodo.offer, null);
  assert.deepEqual(crossTodo.assignee, { kind: 'user', id: bob });
  assert.equal(crossTodo.origin_placement, 'general');
  assert.deepEqual(crossCreate.notices, [{
    kind: 'ask', to: [{ kind: 'user', id: bob }],
    about: `todo:${crossTodo.todo_id}`, body: TODO_NOTICE_BODIES.approval_ask,
  }]);

  // Refusals: missing assignee, agent assignee, start:'now', non-none gate, non-member assignee.
  refused(run(state(), { kind: 'todo_create', title: 'No assignee', todo_kind: 'approval' }, alice, agentA), 'invalid_transition');
  refused(run(state(), { kind: 'todo_create', title: 'Agent assignee', todo_kind: 'approval', assign: { to: { kind: 'agent', id: agentA } } }, alice), 'invalid_transition');
  refused(run(state(), { kind: 'todo_create', title: 'Start now', todo_kind: 'approval', assign: { to: { kind: 'user', id: alice }, start: 'now' } }, alice, agentA), 'invalid_transition');
  refused(run(state(), { kind: 'todo_create', title: 'Gated', todo_kind: 'approval', assign: { to: { kind: 'user', id: alice }, gate: { kind: 'hold', note: null } } }, alice, agentA), 'invalid_transition');
  refused(run(state(), { kind: 'todo_create', title: 'Outsider', todo_kind: 'approval', assign: { to: { kind: 'user', id: uid(999) } } }, alice), 'assignee_not_member');

  // v1 origin scope: channel, dm, group_dm all refused with approval_origin_not_allowed (even if accessible).
  refused(run(state(), {
    kind: 'todo_create', title: 'Ch approval', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } }, origin_placement: 'channel', origin_channel_id: chOne,
  }, alice, agentA, { origin_channel_accessible: true }), 'approval_origin_not_allowed');
  refused(run(state(), {
    kind: 'todo_create', title: 'DM approval', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } }, origin_placement: 'dm', origin_conversation_id: convDm,
  }, alice, agentA, { origin_conversation_accessible: true }), 'approval_origin_not_allowed');
  refused(run(state(), {
    kind: 'todo_create', title: 'Group DM approval', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } }, origin_placement: 'group_dm', origin_conversation_id: convGroup,
  }, alice, agentA, { origin_conversation_accessible: true }), 'approval_origin_not_allowed');

  // Reducer independently rejects forged private-origin approval events.
  const forgedOrigin = structuredClone(ownAgentCreate.events[0]!);
  if (forgedOrigin.type === 'TodoCreated') {
    forgedOrigin.payload.todo.origin_placement = 'channel';
    forgedOrigin.payload.todo.origin_channel_id = chOne;
  }
  assert.throws(() => reduceTodoEvents(state(), [forgedOrigin]), StreamIntegrityError);
});

test('household_todo_decide authorization matrix, note validation, trimming, and requester wake (including own agent)', () => {
  const created = run(state(), {
    kind: 'todo_create', title: 'Approve deploy', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } },
  }, alice, agentA);
  const s = reduceTodoEvents(state(), created.events);
  const approvalId = value(created).todo_id;
  const v = value(created).version;

  // Agent (including alice's own agent) is refused human_confirmation_required.
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve' }, alice, agentA), 'human_confirmation_required');
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'decline' }, bob, agentB), 'human_confirmation_required');

  // Non-assignee humans (creator/other member/admin) are refused not_decider.
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve' }, bob), 'not_decider');
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve' }, admin), 'not_decider');

  // Regular task cannot be decided via household_todo_decide.
  const taskState = state(todo(first, { assignee: { kind: 'user', id: alice } }));
  refused(run(taskState, { kind: 'household_todo_decide', todo_id: first, base_version: 1, decision: 'approve' }, alice), 'invalid_transition');

  // Stale base_version returns conflict with zero events and zero notices.
  const conflict = run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v + 1, decision: 'approve' }, alice);
  assert.equal(conflict.outcome.status, 'conflict');
  assert.deepEqual(conflict.events, []);
  assert.deepEqual(conflict.notices, []);

  // Note validation: 500 code points OK, 501 refused, control chars refused, whitespace-only trims to null.
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve', note: 'a'.repeat(TODO_DECISION_NOTE_LIMIT + 1) }, alice), 'notes_invalid');
  refused(run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve', note: 'ok\u0007' }, alice), 'notes_invalid');
  const maxEmoji = '😀'.repeat(TODO_DECISION_NOTE_LIMIT);
  const approvedWithMaxNote = run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'approve', note: maxEmoji }, alice);
  assert.equal(value(approvedWithMaxNote).decision_note, maxEmoji);
  assert.equal(value(approvedWithMaxNote).decision_status, 'approved');
  assert.equal(value(approvedWithMaxNote).decision_by_user, alice);
  assert.equal(value(approvedWithMaxNote).decision_at, at);
  assert.equal(value(approvedWithMaxNote).state, 'done');
  assert.deepEqual(approvedWithMaxNote.events.map(e => e.type), ['TodoDecided']);
  // Own-agent requester IS woken!
  assert.deepEqual(approvedWithMaxNote.notices, [{
    kind: 'note', to: [{ kind: 'agent', id: agentA }],
    about: `todo:${approvalId}`, body: TODO_NOTICE_BODIES.approved,
  }]);

  // Whitespace-only note normalizes to null on decline, and wakes requester with declined_decision body.
  const declined = run(s, { kind: 'household_todo_decide', todo_id: approvalId, base_version: v, decision: 'decline', note: '   \n\t  ' }, alice);
  assert.equal(value(declined).decision_status, 'declined');
  assert.equal(value(declined).decision_note, null);
  assert.equal(value(declined).state, 'dropped');
  assert.deepEqual(declined.notices, [{
    kind: 'note', to: [{ kind: 'agent', id: agentA }],
    about: `todo:${approvalId}`, body: TODO_NOTICE_BODIES.declined_decision,
  }]);

  // Human requester (different user) is woken; self-created self-assigned human approval emits 0 notices.
  const humanAsked = run(state(), {
    kind: 'todo_create', title: 'Approve budget', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: bob } },
  }, alice);
  const sHuman = reduceTodoEvents(state(), humanAsked.events);
  const humanDecided = run(sHuman, {
    kind: 'household_todo_decide', todo_id: value(humanAsked).todo_id, base_version: value(humanAsked).version, decision: 'approve', note: '  Looks good  ',
  }, bob);
  assert.equal(value(humanDecided).decision_note, 'Looks good');
  assert.deepEqual(humanDecided.notices, [{
    kind: 'note', to: [{ kind: 'user', id: alice }],
    about: `todo:${value(humanAsked).todo_id}`, body: TODO_NOTICE_BODIES.approved,
  }]);

  const selfAsked = run(state(), {
    kind: 'todo_create', title: 'Self check', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } },
  }, alice);
  assert.deepEqual(selfAsked.notices, []);
  const sSelf = reduceTodoEvents(state(), selfAsked.events);
  const selfDecided = run(sSelf, {
    kind: 'household_todo_decide', todo_id: value(selfAsked).todo_id, base_version: value(selfAsked).version, decision: 'approve',
  }, alice);
  assert.deepEqual(selfDecided.notices, []);
});

test('Condition 1: decided approval freeze, immutable kind, direct done/doing refusal, human-only reopen clearing decision, and human-only decider reassignment', () => {
  const created = run(state(), {
    kind: 'todo_create', title: 'Approve vendor', todo_kind: 'approval',
    assign: { to: { kind: 'user', id: alice } },
  }, bob, agentB);
  const openState = reduceTodoEvents(state(), created.events);
  const approvalId = value(created).todo_id;
  const openV = value(created).version;

  // Direct done/doing/start on kind = 'approval' are refused.
  refused(run(openState, { kind: 'todo_set_state', todo_id: approvalId, base_version: openV, state: 'done' }, alice), 'invalid_transition');
  refused(run(openState, { kind: 'todo_set_state', todo_id: approvalId, base_version: openV, state: 'doing' }, alice), 'invalid_transition');
  refused(run(openState, { kind: 'todo_start', todo_id: approvalId }, alice), 'invalid_transition');
  refused(run(openState, { kind: 'todo_set_state', todo_id: approvalId, base_version: openV, state: 'done' }, alice, agentA), 'human_confirmation_required');
  refused(run(openState, { kind: 'todo_start', todo_id: approvalId }, alice, agentA), 'human_confirmation_required');

  // Dropping an open undecided approval leaves decision_status = null and does NOT clear dependent gates.
  const dropped = run(openState, { kind: 'todo_set_state', todo_id: approvalId, base_version: openV, state: 'dropped' }, alice);
  assert.equal(value(dropped).state, 'dropped');
  assert.equal(value(dropped).decision_status, null);
  const droppedState = reduceTodoEvents(openState, dropped.events);
  assert.equal(evaluateGate({ kind: 'after', todo_id: approvalId }, droppedState.todos, now), false);

  // Reassigning an open approval decider: agent refused, null/agent target refused, non-decider non-admin refused, decider & admin succeed.
  refused(run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: { kind: 'user', id: bob } }, alice, agentA), 'human_confirmation_required');
  refused(run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: null }, alice), 'invalid_transition');
  refused(run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: { kind: 'agent', id: agentA } }, alice), 'invalid_transition');
  refused(run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: { kind: 'user', id: bob } }, carol), 'not_permitted');
  const reassignedByDecider = run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: { kind: 'user', id: bob } }, alice);
  assert.deepEqual(value(reassignedByDecider).assignee, { kind: 'user', id: bob });
  assert.equal(reassignedByDecider.notices[0]!.body, TODO_NOTICE_BODIES.approval_ask);
  const reassignedByAdmin = run(openState, { kind: 'todo_assign', todo_id: approvalId, base_version: openV, to: { kind: 'user', id: carol } }, admin);
  assert.deepEqual(value(reassignedByAdmin).assignee, { kind: 'user', id: carol });

  // Approve, then verify post-approval freeze on todo_update for both approved and declined.
  const approved = run(openState, { kind: 'household_todo_decide', todo_id: approvalId, base_version: openV, decision: 'approve', note: 'Approved' }, alice);
  const approvedState = reduceTodoEvents(openState, approved.events);
  const approvedV = value(approved).version;
  refused(run(approvedState, { kind: 'todo_update', todo_id: approvalId, base_version: approvedV, title: 'Mutated' }, alice), 'approval_decided_frozen');
  refused(run(approvedState, { kind: 'todo_update', todo_id: approvalId, base_version: approvedV, notes: 'Mutated' }, admin), 'approval_decided_frozen');
  refused(run(approvedState, { kind: 'todo_update', todo_id: approvalId, base_version: approvedV, due_on: '2026-12-31' }, alice, agentA), 'approval_decided_frozen');

  const declined = run(openState, { kind: 'household_todo_decide', todo_id: approvalId, base_version: openV, decision: 'decline', note: 'No' }, alice);
  const declinedState = reduceTodoEvents(openState, declined.events);
  refused(run(declinedState, { kind: 'todo_update', todo_id: approvalId, base_version: value(declined).version, title: 'Mutated' }, alice), 'approval_decided_frozen');

  // Reducer rejects forged TodoDetailsChanged on decided approval AND forged kind mutation.
  const forgedEdit: TodoEvent = {
    workspace_id: workspace, stream_id: 'stream', schema_version: 1, seq: approvedState.last_seq + 1,
    event_id: uid(900001), command_id: 'forged-edit', type: 'TodoDetailsChanged',
    actor_user: alice, actor_agent_principal: null, actor_run: null, occurred_at_server: now,
    payload: { todo: { ...approvedState.todos[approvalId]!, version: approvedV + 1, title: 'Forged' } },
  };
  assert.throws(() => reduceTodoEvents(approvedState, [forgedEdit]), StreamIntegrityError);
  const forgedKind: TodoEvent = {
    workspace_id: workspace, stream_id: 'stream', schema_version: 1, seq: openState.last_seq + 1,
    event_id: uid(900002), command_id: 'forged-kind', type: 'TodoDetailsChanged',
    actor_user: alice, actor_agent_principal: null, actor_run: null, occurred_at_server: now,
    payload: { todo: { ...openState.todos[approvalId]!, version: openV + 1, kind: 'task', title: 'Downgraded' } },
  };
  assert.throws(() => reduceTodoEvents(openState, [forgedKind]), StreamIntegrityError);

  // Reopening a decided approval: agent refused, non-decider non-admin human refused, decider & admin succeed and clear all decision_* to null.
  refused(run(approvedState, { kind: 'todo_set_state', todo_id: approvalId, base_version: approvedV, state: 'open' }, alice, agentA), 'human_confirmation_required');
  refused(run(approvedState, { kind: 'todo_set_state', todo_id: approvalId, base_version: approvedV, state: 'open' }, bob), 'not_permitted');
  for (const reopener of [alice, admin]) {
    const reopened = run(approvedState, { kind: 'todo_set_state', todo_id: approvalId, base_version: approvedV, state: 'open' }, reopener);
    const reopenedTodo = value(reopened);
    assert.equal(reopenedTodo.state, 'open');
    assert.equal(reopenedTodo.decision_status, null);
    assert.equal(reopenedTodo.decision_by_user, null);
    assert.equal(reopenedTodo.decision_at, null);
    assert.equal(reopenedTodo.decision_note, null);
    const replayed = reduceTodoEvents(approvedState, reopened.events);
    assert.equal(evaluateGate({ kind: 'after', todo_id: approvalId }, replayed.todos, now), false);
  }
});

test('Condition 1 Gap 1: approval gate evaluation, survival across start_now / ownerStartNow / self-claim, reopen re-block, and explicit gate override authorization', () => {
  const approval = todo(first, { kind: 'approval', assignee: { kind: 'user', id: bob } });
  const task = todo(second, {
    assignee: { kind: 'agent', id: agentA }, queue_rank: 5,
    gate: { kind: 'after', todo_id: first }, gate_set_by: bob,
  });
  const otherTask = todo(third, { assignee: { kind: 'agent', id: agentA }, queue_rank: 1 });
  const unapprovedState = state(approval, task, otherTask);

  // 1. Unapproved approval keeps gate blocked across start, queue pickup, steer(start_now), assign(start:'now'), and create(start:'now').
  assert.equal(evaluateGate(task.gate, unapprovedState.todos, now), false);
  refused(run(unapprovedState, { kind: 'todo_start', todo_id: second }, alice, agentA), 'gate_invalid');
  refused(run(unapprovedState, { kind: 'todo_set_state', todo_id: second, base_version: 1, state: 'doing' }, alice, agentA), 'gate_invalid');
  // Queue pickup skips gated task and picks otherTask (third).
  assert.equal(value(run(unapprovedState, { kind: 'todo_start' }, alice, agentA)).todo_id, third);
  refused(run(state(approval, task), { kind: 'todo_start' }, alice, agentA), 'queue_empty');
  // household_todo_steer(start_now) and todo_assign(..., start:'now') refused under uncleared approval gate.
  refused(run(unapprovedState, { kind: 'household_todo_steer', todo_id: second, base_version: 1, action: { kind: 'start_now' } }, alice), 'gate_invalid');
  refused(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentA }, start: 'now' }, alice), 'gate_invalid');
  refused(run(unapprovedState, { kind: 'todo_create', title: 'Bypass', assign: { to: { kind: 'agent', id: agentA }, start: 'now', gate: { kind: 'after', todo_id: first } } }, alice), 'gate_invalid');

  // Agent todo_assign cannot remove, weaken, or replace an existing approval gate.
  refused(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentA }, gate: { kind: 'none' } }, alice, agentA), 'human_confirmation_required');
  refused(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentB }, gate: { kind: 'none' } }, bob, agentB), 'human_confirmation_required');

  // Non-decider non-admin human (alice, even though she owns agentA!) cannot remove bob's approval gate; bob (decider) and admin can.
  refused(run(unapprovedState, { kind: 'household_todo_steer', todo_id: second, base_version: 1, action: { kind: 'gate', gate: { kind: 'none' } } }, alice), 'not_permitted');
  refused(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentA }, gate: { kind: 'none' } }, alice), 'not_permitted');
  // Admin can explicitly clear the approval gate (unassigning or offering a cleared gate to alice's agent).
  assert.deepEqual(value(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: null, gate: { kind: 'none' } }, admin)).gate, { kind: 'none' });
  assert.deepEqual(value(run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentA }, gate: { kind: 'none' } }, admin)).offer!.gate, { kind: 'none' });
  // Bob (the approval decider) can explicitly clear the approval gate via todo_assign.
  const bobClear = run(unapprovedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: null, gate: { kind: 'none' } }, bob);
  assert.deepEqual(value(bobClear).gate, { kind: 'none' });

  // 2. Approve first -> evaluateGate becomes true.
  const approvedDec = run(unapprovedState, { kind: 'household_todo_decide', todo_id: first, base_version: 1, decision: 'approve' }, bob);
  const approvedState = reduceTodoEvents(unapprovedState, approvedDec.events);
  assert.equal(evaluateGate(task.gate, approvedState.todos, now), true);

  // Gap 1a: Successful household_todo_steer(start_now) while approved moves task to front, emits TodoStartAsked + start notice,
  // emits ZERO TodoGateSet events, and preserves todo.gate and todo.gate_set_by unchanged!
  const steered = run(approvedState, { kind: 'household_todo_steer', todo_id: second, base_version: 1, action: { kind: 'start_now' } }, alice);
  assert.equal(steered.outcome.status, 'committed');
  assert.deepEqual(steered.events.map(e => e.type), ['TodoQueueOrdered', 'TodoStartAsked']);
  assert.deepEqual(value(steered).gate, { kind: 'after', todo_id: first });
  assert.equal(value(steered).gate_set_by, bob);
  assert.equal(value(steered).queue_rank, 1);
  assert.equal(steered.notices[0]!.body, TODO_NOTICE_BODIES.start);
  const afterSteer = reduceTodoEvents(approvedState, steered.events);

  // Reopen the approval -> dependent task is immediately re-blocked on every start path!
  const reopenedDec = run(afterSteer, { kind: 'todo_set_state', todo_id: first, base_version: 2, state: 'open' }, bob);
  const reopenedState = reduceTodoEvents(afterSteer, reopenedDec.events);
  assert.equal(evaluateGate(reopenedState.todos[second]!.gate, reopenedState.todos, now), false);
  refused(run(reopenedState, { kind: 'todo_start', todo_id: second }, alice, agentA), 'gate_invalid');
  refused(run(reopenedState, { kind: 'todo_set_state', todo_id: second, base_version: reopenedState.todos[second]!.version, state: 'doing' }, alice, agentA), 'gate_invalid');
  refused(run(reopenedState, { kind: 'household_todo_steer', todo_id: second, base_version: reopenedState.todos[second]!.version, action: { kind: 'start_now' } }, alice), 'gate_invalid');
  refused(run(reopenedState, { kind: 'todo_assign', todo_id: second, base_version: reopenedState.todos[second]!.version, to: { kind: 'agent', id: agentA }, start: 'now' }, alice), 'gate_invalid');

  // Gap 1b: Successful ownerStartNow (todo_assign(..., start:'now') with gate omitted) while approved preserves gate & gate_set_by!
  const ownerAssign = run(approvedState, { kind: 'todo_assign', todo_id: second, base_version: 1, to: { kind: 'agent', id: agentA }, start: 'now' }, alice);
  assert.deepEqual(value(ownerAssign).gate, { kind: 'after', todo_id: first });
  assert.equal(value(ownerAssign).gate_set_by, bob);
  assert.deepEqual(ownerAssign.events.map(e => e.type), ['TodoAssigned', 'TodoQueueOrdered', 'TodoStartAsked']);
  const afterOwnerAssign = reduceTodoEvents(approvedState, ownerAssign.events);
  const reopenedAfterOwnerAssign = reduceTodoEvents(afterOwnerAssign, run(afterOwnerAssign, { kind: 'todo_set_state', todo_id: first, base_version: 2, state: 'open' }, bob).events);
  refused(run(reopenedAfterOwnerAssign, { kind: 'todo_start', todo_id: second }, alice, agentA), 'gate_invalid');

  // Gap 1c: Self-claiming an unassigned task whose approval gate is approved preserves gate & gate_set_by, so returning to open + reopening approval re-blocks it.
  const unassignedTask = todo(second, { assignee: null, queue_rank: null, gate: { kind: 'after', todo_id: first }, gate_set_by: bob });
  const approvedUnassigned = state(approvedState.todos[first]!, unassignedTask);
  const claimed = run(approvedUnassigned, { kind: 'todo_start', todo_id: second }, alice, agentA);
  assert.equal(value(claimed).state, 'doing');
  assert.deepEqual(value(claimed).gate, { kind: 'after', todo_id: first });
  assert.equal(value(claimed).gate_set_by, bob);
  const afterClaim = reduceTodoEvents(approvedUnassigned, claimed.events);
  const backToOpen = reduceTodoEvents(afterClaim, run(afterClaim, { kind: 'todo_set_state', todo_id: second, base_version: value(claimed).version, state: 'open' }, alice).events);
  const reopenedAgain = reduceTodoEvents(backToOpen, run(backToOpen, { kind: 'todo_set_state', todo_id: first, base_version: 2, state: 'open' }, bob).events);
  refused(run(reopenedAgain, { kind: 'todo_start', todo_id: second }, alice, agentA), 'gate_invalid');

  // Reducer rejects forged TodoStartAsked under uncleared approval gate.
  const forgedStartAsked: TodoEvent = {
    workspace_id: workspace, stream_id: 'stream', schema_version: 1, seq: unapprovedState.last_seq + 1,
    event_id: uid(900003), command_id: 'forged-start', type: 'TodoStartAsked',
    actor_user: alice, actor_agent_principal: null, actor_run: null, occurred_at_server: now,
    payload: { todo_id: second, principal_id: agentA },
  };
  assert.throws(() => reduceTodoEvents(unapprovedState, [forgedStartAsked]), StreamIntegrityError);
});

test('Condition 3: mandatory base_version on household_todo_answer, offer freeze/replacement, uncleared offer start_now refusal, and own-agent wake fix', () => {
  // Schema validator rejects household_todo_answer omitting base_version (older-client refusal).
  assert.throws(() => validateHouseholdHumanCommand({
    kind: 'household_todo_answer', todo_id: first, offer_id: uid(300000), answer: 'accept',
  }), (error: unknown) => error instanceof HouseholdToolInputError && error.code === 'invalid_arguments');
  assert.deepEqual(validateHouseholdHumanCommand({
    kind: 'household_todo_answer', todo_id: first, offer_id: uid(300000), base_version: 2, answer: 'accept',
  }), { kind: 'household_todo_answer', todo_id: first, offer_id: uid(300000), base_version: 2, answer: 'accept' });

  // Pending offer freezes todo_update (offer_pending_frozen).
  const initial = state(todo(first));
  const offered = run(initial, { kind: 'todo_assign', todo_id: first, base_version: 1, to: { kind: 'user', id: bob } }, alice);
  const offeredState = reduceTodoEvents(initial, offered.events);
  const offerId = value(offered).offer!.offer_id;
  const offerVersion = value(offered).version;
  refused(run(offeredState, { kind: 'todo_update', todo_id: first, base_version: offerVersion, title: 'Bait and switch' }, alice), 'offer_pending_frozen');

  // Reducer rejects forged TodoDetailsChanged while offer is pending.
  const forgedOfferEdit: TodoEvent = {
    workspace_id: workspace, stream_id: 'stream', schema_version: 1, seq: offeredState.last_seq + 1,
    event_id: uid(900004), command_id: 'forged-offer-edit', type: 'TodoDetailsChanged',
    actor_user: alice, actor_agent_principal: null, actor_run: null, occurred_at_server: now,
    payload: { todo: { ...offeredState.todos[first]!, version: offerVersion + 1, title: 'Forged' } },
  };
  assert.throws(() => reduceTodoEvents(offeredState, [forgedOfferEdit]), StreamIntegrityError);

  // Stale base_version on household_todo_answer returns conflict with zero events and zero notices; matching succeeds.
  const commented = reduceTodoEvents(offeredState, run(offeredState, {
    kind: 'todo_comment', target: { kind: 'todo', id: first }, body: 'Extra context',
  }, alice).events);
  const staleAnswer = run(commented, { kind: 'household_todo_answer', todo_id: first, offer_id: offerId, base_version: offerVersion, answer: 'accept' }, bob);
  assert.equal(staleAnswer.outcome.status, 'conflict');
  assert.deepEqual(staleAnswer.events, []);
  assert.deepEqual(staleAnswer.notices, []);
  const freshAnswer = run(commented, { kind: 'household_todo_answer', todo_id: first, offer_id: offerId, base_version: offerVersion + 1, answer: 'accept' }, bob);
  assert.equal(freshAnswer.outcome.status, 'committed');

  // household_todo_steer(gate / start_now) atomically replaces pending offer.
  const assignedWithOffer = state(todo(first, {
    assignee: { kind: 'agent', id: agentA }, queue_rank: 1,
    offer: {
      offer_id: uid(300001), to: { kind: 'user', id: bob }, decider_user_id: bob,
      start: 'queue', gate: { kind: 'none' }, by: { user_id: alice, principal_id: null }, at,
    },
  }));
  const steeredGate = run(assignedWithOffer, {
    kind: 'household_todo_steer', todo_id: first, base_version: 1, action: { kind: 'gate', gate: { kind: 'hold', note: 'Pause' } },
  }, alice);
  assert.deepEqual(steeredGate.events.map(e => e.type), ['TodoOfferAnswered', 'TodoGateSet']);
  assert.equal(steeredGate.events[0]!.type === 'TodoOfferAnswered' && steeredGate.events[0]!.payload.answer, 'replaced');
  assert.equal(value(steeredGate).offer, null);

  const steeredNow = run(assignedWithOffer, {
    kind: 'household_todo_steer', todo_id: first, base_version: 1, action: { kind: 'start_now' },
  }, alice);
  assert.deepEqual(steeredNow.events.map(e => e.type), ['TodoOfferAnswered', 'TodoQueueOrdered', 'TodoStartAsked']);
  assert.equal(value(steeredNow).offer, null);

  // Own-agent wake bug fix on household_todo_answer: alice's own agent offers start:'now' on agentA -> alice declines -> agentA IS woken!
  const ownAgentOffer = run(state(todo(first)), {
    kind: 'todo_assign', todo_id: first, base_version: 1, to: { kind: 'agent', id: agentA }, start: 'now',
  }, alice, agentA);
  const ownOfferState = reduceTodoEvents(state(todo(first)), ownAgentOffer.events);
  const ownOfferDeclined = run(ownOfferState, {
    kind: 'household_todo_answer', todo_id: first,
    offer_id: value(ownAgentOffer).offer!.offer_id, base_version: value(ownAgentOffer).version, answer: 'decline',
  }, alice);
  assert.deepEqual(ownOfferDeclined.notices, [{
    kind: 'note', to: [{ kind: 'agent', id: agentA }],
    about: `todo:${first}`, body: TODO_NOTICE_BODIES.declined,
  }]);

  // Accepting an offer with start:'now' under an uncleared gate is refused with gate_invalid (zero TodoStartAsked, zero notices).
  const unclearedOfferState = state(
    todo(first, { kind: 'approval', assignee: { kind: 'user', id: bob } }),
    todo(second, {
      offer: {
        offer_id: uid(300002), to: { kind: 'agent', id: agentA }, decider_user_id: alice,
        start: 'now', gate: { kind: 'after', todo_id: first }, by: { user_id: bob, principal_id: null }, at,
      },
    }),
  );
  refused(run(unclearedOfferState, {
    kind: 'household_todo_answer', todo_id: second, offer_id: uid(300002), base_version: 1, answer: 'accept',
  }, alice), 'gate_invalid');
});

test('MCP catalog excludes household_todo_decide, todo_create accepts kind, and command store projects full offer.gate and reauthorizes replays', async () => {
  assert.ok((HOUSEHOLD_SURFACE_KINDS as readonly string[]).includes('household_todo_decide'));
  assert.equal(HOUSEHOLD_TOOLS.some(t => (t.name as string) === 'household_todo_decide'), false);
  assert.equal(HOSTED_TODO_LIST_TOOLS.some(t => (t.name as string) === 'household_todo_decide'), false);

  // todo_create tool schema accepts kind:'approval' and maps it cleanly to todo_kind without clobbering command.kind.
  const seat = 'seat_0000000000000000000000';
  const args = validateHouseholdToolArguments('todo_create', {
    seat, request_id: 'request_001', title: 'Approve spend', kind: 'approval',
    assign: { to: { kind: 'user', id: alice } },
  });
  assert.equal(args.kind, 'approval');
  const inv = householdToolInvocation('todo_create', args, { workspace_id: workspace });
  assert.ok('command' in inv && inv.command.kind === 'todo_create' && inv.command.todo_kind === 'approval');

  // todos.write re-runs authorize AFTER acquiring stream lock and BEFORE returning stored receipt on replay.
  let authCalls = 0;
  let revokeOnReplay = false;
  const receipts = new Map<string, { request_digest: string; outcome: unknown }>();
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('INSERT INTO swarm.household_todo_streams')) return [];
    if (sql.includes('SELECT stream_id,last_seq')) return [{ stream_id: uid(800), last_seq: 0 }];
    if (sql.includes('SELECT * FROM swarm.household_todos')) return [];
    if (sql.includes('SELECT principal_id,accepts_from')) return [];
    if (sql.includes('SELECT request_digest,outcome FROM swarm.household_todo_receipts')) {
      const cmdId = String(values.at(-1));
      const row = receipts.get(cmdId);
      return row ? [row] : [];
    }
    if (sql.includes('INSERT INTO swarm.household_object_audit')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  }) as unknown as Parameters<ReturnType<typeof createHouseholdTodoStore>['write']>[0];
  (tx as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  const store = createHouseholdTodoStore({
    core: { ...todosCore, ...todoPolicy, ...accessPolicy },
    access: async () => {
      authCalls++;
      if (revokeOnReplay && authCalls >= 2) {
        return {
          now,
          facts: {
            ...access(alice),
            member: { user_id: alice, workspace_id: workspace, revoked_at: now, content_role: 'reader', content_consent_id: 'consent' },
          },
        };
      }
      return { now, facts: access(alice) };
    },
    notice: async () => { throw new Error('Replay must never invoke notice'); },
  });

  // Pre-seed a stored receipt for req-replay-1; actor passes initial pre-lock check, then loses access before post-lock replay check.
  receipts.set('req-replay-1', {
    request_digest: '0'.repeat(64),
    outcome: { outcome: { status: 'committed', value: todo(first) }, notices: [] },
  });
  revokeOnReplay = true;
  const replayDenied = await store.write(
    tx, workspace, { user_id: alice, principal_id: null, run_id: null, connection: null }, 'req-replay-1',
    { kind: 'household_todo_decide', todo_id: first, base_version: 1, decision: 'approve' },
  );
  assert.equal(authCalls, 2, 'authorize ran both before stream lock and after stream lock before releasing stored receipt');
  assert.equal(replayDenied.replayed, false);
  assert.equal(replayDenied.outcome.status, 'refused');
});
