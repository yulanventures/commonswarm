import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { appActions, getSnapshot as getStoreSnapshot, useAppStore } from '../store/appStore';
import {
  adaptAgents,
  adaptChannels,
  adaptDirectMessages,
  adaptPeople,
  adaptWaitingCount,
  adaptWorkspaces,
} from './adapter';
import {
  readAgentPresence,
  readAgentPrincipals,
  readAgentWakePath,
  readConversations,
  readDecisionQueue,
  readHomeOverview,
  readMemberProfiles,
  readWaitingTodos,
  readWorkspaces,
  type AgentPrincipalRow,
  type AgentWakePathRow,
  type MemberProfileRow,
  type MyWorkspace,
} from './api';
import type { AgentPresenceRow } from './contracts/agent-presence';
import type { ConversationSummary } from './contracts/conversations';
import type {
  DecisionQueue,
  HomeOverview,
  WaitingTodosQueue,
} from './contracts/home-contract';
import { StaleFenceError, type Fence } from './fence';
import {
  createSessionGate,
  type SessionGate,
  type SessionSnapshot,
} from './session';
import type {
  Agent,
  Channel,
  Person,
  SidebarDirectMessage,
  Workspace,
} from './types';

export const WORKSPACE_UNAVAILABLE_TEXT = "This workspace isn't available.";
export const CONVERSATION_UNAVAILABLE_TEXT =
  "This conversation isn't available in this workspace.";

export type RealtimeUnsubscribe = () => void;

export const queryKeys = {
  workspaces: (loginGen: number) => [loginGen, 'workspaces'] as const,
  homeOverviewPrefix: (loginGen: number) =>
    [loginGen, 'home-overview'] as const,
  homeOverview: (loginGen: number, overviewGen = 0) =>
    [loginGen, 'home-overview', overviewGen] as const,
  workspaceScope: (loginGen: number, workspaceId: string) =>
    [loginGen, 'workspace', workspaceId.toLowerCase()] as const,
  workspaceConversations: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'conversations',
    ] as const,
  workspaceAgents: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'agents',
    ] as const,
  workspaceMembers: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'members',
    ] as const,
  workspaceWaitingPrefix: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'waiting',
    ] as const,
  workspaceWaiting: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
    overviewGen = 0,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'waiting',
      overviewGen,
    ] as const,
  workspaceReviewChecks: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'review-checks',
    ] as const,
  conversationScope: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
    conversationId: string,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'conversation',
      conversationId.toLowerCase(),
    ] as const,
  conversationMessages: (
    loginGen: number,
    workspaceId: string,
    workspaceGen: number,
    conversationId: string,
    conversationGen: number,
  ) =>
    [
      loginGen,
      'workspace',
      workspaceId.toLowerCase(),
      workspaceGen,
      'conversation',
      conversationId.toLowerCase(),
      conversationGen,
    ] as const,
};

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 0,
      },
    },
  });
}

type TrackedScopeKind =
  | 'workspaces'
  | 'overview'
  | 'conversations'
  | 'agents'
  | 'members'
  | 'waiting'
  | 'review'
  | 'conversation';

interface TrackedOperation {
  readonly controller: AbortController;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly scopeKind: TrackedScopeKind;
}

interface TrackedRealtimeSub {
  readonly unsubscribe: RealtimeUnsubscribe;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
}

export interface AgentsBundle {
  readonly principals: AgentPrincipalRow[];
  readonly presence: Map<string, AgentPresenceRow> | null;
  readonly wakePath: Map<string, AgentWakePathRow> | null;
}

export interface WaitingBundle {
  readonly decisionQueue: DecisionQueue;
  readonly waitingTodos: WaitingTodosQueue;
}

export interface DataController {
  readonly sessionGate: SessionGate;
  readonly queryClient: QueryClient;
  /** Register a realtime subscription cleanup to be invoked synchronously on purge/eviction. */
  registerRealtimeSubscription(
    unsubscribe: RealtimeUnsubscribe,
    scope?: { workspaceId?: string | null; conversationId?: string | null },
  ): () => void;
  /** Synchronously purge all in-flight work, cache entries, store server slices, and realtime subs. */
  purgeAllSynchronously(): void;
  /** Synchronously evict one workspace scope (including Waiting and review data) and mark unavailable. */
  evictWorkspaceScope(workspaceId: string): void;
  /** Synchronously evict one conversation scope (plus workspace Waiting & review data). */
  evictConversationScope(
    workspaceId: string,
    conversationId: string,
    options?: { markUnavailable?: boolean },
  ): void;
  /** Handle an explicit 404 `conversation_not_found` response synchronously. */
  handleConversationNotFound(workspaceId: string, conversationId: string): void;
  /** Switch active workspace scope and fence. */
  selectWorkspace(workspaceId: string): void;
  /** Bind active conversation identity onto the fence tracker and store. */
  selectConversation(workspaceId: string | null, conversationId: string | null): void;
  /** Run an abortable fenced read tracked by the controller. */
  runFenced<T>(
    fence: Fence,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    scopeKind?: TrackedScopeKind,
  ): Promise<T>;
  dispose(): void;
}

function isPrivateOrDirect(conv: Pick<ConversationSummary, 'kind'>): boolean {
  return (
    conv.kind === 'private_channel' ||
    conv.kind === 'dm' ||
    conv.kind === 'group_dm'
  );
}

export function createDataController(
  sessionGate: SessionGate,
  queryClient: QueryClient = createAppQueryClient(),
): DataController {
  const activeOps = new Set<TrackedOperation>();
  const realtimeSubs = new Set<TrackedRealtimeSub>();

  const abortMatching = (
    predicate: (op: TrackedOperation) => boolean,
  ): void => {
    for (const op of [...activeOps]) {
      if (predicate(op)) {
        activeOps.delete(op);
        op.controller.abort();
      }
    }
  };

  const dropRealtimeMatching = (
    predicate: (sub: TrackedRealtimeSub) => boolean,
  ): void => {
    for (const sub of [...realtimeSubs]) {
      if (predicate(sub)) {
        realtimeSubs.delete(sub);
        try {
          sub.unsubscribe();
        } catch {
          // Isolate realtime teardown failures so purge completes synchronously.
        }
      }
    }
  };

  const purgeAllSynchronously = (): void => {
    abortMatching(() => true);
    dropRealtimeMatching(() => true);
    void queryClient.cancelQueries();
    queryClient.clear();
    appActions.resetServerState();
  };

  const evictWorkspaceScope = (workspaceId: string): void => {
    const normalized = workspaceId.toLowerCase();
    const loginGen = sessionGate.loginGeneration;
    abortMatching(
      (op) => op.workspaceId === normalized || op.scopeKind === 'overview',
    );
    dropRealtimeMatching((sub) => sub.workspaceId === normalized);
    sessionGate.fenceTracker.retireWorkspace(normalized);

    const scopeKey = queryKeys.workspaceScope(loginGen, normalized);
    void queryClient.cancelQueries({ queryKey: scopeKey });
    queryClient.removeQueries({ queryKey: scopeKey });

    // Evict login-wide overview (and any held overview is now fenced by bumped overviewGeneration).
    const overviewPrefix = queryKeys.homeOverviewPrefix(loginGen);
    void queryClient.cancelQueries({ queryKey: overviewPrefix });
    queryClient.removeQueries({ queryKey: overviewPrefix });

    // Prune revoked workspace from the login-wide workspace list (rail and picker).
    const workspacesKey = queryKeys.workspaces(loginGen);
    const cachedWorkspaces =
      queryClient.getQueryData<MyWorkspace[]>(workspacesKey);
    if (cachedWorkspaces) {
      queryClient.setQueryData<MyWorkspace[]>(
        workspacesKey,
        cachedWorkspaces.filter((ws) => ws.id.toLowerCase() !== normalized),
      );
    }

    appActions.markWorkspaceUnavailable(normalized);
  };

  const evictConversationScope = (
    workspaceId: string,
    conversationId: string,
    options: { markUnavailable?: boolean } = {},
  ): void => {
    const normalizedWs = workspaceId.toLowerCase();
    const normalizedConv = conversationId.toLowerCase();
    const loginGen = sessionGate.loginGeneration;
    const wsGen = sessionGate.fenceTracker.getWorkspaceGeneration(normalizedWs);

    abortMatching(
      (op) =>
        op.conversationId === normalizedConv ||
        op.scopeKind === 'overview' ||
        (op.workspaceId === normalizedWs &&
          (op.scopeKind === 'waiting' || op.scopeKind === 'review')),
    );
    dropRealtimeMatching((sub) => sub.conversationId === normalizedConv);
    sessionGate.fenceTracker.retireConversation(normalizedConv);

    const convScopeKey = queryKeys.conversationScope(
      loginGen,
      normalizedWs,
      wsGen,
      normalizedConv,
    );
    const waitingKey = queryKeys.workspaceWaitingPrefix(
      loginGen,
      normalizedWs,
      wsGen,
    );
    const reviewKey = queryKeys.workspaceReviewChecks(
      loginGen,
      normalizedWs,
      wsGen,
    );
    const overviewPrefix = queryKeys.homeOverviewPrefix(loginGen);

    void queryClient.cancelQueries({ queryKey: convScopeKey });
    queryClient.removeQueries({ queryKey: convScopeKey });
    void queryClient.cancelQueries({ queryKey: waitingKey });
    queryClient.removeQueries({ queryKey: waitingKey });
    void queryClient.cancelQueries({ queryKey: reviewKey });
    queryClient.removeQueries({ queryKey: reviewKey });
    void queryClient.cancelQueries({ queryKey: overviewPrefix });
    queryClient.removeQueries({ queryKey: overviewPrefix });

    // Remove evicted conversation from cached sidebar list if still present.
    const convListKey = queryKeys.workspaceConversations(
      loginGen,
      normalizedWs,
      wsGen,
    );
    const cachedList =
      queryClient.getQueryData<ConversationSummary[]>(convListKey);
    if (cachedList) {
      queryClient.setQueryData<ConversationSummary[]>(
        convListKey,
        cachedList.filter(
          (item) => item.conversationId.toLowerCase() !== normalizedConv,
        ),
      );
    }

    if (options.markUnavailable) {
      appActions.markConversationUnavailable(normalizedWs, normalizedConv);
    } else {
      appActions.recordConversationRevoked(normalizedWs, normalizedConv);
    }
  };

  const handleConversationNotFound = (
    workspaceId: string,
    conversationId: string,
  ): void => {
    evictConversationScope(workspaceId, conversationId, {
      markUnavailable: true,
    });
  };

  const selectWorkspace = (workspaceId: string): void => {
    const normalized = workspaceId.toLowerCase();
    if (
      sessionGate.fenceTracker.isWorkspaceRevoked(normalized) ||
      getStoreSnapshot().revokedWorkspaceIds.includes(normalized)
    ) {
      // Never clear unavailable state or activate queries for a revoked workspace.
      appActions.selectWorkspace(normalized);
      return;
    }
    const previous = sessionGate.fenceTracker.activeWorkspaceId;
    if (previous && previous !== normalized) {
      abortMatching((op) => op.workspaceId === previous);
    }
    sessionGate.fenceTracker.setActiveWorkspace(normalized);
    appActions.selectWorkspace(normalized);
  };

  const selectConversation = (
    workspaceId: string | null,
    conversationId: string | null,
  ): void => {
    const normWs = workspaceId ? workspaceId.toLowerCase() : null;
    const normConv = conversationId ? conversationId.toLowerCase() : null;
    if (normWs && sessionGate.fenceTracker.isWorkspaceRevoked(normWs)) {
      sessionGate.fenceTracker.setActiveConversation(null);
      appActions.selectConversation(null, null);
      return;
    }
    sessionGate.fenceTracker.setActiveConversation(normConv);
    appActions.selectConversation(normWs, normConv);
  };

  const runFenced = async <T>(
    fence: Fence,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    scopeKind: TrackedScopeKind = 'conversations',
  ): Promise<T> => {
    if (!sessionGate.fenceTracker.isCurrent(fence)) {
      throw new StaleFenceError();
    }
    if (externalSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const controller = new AbortController();
    const entry: TrackedOperation = {
      controller,
      workspaceId: fence.workspaceId,
      conversationId: fence.conversationId,
      scopeKind,
    };
    activeOps.add(entry);

    const onExternalAbort = (): void => {
      controller.abort();
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const result = await operation(controller.signal);
      if (!sessionGate.fenceTracker.isCurrent(fence)) {
        throw new StaleFenceError();
      }
      return result;
    } finally {
      activeOps.delete(entry);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  };

  const unsubPurge = sessionGate.onLoginPurge(() => {
    purgeAllSynchronously();
  });

  const registerRealtimeSubscription = (
    unsubscribe: RealtimeUnsubscribe,
    scope: { workspaceId?: string | null; conversationId?: string | null } = {},
  ): (() => void) => {
    const entry: TrackedRealtimeSub = {
      unsubscribe,
      workspaceId: scope.workspaceId?.toLowerCase() ?? null,
      conversationId: scope.conversationId?.toLowerCase() ?? null,
    };
    realtimeSubs.add(entry);
    return () => {
      realtimeSubs.delete(entry);
    };
  };

  return {
    sessionGate,
    queryClient,
    registerRealtimeSubscription,
    purgeAllSynchronously,
    evictWorkspaceScope,
    evictConversationScope,
    handleConversationNotFound,
    selectWorkspace,
    selectConversation,
    runFenced,
    dispose() {
      unsubPurge();
      purgeAllSynchronously();
    },
  };
}

const DataControllerContext = createContext<DataController | null>(null);

export interface AppDataProviderProps {
  controller?: DataController;
  children: ReactNode;
}

export function AppDataProvider({
  controller: externalController,
  children,
}: AppDataProviderProps) {
  const ownedController = useMemo(() => {
    if (externalController) return null;
    const gate = createSessionGate();
    return createDataController(gate);
  }, [externalController]);

  const controller = externalController ?? ownedController!;

  useEffect(() => {
    if (!ownedController) return;
    return () => {
      ownedController.dispose();
      ownedController.sessionGate.dispose();
    };
  }, [ownedController]);

  return createElement(
    DataControllerContext.Provider,
    { value: controller },
    createElement(
      QueryClientProvider,
      { client: controller.queryClient },
      children,
    ),
  );
}

export function useDataController(): DataController {
  const ctx = useContext(DataControllerContext);
  if (!ctx) {
    throw new Error('useDataController must be used inside AppDataProvider.');
  }
  return ctx;
}

export function useSessionSnapshot(): SessionSnapshot {
  const { sessionGate } = useDataController();
  return useSyncExternalStore(
    sessionGate.subscribe,
    () => sessionGate.getSnapshot(),
    () => sessionGate.getSnapshot(),
  );
}

export interface RealSidebarViewModel {
  readonly mode: 'real';
  readonly workspaces: Workspace[];
  readonly workspacesLoading: boolean;
  readonly workspacesError: boolean;
  readonly retryWorkspaces: () => void;
  readonly activeWorkspaceId: string | null;
  readonly activeWorkspaceName: string;
  readonly workspaceUnavailable: boolean;
  readonly channels: Channel[];
  readonly directMessages: SidebarDirectMessage[];
  readonly agents: Agent[];
  readonly people: Person[];
  readonly waitingCount: number | null;
  readonly currentUser: Person | null;
  readonly sidebarLoading: boolean;
  readonly sidebarError: boolean;
  readonly retrySidebar: () => void;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly selectConversation: (conversationId: string) => void;
}

export function useRealSidebarData(): RealSidebarViewModel {
  const controller = useDataController();
  const { sessionGate } = controller;
  const snapshot = useSessionSnapshot();
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const unavailableWorkspaceId = useAppStore((s) => s.unavailableWorkspaceId);
  const revokedWorkspaceIds = useAppStore((s) => s.revokedWorkspaceIds);

  const isAuthenticated =
    snapshot.state.status === 'authenticated' && snapshot.userId !== null;
  const loginGen = snapshot.loginGeneration;
  const overviewGen = sessionGate.fenceTracker.overviewGeneration;

  const workspacesQuery = useQuery<MyWorkspace[]>({
    queryKey: queryKeys.workspaces(loginGen),
    enabled: isAuthenticated,
    queryFn: async ({ signal }) => {
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: null,
        conversationId: null,
      });
      const list = await controller.runFenced(
        fence,
        signal,
        (s) => readWorkspaces(sessionGate, { fence, signal: s }),
        'workspaces',
      );
      if (!sessionGate.fenceTracker.isCurrent(fence)) {
        throw new StaleFenceError();
      }
      const filteredList = list.filter(
        (ws) => !sessionGate.fenceTracker.isWorkspaceRevoked(ws.id),
      );
      const currentSelected = getStoreSnapshot().selectedWorkspaceId;
      if (
        currentSelected !== null &&
        !filteredList.some((ws) => ws.id.toLowerCase() === currentSelected)
      ) {
        controller.evictWorkspaceScope(currentSelected);
      }
      return filteredList;
    },
  });

  const overviewQuery = useQuery<HomeOverview | null>({
    queryKey: queryKeys.homeOverview(loginGen, overviewGen),
    enabled: isAuthenticated,
    queryFn: async ({ signal }) => {
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: null,
        conversationId: null,
        includeOverview: true,
      });
      return controller.runFenced(
        fence,
        signal,
        (s) => readHomeOverview(sessionGate, { fence, signal: s }),
        'overview',
      );
    },
  });

  const rawWorkspaces = useMemo(
    () =>
      (workspacesQuery.data ?? []).filter(
        (ws) =>
          !revokedWorkspaceIds.includes(ws.id.toLowerCase()) &&
          !sessionGate.fenceTracker.isWorkspaceRevoked(ws.id),
      ),
    [workspacesQuery.data, revokedWorkspaceIds, sessionGate.fenceTracker],
  );
  const effectiveWorkspaceId =
    unavailableWorkspaceId !== null
      ? null
      : selectedWorkspaceId !== null &&
          !revokedWorkspaceIds.includes(selectedWorkspaceId)
        ? selectedWorkspaceId
        : (rawWorkspaces[0]?.id ?? null);

  // Synchronously align the active workspace fence before child queries capture it.
  if (
    isAuthenticated &&
    effectiveWorkspaceId !== null &&
    sessionGate.fenceTracker.activeWorkspaceId !== effectiveWorkspaceId
  ) {
    sessionGate.fenceTracker.setActiveWorkspace(effectiveWorkspaceId);
  }

  useEffect(() => {
    if (
      isAuthenticated &&
      selectedWorkspaceId === null &&
      unavailableWorkspaceId === null &&
      rawWorkspaces[0]
    ) {
      controller.selectWorkspace(rawWorkspaces[0].id);
    }
  }, [
    controller,
    isAuthenticated,
    rawWorkspaces,
    selectedWorkspaceId,
    unavailableWorkspaceId,
  ]);

  const workspaceGen =
    effectiveWorkspaceId !== null
      ? sessionGate.fenceTracker.getWorkspaceGeneration(effectiveWorkspaceId)
      : 0;
  const workspaceEnabled =
    isAuthenticated &&
    effectiveWorkspaceId !== null &&
    unavailableWorkspaceId === null &&
    !revokedWorkspaceIds.includes(effectiveWorkspaceId);

  const conversationsQuery = useQuery<ConversationSummary[]>({
    queryKey: queryKeys.workspaceConversations(
      loginGen,
      effectiveWorkspaceId ?? '',
      workspaceGen,
    ),
    enabled: workspaceEnabled,
    queryFn: async ({ signal }) => {
      const wsId = effectiveWorkspaceId!;
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: wsId,
        conversationId: null,
      });
      const list = await controller.runFenced(
        fence,
        signal,
        (s) =>
          readConversations(sessionGate, wsId, {
            fence,
            signal: s,
            includeArchived: false,
          }),
        'conversations',
      );
      if (!sessionGate.fenceTracker.isCurrent(fence)) {
        throw new StaleFenceError();
      }

      // Authoritative loss check: any previously known private channel or DM missing
      // or returned with `joined: false` is evicted synchronously with its Waiting/review/overview caches.
      const accessiblePrivateIds = new Set(
        list
          .filter((conv) => isPrivateOrDirect(conv) && conv.joined)
          .map((conv) => conv.conversationId.toLowerCase()),
      );
      const storeSnap = getStoreSnapshot();
      const previouslyKnown = storeSnap.knownPrivateConversationIds;
      const activeConv =
        sessionGate.fenceTracker.activeConversationId ??
        (storeSnap.selectedConversation?.workspaceId === wsId.toLowerCase()
          ? storeSnap.selectedConversation.conversationId
          : null);
      const lostIds = new Set<string>();
      for (const prevId of previouslyKnown) {
        if (!accessiblePrivateIds.has(prevId)) {
          lostIds.add(prevId);
        }
      }
      for (const conv of list) {
        if (isPrivateOrDirect(conv) && !conv.joined) {
          lostIds.add(conv.conversationId.toLowerCase());
        }
      }
      for (const lostId of lostIds) {
        controller.evictConversationScope(wsId, lostId, {
          markUnavailable: activeConv === lostId,
        });
      }
      appActions.setKnownPrivateConversationIds([...accessiblePrivateIds]);

      return list.filter(
        (conv) => !isPrivateOrDirect(conv) || conv.joined,
      );
    },
  });

  const agentsQuery = useQuery<AgentsBundle>({
    queryKey: queryKeys.workspaceAgents(
      loginGen,
      effectiveWorkspaceId ?? '',
      workspaceGen,
    ),
    enabled: workspaceEnabled,
    queryFn: async ({ signal }) => {
      const wsId = effectiveWorkspaceId!;
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: wsId,
        conversationId: null,
      });
      return controller.runFenced(
        fence,
        signal,
        async (s) => {
          const principals = await readAgentPrincipals(sessionGate, wsId, {
            fence,
            signal: s,
          });
          const [presence, wakePath] = await Promise.all([
            readAgentPresence(sessionGate, wsId, { fence, signal: s }).catch(
              (error) => {
                if (error instanceof StaleFenceError || s.aborted) throw error;
                return null;
              },
            ),
            readAgentWakePath(sessionGate, wsId, { fence, signal: s }).catch(
              (error) => {
                if (error instanceof StaleFenceError || s.aborted) throw error;
                return null;
              },
            ),
          ]);
          if (!sessionGate.fenceTracker.isCurrent(fence)) {
            throw new StaleFenceError();
          }
          return { principals, presence, wakePath };
        },
        'agents',
      );
    },
  });

  const membersQuery = useQuery<MemberProfileRow[]>({
    queryKey: queryKeys.workspaceMembers(
      loginGen,
      effectiveWorkspaceId ?? '',
      workspaceGen,
    ),
    enabled: workspaceEnabled,
    queryFn: async ({ signal }) => {
      const wsId = effectiveWorkspaceId!;
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: wsId,
        conversationId: null,
      });
      return controller.runFenced(
        fence,
        signal,
        (s) => readMemberProfiles(sessionGate, wsId, { fence, signal: s }),
        'members',
      );
    },
  });

  const waitingQuery = useQuery<WaitingBundle | null>({
    queryKey: queryKeys.workspaceWaiting(
      loginGen,
      effectiveWorkspaceId ?? '',
      workspaceGen,
      overviewGen,
    ),
    enabled: workspaceEnabled,
    queryFn: async ({ signal }) => {
      const wsId = effectiveWorkspaceId!;
      const fence = sessionGate.fenceTracker.capture({
        workspaceId: wsId,
        conversationId: null,
        includeOverview: true,
      });
      return controller.runFenced(
        fence,
        signal,
        (s) =>
          new Promise<WaitingBundle | null>((resolve, reject) => {
            let settled = false;
            let decisionResult: DecisionQueue | undefined;
            let todosResult: WaitingTodosQueue | undefined;
            let firstError: unknown = null;
            let hasError = false;
            let completed = 0;

            // React to the FIRST authoritative NULL (non-member) as soon as it arrives,
            // even while the sibling RPC is still held or if the sibling RPC fails.
            const triggerAuthoritativeLoss = (): void => {
              if (settled) return;
              settled = true;
              if (sessionGate.fenceTracker.isCurrent(fence)) {
                controller.evictWorkspaceScope(wsId);
              }
              resolve(null);
            };

            const onSuccess = (
              which: 'decision' | 'todos',
              value: DecisionQueue | WaitingTodosQueue | null,
            ): void => {
              if (settled) return;
              if (value === null) {
                triggerAuthoritativeLoss();
                return;
              }
              if (which === 'decision') {
                decisionResult = value as DecisionQueue;
              } else {
                todosResult = value as WaitingTodosQueue;
              }
              completed += 1;
              if (completed === 2) {
                settled = true;
                if (hasError) {
                  reject(firstError);
                  return;
                }
                if (!sessionGate.fenceTracker.isCurrent(fence)) {
                  reject(new StaleFenceError());
                  return;
                }
                resolve({
                  decisionQueue: decisionResult!,
                  waitingTodos: todosResult!,
                });
              }
            };

            const onError = (error: unknown): void => {
              if (settled) return;
              if (error instanceof StaleFenceError || s.aborted) {
                settled = true;
                reject(error);
                return;
              }
              if (!hasError) {
                hasError = true;
                firstError = error;
              }
              completed += 1;
              // Wait for the sibling before rejecting with a non-loss error so an
              // authoritative NULL from the sibling still retires the workspace.
              if (completed === 2) {
                settled = true;
                reject(firstError);
              }
            };

            readDecisionQueue(sessionGate, wsId, { fence, signal: s }).then(
              (val) => onSuccess('decision', val),
              onError,
            );
            readWaitingTodos(sessionGate, wsId, { fence, signal: s }).then(
              (val) => onSuccess('todos', val),
              onError,
            );
          }),
        'waiting',
      );
    },
  });

  // Pre-paint fence verification: never paint server data if login or workspace fence is no longer current.
  const activeFence = sessionGate.fenceTracker.capture({
    workspaceId: effectiveWorkspaceId,
    conversationId: null,
  });
  const canPaintWorkspace =
    workspaceEnabled && sessionGate.fenceTracker.isCurrent(activeFence);

  const workspaces = adaptWorkspaces(rawWorkspaces, effectiveWorkspaceId);
  const activeWorkspace = workspaces.find((ws) => ws.active) ?? null;
  const activeWorkspaceName = activeWorkspace?.name ?? 'CommonSwarm';

  const channels = useMemo(() => {
    if (!canPaintWorkspace || !conversationsQuery.data) return [];
    return adaptChannels(conversationsQuery.data);
  }, [canPaintWorkspace, conversationsQuery.data]);

  const directMessages = useMemo(() => {
    if (!canPaintWorkspace || !conversationsQuery.data || !snapshot.userId) {
      return [];
    }
    return adaptDirectMessages(
      conversationsQuery.data,
      snapshot.userId,
      membersQuery.data ?? [],
      agentsQuery.data?.principals ?? [],
    );
  }, [
    canPaintWorkspace,
    conversationsQuery.data,
    snapshot.userId,
    membersQuery.data,
    agentsQuery.data,
  ]);

  const agents = useMemo(() => {
    if (!canPaintWorkspace || !effectiveWorkspaceId || !agentsQuery.data) {
      return [];
    }
    return adaptAgents({
      workspaceId: effectiveWorkspaceId,
      principals: agentsQuery.data.principals,
      presence: agentsQuery.data.presence,
      wakePath: agentsQuery.data.wakePath,
      overview: overviewQuery.data ?? null,
      decisionQueue: waitingQuery.data?.decisionQueue ?? null,
    });
  }, [
    canPaintWorkspace,
    effectiveWorkspaceId,
    agentsQuery.data,
    overviewQuery.data,
    waitingQuery.data,
  ]);

  const people = useMemo(() => {
    if (!canPaintWorkspace || !membersQuery.data) return [];
    return adaptPeople(membersQuery.data);
  }, [canPaintWorkspace, membersQuery.data]);

  const waitingCount = useMemo(() => {
    if (!canPaintWorkspace || !waitingQuery.data) return null;
    return adaptWaitingCount(
      waitingQuery.data.decisionQueue,
      waitingQuery.data.waitingTodos,
    );
  }, [canPaintWorkspace, waitingQuery.data]);

  const currentUser = useMemo(() => {
    if (!snapshot.userId) return null;
    const normalizedUser = snapshot.userId.toLowerCase();
    return (
      people.find((person) => person.id.toLowerCase() === normalizedUser) ?? null
    );
  }, [people, snapshot.userId]);

  const sidebarLoading =
    workspacesQuery.isPending ||
    (workspaceEnabled &&
      (conversationsQuery.isPending ||
        agentsQuery.isPending ||
        membersQuery.isPending));

  const sidebarError =
    !sidebarLoading &&
    (workspacesQuery.isError ||
      (workspaceEnabled &&
        (conversationsQuery.isError ||
          agentsQuery.isError ||
          membersQuery.isError)));

  const retrySidebar = (): void => {
    if (workspacesQuery.isError) {
      void workspacesQuery.refetch();
    }
    if (workspaceEnabled) {
      if (conversationsQuery.isError) void conversationsQuery.refetch();
      if (agentsQuery.isError) void agentsQuery.refetch();
      if (membersQuery.isError) void membersQuery.refetch();
      if (waitingQuery.isError) void waitingQuery.refetch();
      if (overviewQuery.isError) void overviewQuery.refetch();
    }
  };

  return {
    mode: 'real',
    workspaces,
    workspacesLoading: workspacesQuery.isPending,
    workspacesError: workspacesQuery.isError,
    retryWorkspaces: () => {
      void workspacesQuery.refetch();
    },
    activeWorkspaceId: effectiveWorkspaceId,
    activeWorkspaceName,
    workspaceUnavailable: unavailableWorkspaceId !== null,
    channels,
    directMessages,
    agents,
    people,
    waitingCount,
    currentUser,
    sidebarLoading,
    sidebarError,
    retrySidebar,
    selectWorkspace: controller.selectWorkspace,
    selectConversation: (conversationId: string) => {
      controller.selectConversation(effectiveWorkspaceId, conversationId);
    },
  };
}
