import type {
  AgentPrincipalRow,
  AgentWakePathRow,
  MemberProfileRow,
  MyWorkspace,
} from './api';
import type { AgentPresenceRow } from './contracts/agent-presence';
import {
  conversationTitle,
  conversationUnreadBadge,
  isChannelKind,
  sortDirectConversations,
  type ConversationMemberRef,
  type ConversationSummary,
} from './contracts/conversations';
import type {
  AgentWorkStatus,
  DecisionQueue,
  HomeOverview,
  WaitingTodosQueue,
} from './contracts/home-contract';
import {
  classifySeatStatus,
  formatSeatAgo,
  formatSeatElapsed,
} from './contracts/seat-status';
import type {
  Agent,
  AgentState,
  AvatarTone,
  Channel,
  Person,
  SidebarDirectMessage,
  Workspace,
} from './types';

const AGENT_TONES: readonly AvatarTone[] = ['purple', 'green', 'blue', 'amber'];
const PERSON_TONES: readonly AvatarTone[] = [
  'maya',
  'jonas',
  'blue',
  'purple',
  'green',
  'amber',
];

function hashIndex(id: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function firstInitial(name: string): string {
  const trimmed = name.trim();
  const char = Array.from(trimmed)[0];
  return char ? char.toUpperCase() : '?';
}

function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return Array.from(words[0]!).slice(0, 2).join('').toUpperCase();
  }
  const first = Array.from(words[0]!)[0] ?? '';
  const last = Array.from(words[words.length - 1]!)[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

export function adaptWorkspaces(
  workspaces: readonly MyWorkspace[],
  activeWorkspaceId: string | null,
): Workspace[] {
  const normalizedActive = activeWorkspaceId?.toLowerCase() ?? null;
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    initial: firstInitial(ws.name),
    active: normalizedActive !== null && ws.id.toLowerCase() === normalizedActive,
  }));
}

export function adaptChannels(
  conversations: readonly ConversationSummary[],
): Channel[] {
  const liveChannels = conversations.filter(
    (conv) =>
      isChannelKind(conv.kind) &&
      conv.archivedAt === null &&
      (conv.kind !== 'private_channel' || conv.joined),
  );

  const sorted = [...liveChannels].sort((left, right) => {
    if (left.kind === 'general' && right.kind !== 'general') return -1;
    if (right.kind === 'general' && left.kind !== 'general') return 1;
    const leftName = (left.slug ?? left.conversationId).toLowerCase();
    const rightName = (right.slug ?? right.conversationId).toLowerCase();
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });

  return sorted.map((conv) => {
    const badge = conversationUnreadBadge(conv);
    const muted = conv.notifyLevel === 'muted';
    const unreadCount = muted ? 0 : Math.max(0, Math.floor(conv.unreadCount ?? 0));
    const mentionCount = muted
      ? 0
      : Math.max(0, Math.floor(conv.mentionCount ?? 0));
    const name =
      conv.kind === 'general'
        ? 'general'
        : conv.slug && conv.slug.trim().length > 0
          ? conv.slug.trim()
          : conv.conversationId;

    return {
      id: conv.conversationId,
      name,
      kind: conv.kind as 'general' | 'public_channel' | 'private_channel',
      isPrivate: conv.kind === 'private_channel',
      unread: badge.kind !== 'none',
      unreadCount,
      mentionCount,
      muted,
      peopleCount: conv.members.filter((m) => m.kind === 'user' && !m.leftAt)
        .length,
      agentIds: conv.members
        .filter((m) => m.kind === 'agent' && !m.leftAt)
        .map((m) => m.id),
      messages: [],
    };
  });
}

export function adaptDirectMessages(
  conversations: readonly ConversationSummary[],
  viewerUserId: string,
  members: readonly MemberProfileRow[],
  agents: readonly AgentPrincipalRow[],
): SidebarDirectMessage[] {
  const joinedDirect = conversations.filter(
    (conv) =>
      (conv.kind === 'dm' || conv.kind === 'group_dm') &&
      conv.archivedAt === null &&
      conv.joined,
  );

  const memberNames = new Map(
    members.map((m) => [m.userId.toLowerCase(), m.name]),
  );
  const agentNames = new Map(
    agents.map((a) => [a.principalId.toLowerCase(), a.name]),
  );

  const lookupName = (member: ConversationMemberRef): string | null => {
    const id = member.id.toLowerCase();
    return member.kind === 'agent'
      ? (agentNames.get(id) ?? null)
      : (memberNames.get(id) ?? null);
  };

  return sortDirectConversations(joinedDirect).map((conv) => {
    const badge = conversationUnreadBadge(conv);
    const muted = conv.notifyLevel === 'muted';
    return {
      id: conv.conversationId,
      kind: conv.kind as 'dm' | 'group_dm',
      title: conversationTitle(conv, viewerUserId.toLowerCase(), lookupName),
      unread: badge.kind !== 'none',
      unreadCount: muted ? 0 : Math.max(0, Math.floor(conv.unreadCount ?? 0)),
      mentionCount: muted ? 0 : Math.max(0, Math.floor(conv.mentionCount ?? 0)),
      muted,
    };
  });
}

export interface AdaptAgentsInput {
  readonly workspaceId: string;
  readonly principals: readonly AgentPrincipalRow[];
  readonly presence?: ReadonlyMap<string, AgentPresenceRow> | null;
  readonly wakePath?: ReadonlyMap<string, AgentWakePathRow> | null;
  readonly overview?: HomeOverview | null;
  readonly decisionQueue?: DecisionQueue | null;
  readonly now?: number;
}

/**
 * Map server agent rows + presence + wake path + overview + asks to sidebar `Agent` models.
 *
 * Truth rules:
 * - No `computerId`, no `harnessId`, no `folder`, no `mode`, no `sessionMeta` (absent, not invented).
 * - Fault status (`seatStatus.attention === true`) maps to `state: 'waiting'` with the real `seatStatus.line`.
 * - Open ask addressed to the viewer maps to `state: 'waiting'` with `'Needs you'` (unless a fault already owns the line).
 * - `seatStatus.kind === 'working'` maps to `state: 'working'` with `seatStatus.line`.
 * - Everything else maps to `state: 'idle'` with `seatStatus.line`.
 */
export function adaptAgents(input: AdaptAgentsInput): Agent[] {
  const now = input.now ?? Date.now();
  const normalizedWorkspace = input.workspaceId.toLowerCase();

  const overviewWorkspace = input.overview?.workspaces.find(
    (ws) => ws.workspace_id.toLowerCase() === normalizedWorkspace,
  );
  const overviewStatusByPrincipal = new Map<string, AgentWorkStatus>();
  if (overviewWorkspace) {
    for (const person of overviewWorkspace.people) {
      for (const agent of person.agents) {
        overviewStatusByPrincipal.set(
          agent.principal_id.toLowerCase(),
          agent.status,
        );
      }
    }
  }

  const agentsWithOpenAsk = new Set<string>();
  if (input.decisionQueue) {
    for (const ask of input.decisionQueue.asks) {
      if (ask.from.kind === 'agent') {
        agentsWithOpenAsk.add(ask.from.id.toLowerCase());
      }
    }
  } else if (overviewWorkspace) {
    for (const ask of overviewWorkspace.needs_you.asks) {
      if (ask.from.kind === 'agent') {
        agentsWithOpenAsk.add(ask.from.id.toLowerCase());
      }
    }
  }

  return input.principals.map((principal) => {
    const id = principal.principalId.toLowerCase();
    const overviewStatus = overviewStatusByPrincipal.get(id);
    const facts = overviewStatus?.facts;
    const wake = input.wakePath?.get(id);
    const hasPresenceMap =
      input.presence !== undefined && input.presence !== null;
    const presenceRow = hasPresenceMap
      ? (input.presence.get(id) ?? null)
      : undefined;

    const seatStatus = classifySeatStatus(
      {
        transport: facts?.transport ?? principal.transport,
        turnOnly: facts?.turn_only ?? principal.turnOnly,
        connection: facts?.connection,
        revoked: facts?.connection === 'removed',
        presence: presenceRow,
        wake: facts?.wake,
        lastActivityAt: facts?.last_activity_at,
        workingOn: facts?.working_on
          ? {
              since: facts.working_on.at,
              until: facts.working_on.until,
              text: null,
              scope: 'private_channel',
            }
          : null,
        doingTodo: facts?.doing ? { since: facts.doing.since } : null,
        serverWork: overviewStatus?.work,
        waitingSince:
          facts?.messages_waiting_since ?? wake?.oldestUnobservedAt ?? null,
        unseenCount:
          facts?.messages_waiting_count ?? wake?.unseenCount ?? null,
        statusUnavailable: !hasPresenceMap && !overviewStatus,
      },
      now,
    );

    const hasOpenAsk = agentsWithOpenAsk.has(id);

    let state: AgentState;
    let sidebarStateLabel: string;
    if (seatStatus.attention) {
      state = 'waiting';
      sidebarStateLabel = seatStatus.line;
    } else if (hasOpenAsk) {
      state = 'waiting';
      sidebarStateLabel = 'Needs you';
    } else if (seatStatus.kind === 'working') {
      state = 'working';
      sidebarStateLabel = seatStatus.line;
    } else {
      state = 'idle';
      sidebarStateLabel = seatStatus.line;
    }

    const stateElapsed =
      seatStatus.age_ms !== null
        ? seatStatus.kind === 'working'
          ? formatSeatElapsed(seatStatus.age_ms)
          : formatSeatAgo(seatStatus.age_ms)
        : '';

    const displayName = principal.name.trim() || principal.principalId;

    return {
      id: principal.principalId,
      name: displayName,
      initial: firstInitial(displayName),
      tone: AGENT_TONES[hashIndex(id, AGENT_TONES.length)] ?? 'purple',
      state,
      stateElapsed,
      sidebarStateLabel,
      channelActivity: seatStatus.line,
      model: principal.model ?? '',
      events: [],
    };
  });
}

/**
 * Map `member_profiles` to sidebar `Person` rows.
 * `presence` is intentionally omitted because the backend has no human presence data.
 */
export function adaptPeople(members: readonly MemberProfileRow[]): Person[] {
  return members.map((member) => ({
    id: member.userId,
    name: member.name,
    initials: personInitials(member.name),
    tone: PERSON_TONES[hashIndex(member.userId, PERSON_TONES.length)] ?? 'maya',
  }));
}

/**
 * Compute Waiting on you count from `decision_queue` + `waiting_todos_page`.
 * Returns `null` when either source is absent/unloaded so an unknown count never fakes zero.
 */
export function adaptWaitingCount(
  decisionQueue: DecisionQueue | null | undefined,
  waitingTodos: WaitingTodosQueue | null | undefined,
): number | null {
  if (!decisionQueue || !waitingTodos) return null;
  return decisionQueue.total + waitingTodos.total;
}
