import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { HOUSEHOLD_LOCAL_SEAT } from '../../../../src/protocol/household-tool-registry.ts';
import { client, isMultiAccountEnabled, pinAccountContext, postCommand, type PinnedAccountContext } from '../commonswarm.ts';
import type {
  ActivityItem,
  AgentQueue,
  AssignInput,
  Comment,
  CommentTarget,
  DecisionAsk,
  DecisionQueue,
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
  WaitingArchivedEntry,
  WaitingArchivedKind,
  KnownWaitingArchivedOutcomeKind,
  WaitingArchivedOutcomeKind,
  WaitingArchivedPage,
  WaitingArchivedPlacement,
  WaitingTodoEntry,
  WaitingTodoPlacement,
  WaitingTodosQueue,
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

interface HomeCommandPinOptions {
  pinnedOverride?: PinnedAccountContext | null;
  accountRouted?: boolean;
  isAlive?: () => boolean;
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
  pinOptions: HomeCommandPinOptions = {},
): Promise<Record<string, unknown>> {
  const accountRouted = pinOptions.accountRouted === true;
  const pinned = isMultiAccountEnabled()
    ? (pinOptions.pinnedOverride ?? pinAccountContext(
      accountRouted ? { userId: session.user.id } : { userId: session.user.id, workspaceId },
    ))
    : null;
  const isCurrent = (ctx: PinnedAccountContext): boolean =>
    accountRouted ? ctx.isCurrent() : ctx.isCurrent(workspaceId);
  if (isMultiAccountEnabled() && (!pinned || !isCurrent(pinned))) {
    throw new HomeCommandRefused('workspace_access_refused');
  }
  const toolArgs: Record<string, unknown> = { seat: HOUSEHOLD_LOCAL_SEAT, ...args };
  if (write) toolArgs.request_id = requestId;
  const { status, body } = await deps.postCommand(
    session,
    requestId,
    { kind: 'household_tool', tool, arguments: toolArgs },
    workspaceExtra(workspaceId),
    unknownOutcome,
    accountRouted || pinOptions.isAlive
      ? {
          pinned,
          ...(accountRouted ? { accountWideWorkspace: true } : {}),
          ...(pinOptions.isAlive ? { isAlive: pinOptions.isAlive } : {}),
        }
      : pinned,
  );
  if (pinned && !isCurrent(pinned)) {
    throw new HomeCommandRefused('workspace_access_refused');
  }
  return checkedCommandBody(status, body);
}

async function householdSurface(
  deps: HomeServerDeps,
  session: Session,
  workspaceId: Uuid,
  requestId: string,
  command: Record<string, unknown>,
  unknownOutcome: string,
  pinOptions: HomeCommandPinOptions = {},
): Promise<Record<string, unknown>> {
  const accountRouted = pinOptions.accountRouted === true;
  const pinned = isMultiAccountEnabled()
    ? (pinOptions.pinnedOverride ?? pinAccountContext(
      accountRouted ? { userId: session.user.id } : { userId: session.user.id, workspaceId },
    ))
    : null;
  const isCurrent = (ctx: PinnedAccountContext): boolean =>
    accountRouted ? ctx.isCurrent() : ctx.isCurrent(workspaceId);
  if (isMultiAccountEnabled() && (!pinned || !isCurrent(pinned))) {
    throw new HomeCommandRefused('workspace_access_refused');
  }
  const { status, body } = await deps.postCommand(
    session,
    requestId,
    command,
    workspaceExtra(workspaceId),
    unknownOutcome,
    accountRouted ? { pinned, accountWideWorkspace: true } : pinned,
  );
  if (pinned && !isCurrent(pinned)) {
    throw new HomeCommandRefused('workspace_access_refused');
  }
  return checkedCommandBody(status, body);
}

const isoTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const DECISION_CONVERSATION_KINDS = new Set(['general', 'public_channel', 'private_channel', 'dm', 'group_dm']);

function decisionAsk(value: unknown): DecisionAsk {
  if (!record(value) || typeof value.signal_id !== 'string' || !record(value.from)
    || (value.from.kind !== 'agent' && value.from.kind !== 'user') || typeof value.from.id !== 'string'
    || (value.from.name !== null && typeof value.from.name !== 'string') || typeof value.body !== 'string'
    || !isoTime(value.created_at) || !isoTime(value.until)) throw new Error('home_decision_queue_malformed');
  const reraised = value.reraised;
  if (reraised !== null && !(record(reraised) && count(reraised.count) && reraised.count > 0 && isoTime(reraised.last_at))) {
    throw new Error('home_decision_queue_malformed');
  }
  let conversationId: string | null | undefined;
  if (value.conversation_id !== undefined) {
    if (value.conversation_id !== null && typeof value.conversation_id !== 'string') {
      throw new Error('home_decision_queue_malformed');
    }
    conversationId = typeof value.conversation_id === 'string' && value.conversation_id.trim()
      ? value.conversation_id.trim().toLowerCase()
      : null;
  }
  let conversationKind: DecisionAsk['conversation_kind'];
  if (value.conversation_kind !== undefined) {
    if (value.conversation_kind !== null && (typeof value.conversation_kind !== 'string' || !DECISION_CONVERSATION_KINDS.has(value.conversation_kind))) {
      throw new Error('home_decision_queue_malformed');
    }
    conversationKind = value.conversation_kind as DecisionAsk['conversation_kind'];
  }
  return {
    signal_id: value.signal_id,
    from: { kind: value.from.kind, id: value.from.id, name: value.from.name },
    body: value.body, created_at: value.created_at, until: value.until,
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(conversationKind !== undefined ? { conversation_kind: conversationKind } : {}),
    reraised: reraised === null ? null : { count: reraised.count as number, last_at: reraised.last_at as string },
  };
}

/** Validates swarm_read.decision_queue. NULL (not a member) stays null; anything else malformed throws. Server order is kept. */
export function parseDecisionQueue(data: unknown, workspaceId: Uuid): DecisionQueue | null {
  if (data === null) return null;
  if (!record(data) || data.workspace_id !== workspaceId || !isoTime(data.generated_at) || !count(data.total)
    || typeof data.truncated !== 'boolean' || !Array.isArray(data.asks) || data.asks.length > data.total) {
    throw new Error('home_decision_queue_malformed');
  }
  return { workspace_id: workspaceId, generated_at: data.generated_at, total: data.total, truncated: data.truncated,
    asks: data.asks.map(decisionAsk) };
}

const WAITING_TODO_REASONS = new Set(['assigned', 'request', 'after', 'hold', 'agent_removed']);
const WAITING_TODO_PLACEMENTS = new Set<WaitingTodoPlacement>(['channel', 'general', 'workspace', 'dm', 'group_dm']);

function waitingTodoEntry(value: unknown): WaitingTodoEntry {
  if (!record(value) || typeof value.todo_id !== 'string' || typeof value.title !== 'string'
    || (value.state !== 'open' && value.state !== 'doing')
    || (value.due_on !== null && typeof value.due_on !== 'string')
    || typeof value.reason !== 'string' || !WAITING_TODO_REASONS.has(value.reason)
    || (value.agent_id !== null && typeof value.agent_id !== 'string')
    || !isoTime(value.state_at)
    || typeof value.placement !== 'string' || !WAITING_TODO_PLACEMENTS.has(value.placement as WaitingTodoPlacement)
    || (value.channel_id !== null && typeof value.channel_id !== 'string')
    || (value.conversation_id !== undefined && value.conversation_id !== null && typeof value.conversation_id !== 'string')) {
    throw new Error('home_waiting_todos_malformed');
  }
  const placement = value.placement as WaitingTodoPlacement;
  const rawConvId = typeof value.conversation_id === 'string' && value.conversation_id.trim()
    ? value.conversation_id.trim().toLowerCase()
    : null;
  if (placement === 'channel' && (!value.channel_id || rawConvId !== null)) throw new Error('home_waiting_todos_malformed');
  if ((placement === 'dm' || placement === 'group_dm') && (!rawConvId || value.channel_id !== null)) {
    throw new Error('home_waiting_todos_malformed');
  }
  return {
    todo_id: value.todo_id,
    title: value.title,
    state: value.state,
    due_on: value.due_on,
    reason: value.reason as WaitingTodoEntry['reason'],
    agent_id: value.agent_id,
    state_at: value.state_at,
    placement,
    channel_id: placement === 'channel' ? value.channel_id : null,
    conversation_id: (placement === 'dm' || placement === 'group_dm') ? rawConvId : null,
  };
}

/** Validates swarm_read.waiting_todos_page. NULL (not a member) stays null; malformed throws. */
export function parseWaitingTodosQueue(data: unknown, workspaceId: Uuid): WaitingTodosQueue | null {
  if (data === null) return null;
  if (!record(data) || data.workspace_id !== workspaceId || !isoTime(data.generated_at) || !count(data.total)
    || typeof data.truncated !== 'boolean' || !Array.isArray(data.todos) || data.todos.length > data.total) {
    throw new Error('home_waiting_todos_malformed');
  }
  return {
    workspace_id: workspaceId,
    generated_at: data.generated_at,
    total: data.total,
    truncated: data.truncated,
    todos: data.todos.map(waitingTodoEntry),
  };
}

const WAITING_ARCHIVED_KINDS = new Set<WaitingArchivedKind>(['ask', 'todo', 'review']);
export const WAITING_ARCHIVED_OUTCOMES = new Set<KnownWaitingArchivedOutcomeKind>([
  'answered', 'cleared_stale', 'done', 'dropped', 'accepted', 'declined', 'dismissed',
  'agent_removed', 'sender_left', 'channel_archived', 'withdrawn', 'expired',
]);
const WAITING_ARCHIVED_PLACEMENTS = new Set<WaitingArchivedPlacement>(['channel', 'general', 'dm', 'group_dm', 'workspace', 'redacted']);

function waitingArchivedEntry(value: unknown): WaitingArchivedEntry {
  const outcomeKind = record(value) && typeof value.outcome_kind === 'string' ? value.outcome_kind.trim() : '';
  if (!record(value)
    || typeof value.item_key !== 'string' || !value.item_key
    || typeof value.kind !== 'string' || !WAITING_ARCHIVED_KINDS.has(value.kind as WaitingArchivedKind)
    || typeof value.id !== 'string'
    || (value.todo_id !== null && typeof value.todo_id !== 'string')
    || (value.ask_kind !== null && value.ask_kind !== 'choice' && value.ask_kind !== 'plain')
    || typeof value.title !== 'string'
    || !outcomeKind
    || typeof value.outcome_text !== 'string'
    || !isoTime(value.archived_at)
    || typeof value.placement !== 'string' || !WAITING_ARCHIVED_PLACEMENTS.has(value.placement as WaitingArchivedPlacement)
    || (value.channel_id !== null && typeof value.channel_id !== 'string')
    || (value.conversation_id !== null && typeof value.conversation_id !== 'string')
    || (value.conversation_kind !== null && (typeof value.conversation_kind !== 'string' || !DECISION_CONVERSATION_KINDS.has(value.conversation_kind)))) {
    throw new Error('home_waiting_archived_malformed');
  }
  let from: WaitingArchivedEntry['from'] = null;
  if (value.from !== null) {
    if (!record(value.from) || (value.from.kind !== 'agent' && value.from.kind !== 'user')
      || typeof value.from.id !== 'string' || (value.from.name !== null && typeof value.from.name !== 'string')) {
      throw new Error('home_waiting_archived_malformed');
    }
    from = { kind: value.from.kind, id: value.from.id, name: value.from.name };
  }
  let answeredBy: WaitingArchivedEntry['answered_by'] = null;
  if (value.answered_by !== null) {
    if (!record(value.answered_by) || (value.answered_by.kind !== 'agent' && value.answered_by.kind !== 'user')
      || typeof value.answered_by.id !== 'string'
      || (value.answered_by.name !== null && typeof value.answered_by.name !== 'string')
      || (value.answered_by.by_viewer !== undefined && typeof value.answered_by.by_viewer !== 'boolean')) {
      throw new Error('home_waiting_archived_malformed');
    }
    answeredBy = {
      kind: value.answered_by.kind,
      id: value.answered_by.id,
      name: value.answered_by.name,
      ...(value.answered_by.by_viewer !== undefined ? { by_viewer: value.answered_by.by_viewer } : {}),
    };
  }
  const placement = value.placement as WaitingArchivedPlacement;
  const channelId = typeof value.channel_id === 'string' && value.channel_id.trim() ? value.channel_id.trim().toLowerCase() : null;
  const conversationId = typeof value.conversation_id === 'string' && value.conversation_id.trim() ? value.conversation_id.trim().toLowerCase() : null;
  if (placement === 'channel' && !channelId) throw new Error('home_waiting_archived_malformed');
  if ((placement === 'dm' || placement === 'group_dm') && (!conversationId || channelId !== null)) {
    throw new Error('home_waiting_archived_malformed');
  }
  return {
    item_key: value.item_key.toLowerCase(),
    kind: value.kind as WaitingArchivedKind,
    id: value.id,
    todo_id: value.todo_id,
    ask_kind: value.ask_kind,
    title: value.title,
    from,
    outcome_kind: outcomeKind as WaitingArchivedOutcomeKind,
    outcome_text: value.outcome_text,
    archived_at: value.archived_at,
    answered_by: answeredBy,
    placement,
    channel_id: placement === 'channel' ? channelId : null,
    conversation_id: placement === 'workspace' || placement === 'redacted' ? null : conversationId,
    conversation_kind: placement === 'workspace' || placement === 'redacted' ? null : value.conversation_kind as WaitingArchivedEntry['conversation_kind'],
  };
}

/** Validates swarm_read.waiting_archived_page. NULL (not a member) stays null; malformed throws. */
export function parseWaitingArchivedPage(data: unknown, workspaceId: Uuid): WaitingArchivedPage | null {
  if (data === null) return null;
  if (!record(data) || data.workspace_id !== workspaceId || !isoTime(data.generated_at) || !count(data.total)
    || typeof data.truncated !== 'boolean' || !Array.isArray(data.items) || data.items.length > data.total) {
    throw new Error('home_waiting_archived_malformed');
  }
  return {
    workspace_id: workspaceId,
    generated_at: data.generated_at,
    total: data.total,
    truncated: data.truncated,
    items: data.items.map(waitingArchivedEntry),
  };
}

export class HomeToolsUnavailable extends Error {
  constructor() { super('home_tools_unavailable'); this.name = 'HomeToolsUnavailable'; }
}
export class HomeArchivedDeniedError extends Error {
  constructor() { super('home_waiting_archived_denied'); this.name = 'HomeArchivedDeniedError'; }
}
/** Detect explicit auth/permission refusal from PostgREST/Postgres RPC error payloads. */
function isArchivedAuthDenied(error: { code?: string | null; status?: number | null }): boolean {
  const code = typeof error.code === 'string' ? error.code : '';
  const status = typeof error.status === 'number' ? error.status : 0;
  return status === 401 || status === 403 || code === '42501' || code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303';
}
/** Detect absence by owned response codes, never by error prose. */
export function homeToolsMissing(body: Record<string, unknown>): boolean {
  return [body.error, body.code, body.reason].some(code => code === 'unknown_tool' || code === 'unknown_household_tool' || code === 'PGRST202' || code === '42883');
}

function checkedCommandBody(status: number, body: Record<string, unknown>): Record<string, unknown> {
  if (homeToolsMissing(body)) throw new HomeToolsUnavailable();
  if (status !== 200 && !(body.status === 'refused' && isTodoRefusal(body.reason))) {
    throw new Error('home_request_failed');
  }
  return body;
}

export function createHomeServer(
  session: Session,
  deps: Partial<HomeServerDeps> = {},
  pinnedOverride?: PinnedAccountContext | null,
  options?: { accountRouted?: boolean; isAlive?: () => boolean },
): HomeServer {
  const resolved = { ...defaultDeps(), ...deps };
  const pinOptions: HomeCommandPinOptions = {
    pinnedOverride,
    accountRouted: options?.accountRouted === true,
    ...(options?.isAlive ? { isAlive: options.isAlive } : {}),
  };
  const resolvePinnedClient = (): { c: SupabaseClient; pinned: PinnedAccountContext | null } => {
    if (isMultiAccountEnabled()) {
      const pinned = pinnedOverride ?? pinAccountContext({ userId: session.user.id });
      if (!pinned || !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      return { c: pinned.runtime.client, pinned };
    }
    const c = resolved.client();
    if (!c) throw new Error('home_no_deployment');
    return { c, pinned: null };
  };

  return {
    async overview(): Promise<HomeOverview> {
      const { c, pinned } = resolvePinnedClient();
      const { data, error } = await c.schema('swarm_read').rpc('home_overview');
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      if (error && homeToolsMissing({ code: error.code })) throw new HomeToolsUnavailable();
      if (error) throw new Error('home_overview_failed');
      if (!record(data) || typeof data.viewer_user_id !== 'string' || typeof data.generated_at !== 'string' || !Array.isArray(data.workspaces)) throw new Error('home_overview_malformed');
      return data as unknown as HomeOverview;
    },

    async decisionQueue(workspaceId): Promise<DecisionQueue | null> {
      const { c, pinned } = resolvePinnedClient();
      const { data, error } = await c.schema('swarm_read').rpc('decision_queue', { p_workspace_id: workspaceId });
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      if (error && homeToolsMissing({ code: error.code })) throw new HomeToolsUnavailable();
      if (error) throw new Error('home_decision_queue_failed');
      const first = parseDecisionQueue(data, workspaceId);
      if (!first || (!first.truncated && first.asks.length >= first.total)) return first;
      // More than 100 open asks: keyset-page through decision_queue_page until the server reports
      // no more rows. If an older server lacks the paged RPC, any later page fails, or the cap is
      // reached, keep truncated: true so callers never mistake a partial queue for complete.
      const asks = [...first.asks];
      const seen = new Set(asks.map(ask => ask.signal_id));
      let page = first;
      let truncated = true;
      let pages = 1;
      const MAX_PAGES = 20;
      while (truncated && pages < MAX_PAGES && page.asks.length > 0) {
        if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
        const last = page.asks[page.asks.length - 1]!;
        let next: DecisionQueue | null = null;
        let pageFailed = false;
        try {
          const paged = await c.schema('swarm_read').rpc('decision_queue_page', {
            p_workspace_id: workspaceId,
            p_after_created_at: last.created_at,
            p_after_id: last.signal_id,
          });
          if (paged.error) pageFailed = true;
          else next = parseDecisionQueue(paged.data, workspaceId);
        } catch {
          pageFailed = true;
        }
        // C2: Guard after every page OUTSIDE the partial-queue catch so a view change
        // throws and drops prior-account rows instead of returning a stale partial queue.
        if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
        if (pageFailed || !next) break;
        let added = 0;
        for (const ask of next.asks) {
          if (seen.has(ask.signal_id)) continue;
          seen.add(ask.signal_id);
          asks.push(ask);
          added += 1;
        }
        page = next;
        pages += 1;
        if (!next.truncated) {
          truncated = false;
          break;
        }
        if (added === 0) break;
      }
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      return {
        workspace_id: workspaceId,
        generated_at: page.generated_at,
        total: Math.max(page.total, asks.length),
        truncated,
        asks,
      };
    },

    async waitingTodos(workspaceId): Promise<WaitingTodosQueue | null> {
      const { c, pinned } = resolvePinnedClient();
      const PAGE_LIMIT = 50;
      const MAX_PAGES = 20;
      const { data, error } = await c.schema('swarm_read').rpc('waiting_todos_page', {
        p_workspace_id: workspaceId,
        p_limit: PAGE_LIMIT,
      });
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      if (error && homeToolsMissing({ code: error.code })) throw new HomeToolsUnavailable();
      if (error) throw new Error('home_waiting_todos_failed');
      const first = parseWaitingTodosQueue(data, workspaceId);
      if (!first || (!first.truncated && first.todos.length >= first.total)) return first;
      const todos = [...first.todos];
      const seen = new Set(todos.map(todo => todo.todo_id));
      let page = first;
      let truncated = true;
      let pages = 1;
      while (truncated && pages < MAX_PAGES && page.todos.length > 0) {
        if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
        const last = page.todos[page.todos.length - 1]!;
        let next: WaitingTodosQueue | null = null;
        let pageFailed = false;
        try {
          const paged = await c.schema('swarm_read').rpc('waiting_todos_page', {
            p_workspace_id: workspaceId,
            p_limit: PAGE_LIMIT,
            p_after_state_at: last.state_at,
            p_after_todo_id: last.todo_id,
          });
          if (paged.error) pageFailed = true;
          else next = parseWaitingTodosQueue(paged.data, workspaceId);
        } catch {
          pageFailed = true;
        }
        // C2: Guard after every page OUTSIDE the partial-queue catch so a view change
        // throws and drops prior-account rows instead of returning a stale partial queue.
        if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
        if (pageFailed || !next) break;
        let added = 0;
        for (const todo of next.todos) {
          if (seen.has(todo.todo_id)) continue;
          seen.add(todo.todo_id);
          todos.push(todo);
          added += 1;
        }
        page = next;
        pages += 1;
        if (!next.truncated) {
          truncated = false;
          break;
        }
        if (added === 0) break;
      }
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      return {
        workspace_id: workspaceId,
        generated_at: page.generated_at,
        total: Math.max(page.total, todos.length),
        truncated,
        todos,
      };
    },

    async waitingArchived(workspaceId, options = {}): Promise<WaitingArchivedPage | null> {
      const { c, pinned } = resolvePinnedClient();
      const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
      const params: Record<string, unknown> = { p_workspace_id: workspaceId, p_limit: limit };
      if (options.after) {
        params.p_after_archived_at = options.after.archived_at;
        params.p_after_item_key = options.after.item_key;
      }
      const { data, error, status } = await c.schema('swarm_read').rpc('waiting_archived_page', params);
      if (pinned && !pinned.isCurrent()) throw new HomeCommandRefused('workspace_access_refused');
      if (error && homeToolsMissing({ code: error.code })) throw new HomeToolsUnavailable();
      if (error && isArchivedAuthDenied({ code: error.code, status })) throw new HomeArchivedDeniedError();
      if (error) throw new Error('home_waiting_archived_failed');
      return parseWaitingArchivedPage(data, workspaceId);
    },

    async activity(workspaceId, since, limit): Promise<ActivityItem[]> {
      const body = parseOkBody(await householdSurface(resolved, session, workspaceId, crypto.randomUUID(), {
        kind: 'household_activity',
        since,
        limit,
      }, 'The activity could not be loaded. Reload to try again.', pinOptions));
      return readArray<ActivityItem>(body.items);
    },

    async listTodos(workspaceId, q) {
      const args: Record<string, unknown> = { scope: q.scope, offset: q.offset, limit: boundedLimit(q.limit, 50) };
      if (q.assignee) args.assignee = q.assignee;
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'todo_list', args, 'The to-dos could not be loaded. Reload to try again.', false, pinOptions));
      return {
        todos: readArray<TodoSummary>(body.todos),
        next_offset: pageOffset(body.next_offset),
      };
    },

    async readTodo(workspaceId, todoId, commentOffset = 0) {
      const args: Record<string, unknown> = { todo_id: todoId, comment_offset: commentOffset };
      const body = parseOkBody(await householdTool(resolved, session, workspaceId, crypto.randomUUID(), 'todo_read', args, 'The to-do could not be loaded. Reload to try again.', false, pinOptions));
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
      }, 'The comments could not be loaded. Reload to try again.', false, pinOptions));
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
      }, 'The line could not be loaded. Reload to try again.', false, pinOptions));
      return parseAgentQueue(body);
    },

    async createTodo(workspaceId, input, requestId) {
      const args: Record<string, unknown> = { title: input.title };
      if (input.notes !== undefined) args.notes = input.notes;
      if (input.due_on !== undefined) args.due_on = input.due_on;
      if (input.assign) args.assign = input.assign;
      if (input.origin_placement !== undefined) args.origin_placement = input.origin_placement;
      if (input.origin_channel_id !== undefined) args.origin_channel_id = input.origin_channel_id;
      if (input.origin_conversation_id !== undefined) args.origin_conversation_id = input.origin_conversation_id;
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_create', args, 'The to-do may or may not have been saved. Reload to check.', true, pinOptions);
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
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_update', args, 'The to-do may or may not have been updated. Reload to check.', true, pinOptions);
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
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_assign', args, 'The assignment may or may not have changed. Reload to check.', true, pinOptions);
      return parseWriteResult<Todo>(body);
    },

    async setTodoState(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_set_state', {
        todo_id: input.todo_id,
        base_version: input.base_version,
        state: input.state,
      }, 'The to-do state may or may not have changed. Reload to check.', true, pinOptions);
      return parseWriteResult<Todo>(body);
    },

    async startTodo(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_start', {
        todo_id: input.todo_id,
      }, 'The to-do may or may not be in Doing. Reload to check.', true, pinOptions);
      return parseWriteResult<Todo>(body);
    },

    async answerRequest(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_todo_answer',
        todo_id: input.todo_id,
        offer_id: input.offer_id,
        answer: input.answer,
      }, 'The request may or may not have been answered. Reload to check.', pinOptions);
      return parseWriteResult<Todo>(body);
    },

    async steerQueue(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_todo_steer',
        todo_id: input.todo_id,
        base_version: input.base_version,
        action: input.action,
      }, 'The line may or may not have changed. Reload to check.', pinOptions);
      return parseWriteResult<Todo>(body);
    },

    async setWorkPolicy(workspaceId, input, requestId) {
      const body = await householdSurface(resolved, session, workspaceId, requestId, {
        kind: 'household_agent_work_policy',
        principal_id: input.principal_id,
        accepts_from: input.accepts_from,
      }, 'Who can give this agent work may or may not have changed. Reload to check.', pinOptions);
      return parseWriteResult(body);
    },

    async comment(workspaceId, input, requestId) {
      const body = await householdTool(resolved, session, workspaceId, requestId, 'todo_comment', {
        target: input.target,
        body: input.body,
        mentions: input.mentions,
      }, 'The comment may or may not have been posted. Reload to check.', true, pinOptions);
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

    async decisionQueue(workspaceId) {
      const row = fixtures.overview.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
      if (!row) return null;
      const asks = [...row.needs_you.asks].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.signal_id.localeCompare(b.signal_id));
      return { workspace_id: workspaceId, generated_at: fixtures.overview.generated_at, total: asks.length, truncated: false,
        asks: asks.map((ask) => ({ signal_id: ask.signal_id, from: { ...ask.from, name: null }, body: '', created_at: ask.created_at,
          until: ask.until, reraised: null })) };
    },

    async waitingTodos(workspaceId) {
      const row = fixtures.overview.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
      if (!row) return null;
      const byId = new Map<string, WaitingTodoEntry>();
      const order: string[] = [];
      for (const todo of row.needs_you.assigned) {
        if (todo.state === 'done' || todo.state === 'dropped') continue;
        byId.set(todo.todo_id, {
          todo_id: todo.todo_id, title: todo.title, state: todo.state === 'doing' ? 'doing' : 'open',
          due_on: todo.due_on, reason: 'assigned', agent_id: null, state_at: fixtures.overview.generated_at,
          placement: 'workspace', channel_id: null,
        });
        order.push(todo.todo_id);
      }
      for (const todo of row.needs_you.waiting) {
        if (todo.state === 'done' || todo.state === 'dropped') continue;
        const entry: WaitingTodoEntry = {
          todo_id: todo.todo_id, title: todo.title, state: todo.state === 'doing' ? 'doing' : 'open',
          due_on: todo.due_on, reason: todo.reason, agent_id: todo.agent_id, state_at: fixtures.overview.generated_at,
          placement: 'workspace', channel_id: null,
        };
        if (!byId.has(todo.todo_id)) { byId.set(todo.todo_id, entry); order.push(todo.todo_id); }
        else if (todo.reason === 'request') byId.set(todo.todo_id, entry);
      }
      const todos = order.map(id => byId.get(id)!).filter(Boolean);
      return { workspace_id: workspaceId, generated_at: fixtures.overview.generated_at, total: todos.length, truncated: false, todos };
    },

    async waitingArchived(workspaceId) {
      const row = fixtures.overview.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
      if (!row) return null;
      return { workspace_id: workspaceId, generated_at: fixtures.overview.generated_at, total: 0, truncated: false, items: [] };
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
