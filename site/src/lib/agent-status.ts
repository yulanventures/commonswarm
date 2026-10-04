/*
 * One plain status per agent, for the rail and the People & agents list.
 *
 * The roster carries wire facts: transport, turn-only receive, the presence row (last call,
 * push routes, client build) and the access row (revoked, suspended). A person needs one chip
 * and, where it helps, one sentence. This file is the only translation; the wire words stay
 * available in the profile panel for support.
 *
 * TRUTH RULES.
 * - Hosted agents are turn-only (src/protocol/workspace-reducer.ts): they read messages when
 *   someone chats with them. The sentence says exactly that and never "online" or "wakes".
 * - "Gets messages as they arrive" is said only while a push route is live in the presence row,
 *   the same lease the classifier calls live (src/cloud/agent-presence.ts).
 * - No presence row means the server has no view. The chip then says nothing about activity.
 */

import { classifyAgentPresence, type AgentPresenceRow } from "../../../src/cloud/agent-presence";

export type AgentStatusKind = "removed" | "suspended" | "inactive" | "active" | "idle" | "connected";

export interface AgentStatusInput {
  transport?: "local" | "hosted_mcp";
  turnOnly?: boolean;
  presence?: AgentPresenceRow | null;
  /** The access row says the agent's key or connection was revoked. */
  revoked?: boolean;
  /** The access row says the agent's access is suspended (for example a new host). */
  suspended?: boolean;
}

export interface AgentStatus {
  kind: AgentStatusKind;
  /** Short chip text. */
  chip: string;
  /** How it receives messages, in one sentence, or null when unknown. */
  receive: string | null;
}

/** An agent silent this long reads as not active. */
export const AGENT_INACTIVE_AFTER_MS = 3 * 24 * 60 * 60_000;
/** Within this, the chip says "Active now". */
const ACTIVE_NOW_MS = 10 * 60_000;

function ago(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function agentStatus(input: AgentStatusInput, now = Date.now()): AgentStatus {
  const hosted = input.transport === "hosted_mcp" || input.turnOnly === true;
  let receive: string | null = hosted ? "Checks messages when you chat with it." : null;
  let lastCallAge: number | null = null;
  if (input.presence !== undefined) {
    const presence = classifyAgentPresence(input.presence, now);
    lastCallAge = presence.last_call?.age_ms ?? null;
    if (!hosted) {
      receive = presence.wake.kind.startsWith("live ")
        ? "Gets messages as they arrive."
        : presence.wake.kind === "turn"
          ? "Checks messages at the start of each turn."
          : null;
    }
  }
  if (input.revoked) {
    return { kind: "removed", chip: "Removed", receive: "It can no longer read or post." };
  }
  if (input.suspended) {
    return { kind: "suspended", chip: "Needs reconnecting", receive: "Connect it again from its app." };
  }
  if (input.presence === undefined) {
    return { kind: "connected", chip: "Connected", receive };
  }
  if (lastCallAge === null) {
    return { kind: "idle", chip: "Not active yet", receive };
  }
  if (lastCallAge >= AGENT_INACTIVE_AFTER_MS) {
    const days = Math.floor(lastCallAge / 86_400_000);
    return { kind: "inactive", chip: `Not active for ${days} days`, receive };
  }
  return {
    kind: "active",
    chip: lastCallAge < ACTIVE_NOW_MS ? "Active now" : `Active ${ago(lastCallAge)}`,
    receive,
  };
}
