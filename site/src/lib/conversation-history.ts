/**
 * Conversations Step 3D-1: pure state, paired-cursor pagination, strict #general / All messages
 * DM exclusion, fail-closed send gating, and local state/draft clearing for Step 2b
 * `conversation_history` and `post_signal({ conversation_id })`.
 */
import { GENERAL_CHANNEL_ID } from "./channels.js";
import {
  CONVERSATION_UNAVAILABLE_TEXT,
  DM_ATTACHMENTS_REFUSAL_TEXT,
  isDirectKind,
  type ConversationCursor,
  type ConversationHistoryResult,
  type ConversationKind,
  type ConversationSummary,
} from "./conversations.js";

export interface ConversationHistorySignal {
  id: string;
  createdAt: string;
  body?: string;
  channelId: string | null;
  to: string | null;
  toAgent: string | null;
  conversationId?: string | null;
  conversationKind?: ConversationKind | null;
}

export type ConversationHistoryStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export interface ConversationHistoryState<T extends ConversationHistorySignal = ConversationHistorySignal> {
  workspaceId: string;
  viewerId: string;
  conversationId: string;
  status: ConversationHistoryStatus;
  errorMessage: string;
  conversation: ConversationSummary | null;
  rows: T[];
  hasMore: boolean;
  nextBefore: ConversationCursor | null;
  nextAfter: ConversationCursor | null;
  olderLoading: boolean;
  olderError: string;
}

export type ActiveConversationHistoryTarget =
  | { mode: "conversation"; conversationId: string; isDm: boolean; kind: ConversationKind | null }
  | { mode: "all-signals" }
  | { mode: "legacy" };

/** Canonical feed ordering matching the server's `(created_at DESC, id DESC)` index. */
export function compareSignalsDesc(
  a: Pick<ConversationHistorySignal, "createdAt" | "id">,
  b: Pick<ConversationHistorySignal, "createdAt" | "id">,
): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export function createConversationHistoryState<T extends ConversationHistorySignal>(
  workspaceId: string,
  viewerId: string,
  conversationId: string,
): ConversationHistoryState<T> {
  return {
    workspaceId,
    viewerId,
    conversationId,
    status: "loading",
    errorMessage: "",
    conversation: null,
    rows: [],
    hasMore: false,
    nextBefore: null,
    nextAfter: null,
    olderLoading: false,
    olderError: "",
  };
}

/** Uniform non-oracle unavailable state: clears every client-held row and cursor immediately. */
export function unavailableConversationHistoryState<T extends ConversationHistorySignal>(
  workspaceId: string,
  viewerId: string,
  conversationId: string,
): ConversationHistoryState<T> {
  return {
    workspaceId,
    viewerId,
    conversationId,
    status: "unavailable",
    errorMessage: CONVERSATION_UNAVAILABLE_TEXT,
    conversation: null,
    rows: [],
    hasMore: false,
    nextBefore: null,
    nextAfter: null,
    olderLoading: false,
    olderError: "",
  };
}

function stampConversationRows<T extends ConversationHistorySignal>(
  rows: readonly T[],
  conversation: ConversationSummary,
): T[] {
  return rows.map((row) => ({
    ...row,
    conversationId: row.conversationId ?? conversation.conversationId,
    conversationKind: row.conversationKind ?? conversation.kind,
  }));
}

function dedupeSortDesc<T extends ConversationHistorySignal>(
  primary: readonly T[],
  secondary: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const row of secondary) byId.set(row.id, row);
  // Primary (authoritative server rows) overwrites any optimistic/older copy with the same id.
  for (const row of primary) byId.set(row.id, row);
  return [...byId.values()].sort(compareSignalsDesc);
}

/**
 * Apply the first page of `conversation_history` for an opened conversation.
 * - `404 conversation_not_found`: returns a wiped uniform unavailable state (no existence oracle).
 * - `200`: merges authoritative rows with any in-flight optimistic rows for this conversation.
 */
export function applyConversationHistoryInitial<T extends ConversationHistorySignal>(
  state: ConversationHistoryState<T>,
  result: ConversationHistoryResult<T>,
  optimisticRows: readonly T[] = [],
): ConversationHistoryState<T> {
  if (!result.ok) {
    if (result.code === "conversation_not_found") {
      return unavailableConversationHistoryState<T>(
        state.workspaceId,
        state.viewerId,
        state.conversationId,
      );
    }
    return {
      ...state,
      status: "error",
      errorMessage: result.message,
      olderLoading: false,
    };
  }
  const stamped = stampConversationRows(result.messages, result.conversation);
  const pageFloor = result.hasMore ? stamped.at(-1) ?? null : null;
  const localForConv = optimisticRows.filter((row) => {
    if (row.conversationId && row.conversationId !== result.conversation.conversationId) return false;
    if (pageFloor === null) return true;
    return compareSignalsDesc(row, pageFloor) <= 0;
  });
  const rows = dedupeSortDesc(stamped, localForConv);
  return {
    workspaceId: state.workspaceId,
    viewerId: state.viewerId,
    conversationId: result.conversation.conversationId,
    status: "ready",
    errorMessage: "",
    conversation: result.conversation,
    rows,
    hasMore: result.hasMore,
    nextBefore: result.nextBefore,
    nextAfter: result.nextAfter,
    olderLoading: false,
    olderError: "",
  };
}

/**
 * Apply one older page (`before_created_at`, `before_id`) to a loaded conversation.
 * - `404 conversation_not_found`: immediately wipes all client-held rows and cursors.
 * - Transient error: keeps loaded rows and `nextBefore` intact so Retry works without scroll loss.
 */
export function applyConversationHistoryOlder<T extends ConversationHistorySignal>(
  state: ConversationHistoryState<T>,
  result: ConversationHistoryResult<T>,
): ConversationHistoryState<T> {
  if (!result.ok) {
    if (result.code === "conversation_not_found") {
      return unavailableConversationHistoryState<T>(
        state.workspaceId,
        state.viewerId,
        state.conversationId,
      );
    }
    return {
      ...state,
      olderLoading: false,
      olderError: result.message,
    };
  }
  const stamped = stampConversationRows(result.messages, result.conversation);
  const rows = dedupeSortDesc(stamped, state.rows);
  return {
    ...state,
    status: "ready",
    errorMessage: "",
    conversation: result.conversation,
    rows,
    hasMore: result.hasMore,
    nextBefore: result.nextBefore,
    nextAfter: state.nextAfter ?? result.nextAfter,
    olderLoading: false,
    olderError: "",
  };
}

/**
 * Apply a live/Realtime refresh (`after` cursor or latest head page) onto a loaded conversation.
 * - Preserves older loaded pages and `nextBefore` cursor.
 * - `404 conversation_not_found`: immediately clears rows and cursors (`lostAccess: true`).
 * - Transient error: leaves existing readable history untouched.
 */
export function applyConversationHistoryRefresh<T extends ConversationHistorySignal>(
  state: ConversationHistoryState<T>,
  result: ConversationHistoryResult<T>,
  optimisticRows: readonly T[] = [],
): { state: ConversationHistoryState<T>; changed: boolean; lostAccess: boolean } {
  if (!result.ok) {
    if (result.code === "conversation_not_found") {
      return {
        state: unavailableConversationHistoryState<T>(
          state.workspaceId,
          state.viewerId,
          state.conversationId,
        ),
        changed: state.status !== "unavailable" || state.rows.length > 0,
        lostAccess: true,
      };
    }
    return { state, changed: false, lostAccess: false };
  }
  const stamped = stampConversationRows(result.messages, result.conversation);
  const localForConv = optimisticRows.filter(
    (row) => !row.conversationId || row.conversationId === result.conversation.conversationId,
  );
  const combinedExisting = state.rows.length > 0 ? [...localForConv, ...state.rows] : localForConv;
  const rows = dedupeSortDesc(stamped, combinedExisting);
  const changed =
    state.status !== "ready" ||
    rows.length !== state.rows.length ||
    rows.some((row, i) => row.id !== state.rows[i]?.id || row.body !== state.rows[i]?.body);
  const preserveOlder = state.rows.length > 0;
  return {
    state: {
      ...state,
      status: "ready",
      errorMessage: "",
      conversation: result.conversation,
      rows,
      hasMore: preserveOlder ? state.hasMore || result.hasMore : result.hasMore,
      nextBefore: preserveOlder ? state.nextBefore ?? result.nextBefore : result.nextBefore,
      nextAfter: result.nextAfter ?? state.nextAfter,
    },
    changed,
    lostAccess: false,
  };
}

export interface DirectExclusionOptions {
  /** True ONLY when the server explicitly returned ConversationsUnsupportedError (pre-Step-2b). */
  legacyUnsupported?: boolean;
}

/**
 * Determine whether a signal belongs to a direct message or group DM and must therefore be
 * excluded from `#general` and `All messages`.
 *
 * Fail-closed on modern servers: even when `conversations` is `null` (discovery pending or 503)
 * and the legacy PostgREST projection omits `conversation_id`, unfiled addressed rows
 * (`channelId === null && (to !== null || toAgent !== null)`) are excluded unless the server
 * explicitly declared pre-Step-2b `legacyUnsupported`.
 */
export function isDirectConversationRow(
  row: ConversationHistorySignal,
  conversations: readonly ConversationSummary[] | null,
  options?: DirectExclusionOptions,
): boolean {
  if (row.conversationKind === "dm" || row.conversationKind === "group_dm") return true;
  if (conversations === null) {
    if (options?.legacyUnsupported === true) return false;
    return row.channelId === null && (row.to !== null || row.toAgent !== null);
  }
  let generalId: string | null = null;
  for (const conv of conversations) {
    if (conv.kind === "general") generalId = conv.conversationId;
    if (row.conversationId && conv.conversationId === row.conversationId) {
      return isDirectKind(conv.kind);
    }
  }
  // Under Step 2b, unfiled addressed rows (channelId === null with a recipient) belong to DMs/group DMs,
  // never to #general or All messages, unless explicitly filed in #general.
  if (row.channelId === null && (row.to !== null || row.toAgent !== null)) {
    return !row.conversationId || row.conversationId !== generalId;
  }
  return false;
}

/**
 * Filter rows for `#general` or `All messages` so DM and group DM rows never leak into either view,
 * including during a failed or pending Step 2b `conversations` list read.
 */
export function excludeDirectConversationRows<T extends ConversationHistorySignal>(
  rows: readonly T[],
  conversations: readonly ConversationSummary[] | null,
  activeChannelId: string | null,
  options?: DirectExclusionOptions,
): T[] {
  if (conversations === null && options?.legacyUnsupported === true) return [...rows];
  const generalId = conversations?.find((c) => c.kind === "general")?.conversationId ?? null;
  const dmIds = new Set(
    (conversations ?? []).filter((c) => isDirectKind(c.kind)).map((c) => c.conversationId),
  );
  return rows.filter((row) => {
    if (row.conversationKind === "dm" || row.conversationKind === "group_dm") return false;
    if (row.conversationId && dmIds.has(row.conversationId)) return false;
    if (activeChannelId === GENERAL_CHANNEL_ID) {
      if (row.conversationId && generalId && row.conversationId !== generalId) return false;
      if (row.channelId !== null) return false;
      if (row.to !== null || row.toAgent !== null) return false;
      return true;
    }
    if (activeChannelId === null) {
      if (row.channelId === null && (row.to !== null || row.toAgent !== null)) {
        if (!row.conversationId || row.conversationId !== generalId) return false;
      }
      return true;
    }
    return true;
  });
}

/**
 * Resolve which history transport drives the open Chat view.
 * - Any `?dm=<conversation_id>` uses `conversation_history` (even when absent from the sidebar list,
 *   so unknown/left/inaccessible IDs get the uniform server `404 conversation_not_found` state).
 * - `#general` and named channels use `conversation_history` whenever Step 2b `conversations` loaded.
 * - `All messages` (`activeChannelId === null`) uses `signalPage` with strict DM exclusion.
 * - Pre-Step-2b servers (`workspaceConversations === null`) stay on the legacy transport.
 */
export function resolveActiveConversationHistoryTarget(args: {
  workspaceConversations: readonly ConversationSummary[] | null;
  activeDmConversationId: string | null;
  activeDm: { kind: "person" | "agent"; id: string } | null;
  activeChannelId: string | null;
  unknownChannelId: string | null;
  viewerUserId: string | null;
}): ActiveConversationHistoryTarget {
  const {
    workspaceConversations,
    activeDmConversationId,
    activeDm,
    activeChannelId,
    unknownChannelId,
    viewerUserId,
  } = args;
  if (activeDmConversationId !== null) {
    const matched = workspaceConversations?.find((c) => c.conversationId === activeDmConversationId) ?? null;
    return {
      mode: "conversation",
      conversationId: activeDmConversationId,
      isDm: true,
      kind: matched?.kind ?? null,
    };
  }
  if (workspaceConversations === null) return { mode: "legacy" };
  if (activeDm !== null && viewerUserId) {
    const partnerKind = activeDm.kind === "agent" ? "agent" : "user";
    const partnerId = activeDm.id.toLowerCase();
    const viewerLower = viewerUserId.toLowerCase();
    const matchedDm = workspaceConversations.find((c) => {
      if (c.kind !== "dm") return false;
      const live = c.members.filter((m) => !m.leftAt);
      const others = live.filter((m) => !(m.kind === "user" && m.id.toLowerCase() === viewerLower));
      return others.length === 1 && others[0]!.kind === partnerKind && others[0]!.id.toLowerCase() === partnerId;
    });
    if (matchedDm) {
      return { mode: "conversation", conversationId: matchedDm.conversationId, isDm: true, kind: "dm" };
    }
    return { mode: "legacy" };
  }
  if (unknownChannelId !== null) return { mode: "legacy" };
  if (activeChannelId === null) return { mode: "all-signals" };
  if (activeChannelId === GENERAL_CHANNEL_ID) {
    const general = workspaceConversations.find((c) => c.kind === "general");
    return general
      ? { mode: "conversation", conversationId: general.conversationId, isDm: false, kind: "general" }
      : { mode: "legacy" };
  }
  const channelConv = workspaceConversations.find((c) => c.channelId === activeChannelId);
  return channelConv
    ? { mode: "conversation", conversationId: channelConv.conversationId, isDm: false, kind: channelConv.kind }
    : { mode: "legacy" };
}

/**
 * Step 3D-1 fail-closed send guard for true DMs (1:1 DM, Notes to self, and group DM) posted via
 * `post_signal({ conversation_id })`.
 * - Refuses stale, unavailable, unjoined, or archived DMs (never falls back to workspace broadcast).
 * - Refuses workspace-readable attachments on every DM before any upload starts.
 */
export function directConversationSendRefusal(args: {
  activeDmConversationId: string | null;
  activeDm: { kind: "person" | "agent"; id: string } | null;
  conversation: ConversationSummary | null;
  historyStatus: ConversationHistoryStatus;
  hasAttachments: boolean;
}): string | null {
  const { activeDmConversationId, activeDm, conversation, historyStatus, hasAttachments } = args;
  if (activeDmConversationId !== null) {
    if (historyStatus === "unavailable") return CONVERSATION_UNAVAILABLE_TEXT;
    if (!conversation || !isDirectKind(conversation.kind) || !conversation.joined || conversation.archivedAt !== null) {
      return CONVERSATION_UNAVAILABLE_TEXT;
    }
    if (hasAttachments) return DM_ATTACHMENTS_REFUSAL_TEXT;
    return null;
  }
  if (activeDm !== null && hasAttachments) {
    return DM_ATTACHMENTS_REFUSAL_TEXT;
  }
  return null;
}

/**
 * Fail-closed channel membership submit guard covering both top-level sends and thread replies.
 * Only allows pre-Step-2b fallback when the server explicitly reported `unsupported`.
 */
export function channelMembershipSendRefusal(args: {
  channelId: string | null;
  generalId: string;
  conversations: readonly ConversationSummary[] | null;
  conversationsReadState: "idle" | "pending" | "ready" | "unsupported" | "failed";
}): string | null {
  const { channelId, generalId, conversations, conversationsReadState } = args;
  if (channelId === null || channelId === generalId) return null;
  if (conversationsReadState === "unsupported") return null;
  if (conversations === null) {
    return conversationsReadState === "failed"
      ? "Couldn't check channel membership. Retry before posting."
      : "Checking channel membership. Try again in a moment.";
  }
  const conv = conversations.find((c) => c.channelId === channelId) ?? null;
  if (!conv) return CONVERSATION_UNAVAILABLE_TEXT;
  if (!conv.joined) return "Join this channel to post.";
  return null;
}

/**
 * Honest direct-message audience sentence accounting for Step 2b agent-owner read-only oversight.
 * Agent-free DMs keep the exclusive promise; DMs containing an agent state the oversight exception.
 */
export function directConversationAudienceSentence(
  conv: Pick<ConversationSummary, "members">,
  viewerId: string,
  title: string,
): string {
  const live = conv.members.filter((m) => !m.leftAt);
  const others = live.filter((m) => !(m.kind === "user" && m.id === viewerId));
  if (others.length === 0) return "Only you can read this.";
  const hasAgent = live.some((m) => m.kind === "agent");
  if (hasAgent) {
    return `Direct message with ${title}. Agent owners can read their agents' DMs.`;
  }
  return `Only ${title} and you can read this.`;
}

/** Storage keys bound to viewer + workspace + conversation so drafts never bleed across accounts and wipe cleanly on leave/revocation. */
export function conversationDraftStorageKey(
  viewerId: string,
  workspaceId: string,
  conversationId: string,
): string {
  return `commonswarm:composer-draft:${viewerId}:${workspaceId}:conv:${conversationId}`;
}

export function clearConversationDraftStorage(
  storage: Pick<Storage, "removeItem"> | null | undefined,
  viewerId: string,
  workspaceId: string,
  conversationId: string,
): void {
  if (!storage || !viewerId || !workspaceId || !conversationId) return;
  try {
    storage.removeItem(conversationDraftStorageKey(viewerId, workspaceId, conversationId));
  } catch {
    // Storage access is optional in restricted browsing contexts.
  }
}
