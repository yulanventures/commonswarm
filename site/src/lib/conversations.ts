/**
 * Conversations (Step 3 UI foundation): pure client models, wire builders, response decoders,
 * and UI affordance rules for #general, public and private channels, 1:1 DMs, and group DMs.
 *
 * Every command shape matches Step 2a (`supabase/functions/command/conversations.ts`), verified
 * directly against `parseConversationCommand` in `conversations.test.mjs`. Read-list fields stay
 * decoupled from the exact Step 2b transport so PR 3B-3D plug straight into Step 2b reads.
 */
import { channelLabel, GENERAL_CHANNEL_SLUG } from "./channels.js";

export const CONVERSATION_KINDS = [
  "general",
  "public_channel",
  "private_channel",
  "dm",
  "group_dm",
] as const;
export type ConversationKind = typeof CONVERSATION_KINDS[number];

export const CONVERSATION_NOTIFY_LEVELS = ["everything", "mentions", "muted"] as const;
export type ConversationNotifyLevel = typeof CONVERSATION_NOTIFY_LEVELS[number];

/** Maximum members in a 1:1 or group DM, caller included (sender + 8 recipients). */
export const CONVERSATION_MEMBER_MAX = 9;
/** Maximum members in a single `conversation_invite` command. */
export const CONVERSATION_INVITE_MAX = 50;

export interface ConversationMemberRef {
  kind: "user" | "agent";
  id: string;
}

export interface ConversationMember extends ConversationMemberRef {
  name?: string | null;
  leftAt?: string | null;
}

/** One conversation row for the sidebar and directory (fed by Step 2b `conversations` read). */
export interface ConversationSummary {
  conversationId: string;
  kind: ConversationKind;
  channelId: string | null;
  slug: string | null;
  description: string | null;
  archivedAt: string | null;
  joined: boolean;
  generation?: number;
  leadMode?: "workspace" | "agent" | "none" | null;
  leadAgentPrincipalId?: string | null;
  members: readonly ConversationMember[];
  notifyLevel: ConversationNotifyLevel;
  starred: boolean;
  starRank: number | null;
  readThroughAt?: string | null;
  readThroughId?: string | null;
  unreadCount: number | null;
  mentionCount: number | null;
  lastMessageAt: string | null;
  lastMessageId: string | null;
}

/**
 * Read-only owner oversight row (Step 2b `conversation_oversight`). Deliberately omits personal
 * notification, star, read-mark, and unread fields so oversight rows cannot enter personal sidebar
 * or unread state (V4 C2).
 */
export interface OversightConversationSummary {
  conversationId: string;
  kind: ConversationKind;
  channelId: string | null;
  slug: string | null;
  description: string | null;
  archivedAt: string | null;
  generation: number;
  members: readonly ConversationMember[];
  lastMessageAt: string | null;
  lastMessageId: string | null;
  readOnly: true;
}

export interface ConversationCursor {
  createdAt: string;
  id: string;
}

export interface ConversationHistoryOptions {
  before?: ConversationCursor | null;
  after?: ConversationCursor | null;
  limit?: number;
  includeMentions?: boolean;
  includeReactions?: boolean;
}

export type ConversationHistoryResult<T> =
  | {
    ok: true;
    conversation: ConversationSummary;
    messages: T[];
    hasMore: boolean;
    nextBefore: ConversationCursor | null;
    nextAfter: ConversationCursor | null;
  }
  | { ok: false; code: "conversation_not_found" | "other"; message: string };

export type OversightHistoryResult<T> =
  | {
    ok: true;
    conversation: OversightConversationSummary;
    messages: T[];
    hasMore: boolean;
    nextBefore: ConversationCursor | null;
    nextAfter: ConversationCursor | null;
  }
  | { ok: false; code: "conversation_not_found" | "other"; message: string };

export interface OpenedConversation {
  conversationId: string;
  kind: "dm" | "group_dm";
  generation: number;
  members: ConversationMemberRef[];
}

export type ConversationOpenErrorCode =
  | "conversation_left"
  | "conversation_member_left"
  | "conversation_member_not_in_workspace"
  | "conversation_too_large"
  | "forbidden"
  | "other";

export type ConversationOpenResult =
  | { ok: true; conversation: OpenedConversation; created: boolean }
  | {
    ok: false;
    code: ConversationOpenErrorCode;
    message: string;
    /** True only when another member left and the caller may explicitly start a new group. */
    canStartNewGroup: boolean;
  };

export type ConversationActionErrorCode =
  | "conversation_not_found"
  | "signal_not_found"
  | "channel_archived"
  | "conversation_private_channel"
  | "conversation_cannot_leave"
  | "conversation_members_fixed"
  | "conversation_not_member"
  | "conversation_member_not_in_workspace"
  | "forbidden"
  | "other";

export type ConversationActionResult =
  | {
    ok: true;
    conversationId: string;
    kind?: ConversationKind;
    channelId?: string | null;
    changed?: boolean;
    membersAdded?: ConversationMemberRef[];
    readThroughAt?: string | null;
    notifyLevel?: ConversationNotifyLevel;
    starred?: boolean;
    starRank?: number | null;
  }
  | { ok: false; code: ConversationActionErrorCode; message: string };

export const CONVERSATION_UNAVAILABLE_TEXT =
  "This conversation isn't available in this workspace.";
export const GROUP_LEAVE_CONFIRM_BODY =
  "You'll lose access to this group's history. Leaving is final; a current member must start a new group to include you again.";
export const DM_ATTACHMENTS_REFUSAL_TEXT =
  "Attachments aren't available in private conversations.";
export const NOTES_TO_SELF_LABEL = "Notes to self";

export function isDirectKind(kind: ConversationKind): boolean {
  return kind === "dm" || kind === "group_dm";
}

export function isChannelKind(kind: ConversationKind): boolean {
  return kind === "general" || kind === "public_channel" || kind === "private_channel";
}

/** #general and 1:1 DMs cannot be left (mute a 1:1 instead). Public/private channels and group DMs can. */
export function canLeaveConversation(kind: ConversationKind): boolean {
  return kind === "public_channel" || kind === "private_channel" || kind === "group_dm";
}

/** Only live public and private channels accept member invites; #general, DMs and group DMs are fixed. */
export function canInviteToConversation(kind: ConversationKind, archived: boolean): boolean {
  return !archived && (kind === "public_channel" || kind === "private_channel");
}

/**
 * Fail-closed attachment check for conversations: only #general and open public channels allow
 * workspace-readable file attachments. Private channels, 1:1 DMs, group DMs, and unknown kinds
 * refuse attachments before any upload starts.
 */
export function attachmentsAllowedInConversation(kind: ConversationKind | null | undefined): boolean {
  return kind === "general" || kind === "public_channel";
}

function joinLabelNames(names: readonly string[]): string {
  if (names.length === 0) return "Direct message";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Human-readable title for any conversation kind. */
export function conversationTitle(
  conv: Pick<ConversationSummary, "kind" | "slug" | "members">,
  viewerUserId: string,
  lookupName?: (member: ConversationMemberRef) => string | null | undefined,
): string {
  if (conv.kind === "general") return channelLabel(GENERAL_CHANNEL_SLUG);
  if (conv.kind === "public_channel" || conv.kind === "private_channel") {
    return conv.slug ? channelLabel(conv.slug) : "Channel";
  }
  const live = conv.members.filter((m) => !m.leftAt);
  const others = live.filter((m) => !(m.kind === "user" && m.id === viewerUserId));
  if (others.length === 0) return NOTES_TO_SELF_LABEL;
  const names = others.map((m) => {
    const resolved = (m.name ?? lookupName?.(m) ?? "").trim();
    return resolved || (m.kind === "agent" ? "Agent" : "Member");
  });
  return joinLabelNames(names);
}

/** Direct messages and group DMs sorted newest-activity first, with conversationId as a stable tiebreak. */
export function sortDirectConversations<T extends Pick<ConversationSummary, "conversationId" | "kind" | "lastMessageAt">>(
  list: readonly T[],
): T[] {
  return list
    .filter((item) => isDirectKind(item.kind))
    .sort((left, right) => {
      const a = left.lastMessageAt ?? "";
      const b = right.lastMessageAt ?? "";
      if (a !== b) return a > b ? -1 : 1;
      return left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0;
    });
}

export type ConversationBadge =
  | { kind: "none" }
  | { kind: "dot"; label: string }
  | { kind: "mentions"; text: string; label: string };

/**
 * Unread/mention indicator for one conversation row.
 * Muted conversations suppress visual indicators while keeping server unread state intact.
 */
export function conversationUnreadBadge(
  conv: Pick<ConversationSummary, "archivedAt" | "notifyLevel" | "unreadCount" | "mentionCount">,
): ConversationBadge {
  if (conv.archivedAt !== null || conv.notifyLevel === "muted") return { kind: "none" };
  const mentions = conv.mentionCount ?? 0;
  if (mentions > 0) {
    const whole = Math.floor(mentions);
    return {
      kind: "mentions",
      text: whole > 99 ? "99+" : String(whole),
      label: `${whole} ${whole === 1 ? "mention" : "mentions"}`,
    };
  }
  const unread = conv.unreadCount ?? 0;
  if (unread > 0) return { kind: "dot", label: `${Math.floor(unread)} unread` };
  return { kind: "none" };
}

function dedupeMembers(list: readonly ConversationMemberRef[]): ConversationMemberRef[] {
  const seen = new Set<string>();
  const out: ConversationMemberRef[] = [];
  for (const m of list) {
    const id = m.id.toLowerCase();
    const key = `${m.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m.kind, id });
  }
  return out;
}

/* ── Step 2a command payload builders ─────────────────────────────────────────────────────── */

export function buildOpenConversationCommand(
  members: readonly ConversationMemberRef[],
  newGroup = false,
): Record<string, unknown> {
  const clean = dedupeMembers(members);
  return {
    kind: "conversation_open",
    members: clean,
    ...(newGroup ? { new_group: true } : {}),
  };
}

export function buildJoinConversationCommand(conversationId: string): Record<string, unknown> {
  return { kind: "conversation_join", conversation_id: conversationId.toLowerCase() };
}

export function buildLeaveConversationCommand(conversationId: string): Record<string, unknown> {
  return { kind: "conversation_leave", conversation_id: conversationId.toLowerCase() };
}

export function buildInviteConversationCommand(
  conversationId: string,
  members: readonly ConversationMemberRef[],
): Record<string, unknown> {
  return {
    kind: "conversation_invite",
    conversation_id: conversationId.toLowerCase(),
    members: dedupeMembers(members),
  };
}

export function buildRemoveConversationCommand(
  conversationId: string,
  member: ConversationMemberRef,
): Record<string, unknown> {
  return {
    kind: "conversation_remove",
    conversation_id: conversationId.toLowerCase(),
    member: { kind: member.kind, id: member.id.toLowerCase() },
  };
}

export function buildMarkConversationReadCommand(
  conversationId: string,
  throughSignalId: string | null = null,
): Record<string, unknown> {
  return {
    kind: "conversation_mark_read",
    conversation_id: conversationId.toLowerCase(),
    ...(throughSignalId ? { through_signal_id: throughSignalId.toLowerCase() } : {}),
  };
}

export function buildSetConversationNotifyCommand(
  conversationId: string,
  change: {
    notifyLevel?: ConversationNotifyLevel;
    starred?: boolean;
    starRank?: number | null;
  },
): Record<string, unknown> {
  return {
    kind: "conversation_set_notify",
    conversation_id: conversationId.toLowerCase(),
    ...(change.notifyLevel !== undefined ? { notify_level: change.notifyLevel } : {}),
    ...(change.starred !== undefined ? { starred: change.starred } : {}),
    ...(change.starred === true && change.starRank !== undefined ? { star_rank: change.starRank } : {}),
  };
}

/* ── Step 2a wire response decoders ───────────────────────────────────────────────────────── */

function parseMemberRefs(value: unknown): ConversationMemberRef[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationMemberRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if ((row.kind === "user" || row.kind === "agent") && typeof row.id === "string") {
      out.push({ kind: row.kind, id: row.id.toLowerCase() });
    }
  }
  return out;
}

function errorSentence(body: Record<string, unknown>, fallback: string): string {
  for (const key of ["message", "reason"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

const OPEN_ERROR_CODES = new Set<ConversationOpenErrorCode>([
  "conversation_left",
  "conversation_member_left",
  "conversation_member_not_in_workspace",
  "conversation_too_large",
  "forbidden",
]);

export function parseConversationOpenResponse(
  status: number,
  body: Record<string, unknown>,
): ConversationOpenResult {
  if (status === 200 && body.status === "accepted" && body.conversation && typeof body.conversation === "object") {
    const conv = body.conversation as Record<string, unknown>;
    const kind = conv.kind === "group_dm" ? "group_dm" : conv.kind === "dm" ? "dm" : null;
    if (typeof conv.conversation_id === "string" && kind !== null) {
      return {
        ok: true,
        conversation: {
          conversationId: conv.conversation_id.toLowerCase(),
          kind,
          generation: typeof conv.generation === "number" ? conv.generation : 1,
          members: parseMemberRefs(conv.members),
        },
        created: body.created === true,
      };
    }
  }
  const raw = typeof body.error === "string" ? body.error : "other";
  const code: ConversationOpenErrorCode = OPEN_ERROR_CODES.has(raw as ConversationOpenErrorCode)
    ? (raw as ConversationOpenErrorCode)
    : "other";
  return {
    ok: false,
    code,
    message: errorSentence(body, "CommonSwarm could not open that conversation."),
    canStartNewGroup: code === "conversation_member_left",
  };
}

const ACTION_ERROR_CODES = new Set<ConversationActionErrorCode>([
  "conversation_not_found",
  "signal_not_found",
  "channel_archived",
  "conversation_private_channel",
  "conversation_cannot_leave",
  "conversation_members_fixed",
  "conversation_not_member",
  "conversation_member_not_in_workspace",
  "forbidden",
]);

export function parseConversationActionResponse(
  status: number,
  body: Record<string, unknown>,
  fallbackMessage: string,
): ConversationActionResult {
  if (status === 200 && body.status === "accepted" && typeof body.conversation_id === "string") {
    const kind = (CONVERSATION_KINDS as readonly unknown[]).includes(body.kind)
      ? (body.kind as ConversationKind)
      : undefined;
    const notifyLevel = (CONVERSATION_NOTIFY_LEVELS as readonly unknown[]).includes(body.notify_level)
      ? (body.notify_level as ConversationNotifyLevel)
      : undefined;
    return {
      ok: true,
      conversationId: body.conversation_id.toLowerCase(),
      ...(kind !== undefined ? { kind } : {}),
      ...(Object.hasOwn(body, "channel_id")
        ? { channelId: typeof body.channel_id === "string" ? body.channel_id.toLowerCase() : null }
        : {}),
      ...(typeof body.changed === "boolean" ? { changed: body.changed } : {}),
      ...(Array.isArray(body.members_added) ? { membersAdded: parseMemberRefs(body.members_added) } : {}),
      ...(Object.hasOwn(body, "read_through_at")
        ? { readThroughAt: typeof body.read_through_at === "string" ? body.read_through_at : null }
        : {}),
      ...(notifyLevel !== undefined ? { notifyLevel } : {}),
      ...(typeof body.starred === "boolean" ? { starred: body.starred } : {}),
      ...(Object.hasOwn(body, "star_rank")
        ? { starRank: typeof body.star_rank === "number" ? body.star_rank : null }
        : {}),
    };
  }
  const raw = typeof body.error === "string" ? body.error : "other";
  const code: ConversationActionErrorCode = ACTION_ERROR_CODES.has(raw as ConversationActionErrorCode)
    ? (raw as ConversationActionErrorCode)
    : "other";
  return {
    ok: false,
    code,
    message: errorSentence(body, fallbackMessage),
  };
}

/* ── Step 2b read request builders & decoders (`POST /functions/v1/read`) ────────────────── */

export function buildListConversationsRequest(
  workspaceId: string,
  includeArchived = false,
): Record<string, unknown> {
  return {
    resource: "conversations",
    workspace_id: workspaceId.toLowerCase(),
    include_archived: includeArchived,
  };
}

function historyCursorFields(options: ConversationHistoryOptions = {}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (options.before) {
    fields.before_created_at = options.before.createdAt;
    fields.before_id = options.before.id.toLowerCase();
  }
  if (options.after) {
    fields.after_created_at = options.after.createdAt;
    fields.after_id = options.after.id.toLowerCase();
  }
  if (options.limit !== undefined) fields.limit = options.limit;
  if (options.includeMentions !== undefined) fields.include_mentions = options.includeMentions;
  if (options.includeReactions !== undefined) fields.include_reactions = options.includeReactions;
  return fields;
}

export function buildConversationHistoryRequest(
  workspaceId: string,
  conversationId: string,
  options: ConversationHistoryOptions = {},
): Record<string, unknown> {
  return {
    resource: "conversation_history",
    workspace_id: workspaceId.toLowerCase(),
    conversation_id: conversationId.toLowerCase(),
    ...historyCursorFields(options),
  };
}

export function buildOversightListRequest(
  workspaceId: string,
  agentPrincipalId: string,
): Record<string, unknown> {
  return {
    resource: "conversation_oversight",
    workspace_id: workspaceId.toLowerCase(),
    agent_principal_id: agentPrincipalId.toLowerCase(),
  };
}

export function buildOversightHistoryRequest(
  workspaceId: string,
  conversationId: string,
  agentPrincipalId: string,
  options: ConversationHistoryOptions = {},
): Record<string, unknown> {
  return {
    resource: "conversation_oversight_history",
    workspace_id: workspaceId.toLowerCase(),
    conversation_id: conversationId.toLowerCase(),
    agent_principal_id: agentPrincipalId.toLowerCase(),
    ...historyCursorFields(options),
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseConversationMembers(value: unknown): ConversationMember[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationMember[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if ((row.kind === "user" || row.kind === "agent") && typeof row.id === "string") {
      out.push({
        kind: row.kind,
        id: row.id.toLowerCase(),
        name: nullableText(row.name),
        leftAt: nullableText(row.left_at),
      });
    }
  }
  return out;
}

function parseCursor(value: unknown): ConversationCursor | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.created_at !== "string" || typeof row.id !== "string") return null;
  return { createdAt: row.created_at, id: row.id.toLowerCase() };
}

export function parseConversationSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.conversation_id !== "string") return null;
  if (!(CONVERSATION_KINDS as readonly unknown[]).includes(row.kind)) return null;
  const notifyLevel = (CONVERSATION_NOTIFY_LEVELS as readonly unknown[]).includes(row.notify_level)
    ? (row.notify_level as ConversationNotifyLevel)
    : "everything";
  const leadMode = row.lead_mode === "workspace" || row.lead_mode === "agent" || row.lead_mode === "none"
    ? row.lead_mode
    : null;
  return {
    conversationId: row.conversation_id.toLowerCase(),
    kind: row.kind as ConversationKind,
    channelId: nullableText(row.channel_id)?.toLowerCase() ?? null,
    slug: nullableText(row.slug),
    description: nullableText(row.description),
    archivedAt: nullableText(row.archived_at),
    joined: row.joined === true,
    generation: typeof row.generation === "number" ? row.generation : 0,
    leadMode,
    leadAgentPrincipalId: nullableText(row.lead_agent_principal_id)?.toLowerCase() ?? null,
    members: parseConversationMembers(row.members),
    notifyLevel,
    starred: row.starred === true,
    starRank: nullableNumber(row.star_rank),
    readThroughAt: nullableText(row.read_through_at),
    readThroughId: nullableText(row.read_through_id)?.toLowerCase() ?? null,
    unreadCount: nullableNumber(row.unread_count),
    mentionCount: nullableNumber(row.mention_count),
    lastMessageAt: nullableText(row.last_message_at),
    lastMessageId: nullableText(row.last_message_id)?.toLowerCase() ?? null,
  };
}

export function parseOversightConversationSummary(value: unknown): OversightConversationSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.conversation_id !== "string") return null;
  if (!(CONVERSATION_KINDS as readonly unknown[]).includes(row.kind)) return null;
  return {
    conversationId: row.conversation_id.toLowerCase(),
    kind: row.kind as ConversationKind,
    channelId: nullableText(row.channel_id)?.toLowerCase() ?? null,
    slug: nullableText(row.slug),
    description: nullableText(row.description),
    archivedAt: nullableText(row.archived_at),
    generation: typeof row.generation === "number" ? row.generation : 0,
    members: parseConversationMembers(row.members),
    lastMessageAt: nullableText(row.last_message_at),
    lastMessageId: nullableText(row.last_message_id)?.toLowerCase() ?? null,
    readOnly: true,
  };
}

export function parseConversationsListResponse(body: Record<string, unknown>): ConversationSummary[] {
  if (!Array.isArray(body.conversations)) return [];
  const out: ConversationSummary[] = [];
  for (const row of body.conversations) {
    const parsed = parseConversationSummary(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type ConversationsListOutcome =
  | { status: "ready"; conversations: ConversationSummary[] }
  | { status: "unsupported"; message: string }
  | { status: "failed"; message: string };

const UNSUPPORTED_CONVERSATIONS_READ_ERRORS = new Set([
  "invalid_request",
  "invalid_resource",
  "unsupported_resource",
  "not_found",
]);

/**
 * Classifies a `POST /functions/v1/read` (`resource: "conversations"`) response.
 * Only an explicit pre-Step-2b not-supported refusal selects `"unsupported"`.
 * An empty 200, malformed 200 (missing `conversations` array), or any transient/unexpected error
 * returns `"failed"` so the UI shows Retry and never exposes the legacy composer.
 */
export function parseConversationsListOutcome(
  status: number,
  body: Record<string, unknown>,
): ConversationsListOutcome {
  if (status === 200) {
    if (Array.isArray(body.conversations)) {
      return { status: "ready", conversations: parseConversationsListResponse(body) };
    }
    return { status: "failed", message: errorSentence(body, "Couldn't check channel membership.") };
  }
  const code = typeof body.error === "string" ? body.error : "";
  if (status === 404 || (status === 400 && UNSUPPORTED_CONVERSATIONS_READ_ERRORS.has(code))) {
    return { status: "unsupported", message: errorSentence(body, `Conversations read unavailable (HTTP ${status}).`) };
  }
  return { status: "failed", message: errorSentence(body, "Couldn't check channel membership.") };
}

export function parseOversightListResponse(body: Record<string, unknown>): OversightConversationSummary[] {
  if (!Array.isArray(body.conversations)) return [];
  const out: OversightConversationSummary[] = [];
  for (const row of body.conversations) {
    const parsed = parseOversightConversationSummary(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseConversationHistoryResponse<T>(
  status: number,
  body: Record<string, unknown>,
  mapMessage: (row: Record<string, unknown>) => T,
): ConversationHistoryResult<T> {
  if (status === 404 || body.error === "conversation_not_found") {
    return {
      ok: false,
      code: "conversation_not_found",
      message: errorSentence(body, CONVERSATION_UNAVAILABLE_TEXT),
    };
  }
  const conversation = parseConversationSummary(body.conversation);
  if (status === 200 && conversation && Array.isArray(body.messages)) {
    return {
      ok: true,
      conversation,
      messages: body.messages
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
        .map(mapMessage),
      hasMore: body.has_more === true,
      nextBefore: parseCursor(body.next_before),
      nextAfter: parseCursor(body.next_after),
    };
  }
  return {
    ok: false,
    code: "other",
    message: errorSentence(body, "CommonSwarm could not load this conversation."),
  };
}

export function parseOversightHistoryResponse<T>(
  status: number,
  body: Record<string, unknown>,
  mapMessage: (row: Record<string, unknown>) => T,
): OversightHistoryResult<T> {
  if (status === 404 || body.error === "conversation_not_found") {
    return {
      ok: false,
      code: "conversation_not_found",
      message: errorSentence(body, CONVERSATION_UNAVAILABLE_TEXT),
    };
  }
  const conversation = parseOversightConversationSummary(body.conversation);
  if (status === 200 && conversation && Array.isArray(body.messages)) {
    return {
      ok: true,
      conversation,
      messages: body.messages
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
        .map(mapMessage),
      hasMore: body.has_more === true,
      nextBefore: parseCursor(body.next_before),
      nextAfter: parseCursor(body.next_after),
    };
  }
  return {
    ok: false,
    code: "other",
    message: errorSentence(body, "CommonSwarm could not load this conversation."),
  };
}

