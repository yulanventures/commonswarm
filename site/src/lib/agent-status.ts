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
import { WAKE_STALE_MS } from "../../../src/cloud/idle-poll";
import { wakePathMark } from "./wake-path";
import { STANDING_IDLE_PAUSE_DAYS, STANDING_RESUME_ACTORS, type GrantRiskInput } from "./standing-grants";
import type { AgentStateVM } from "./home-types";
import { formatWhen } from "./home-names";

export type AgentStatusKind = "removed" | "suspended" | "inactive" | "active" | "idle" | "connected";

export interface AgentStatusInput {
  own?: boolean;
  ownerName?: string | null;
  ownerFirstName?: string | null;
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

/** Dialog activity uses whole words and elapsed days, also for its Last active fact. */
export function peopleAgentActivityTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  const [amount, unit] = minutes < 60 ? [minutes, "minute"]
    : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

export function agentStatus(input: AgentStatusInput, now = Date.now()): AgentStatus {
  const hosted = input.transport === "hosted_mcp";
  const chatPerson = input.own === false ? input.ownerFirstName?.trim() || input.ownerName?.trim().split(/\s+/)[0] : null;
  let receive: string | null = hosted ? input.own === false
    ? chatPerson ? `Checks messages when ${chatPerson} chats with it.` : "Checks messages when its owner chats with it."
    : "Checks messages when you chat with it." : input.turnOnly ? "Checks messages each time it starts a task." : null;
  let lastCallAge: number | null = null;
  if (input.presence !== undefined) {
    const presence = classifyAgentPresence(input.presence, now);
    lastCallAge = presence.last_call?.age_ms ?? null;
    if (!hosted) {
      receive = presence.wake.kind.startsWith("live ")
        ? "Gets messages as they arrive."
        : presence.wake.kind === "turn"
          ? "Checks messages each time it starts a task."
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


export type PeopleAgentStatusKind = AgentStatusKind | "key-off" | "key-ended" | "paused" | "stale-messages" | "key-ends-soon" | "new-computer";
export interface PeopleAgentStatusInput extends AgentStatusInput {
  grant?: GrantRiskInput | null;
  oldestUnobservedAt?: string | null;
  app?: string | null;
  ownerName: string | null;
  own: boolean;
  mayManage: boolean;
  sample: boolean;
}
export interface PeopleAgentStatus {
  kind: PeopleAgentStatusKind;
  label: string;
  sentence: string;
  attention: boolean;
  fix: { action: "resume" | "new-key" | "guide-chat" | "guide-local" | null; allowed: boolean; askWho: string | null };
}

/** One translation of the same wire facts, with attention and viewer-specific next steps. */
export function peopleAgentStatus(input: PeopleAgentStatusInput, now = Date.now()): PeopleAgentStatus {
  const base = agentStatus(input, now);
  const owner = input.ownerName?.split(/\s+/)[0] ?? "its owner";
  const actors = STANDING_RESUME_ACTORS.map((actor, index) =>
    index === STANDING_RESUME_ACTORS.length - 1 ? `or ${actor}` : actor).join(", ");
  const result = (kind: PeopleAgentStatusKind, label: string, sentence: string,
    action: PeopleAgentStatus["fix"]["action"] = null, permitted = false, askWho: string | null = null,
    attention = true): PeopleAgentStatus => ({ kind, label, sentence, attention,
      fix: { action, allowed: permitted && !input.sample, askWho } });
  const keyFix = (kind: "key-off" | "key-ended" | "key-ends-soon", label: string) => result(kind, label,
    input.own ? kind === "key-ends-soon" ? "Get a new key before this one ends." : "It needs a new key to connect again."
      : `Ask ${owner} to get a new key.`, "new-key", input.own, input.own ? null : owner);
  const grant = input.grant;
  if (grant?.revokedAt) return keyFix("key-off", "Key turned off");
  const horizon = grant?.kind === "timeboxed" && grant.horizonExpiresAt ? Date.parse(grant.horizonExpiresAt) : NaN;
  if (horizon <= now) return keyFix("key-ended", "Key ended");
  if (grant?.kind === "standing" && grant.suspendedAt) return result("paused",
    `Paused: unused for ${STANDING_IDLE_PAUSE_DAYS} days`, input.mayManage ? "Resume it so it can connect again."
      : input.ownerName ? `Ask ${owner} to resume it.` : `Ask ${actors} to resume it.`,
    "resume", input.mayManage, input.mayManage ? null : input.ownerName ? owner : actors);
  if (wakePathMark(input.oldestUnobservedAt, now)) {
    const hosted = input.transport === "hosted_mcp";
    return result("stale-messages", `Hasn’t picked up messages for ${WAKE_STALE_MS / 60_000}+ min`,
      hosted ? "Open the chat app you use it in and say: check CommonSwarm." : "Start its cswarm process.",
      hosted ? "guide-chat" : "guide-local", input.own, input.own ? null : owner);
  }
  if (horizon - now <= 3 * 86_400_000) {
    const days = Math.max(1, Math.ceil((horizon - now) / 86_400_000));
    return keyFix("key-ends-soon", `Key ends in ${days} ${days === 1 ? "day" : "days"}`);
  }
  if (grant?.newHostAt) return result("new-computer", "Used from a new computer", "Keep using it if you recognize this computer.");
  const label = base.kind === "active" && base.chip !== "Active now" && input.presence?.last_command_at
    ? `Active ${peopleAgentActivityTime(input.presence.last_command_at, now)}` : base.chip;
  return result(base.kind, label, base.receive ?? "Message checks have not been reported.", null, false, null, false);
}

export function agentResumeReceipt(name: string): string {
  return `Resumed. Nothing has reached ${name} yet. It renews the next time it starts. Another ${STANDING_IDLE_PAUSE_DAYS} days without use will pause it again.`;
}

/** Server-recorded activity keeps an old work claim from reading as current work. */
export const WORK_RECENT_MS = 30 * 60_000;
export interface HomeAgentStatusInput extends PeopleAgentStatusInput {
  workingOn?: { title?: string; body?: string; until: string; createdAt?: string; created_at?: string } | null;
  doingTodo?: { title: string; since?: string; startedAt?: string } | null;
  lastActionAt?: string | null;
  hasWakePath?: boolean;
  serverWork?: "working" | "idle" | "disconnected";
  now?: number;
  locale?: string;
}
export interface HomeAgentState extends AgentStateVM { receive: string | null }

/** Home presentation extends the dialog translation; it never invents a reconnect action. */
export function homeAgentState(input: HomeAgentStatusInput, now = input.now ?? Date.now()): HomeAgentState {
  const hosted = input.transport === "hosted_mcp";
  const hasWakePath = !hosted && (input.hasWakePath ?? Boolean(input.presence &&
    (input.presence.watcher_at || input.presence.channel_at || input.presence.listener_at)));
  const people = peopleAgentStatus({ ...input, oldestUnobservedAt: hasWakePath && !input.revoked && !input.suspended ? input.oldestUnobservedAt : null }, now);
  const receive = agentStatus(input, now).receive;
  const lastAction = Date.parse(input.lastActionAt ?? input.presence?.last_command_at ?? "");
  const recent = Number.isFinite(lastAction) && lastAction <= now && now - lastAction <= WORK_RECENT_MS;
  const workingOn = input.workingOn && Date.parse(input.workingOn.until) > now ? input.workingOn : null;
  const disconnected = ["removed", "suspended", "key-off", "key-ended", "paused"].includes(people.kind);
  const kind = input.serverWork ?? (disconnected || people.kind === "stale-messages" ? "disconnected"
    : recent && (input.doingTodo || workingOn) ? "working" : "idle");
  let word: AgentStateVM["word"] = kind === "working" ? "Working" : kind === "disconnected" ? "Disconnected" : "Idle";
  let detail: string;
  // The server supplies the work class; credential facts still need their own detail and fix.
  if (disconnected) {
    detail = people.label;
  } else if (kind === "disconnected") {
    if (people.kind === "stale-messages") {
      word = "Not picking up";
      detail = `A message has waited since ${formatWhen(input.oldestUnobservedAt!, now, input.locale)}`;
    } else detail = "Needs reconnecting";
  } else if (kind === "working") {
    if (input.doingTodo) {
      const since = input.doingTodo.since ?? input.doingTodo.startedAt;
      detail = `Doing ‘${input.doingTodo.title}’${since ? ` since ${formatWhen(since, now, input.locale)}` : ""}`;
    } else if (workingOn) {
      const at = workingOn.createdAt ?? workingOn.created_at;
      detail = `Said it’s working on ‘${workingOn.title ?? workingOn.body ?? "a task"}’${at ? ` · ${peopleAgentActivityTime(at, now)}` : " · Time unavailable"}`;
    } else detail = "Recent work reported by the server";
  } else if (hosted && wakePathMark(input.oldestUnobservedAt, now)) {
    detail = `Messages waiting since ${formatWhen(input.oldestUnobservedAt!, now, input.locale)}${receive ? `. ${receive}` : ""}`;
  } else if (!recent && input.doingTodo) {
    detail = `${Number.isFinite(lastAction) ? `Last active ${peopleAgentActivityTime(new Date(lastAction).toISOString(), now)}` : "No activity reported yet"}; ‘${input.doingTodo.title}’ is still in Doing`;
  } else {
    detail = input.presence == null ? "No activity reported yet" : people.kind === "stale-messages"
      ? agentStatus(input, now).chip : people.label;
  }
  const attention = disconnected || kind === "disconnected" || (people.attention && people.kind !== "stale-messages");
  const fix = attention && (disconnected || people.attention)
    ? { ...people.fix, sentence: people.sentence }
    : { action: null, allowed: false, askWho: null, sentence: "" } as AgentStateVM["fix"];
  if (kind === "disconnected" && !people.attention && !disconnected) fix.sentence = "Connect it again from its app.";
  return { kind, word, detail, attention, fix, receive };
}
