// Copied pure decoders from site/src/lib/home/client.ts (lines 68-70, 214-402) and
// site/src/lib/home-map.ts (lines 448-450) at commit 1cbfcccfde5e68a6db19272ee504d66a25a66fc9,
// plus strict HomeOverview validation for fail-closed decoding.

import type {
  AgentWorkStatus,
  DecisionAsk,
  DecisionQueue,
  HomeOverview,
  Uuid,
  WaitingArchivedEntry,
  WaitingArchivedKind,
  WaitingArchivedOutcomeKind,
  WaitingArchivedPage,
  WaitingArchivedPlacement,
  WaitingTodoEntry,
  WaitingTodoPlacement,
  WaitingTodosQueue,
  WorkspaceCatchUp,
} from './home-contract.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isoTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const DECISION_CONVERSATION_KINDS = new Set([
  'general',
  'public_channel',
  'private_channel',
  'dm',
  'group_dm',
]);

function decisionAsk(value: unknown): DecisionAsk {
  if (
    !record(value) ||
    typeof value.signal_id !== 'string' ||
    !record(value.from) ||
    (value.from.kind !== 'agent' && value.from.kind !== 'user') ||
    typeof value.from.id !== 'string' ||
    (value.from.name !== null && typeof value.from.name !== 'string') ||
    typeof value.body !== 'string' ||
    !isoTime(value.created_at) ||
    !isoTime(value.until)
  ) {
    throw new Error('home_decision_queue_malformed');
  }
  const reraised = value.reraised;
  if (
    reraised !== null &&
    !(
      record(reraised) &&
      count(reraised.count) &&
      reraised.count > 0 &&
      isoTime(reraised.last_at)
    )
  ) {
    throw new Error('home_decision_queue_malformed');
  }
  let conversationId: string | null | undefined;
  if (value.conversation_id !== undefined) {
    if (
      value.conversation_id !== null &&
      typeof value.conversation_id !== 'string'
    ) {
      throw new Error('home_decision_queue_malformed');
    }
    conversationId =
      typeof value.conversation_id === 'string' && value.conversation_id.trim()
        ? value.conversation_id.trim().toLowerCase()
        : null;
  }
  let conversationKind: DecisionAsk['conversation_kind'];
  if (value.conversation_kind !== undefined) {
    if (
      value.conversation_kind !== null &&
      (typeof value.conversation_kind !== 'string' ||
        !DECISION_CONVERSATION_KINDS.has(value.conversation_kind))
    ) {
      throw new Error('home_decision_queue_malformed');
    }
    conversationKind = value.conversation_kind as DecisionAsk['conversation_kind'];
  }
  return {
    signal_id: value.signal_id,
    from: { kind: value.from.kind, id: value.from.id, name: value.from.name },
    body: value.body,
    created_at: value.created_at,
    until: value.until,
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(conversationKind !== undefined
      ? { conversation_kind: conversationKind }
      : {}),
    reraised:
      reraised === null
        ? null
        : {
            count: reraised.count as number,
            last_at: reraised.last_at as string,
          },
  };
}

/** Validates swarm_read.decision_queue. NULL (not a member) stays null; anything else malformed throws. Server order is kept. */
export function parseDecisionQueue(
  data: unknown,
  workspaceId: Uuid,
): DecisionQueue | null {
  if (data === null) return null;
  if (
    !record(data) ||
    data.workspace_id !== workspaceId ||
    !isoTime(data.generated_at) ||
    !count(data.total) ||
    typeof data.truncated !== 'boolean' ||
    !Array.isArray(data.asks) ||
    data.asks.length > data.total
  ) {
    throw new Error('home_decision_queue_malformed');
  }
  return {
    workspace_id: workspaceId,
    generated_at: data.generated_at,
    total: data.total,
    truncated: data.truncated,
    asks: data.asks.map(decisionAsk),
  };
}

const WAITING_TODO_REASONS = new Set([
  'assigned',
  'request',
  'after',
  'hold',
  'agent_removed',
]);
const WAITING_TODO_PLACEMENTS = new Set<WaitingTodoPlacement>([
  'channel',
  'general',
  'workspace',
  'dm',
  'group_dm',
]);

function waitingTodoEntry(value: unknown): WaitingTodoEntry {
  if (
    !record(value) ||
    typeof value.todo_id !== 'string' ||
    typeof value.title !== 'string' ||
    (value.state !== 'open' && value.state !== 'doing') ||
    (value.due_on !== null && typeof value.due_on !== 'string') ||
    typeof value.reason !== 'string' ||
    !WAITING_TODO_REASONS.has(value.reason) ||
    (value.agent_id !== null && typeof value.agent_id !== 'string') ||
    !isoTime(value.state_at) ||
    typeof value.placement !== 'string' ||
    !WAITING_TODO_PLACEMENTS.has(value.placement as WaitingTodoPlacement) ||
    (value.channel_id !== null && typeof value.channel_id !== 'string') ||
    (value.conversation_id !== undefined &&
      value.conversation_id !== null &&
      typeof value.conversation_id !== 'string')
  ) {
    throw new Error('home_waiting_todos_malformed');
  }
  const placement = value.placement as WaitingTodoPlacement;
  const rawConvId =
    typeof value.conversation_id === 'string' && value.conversation_id.trim()
      ? value.conversation_id.trim().toLowerCase()
      : null;
  if (placement === 'channel' && (!value.channel_id || rawConvId !== null)) {
    throw new Error('home_waiting_todos_malformed');
  }
  if (
    (placement === 'dm' || placement === 'group_dm') &&
    (!rawConvId || value.channel_id !== null)
  ) {
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
    conversation_id:
      placement === 'dm' || placement === 'group_dm' ? rawConvId : null,
  };
}

/** Validates swarm_read.waiting_todos_page. NULL (not a member) stays null; malformed throws. */
export function parseWaitingTodosQueue(
  data: unknown,
  workspaceId: Uuid,
): WaitingTodosQueue | null {
  if (data === null) return null;
  if (
    !record(data) ||
    data.workspace_id !== workspaceId ||
    !isoTime(data.generated_at) ||
    !count(data.total) ||
    typeof data.truncated !== 'boolean' ||
    !Array.isArray(data.todos) ||
    data.todos.length > data.total
  ) {
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

const WAITING_ARCHIVED_KINDS = new Set<WaitingArchivedKind>([
  'ask',
  'todo',
  'review',
]);
const WAITING_ARCHIVED_OUTCOMES = new Set<WaitingArchivedOutcomeKind>([
  'answered',
  'cleared_stale',
  'done',
  'dropped',
  'accepted',
  'declined',
]);
const WAITING_ARCHIVED_PLACEMENTS = new Set<WaitingArchivedPlacement>([
  'channel',
  'general',
  'dm',
  'group_dm',
  'workspace',
  'redacted',
]);

function waitingArchivedEntry(value: unknown): WaitingArchivedEntry {
  if (
    !record(value) ||
    typeof value.item_key !== 'string' ||
    !value.item_key ||
    typeof value.kind !== 'string' ||
    !WAITING_ARCHIVED_KINDS.has(value.kind as WaitingArchivedKind) ||
    typeof value.id !== 'string' ||
    (value.todo_id !== null && typeof value.todo_id !== 'string') ||
    (value.ask_kind !== null &&
      value.ask_kind !== 'choice' &&
      value.ask_kind !== 'plain') ||
    typeof value.title !== 'string' ||
    typeof value.outcome_kind !== 'string' ||
    !WAITING_ARCHIVED_OUTCOMES.has(
      value.outcome_kind as WaitingArchivedOutcomeKind,
    ) ||
    typeof value.outcome_text !== 'string' ||
    !isoTime(value.archived_at) ||
    typeof value.placement !== 'string' ||
    !WAITING_ARCHIVED_PLACEMENTS.has(
      value.placement as WaitingArchivedPlacement,
    ) ||
    (value.channel_id !== null && typeof value.channel_id !== 'string') ||
    (value.conversation_id !== null &&
      typeof value.conversation_id !== 'string') ||
    (value.conversation_kind !== null &&
      (typeof value.conversation_kind !== 'string' ||
        !DECISION_CONVERSATION_KINDS.has(value.conversation_kind)))
  ) {
    throw new Error('home_waiting_archived_malformed');
  }
  let from: WaitingArchivedEntry['from'] = null;
  if (value.from !== null) {
    if (
      !record(value.from) ||
      (value.from.kind !== 'agent' && value.from.kind !== 'user') ||
      typeof value.from.id !== 'string' ||
      (value.from.name !== null && typeof value.from.name !== 'string')
    ) {
      throw new Error('home_waiting_archived_malformed');
    }
    from = { kind: value.from.kind, id: value.from.id, name: value.from.name };
  }
  let answeredBy: WaitingArchivedEntry['answered_by'] = null;
  if (value.answered_by !== null) {
    if (
      !record(value.answered_by) ||
      (value.answered_by.kind !== 'agent' &&
        value.answered_by.kind !== 'user') ||
      typeof value.answered_by.id !== 'string' ||
      (value.answered_by.name !== null &&
        typeof value.answered_by.name !== 'string') ||
      (value.answered_by.by_viewer !== undefined &&
        typeof value.answered_by.by_viewer !== 'boolean')
    ) {
      throw new Error('home_waiting_archived_malformed');
    }
    answeredBy = {
      kind: value.answered_by.kind,
      id: value.answered_by.id,
      name: value.answered_by.name,
      ...(value.answered_by.by_viewer !== undefined
        ? { by_viewer: value.answered_by.by_viewer }
        : {}),
    };
  }
  const placement = value.placement as WaitingArchivedPlacement;
  const channelId =
    typeof value.channel_id === 'string' && value.channel_id.trim()
      ? value.channel_id.trim().toLowerCase()
      : null;
  const conversationId =
    typeof value.conversation_id === 'string' && value.conversation_id.trim()
      ? value.conversation_id.trim().toLowerCase()
      : null;
  if (placement === 'channel' && !channelId) {
    throw new Error('home_waiting_archived_malformed');
  }
  if (
    (placement === 'dm' || placement === 'group_dm') &&
    (!conversationId || channelId !== null)
  ) {
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
    outcome_kind: value.outcome_kind as WaitingArchivedOutcomeKind,
    outcome_text: value.outcome_text,
    archived_at: value.archived_at,
    answered_by: answeredBy,
    placement,
    channel_id: placement === 'channel' ? channelId : null,
    conversation_id:
      placement === 'workspace' || placement === 'redacted'
        ? null
        : conversationId,
    conversation_kind:
      placement === 'workspace' || placement === 'redacted'
        ? null
        : (value.conversation_kind as WaitingArchivedEntry['conversation_kind']),
  };
}

/** Validates swarm_read.waiting_archived_page. NULL (not a member) stays null; malformed throws. */
export function parseWaitingArchivedPage(
  data: unknown,
  workspaceId: Uuid,
): WaitingArchivedPage | null {
  if (data === null) return null;
  if (
    !record(data) ||
    data.workspace_id !== workspaceId ||
    !isoTime(data.generated_at) ||
    !count(data.total) ||
    typeof data.truncated !== 'boolean' ||
    !Array.isArray(data.items) ||
    data.items.length > data.total
  ) {
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

/** Only an absent rollout endpoint permits compatibility reads. Refused/failed reads stay visible. */
export function homeOverviewUnavailable(
  status: number | undefined,
  code: string | undefined,
): boolean {
  return status === 404 || code === 'PGRST202' || code === '42883';
}

const VALID_ROLES = new Set(['owner', 'admin', 'member']);
const VALID_AGENT_WORK = new Set(['working', 'idle', 'disconnected']);
const VALID_AGENT_CONNECTIONS = new Set([
  'live',
  'removed',
  'connection_off',
  'key_off',
  'key_ended',
  'paused',
]);

function parseAgentWorkStatus(value: unknown): AgentWorkStatus {
  if (
    !record(value) ||
    typeof value.work !== 'string' ||
    !VALID_AGENT_WORK.has(value.work) ||
    !record(value.facts) ||
    (value.facts.transport !== 'local' &&
      value.facts.transport !== 'hosted_mcp') ||
    typeof value.facts.turn_only !== 'boolean' ||
    typeof value.facts.connection !== 'string' ||
    !VALID_AGENT_CONNECTIONS.has(value.facts.connection) ||
    (value.facts.last_activity_at !== null &&
      typeof value.facts.last_activity_at !== 'string') ||
    (value.facts.messages_waiting_since !== null &&
      typeof value.facts.messages_waiting_since !== 'string')
  ) {
    throw new Error('home_overview_malformed');
  }
  return value as unknown as AgentWorkStatus;
}

function parseWorkspaceCatchUp(value: unknown): WorkspaceCatchUp {
  if (
    !record(value) ||
    typeof value.workspace_id !== 'string' ||
    !value.workspace_id.trim() ||
    typeof value.name !== 'string' ||
    typeof value.role !== 'string' ||
    !VALID_ROLES.has(value.role) ||
    !Array.isArray(value.people) ||
    !record(value.needs_you) ||
    !Array.isArray(value.needs_you.asks) ||
    !Array.isArray(value.needs_you.assigned) ||
    !Array.isArray(value.needs_you.waiting)
  ) {
    throw new Error('home_overview_malformed');
  }
  for (const person of value.people) {
    if (
      !record(person) ||
      typeof person.user_id !== 'string' ||
      typeof person.display_name !== 'string' ||
      typeof person.role !== 'string' ||
      !VALID_ROLES.has(person.role) ||
      !Array.isArray(person.agents)
    ) {
      throw new Error('home_overview_malformed');
    }
    for (const agent of person.agents) {
      if (
        !record(agent) ||
        typeof agent.principal_id !== 'string' ||
        typeof agent.name !== 'string'
      ) {
        throw new Error('home_overview_malformed');
      }
      parseAgentWorkStatus(agent.status);
    }
  }
  return value as unknown as WorkspaceCatchUp;
}

/** Validates swarm_read.home_overview strictly. Malformed payloads throw instead of returning partial state. */
export function parseHomeOverview(data: unknown): HomeOverview {
  if (
    !record(data) ||
    typeof data.viewer_user_id !== 'string' ||
    !data.viewer_user_id.trim() ||
    !isoTime(data.generated_at) ||
    !Array.isArray(data.workspaces)
  ) {
    throw new Error('home_overview_malformed');
  }
  const workspaces = data.workspaces.map(parseWorkspaceCatchUp);
  return {
    viewer_user_id: data.viewer_user_id,
    generated_at: data.generated_at,
    workspaces,
  };
}
