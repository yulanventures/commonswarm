/** Closed local projections of the home contract. The server owns permissions,
 * gate evaluation and paging. Stored write receipts lack derived read fields. */
import type { HouseholdToolInvocation } from '../protocol/household-tool-registry.js';
import type { Todo, TodoActor, TodoComment, TodoGate, TodoOffer, Party } from '../protocol/household-todos.js';
import type { AgentWork, AgentWorkFacts } from '../protocol/household-todo-policy.js';
import { TODO_TITLE_LIMIT, TODO_NOTES_LIMIT, TODO_COMMENT_LIMIT, TODO_MENTIONS_LIMIT, TODO_GATE_NOTE_LIMIT } from '../protocol/household-todo-policy.js';

export type HouseholdTodoView = Omit<Todo, 'queue_rank' | 'gate_set_by'> & {
  gate_clear?: boolean; queue_position?: number | null;
};
export interface HouseholdTodoSummary {
  todo_id: string; version: number; title: string; state: Todo['state']; due_on: string | null;
  assignee: Party | null;
  offer: Pick<TodoOffer, 'offer_id' | 'to' | 'decider_user_id' | 'start'> | null;
  gate: { kind: TodoGate['kind']; clear: boolean; todo_id: string | null; at: string | null };
  queue_position: number | null; comment_count: number; state_at: string;
}
export type HouseholdTodoNotice = { to: Party[]; status: 'sent'; signal_id: string }
  | { to: Party[]; status: 'not_sent'; reason: 'signal_rate_limited' | 'recipient_not_live' };
const sections = ['working', 'up_next', 'not_yet', 'requests'] as const;
type Section = typeof sections[number];
export type HouseholdTodoQueue = {
  workspace_id: string; principal_id: string; owner_user_id: string;
  accepts_from: 'owner' | 'anyone'; content_access: 'none' | 'read' | 'read_write';
  status: { work: AgentWork; facts: AgentWorkFacts }; read_at: string;
  next_offset: Record<Section, number | null>;
} & Record<Section, HouseholdTodoSummary[]>;
export type HouseholdTodoClientResult =
  | { status: 'committed'; kind: 'todo'; request_id: string; value: HouseholdTodoView; notices: HouseholdTodoNotice[]; replayed: boolean }
  | { status: 'committed'; kind: 'comment'; request_id: string; value: TodoComment; notices: HouseholdTodoNotice[]; replayed: boolean }
  | { status: 'conflict'; kind: 'todo'; request_id: string; current: HouseholdTodoView }
  | { status: 'ok'; kind: 'todo_list'; todos: HouseholdTodoSummary[]; next_offset: number | null }
  | { status: 'ok'; kind: 'todo_read'; todo: HouseholdTodoView; comments: TodoComment[]; next_comment_offset: number | null }
  | { status: 'ok'; kind: 'comment_list'; comments: TodoComment[]; next_offset: number | null }
  | { status: 'ok'; kind: 'todo_queue'; queue: HouseholdTodoQueue };

class InvalidResponse extends Error {}
function requireValue(ok: unknown): asserts ok { if (!ok) throw new InvalidResponse(); }
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown, max = Infinity, min = 0): string {
  requireValue(typeof value === 'string' && Array.from(value).length >= min && Array.from(value).length <= max);
  return value;
}
const id = (value: unknown): string => text(value, 255, 1);
function integer(value: unknown, min = 0): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min); return value;
}
function boolean(value: unknown): boolean { requireValue(typeof value === 'boolean'); return value; }
function choice<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  requireValue(typeof value === 'string' && values.includes(value)); return value;
}
function time(value: unknown): string { const s = text(value, 64, 1); requireValue(Number.isFinite(Date.parse(s))); return s; }
function date(value: unknown): string {
  const s = text(value, 10, 10); requireValue(/^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(time(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s); return s;
}
const nullable = <T>(value: unknown, decode: (value: unknown) => T): T | null => value === null ? null : decode(value);
const cursor = (value: unknown): number | null => nullable(value, integer);
function list<T>(value: unknown, decode: (value: unknown) => T, max: number): T[] {
  requireValue(Array.isArray(value) && value.length <= max); return Array.from(value, decode);
}
function party(value: unknown): Party { const r = record(value); return { kind: choice(r.kind, ['user', 'agent']), id: id(r.id) }; }
function actor(value: unknown): TodoActor { const r = record(value); return { user_id: id(r.user_id), principal_id: nullable(r.principal_id, id) }; }
const state = (value: unknown): Todo['state'] => choice(value, ['open', 'doing', 'done', 'dropped']);
const gateKind = (value: unknown): TodoGate['kind'] => choice(value, ['none', 'hold', 'after', 'at']);
function gate(value: unknown): TodoGate {
  const r = record(value), kind = gateKind(r.kind);
  if (kind === 'hold') return { kind, note: nullable(r.note, v => text(v, TODO_GATE_NOTE_LIMIT)) };
  if (kind === 'after') return { kind, todo_id: id(r.todo_id) };
  if (kind === 'at') return { kind, at: time(r.at) };
  return { kind };
}
function offerSummary(value: unknown): NonNullable<HouseholdTodoSummary['offer']> {
  const r = record(value); return { offer_id: id(r.offer_id), to: party(r.to), decider_user_id: id(r.decider_user_id), start: choice(r.start, ['queue', 'now']) };
}
function offer(value: unknown): TodoOffer {
  const r = record(value); return { ...offerSummary(r), gate: gate(r.gate), by: actor(r.by), at: time(r.at) };
}
function todo(value: unknown, workspace: string, expectedId?: string, reading = false): HouseholdTodoView {
  const r = record(value); requireValue(r.workspace_id === workspace && (expectedId === undefined || r.todo_id === expectedId));
  const output: HouseholdTodoView = {
    workspace_id: workspace, todo_id: id(r.todo_id), version: integer(r.version, 1), title: text(r.title, TODO_TITLE_LIMIT, 1),
    notes: text(r.notes, TODO_NOTES_LIMIT), state: state(r.state), due_on: nullable(r.due_on, date),
    created_by: actor(r.created_by), created_at: time(r.created_at), assignee: nullable(r.assignee, party),
    assigned_by: nullable(r.assigned_by, actor), assigned_at: nullable(r.assigned_at, time), offer: nullable(r.offer, offer),
    gate: gate(r.gate), state_by: actor(r.state_by), state_at: time(r.state_at), comment_count: integer(r.comment_count),
  };
  if (reading || r.gate_clear !== undefined) output.gate_clear = boolean(r.gate_clear);
  if (reading || r.queue_position !== undefined) output.queue_position = nullable(r.queue_position, v => integer(v, 1));
  return output;
}
function summary(value: unknown): HouseholdTodoSummary {
  const r = record(value), g = record(r.gate);
  return { todo_id: id(r.todo_id), version: integer(r.version, 1), title: text(r.title, TODO_TITLE_LIMIT, 1), state: state(r.state),
    due_on: nullable(r.due_on, date), assignee: nullable(r.assignee, party), offer: nullable(r.offer, offerSummary),
    // The store currently sends kind + clear only, as AM3 specifies. Optional
    // references from contract-aware hosts are retained; absent ones are null.
    gate: { kind: gateKind(g.kind), clear: boolean(g.clear), todo_id: g.todo_id === undefined ? null : nullable(g.todo_id, id), at: g.at === undefined ? null : nullable(g.at, time) },
    queue_position: nullable(r.queue_position, v => integer(v, 1)), comment_count: integer(r.comment_count), state_at: time(r.state_at) };
}
function target(value: unknown): TodoComment['target'] {
  const r = record(value); return { kind: choice(r.kind, ['todo', 'list', 'doc', 'file']), id: id(r.id) };
}
function comment(value: unknown, expected?: TodoComment['target']): TodoComment {
  const r = record(value), t = target(r.target);
  requireValue(!expected || t.kind === expected.kind && t.id === expected.id);
  return { comment_id: id(r.comment_id), target: t, author: actor(r.author), body: text(r.body, TODO_COMMENT_LIMIT, 1),
    mentions: list(r.mentions, party, TODO_MENTIONS_LIMIT), created_at: time(r.created_at) };
}
function notice(value: unknown): HouseholdTodoNotice {
  const r = record(value), to = list(r.to, party, TODO_MENTIONS_LIMIT);
  return r.status === 'sent' ? { to, status: 'sent', signal_id: id(r.signal_id) }
    : (requireValue(r.status === 'not_sent'), { to, status: 'not_sent', reason: choice(r.reason, ['signal_rate_limited', 'recipient_not_live']) });
}
function workStatus(value: unknown): HouseholdTodoQueue['status'] {
  const r = record(value), f = record(r.facts);
  return { work: choice(r.work, ['working', 'idle', 'disconnected']), facts: {
    transport: choice(f.transport, ['local', 'hosted_mcp']), turn_only: boolean(f.turn_only),
    connection: choice(f.connection, ['live', 'removed', 'connection_off', 'key_off', 'key_ended', 'paused']),
    last_activity_at: nullable(f.last_activity_at, time), messages_waiting_since: nullable(f.messages_waiting_since, time),
    doing: nullable(f.doing, v => { const d = record(v); return { todo_id: id(d.todo_id), title: nullable(d.title, v => text(v, TODO_TITLE_LIMIT)), since: time(d.since) }; }),
    working_on: nullable(f.working_on, v => { const w = record(v); return { signal_id: id(w.signal_id), at: time(w.at), until: time(w.until) }; }),
  } };
}

/** Accept both the edge's flat receipt and the injected store's outcome wrapper.
 * Unknown or malformed values never cross into CLI/MCP output. */
export function decodeHouseholdTodoResponse(data: Record<string, unknown>, invocation: HouseholdToolInvocation,
  envelope: Record<string, unknown>): HouseholdTodoClientResult | null {
  try {
    if ('command' in invocation) {
      const command = invocation.command;
      const request_id = invocation.request_id!; requireValue(request_id && (data.request_id === undefined || data.request_id === request_id));
      const expectedId = 'todo_id' in command ? command.todo_id : undefined;
      if (data.status === 'conflict' && command.kind !== 'todo_comment') return { status: 'conflict', kind: 'todo', request_id, current: todo(data.current, invocation.workspace_id, expectedId) };
      requireValue(data.status === 'committed');
      const notices = list(data.notices ?? envelope.notices, notice, 1), replayed = boolean(data.replayed ?? envelope.replayed);
      if (command.kind === 'todo_comment') return { status: 'committed', kind: 'comment', request_id, value: comment(data.value, command.target), notices, replayed };
      return { status: 'committed', kind: 'todo', request_id, value: todo(data.value, invocation.workspace_id, expectedId), notices, replayed };
    }
    requireValue(data.status === 'ok' && (data.kind === undefined || data.kind === invocation.query.kind));
    const query = invocation.query;
    if (query.kind === 'todo_list') return { status: 'ok', kind: query.kind, todos: list(data.todos, summary, query.limit ?? 50), next_offset: cursor(data.next_offset) };
    if (query.kind === 'todo_read') return { status: 'ok', kind: query.kind, todo: todo(data.todo, invocation.workspace_id, query.todo_id, true),
      comments: list(data.comments, v => comment(v, { kind: 'todo', id: query.todo_id }), 20), next_comment_offset: cursor(data.next_comment_offset) };
    if (query.kind === 'comment_list') return { status: 'ok', kind: query.kind, comments: list(data.comments, v => comment(v, query.target), query.limit ?? 20), next_offset: cursor(data.next_offset) };
    requireValue(query.kind === 'todo_queue');
    const q = record(data.queue), next = record(q.next_offset);
    requireValue(q.workspace_id === invocation.workspace_id && (query.principal_id === undefined || q.principal_id === query.principal_id));
    const queue: HouseholdTodoQueue = { workspace_id: invocation.workspace_id, principal_id: id(q.principal_id), owner_user_id: id(q.owner_user_id),
      accepts_from: choice(q.accepts_from, ['owner', 'anyone']), content_access: choice(q.content_access, ['none', 'read', 'read_write']),
      status: workStatus(q.status), read_at: time(q.read_at),
      working: list(q.working, summary, query.limit ?? 50), up_next: list(q.up_next, summary, query.limit ?? 50),
      not_yet: list(q.not_yet, summary, query.limit ?? 50), requests: list(q.requests, summary, query.limit ?? 50),
      next_offset: { working: cursor(next.working), up_next: cursor(next.up_next), not_yet: cursor(next.not_yet), requests: cursor(next.requests) } };
    return { status: 'ok', kind: query.kind, queue };
  } catch (error) {
    if (!(error instanceof InvalidResponse)) throw error;
    return null;
  }
}
