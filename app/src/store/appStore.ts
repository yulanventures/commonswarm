import { useSyncExternalStore } from 'react';
import {
  CURRENT_USER_ID,
  DEFAULT_ADD_AGENT_DRAFT,
  INITIAL_EXPANDED_STEPS,
  createInitialAgents,
  createInitialChannels,
  createInitialClearedItems,
  createInitialWaitingItems,
  getFixtureWaitingItem,
} from '../data/fixtures';
import type {
  AddAgentDraft,
  Agent,
  ApprovalOptionKind,
  AvatarTone,
  Channel,
  ClearedItem,
  PermissionMode,
  WaitingItem,
} from '../data/types';

export type WaitingFilter = 'open' | 'archived';

export interface ScopedConversationId {
  readonly workspaceId: string;
  readonly conversationId: string;
}

export interface AppState {
  agents: Agent[];
  channels: Channel[];
  waitingItems: WaitingItem[];
  clearedItems: ClearedItem[];
  expandedSteps: Record<string, boolean>;
  composerDrafts: Record<string, string>;
  waitingFilter: WaitingFilter;
  addAgentDialogOpen: boolean;
  addAgentDraft: AddAgentDraft;
  announcement: string;
  selectedWorkspaceId: string | null;
  selectedConversation: ScopedConversationId | null;
  unavailableWorkspaceId: string | null;
  revokedWorkspaceIds: string[];
  unavailableConversation: ScopedConversationId | null;
  revokedConversationKeys: string[];
  knownPrivateConversationIds: string[];
}

type Listener = () => void;

const AGENT_TONE_CYCLE: readonly AvatarTone[] = [
  'purple',
  'green',
  'blue',
  'amber',
];

function createInitialState(): AppState {
  return {
    agents: createInitialAgents(),
    channels: createInitialChannels(),
    waitingItems: createInitialWaitingItems(),
    clearedItems: createInitialClearedItems(),
    expandedSteps: { ...INITIAL_EXPANDED_STEPS },
    composerDrafts: {},
    waitingFilter: 'open',
    addAgentDialogOpen: false,
    addAgentDraft: { ...DEFAULT_ADD_AGENT_DRAFT },
    announcement: '',
    selectedWorkspaceId: null,
    selectedConversation: null,
    unavailableWorkspaceId: null,
    revokedWorkspaceIds: [],
    unavailableConversation: null,
    revokedConversationKeys: [],
    knownPrivateConversationIds: [],
  };
}

let state: AppState = createInitialState();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(updater: (prev: AppState) => AppState): void {
  state = updater(state);
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): AppState {
  return state;
}

export function useAppStore<T>(selector: (snapshot: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getOpenWaitingCount(snapshot: AppState): number {
  return snapshot.waitingItems.filter((item) => item.status === 'open').length;
}

export function resetAppStore(): void {
  state = createInitialState();
  emit();
}

function formatSettledApprovalLabel(
  optionId: string,
  kind?: ApprovalOptionKind,
): string {
  switch (kind) {
    case 'allow_once':
      return 'Allowed once';
    case 'allow_always':
      return 'Always allowed in this folder';
    case 'reject_once':
      return 'Denied';
    case 'reject_always':
      return 'Always denied';
  }
  switch (optionId) {
    case 'allow-once':
      return 'Allowed once';
    case 'always-folder':
      return 'Always allowed in this folder';
    case 'deny':
      return 'Denied';
    default:
      return 'Answered';
  }
}

export const appActions = {
  dismissWaitingItem(id: string): void {
    setState((prev) => {
      const target = prev.waitingItems.find((item) => item.id === id);
      if (!target || target.status !== 'open') return prev;
      return {
        ...prev,
        waitingItems: prev.waitingItems.map((item): WaitingItem =>
          item.id === id
            ? { id: target.id, kind: target.kind, status: 'dismissed' }
            : item,
        ),
        announcement: 'Dismissed',
      };
    });
  },

  undoDismissWaitingItem(id: string): void {
    setState((prev) => {
      const target = prev.waitingItems.find((item) => item.id === id);
      if (!target || target.status !== 'dismissed') return prev;
      const restored = getFixtureWaitingItem(target.kind, target.id);
      if (!restored) return prev;
      return {
        ...prev,
        waitingItems: prev.waitingItems.map((item): WaitingItem =>
          item.id === id ? restored : item,
        ),
        announcement: 'Restored',
      };
    });
  },

  answerApproval(approvalId: string, optionId: string): void {
    setState((prev) => {
      let matchedAgentName = '';
      let matchedKind: ApprovalOptionKind | undefined;

      for (const agent of prev.agents) {
        for (const event of agent.events) {
          if (
            event.type === 'approval_request' &&
            event.approvalId === approvalId
          ) {
            matchedKind = event.options.find(
              (option) => option.id === optionId,
            )?.kind;
            break;
          }
        }
      }

      const settledLabel = formatSettledApprovalLabel(optionId, matchedKind);

      const agents = prev.agents.map((agent) => {
        const hasApproval = agent.events.some(
          (event) =>
            event.type === 'approval_request' &&
            event.approvalId === approvalId,
        );
        if (!hasApproval) return agent;
        matchedAgentName = agent.name;
        return {
          ...agent,
          state: 'working' as const,
          stateElapsed: 'now',
          sidebarStateLabel: 'Working',
          channelActivity: 'Working · pushing branch',
          events: agent.events.map((event) =>
            event.type === 'approval_request' && event.approvalId === approvalId
              ? {
                  ...event,
                  settledOptionId: optionId,
                  settledLabel,
                }
              : event,
          ),
        };
      });

      const waitingTarget = prev.waitingItems.find(
        (item) => item.id === approvalId,
      );
      const waitingItems = prev.waitingItems.map((item): WaitingItem =>
        item.id === approvalId && item.status !== 'dismissed'
          ? { ...item, status: 'resolved' as const, resolvedLabel: settledLabel }
          : item,
      );

      const clearedItems =
        waitingTarget && waitingTarget.status === 'open'
          ? [
              {
                id: `cleared-${approvalId}`,
                title: waitingTarget.title,
                reason: `${settledLabel} by Maya`,
              },
              ...prev.clearedItems,
            ]
          : prev.clearedItems;

      return {
        ...prev,
        agents,
        waitingItems,
        clearedItems,
        announcement: matchedAgentName
          ? `${settledLabel}. ${matchedAgentName} is now Working.`
          : settledLabel,
      };
    });
  },

  answerChoice(waitingId: string, optionId: string): void {
    setState((prev) => {
      const target = prev.waitingItems.find((item) => item.id === waitingId);
      if (!target || target.status !== 'open' || target.kind !== 'choice') {
        return prev;
      }
      const option = target.options.find((opt) => opt.id === optionId);
      const label = option ? option.label : optionId;
      return {
        ...prev,
        waitingItems: prev.waitingItems.map((item): WaitingItem =>
          item.id === waitingId && item.status !== 'dismissed'
            ? { ...item, status: 'resolved' as const, resolvedLabel: label }
            : item,
        ),
        clearedItems: [
          {
            id: `cleared-${waitingId}`,
            title: target.title,
            reason: `Answered: ${label}`,
          },
          ...prev.clearedItems,
        ],
        announcement: `Answered ${target.title}: ${label}`,
      };
    });
  },

  toggleStep(stepId: string): void {
    setState((prev) => ({
      ...prev,
      expandedSteps: {
        ...prev.expandedSteps,
        [stepId]: !prev.expandedSteps[stepId],
      },
    }));
  },

  setComposerDraft(targetKey: string, value: string): void {
    setState((prev) => ({
      ...prev,
      composerDrafts: {
        ...prev.composerDrafts,
        [targetKey]: value,
      },
    }));
  },

  setAgentModel(agentId: string, model: string): void {
    setState((prev) => ({
      ...prev,
      agents: prev.agents.map((agent) =>
        agent.id === agentId ? { ...agent, model } : agent,
      ),
      announcement: `Model set to ${model}`,
    }));
  },

  setAgentMode(agentId: string, mode: PermissionMode): void {
    setState((prev) => ({
      ...prev,
      agents: prev.agents.map((agent) =>
        agent.id === agentId ? { ...agent, mode } : agent,
      ),
      announcement: `Mode set to ${mode}`,
    }));
  },

  sendAgentMessage(agentId: string): void {
    const key = `agent:${agentId}`;
    setState((prev) => {
      const text = (prev.composerDrafts[key] ?? '').trim();
      if (!text) return prev;
      return {
        ...prev,
        agents: prev.agents.map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                events: [
                  ...agent.events,
                  {
                    id: `evt-queued-${Date.now()}`,
                    type: 'queued_message',
                    authorName: 'Maya',
                    text,
                  },
                ],
              }
            : agent,
        ),
        composerDrafts: {
          ...prev.composerDrafts,
          [key]: '',
        },
        announcement: 'Message queued',
      };
    });
  },

  sendChannelMessage(channelName: string): void {
    const key = `channel:${channelName}`;
    setState((prev) => {
      const text = (prev.composerDrafts[key] ?? '').trim();
      if (!text) return prev;
      return {
        ...prev,
        channels: prev.channels.map((channel) =>
          channel.name === channelName
            ? {
                ...channel,
                messages: [
                  ...channel.messages,
                  {
                    id: `msg-${Date.now()}`,
                    authorType: 'person',
                    authorId: CURRENT_USER_ID,
                    timestamp: 'Just now',
                    segments: [{ type: 'text', value: text }],
                  },
                ],
              }
            : channel,
        ),
        composerDrafts: {
          ...prev.composerDrafts,
          [key]: '',
        },
        announcement: `Message sent to #${channelName}`,
      };
    });
  },

  setWaitingFilter(filter: WaitingFilter): void {
    setState((prev) => ({
      ...prev,
      waitingFilter: filter,
    }));
  },

  openAddAgentDialog(): void {
    setState((prev) => ({
      ...prev,
      addAgentDialogOpen: true,
    }));
  },

  closeAddAgentDialog(): void {
    setState((prev) => ({
      ...prev,
      addAgentDialogOpen: false,
    }));
  },

  updateAddAgentDraft(patch: Partial<AddAgentDraft>): void {
    setState((prev) => ({
      ...prev,
      addAgentDraft: {
        ...prev.addAgentDraft,
        ...patch,
      },
    }));
  },

  submitAddAgent(): string | null {
    const draft = state.addAgentDraft;
    const trimmedName = draft.name.trim();
    if (!trimmedName || draft.computerId === 'another') {
      setState((prev) => ({ ...prev, addAgentDialogOpen: false }));
      return null;
    }

    const baseSlug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const id =
      baseSlug && !state.agents.some((agent) => agent.id === baseSlug)
        ? baseSlug
        : `${baseSlug || 'agent'}-${state.agents.length + 1}`;
    const tone =
      AGENT_TONE_CYCLE[state.agents.length % AGENT_TONE_CYCLE.length] ??
      'purple';

    const newAgent: Agent = {
      id,
      name: trimmedName,
      initial: trimmedName.charAt(0).toUpperCase(),
      tone,
      computerId: draft.computerId,
      harnessId: draft.harnessId,
      folder: draft.folder.trim() || '~/northwind',
      state: 'idle',
      stateElapsed: 'now',
      sidebarStateLabel: 'Idle · now',
      channelActivity: 'Idle',
      model: 'Opus 5.5 · High',
      mode: draft.mode,
      sessionMeta: {
        branch: 'main',
        contextUsedPercent: 0,
        totalAdded: 0,
        totalRemoved: 0,
        files: [],
        watcherIds: [CURRENT_USER_ID],
      },
      events: [],
    };

    setState((prev) => ({
      ...prev,
      agents: [...prev.agents, newAgent],
      addAgentDialogOpen: false,
      addAgentDraft: { ...DEFAULT_ADD_AGENT_DRAFT },
      announcement: `Started agent ${newAgent.name}`,
    }));

    return id;
  },

  selectWorkspace(workspaceId: string | null): void {
    const normalized = workspaceId ? workspaceId.toLowerCase() : null;
    setState((prev) => {
      if (normalized !== null && prev.revokedWorkspaceIds.includes(normalized)) {
        // Selecting a revoked workspace must never clear its unavailable state.
        return {
          ...prev,
          selectedWorkspaceId: normalized,
          selectedConversation: null,
          unavailableWorkspaceId: normalized,
          unavailableConversation: null,
          knownPrivateConversationIds: [],
        };
      }
      const sameWorkspace = prev.selectedWorkspaceId === normalized;
      return {
        ...prev,
        selectedWorkspaceId: normalized,
        selectedConversation: sameWorkspace ? prev.selectedConversation : null,
        unavailableWorkspaceId: null,
        unavailableConversation: sameWorkspace
          ? prev.unavailableConversation
          : null,
        knownPrivateConversationIds: sameWorkspace
          ? prev.knownPrivateConversationIds
          : [],
      };
    });
  },

  selectConversation(
    workspaceId: string | null,
    conversationId: string | null,
  ): void {
    const normWs = workspaceId ? workspaceId.toLowerCase() : null;
    const normConv = conversationId ? conversationId.toLowerCase() : null;
    setState((prev) => {
      if (!normWs || !normConv) {
        if (prev.selectedConversation === null) return prev;
        return {
          ...prev,
          selectedConversation: null,
        };
      }
      const nextSelection: ScopedConversationId = {
        workspaceId: normWs,
        conversationId: normConv,
      };
      const convKey = `${normWs}:${normConv}`;
      const isRevoked = prev.revokedConversationKeys.includes(convKey);
      const nextUnavailable = isRevoked
        ? nextSelection
        : prev.unavailableConversation;
      if (
        prev.selectedConversation?.workspaceId === normWs &&
        prev.selectedConversation?.conversationId === normConv &&
        prev.unavailableConversation?.workspaceId ===
          nextUnavailable?.workspaceId &&
        prev.unavailableConversation?.conversationId ===
          nextUnavailable?.conversationId
      ) {
        return prev;
      }
      return {
        ...prev,
        selectedConversation: nextSelection,
        unavailableConversation: nextUnavailable,
      };
    });
  },

  markWorkspaceUnavailable(workspaceId: string): void {
    const normalized = workspaceId.toLowerCase();
    setState((prev) => ({
      ...prev,
      selectedConversation: null,
      unavailableWorkspaceId: normalized,
      revokedWorkspaceIds: prev.revokedWorkspaceIds.includes(normalized)
        ? prev.revokedWorkspaceIds
        : [...prev.revokedWorkspaceIds, normalized],
      unavailableConversation: null,
      knownPrivateConversationIds: [],
    }));
  },

  markConversationUnavailable(
    workspaceId: string,
    conversationId: string,
  ): void {
    const normWs = workspaceId.toLowerCase();
    const normConv = conversationId.toLowerCase();
    const key = `${normWs}:${normConv}`;
    setState((prev) => ({
      ...prev,
      unavailableConversation: {
        workspaceId: normWs,
        conversationId: normConv,
      },
      revokedConversationKeys: prev.revokedConversationKeys.includes(key)
        ? prev.revokedConversationKeys
        : [...prev.revokedConversationKeys, key],
      knownPrivateConversationIds: prev.knownPrivateConversationIds.filter(
        (id) => id !== normConv,
      ),
    }));
  },

  recordConversationRevoked(workspaceId: string, conversationId: string): void {
    const normWs = workspaceId.toLowerCase();
    const normConv = conversationId.toLowerCase();
    const key = `${normWs}:${normConv}`;
    setState((prev) => ({
      ...prev,
      revokedConversationKeys: prev.revokedConversationKeys.includes(key)
        ? prev.revokedConversationKeys
        : [...prev.revokedConversationKeys, key],
      knownPrivateConversationIds: prev.knownPrivateConversationIds.filter(
        (id) => id !== normConv,
      ),
    }));
  },

  clearUnavailableConversation(): void {
    setState((prev) =>
      prev.unavailableConversation === null
        ? prev
        : { ...prev, unavailableConversation: null },
    );
  },

  setKnownPrivateConversationIds(ids: readonly string[]): void {
    const normalized = ids.map((id) => id.toLowerCase());
    setState((prev) => ({
      ...prev,
      knownPrivateConversationIds: normalized,
    }));
  },

  /**
   * Synchronously reset every store slice that holds server-derived state.
   * Called on login-generation changes and bfcache retirement before any await.
   */
  resetServerState(): void {
    setState((prev) => ({
      ...prev,
      selectedWorkspaceId: null,
      selectedConversation: null,
      unavailableWorkspaceId: null,
      revokedWorkspaceIds: [],
      unavailableConversation: null,
      revokedConversationKeys: [],
      knownPrivateConversationIds: [],
    }));
  },
};
