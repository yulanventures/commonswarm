// Pure consumer to-do core. The adapter supplies locked, authenticated facts,
// server IDs and time; it commits events, receipts, audit and notices together.
// Titles, notes and comments are untrusted data, never agent instructions.
import { SCHEMA_VERSION, type EventEnvelope } from './events.js';
import { StreamIntegrityError, UnknownEventTypeError } from './reducer.js';
import {
  householdAccessRefusal, householdWriteLimitReached,
  type HouseholdAccessFacts, type HouseholdAccessRefusal,
} from './household-object-policy.js';
import {
  TODO_QUEUE_LIMIT, TODO_OPEN_LIMIT, TODO_TITLE_LIMIT, TODO_NOTES_LIMIT,
  TODO_COMMENT_LIMIT, TODO_MENTIONS_LIMIT, TODO_GATE_NOTE_LIMIT, TODO_EVENT_BYTE_LIMIT,
  TODO_DEFAULT_ACCEPTS_FROM, TODO_NOTICE_BODIES, todoNoticeAbout, OBJECT_NOTICE_ABOUT_PREFIX,
} from './household-todo-policy.js';

export type Party = { kind: 'user'; id: string } | { kind: 'agent'; id: string };
export interface TodoActor { user_id: string; principal_id: string | null }
export type TodoState = 'open' | 'doing' | 'done' | 'dropped';
export type TodoStart = 'queue' | 'now';
export type TodoGate = { kind: 'none' } | { kind: 'hold'; note: string | null }
  | { kind: 'after'; todo_id: string } | { kind: 'at'; at: string };
export interface TodoOffer {
  offer_id: string; to: Party; decider_user_id: string; start: TodoStart;
  gate: TodoGate; by: TodoActor; at: string;
}
/** Stored fields only. gate_clear and queue_position are derived on read. */
export interface Todo {
  workspace_id: string; todo_id: string; version: number;
  title: string; notes: string; state: TodoState; due_on: string | null;
  created_by: TodoActor; created_at: string;
  assignee: Party | null; assigned_by: TodoActor | null; assigned_at: string | null;
  offer: TodoOffer | null; gate: TodoGate; gate_set_by: string | null;
  queue_rank: number | null; state_by: TodoActor; state_at: string; comment_count: number;
}
export type CommentTarget = { kind: 'todo'; id: string } | { kind: 'list' | 'doc' | 'file'; id: string };
export interface TodoComment {
  comment_id: string; target: CommentTarget; author: TodoActor;
  body: string; mentions: readonly Party[]; created_at: string;
}
export interface AgentWorkPolicy { principal_id: string; accepts_from: 'owner' | 'anyone'; set_by_user: string; set_at: string }
export type TodoRefusal = HouseholdAccessRefusal | 'human_confirmation_required' | 'principal_required'
  | 'todo_not_found' | 'target_not_found' | 'title_invalid' | 'notes_invalid' | 'due_invalid'
  | 'comment_invalid' | 'mentions_invalid' | 'assignee_not_member' | 'assignee_removed'
  | 'invalid_transition' | 'not_assignee' | 'not_permitted' | 'owner_only'
  | 'offer_not_pending' | 'not_decider' | 'not_in_queue' | 'gate_invalid' | 'gate_cycle'
  | 'queue_empty' | 'queue_full' | 'todo_limit_reached' | 'request_id_reused' | 'todo_write_rate_limited'
  | 'invalid_command_context';
export type TodoOutcome = { status: 'committed'; value: Todo | TodoComment | AgentWorkPolicy }
  | { status: 'conflict'; current: Todo } | { status: 'refused'; reason: TodoRefusal };
export interface TodoReceipt { principal: string; command_id: string; request_digest: string; outcome: TodoOutcome }
/** An intent, not a delivery claim. The adapter returns sent/not_sent receipts. */
export interface TodoNotice { kind: 'ask' | 'note'; to: readonly Party[]; about: string; body: string }

export const TODO_EVENT_TYPES = [
  'TodoCreated', 'TodoDetailsChanged', 'TodoAssigned', 'TodoOffered', 'TodoOfferAnswered',
  'TodoStateChanged', 'TodoQueueOrdered', 'TodoGateSet', 'TodoStartAsked', 'TodoCommented', 'AgentWorkPolicySet',
] as const;
export type TodoEventType = typeof TODO_EVENT_TYPES[number];
type TodoPayloads = {
  TodoCreated: { todo: Todo };
  TodoDetailsChanged: { todo: Todo };
  TodoAssigned: { todo: Todo };
  TodoOffered: { todo: Todo };
  TodoOfferAnswered: { todo: Todo; offer_id: string; answer: 'accept' | 'decline' | 'withdraw' | 'replaced' };
  TodoStateChanged: { todo: Todo };
  TodoQueueOrdered: { principal_id: string; todo_ids: readonly string[] };
  TodoGateSet: { todo: Todo };
  TodoStartAsked: { todo_id: string; principal_id: string };
  TodoCommented: { comment: TodoComment; todo: Todo | null };
  AgentWorkPolicySet: { policy: AgentWorkPolicy };
};
export type TodoEvent = { [K in TodoEventType]: EventEnvelope<TodoPayloads[K] & { receipt?: TodoReceipt }, K> }[TodoEventType];
export interface HouseholdTodoState {
  workspace_id: string; stream_id: string; last_seq: number;
  todos: Readonly<Record<string, Todo>>;
  comments: Readonly<Record<string, TodoComment>>;
  policies: Readonly<Record<string, AgentWorkPolicy>>;
  receipts: Readonly<Record<string, TodoReceipt>>;
}
export interface AssignInput { to: Party; start?: TodoStart; gate?: TodoGate }
export type SteerAction = { kind: 'move'; after_todo_id: string | null } | { kind: 'start_now' }
  | { kind: 'gate'; gate: TodoGate };
export type TodoCommand =
  | { kind: 'todo_create'; title: string; notes?: string; due_on?: string | null; assign?: AssignInput }
  | { kind: 'todo_update'; todo_id: string; base_version: number; title?: string; notes?: string; due_on?: string | null }
  | { kind: 'todo_assign'; todo_id: string; base_version: number; to: Party | null; start?: TodoStart; gate?: TodoGate }
  | { kind: 'todo_start'; todo_id?: string }
  | { kind: 'todo_set_state'; todo_id: string; base_version: number; state: TodoState }
  | { kind: 'household_todo_answer'; todo_id: string; offer_id: string; answer: 'accept' | 'decline' | 'withdraw' }
  | { kind: 'household_todo_steer'; todo_id: string; base_version: number; action: SteerAction }
  | { kind: 'household_agent_work_policy'; principal_id: string; accepts_from: 'owner' | 'anyone' }
  | { kind: 'todo_comment'; target: CommentTarget; body: string; mentions?: readonly Party[] };
export interface TodoMemberFacts { user_id: string; workspace_id: string; revoked_at: number | null; role: 'owner' | 'admin' | 'member' }
export interface TodoAgentFacts { principal_id: string; owner_user_id: string; workspace_id: string; revoked_at: number | null }
export interface DecideTodoContext {
  access: HouseholdAccessFacts; now: number; command_id: string; request_digest: string;
  seq: number;
  /** One distinct server-generated UUID per emitted event, in order. */
  event_ids: readonly string[];
  todo_id?: string; offer_id?: string; comment_id?: string;
  members: readonly TodoMemberFacts[]; agents: readonly TodoAgentFacts[];
  /** Current committed object identities for comment targets, not drafts. */
  objects: readonly { kind: 'list' | 'doc' | 'file'; id: string }[];
  identity_write_attempts: number; workspace_write_attempts: number;
}
export interface TodoDecision { outcome: TodoOutcome; events: readonly TodoEvent[]; receipt: TodoReceipt | null; notices: readonly TodoNotice[]; replayed: boolean }
const encoder = new TextEncoder();
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const receiptKey = (principal: string, commandId: string): string => JSON.stringify([principal, commandId]);
const isOpen = (todo: Todo): boolean => todo.state === 'open' || todo.state === 'doing';
const sameParty = (a: Party | null, b: Party | null): boolean => a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id;
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}
const textLength = (text: string): number => Array.from(text).length;
const validTitle = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0
  && textLength(text) <= TODO_TITLE_LIMIT && !/[\u0000-\u001f\u007f-\u009f]/u.test(text);
const hasInvalidControls = (text: string): boolean => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);
const validNotes = (text: unknown): text is string => typeof text === 'string' && textLength(text) <= TODO_NOTES_LIMIT && !hasInvalidControls(text);
function validDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validGate(gate: TodoGate): boolean {
  if (!gate || typeof gate !== 'object') return false;
  switch (gate.kind) {
    case 'none': return true;
    case 'hold': return gate.note === null || typeof gate.note === 'string' && textLength(gate.note) <= TODO_GATE_NOTE_LIMIT && !hasInvalidControls(gate.note);
    case 'after': return uuid(gate.todo_id);
    case 'at': return typeof gate.at === 'string'
      && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(gate.at)
      && validDate(gate.at.slice(0, 10)) && Number.isFinite(Date.parse(gate.at));
    default: return false;
  }
}
function gateCycles(todoId: string, gate: TodoGate, todos: Readonly<Record<string, Todo>>): boolean {
  const seen = new Set([todoId]);
  let next = gate;
  while (next.kind === 'after') {
    if (seen.has(next.todo_id)) return true;
    seen.add(next.todo_id);
    const todo = own(todos, next.todo_id);
    if (!todo) return false;
    next = todo.gate;
  }
  return false;
}
/** No scheduler: time/dependency gates are evaluated against the read clock.
 * Even a corrupt cyclic projection fails closed. Missing dependencies stay held. */
export function evaluateGate(gate: TodoGate, todos: Readonly<Record<string, Todo>>, now: number): boolean {
  if (!Number.isFinite(now) || !validGate(gate)) return false;
  if (gate.kind === 'none') return true;
  if (gate.kind === 'hold') return false;
  if (gate.kind === 'at') return Date.parse(gate.at) <= now;
  if (gateCycles('', gate, todos)) return false;
  const dependency = own(todos, gate.todo_id);
  return !!dependency && (dependency.state === 'done' || dependency.state === 'dropped');
}
export function emptyHouseholdTodoState(workspaceId: string, streamId: string): HouseholdTodoState {
  if (!id(workspaceId) || !id(streamId)) throw new RangeError('workspace and stream IDs are required');
  return { workspace_id: workspaceId, stream_id: streamId, last_seq: -1, todos: {}, comments: {}, policies: {}, receipts: {} };
}
function queue(state: HouseholdTodoState, principalId: string): Todo[] {
  return Object.values(state.todos).filter(todo => isOpen(todo) && todo.assignee?.kind === 'agent'
    && todo.assignee.id === principalId && todo.queue_rank !== null)
    .sort((a, b) => a.queue_rank! - b.queue_rank! || (a.todo_id < b.todo_id ? -1 : a.todo_id > b.todo_id ? 1 : 0));
}

export function decideTodo(state: HouseholdTodoState, command: TodoCommand, ctx: DecideTodoContext): TodoDecision {
  const bare = (outcome: TodoOutcome): TodoDecision => ({ outcome, events: [], receipt: null, notices: [], replayed: false });
  const operation = command.kind === 'todo_create' || command.kind === 'todo_comment' ? 'create' : 'update';
  const denied = householdAccessRefusal(ctx.access, state.workspace_id, operation, ctx.now);
  if (denied) return bare({ status: 'refused', reason: denied });
  if (!id(ctx.command_id) || !/^[a-f0-9]{64}$/.test(ctx.request_digest)
    || !Number.isSafeInteger(ctx.seq) || ctx.seq <= state.last_seq) return bare({ status: 'refused', reason: 'invalid_command_context' });
  const actor: TodoActor = { user_id: ctx.access.actor.user_id, principal_id: ctx.access.actor.principal_id };
  const principal = actor.principal_id ?? actor.user_id;
  const previous = own(state.receipts, receiptKey(principal, ctx.command_id));
  if (previous) return previous.request_digest === ctx.request_digest
    ? { ...bare(structuredClone(previous.outcome)), replayed: true }
    : bare({ status: 'refused', reason: 'request_id_reused' });
  const events: TodoEvent[] = [];
  const notices: TodoNotice[] = [];
  let draft = state;
  const timestamp = new Date(ctx.now).toISOString();
  const finish = (outcome: TodoOutcome): TodoDecision => {
    const receipt: TodoReceipt = { principal, command_id: ctx.command_id, request_digest: ctx.request_digest, outcome: structuredClone(outcome) };
    if (outcome.status !== 'committed') return { outcome, receipt, events: [], notices: [], replayed: false };
    const last = events.at(-1);
    if (last) last.payload.receipt = receipt;
    if (events.some(event => encoder.encode(JSON.stringify(event)).length > TODO_EVENT_BYTE_LIMIT)) {
      // This is an adapter/envelope defect, not a new public refusal code.
      throw new RangeError('to-do event exceeds 64 KiB');
    }
    return { outcome: structuredClone(outcome), receipt, events, notices: structuredClone(notices), replayed: false };
  };
  const refuse = (reason: TodoRefusal): TodoDecision => finish({ status: 'refused', reason });
  const emit = <K extends TodoEventType>(type: K, payload: TodoPayloads[K]): void => {
    const eventId = ctx.event_ids[events.length];
    if (!uuid(eventId) || events.some(event => event.event_id === eventId)) throw new RangeError('distinct server event IDs are required');
    const event = { workspace_id: state.workspace_id, stream_id: state.stream_id, schema_version: SCHEMA_VERSION,
      seq: ctx.seq + events.length, event_id: eventId, command_id: ctx.command_id, type,
      actor_user: actor.user_id, actor_agent_principal: actor.principal_id, actor_run: ctx.access.actor.run_id,
      occurred_at_server: ctx.now, payload: structuredClone(payload) } as TodoEvent;
    // Replay the command together so acceptance retains the answered offer's provenance.
    draft = reduceTodoEvents(state, [...events, event]);
    events.push(event);
  };
  const member = (userId: string): TodoMemberFacts | undefined => ctx.members.find(m => m.user_id === userId && m.workspace_id === state.workspace_id && m.revoked_at === null);
  const agent = (principalId: string): TodoAgentFacts | undefined => ctx.agents.find(a => a.principal_id === principalId && a.workspace_id === state.workspace_id);
  const admin = (): boolean => ['owner', 'admin'].includes(member(actor.user_id)?.role ?? '');
  const human = actor.principal_id === null && ctx.access.credential.kind === 'human';
  const actorParty: Party = actor.principal_id === null ? { kind: 'user', id: actor.user_id } : { kind: 'agent', id: actor.principal_id };
  const targetRefusal = (party: Party): TodoRefusal | null => {
    if (!party || !id(party.id) || !['user', 'agent'].includes(party.kind)) return 'assignee_not_member';
    if (party.kind === 'user') return member(party.id) ? null : 'assignee_not_member';
    const fact = agent(party.id);
    if (!fact || !member(fact.owner_user_id)) return 'assignee_not_member';
    return fact.revoked_at !== null ? 'assignee_removed' : null;
  };
  const gateRefusal = (todoId: string, gate: TodoGate): TodoRefusal | null => {
    if (!validGate(gate) || (gate.kind === 'after' && !own(draft.todos, gate.todo_id))) return 'gate_invalid';
    return gateCycles(todoId, gate, draft.todos) ? 'gate_cycle' : null;
  };
  const queueFull = (todo: Todo, party: Party): boolean => party.kind === 'agent'
    && queue(draft, party.id).filter(t => t.todo_id !== todo.todo_id).length >= TODO_QUEUE_LIMIT;
  const order = (principalId: string, todoId: string, afterId: string | null): TodoRefusal | null => {
    const items = queue(draft, principalId).map(t => t.todo_id).filter(i => i !== todoId);
    const index = afterId === null ? -1 : items.indexOf(afterId);
    if (afterId !== null && index === -1) return 'not_in_queue';
    items.splice(index + 1, 0, todoId);
    emit('TodoQueueOrdered', { principal_id: principalId, todo_ids: items });
    return null;
  };
  const notice = (todoId: string, kind: 'ask' | 'note', to: Party, body: string): void => { notices.push({ kind, to: [to], about: todoNoticeAbout(todoId), body }); };
  const assigned = (todo: Todo, input: AssignInput): TodoDecision | null => {
    const failure = targetRefusal(input.to);
    if (failure) return refuse(failure);
    const start = input.start ?? 'queue';
    const owner = input.to.kind === 'agent' ? agent(input.to.id)!.owner_user_id : input.to.id;
    const ownerStartNow = input.to.kind === 'agent' && start === 'now' && human && owner === actor.user_id;
    const gate = input.gate ?? (ownerStartNow ? { kind: 'none' } : todo.gate);
    if (start !== 'queue' && start !== 'now') return refuse('invalid_transition');
    const gateError = gateRefusal(todo.todo_id, gate);
    if (gateError) return refuse(gateError);
    const accepted = input.to.kind === 'user' ? input.to.id === actor.user_id
      : start === 'now' ? human && owner === actor.user_id
        : owner === actor.user_id || (own(draft.policies, input.to.id)?.accepts_from ?? TODO_DEFAULT_ACCEPTS_FROM) === 'anyone';
    if (accepted && queueFull(todo, input.to)) return refuse('queue_full');
    if (todo.offer) {
      emit('TodoOfferAnswered', { todo: { ...todo, version: todo.version + 1, offer: null }, offer_id: todo.offer.offer_id, answer: 'replaced' });
      todo = own(draft.todos, todo.todo_id)!;
    }
    if (!accepted) {
      if (!uuid(ctx.offer_id)) throw new RangeError('server offer ID is required');
      if (todo.state === 'doing') {
        emit('TodoStateChanged', { todo: { ...todo, version: todo.version + 1, state: 'open', state_by: actor, state_at: timestamp } });
        todo = own(draft.todos, todo.todo_id)!;
      }
      const offer: TodoOffer = { offer_id: ctx.offer_id, to: input.to, decider_user_id: owner, start, gate, by: actor, at: timestamp };
      emit('TodoOffered', { todo: { ...todo, version: todo.version + 1, offer } });
      notice(todo.todo_id, 'ask', { kind: 'user', id: owner }, input.to.kind === 'user' ? TODO_NOTICE_BODIES.person_offer : TODO_NOTICE_BODIES.agent_offer);
      return null;
    }
    accept(todo, input.to, start, gate, gate.kind === 'none' ? null : input.gate === undefined ? todo.gate_set_by : actor.user_id);
    if (input.to.kind === 'agent') {
      if (start === 'now') notice(todo.todo_id, 'ask', input.to, TODO_NOTICE_BODIES.start);
      else if (evaluateGate(gate, draft.todos, ctx.now)) notice(todo.todo_id, 'note', input.to, TODO_NOTICE_BODIES.added);
    }
    return null;
  };
  const accept = (todo: Todo, to: Party | null, start: TodoStart, gate: TodoGate,
    gateSetBy: string | null = gate.kind === 'none' ? null : actor.user_id): void => {
    const rank = to?.kind === 'agent' ? Math.max(0, ...queue(draft, to.id).filter(t => t.todo_id !== todo.todo_id).map(t => t.queue_rank!)) + 1 : null;
    emit('TodoAssigned', { todo: { ...todo, version: todo.version + 1, assignee: to,
      assigned_by: actor, assigned_at: timestamp, state: 'open', state_by: actor, state_at: timestamp,
      gate, gate_set_by: gateSetBy, queue_rank: rank, offer: null } });
    if (to?.kind === 'agent' && start === 'now') {
      order(to.id, todo.todo_id, null);
      emit('TodoStartAsked', { todo_id: todo.todo_id, principal_id: to.id });
    }
  };
  if (householdWriteLimitReached(ctx.identity_write_attempts, ctx.workspace_write_attempts)) return refuse('todo_write_rate_limited');
  if (command.kind.startsWith('household_') && !human) return refuse('human_confirmation_required');
  if (command.kind === 'household_agent_work_policy') {
    const fact = agent(command.principal_id);
    if (!fact || !member(fact.owner_user_id)) return refuse('assignee_not_member');
    if (fact.revoked_at !== null) return refuse('assignee_removed');
    if (fact.owner_user_id !== actor.user_id) return refuse('owner_only');
    if (!['owner', 'anyone'].includes(command.accepts_from)) return refuse('not_permitted');
    const policy: AgentWorkPolicy = { principal_id: fact.principal_id, accepts_from: command.accepts_from, set_by_user: actor.user_id, set_at: timestamp };
    emit('AgentWorkPolicySet', { policy });
    return finish({ status: 'committed', value: policy });
  }
  if (command.kind === 'todo_comment') {
    const target = command.target;
    if (!target || !id(target.id) || textLength(target.id) > 255 || !['todo', 'list', 'doc', 'file'].includes(target.kind)
      || (target.kind === 'todo' ? !own(state.todos, target.id) : !ctx.objects.some(o => o.kind === target.kind && o.id === target.id))) return refuse('target_not_found');
    if (typeof command.body !== 'string' || !command.body.trim() || textLength(command.body) > TODO_COMMENT_LIMIT || hasInvalidControls(command.body)) return refuse('comment_invalid');
    const mentions = command.mentions ?? [];
    if (!Array.isArray(mentions) || mentions.length > TODO_MENTIONS_LIMIT || mentions.some(p => targetRefusal(p) !== null)
      || new Set(mentions.map(p => `${p.kind}:${p.id}`)).size !== mentions.length) return refuse('mentions_invalid');
    if (!uuid(ctx.comment_id) || own(state.comments, ctx.comment_id)) throw new RangeError('new server comment ID is required');
    const comment: TodoComment = { comment_id: ctx.comment_id, target, author: actor, body: command.body, mentions, created_at: timestamp };
    const todo = target.kind === 'todo' ? own(state.todos, target.id)! : null;
    emit('TodoCommented', { comment, todo: todo ? { ...todo, version: todo.version + 1, comment_count: todo.comment_count + 1 } : null });
    if (mentions.length) notices.push({ kind: 'note', to: mentions, about: target.kind === 'todo' ? todoNoticeAbout(target.id) : `${OBJECT_NOTICE_ABOUT_PREFIX}${target.id}`, body: TODO_NOTICE_BODIES.mentioned });
    return finish({ status: 'committed', value: comment });
  }
  if (command.kind === 'todo_create') {
    if (!validTitle(command.title)) return refuse('title_invalid');
    if (!validNotes(command.notes ?? '')) return refuse('notes_invalid');
    if (!validDate(command.due_on ?? null)) return refuse('due_invalid');
    if (Object.values(state.todos).filter(isOpen).length >= TODO_OPEN_LIMIT) return refuse('todo_limit_reached');
    if (!uuid(ctx.todo_id) || own(state.todos, ctx.todo_id)) throw new RangeError('new server to-do ID is required');
    const todo: Todo = { workspace_id: state.workspace_id, todo_id: ctx.todo_id, version: 1,
      title: command.title, notes: command.notes ?? '', due_on: command.due_on ?? null, state: 'open',
      created_by: actor, created_at: timestamp, assignee: null, assigned_by: null, assigned_at: null,
      offer: null, gate: { kind: 'none' }, gate_set_by: null, queue_rank: null, state_by: actor, state_at: timestamp, comment_count: 0 };
    emit('TodoCreated', { todo });
    if (command.assign) {
      const failure = assigned(todo, command.assign);
      if (failure) return failure;
    }
    return finish({ status: 'committed', value: own(draft.todos, todo.todo_id)! });
  }
  let todoId = command.todo_id;
  if (command.kind === 'todo_start' && todoId === undefined) {
    if (actor.principal_id === null) return refuse('queue_empty');
    todoId = queue(state, actor.principal_id).find(t => t.state === 'open' && evaluateGate(t.gate, state.todos, ctx.now))?.todo_id;
    if (!todoId) return refuse('queue_empty');
  }
  let todo = todoId ? own(state.todos, todoId) : undefined;
  if (!todo) return refuse('todo_not_found');
  if ('base_version' in command && command.base_version !== todo.version) return finish({ status: 'conflict', current: structuredClone(todo) });
  if (command.kind === 'todo_update') {
    if (command.title !== undefined && !validTitle(command.title)) return refuse('title_invalid');
    if (command.notes !== undefined && !validNotes(command.notes)) return refuse('notes_invalid');
    if (command.due_on !== undefined && !validDate(command.due_on)) return refuse('due_invalid');
    if ((command.title === undefined || command.title === todo.title) && (command.notes === undefined || command.notes === todo.notes)
      && (command.due_on === undefined || command.due_on === todo.due_on)) return finish({ status: 'committed', value: todo });
    emit('TodoDetailsChanged', { todo: { ...todo, version: todo.version + 1,
      title: command.title ?? todo.title, notes: command.notes ?? todo.notes, due_on: command.due_on === undefined ? todo.due_on : command.due_on } });
  } else if (command.kind === 'todo_assign') {
    if (!isOpen(todo)) return refuse('invalid_transition');
    if (command.to === null) {
      const gate = command.gate ?? todo.gate;
      const gateError = gateRefusal(todo.todo_id, gate);
      if (gateError) return refuse(gateError);
      if (todo.offer) {
        emit('TodoOfferAnswered', { todo: { ...todo, version: todo.version + 1, offer: null }, offer_id: todo.offer.offer_id, answer: 'replaced' });
        todo = own(draft.todos, todo.todo_id)!;
      }
      accept(todo, null, 'queue', gate, command.gate === undefined ? todo.gate_set_by : gate.kind === 'none' ? null : actor.user_id);
    } else {
      const failure = assigned(todo, { to: command.to, start: command.start, gate: command.gate });
      if (failure) return failure;
    }
  } else if (command.kind === 'household_todo_answer') {
    const offer = todo.offer;
    if (!offer || offer.offer_id !== command.offer_id) return refuse('offer_not_pending');
    if (!['accept', 'decline', 'withdraw'].includes(command.answer)) return refuse('invalid_transition');
    if (command.answer === 'withdraw' ? actor.user_id !== offer.by.user_id && !admin() : actor.user_id !== offer.decider_user_id) return refuse('not_decider');
    if (command.answer === 'accept') {
      if (!isOpen(todo)) return refuse('invalid_transition');
      const targetError = targetRefusal(offer.to);
      if (targetError) return refuse(targetError);
      const gateError = gateRefusal(todo.todo_id, offer.gate);
      if (gateError) return refuse(gateError);
      if (queueFull(todo, offer.to)) return refuse('queue_full');
    }
    emit('TodoOfferAnswered', { todo: { ...todo, version: todo.version + 1, offer: null }, offer_id: offer.offer_id, answer: command.answer });
    if (command.answer === 'accept') accept(own(draft.todos, todo.todo_id)!, offer.to, offer.start, offer.gate,
      offer.gate.kind === 'none' ? null : offer.by.user_id);
    // The one-signal cap conflicts with notifying both sides on acceptance.
    // A ready agent gets the queue/start notice; otherwise notify the offerer.
    if (command.answer === 'accept' && offer.to.kind === 'agent'
      && (offer.start === 'now' || evaluateGate(offer.gate, draft.todos, ctx.now))) {
      if (offer.start === 'now') notice(todo.todo_id, 'ask', offer.to, TODO_NOTICE_BODIES.start);
      else notice(todo.todo_id, 'note', offer.to, TODO_NOTICE_BODIES.added);
    } else if (command.answer !== 'withdraw' && offer.by.user_id !== offer.decider_user_id) {
      notice(todo.todo_id, 'note', offer.by.principal_id ? { kind: 'agent', id: offer.by.principal_id } : { kind: 'user', id: offer.by.user_id }, command.answer === 'accept' ? TODO_NOTICE_BODIES.accepted : TODO_NOTICE_BODIES.declined);
    }
  } else if (command.kind === 'household_todo_steer') {
    const action = command.action;
    if (!todo.assignee || todo.assignee.kind !== 'agent' || !isOpen(todo) || todo.queue_rank === null) return refuse('not_in_queue');
    const fact = agent(todo.assignee.id);
    // Binding ruling R7 supersedes C's original-gate-setter exception.
    if (!fact || fact.owner_user_id !== actor.user_id) return refuse('owner_only');
    if (fact.revoked_at !== null) return refuse('assignee_removed');
    if (action.kind === 'move') {
      const failure = order(todo.assignee.id, todo.todo_id, action.after_todo_id);
      if (failure) return refuse(failure);
    } else if (action.kind === 'start_now') {
      if (todo.gate.kind !== 'none') {
        emit('TodoGateSet', { todo: { ...todo, version: todo.version + 1, gate: { kind: 'none' }, gate_set_by: null } });
      }
      order(todo.assignee.id, todo.todo_id, null);
      emit('TodoStartAsked', { todo_id: todo.todo_id, principal_id: todo.assignee.id });
      notice(todo.todo_id, 'ask', todo.assignee, TODO_NOTICE_BODIES.start);
    } else if (action.kind === 'gate') {
      const failure = gateRefusal(todo.todo_id, action.gate);
      if (failure) return refuse(failure);
      emit('TodoGateSet', { todo: { ...todo, version: todo.version + 1, gate: action.gate, gate_set_by: action.gate.kind === 'none' ? null : actor.user_id } });
    } else return refuse('not_permitted');
  } else if (command.kind === 'todo_start' || command.kind === 'todo_set_state') {
    const next = command.kind === 'todo_start' ? 'doing' : command.state;
    const allowed = todo.state === 'open' ? ['doing', 'done', 'dropped']
      : todo.state === 'doing' ? ['open', 'done', 'dropped'] : ['open'];
    if (!allowed.includes(next)) return refuse('invalid_transition');
    if (next === 'doing') {
      if (todo.assignee !== null && !sameParty(todo.assignee, actorParty)) return refuse('not_assignee');
      if (!evaluateGate(todo.gate, state.todos, ctx.now)) return refuse('gate_invalid');
      if (todo.assignee === null) {
        const targetError = targetRefusal(actorParty);
        if (targetError) return refuse(targetError);
        if (queueFull(todo, actorParty)) return refuse('queue_full');
        if (todo.offer) {
          emit('TodoOfferAnswered', { todo: { ...todo, version: todo.version + 1, offer: null }, offer_id: todo.offer.offer_id, answer: 'replaced' });
          todo = own(draft.todos, todo.todo_id)!;
        }
        accept(todo, actorParty, 'queue', { kind: 'none' });
        todo = own(draft.todos, todo.todo_id)!;
      }
    } else {
      const assigneeSide = sameParty(todo.assignee, actorParty) || todo.assignee?.kind === 'agent' && agent(todo.assignee.id)?.owner_user_id === actor.user_id;
      if (todo.assignee !== null && !assigneeSide && todo.created_by.user_id !== actor.user_id && !admin()) return refuse('not_permitted');
      if (!isOpen(todo) && next === 'open') {
        if (Object.values(state.todos).filter(isOpen).length >= TODO_OPEN_LIMIT) return refuse('todo_limit_reached');
        if (todo.assignee && queueFull(todo, todo.assignee)) return refuse('queue_full');
      }
    }
    const rank = !isOpen(todo) && next === 'open' && todo.assignee?.kind === 'agent'
      ? Math.max(0, ...queue(draft, todo.assignee.id).map(t => t.queue_rank!)) + 1 : todo.queue_rank;
    emit('TodoStateChanged', { todo: { ...todo, version: todo.version + 1, state: next, state_by: actor, state_at: timestamp,
      queue_rank: next === 'done' || next === 'dropped' ? null : rank } });
  } else return refuse('not_permitted');
  return finish({ status: 'committed', value: own(draft.todos, todo.todo_id)! });
}

/** Refused/conflicting/no-op commands have no event. The adapter must load their
 * durable receipts into state.receipts as well as the receipts replayed here. */
export function reduceTodoEvents(initial: HouseholdTodoState, events: readonly TodoEvent[]): HouseholdTodoState {
  let state = initial;
  let acceptedOffer: { todo_id: string; command_id: string; offer: TodoOffer } | null = null;
  for (const event of events) {
    if (!(TODO_EVENT_TYPES as readonly string[]).includes(event.type)) throw new UnknownEventTypeError(event.type, event.seq);
    const fail = (reason: string): never => { throw new StreamIntegrityError(`to-do event at seq ${event.seq}: ${reason}`); };
    if (event.schema_version !== SCHEMA_VERSION || event.workspace_id !== state.workspace_id || event.stream_id !== state.stream_id
      || !Number.isSafeInteger(event.seq) || event.seq <= state.last_seq || !Number.isFinite(event.occurred_at_server)
      || !uuid(event.event_id) || !id(event.command_id) || !id(event.actor_user)
      || encoder.encode(JSON.stringify(event)).length > TODO_EVENT_BYTE_LIMIT || !event.payload) fail('invalid envelope');
    const todos = { ...state.todos }, comments = { ...state.comments }, policies = { ...state.policies }, receipts = { ...state.receipts };
    const applyTodo = (todo: Todo, create = false): void => {
      const current = own(todos, todo?.todo_id);
      if (!todo || !uuid(todo.todo_id) || todo.workspace_id !== state.workspace_id || !validTitle(todo.title)
        || !validNotes(todo.notes) || !validDate(todo.due_on) || !['open', 'doing', 'done', 'dropped'].includes(todo.state)
        || !validGate(todo.gate) || !Number.isSafeInteger(todo.version) || todo.version !== (create ? 1 : (current?.version ?? -1) + 1)
        || (create ? !!current : !current) || !Number.isSafeInteger(todo.comment_count) || todo.comment_count < 0
        || (todo.queue_rank !== null && (todo.assignee?.kind !== 'agent' || !isOpen(todo) || !Number.isSafeInteger(todo.queue_rank) || todo.queue_rank < 1))) fail('invalid to-do projection');
      const validActor = (actor: TodoActor): boolean => !!actor && id(actor.user_id) && (actor.principal_id === null || id(actor.principal_id));
      const validParty = (party: Party | null): boolean => party === null || !!party && ['user', 'agent'].includes(party.kind) && id(party.id);
      const author: TodoActor = { user_id: event.actor_user!, principal_id: event.actor_agent_principal };
      const at = new Date(event.occurred_at_server).toISOString();
      if (!validActor(todo.created_by) || !validActor(todo.state_by) || !validParty(todo.assignee)
        || !Number.isFinite(Date.parse(todo.created_at)) || !Number.isFinite(Date.parse(todo.state_at))
        || (todo.assignee?.kind === 'agent' && isOpen(todo) && todo.queue_rank === null)
        || gateCycles(todo.todo_id, todo.gate, todos) || todo.gate.kind === 'after' && !own(todos, todo.gate.todo_id)) fail('invalid to-do fields');
      if (todo.offer && (!uuid(todo.offer.offer_id) || !validParty(todo.offer.to) || !id(todo.offer.decider_user_id)
        || !['queue', 'now'].includes(todo.offer.start) || !validGate(todo.offer.gate) || !validActor(todo.offer.by)
        || !Number.isFinite(Date.parse(todo.offer.at)))) fail('invalid offer');
      if (create) {
        if (!equal(todo.created_by, author) || !equal(todo.state_by, author) || todo.created_at !== at || todo.state_at !== at
          || todo.state !== 'open' || todo.assignee !== null || todo.assigned_by !== null || todo.assigned_at !== null
          || todo.offer !== null || todo.gate.kind !== 'none' || todo.gate_set_by !== null || todo.queue_rank !== null || todo.comment_count !== 0) fail('invalid create');
      } else {
        // Snapshots make events reducer-complete, but each event may change only
        // its own fields. Immutable creation provenance cannot be rewritten.
        const fields: Partial<Record<TodoEventType, readonly (keyof Todo)[]>> = {
          TodoDetailsChanged: ['title', 'notes', 'due_on'],
          TodoAssigned: ['assignee', 'assigned_by', 'assigned_at', 'state', 'state_by', 'state_at', 'gate', 'gate_set_by', 'queue_rank', 'offer'],
          TodoOffered: ['offer'], TodoOfferAnswered: ['offer'],
          TodoStateChanged: ['state', 'state_by', 'state_at', 'queue_rank'],
          TodoGateSet: ['gate', 'gate_set_by'], TodoCommented: ['comment_count'],
        };
        const allowed = new Set<keyof Todo>(['version', ...(fields[event.type] ?? [])]);
        if (Object.keys(current!).some(key => !allowed.has(key as keyof Todo) && !equal(current![key as keyof Todo], todo[key as keyof Todo]))) fail('unrelated field changed');
        if (event.type === 'TodoAssigned') {
          const validSetter = acceptedOffer
            ? acceptedOffer.todo_id === todo.todo_id && acceptedOffer.command_id === event.command_id
              && acceptedOffer.offer.decider_user_id === event.actor_user && event.actor_agent_principal === null
              && sameParty(todo.assignee, acceptedOffer.offer.to) && equal(todo.gate, acceptedOffer.offer.gate)
              && todo.gate_set_by === (todo.gate.kind === 'none' ? null : acceptedOffer.offer.by.user_id)
            : todo.gate_set_by === (todo.gate.kind === 'none' ? null : event.actor_user)
              || equal(todo.gate, current!.gate) && todo.gate_set_by === current!.gate_set_by;
          if (todo.state !== 'open' || todo.offer !== null || !equal(todo.assigned_by, author)
            || todo.assigned_at !== at || !equal(todo.state_by, author) || todo.state_at !== at || !validSetter) fail('invalid assignment');
        }
        if (event.type === 'TodoOffered' && (!todo.offer || !equal(todo.offer.by, author) || todo.offer.at !== at || current!.offer !== null)) fail('invalid offer provenance');
        if (event.type === 'TodoStateChanged') {
          const allowedStates = current!.state === 'open' ? ['doing', 'done', 'dropped'] : current!.state === 'doing' ? ['open', 'done', 'dropped'] : ['open'];
          if (!allowedStates.includes(todo.state) || !equal(todo.state_by, author) || todo.state_at !== at
            || todo.state === 'doing' && (!todo.assignee || !sameParty(todo.assignee, event.actor_agent_principal
              ? { kind: 'agent', id: event.actor_agent_principal } : { kind: 'user', id: event.actor_user! })
              || !evaluateGate(todo.gate, todos, event.occurred_at_server))) fail('invalid state transition');
        }
        if (event.type === 'TodoGateSet' && todo.gate_set_by !== (todo.gate.kind === 'none' ? null : event.actor_user)) fail('invalid gate setter');
      }
      todos[todo.todo_id] = structuredClone(todo);
    };
    if (event.type !== 'TodoAssigned') acceptedOffer = null;
    switch (event.type) {
      case 'TodoCreated': applyTodo(event.payload.todo, true); break;
      case 'TodoDetailsChanged': case 'TodoAssigned': case 'TodoOffered': case 'TodoStateChanged': case 'TodoGateSet': applyTodo(event.payload.todo); break;
      case 'TodoOfferAnswered': {
        const current = own(todos, event.payload.todo?.todo_id);
        if (!current?.offer || current.offer.offer_id !== event.payload.offer_id || event.payload.todo.offer !== null
          || !['accept', 'decline', 'withdraw', 'replaced'].includes(event.payload.answer)) fail('invalid offer answer');
        if (event.payload.answer === 'accept') acceptedOffer = { todo_id: current!.todo_id,
          command_id: event.command_id, offer: current!.offer! };
        applyTodo(event.payload.todo); break;
      }
      case 'TodoQueueOrdered': {
        const ids = event.payload.todo_ids;
        const expected = queue(state, event.payload.principal_id).map(t => t.todo_id);
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== expected.length || expected.some(i => !ids.includes(i))) fail('incomplete queue order');
        ids.forEach((todoId, index) => { todos[todoId] = { ...todos[todoId]!, queue_rank: index + 1 }; });
        break;
      }
      case 'TodoStartAsked': {
        const todo = own(todos, event.payload.todo_id);
        if (!todo || todo.assignee?.kind !== 'agent' || todo.assignee.id !== event.payload.principal_id || !isOpen(todo)) fail('invalid start request');
        break;
      }
      case 'TodoCommented': {
        const comment = event.payload.comment;
        if (!comment || !uuid(comment.comment_id) || own(comments, comment.comment_id) || !comment.body?.trim()
          || textLength(comment.body) > TODO_COMMENT_LIMIT || hasInvalidControls(comment.body) || !Array.isArray(comment.mentions)
          || comment.mentions.length > TODO_MENTIONS_LIMIT || comment.author.user_id !== event.actor_user
          || comment.author.principal_id !== event.actor_agent_principal || comment.created_at !== new Date(event.occurred_at_server).toISOString()) fail('invalid comment');
        if (comment.target.kind === 'todo') {
          const current = own(todos, comment.target.id);
          if (!current || !event.payload.todo || event.payload.todo.todo_id !== current.todo_id || event.payload.todo.comment_count !== current.comment_count + 1) fail('invalid comment count');
          applyTodo(event.payload.todo!);
        } else if (event.payload.todo !== null) fail('unexpected comment to-do');
        comments[comment.comment_id] = structuredClone(comment); break;
      }
      case 'AgentWorkPolicySet': {
        const policy = event.payload.policy;
        if (!policy || !id(policy.principal_id) || !['owner', 'anyone'].includes(policy.accepts_from)
          || policy.set_by_user !== event.actor_user || event.actor_agent_principal !== null
          || policy.set_at !== new Date(event.occurred_at_server).toISOString()) fail('invalid work policy');
        policies[policy.principal_id] = structuredClone(policy); break;
      }
    }
    if (event.type === 'TodoAssigned') acceptedOffer = null;
    const receipt = event.payload.receipt;
    if (receipt) {
      const key = receiptKey(receipt.principal, receipt.command_id);
      if (receipt.command_id !== event.command_id || receipt.principal !== (event.actor_agent_principal ?? event.actor_user)
        || !/^[a-f0-9]{64}$/.test(receipt.request_digest) || receipt.outcome.status !== 'committed' || own(receipts, key)) fail('invalid receipt');
      const outcome = receipt.outcome;
      if (outcome.status === 'committed') {
        const value = outcome.value;
        const projected = 'todo_id' in value ? own(todos, value.todo_id) : 'comment_id' in value ? own(comments, value.comment_id) : own(policies, value.principal_id);
        if (!projected || !equal(projected, value)) fail('receipt does not match projection');
      }
      receipts[key] = structuredClone(receipt);
    }
    state = { ...state, last_seq: event.seq, todos, comments, policies, receipts };
    if (Object.values(todos).filter(isOpen).length > TODO_OPEN_LIMIT
      || Object.values(todos).some(t => t.assignee?.kind === 'agent' && queue(state, t.assignee.id).length > TODO_QUEUE_LIMIT)) fail('to-do quota violated');
  }
  return state;
}
