import type { AgentStateVM, QueueRowVM } from "./home-types";

/** Typographic apostrophe used in every possessive on this view. */
export const APOSTROPHE = "\u2019";
const LSQUOTE = "\u2018";
const RSQUOTE = "\u2019";

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
  policyTitle: "Who can give it work",
  policyOwner: "Only you",
  policyAnyone: "Anyone in the workspace",
  policyOffer: "A to-do from anyone else comes to you to decide.",
  policyLock: "Only you can change who gives it work.",
} as const;

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

export function disconnectedBanner(detail: string): string {
  const reason = detail.length ? `${detail.charAt(0).toLocaleLowerCase()}${detail.slice(1)}` : "disconnected";
  return `Disconnected: ${reason}. Nothing in its line moves until it reconnects.`;
}

export function emptyLine(agentName: string): string {
  return `Nothing in ${possessive(agentName)} line. ${AGENT_COPY.emptyAssign}`;
}

/** Title of the card that holds the agent's line (vocabulary: "line", never "queue"). */
export function lineTitle(agentName: string): string {
  return `${possessive(agentName)} line`;
}

/** What a disconnected agent has waiting, from the measured line only. Null when nothing is measured as waiting. */
export function waitingLine(count: number): string | null {
  if (!Number.isInteger(count) || count < 1) return null;
  return count === 1 ? "1 to-do is waiting in its line." : `${count} to-dos are waiting in its line.`;
}

/** The Facts card introduction: what the card answers, with no claim the server does not measure. */
export function factsIntro(agentName: string, workspaceName: string): string {
  return `How ${agentName} connects to ${workspaceName} and what it may use here.`;
}

/** The Facts card summary line, from the measured last call (or "Not reported"). */
export function lastActiveLine(value: string): string {
  return `${AGENT_COPY.lastActive}: ${value}.`;
}

/** The secondary control that switches the work policy to the other value. */
export function policyChangeLabel(next: "owner" | "anyone"): string {
  const target = next === "owner" ? AGENT_COPY.policyOwner : AGENT_COPY.policyAnyone;
  return `Change to ${target.charAt(0).toLocaleLowerCase()}${target.slice(1)}`;
}

/** The value word of a plain fact row (Lists & docs, What it posts here); the same words the switch row used. */
export function switchWord(state: "on" | "off" | "always" | "never"): string {
  return { on: "On", off: "Off", always: AGENT_COPY.postsHereAlways, never: "Never" }[state];
}

/** The danger entry point; removal ends access to this workspace only (people dialog confirmation). */
export function removeLabel(agentName: string, workspaceName: string): string {
  return `Remove ${agentName} from ${workspaceName}`;
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
