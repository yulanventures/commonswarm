import { newCommandId, type ReactionCommand, type SignalRecord } from "./command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import { withClientBuild } from "./client-build.js";
import { signalReachesAgent } from "./signals.js";
import { SIGNAL_REACTION_SEEN } from "../protocol/signal-reactions.js";

export const AGENT_SEEN_BATCH_MAX = 50;
/** Seen marks one surfaced batch may send. More are left unmarked; the marks are a courtesy. */
export const AGENT_SEEN_REACTION_MAX = 20;
const AGENT_SEEN_TIMEOUT_MS = 5_000;

export type AgentSeenFailureCode = "transport" | "http" | "protocol";

export class AgentSeenReportError extends Error {
  constructor(
    readonly code: AgentSeenFailureCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AgentSeenReportError";
  }
}

export interface AgentSeenReportResult {
  attempted: number;
  reported: number;
  failures: AgentSeenFailureCode[];
}

export function renderedBroadcastIds(rows: readonly SignalRecord[]): string[] {
  return [...new Set(rows.filter((row) =>
    row.to === null && row.to_agent === null
  ).map((row) => row.id))];
}

export function agentSeenBatches(
  ids: readonly string[],
): string[][] {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += AGENT_SEEN_BATCH_MAX) {
    batches.push(unique.slice(offset, offset + AGENT_SEEN_BATCH_MAX));
  }
  return batches;
}

/**
 * One best-effort agent command: a fresh command id, one attempt, AGENT_SEEN_TIMEOUT_MS at most
 * (sooner when `signal` aborts), and an `ok: true` answer or an AgentSeenReportError.
 */
async function postAgentCommandOnce(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  command: { kind: "signals_seen"; signal_ids: readonly string[] } | ReactionCommand,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_SEEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        apikey: target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(withClientBuild({
        command_id: newCommandId(),
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: workspaceId,
        stream: { kind: "workspace" },
        command,
      })),
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    });
  } catch {
    throw new AgentSeenReportError(
      "transport",
      "agent seen report did not reach the command service",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AgentSeenReportError(
      "http",
      `agent seen report was refused with HTTP ${response.status}`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentSeenReportError(
      "protocol",
      "agent seen report returned malformed JSON",
      response.status,
    );
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    (body as Record<string, unknown>).ok !== true
  ) {
    throw new AgentSeenReportError(
      "protocol",
      "agent seen report returned a malformed acknowledgement",
      response.status,
    );
  }
}

export async function reportRenderedBroadcasts(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  signalIds: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<AgentSeenReportResult> {
  const batches = agentSeenBatches(signalIds);
  const failures: AgentSeenFailureCode[] = [];
  let reported = 0;
  for (const batch of batches) {
    try {
      await postAgentCommandOnce(target, token, workspaceId, { kind: "signals_seen", signal_ids: batch }, fetcher);
      reported += batch.length;
    } catch (error) {
      failures.push(
        error instanceof AgentSeenReportError ? error.code : "transport",
      );
    }
  }
  return { attempted: new Set(signalIds).size, reported, failures };
}

/**
 * The surfaced rows this agent marks seen with 👀: an ask or a note that reaches it (addressed or
 * mentioned), that it did not write, and that is not a reaction note (whose id is a reaction's).
 * A working-on update and a broadcast that only passes by get no mark. Unique, in order, bounded.
 */
export function seenAckTargets(
  rows: readonly SignalRecord[],
  principalId: string,
  limit = AGENT_SEEN_REACTION_MAX,
): string[] {
  const ids = rows.filter((row) =>
    (row.kind === "ask" || row.kind === "note") &&
    !(row.from_kind === "agent" && row.from === principalId) &&
    row.reaction === undefined &&
    signalReachesAgent(row, principalId)
  ).map((row) => row.id);
  return [...new Set(ids)].slice(0, limit);
}

/**
 * Mark surfaced messages seen with 👀 (source "ack"), one add_reaction each, in parallel. Never
 * throws: a refusal or a lost answer only lowers `reported`, and the server keeps one 👀 per agent
 * per message, so a repeat changes nothing.
 */
export async function reportSeenReactions(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  signalIds: readonly string[],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AgentSeenReportResult> {
  const ids = [...new Set(signalIds)].slice(0, AGENT_SEEN_REACTION_MAX);
  const outcomes = await Promise.all(ids.map(async (id) => {
    try {
      await postAgentCommandOnce(target, token, workspaceId,
        { kind: "add_reaction", signal_id: id, emoji: SIGNAL_REACTION_SEEN, source: "ack" }, fetcher, signal);
      return null;
    } catch (error) {
      return error instanceof AgentSeenReportError ? error.code : "transport" as const;
    }
  }));
  const failures = outcomes.filter((code): code is AgentSeenFailureCode => code !== null);
  return { attempted: ids.length, reported: ids.length - failures.length, failures };
}
