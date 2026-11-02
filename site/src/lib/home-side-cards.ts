// Home UI: the workspace Details column. With nothing selected it shows what this workspace shares;
// a selected person or agent replaces it with their profile (LiveDashboard.astro, data-entity-panel).
// To-dos, Lists, Files and Wiki live in the workspace tabs, so they are not repeated here.
// User text goes in through textContent only; nothing here reads the network or the clock.
import type { AgentVM } from "./home-types";
import { HOSTED_LISTS_NOTE } from "./hosted-lists-note";

/** An agent of the viewer's that may use Lists & docs here. `until` is null while it lasts until withdrawn. */
export interface SideSharedAgentVM { agent: AgentVM; until: string | null }

export interface SideCardsVM {
  sample: boolean;
  workspaceName: string;
  /** The viewer's agents only: the access read is owner-scoped, so other people's agents never appear here. */
  sharedAgents: SideSharedAgentVM[];
}

/** "Everyone in Home sees what is posted here, including what agents post." */
export function sharedEveryoneLine(workspaceName: string): string {
  return `Everyone in ${workspaceName} sees what is posted here, including what agents post.`;
}

/**
 * One line per agent of the viewer's own that may use Lists & docs. The line is the spec's exact sentence
 * while the approval lasts until withdrawn; with an end date it says so instead of promising more.
 */
export function sharedAgentLines(agents: readonly SideSharedAgentVM[]): string[] {
  // A hosted agent's stored approval is real but unusable for now: say so instead of promising access.
  return agents.filter(({ agent }) => agent.yours).map(({ agent, until }) => agent.hosted ? `${agent.label}: ${HOSTED_LISTS_NOTE}` : until
    ? `${agent.label} can use Lists & docs here until ${until}, or until you withdraw it.`
    : `${agent.label} can use Lists & docs here, until you withdraw it.`);
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** "What’s shared here": the broad line for everyone, then one line per agent of the viewer's own. */
export function buildSharedCard(doc: Document, vm: SideCardsVM): HTMLElement {
  const root = node(doc, "section", "hm-side-card"); root.dataset.sideCard = "shared";
  const heading = node(doc, "h2", "hm-side-card__title", "What’s shared here"); heading.id = "hm-side-shared-title";
  root.setAttribute("aria-labelledby", heading.id);
  const body = node(doc, "div", "hm-side-card__body");
  body.append(node(doc, "p", "hm-side-card__line", sharedEveryoneLine(vm.workspaceName)));
  for (const line of sharedAgentLines(vm.sharedAgents)) body.append(node(doc, "p", "hm-side-card__line", line));
  root.append(heading, body);
  return root;
}

/** The workspace's own details: what it shares. */
export function buildSideCards(doc: Document, vm: SideCardsVM): HTMLElement {
  const column = node(doc, "div", "hm-side"); column.dataset.homeSide = ""; if (vm.sample) column.dataset.sample = "true";
  column.append(buildSharedCard(doc, vm));
  return column;
}
