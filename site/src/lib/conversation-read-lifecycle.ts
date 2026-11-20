/*
 * Conversation read lifecycle controller (extracted from LiveDashboard.astro per C2/C6/C7 refactor rule).
 *
 * Owns Step 2b `resource: "conversations"` list refreshes, omission reconciliation, and
 * `resource: "conversation_history"` initial / load-older / incremental live-refresh reads,
 * keeping generation guards, session-identity checks, and unavailable-conversation eviction in
 * one testable unit independent of DOM rendering.
 */

import {
  applyConversationHistoryInitial,
  applyConversationHistoryOlder,
  applyConversationHistoryRefresh,
  createConversationHistoryState,
  type ConversationHistoryState,
} from "./conversation-history";
import {
  isDirectKind,
  type ConversationHistoryCursor,
  type ConversationHistoryResult,
  type ConversationSummary,
} from "./conversations";

export type ConversationsReadState = "idle" | "pending" | "ready" | "unsupported" | "failed";

export interface ConversationHistorySignal {
  id: string;
  createdAt: string;
  conversationId?: string | null;
}

export type ConversationHistoryTarget =
  | { mode: "conversation"; conversationId: string }
  | { mode: "all-signals" | "legacy" };

export interface ConversationReadLifecycleStore<TSignal extends ConversationHistorySignal> {
  getConversations: () => ConversationSummary[] | null;
  setConversations: (rows: ConversationSummary[] | null) => void;
  getReadState: () => ConversationsReadState;
  setReadState: (state: ConversationsReadState) => void;
  getReadError: () => string;
  setReadError: (error: string) => void;
  getConversationsGeneration: () => number;
  setConversationsGeneration: (next: number) => void;
  getConversationsReadAt: () => number;
  setConversationsReadAt: (at: number) => void;
  getHistory: () => ConversationHistoryState<TSignal> | null;
  setHistory: (state: ConversationHistoryState<TSignal> | null) => void;
  getHistoryGeneration: () => number;
  setHistoryGeneration: (next: number) => void;
  getSessionEpoch: () => number;
  setSessionEpoch: (next: number) => void;
  modernConversationsConfirmed: Set<string>;
  evictedConversationIds: Set<string>;
}

export interface ConversationReadLifecycleDeps<TSignal extends ConversationHistorySignal> {
  store?: ConversationReadLifecycleStore<TSignal>;
  listConversations: (
    workspaceId: string,
    includeArchived: boolean,
    expectedUserId: string,
    isAlive: () => boolean,
  ) => Promise<ConversationSummary[]>;
  readConversationHistory: (
    workspaceId: string,
    conversationId: string,
    options: {
      before?: ConversationHistoryCursor;
      after?: ConversationHistoryCursor;
      limit: number;
      includeMentions: boolean;
      includeReactions: boolean;
      expectedUserId: string;
      isAlive: () => boolean;
    },
  ) => Promise<ConversationHistoryResult<TSignal>>;
  isConversationsUnsupportedError: (error: unknown) => boolean;
  isSessionIdentityMismatch: (error: unknown) => boolean;
  readableError: (error: unknown) => string;
  now?: () => number;
  refreshThrottleMs?: number;
  generalChannelId: string;
  isSampleMode: () => boolean;
  activeSessionUserId: () => string;
  activeWorkspaceId: () => string | null;
  activeRequestVersion: () => number;
  activeChannelId: () => string | null;
  activeDmConversationId: () => string | null;
  activeConversationHistoryTarget: () => ConversationHistoryTarget;
  optimisticRowsForConversation: (conversationId: string) => TSignal[];
  onClearOmittedConversationData: (workspaceId: string, userId: string, conversationId: string) => void;
  onEvictActiveConversation: (workspaceId: string, conversationId: string, markUnavailable: boolean) => void;
  onResetLoadOlderState?: () => void;
  onConversationReadStateChanged?: (render: boolean) => void;
  onConversationsCommitted?: (render: boolean) => void;
  onHistoryApplied?: (args: {
    workspaceId: string;
    version: number;
    reset: boolean;
    state: ConversationHistoryState<TSignal>;
  }) => void;
}

export type ConversationLatestRefreshOutcome<TSignal extends ConversationHistorySignal> =
  | { status: "stale" }
  | { status: "lost_access" }
  | { status: "ignored" }
  | { status: "ready"; state: ConversationHistoryState<TSignal>; changed: boolean };

export interface ConversationReadLifecycle<TSignal extends ConversationHistorySignal> {
  getConversations: () => ConversationSummary[] | null;
  getReadState: () => ConversationsReadState;
  getReadError: () => string;
  getHistory: () => ConversationHistoryState<TSignal> | null;
  getSessionEpoch: () => number;
  isEvicted: (workspaceId: string, conversationId: string) => boolean;
  reset: () => void;
  commitWorkspaceConversations: (
    workspaceId: string,
    pinnedUserId: string,
    rows: ConversationSummary[],
    render: boolean,
  ) => boolean;
  refreshConversations: (workspaceId: string, force: boolean, render?: boolean) => Promise<void>;
  loadConversationPage: (args: {
    workspaceId: string;
    conversationId: string;
    pinnedUserId: string;
    version: number;
    reset: boolean;
    fallbackBeforeCursor: ConversationHistoryCursor | null;
  }) => Promise<boolean>;
  refreshConversationLatest: (args: {
    workspaceId: string;
    conversationId: string;
    pinnedUserId: string;
    version: number;
  }) => Promise<ConversationLatestRefreshOutcome<TSignal>>;
}

const DEFAULT_REFRESH_THROTTLE_MS = 15_000;

function createMemoryStore<TSignal extends ConversationHistorySignal>(): ConversationReadLifecycleStore<TSignal> {
  let conversations: ConversationSummary[] | null = null;
  let readState: ConversationsReadState = "idle";
  let readError = "";
  let conversationsGeneration = 0;
  let conversationsReadAt = 0;
  let history: ConversationHistoryState<TSignal> | null = null;
  let historyGeneration = 0;
  let sessionEpoch = 0;
  return {
    getConversations: () => conversations,
    setConversations: (rows) => { conversations = rows; },
    getReadState: () => readState,
    setReadState: (state) => { readState = state; },
    getReadError: () => readError,
    setReadError: (error) => { readError = error; },
    getConversationsGeneration: () => conversationsGeneration,
    setConversationsGeneration: (next) => { conversationsGeneration = next; },
    getConversationsReadAt: () => conversationsReadAt,
    setConversationsReadAt: (at) => { conversationsReadAt = at; },
    getHistory: () => history,
    setHistory: (state) => { history = state; },
    getHistoryGeneration: () => historyGeneration,
    setHistoryGeneration: (next) => { historyGeneration = next; },
    getSessionEpoch: () => sessionEpoch,
    setSessionEpoch: (next) => { sessionEpoch = next; },
    modernConversationsConfirmed: new Set<string>(),
    evictedConversationIds: new Set<string>(),
  };
}

export function createConversationReadLifecycle<TSignal extends ConversationHistorySignal>(
  deps: ConversationReadLifecycleDeps<TSignal>,
): ConversationReadLifecycle<TSignal> {
  const store = deps.store ?? createMemoryStore<TSignal>();
  const now = deps.now ?? (() => Date.now());
  const throttleMs = deps.refreshThrottleMs ?? DEFAULT_REFRESH_THROTTLE_MS;

  const reset = (): void => {
    store.setConversations(null);
    store.setReadState("idle");
    store.setReadError("");
    store.setConversationsGeneration(store.getConversationsGeneration() + 1);
    store.setConversationsReadAt(0);
    store.setHistory(null);
    store.setHistoryGeneration(store.getHistoryGeneration() + 1);
    store.setSessionEpoch(store.getSessionEpoch() + 1);
  };

  const commitWorkspaceConversations = (
    workspaceId: string,
    pinnedUserId: string,
    rows: ConversationSummary[],
    render: boolean,
  ): boolean => {
    const prevList = store.getConversations();
    const nextIds = new Set(rows.map((row) => row.conversationId));
    for (const row of rows) {
      if (row.joined) store.evictedConversationIds.delete(`${workspaceId}:${row.conversationId}`);
    }
    if (prevList) {
      for (const prev of prevList) {
        if (!nextIds.has(prev.conversationId) && (prev.kind === "private_channel" || isDirectKind(prev.kind))) {
          store.evictedConversationIds.add(`${workspaceId}:${prev.conversationId}`);
          deps.onClearOmittedConversationData(workspaceId, pinnedUserId, prev.conversationId);
        }
      }
    }
    store.setConversations(rows);
    store.setReadState("ready");
    store.setReadError("");
    if (pinnedUserId && workspaceId) store.modernConversationsConfirmed.add(`${pinnedUserId}:${workspaceId}`);

    const history = store.getHistory();
    const activeDmId = deps.activeDmConversationId();
    const requestedDmId = activeDmId ??
      (history && history.conversation?.kind && isDirectKind(history.conversation.kind)
        ? history.conversationId
        : null);
    if (requestedDmId !== null) {
      const freshDm = rows.find((row) => row.conversationId === requestedDmId);
      if (!freshDm || !freshDm.joined) {
        deps.onEvictActiveConversation(workspaceId, requestedDmId, true);
        return true;
      }
    }
    const channelId = deps.activeChannelId();
    if (channelId !== null && channelId !== deps.generalChannelId) {
      const openPrivateConvId =
        history?.conversation?.kind === "private_channel"
          ? history.conversationId
          : prevList?.find((c) => c.channelId === channelId && c.kind === "private_channel")?.conversationId ?? null;
      if (openPrivateConvId !== null) {
        const freshPrivate = rows.find((row) => row.conversationId === openPrivateConvId);
        if (!freshPrivate || !freshPrivate.joined) {
          deps.onEvictActiveConversation(workspaceId, openPrivateConvId, true);
          return true;
        }
      }
    }
    deps.onConversationsCommitted?.(render);
    return false;
  };

  const refreshConversations = async (workspaceId: string, force: boolean, render = true): Promise<void> => {
    const pinnedUserId = deps.activeSessionUserId();
    if (deps.isSampleMode() || !pinnedUserId || !workspaceId || store.getReadState() === "unsupported") return;
    const ts = now();
    if (!force && ts - store.getConversationsReadAt() < throttleMs) return;
    store.setConversationsReadAt(ts);
    const generation = store.getConversationsGeneration() + 1;
    store.setConversationsGeneration(generation);
    if (store.getConversations() === null && store.getReadState() === "idle") {
      store.setReadState("pending");
      deps.onConversationReadStateChanged?.(render);
    }
    const listStillAlive = (): boolean =>
      generation === store.getConversationsGeneration() &&
      workspaceId === deps.activeWorkspaceId() &&
      deps.activeSessionUserId() === pinnedUserId;
    let rows: ConversationSummary[];
    try {
      rows = await deps.listConversations(workspaceId, true, pinnedUserId, listStillAlive);
    } catch (error) {
      if (deps.isSessionIdentityMismatch(error)) return;
      if (!listStillAlive()) return;
      const confirmedModern = store.modernConversationsConfirmed.has(`${pinnedUserId}:${workspaceId}`);
      if (deps.isConversationsUnsupportedError(error) && !confirmedModern) {
        store.setReadState("unsupported");
        store.setReadError("");
        deps.onConversationReadStateChanged?.(render);
        return;
      }
      if ((store.getConversations() === null && store.getReadState() !== "unsupported") || confirmedModern) {
        if (store.getConversations() === null) store.setReadState("failed");
        store.setReadError(deps.readableError(error) || "Couldn't check channel membership.");
        deps.onConversationReadStateChanged?.(render);
      }
      return;
    }
    if (!listStillAlive()) return;
    commitWorkspaceConversations(workspaceId, pinnedUserId, rows, render);
  };

  const syncConversationSummary = (updated: ConversationSummary | null): void => {
    const current = store.getConversations();
    if (!updated || !current) return;
    if (current.some((c) => c.conversationId === updated.conversationId)) {
      store.setConversations(current.map((c) => (c.conversationId === updated.conversationId ? updated : c)));
    }
  };

  const loadConversationPage: ConversationReadLifecycle<TSignal>["loadConversationPage"] = async ({
    workspaceId,
    conversationId,
    pinnedUserId,
    version,
    reset: isReset,
    fallbackBeforeCursor,
  }) => {
    const histGen = store.getHistoryGeneration() + 1;
    store.setHistoryGeneration(histGen);
    const currentHistory = store.getHistory();
    const beforeCursor = isReset
      ? null
      : currentHistory && currentHistory.conversationId === conversationId
        ? currentHistory.nextBefore
        : fallbackBeforeCursor;
    if (isReset) {
      deps.onResetLoadOlderState?.();
      store.setSessionEpoch(store.getSessionEpoch() + 1);
      if (
        !currentHistory ||
        currentHistory.conversationId !== conversationId ||
        currentHistory.workspaceId !== workspaceId ||
        currentHistory.viewerId !== pinnedUserId
      ) {
        store.setHistory(createConversationHistoryState<TSignal>(workspaceId, pinnedUserId, conversationId));
      }
    }
    const pinnedSessionEpoch = store.getSessionEpoch();
    const stillMatches = (): boolean => {
      if (
        pinnedSessionEpoch !== store.getSessionEpoch() ||
        version !== deps.activeRequestVersion() ||
        workspaceId !== deps.activeWorkspaceId() ||
        deps.activeSessionUserId() !== pinnedUserId
      ) {
        return false;
      }
      const target = deps.activeConversationHistoryTarget();
      return target.mode === "conversation" && target.conversationId === conversationId;
    };
    const readStillAlive = (): boolean => (!isReset || histGen === store.getHistoryGeneration()) && stillMatches();
    if (!readStillAlive()) return false;
    let result: ConversationHistoryResult<TSignal>;
    try {
      result = await deps.readConversationHistory(workspaceId, conversationId, {
        ...(beforeCursor ? { before: beforeCursor } : {}),
        limit: 50,
        includeMentions: true,
        includeReactions: true,
        expectedUserId: pinnedUserId,
        isAlive: readStillAlive,
      });
    } catch (error) {
      if (deps.isSessionIdentityMismatch(error)) return false;
      throw error;
    }
    if (!readStillAlive()) return false;
    const latestHistory = store.getHistory();
    const liveState = latestHistory && latestHistory.conversationId === conversationId
      ? latestHistory
      : createConversationHistoryState<TSignal>(workspaceId, pinnedUserId, conversationId);
    if (!isReset && liveState.status === "unavailable") return false;
    const next = isReset
      ? applyConversationHistoryInitial(liveState, result, deps.optimisticRowsForConversation(conversationId))
      : applyConversationHistoryOlder(liveState, result);
    store.setHistory(next);
    if (next.status === "unavailable") {
      deps.onEvictActiveConversation(workspaceId, conversationId, true);
      return false;
    }
    if (!isReset && next.olderError) {
      throw new Error(next.olderError);
    }
    if (isReset && next.status === "error") {
      throw new Error(next.errorMessage || "CommonSwarm could not load this conversation.");
    }
    syncConversationSummary(next.conversation);
    deps.onHistoryApplied?.({ workspaceId, version, reset: isReset, state: next });
    return true;
  };

  const refreshConversationLatest: ConversationReadLifecycle<TSignal>["refreshConversationLatest"] = async ({
    workspaceId,
    conversationId,
    pinnedUserId,
    version,
  }) => {
    const histGen = store.getHistoryGeneration() + 1;
    store.setHistoryGeneration(histGen);
    const pinnedSessionEpoch = store.getSessionEpoch();
    const currentHistory = store.getHistory();
    const afterCursor = currentHistory &&
      currentHistory.conversationId === conversationId &&
      currentHistory.workspaceId === workspaceId &&
      currentHistory.viewerId === pinnedUserId
      ? currentHistory.nextAfter
      : null;
    const refreshStillAlive = (): boolean => {
      const target = deps.activeConversationHistoryTarget();
      return (
        pinnedSessionEpoch === store.getSessionEpoch() &&
        histGen === store.getHistoryGeneration() &&
        version === deps.activeRequestVersion() &&
        workspaceId === deps.activeWorkspaceId() &&
        deps.activeSessionUserId() === pinnedUserId &&
        target.mode === "conversation" &&
        target.conversationId === conversationId
      );
    };
    if (!refreshStillAlive()) return { status: "stale" };
    let result: ConversationHistoryResult<TSignal>;
    try {
      result = await deps.readConversationHistory(workspaceId, conversationId, {
        ...(afterCursor ? { after: afterCursor } : {}),
        limit: 50,
        includeMentions: true,
        includeReactions: true,
        expectedUserId: pinnedUserId,
        isAlive: refreshStillAlive,
      });
    } catch (error) {
      if (deps.isSessionIdentityMismatch(error)) return { status: "stale" };
      throw error;
    }
    if (!refreshStillAlive()) return { status: "stale" };
    const latestHistory = store.getHistory();
    const liveState = latestHistory &&
      latestHistory.conversationId === conversationId &&
      latestHistory.workspaceId === workspaceId &&
      latestHistory.viewerId === pinnedUserId
      ? latestHistory
      : createConversationHistoryState<TSignal>(workspaceId, pinnedUserId, conversationId);
    if (liveState.status === "unavailable") return { status: "stale" };
    const refreshed = applyConversationHistoryRefresh(
      liveState,
      result,
      deps.optimisticRowsForConversation(conversationId),
    );
    store.setHistory(refreshed.state);
    if (refreshed.lostAccess) {
      deps.onEvictActiveConversation(workspaceId, conversationId, true);
      return { status: "lost_access" };
    }
    if (refreshed.state.status === "ready") {
      syncConversationSummary(refreshed.state.conversation);
      return { status: "ready", state: refreshed.state, changed: refreshed.changed };
    }
    return { status: "ignored" };
  };

  return {
    getConversations: () => store.getConversations(),
    getReadState: () => store.getReadState(),
    getReadError: () => store.getReadError(),
    getHistory: () => store.getHistory(),
    getSessionEpoch: () => store.getSessionEpoch(),
    isEvicted: (workspaceId, conversationId) => store.evictedConversationIds.has(`${workspaceId}:${conversationId}`),
    reset,
    commitWorkspaceConversations,
    refreshConversations,
    loadConversationPage,
    refreshConversationLatest,
  };
}
