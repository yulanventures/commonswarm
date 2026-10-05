import { STANDING_IDLE_PAUSE_DAYS } from "./standing-grants";
import type { AgentStateKind, AgentStateVM, QueueRowVM } from "./home-types";

/** Typographic apostrophe used in every possessive on this view. */
export const APOSTROPHE = "\u2019";
const LSQUOTE = "\u2018";
const RSQUOTE = "\u2019";
const DOT = " \u00b7 ";

export type DisconnectReason =
  | "key-off"
  | "key-ended"
  | "paused"
  | "needs-reconnecting"
  | "removed";

export interface HomeAgentStatusCopyInput {
  disconnect: DisconnectReason | null;
  hosted: boolean;
  /** Local agent that has a measured receive path. Never true for chat-app agents. */
  localInbox: boolean;
  /** Preformatted clock, e.g. "10:05 am". */
  waitingSince: string | null;
  /**
   * True only when peopleAgentStatus already classified stale-messages
   * (the measured wakePathMark threshold). A waiting clock alone is not enough.
   */
  staleMessages: boolean;
  doingTitle: string | null;
  doingSince: string | null;
  workingOnTitle: string | null;
  workingOnWhen: string | null;
  /** True when a server-recorded action fell inside the last 30 minutes (R1). */
  recentAction: boolean;
  /** Preformatted idle age, e.g. "3 hours ago". */
  lastActive: string | null;
  idleChip: string;
}

export interface HomeAgentStatusCopy {
  kind: AgentStateKind;
  word: AgentStateVM["word"];
  detail: string;
}

export const AGENT_COPY = {
  whatToDo: "What to do",
  doingNow: "Doing now",
  upNext: "Up next",
  notYet: "Not yet",
  atSetTime: "At a set time",
  doneRecently: "Done recently",
  facts: "Facts",
  recentActivity: "Recent activity",
  manage: "Manage in People & agents",
  model: "Model",
  receiveFact: "How it gets messages",
  lastActive: "Last active",
  listsAndDocs: "Lists & docs",
  postsHere: "What it posts here",
  postsHereAlways: "Always",
  notFound: "Nothing with this link in Home.",
  homeLink: "Home",
  release: "Release",
  resume: "Resume",
  newKey: "Get a new key",
  emptyAssign: "Assign it a to-do from any to-do page.",
} as const;

export const IDLE_CHIPS = [
  "Active 2 hours ago",
  "Not active yet",
  "Not active for 5 days",
  "No activity reported yet",
] as const;

const NO_STEER: QueueRowVM["may"] = {
  up: false, down: false, startNow: false, notYet: false, release: false,
};

export function possessive(name: string): string {
  return `${name}${APOSTROPHE}s`;
}

export function quotedTitle(title: string): string {
  return `${LSQUOTE}${title}${RSQUOTE}`;
}

export function ownershipLine(ownerFirstName: string, yours: boolean): string {
  const line = `${possessive(ownerFirstName)} agent`;
  return yours ? `${line} (you)` : line;
}

export function receiveSentence(input: {
  hosted: boolean;
  yours: boolean;
  ownerFirstName: string | null;
  livePush: boolean;
  checksOnTask: boolean;
}): string {
  if (input.hosted) {
    return input.yours
      ? "Checks messages when you chat with it."
      : `Checks messages when ${input.ownerFirstName ?? "its owner"} chats with it.`;
  }
  if (input.livePush) return "Gets messages as they arrive.";
  if (input.checksOnTask) return "Checks messages each time it starts a task.";
  return "Message checks have not been reported.";
}

export function disconnectDetail(reason: DisconnectReason): string {
  if (reason === "key-off") return "Key turned off";
  if (reason === "key-ended") return "Key ended";
  if (reason === "paused") return `Paused: unused for ${STANDING_IDLE_PAUSE_DAYS} days`;
  if (reason === "removed") return "Removed";
  return "Needs reconnecting";
}

export function disconnectedBanner(detail: string): string {
  const reason = detail.length ? `${detail.charAt(0).toLocaleLowerCase()}${detail.slice(1)}` : "disconnected";
  return `Disconnected: ${reason}. Nothing in its line moves until it reconnects.`;
}

export function emptyLine(agentName: string): string {
  return `Nothing in ${possessive(agentName)} line. ${AGENT_COPY.emptyAssign}`;
}

export function footerNote(agentName: string, workspaceName: string): string {
  return `This page shows ${agentName} in ${workspaceName}.`;
}

/** R4. Never "starts at". The to-do joins the line; the agent reads it later. */
export function setTimeCopy(agentName: string, when: string): string {
  return `Joins ${possessive(agentName)} line at ${when}. ${agentName} sees it the next time it checks.`;
}

export function notYetTodoGate(title: string, agentName: string): string {
  return `On hold until ${quotedTitle(title)} is done. It stays out of ${possessive(agentName)} line until then, or until someone releases it.`;
}

export function notYetTimeGate(when: string): string {
  return `On hold until ${when}.`;
}

export function notYetNoteGate(note: string): string {
  return `On hold: ${note}`;
}

export function workingDoingDetail(title: string, since: string): string {
  return `Doing ${quotedTitle(title)} since ${since}`;
}

export function workingOnDetail(title: string, when: string): string {
  return `Said it${APOSTROPHE}s working on ${quotedTitle(title)}${DOT}${when}`;
}

export function staleDoingDetail(lastActive: string, title: string): string {
  return `Last active ${lastActive}; ${quotedTitle(title)} is still in Doing`;
}

export function notPickingUpDetail(since: string): string {
  return `A message has waited since ${since}`;
}

export function hostedWaitingDetail(since: string): string {
  return `Messages waiting since ${since}`;
}

/**
 * R1 status class and the measured detail. Callers pass preformatted times so
 * this file never reads the clock. Working requires a recent server action.
 */
export function homeAgentStatusCopy(input: HomeAgentStatusCopyInput): HomeAgentStatusCopy {
  if (input.disconnect) {
    return { kind: "disconnected", word: "Disconnected", detail: disconnectDetail(input.disconnect) };
  }
  // R1: working outranks waiting. "Not picking up" only when peopleAgentStatus already
  // flagged stale-messages for a local inbox. Hosted waiting stays idle.
  if (input.recentAction && input.doingTitle && input.doingSince) {
    return { kind: "working", word: "Working", detail: workingDoingDetail(input.doingTitle, input.doingSince) };
  }
  if (input.recentAction && input.workingOnTitle && input.workingOnWhen) {
    return { kind: "working", word: "Working", detail: workingOnDetail(input.workingOnTitle, input.workingOnWhen) };
  }
  if (!input.hosted && input.localInbox && input.staleMessages && input.waitingSince) {
    return { kind: "disconnected", word: "Not picking up", detail: notPickingUpDetail(input.waitingSince) };
  }
  if (input.hosted && input.waitingSince) {
    return { kind: "idle", word: "Idle", detail: hostedWaitingDetail(input.waitingSince) };
  }
  if (input.doingTitle && input.lastActive) {
    return { kind: "idle", word: "Idle", detail: staleDoingDetail(input.lastActive, input.doingTitle) };
  }
  return { kind: "idle", word: "Idle", detail: input.idleChip };
}

export function fixActionLabel(action: AgentStateVM["fix"]["action"]): string | null {
  if (action === "resume") return AGENT_COPY.resume;
  if (action === "new-key") return AGENT_COPY.newKey;
  return null;
}

/** Resume / Get a new key only on the viewer's own agent, never in sample mode. */
export function fixControlAllowed(yours: boolean, sample: boolean, allowed: boolean): boolean {
  return yours && !sample && allowed;
}

export function agentLineEmpty(sections: {
  doingNow: unknown;
  upNext: readonly unknown[];
  notYet: readonly unknown[];
  atSetTime: readonly unknown[];
}): boolean {
  return !sections.doingNow
    && sections.upNext.length === 0
    && sections.notYet.length === 0
    && sections.atSetTime.length === 0;
}

/** R7: steering is for the agent's owner, and never in sample mode. */
export function steeringMay(
  yours: boolean,
  sample: boolean,
  pageSteer: boolean,
  rowMay: QueueRowVM["may"],
): QueueRowVM["may"] {
  if (sample || !yours || !pageSteer) return { ...NO_STEER };
  return { ...rowMay };
}

export function doneRecentlyLimit<T>(rows: readonly T[], limit = 5): T[] {
  return rows.slice(0, limit);
}
