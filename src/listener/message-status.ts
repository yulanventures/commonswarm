/**
 * Message status from an agent's own host: Working with a coarse label while it handles a
 * message a person sent it, and idle when the turn ends. The server sets the two-minute expiry;
 * this side only names the message, a closed label, and an ordered stream and sequence.
 *
 * Labels come from a closed table keyed by the host's tool name (Claude hooks) or ACP tool kind
 * (the listener). Tool input, paths, commands, URLs and titles are never read, stored or sent.
 * The whole operation is bounded by MESSAGE_STATUS_BUDGET_MS and never throws to its caller.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CloudTarget } from "../cloud/config.js";
import { readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "../cloud/storage.js";

export const MESSAGE_STATUS_LABELS = [
  "thinking",
  "reading",
  "editing",
  "searching",
  "running_command",
  "searching_web",
  "using_tool",
] as const;
export type MessageStatusLabel = typeof MESSAGE_STATUS_LABELS[number];

/** Total time one status update may take, credential and state file included. */
export const MESSAGE_STATUS_BUDGET_MS = 1_000;
/** At most one tool-step update per this interval. */
export const MESSAGE_STATUS_THROTTLE_MS = 4_000;
export const MESSAGE_STATUS_FILE = "message-status.json";
const MAX_STATE_BYTES = 1_024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CLAUDE_TOOL_LABELS: Readonly<Record<string, MessageStatusLabel>> = {
  Read: "reading",
  NotebookRead: "reading",
  Grep: "searching",
  Glob: "searching",
  LS: "searching",
  Edit: "editing",
  MultiEdit: "editing",
  Write: "editing",
  NotebookEdit: "editing",
  Bash: "running_command",
  WebFetch: "searching_web",
  WebSearch: "searching_web",
};

/** A Claude Code tool name to a coarse label. Anything not in the table, MCP tools included,
 *  is "using a tool"; the name itself never leaves this function. */
export function claudeToolLabel(toolName: unknown): MessageStatusLabel {
  return typeof toolName === "string" && Object.hasOwn(CLAUDE_TOOL_LABELS, toolName)
    ? CLAUDE_TOOL_LABELS[toolName]!
    : "using_tool";
}

const ACP_KIND_LABELS: Readonly<Record<string, MessageStatusLabel>> = {
  read: "reading",
  edit: "editing",
  delete: "editing",
  move: "editing",
  search: "searching",
  execute: "running_command",
  fetch: "searching_web",
  think: "thinking",
};

/** An ACP tool kind (the listener's session updates) to a coarse label. */
export function acpToolKindLabel(kind: unknown): MessageStatusLabel {
  return typeof kind === "string" && Object.hasOwn(ACP_KIND_LABELS, kind)
    ? ACP_KIND_LABELS[kind]!
    : "using_tool";
}

export interface MessageStatusFrame {
  workspaceId: string;
  streamId: string;
  sequence: number;
  state: "working" | "idle";
  signalId: string | null;
  label: MessageStatusLabel | null;
}

/** POST one status frame. Resolves true on 202; false on any failure, never throws. */
export async function publishMessageStatus(options: {
  target: CloudTarget;
  credential: string;
  frame: MessageStatusFrame;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}): Promise<boolean> {
  const { frame } = options;
  try {
    const response = await (options.fetcher ?? fetch)(`${options.target.url}/functions/v1/activity`, {
      method: "POST",
      headers: {
        ...options.headers,
        authorization: `Bearer ${options.credential}`,
        apikey: options.target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        kind: "status",
        workspace_id: frame.workspaceId,
        stream_id: frame.streamId,
        sequence: frame.sequence,
        state: frame.state,
        signal_id: frame.signalId,
        label: frame.label,
      }),
      signal: options.signal ?? AbortSignal.timeout(MESSAGE_STATUS_BUDGET_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 202;
  } catch {
    return false;
  }
}

/** Per-agent hook state: the stream and sequence, the message being handled, and when the last
 *  update was sent. No tool name, label, path or text is stored. */
export interface MessageStatusState {
  version: 1;
  stream_id: string;
  sequence: number;
  signal_id: string | null;
  last_sent_at: number;
}

export async function readMessageStatusState(directory: string): Promise<MessageStatusState> {
  const fresh = (): MessageStatusState => ({ version: 1, stream_id: randomUUID(), sequence: 0, signal_id: null, last_sent_at: 0 });
  let raw: string | null;
  try {
    raw = await readSecureJsonFileIfPresent(join(directory, MESSAGE_STATUS_FILE), MAX_STATE_BYTES);
  } catch {
    return fresh();
  }
  if (raw === null) return fresh();
  try {
    const value = JSON.parse(raw) as Partial<MessageStatusState>;
    if (
      value.version === 1 && typeof value.stream_id === "string" && UUID_RE.test(value.stream_id) &&
      Number.isSafeInteger(value.sequence) && value.sequence! >= 0 &&
      (value.signal_id === null || (typeof value.signal_id === "string" && UUID_RE.test(value.signal_id))) &&
      Number.isSafeInteger(value.last_sent_at) && value.last_sent_at! >= 0
    ) {
      return value as MessageStatusState;
    }
  } catch { /* A damaged file starts a new stream. */ }
  return fresh();
}

export async function writeMessageStatusState(directory: string, state: MessageStatusState): Promise<void> {
  await writeSecureJsonFile(join(directory, MESSAGE_STATUS_FILE), JSON.stringify(state));
}

export type MessageStatusEvent =
  | { kind: "working"; signalId: string }
  | { kind: "tool"; label: MessageStatusLabel }
  | { kind: "stop" };

/**
 * Apply one hook event to the agent's status: start Working on a message, update the label at
 * most once per throttle interval, or go idle. Bounded by MESSAGE_STATUS_BUDGET_MS from the
 * call, including the state file; resolves without throwing either way.
 */
export async function applyMessageStatusEvent(options: {
  directory: string;
  target: CloudTarget;
  credential: string;
  workspaceId: string;
  event: MessageStatusEvent;
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
  now?: () => number;
  budgetMs?: number;
}): Promise<"sent" | "skipped" | "failed"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"failed">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("failed");
    }, options.budgetMs ?? MESSAGE_STATUS_BUDGET_MS);
  });
  const work = (async (): Promise<"sent" | "skipped" | "failed"> => {
    const now = options.now ?? Date.now;
    const { event } = options;
    // Hook processes run in the background and can overlap: the state read, the next sequence and
    // the write happen under one short lock, so two updates never share a sequence.
    const planned = await withFileLock(options.directory, "message-status", async () => {
      const state = await readMessageStatusState(options.directory);
      let next: MessageStatusState;
      let frame: MessageStatusFrame;
      if (event.kind === "working") {
        next = { ...state, sequence: state.sequence + 1, signal_id: event.signalId, last_sent_at: now() };
        frame = { workspaceId: options.workspaceId, streamId: state.stream_id, sequence: next.sequence, state: "working", signalId: event.signalId, label: "thinking" };
      } else if (event.kind === "tool") {
        if (state.signal_id === null || now() - state.last_sent_at < MESSAGE_STATUS_THROTTLE_MS) return null;
        next = { ...state, sequence: state.sequence + 1, last_sent_at: now() };
        frame = { workspaceId: options.workspaceId, streamId: state.stream_id, sequence: next.sequence, state: "working", signalId: state.signal_id, label: event.label };
      } else {
        if (state.signal_id === null) return null;
        next = { ...state, sequence: state.sequence + 1, signal_id: null, last_sent_at: now() };
        frame = { workspaceId: options.workspaceId, streamId: state.stream_id, sequence: next.sequence, state: "idle", signalId: null, label: null };
      }
      // The sequence advances before the send, so a retried or concurrent update never reuses one.
      await writeMessageStatusState(options.directory, next);
      return frame;
    }, { timeoutMs: 250, signal: controller.signal });
    if (planned === null) return "skipped";
    const frame = planned;
    if (controller.signal.aborted) return "failed";
    return await publishMessageStatus({
      target: options.target,
      credential: options.credential,
      frame,
      signal: controller.signal,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }) ? "sent" : "failed";
  })().catch((): "failed" => "failed");
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Opt-in marker in a listener's instance directory, written by `hook install claude --status
 *  --write` and removed when status is turned off. The listener's headless path reads it. */
export const MESSAGE_STATUS_OPT_IN_FILE = "message-status-opt-in.json";

export async function setMessageStatusOptIn(directory: string, enabled: boolean): Promise<void> {
  const path = join(directory, MESSAGE_STATUS_OPT_IN_FILE);
  if (enabled) {
    await writeSecureJsonFile(path, JSON.stringify({ version: 1, enabled: true }));
  } else {
    await rm(path, { force: true });
  }
}

export async function messageStatusOptedIn(directory: string): Promise<boolean> {
  try {
    const raw = await readSecureJsonFileIfPresent(join(directory, MESSAGE_STATUS_OPT_IN_FILE), MAX_STATE_BYTES);
    if (raw === null) return false;
    const value = JSON.parse(raw) as { version?: unknown; enabled?: unknown };
    return value.version === 1 && value.enabled === true;
  } catch {
    return false;
  }
}

/** Run one status operation, credential reads included, inside MESSAGE_STATUS_BUDGET_MS.
 *  Resolves false on timeout or failure; never throws. */
export async function withinMessageStatusBudget(
  work: (signal: AbortSignal) => Promise<boolean>,
  budgetMs = MESSAGE_STATUS_BUDGET_MS,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, budgetMs);
  });
  try {
    return await Promise.race([work(controller.signal).catch(() => false), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
