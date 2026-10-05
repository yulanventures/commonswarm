import type { Session } from '@supabase/supabase-js';
import { HOUSEHOLD_LOCAL_SEAT } from '../../../../src/protocol/household-tool-registry.ts';
import { client, postCommand } from '../commonswarm.ts';
import type {
  ActivityItem,
  AgentQueue,
  AssignInput,
  Comment,
  CommentTarget,
  HomeOverview,
  HomeServer,
  LocalDate,
  Notice,
  Party,
  SteerAction,
  Todo,
  TodoRefusal as WireTodoRefusal,
  TodoSummary,
  QueueSection,
  TodoState,
  Uuid,
  WriteResult,
} from './contract.ts';
import { todoSummary, type HomeFixtures } from './fixtures.ts';

type PostCommandFn = typeof postCommand;
type ClientFn = typeof client;

export interface HomeServerDeps {
  postCommand: PostCommandFn;
  client: ClientFn;
}

const defaultDeps = (): HomeServerDeps => ({ postCommand, client });

function workspaceExtra(workspaceId: Uuid): Record<string, unknown> {
  return { workspace_id: workspaceId, stream: { kind: 'workspace' } };
}

// contract.ts is frozen for this lane. The local type and runtime allowlist share
// one inventory, checked against the wire union without changing that file.
export const TODO_REFUSAL_CODES = [
  'workspace_access_refused', 'content_consent_required', 'content_read_only',
  'connection_access_refused', 'human_confirmation_required', 'todo_not_found',
  'target_not_found', 'title_invalid', 'notes_invalid', 'due_invalid', 'comment_invalid',
  'mentions_invalid', 'assignee_not_member', 'assignee_removed', 'invalid_transition',
  'not_assignee', 'not_permitted', 'owner_only', 'offer_not_pending', 'not_decider',
  'not_in_queue', 'gate_invalid', 'gate_cycle', 'queue_empty', 'queue_full',
  'todo_limit_reached', 'request_id_reused', 'todo_write_rate_limited',
] as const satisfies readonly WireTodoRefusal[];
export type TodoRefusal = typeof TODO_REFUSAL_CODES[number];
const refusalCodes: ReadonlySet<string> = new Set(TODO_REFUSAL_CODES);

function isTodoRefusal(value: unknown): value is TodoRefusal {
  return typeof value === 'string' && refusalCodes.has(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pageOffset(value: unknown): number | null {
  if (value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) return value;
  throw new Error('home_read_malformed');
}

function readArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('home_read_malformed');
  return value as T[];
}

function parseWriteResult<T>(body: Record<string, unknown>): WriteResult<T> {
  const status = body.status;
  if (status === 'committed') {
    const notices: Notice[] = Array.isArray(body.notices) ? body.notices as Notice[] : [];
    return {
      status: 'committed',
      value: body.value as T,
      notices,
      replayed: body.replayed === true,
    };
  }
  if (status === 'conflict') {
    return { status: 'conflict', current: body.current as Todo };
  }
  if (status === 'refused' && isTodoRefusal(body.reason)) {
    return { status: 'refused', reason: body.reason };
  }
  throw new Error('home_write_malformed');
}

function parseAgentQueue(body: Record<string, unknown>): AgentQueue {
  // A nested queue keeps the transport's status:'ok' separate from agent work status.
  const queue = body.queue;
  if (!record(queue) || typeof queue.workspace_id !== 'string' || typeof queue.principal_id !== 'string'
    || typeof queue.owner_user_id !== 'string' || typeof queue.read_at !== 'string'
    || !['anyone', 'owner'].includes(String(queue.accepts_from))
    || !['none', 'read', 'read_write'].includes(String(queue.content_access))
    || !record(queue.status) || !['working', 'idle', 'disconnected'].includes(String(queue.status.work))
    || !record(queue.status.facts) || !record(queue.next_offset)) {
    throw new Error('home_queue_malformed');
  }
  for (const section of QUEUE_SECTIONS) {
    readArray<TodoSummary>(queue[section]);
    pageOffset(queue.next_offset[section]);
  }
  return queue as unknown as AgentQueue;
}

function parseOkBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.status === 'refused' && isTodoRefusal(body.reason)) {
    throw new HomeCommandRefused(body.reason);
  }
  if (body.status !== 'ok') throw new Error('home_read_malformed');
  return body;
}

export class HomeCommandRefused extends Error {
  readonly reason: TodoRefusal;
  constructor(reason: TodoRefusal) {
    super(reason);
    this.name = 'HomeCommandRefused';
    this.reason = reason;
  }
}

async function householdTool(
  deps: HomeServerDeps,
  session: Session,
  workspaceId: Uuid,
  requestId: string,
  tool: string,
  args: Record<string, unknown>,
  unknownOutcome: string,
  write = false,
): Promise<Record<string, unknown>> {
  const toolArgs: Record<string, unknown> = { seat: HOUSEHOLD_LOCAL_SEAT, ...args };
  if (write) toolArgs.request_id = requestId;
  const { status, body } = await deps.postCommand(
    session,
    requestId,
    { kind: 'household_tool', tool, arguments: toolArgs },
    workspaceExtra(workspaceId),
    unknownOutcome,
  );
  return checkedCommandBody(status, body);
}

async function householdSurface(
  deps: HomeServerDeps,
  session: Session,
  workspaceId: Uuid,
  requestId: string,
  command: Record<string, unknown>,
  unknownOutcome: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await deps.postCommand(session, requestId, command, workspaceExtra(workspaceId), unknownOutcome);
  return checkedCommandBody(status, body);
}

function checkedCommandBody(status: number, body: Record<string, unknown>): Record<string, unknown> {
  if (status !== 200 && !(body.status === 'refused' && isTodoRefusal(body.reason))) {
    throw new Error('home_request_failed');
  }
  return body;
}

export function createHomeServer(session: Session, deps: Partial<HomeServerDeps> = {}): HomeServer {
  const resolved = { ...defaultDeps(), ...deps };

  return {
    async overview(): Promise<HomeOverview> {
      const c = resolved.client();
      if (!c) throw new Error('home_no_deployment');
      const { data, error } = await c.schema('swarm_read').rpc('home_overview');
      if (error) throw new Error('home_overview_failed');
      if (!record(data) || typeof data.viewer_user_id !== 'string' || typeof data.generated_at !== 'string' || !Array.isArray(data.workspaces)) throw new Error('home_overview_malformed');
      return data as unknown as HomeOverview;
    },

    async activity(workspaceId, since, limit): Promise<ActivityItem[]> {
      const body = parseOkBody(await householdSurface(resolved, session, workspaceId, crypto.randomUUID(), {
        kind: 'household_activity',
        since,
        limit,
      }, 'The activity could not be loaded. Reload to try again.'));
      return readArray<ActivityItem>(body.items);
    },

    async listTodos(workspaceId, q) {
      const args: Record<string, unknown> = { scope: q.scope, offset: q.offset, limit: boundedLimit(q.limit, 50) };
      if (q.assignee) args.assignee = q.assignee;
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'todo_list', args, 'The to-dos could not be loaded. Reload to try again.'));
      return {
        todos: readArray<TodoSummary>(body.todos),
        next_offset: pageOffset(body.next_offset),
      };
    },

    async readTodo(workspaceId, todoId, commentOffset = 0) {
      const args: Record<string, unknown> = { todo_id: todoId, comment_offset: commentOffset };
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'todo_read', args, 'The to-do could not be loaded. Reload to try again.'));
      if (!record(body.todo) || typeof body.todo.todo_id !== 'string') throw new Error('home_read_malformed');
      return {
        todo: body.todo as unknown as Todo,
        comments: readArray<Comment>(body.comments),
        next_comment_offset: pageOffset(body.next_comment_offset),
      };
    },

    async listComments(workspaceId, target, offset, limit) {
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'comment_list', {
        target,
        offset,
        limit,
      }, 'The comments could not be loaded. Reload to try again.'));
      return {
        comments: readArray<Comment>(body.comments),
        next_offset: pageOffset(body.next_offset),
      };
    },

    async agentQueue(workspaceId, principalId, q = {}) {
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'todo_queue', {
        principal_id: principalId,
        ...(q.section === undefined ? {} : { section: q.section }),
        offset: q.offset ?? 0,
        limit: boundedLimit(q.limit ?? 50, 50),
      }, 'The line could not be loaded. Reload to try again.'));
      return parseAgentQueue(body);
    },

    async createTodo(workspaceId, input, requestId) {
      const args: Record<string, unknown> = { title: input.title };
      if (input.notes !== undefined) args.notes = input.notes;
      if (input.due_on !== undefined) args.due_on = input.due_on;
      if (input.assign) args.assign = input.assign;
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_create', args, 'The to-do may or may not have been saved. Reload to check.', true);
      return parseWriteResult<Todo>(body);
    },

    async updateTodo(workspaceId, input, requestId) {
      const args: Record<string, unknown> = {
        todo_id: input.todo_id,
        base_version: input.base_version,
      };
      if (input.title !== undefined) args.title = input.title;
      if (input.notes !== undefined) args.notes = input.notes;
      if (input.due_on !== undefined) args.due_on = input.due_on;
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_update', args, 'The to-do may or may not have been updated. Reload to check.', true);
      return parseWriteResult<Todo>(body);
    },

    async assignTodo(workspaceId, input, requestId) {
      const args: Record<string, unknown> = {
        todo_id: input.todo_id,
        base_version: input.base_version,
      };
      if ('to' in input && input.to === null) args.to = null;
      else {
        const assign = input as { todo_id: Uuid; base_version: number } & AssignInput;
        args.to = assign.to;
        if (assign.start !== undefined) args.start = assign.start;
        if (assign.gate !== undefined) args.gate = assign.gate;
      }
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_assign', args, 'The assignment may or may not have changed. Reload to check.', true);
      return parseWriteResult<Todo>(body);
    },

    async setTodoState(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_set_state', {
        todo_id: input.todo_id,
        base_version: input.base_version,
        state: input.state,
      }, 'The to-do state may or may not have changed. Reload to check.', true);
      return parseWriteResult<Todo>(body);
    },

    async startTodo(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_start', {
        todo_id: input.todo_id,
      }, 'The to-do may or may not be in Doing. Reload to check.', true);
      return parseWriteResult<Todo>(body);
    },

    async answerRequest(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_todo_answer',
        todo_id: input.todo_id,
        offer_id: input.offer_id,
        answer: input.answer,
      }, 'The request may or may not have been answered. Reload to check.');
      return parseWriteResult<Todo>(body);
    },

    async steerQueue(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_todo_steer',
        todo_id: input.todo_id,
        base_version: input.base_version,
        action: input.action,
      }, 'The line may or may not have changed. Reload to check.');
      return parseWriteResult<Todo>(body);
    },

    async setWorkPolicy(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_agent_work_policy',
        principal_id: input.principal_id,
        accepts_from: input.accepts_from,
      }, 'Who can give this agent work may or may not have changed. Reload to check.');
      return parseWriteResult(body);
    },

    async comment(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_comment', {
        target: input.target,
        body: input.body,
        mentions: input.mentions,
      }, 'The comment may or may not have been posted. Reload to check.', true);
      return parseWriteResult<Comment>(body);
    },
  };
}

function todosInWorkspace(fixtures: HomeFixtures, workspaceId: Uuid): Todo[] {
  return fixtures.todosByWorkspace[workspaceId] ?? [];
}

function findTodo(fixtures: HomeFixtures, workspaceId: Uuid, todoId: Uuid): Todo | undefined {
  return todosInWorkspace(fixtures, workspaceId).find((row) => row.todo_id === todoId);
}

function requireContentConsent(fixtures: HomeFixtures, workspaceId: Uuid): void {
  const workspace = fixtures.overview.workspaces.find((row) => row.workspace_id === workspaceId);
  if (!workspace) throw new HomeCommandRefused('workspace_access_refused');
  if (workspace.content === null) throw new HomeCommandRefused('content_consent_required');
}

const QUEUE_SECTIONS: readonly QueueSection[] = ['working', 'up_next', 'not_yet', 'requests'];
const PAGE_BUDGET = 28 * 1024;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).length;

function boundedLimit(limit: number, cap: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('home_page_invalid');
  return Math.min(limit, cap);
}

function offsetValue(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('home_page_invalid');
  return offset;
}

/** Fits the worst (double-serialized) transport, preserving absolute continuation offsets. */
function fixturePage<T>(rows: T[], offset: number, limit: number,
  envelope: (page: T[], next: number | null) => unknown, allowEmpty = false): { page: T[]; next: number | null } {
  offsetValue(offset);
  const page: T[] = [];
  for (const row of rows.slice(offset, offset + limit)) {
    const end = offset + page.length + 1;
    if (byteLength(envelope([...page, row], end < rows.length ? end : null)) > PAGE_BUDGET
      && (page.length > 0 || allowEmpty)) break;
    page.push(row); // AM16: a list always makes progress by returning its first row.
  }
  const end = offset + page.length;
  return { page, next: end < rows.length ? end : null };
}

export function createFixtureHomeServer(fixtures: HomeFixtures): HomeServer {
  return {
    async overview() {
      return fixtures.overview;
    },

    async activity(workspaceId, since, limit) {
      requireContentConsent(fixtures, workspaceId);
      const rows = fixtures.activityByWorkspace[workspaceId] ?? [];
      return rows.filter((row) => row.at >= since).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    },

    async listTodos(workspaceId, q) {
      requireContentConsent(fixtures, workspaceId);
      let rows = todosInWorkspace(fixtures, workspaceId).filter((row) =>
        q.scope === 'all' ? true : row.state === 'open' || row.state === 'doing');
      if (q.assignee) {
        rows = rows.filter((row) =>
          row.assignee?.kind === q.assignee!.kind && row.assignee.id === q.assignee!.id);
      }
      const { page, next } = fixturePage(rows.map(todoSummary), q.offset, boundedLimit(q.limit, 50),
        (todos, next_offset) => ({ status: 'ok', todos, next_offset }));
      return { todos: page, next_offset: next };
    },

    async readTodo(workspaceId, todoId, commentOffset = 0) {
      requireContentConsent(fixtures, workspaceId);
      const todo = findTodo(fixtures, workspaceId, todoId);
      if (!todo) throw new HomeCommandRefused('todo_not_found');
      const rows = (fixtures.commentsByWorkspace[workspaceId] ?? [])
        .filter((row) => row.target.kind === 'todo' && row.target.id === todoId);
      const { page, next } = fixturePage(rows, commentOffset, 20,
        (comments, next_comment_offset) => ({ status: 'ok', todo, comments, next_comment_offset }), true);
      return { todo, comments: page, next_comment_offset: next };
    },

    async listComments(workspaceId, target, offset, limit) {
      requireContentConsent(fixtures, workspaceId);
      const rows = (fixtures.commentsByWorkspace[workspaceId] ?? [])
        .filter((row) => row.target.kind === target.kind && row.target.id === target.id);
      const { page, next } = fixturePage(rows, offset, boundedLimit(limit, 100),
        (comments, next_offset) => ({ status: 'ok', comments, next_offset }));
      return { comments: page, next_offset: next };
    },

    async agentQueue(workspaceId, principalId, q = {}) {
      requireContentConsent(fixtures, workspaceId);
      const source = fixtures.queues[principalId];
      if (!source || source.workspace_id !== workspaceId) throw new HomeCommandRefused('target_not_found');
      const offset = offsetValue(q.offset ?? 0);
      const limit = boundedLimit(q.limit ?? 50, 50);
      const queue: AgentQueue = {
        ...source, working: [], up_next: [], not_yet: [], requests: [],
        next_offset: { working: null, up_next: null, not_yet: null, requests: null },
      };
      let cut = false;
      for (const section of QUEUE_SECTIONS) {
        if (q.section && section !== q.section) {
          queue.next_offset[section] = source[section].length ? 0 : null;
          continue;
        }
        if (cut) { queue.next_offset[section] = 0; continue; }
        const { page, next } = fixturePage(source[section], offset, limit, (rows, next_offset) => ({
          status: 'ok', queue: { ...queue, [section]: rows, next_offset: { ...queue.next_offset, [section]: next_offset } },
        }), QUEUE_SECTIONS.some(key => queue[key].length > 0));
        queue[section] = page;
        queue.next_offset[section] = next;
        cut = next !== null;
      }
      return queue;
    },

    async createTodo() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async updateTodo() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async assignTodo() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async setTodoState() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async startTodo() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async answerRequest() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async steerQueue() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async setWorkPolicy() {
      return { status: 'refused', reason: 'not_permitted' };
    },

    async comment() {
      return { status: 'refused', reason: 'not_permitted' };
    },
  };
}

export type { LocalDate, Party, SteerAction, TodoState };
