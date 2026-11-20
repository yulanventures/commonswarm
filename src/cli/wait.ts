/**
 * Blocking `cswarm wait` on Step 2b conversations, channels, and threads (Wave 1 V3).
 *
 * Uses `POST /functions/v1/read` (`conversations` and `conversation_history` with
 * paired `after_created_at`/`after_id` cursors), shares V1's exact opaque cursor
 * format (`base64url(JSON.stringify({ v: 1, created_at, id }))`) and structured
 * `--json` error envelope (`{ ok: false, error, reason, message, next }`), stops
 * immediately on 401/403/404 access loss, honors `Retry-After` / 429 with bounded
 * jittered backoff, and tears down cleanly on `SIGINT` / `SIGTERM`.
 */
import { channelSelectorProblem, isGeneralChannel } from "../cloud/channels.js";
import type { SignalRecord } from "../cloud/command-client.js";
import { readEndpoint, type CloudTarget } from "../cloud/config.js";
import {
  findChannelConversation,
  type ConversationCursorWire,
  type ConversationSummaryWire,
} from "../cloud/conversations.js";
import {
  observeSurfacedDeliveries,
  surfacedDeliveryIds,
} from "../cloud/delivery-observation.js";
import { parseServerErrorEnvelope } from "../cloud/error-envelope.js";
import { parseRetryAfterMs } from "../cloud/signals.js";

export const WAIT_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const WAIT_MAX_TIMEOUT_MS = 30 * 60_000;
export const WAIT_REQUEST_TIMEOUT_MS = 30_000;
export const WAIT_POLL_INITIAL_MS = 1_000;
export const WAIT_POLL_MAX_MS = 3_000;
export const WAIT_ERROR_BACKOFF_MAX_MS = 10_000;
export const WAIT_PAGE_LIMIT = 50;

export const WAIT_TIMED_OUT_EXIT_CODE = 124;
export const WAIT_SIGINT_EXIT_CODE = 130;
export const WAIT_SIGTERM_EXIT_CODE = 143;

const WAIT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAIT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const WAIT_ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const WAIT_DURATION_RE = /^([1-9]\d*)(ms|s|m)$/;

export type WaitActorKind = "user" | "agent";

export interface WaitActorIdentity {
  kind: WaitActorKind;
  id: string;
}

export interface WaitJsonErrorEnvelope {
  ok: false;
  error: string;
  reason: string;
  message: string;
  next: string[];
  matched?: false;
  conversation_id?: string | null;
  cursor?: string | null;
  signal?: "SIGINT" | "SIGTERM";
}

export interface WaitMatchResult {
  ok: true;
  matched: true;
  conversation_id: string;
  event: Record<string, unknown>;
  cursor: string;
  next: string[];
}

export interface WaitTimeoutResult {
  ok: false;
  matched: false;
  error: "timeout";
  reason: "timeout";
  message: string;
  conversation_id: string;
  cursor: string | null;
  next: string[];
}

export class WaitCommandError extends Error {
  readonly name = "WaitCommandError";

  constructor(
    readonly payload: WaitJsonErrorEnvelope,
    readonly exitCode: number = 1,
  ) {
    super(payload.message);
  }
}

export function sanitizeWaitText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

export function isValidIsoTimestamp(value: string): boolean {
  const match = WAIT_ISO_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  if (match[8] !== "Z") {
    const offHour = Number(match[10]);
    const offMinute = Number(match[11]);
    if (offHour > 23 || offMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * Shared V1/V3 opaque cursor codec:
 * `base64url(JSON.stringify({ v: 1, created_at: "<ISO-8601>", id: "<uuid>" }))`
 */
export function encodeConversationCursor(cursor: ConversationCursorWire): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      created_at: cursor.created_at,
      id: cursor.id.toLowerCase(),
    }),
    "utf8",
  ).toString("base64url");
}

function invalidCursorError(detail: string, nextHint?: string): WaitCommandError {
  return new WaitCommandError(
    {
      ok: false,
      error: "invalid_cursor",
      reason: "invalid_cursor",
      message: detail,
      next: [
        nextHint ??
          "cswarm wait --conversation <conversation-id> --json",
      ],
    },
    1,
  );
}

/**
 * Strictly decode and validate an opaque V1/V3 `--after` cursor.
 * Rejects malformed base64url, non-object JSON, unexpected keys, `v !== 1`,
 * invalid ISO-8601 `created_at`, or non-UUID `id`.
 */
export function decodeConversationCursor(raw: string, nextHint?: string): ConversationCursorWire {
  if (raw.length === 0 || raw.length > 512 || !WAIT_BASE64URL_RE.test(raw)) {
    throw invalidCursorError("Invalid --after cursor: expected a base64url cursor from a prior read or wait.", nextHint);
  }
  let decodedBytes: Buffer;
  try {
    decodedBytes = Buffer.from(raw, "base64url");
  } catch {
    throw invalidCursorError("Invalid --after cursor: malformed base64url encoding.", nextHint);
  }
  if (decodedBytes.toString("base64url") !== raw) {
    throw invalidCursorError("Invalid --after cursor: non-canonical base64url encoding.", nextHint);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedBytes.toString("utf8"));
  } catch {
    throw invalidCursorError("Invalid --after cursor: decoded payload is not valid JSON.", nextHint);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidCursorError("Invalid --after cursor: expected a JSON object.", nextHint);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(record, "v") ||
    !Object.hasOwn(record, "created_at") ||
    !Object.hasOwn(record, "id")
  ) {
    throw invalidCursorError("Invalid --after cursor: expected exact fields v, created_at, and id.", nextHint);
  }
  if (record.v !== 1) {
    throw invalidCursorError("Invalid --after cursor: unsupported cursor version (expected v: 1).", nextHint);
  }
  if (typeof record.created_at !== "string" || !isValidIsoTimestamp(record.created_at)) {
    throw invalidCursorError("Invalid --after cursor: created_at must be a valid ISO-8601 timestamp.", nextHint);
  }
  if (typeof record.id !== "string" || !WAIT_UUID_RE.test(record.id)) {
    throw invalidCursorError("Invalid --after cursor: id must be a valid UUID.", nextHint);
  }
  return {
    created_at: record.created_at,
    id: record.id.toLowerCase(),
  };
}

/**
 * Parse `--timeout <duration>` (`500ms`, `10s`, `5m`, up to `30m`).
 */
export function parseWaitTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return WAIT_DEFAULT_TIMEOUT_MS;
  const match = WAIT_DURATION_RE.exec(raw.trim());
  if (!match) {
    throw new WaitCommandError(
      {
        ok: false,
        error: "invalid_arguments",
        reason: "invalid_arguments",
        message: "--timeout must be a positive duration such as 10s, 5m, or 30m (max 30m).",
        next: ["cswarm wait --help"],
      },
      1,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > WAIT_MAX_TIMEOUT_MS) {
    throw new WaitCommandError(
      {
        ok: false,
        error: "invalid_arguments",
        reason: "invalid_arguments",
        message: "--timeout must be between 1ms and 30m.",
        next: ["cswarm wait --timeout 30m --help"],
      },
      1,
    );
  }
  return ms;
}

export interface WaitTargetDescriptor {
  conversationId?: string;
  channel?: string;
  threadRootId?: string;
  mentions: boolean;
  json: boolean;
}

export function buildWaitNextCommand(
  target: WaitTargetDescriptor,
  resolvedConversationId: string | null,
  cursor: string | null,
): string {
  const parts = ["cswarm", "wait"];
  if (resolvedConversationId !== null) {
    parts.push("--conversation", resolvedConversationId.toLowerCase());
  } else if (target.conversationId !== undefined) {
    parts.push("--conversation", target.conversationId.toLowerCase());
  } else if (target.channel !== undefined) {
    parts.push("--channel", target.channel);
  }
  if (target.threadRootId !== undefined) {
    parts.push("--thread", target.threadRootId.toLowerCase());
  }
  if (target.mentions) {
    parts.push("--mentions");
  }
  if (cursor !== null) {
    parts.push("--after", cursor);
  }
  if (target.json) {
    parts.push("--json");
  }
  return parts.join(" ");
}

/**
 * Exact UTC millisecond bucket matching Postgres `date_trunc('milliseconds', created_at)`
 * used by `swarm.conversation_history_page` (migration 20261120000001).
 */
export function timestampMsBucket(iso: string): bigint {
  const match = WAIT_ISO_TIMESTAMP_RE.exec(iso);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    // Truncate fractional seconds to 3 digits (milliseconds) toward floor,
    // matching Postgres `date_trunc('milliseconds', timestamptz)`.
    const fracMs = BigInt((match[7] ?? "").padEnd(3, "0").slice(0, 3));
    let wholeSec = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
    if (match[8] !== "Z") {
      const sign = match[9] === "+" ? 1 : -1;
      const offsetSec = (Number(match[10]) * 60 + Number(match[11])) * 60;
      wholeSec -= sign * offsetSec;
    }
    return BigInt(wholeSec) * 1_000n + fracMs;
  }
  return BigInt(Math.floor(Date.parse(iso)));
}

/**
 * Cursor comparator aligned with server `conversation_history` pagination:
 * `ORDER BY date_trunc('milliseconds', created_at) ASC, signal_id ASC`.
 */
export function compareCursor(a: ConversationCursorWire, b: ConversationCursorWire): number {
  const ta = timestampMsBucket(a.created_at);
  const tb = timestampMsBucket(b.created_at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = a.id.toLowerCase();
  const ib = b.id.toLowerCase();
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

function cursorFromMessage(message: Record<string, unknown>): ConversationCursorWire | null {
  const createdAt = message.created_at;
  const id = message.id;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
  if (typeof id !== "string" || !WAIT_UUID_RE.test(id)) return null;
  return { created_at: createdAt, id: id.toLowerCase() };
}

export function messageMatchesMentions(
  message: Record<string, unknown>,
  actor: WaitActorIdentity,
): boolean {
  const wantedId = actor.id.toLowerCase();
  if (actor.kind === "agent" && typeof message.to_agent === "string" && message.to_agent.toLowerCase() === wantedId) {
    return true;
  }
  if (actor.kind === "user" && typeof message.to === "string" && message.to.toLowerCase() === wantedId) {
    return true;
  }
  if (Array.isArray(message.mentions)) {
    for (const entry of message.mentions) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (rec.kind === actor.kind && typeof rec.id === "string" && rec.id.toLowerCase() === wantedId) {
        return true;
      }
    }
  }
  if (Array.isArray(message.recipients)) {
    for (const entry of message.recipients) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (rec.kind === actor.kind && typeof rec.id === "string" && rec.id.toLowerCase() === wantedId) {
        return true;
      }
    }
  }
  return false;
}

export function messageMatchesWaitFilter(
  message: Record<string, unknown>,
  filter: { threadRootId?: string; mentions: boolean; actor?: WaitActorIdentity | null },
): boolean {
  if (filter.threadRootId !== undefined) {
    const rootId = message.thread_root_id;
    if (typeof rootId !== "string" || rootId.toLowerCase() !== filter.threadRootId.toLowerCase()) {
      return false;
    }
  }
  if (filter.mentions) {
    if (!filter.actor) return false;
    if (!messageMatchesMentions(message, filter.actor)) return false;
  }
  return true;
}

export interface ParsedWaitOptions {
  conversationId?: string;
  channel?: string;
  threadRootId?: string;
  mentions: boolean;
  after: ConversationCursorWire | null;
  timeoutMs: number;
  json: boolean;
}

export interface WaitRawFlags {
  conversation?: string;
  channel?: string;
  thread?: string;
  mentions?: boolean;
  after?: string;
  afterCreatedAt?: string;
  afterId?: string;
  timeout?: string;
  json?: boolean;
}

export function parseWaitOptions(raw: WaitRawFlags): ParsedWaitOptions {
  const mentions = raw.mentions === true;
  const json = raw.json === true;
  const hasConv = raw.conversation !== undefined;
  const hasChan = raw.channel !== undefined;
  if (hasConv && hasChan) {
    throw new WaitCommandError({
      ok: false,
      error: "invalid_arguments",
      reason: "invalid_arguments",
      message: "Use either --conversation <uuid> or --channel <slug>, not both.",
      next: ["cswarm conversations --json", "cswarm wait --channel general --json"],
    });
  }
  if (!hasConv && !hasChan) {
    const threadHint = raw.thread && WAIT_UUID_RE.test(raw.thread)
      ? `cswarm wait --conversation <conversation-id> --thread ${raw.thread.toLowerCase()}${json ? " --json" : ""}`
      : `cswarm wait --channel general${json ? " --json" : ""}`;
    throw new WaitCommandError({
      ok: false,
      error: "invalid_arguments",
      reason: "invalid_arguments",
      message: "cswarm wait requires --conversation <uuid> or --channel <slug>.",
      next: ["cswarm conversations --json", threadHint],
    });
  }

  let conversationId: string | undefined;
  if (hasConv) {
    if (!WAIT_UUID_RE.test(raw.conversation!)) {
      throw new WaitCommandError({
        ok: false,
        error: "invalid_arguments",
        reason: "invalid_arguments",
        message: "--conversation must be a valid conversation UUID.",
        next: ["cswarm conversations --json"],
      });
    }
    conversationId = raw.conversation!.toLowerCase();
  }

  let channel: string | undefined;
  if (hasChan) {
    const rawChannel = raw.channel!;
    if (!WAIT_UUID_RE.test(rawChannel) && !isGeneralChannel(rawChannel)) {
      const problem = channelSelectorProblem(rawChannel);
      if (problem !== null) {
        throw new WaitCommandError({
          ok: false,
          error: "invalid_arguments",
          reason: "invalid_arguments",
          message: problem,
          next: ["cswarm channel ls --json"],
        });
      }
    }
    channel = rawChannel;
  }

  let threadRootId: string | undefined;
  if (raw.thread !== undefined) {
    if (!WAIT_UUID_RE.test(raw.thread)) {
      throw new WaitCommandError({
        ok: false,
        error: "invalid_arguments",
        reason: "invalid_arguments",
        message: "--thread must be a valid root signal UUID.",
        next: [
          conversationId
            ? `cswarm conversation read ${conversationId} --json`
            : "cswarm conversations --json",
        ],
      });
    }
    threadRootId = raw.thread.toLowerCase();
  }

  const targetHint = buildWaitNextCommand(
    { conversationId, channel, threadRootId, mentions, json },
    conversationId ?? null,
    null,
  );

  const hasAfter = raw.after !== undefined;
  const hasAfterCreatedAt = raw.afterCreatedAt !== undefined;
  const hasAfterId = raw.afterId !== undefined;
  if (hasAfter && (hasAfterCreatedAt || hasAfterId)) {
    throw new WaitCommandError({
      ok: false,
      error: "invalid_arguments",
      reason: "invalid_arguments",
      message: "Use --after <cursor> or --after-created-at <iso> --after-id <uuid>, not both.",
      next: [targetHint],
    });
  }
  if (hasAfterCreatedAt !== hasAfterId) {
    throw new WaitCommandError({
      ok: false,
      error: "invalid_arguments",
      reason: "invalid_arguments",
      message: "--after-created-at and --after-id must be given together.",
      next: [targetHint],
    });
  }

  let after: ConversationCursorWire | null = null;
  if (hasAfter) {
    after = decodeConversationCursor(raw.after!, targetHint);
  } else if (hasAfterCreatedAt && hasAfterId) {
    if (!isValidIsoTimestamp(raw.afterCreatedAt!) || !WAIT_UUID_RE.test(raw.afterId!)) {
      throw invalidCursorError(
        "Invalid cursor pair: --after-created-at must be an ISO-8601 timestamp and --after-id must be a UUID.",
        targetHint,
      );
    }
    after = {
      created_at: raw.afterCreatedAt!,
      id: raw.afterId!.toLowerCase(),
    };
  }

  const timeoutMs = parseWaitTimeoutMs(raw.timeout);

  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(threadRootId !== undefined ? { threadRootId } : {}),
    mentions,
    after,
    timeoutMs,
    json,
  };
}

interface RawReadResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfterMs: number | null;
}

async function postReadWithSignal(
  target: CloudTarget,
  getBearer: () => Promise<string>,
  payload: Record<string, unknown>,
  options: {
    fetcher: typeof fetch;
    signal: AbortSignal;
    requestTimeoutMs: number;
    now: () => number;
  },
): Promise<RawReadResponse> {
  const bearer = await getBearer();
  const reqController = new AbortController();
  const onParentAbort = () => reqController.abort(options.signal.reason);
  if (options.signal.aborted) {
    reqController.abort(options.signal.reason);
  } else {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    reqController.abort(new Error("wait_request_timeout"));
  }, Math.max(1, Math.trunc(options.requestTimeoutMs)));

  try {
    const response = await options.fetcher(readEndpoint(target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        apikey: target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: reqController.signal,
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text.trim().length > 0) {
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && !Array.isArray(json)) {
          parsed = json as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
    }
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), options.now());
    return { status: response.status, body: parsed, retryAfterMs };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onParentAbort);
  }
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(1, Math.trunc(ms)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyTerminalHttpError(
  status: number,
  body: Record<string, unknown>,
  context: {
    resource: "conversations" | "conversation_history" | "members";
    credentialKind: "human" | "agent";
    conversationId: string | null;
    cursor: string | null;
    channel?: string;
    json: boolean;
  },
): WaitCommandError | null {
  const env = parseServerErrorEnvelope(body);
  const rawMessage = typeof body.message === "string" && body.message.trim().length > 0
    ? sanitizeWaitText(body.message.trim()).slice(0, 400)
    : null;
  const jsonFlag = context.json ? " --json" : "";
  const authNext = context.credentialKind === "agent"
    ? [`cswarm whoami${jsonFlag}`, `cswarm conversations${jsonFlag}`]
    : ["cswarm login", `cswarm conversations${jsonFlag}`];

  if (status === 401) {
    return new WaitCommandError({
      ok: false,
      error: env.error ?? "unauthorized",
      reason: "auth_expired",
      message: rawMessage ?? "Authentication expired or was rejected while waiting.",
      next: authNext,
      ...(context.conversationId !== null ? { conversation_id: context.conversationId } : {}),
      ...(context.cursor !== null ? { cursor: context.cursor } : {}),
    });
  }
  if (status === 403) {
    return new WaitCommandError({
      ok: false,
      error: env.error ?? "forbidden",
      reason: "access_lost",
      message: rawMessage ?? "Access to this workspace or conversation was denied.",
      next: [`cswarm conversations${jsonFlag}`, ...(context.credentialKind === "agent" ? [`cswarm whoami${jsonFlag}`] : [])],
      ...(context.conversationId !== null ? { conversation_id: context.conversationId } : {}),
      ...(context.cursor !== null ? { cursor: context.cursor } : {}),
    });
  }
  if (status === 404) {
    const isChannelLookup = context.resource === "conversations" && context.channel !== undefined;
    const reason = isChannelLookup ? "channel_not_found" : "conversation_not_found";
    return new WaitCommandError({
      ok: false,
      error: env.error ?? reason,
      reason,
      message: rawMessage ?? (isChannelLookup
        ? `Channel "${context.channel}" is not available in this workspace.`
        : "This conversation isn't available in this workspace."),
      next: isChannelLookup
        ? [`cswarm channel ls${jsonFlag}`, `cswarm conversations${jsonFlag}`]
        : [`cswarm conversations${jsonFlag}`],
      ...(context.conversationId !== null ? { conversation_id: context.conversationId } : {}),
      ...(context.cursor !== null ? { cursor: context.cursor } : {}),
    });
  }
  if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
    return new WaitCommandError({
      ok: false,
      error: env.error ?? `http_${status}`,
      reason: "invalid_request",
      message: rawMessage ?? `Read request refused (HTTP ${status}).`,
      next: [`cswarm conversations${jsonFlag}`],
      ...(context.conversationId !== null ? { conversation_id: context.conversationId } : {}),
      ...(context.cursor !== null ? { cursor: context.cursor } : {}),
    });
  }
  if (status === 429 && env.retryable === false) {
    return new WaitCommandError({
      ok: false,
      error: env.error ?? "rate_limited",
      reason: "rate_limited",
      message: rawMessage ?? "Rate limit exceeded while waiting.",
      next: [`cswarm conversations${jsonFlag}`],
      ...(context.conversationId !== null ? { conversation_id: context.conversationId } : {}),
      ...(context.cursor !== null ? { cursor: context.cursor } : {}),
    });
  }
  return null;
}

export interface WaitLoopDeps {
  target: CloudTarget;
  workspaceId: string;
  credentialKind: "human" | "agent";
  getBearer: () => Promise<string>;
  actor?: WaitActorIdentity | null;
  options: ParsedWaitOptions;
  fetcher?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
  pollInitialMs?: number;
  pollMaxMs?: number;
  requestTimeoutMs?: number;
}

function jitteredDelayMs(baseMs: number, minMs: number, maxMs: number, random: () => number): number {
  const clamped = Math.min(maxMs, Math.max(minMs, baseMs));
  // Small bounded jitter in [0.85, 1.15] clamped to [minMs, maxMs]
  const factor = 0.85 + Math.min(1, Math.max(0, random())) * 0.3;
  return Math.max(1, Math.round(Math.min(maxMs, Math.max(minMs, clamped * factor))));
}

function makeInterruptedError(
  signalName: "SIGINT" | "SIGTERM",
  target: WaitTargetDescriptor,
  conversationId: string | null,
  cursor: ConversationCursorWire | null,
): WaitCommandError {
  const encodedCursor = cursor ? encodeConversationCursor(cursor) : null;
  const nextCmd = buildWaitNextCommand(target, conversationId, encodedCursor);
  return new WaitCommandError(
    {
      ok: false,
      matched: false,
      error: "interrupted",
      reason: "interrupted",
      signal: signalName,
      message: `Wait interrupted by ${signalName}.`,
      conversation_id: conversationId,
      cursor: encodedCursor,
      next: [nextCmd],
    },
    signalName === "SIGINT" ? WAIT_SIGINT_EXIT_CODE : WAIT_SIGTERM_EXIT_CODE,
  );
}

/**
 * Core blocking wait execution loop.
 * Purely injectable for deterministic unit tests and wired directly to `cswarm wait`.
 */
export async function executeWait(deps: WaitLoopDeps): Promise<WaitMatchResult | WaitTimeoutResult> {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const opts = deps.options;
  const rawPollInitialMs = deps.pollInitialMs ?? WAIT_POLL_INITIAL_MS;
  const rawPollMaxMs = deps.pollMaxMs ?? WAIT_POLL_MAX_MS;
  const pollInitialMs = deps.pollInitialMs !== undefined
    ? rawPollInitialMs
    : Math.min(rawPollInitialMs, Math.max(50, Math.floor(opts.timeoutMs / 4)));
  const pollMaxMs = Math.max(pollInitialMs, Math.min(rawPollMaxMs, opts.timeoutMs));
  const requestTimeoutCapMs = deps.requestTimeoutMs ?? WAIT_REQUEST_TIMEOUT_MS;
  const workspaceId = deps.workspaceId.toLowerCase();
  const deadline = now() + opts.timeoutMs;

  const controller = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | null = null;
  const onExternalAbort = () => {
    const reason = deps.signal?.reason;
    if (reason === "SIGINT" || reason === "SIGTERM") interruptedBy = reason;
    controller.abort(reason);
  };
  if (deps.signal) {
    if (deps.signal.aborted) onExternalAbort();
    else deps.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const targetDescriptor: WaitTargetDescriptor = {
    conversationId: opts.conversationId,
    channel: opts.channel,
    threadRootId: opts.threadRootId,
    mentions: opts.mentions,
    json: opts.json,
  };

  let resolvedConversationId: string | null = opts.conversationId ?? null;
  let cursor: ConversationCursorWire | null = opts.after;
  let actor: WaitActorIdentity | null = deps.actor ?? null;

  const checkAbort = (): void => {
    if (interruptedBy !== null) {
      throw makeInterruptedError(interruptedBy, targetDescriptor, resolvedConversationId, cursor);
    }
    if (controller.signal.aborted) {
      throw makeInterruptedError("SIGTERM", targetDescriptor, resolvedConversationId, cursor);
    }
  };

  const remainingMs = (): number => Math.max(0, deadline - now());

  const readWithRetry = async (
    resource: "conversations" | "conversation_history" | "members",
    payload: Record<string, unknown>,
  ): Promise<RawReadResponse | null> => {
    let errorBackoffMs = pollInitialMs;
    while (true) {
      checkAbort();
      const rem = remainingMs();
      if (rem <= 0) return null;
      const reqTimeout = Math.min(requestTimeoutCapMs, rem);
      let res: RawReadResponse;
      try {
        res = await postReadWithSignal(deps.target, deps.getBearer, payload, {
          fetcher,
          signal: controller.signal,
          requestTimeoutMs: reqTimeout,
          now,
        });
      } catch (err) {
        checkAbort();
        // Propagate renewal/auth failures thrown by getBearer() immediately.
        if (err instanceof WaitCommandError) throw err;
        const name = err instanceof Error ? err.name : "";
        if (
          name === "RenewalRevoked" ||
          name === "RenewalSuspended" ||
          name === "RenewalReauthorisationRequired" ||
          name === "RenewalCredentialCheckError"
        ) {
          throw new WaitCommandError({
            ok: false,
            error: name === "RenewalReauthorisationRequired" ? "auth_expired" : "access_lost",
            reason: name === "RenewalReauthorisationRequired" ? "auth_expired" : "access_lost",
            message: sanitizeWaitText(err instanceof Error ? err.message : "Agent credential is no longer valid."),
            next: [`cswarm whoami${opts.json ? " --json" : ""}`],
            conversation_id: resolvedConversationId,
            cursor: cursor ? encodeConversationCursor(cursor) : null,
          });
        }
        const remAfter = remainingMs();
        if (remAfter <= 0) return null;
        const waitMs = Math.min(remAfter, errorBackoffMs);
        errorBackoffMs = Math.min(WAIT_ERROR_BACKOFF_MAX_MS, errorBackoffMs * 2);
        await sleep(waitMs, controller.signal);
        continue;
      }

      if (res.status === 200) return res;

      const terminal = classifyTerminalHttpError(res.status, res.body, {
        resource,
        credentialKind: deps.credentialKind,
        conversationId: resolvedConversationId,
        cursor: cursor ? encodeConversationCursor(cursor) : null,
        channel: opts.channel,
        json: opts.json,
      });
      if (terminal !== null) throw terminal;

      // Retryable 429 / 408 / 5xx: honor Retry-After when present, bounded by remaining budget.
      const remAfter = remainingMs();
      if (remAfter <= 0) return null;
      const retryDelay = res.retryAfterMs !== null
        ? Math.max(res.retryAfterMs, pollInitialMs)
        : errorBackoffMs;
      const waitMs = Math.min(remAfter, retryDelay);
      errorBackoffMs = Math.min(WAIT_ERROR_BACKOFF_MAX_MS, errorBackoffMs * 2);
      await sleep(waitMs, controller.signal);
    }
  };

  try {
    // 1. Resolve --channel fail-closed via Step 2b `conversations` read (never auto-create).
    if (resolvedConversationId === null && opts.channel !== undefined) {
      const convRes = await readWithRetry("conversations", {
        resource: "conversations",
        workspace_id: workspaceId,
        include_archived: false,
      });
      if (convRes === null) {
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out resolving channel "${opts.channel}" after ${opts.timeoutMs}ms.`,
          conversation_id: "",
          cursor: cursor ? encodeConversationCursor(cursor) : null,
          next: [buildWaitNextCommand(targetDescriptor, null, cursor ? encodeConversationCursor(cursor) : null)],
        };
      }
      const list = Array.isArray(convRes.body.conversations)
        ? (convRes.body.conversations as ConversationSummaryWire[])
        : [];
      const found = findChannelConversation(list, opts.channel);
      if (found === null) {
        const jsonFlag = opts.json ? " --json" : "";
        throw new WaitCommandError({
          ok: false,
          error: "channel_not_found",
          reason: "channel_not_found",
          message: `There is no channel named "${opts.channel}" in this workspace. cswarm wait never auto-creates channels.`,
          next: [`cswarm channel ls${jsonFlag}`, `cswarm conversations${jsonFlag}`],
        });
      }
      resolvedConversationId = found.conversation_id.toLowerCase();
    }

    const conversationId = resolvedConversationId!;

    // 2. Resolve caller identity if --mentions was requested and local credential lacked principalId.
    if (opts.mentions && actor === null) {
      if (deps.credentialKind !== "agent") {
        throw new WaitCommandError({
          ok: false,
          error: "identity_unavailable",
          reason: "identity_unavailable",
          message: "Could not determine your user id for --mentions filtering.",
          next: ["cswarm login"],
        });
      }
      const dirRes = await readWithRetry("members", {
        resource: "members",
        workspace_id: workspaceId,
      });
      if (dirRes === null) {
        const encoded = cursor ? encodeConversationCursor(cursor) : null;
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out resolving agent identity after ${opts.timeoutMs}ms.`,
          conversation_id: conversationId,
          cursor: encoded,
          next: [buildWaitNextCommand(targetDescriptor, conversationId, encoded)],
        };
      }
      const identity = dirRes.body.identity as Record<string, unknown> | undefined;
      const pid = typeof identity?.principal_id === "string" && WAIT_UUID_RE.test(identity.principal_id)
        ? identity.principal_id.toLowerCase()
        : null;
      if (pid === null) {
        throw new WaitCommandError({
          ok: false,
          error: "identity_unavailable",
          reason: "identity_unavailable",
          message: "Authenticated credential did not return an agent principal_id for --mentions filtering.",
          next: [`cswarm whoami${opts.json ? " --json" : ""}`],
        });
      }
      actor = { kind: "agent", id: pid };
    }

    // 3. Anchor on current tip when --after was omitted (wait for NEW events, never replay history).
    if (cursor === null) {
      const tipRes = await readWithRetry("conversation_history", {
        resource: "conversation_history",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        limit: 1,
        include_mentions: false,
        include_reactions: false,
      });
      if (tipRes === null) {
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out after ${opts.timeoutMs}ms waiting for an event.`,
          conversation_id: conversationId,
          cursor: null,
          next: [buildWaitNextCommand(targetDescriptor, conversationId, null)],
        };
      }
      const tipMessages = Array.isArray(tipRes.body.messages)
        ? (tipRes.body.messages as Record<string, unknown>[])
        : [];
      const nextAfter = tipRes.body.next_after as ConversationCursorWire | null | undefined;
      if (
        nextAfter &&
        typeof nextAfter.created_at === "string" &&
        typeof nextAfter.id === "string" &&
        WAIT_UUID_RE.test(nextAfter.id)
      ) {
        cursor = { created_at: nextAfter.created_at, id: nextAfter.id.toLowerCase() };
      } else if (tipMessages.length > 0) {
        cursor = cursorFromMessage(tipMessages[tipMessages.length - 1]!);
      }
      // After anchoring at the current tip, wait one initial poll interval before checking for new arrivals.
      const remAfterTip = remainingMs();
      if (remAfterTip > 0) {
        await sleep(Math.min(remAfterTip, jitteredDelayMs(pollInitialMs, pollInitialMs, pollMaxMs, random)), controller.signal);
        checkAbort();
      }
    }

    // 4. Blocking poll loop using Step 2b `conversation_history` with paired `after` cursor.
    let currentPollMs = pollInitialMs;
    while (true) {
      checkAbort();
      if (remainingMs() <= 0) {
        const encoded = cursor ? encodeConversationCursor(cursor) : null;
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out after ${opts.timeoutMs}ms without a matching event.`,
          conversation_id: conversationId,
          cursor: encoded,
          next: [buildWaitNextCommand(targetDescriptor, conversationId, encoded)],
        };
      }

      const payload: Record<string, unknown> = {
        resource: "conversation_history",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        ...(cursor
          ? { after_created_at: cursor.created_at, after_id: cursor.id.toLowerCase() }
          : {}),
        limit: WAIT_PAGE_LIMIT,
        include_mentions: true,
        include_reactions: false,
      };

      const pageRes = await readWithRetry("conversation_history", payload);
      if (pageRes === null) {
        const encoded = cursor ? encodeConversationCursor(cursor) : null;
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out after ${opts.timeoutMs}ms without a matching event.`,
          conversation_id: conversationId,
          cursor: encoded,
          next: [buildWaitNextCommand(targetDescriptor, conversationId, encoded)],
        };
      }

      const rawMessages = Array.isArray(pageRes.body.messages)
        ? (pageRes.body.messages as Record<string, unknown>[])
        : [];
      const hasMore = pageRes.body.has_more === true;

      // Normalize ascending chronological order by (created_at, id) so we return the
      // earliest matching message and advance cursor strictly past what was returned.
      const ordered = rawMessages
        .map((msg) => ({ msg, cur: cursorFromMessage(msg) }))
        .filter((item): item is { msg: Record<string, unknown>; cur: ConversationCursorWire } => item.cur !== null)
        .sort((a, b) => compareCursor(a.cur, b.cur));

      let sawNewMessage = false;
      for (const item of ordered) {
        if (cursor !== null && compareCursor(item.cur, cursor) <= 0) {
          continue;
        }
        sawNewMessage = true;
        cursor = item.cur;
        if (messageMatchesWaitFilter(item.msg, { threadRootId: opts.threadRootId, mentions: opts.mentions, actor })) {
          const encoded = encodeConversationCursor(cursor);
          return {
            ok: true,
            matched: true,
            conversation_id: conversationId,
            event: item.msg,
            cursor: encoded,
            next: [buildWaitNextCommand(targetDescriptor, conversationId, encoded)],
          };
        }
      }

      // If more pages are immediately available after a non-matching page, drain without sleeping.
      if (hasMore && sawNewMessage) {
        currentPollMs = pollInitialMs;
        continue;
      }

      if (sawNewMessage) {
        currentPollMs = pollInitialMs;
      }

      const rem = remainingMs();
      if (rem <= 0) {
        const encoded = cursor ? encodeConversationCursor(cursor) : null;
        return {
          ok: false,
          matched: false,
          error: "timeout",
          reason: "timeout",
          message: `Timed out after ${opts.timeoutMs}ms without a matching event.`,
          conversation_id: conversationId,
          cursor: encoded,
          next: [buildWaitNextCommand(targetDescriptor, conversationId, encoded)],
        };
      }

      const delay = jitteredDelayMs(currentPollMs, pollInitialMs, pollMaxMs, random);
      currentPollMs = Math.min(pollMaxMs, Math.round(currentPollMs * 1.5));
      await sleep(Math.min(rem, delay), controller.signal);
    }
  } finally {
    if (deps.signal) {
      deps.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export interface WaitWritableStream {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
}

export interface RunWaitCliArgs {
  rawFlags: WaitRawFlags;
  resolveContext: () => Promise<{
    target: CloudTarget;
    workspaceId: string;
    credentialKind: "human" | "agent";
    getBearer: () => Promise<string>;
    actor: WaitActorIdentity | null;
    fetcher: typeof fetch;
  }>;
  stdout?: WaitWritableStream;
  stderr?: WaitWritableStream;
  installSignals?: boolean;
}

async function writeWaitOutput(stream: WaitWritableStream, value: string): Promise<void> {
  if (!value) return;
  if (typeof stream.once === "function" && typeof stream.off === "function") {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      stream.once!("error", onError);
      try {
        stream.write(value, (error) => {
          stream.off!("error", onError);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        stream.off!("error", onError);
        reject(error);
      }
    });
    return;
  }
  if (stream.write.length >= 2) {
    await new Promise<void>((resolve, reject) => {
      try {
        stream.write(value, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    return;
  }
  stream.write(value);
}

function normalizeSignalForObservation(event: Record<string, unknown>): SignalRecord {
  const lowerId = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
  const normalizeRefList = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const rec = entry as Record<string, unknown>;
        const id = lowerId(rec.id);
        if ((rec.kind !== "user" && rec.kind !== "agent") || id === null) return [];
        return [{ ...rec, kind: rec.kind, id }];
      })
      : undefined;
  return {
    ...(event as unknown as SignalRecord),
    id: lowerId(event.id) ?? "",
    from: lowerId(event.from) ?? "",
    to: lowerId(event.to),
    to_agent: lowerId(event.to_agent),
    ...(event.recipients !== undefined ? { recipients: normalizeRefList(event.recipients) as SignalRecord["recipients"] } : {}),
    ...(event.mentions !== undefined ? { mentions: normalizeRefList(event.mentions) as SignalRecord["mentions"] } : {}),
  };
}

/**
 * CLI entry point invoked from `src/cli.ts`.
 * Installs clean `SIGINT`/`SIGTERM` handlers for the wait duration and formats
 * either structured `--json` or concise human output, acknowledging returned
 * agent deliveries only after stdout has received the bytes.
 */
export async function runWaitCli(params: RunWaitCliArgs): Promise<number> {
  const stdout: WaitWritableStream = params.stdout ?? process.stdout;
  const stderr: WaitWritableStream = params.stderr ?? process.stderr;
  const parsed = parseWaitOptions(params.rawFlags);

  let context: Awaited<ReturnType<RunWaitCliArgs["resolveContext"]>>;
  try {
    context = await params.resolveContext();
  } catch (err) {
    if (err instanceof WaitCommandError) throw err;
    throw classifySetupError(err, parsed.json);
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  const useSignals = params.installSignals !== false;
  if (useSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  try {
    const result = await executeWait({
      target: context.target,
      workspaceId: context.workspaceId,
      credentialKind: context.credentialKind,
      getBearer: context.getBearer,
      actor: context.actor,
      options: parsed,
      fetcher: context.fetcher,
      signal: controller.signal,
    });

    if (parsed.json) {
      await writeWaitOutput(stdout, `${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      const m = result.event;
      const createdAt = sanitizeWaitText(String(m.created_at ?? ""));
      const id = sanitizeWaitText(String(m.id ?? ""));
      const fromKind = sanitizeWaitText(String(m.from_kind ?? ""));
      const from = sanitizeWaitText(String(m.from ?? ""));
      const body = sanitizeWaitText(String(m.body ?? ""));
      const lines = [`${createdAt} · ${id} · ${fromKind}:${from} · ${body}\n`];
      if (result.next.length > 0) {
        lines.push(`Next: ${result.next[0]}\n`);
      }
      await writeWaitOutput(stdout, lines.join(""));
    } else {
      const lines = [`cswarm: ${result.message}\n`];
      if (result.next.length > 0) {
        lines.push(`Next: ${result.next[0]}\n`);
      }
      await writeWaitOutput(stderr, lines.join(""));
    }

    // Observe the returned agent delivery strictly AFTER output is written so turn-mode
    // hooks and `cswarm check` do not repeat it. Best effort: never alters output or exit code.
    if (result.ok && context.credentialKind === "agent" && !controller.signal.aborted) {
      const principalId = context.actor?.kind === "agent" ? context.actor.id.toLowerCase() : null;
      const signalIds = surfacedDeliveryIds(
        [normalizeSignalForObservation(result.event)],
        principalId,
        { excludeOwn: true },
      );
      if (signalIds.length > 0) {
        try {
          const credential = await context.getBearer();
          await observeSurfacedDeliveries({
            target: context.target,
            fetcher: context.fetcher,
            credential,
            workspaceId: context.workspaceId.toLowerCase(),
            signalIds,
            signal: controller.signal,
          });
        } catch {
          // Best-effort observation: output, cursor, and exit status never depend on it.
        }
      }
    }

    return result.ok ? 0 : WAIT_TIMED_OUT_EXIT_CODE;
  } finally {
    if (useSignals) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}

export function classifySetupError(error: unknown, json: boolean): WaitCommandError {
  const jsonFlag = json ? " --json" : "";
  const message = sanitizeWaitText(error instanceof Error ? error.message : "Failed to initialize cswarm wait.");
  const name = error instanceof Error ? error.name : "";
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : null;

  if (
    code === "profile_session_mismatch" ||
    code === "profile_other_session" ||
    message.includes("This profile belongs to another session")
  ) {
    return new WaitCommandError({
      ok: false,
      error: "profile_session_mismatch",
      reason: "profile_session_mismatch",
      message,
      next: ["cswarm setup guide"],
    });
  }
  if (code === "human_session_missing" || message.includes("not logged in") || message.includes("not signed in")) {
    return new WaitCommandError({
      ok: false,
      error: code ?? "not_configured",
      reason: "not_configured",
      message,
      next: ["cswarm login", `cswarm workspaces${jsonFlag}`],
    });
  }
  if (code === "human_session_refresh_failed" || name === "RenewalReauthorisationRequired") {
    return new WaitCommandError({
      ok: false,
      error: code ?? "auth_expired",
      reason: "auth_expired",
      message,
      next: ["cswarm login", `cswarm whoami${jsonFlag}`],
    });
  }
  if (name === "RenewalRevoked" || name === "RenewalSuspended") {
    return new WaitCommandError({
      ok: false,
      error: "access_lost",
      reason: "access_lost",
      message,
      next: [`cswarm whoami${jsonFlag}`],
    });
  }
  if (name === "WorkspaceCliError") {
    return new WaitCommandError({
      ok: false,
      error: code ?? "workspace_required",
      reason: "workspace_required",
      message,
      next: [`cswarm workspaces${jsonFlag}`],
    });
  }
  return new WaitCommandError({
    ok: false,
    error: code ?? "wait_setup_failed",
    reason: "not_configured",
    message,
    next: [`cswarm status${jsonFlag}`],
  });
}
