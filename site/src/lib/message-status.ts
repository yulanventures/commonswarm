/**
 * Message status for agents: the one line under the signed-in person's latest message to each
 * agent (Delivered, Seen, Working with a coarse label, Replied). Details come only from
 * swarm_read.message_status; the workspace activity topic carries a bare status event that says
 * an agent is working or idle, which triggers a re-read and the panel's generic "Working".
 */
import type { Signal } from "./commonswarm";

export const MESSAGE_STATUS_LABEL_TEXT = {
  thinking: "thinking",
  reading: "reading",
  editing: "editing",
  searching: "searching",
  running_command: "running a command",
  searching_web: "searching the web",
  using_tool: "using a tool",
} as const;
export type MessageStatusLabel = keyof typeof MESSAGE_STATUS_LABEL_TEXT;

export interface MessageStatus {
  signalId: string;
  agentPrincipalId: string;
  delivered: boolean;
  seen: boolean;
  replied: boolean;
  working: { label: MessageStatusLabel; until: number } | null;
}

/** An agent's status event on the workspace activity topic. */
export interface AgentStatusEvent {
  principalId: string;
  state: "working" | "idle";
  emittedAt: number;
}

/** The read caps one call at 50 messages. */
export const MESSAGE_STATUS_BATCH = 50;
/** Without a status event, re-read at most this often while a line is visible. */
export const MESSAGE_STATUS_REFRESH_MS = 20_000;
/** The server's Working expiry; a status event older than this no longer means working. */
export const MESSAGE_STATUS_WORKING_MS = 120_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_EVENT_KEYS = new Set(["version", "kind", "workspaceId", "principalId", "state", "emittedAt", "id"]);

/** Rows from message_status, or null when the reply is unavailable or malformed. */
export function parseMessageStatus(data: unknown): MessageStatus[] | null {
  if (data === null || typeof data !== "object" || !Array.isArray((data as { statuses?: unknown }).statuses)) return null;
  const rows: MessageStatus[] = [];
  for (const raw of (data as { statuses: unknown[] }).statuses) {
    if (raw === null || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.signal_id !== "string" || !UUID_RE.test(row.signal_id) ||
        typeof row.agent_principal_id !== "string" || !UUID_RE.test(row.agent_principal_id) ||
        typeof row.delivered !== "boolean" || typeof row.seen !== "boolean" || typeof row.replied !== "boolean") return null;
    let working: MessageStatus["working"] = null;
    if (row.working !== null) {
      const w = row.working as Record<string, unknown> | undefined;
      const until = typeof w?.until === "string" ? Date.parse(w.until) : Number.NaN;
      if (!w || typeof w.label !== "string" || !Object.hasOwn(MESSAGE_STATUS_LABEL_TEXT, w.label) || !Number.isFinite(until)) return null;
      working = { label: w.label as MessageStatusLabel, until };
    }
    rows.push({
      signalId: row.signal_id.toLowerCase(),
      agentPrincipalId: row.agent_principal_id.toLowerCase(),
      delivered: row.delivered,
      seen: row.seen,
      replied: row.replied,
      working,
    });
  }
  return rows;
}

/** A status event for this workspace, or null for anything else (activity frames included).
 *  Realtime may add its own broadcast `id`. */
export function parseAgentStatusEvent(payload: unknown, workspaceId: string): AgentStatusEvent | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (row.kind !== "status" || Object.keys(row).some((key) => !STATUS_EVENT_KEYS.has(key))) return null;
  const emittedAt = typeof row.emittedAt === "string" ? Date.parse(row.emittedAt) : Number.NaN;
  if (row.version !== 1 || typeof row.workspaceId !== "string" || row.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
      typeof row.principalId !== "string" || !UUID_RE.test(row.principalId) ||
      (row.state !== "working" && row.state !== "idle") || !Number.isFinite(emittedAt)) return null;
  return { principalId: row.principalId.toLowerCase(), state: row.state, emittedAt };
}

/** The line's text, or null before the agent's client has the message (the receipt covers that). */
export function messageStatusText(status: MessageStatus, now: number): string | null {
  if (status.replied) return "Replied";
  if (status.working !== null && status.working.until > now) return `Working · ${MESSAGE_STATUS_LABEL_TEXT[status.working.label]}`;
  if (status.seen) return "Seen";
  if (status.delivered) return "Delivered";
  return null;
}

/** The signed-in person's latest visible message to each agent: the only rows that get a line. */
export function latestMessagesToAgents(signals: readonly Signal[], viewerId: string): Signal[] {
  const latest = new Map<string, Signal>();
  for (const signal of signals) {
    if (signal.fromKind !== "user" || signal.from !== viewerId || signal.toAgent === null || signal.threadRootId !== null) continue;
    const current = latest.get(signal.toAgent);
    if (!current || Date.parse(signal.createdAt) > Date.parse(current.createdAt) ||
        (signal.createdAt === current.createdAt && signal.id > current.id)) latest.set(signal.toAgent, signal);
  }
  return [...latest.values()]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, MESSAGE_STATUS_BATCH);
}
