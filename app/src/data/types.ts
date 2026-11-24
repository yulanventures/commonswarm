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
  presence?: 'online' | 'away';
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

export type AgentStepKind =
  | 'Read'
  | 'Search'
  | 'Ran'
  | 'Edited'
  | 'Tool'
  | 'Think';

export type AgentStepState = 'running' | 'ok' | 'error';

export interface AgentStep {
  id: string;
  kind: AgentStepKind;
  target: string;
  result?: StepResult;
  state: AgentStepState;
  output?: StepOutput;
}

export type ApprovalOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface ApprovalOption {
  id: string;
  kind?: ApprovalOptionKind;
  label: string;
  primary?: boolean;
}

export type SessionStatusKind =
  | 'turn_started'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'message_refused'
  | 'runner_stopped'
  | 'authority_lost';

export interface SessionStatusEvent {
  id: string;
  type: 'session_status';
  kind: SessionStatusKind;
  detail?: string;
  stopReason?: string;
  timestamp: string;
}

export interface PersonMessageEvent {
  id: string;
  type: 'person_message';
  authorId: string;
  timestamp: string;
  text: string;
  seen?: boolean;
}

export interface AgentStepsEvent {
  id: string;
  type: 'agent_steps';
  agentId: string;
  durationLabel: string;
  steps: AgentStep[];
}

export type AgentTextDelivery = 'posting' | 'posted' | 'failed' | 'abandoned';

export interface AgentTextEvent {
  id: string;
  type: 'agent_text';
  agentId: string;
  messageId?: string;
  text: string;
  streaming?: boolean;
  delivery?: AgentTextDelivery;
}

export interface ApprovalRequestEvent {
  id: string;
  type: 'approval_request';
  agentId: string;
  approvalId: string;
  title: string;
  command?: string;
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
  | QueuedMessageEvent
  | SessionStatusEvent;

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
  computerId?: string;
  harnessId?: HarnessId;
  folder?: string;
  state: AgentState;
  stateElapsed: string;
  sidebarStateLabel: string;
  channelActivity: string;
  model: string;
  mode?: PermissionMode;
  sessionMeta?: SessionMeta;
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

export type MessageCardKind = 'asked' | 'review_requested' | 'todo';

export interface ResolvedMention {
  readonly id: string;
  readonly kind: 'person' | 'agent';
  readonly name: string;
  readonly tone: AvatarTone;
  readonly source: 'author' | 'lead' | 'thread';
}

export interface ConversationMessage {
  readonly id: string;
  readonly authorType: 'person' | 'agent';
  readonly authorId: string;
  readonly authorName: string;
  readonly avatarLabel: string;
  readonly avatarTone: AvatarTone;
  readonly createdAt: string;
  readonly timeLabel: string;
  readonly body: string;
  readonly mentions: readonly ResolvedMention[];
  readonly replyCount: number;
  readonly cardKind: MessageCardKind | null;
  readonly cardLabel: 'Asked' | 'Review requested' | 'To-do' | null;
  readonly isThreadReply: boolean;
  readonly threadRootId: string | null;
}

export interface Channel {
  id?: string;
  name: string;
  kind?: 'general' | 'public_channel' | 'private_channel';
  isPrivate?: boolean;
  unread: boolean;
  unreadCount?: number;
  mentionCount?: number;
  muted?: boolean;
  peopleCount: number;
  agentIds: string[];
  messages: ChannelMessage[];
}

export interface SidebarDirectMessage {
  id: string;
  kind: 'dm' | 'group_dm';
  title: string;
  unread: boolean;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
}

export type WaitingItemKind = 'approval' | 'choice' | 'review';

export type ActiveWaitingItemStatus = 'open' | 'resolved';

export interface WaitingApprovalItem {
  id: string;
  kind: 'approval';
  agentId: string;
  title: string;
  meta: string;
  command?: string;
  options: ApprovalOption[];
  status: ActiveWaitingItemStatus;
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
  status: ActiveWaitingItemStatus;
  resolvedLabel?: string;
}

export interface WaitingReviewItem {
  id: string;
  kind: 'review';
  agentId: string;
  title: string;
  meta: string;
  targetRoute: string;
  status: ActiveWaitingItemStatus;
  resolvedLabel?: string;
}

export type ActiveWaitingItem =
  | WaitingApprovalItem
  | WaitingChoiceItem
  | WaitingReviewItem;

export interface DismissedWaitingItem {
  id: string;
  kind: WaitingItemKind;
  status: 'dismissed';
}

export type WaitingItem = ActiveWaitingItem | DismissedWaitingItem;

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
