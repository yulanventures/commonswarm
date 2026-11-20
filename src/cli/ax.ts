/**
 * Self-healing CLI AX helpers (Wave 1 V1 / shared V1+V3 contract):
 * - Opaque cursor codec (`--after <cursor>`): `base64url(JSON.stringify({ v: 1, created_at, id }))`
 * - Structured `--json` error envelopes (`{ ok: false, error, reason, message, next }`)
 * - Secret scrubbing so tokens, JWTs, and credential contents are never echoed
 * - Continuation command builders and richer `whoami --json` conversation summaries
 */
import type { AgentChannelList } from "../cloud/channels.js";
import type { ConversationSummaryWire } from "../cloud/conversations.js";
import { quoteAgentArgument } from "../cloud/agent-onboarding-contract.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]{1,512}$/;
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/i;

export interface OpaqueCursor {
  v: 1;
  created_at: string;
  id: string;
}

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";
  readonly reason: CliAxReason = "invalid_cursor";

  constructor(
    message = "Invalid --after cursor. Pass the opaque next_cursor from a previous read, or omit --after.",
  ) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export class ConversationReadRefusedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConversationReadRefusedError";
    this.status = status;
    this.code = code;
  }
}

export function encodeOpaqueCursor(cursor: { created_at: string; id: string }): string {
  if (
    typeof cursor.created_at !== "string" ||
    !ISO_8601_RE.test(cursor.created_at) ||
    !Number.isFinite(Date.parse(cursor.created_at))
  ) {
    throw new InvalidCursorError("Cannot encode cursor: created_at must be a valid ISO-8601 timestamp.");
  }
  if (typeof cursor.id !== "string" || !UUID_RE.test(cursor.id)) {
    throw new InvalidCursorError("Cannot encode cursor: id must be a UUID.");
  }
  const payload: OpaqueCursor = {
    v: 1,
    created_at: cursor.created_at,
    id: cursor.id.toLowerCase(),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeOpaqueCursor(raw: string): OpaqueCursor {
  if (typeof raw !== "string" || !BASE64URL_RE.test(raw)) {
    throw new InvalidCursorError();
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64url");
  } catch {
    throw new InvalidCursorError();
  }
  // Reject non-canonical base64url encodings (e.g. stray trailing bits).
  if (bytes.length === 0 || bytes.toString("base64url") !== raw) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidCursorError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "created_at" || keys[1] !== "id" || keys[2] !== "v") {
    throw new InvalidCursorError();
  }
  if (record.v !== 1) {
    throw new InvalidCursorError();
  }
  if (
    typeof record.created_at !== "string" ||
    !ISO_8601_RE.test(record.created_at) ||
    !Number.isFinite(Date.parse(record.created_at))
  ) {
    throw new InvalidCursorError();
  }
  if (typeof record.id !== "string" || !UUID_RE.test(record.id)) {
    throw new InvalidCursorError();
  }
  return {
    v: 1,
    created_at: record.created_at,
    id: record.id.toLowerCase(),
  };
}

/**
 * Pick the newest valid `(created_at, id)` pair from a message list regardless
 * of page ordering so `next_cursor` always anchors cleanly at the tip.
 */
export function latestMessageCursor(
  messages: ReadonlyArray<Record<string, unknown>>,
): { created_at: string; id: string } | null {
  let best: { created_at: string; id: string; ms: number } | null = null;
  for (const row of messages) {
    const createdAt = row.created_at;
    const id = row.id;
    if (
      typeof createdAt !== "string" ||
      !ISO_8601_RE.test(createdAt) ||
      typeof id !== "string" ||
      !UUID_RE.test(id)
    ) {
      continue;
    }
    const ms = Date.parse(createdAt);
    if (!Number.isFinite(ms)) continue;
    const normalizedId = id.toLowerCase();
    if (
      best === null ||
      ms > best.ms ||
      (ms === best.ms && normalizedId > best.id)
    ) {
      best = { created_at: createdAt, id: normalizedId, ms };
    }
  }
  return best === null ? null : { created_at: best.created_at, id: best.id };
}

/** Strip ANSI escapes, control chars, and any token/JWT/secret material from output. */
export function scrubCliSecrets(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\bswm_(?:agt|cap|tok)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /"(agent_token|access_token|refresh_token|anon_key|connection_secret|token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .slice(0, 1000);
}

export type CliAxReason =
  | "profile_session_mismatch"
  | "not_configured"
  | "auth_expired"
  | "access_lost"
  | "channel_not_found"
  | "conversation_not_found"
  | "not_a_member"
  | "invalid_cursor"
  | "invalid_arguments"
  | "rate_limited"
  | "timeout"
  | "request_id_conflict"
  | "command_failed";

export interface CliJsonErrorEnvelope {
  ok: false;
  error: string;
  reason: CliAxReason;
  message: string;
  next: string[];
}

export interface OnboardingCliJsonErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
  reason: CliAxReason;
  message: string;
  next: string[];
}

export interface CliErrorContext {
  verb?: string;
  subcommand?: string;
  profilePath?: string;
  hostSessionId?: string;
  workspaceId?: string;
  conversationId?: string;
  channelSelector?: string;
  isUsageError?: boolean;
}

function safeAuthFlags(ctx: CliErrorContext, includeHostSession = true): string {
  const parts: string[] = [];
  if (ctx.profilePath) {
    parts.push(`--profile ${quoteAgentArgument(ctx.profilePath)}`);
    if (includeHostSession && ctx.hostSessionId) {
      parts.push(`--host-session-id ${quoteAgentArgument(ctx.hostSessionId)}`);
    }
  }
  if (ctx.workspaceId && UUID_RE.test(ctx.workspaceId)) {
    parts.push(`--workspace-id ${ctx.workspaceId.toLowerCase()}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function commandLabel(ctx: CliErrorContext): string {
  if (!ctx.verb) return "cswarm";
  return ctx.subcommand ? `cswarm ${ctx.verb} ${ctx.subcommand}` : `cswarm ${ctx.verb}`;
}

export function buildConversationReadNext(options: {
  conversationId: string;
  afterCursor: string;
  profilePath?: string;
  hostSessionId?: string;
  workspaceId?: string;
  limit?: number;
}): string {
  const parts = [
    "cswarm",
    "conversation",
    "read",
    options.conversationId.toLowerCase(),
    "--after",
    options.afterCursor,
  ];
  if (options.limit !== undefined && options.limit !== 50) {
    parts.push("--limit", String(options.limit));
  }
  if (options.profilePath) {
    parts.push("--profile", quoteAgentArgument(options.profilePath));
    if (options.hostSessionId) {
      parts.push("--host-session-id", quoteAgentArgument(options.hostSessionId));
    }
  }
  if (options.workspaceId && UUID_RE.test(options.workspaceId)) {
    parts.push("--workspace-id", options.workspaceId.toLowerCase());
  }
  parts.push("--json");
  return parts.join(" ");
}

export function buildCheckNext(options: {
  profilePath: string;
  workspaceId: string;
  hostSessionId?: string;
  afterCursor?: string | null;
}): string {
  const parts = [
    "cswarm",
    "check",
    "--profile",
    quoteAgentArgument(options.profilePath),
    "--workspace-id",
    options.workspaceId.toLowerCase(),
  ];
  if (options.hostSessionId) {
    parts.push("--host-session-id", quoteAgentArgument(options.hostSessionId));
  }
  if (options.afterCursor) {
    parts.push("--after", options.afterCursor);
  }
  parts.push("--json");
  return parts.join(" ");
}

function extractRawCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; error?: unknown };
  if (typeof record.code === "string" && ERROR_CODE_RE.test(record.code)) {
    return record.code;
  }
  if (typeof record.error === "string" && ERROR_CODE_RE.test(record.error)) {
    return record.error;
  }
  return null;
}

function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function extractErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

export function classifyCliError(
  error: unknown,
  ctx: CliErrorContext = {},
): { error: string; reason: CliAxReason; next: string[] } {
  const rawCode = extractRawCode(error);
  const status = extractHttpStatus(error);
  const name = extractErrorName(error);
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const lower = message.toLowerCase();
  const flags = safeAuthFlags(ctx);
  const setupHint = "cswarm setup --connection-file <private-file> --host-session-id <this-session-id> --json";

  // 1. Invalid cursor
  if (
    error instanceof InvalidCursorError ||
    rawCode === "invalid_cursor" ||
    rawCode === "cursor_not_found"
  ) {
    const next = ctx.verb === "conversation" && ctx.subcommand === "read" && ctx.conversationId && UUID_RE.test(ctx.conversationId)
      ? [`cswarm conversation read ${ctx.conversationId.toLowerCase()}${flags} --json`]
      : ctx.verb === "check" && ctx.profilePath
      ? [`cswarm check${flags} --json`]
      : [`${commandLabel(ctx)} --help`];
    return { error: rawCode ?? "invalid_cursor", reason: "invalid_cursor", next };
  }

  // 2. Profile / host-session binding mismatch
  if (
    rawCode === "profile_other_session" ||
    rawCode === "host_session_required" ||
    rawCode === "setup_host_session_required" ||
    rawCode === "host_session_invalid" ||
    lower.includes("this profile belongs to another session")
  ) {
    if (rawCode === "profile_other_session" || lower.includes("this profile belongs to another session")) {
      return {
        error: rawCode ?? "profile_other_session",
        reason: "profile_session_mismatch",
        next: [setupHint],
      };
    }
    const profilePart = ctx.profilePath ? ` --profile ${quoteAgentArgument(ctx.profilePath)}` : " --profile <profile>";
    return {
      error: rawCode ?? "host_session_required",
      reason: "profile_session_mismatch",
      next: [
        "cswarm setup guide",
        `${commandLabel(ctx)}${profilePart} --host-session-id <this-session-id> --json`,
      ],
    };
  }

  // 3. Request ID conflict
  if (rawCode === "request_id_conflict" || name === "RequestIdConflict") {
    return {
      error: "request_id_conflict",
      reason: "request_id_conflict",
      next: ["Use a fresh --request-id for a new write, or keep the exact same inputs to replay."],
    };
  }

  // 4. Channel / conversation not found & not-a-member
  if (
    rawCode === "channel_not_found" ||
    lower.includes("there is no channel named") ||
    lower.includes("there is no channel with") ||
    lower.includes("no channel with that")
  ) {
    return {
      error: rawCode ?? "channel_not_found",
      reason: "channel_not_found",
      next: [
        `cswarm channel ls${flags} --json`,
        `cswarm conversations${flags} --json`,
      ],
    };
  }

  if (
    rawCode === "conversation_not_found" ||
    lower.includes("this conversation isn't available")
  ) {
    return {
      error: rawCode ?? "conversation_not_found",
      reason: "conversation_not_found",
      next: [`cswarm conversations${flags} --json`],
    };
  }

  if (
    rawCode === "conversation_not_member" ||
    lower.includes("join the channel before") ||
    lower.includes("join the conversation first") ||
    lower.includes("aren't in this channel")
  ) {
    const joinTarget = ctx.channelSelector ? quoteAgentArgument(ctx.channelSelector) : "<channel>";
    return {
      error: rawCode ?? "conversation_not_member",
      reason: "not_a_member",
      next: [
        `cswarm channel join ${joinTarget}${flags} --json`,
        `cswarm conversations${flags} --json`,
      ],
    };
  }

  // 5. Invalid flags / arguments
  if (
    ctx.isUsageError === true ||
    name === "UsageError" ||
    name === "ReplyStatusUsageError" ||
    rawCode === "check_options_invalid" ||
    rawCode === "hook_options_invalid" ||
    rawCode === "receive_command_invalid" ||
    rawCode === "profile_flags_conflict" ||
    rawCode === "profile_command_invalid" ||
    rawCode === "invalid_request" ||
    lower.startsWith("unknown option:") ||
    lower.includes("requires a value") ||
    lower.includes("too few positional arguments") ||
    lower.includes("too many positional arguments") ||
    lower.includes("must be given together")
  ) {
    const helpCmd = ctx.verb ? `cswarm ${ctx.verb} --help` : "cswarm --help";
    return {
      error: rawCode ?? "invalid_arguments",
      reason: "invalid_arguments",
      next: [helpCmd],
    };
  }

  // 6. Rate-limit / quota
  if (
    status === 429 ||
    rawCode === "rate_limited" ||
    rawCode === "quota_exceeded" ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests")
  ) {
    return {
      error: rawCode ?? "rate_limited",
      reason: "rate_limited",
      next: ["Wait for the rate-limit window to reset, then rerun the same command."],
    };
  }

  // 7. Timeouts
  if (
    rawCode === "check_timeout" ||
    rawCode === "ETIMEDOUT" ||
    name === "SignalReadTimeoutError" ||
    name === "FileLockTimeoutError" ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    const retryCmd = ctx.verb === "check" && ctx.profilePath
      ? `cswarm check${flags} --json`
      : ctx.verb === "conversation" && ctx.subcommand === "read" && ctx.conversationId && UUID_RE.test(ctx.conversationId)
      ? `cswarm conversation read ${ctx.conversationId.toLowerCase()}${flags} --json`
      : `${commandLabel(ctx)}${flags} --json`;
    return {
      error: rawCode ?? "timeout",
      reason: "timeout",
      next: [retryCmd],
    };
  }

  // 8. Access lost / revoked / forbidden
  if (
    status === 403 ||
    name === "RenewalRevoked" ||
    name === "RenewalSuspended" ||
    rawCode === "forbidden" ||
    rawCode === "authenticated_identity_mismatch" ||
    rawCode === "renewal_grant_revoked" ||
    rawCode === "renewal_lineage_revoked" ||
    rawCode === "predecessor_revoked" ||
    rawCode === "renewal_grant_suspended" ||
    rawCode === "hosted_seat_revoked" ||
    rawCode === "hosted_seat_forbidden" ||
    lower.includes("revoked") ||
    lower.includes("suspended") ||
    lower.includes("forbidden")
  ) {
    return {
      error: rawCode ?? "access_lost",
      reason: "access_lost",
      next: [
        ...(ctx.profilePath ? [`cswarm resume${flags} --json`] : []),
        setupHint,
      ],
    };
  }

  // 9. Auth expired / unauthenticated
  // Never suggest `cswarm login` when a transient refresh error preserved the saved credential.
  if (lower.includes("your credential was kept")) {
    return {
      error: rawCode ?? "transient_auth_error",
      reason: "timeout",
      next: ["Retry the same command."],
    };
  }
  if (
    status === 401 ||
    name === "RenewalReauthorisationRequired" ||
    rawCode === "unauthenticated" ||
    rawCode === "token_expired" ||
    rawCode === "human_session_refresh_failed" ||
    lower.includes("unauthenticated") ||
    lower.includes("expired") ||
    lower.includes("reauthori")
  ) {
    const isHuman = rawCode === "human_session_refresh_failed" || lower.includes("cswarm login");
    return {
      error: rawCode ?? "auth_expired",
      reason: "auth_expired",
      next: isHuman
        ? ["cswarm login"]
        : [
            `cswarm whoami${flags} --json`,
            setupHint,
          ],
    };
  }

  // 10. Not configured / missing setup, target, credential, or workspace
  if (
    rawCode === "profile_missing" ||
    rawCode === "profile_credential_missing" ||
    rawCode === "human_session_missing" ||
    rawCode === "workspace_not_selected" ||
    rawCode === "workspace_ambiguous" ||
    rawCode === "no_workspaces" ||
    rawCode?.startsWith("agent_credential_") === true ||
    lower.includes("not logged in") ||
    lower.includes("run cswarm login") ||
    lower.includes("--connection-file is required") ||
    lower.includes("no cloud target") ||
    lower.includes("no workspace selected") ||
    lower.includes("needs --agent-token-file")
  ) {
    if (rawCode === "workspace_not_selected" || rawCode === "workspace_ambiguous" || lower.includes("no workspace selected")) {
      return {
        error: rawCode ?? "not_configured",
        reason: "not_configured",
        next: [
          `cswarm workspaces${flags} --json`,
          "cswarm use <workspace-id>",
        ],
      };
    }
    if (rawCode === "human_session_missing" || lower.includes("not logged in") || lower.includes("run cswarm login")) {
      return {
        error: rawCode ?? "not_configured",
        reason: "not_configured",
        next: ["cswarm login", setupHint],
      };
    }
    return {
      error: rawCode ?? "not_configured",
      reason: "not_configured",
      next: [setupHint, "cswarm setup guide"],
    };
  }

  // Fallback: preserve machine code when present and provide a safe recovery step.
  return {
    error: rawCode ?? (status !== null ? `http_${status}` : "command_failed"),
    reason: "command_failed",
    next: [ctx.verb ? `cswarm ${ctx.verb} --help` : "cswarm --help"],
  };
}

export function buildCliErrorEnvelope(
  error: unknown,
  ctx: CliErrorContext = {},
  renderedMessage?: string,
): CliJsonErrorEnvelope {
  const classified = classifyCliError(error, ctx);
  const rawMessage = renderedMessage ?? (error instanceof Error ? error.message : "unknown error");
  return {
    ok: false,
    error: classified.error,
    reason: classified.reason,
    message: scrubCliSecrets(rawMessage),
    next: classified.next.map(scrubCliSecrets),
  };
}

export function buildOnboardingErrorEnvelope(
  error: unknown,
  code: string,
  renderedMessage: string,
  ctx: CliErrorContext = {},
): OnboardingCliJsonErrorEnvelope {
  const classified = classifyCliError(error, ctx);
  const safeMessage = scrubCliSecrets(renderedMessage);
  return {
    ok: false,
    error: { code, message: safeMessage },
    reason: classified.reason,
    message: safeMessage,
    next: classified.next.map(scrubCliSecrets),
  };
}

export interface WhoamiChannelEntry {
  conversation_id: string | null;
  channel_id: string | null;
  kind: "general" | "public_channel" | "private_channel";
  slug: string;
  joined: boolean;
  unread_count: number | null;
  mention_count: number | null;
  unread?: boolean | null;
}

export interface WhoamiDirectMessageEntry {
  conversation_id: string;
  kind: "dm" | "group_dm";
  members: Array<{ kind: "user" | "agent"; id: string; name: string | null }>;
  unread_count: number;
  mention_count: number;
}

export interface WhoamiConversationsSummary {
  source: "conversations" | "channels_fallback" | "unavailable";
  channels: WhoamiChannelEntry[];
  direct_messages: WhoamiDirectMessageEntry[];
  total_unread: number | null;
  total_mentions: number | null;
}

export function summarizeWhoamiConversations(
  conversations: readonly ConversationSummaryWire[],
): WhoamiConversationsSummary {
  const channels: WhoamiChannelEntry[] = [];
  const direct_messages: WhoamiDirectMessageEntry[] = [];
  let totalUnread = 0;
  let totalMentions = 0;

  for (const c of conversations) {
    if (c.archived_at !== null) continue;
    if (c.kind === "general" || c.kind === "public_channel" || c.kind === "private_channel") {
      channels.push({
        conversation_id: c.conversation_id,
        channel_id: c.channel_id,
        kind: c.kind,
        slug: c.kind === "general" ? "general" : (c.slug ?? c.conversation_id),
        joined: c.joined,
        unread_count: c.unread_count,
        mention_count: c.mention_count,
      });
      if (c.joined) {
        totalUnread += c.unread_count;
        totalMentions += c.mention_count;
      }
    } else if (c.kind === "dm" || c.kind === "group_dm") {
      direct_messages.push({
        conversation_id: c.conversation_id,
        kind: c.kind,
        members: c.members
          .filter((m) => m.left_at === null)
          .map((m) => ({ kind: m.kind, id: m.id, name: m.name })),
        unread_count: c.unread_count,
        mention_count: c.mention_count,
      });
      totalUnread += c.unread_count;
      totalMentions += c.mention_count;
    }
  }

  return {
    source: "conversations",
    channels,
    direct_messages,
    total_unread: totalUnread,
    total_mentions: totalMentions,
  };
}

export function summarizeWhoamiChannelsFallback(
  list: AgentChannelList,
): WhoamiConversationsSummary {
  const channels: WhoamiChannelEntry[] = [
    {
      conversation_id: null,
      channel_id: null,
      kind: "general",
      slug: "general",
      joined: true,
      unread_count: null,
      mention_count: null,
      unread: list.general_unread,
    },
    ...list.channels
      .filter((row) => row.archived_at === null)
      .map((row): WhoamiChannelEntry => ({
        conversation_id: null,
        channel_id: row.channel_id,
        kind: row.visibility === "private" ? "private_channel" : "public_channel",
        slug: row.slug,
        joined: true,
        unread_count: null,
        mention_count: null,
        unread: row.unread ?? null,
      })),
  ];
  return {
    source: "channels_fallback",
    channels,
    direct_messages: [],
    total_unread: null,
    total_mentions: null,
  };
}

export function unavailableWhoamiConversations(): WhoamiConversationsSummary {
  return {
    source: "unavailable",
    channels: [],
    direct_messages: [],
    total_unread: null,
    total_mentions: null,
  };
}
