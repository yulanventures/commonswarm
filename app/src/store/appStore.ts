import { useSyncExternalStore } from 'react';
import {
  CURRENT_USER_ID,
  DEFAULT_ADD_AGENT_DRAFT,
  INITIAL_EXPANDED_STEPS,
  createInitialAgents,
  createInitialChannels,
  createInitialClearedItems,
  createInitialWaitingItems,
} from '../data/fixtures';
import type {
  AddAgentDraft,
  Agent,
  AvatarTone,
  Channel,
  ClearedItem,
  PermissionMode,
  WaitingItem,
} from '../data/types';

export type WaitingFilter = 'open' | 'archived';

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

function formatSettledApprovalLabel(optionId: string): string {
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
          item.id === id ? { ...item, status: 'dismissed' as const } : item,
        ),
        announcement: `Dismissed ${target.title}`,
      };
    });
  },

  undoDismissWaitingItem(id: string): void {
    setState((prev) => {
      const target = prev.waitingItems.find((item) => item.id === id);
      if (!target || target.status !== 'dismissed') return prev;
      return {
        ...prev,
        waitingItems: prev.waitingItems.map((item): WaitingItem =>
          item.id === id ? { ...item, status: 'open' as const } : item,
        ),
        announcement: `Restored ${target.title}`,
      };
    });
  },

  answerApproval(approvalId: string, optionId: string): void {
    const settledLabel = formatSettledApprovalLabel(optionId);
    setState((prev) => {
      let matchedAgentName = '';
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
      const waitingItems = prev.waitingItems.map((item) =>
        item.id === approvalId
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
      if (!target || target.kind !== 'choice' || target.status !== 'open') {
        return prev;
      }
      const option = target.options.find((opt) => opt.id === optionId);
      const label = option ? option.label : optionId;
      return {
        ...prev,
        waitingItems: prev.waitingItems.map((item) =>
          item.id === waitingId
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
};
