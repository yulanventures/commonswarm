export type AvatarTone =
  | 'purple'
  | 'green'
  | 'blue'
  | 'amber'
  | 'maya'
  | 'jonas';

export type HarnessId = 'claude' | 'codex' | 'agy' | 'grok';

export type AgentState = 'waiting' | 'working' | 'idle';

export type PermissionMode =
  | 'Ask before edits'
  | 'Edit files, ask for commands'
  | 'Work on its own';

export interface Workspace {
  id: string;
  name: string;
  initial: string;
  active: boolean;
}

export interface Person {
  id: string;
  name: string;
  initials: string;
  tone: AvatarTone;
  presence: 'online' | 'away';
}

export interface Computer {
  id: string;
  name: string;
  shortName: string;
  online: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  name: string;
  tag: string;
  status: string;
  installed: boolean;
}

export type StepResult =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'diff'; added: number; removed: number };

export interface StepOutputPart {
  text: string;
  tone?: 'default' | 'added' | 'removed';
}

export interface StepOutput {
  headlineParts: StepOutputPart[];
  detail: string;
}

export interface AgentStep {
  id: string;
  kind: 'Read' | 'Search' | 'Ran' | 'Edited';
  target: string;
  phoneTarget?: string;
  result?: StepResult;
  state: 'ok' | 'error';
  output?: StepOutput;
  showOnPhone?: boolean;
}

export interface ApprovalOption {
  id: string;
  label: string;
  phoneLabel?: string;
  primary?: boolean;
}

export interface PersonMessageEvent {
  id: string;
  type: 'person_message';
  authorId: string;
  timestamp: string;
  text: string;
  phoneText?: string;
}

export interface AgentStepsEvent {
  id: string;
  type: 'agent_steps';
  agentId: string;
  durationLabel: string;
  steps: AgentStep[];
}

export interface AgentTextEvent {
  id: string;
  type: 'agent_text';
  agentId: string;
  text: string;
  phoneText?: string;
}

export interface ApprovalRequestEvent {
  id: string;
  type: 'approval_request';
  agentId: string;
  approvalId: string;
  title: string;
  command: string;
  options: ApprovalOption[];
  settledOptionId?: string;
  settledLabel?: string;
}

export interface QueuedMessageEvent {
  id: string;
  type: 'queued_message';
  authorName: string;
  text: string;
}

export type SessionEvent =
  | PersonMessageEvent
  | AgentStepsEvent
  | AgentTextEvent
  | ApprovalRequestEvent
  | QueuedMessageEvent;

export interface SessionFileChange {
  path: string;
  added: number;
  removed: number;
}

export interface SessionMeta {
  branch: string;
  contextUsedPercent: number;
  totalAdded: number;
  totalRemoved: number;
  files: SessionFileChange[];
  watcherIds: string[];
}

export interface Agent {
  id: string;
  name: string;
  initial: string;
  tone: AvatarTone;
  computerId: string;
  harnessId: HarnessId;
  folder: string;
  state: AgentState;
  stateElapsed: string;
  sidebarStateLabel: string;
  channelActivity: string;
  model: string;
  mode: PermissionMode;
  sessionMeta: SessionMeta;
  events: SessionEvent[];
}

export type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'mention'; agentId: string; label: string; tone: AvatarTone };

export interface WorkingCardData {
  statusLabel: string;
  activity: string;
  meta: string;
}

export interface ReviewChip {
  label: string;
  tone: 'working' | 'neutral' | 'needs-you';
}

export interface ReviewCardData {
  title: string;
  commit: string;
  chips: ReviewChip[];
}

export interface ChannelMessage {
  id: string;
  authorType: 'person' | 'agent';
  authorId: string;
  timestamp: string;
  segments?: MessageSegment[];
  workingCard?: WorkingCardData;
  reviewCard?: ReviewCardData;
}

export interface Channel {
  name: string;
  unread: boolean;
  peopleCount: number;
  agentIds: string[];
  messages: ChannelMessage[];
}

export type WaitingItemStatus = 'open' | 'dismissed' | 'resolved';

export interface WaitingApprovalItem {
  id: string;
  kind: 'approval';
  agentId: string;
  title: string;
  meta: string;
  command: string;
  options: ApprovalOption[];
  status: WaitingItemStatus;
  resolvedLabel?: string;
}

export interface WaitingChoiceOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface WaitingChoiceItem {
  id: string;
  kind: 'choice';
  agentId: string;
  title: string;
  meta: string;
  options: WaitingChoiceOption[];
  status: WaitingItemStatus;
  resolvedLabel?: string;
}

export interface WaitingReviewItem {
  id: string;
  kind: 'review';
  agentId: string;
  title: string;
  meta: string;
  targetRoute: string;
  status: WaitingItemStatus;
  resolvedLabel?: string;
}

export type WaitingItem =
  | WaitingApprovalItem
  | WaitingChoiceItem
  | WaitingReviewItem;

export interface ClearedItem {
  id: string;
  title: string;
  reason: string;
}

export interface SlashCommand {
  command: string;
  description: string;
  scopeBadge?: string;
}

export interface AddAgentDraft {
  computerId: string;
  harnessId: HarnessId;
  name: string;
  folder: string;
  mode: PermissionMode;
}
