// Catch up view (UI-SPEC.md section 3.2). Lane C owns this file.
import { agentOrb, capsule, needsYouCard, personAvatar } from "./home-primitives";
import type { AgentVM, CapsuleVM, NeedsYouVM, PersonVM } from "./home-types";

/** Local view model for Catch up; integration maps server rows into this shape. */
export interface CatchUpWorkspaceCardVM {
  id: string;
  name: string;
  href: string;
  peopleSummary: string;
  capsules: CapsuleVM[];
  openTodos: number | null;
  lists: number | null;
  files: number | null;
  agentsNeedingAttention: number | null;
  newMessagesSinceLastLooked: number | null;
  state: "loading" | "ready" | "failed" | "open";
}

export interface CatchUpLatestRowVM {
  id: string;
  authorLabel: string;
  workspace: {
    name: string;
    href: string;
  };
  excerpt: string;
  when: string;
  /** Optional: when integration knows who posted, the row shows their avatar. */
  author?: PersonVM | AgentVM | null;
}

export interface CatchUpVM {
  sample: boolean;
  viewerFirstName: string;
  now: string;
  needsYou: NeedsYouVM[];
  needsYouExpanded?: boolean;
  workspaces: CatchUpWorkspaceCardVM[];
  latest: CatchUpLatestRowVM[];
}

export interface CatchUpCallbacks {
  onNeedsYouAction: (action: string, item: NeedsYouVM) => void;
  onShowMoreNeedsYou: () => void;
}

const NEEDS_YOU_PREVIEW = 3;
const LATEST_MAX = 8;
/** One row of person+agents capsules on a workspace card; the rest are a "+N" count. */
const CARD_CAPSULES_MAX = 3;

/** Date eyebrow above the greeting ("Monday, October 5"), from the same clock as the greeting. */
export function catchUpDateLine(now: string): string {
  return new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * The card footer is one line, as in the canvas design. The other measured lines stay in the card's
 * accessible name. New messages win: agent attention also surfaces as a Needs you item at the top.
 */
export function catchUpCardFooter(card: CatchUpWorkspaceCardVM): { kind: "since" | "attention" | "counts"; text: string } | null {
  const since = catchUpNewMessagesSinceLastLookedLine(card.newMessagesSinceLastLooked);
  if (since) return { kind: "since", text: since };
  const attention = catchUpAgentAttentionLine(card.agentsNeedingAttention);
  if (attention) return { kind: "attention", text: attention };
  const counts = catchUpWorkspaceCountsLine(card);
  return counts ? { kind: "counts", text: counts } : null;
}

/** Local greeting until home-names.ts ships in lane P. */
export function catchUpGreeting(now: string, firstName: string): string {
  const hour = new Date(now).getHours();
  const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${period}, ${firstName}.`;
}

function catchUpMemberLabel(member: PersonVM, duplicateFirstNames: Set<string>): string {
  return duplicateFirstNames.has(member.firstName) ? member.name : member.firstName;
}

/** People summary for a workspace card (UI-SPEC.md section 2.3). */
export function catchUpPeopleSummary(members: PersonVM[]): string {
  const others = members.filter((member) => !member.you);
  if (others.length === 0) return "Just you";
  const firstNameCounts = new Map<string, number>();
  for (const member of members) firstNameCounts.set(member.firstName, (firstNameCounts.get(member.firstName) ?? 0) + 1);
  const duplicateFirstNames = new Set(members.filter((member) => (firstNameCounts.get(member.firstName) ?? 0) > 1).map((member) => member.firstName));
  if (others.length === 1) return `You and ${catchUpMemberLabel(others[0], duplicateFirstNames)}`;
  if (others.length === 2) {
    return `You, ${catchUpMemberLabel(others[0], duplicateFirstNames)} and ${catchUpMemberLabel(others[1], duplicateFirstNames)}`;
  }
  return `You, ${catchUpMemberLabel(others[0], duplicateFirstNames)} and ${others.length - 1} others`;
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return count === 1 ? singular : pluralWord;
}

export function catchUpWorkspaceCheckTotals(workspaces: CatchUpWorkspaceCardVM[]): {
  checked: number; total: number; anyFailed: boolean; anyPending: boolean;
} {
  const checked = workspaces.filter((card) => card.state === "ready").length;
  return {
    checked,
    total: workspaces.length,
    anyFailed: workspaces.some((card) => card.state === "failed"),
    anyPending: workspaces.some((card) => card.state === "loading"),
  };
}

/** Measured subline copy (UI-SPEC.md section 3.2). Partial failure wins over the empty state. */
export function catchUpSubline(vm: CatchUpVM): string {
  const { checked, total, anyFailed, anyPending } = catchUpWorkspaceCheckTotals(vm.workspaces);
  if (anyFailed) return `Checked ${checked} of ${total} ${plural(total, "workspace")}.`;
  const count = vm.needsYou.length;
  if (count > 0) {
    const workspaces = vm.workspaces.length;
    const verb = count === 1 ? "needs" : "need";
    return `${count} ${plural(count, "thing")} ${verb} you across ${workspaces} ${plural(workspaces, "workspace")}.`;
  }
  if (anyPending || checked < total) return `Checked ${checked} of ${total} ${plural(total, "workspace")}.`;
  return "Nothing needs you right now.";
}

/** Counts line built only from reads that succeeded; unknown counts are omitted, never shown as 0. */
export function catchUpWorkspaceCountsLine(card: CatchUpWorkspaceCardVM): string | null {
  const parts: string[] = [];
  if (card.openTodos !== null) parts.push(`${card.openTodos} open ${plural(card.openTodos, "to-do", "to-dos")}`);
  if (card.lists !== null) parts.push(`${card.lists} ${plural(card.lists, "list")}`);
  if (card.files !== null) parts.push(`${card.files} ${plural(card.files, "file")}`);
  return parts.length ? parts.join(" · ") : null;
}

export function catchUpAgentAttentionLine(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count === 1 ? "1 agent needs attention" : `${count} agents need attention`;
}

/** Workspace-card copy when the overview read measured new messages (DECISIONS R9). */
export function catchUpNewMessagesSinceLastLookedLine(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count === 1 ? "1 new message since you last looked" : `${count} new messages since you last looked`;
}

export function catchUpNeedsYouVisible(items: NeedsYouVM[], expanded: boolean): NeedsYouVM[] {
  return expanded ? items : items.slice(0, NEEDS_YOU_PREVIEW);
}

export function catchUpNeedsYouMoreCount(items: NeedsYouVM[], expanded: boolean): number {
  return expanded ? 0 : Math.max(0, items.length - NEEDS_YOU_PREVIEW);
}

/** Integration supplies `latest` newest-first across all workspaces; this only caps length. */
export function catchUpLatestVisible(rows: CatchUpLatestRowVM[]): CatchUpLatestRowVM[] {
  return rows.slice(0, LATEST_MAX);
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function link(doc: Document, href: string, className: string, label: string): HTMLAnchorElement {
  const element = node(doc, "a", className);
  element.href = href;
  element.textContent = label;
  return element;
}

function workspaceCardShell(doc: Document, card: CatchUpWorkspaceCardVM, sample: boolean): HTMLElement {
  if (sample) {
    const element = node(doc, "div", "hm-catchup-card hm-catchup-card--sample");
    element.dataset.workspaceId = card.id;
    return element;
  }
  const element = node(doc, "a", "hm-catchup-card");
  element.href = card.href;
  element.dataset.workspaceId = card.id;
  return element;
}

function workspaceCard(doc: Document, card: CatchUpWorkspaceCardVM, sample: boolean): HTMLElement {
  const element = workspaceCardShell(doc, card, sample);
  if (card.state === "loading") {
    element.setAttribute("aria-busy", "true");
    const statusText = `Checking ${card.name}…`;
    const status = node(doc, "p", "hm-catchup-card-status", statusText);
    element.append(node(doc, "div", "hm-catchup-card-head", card.name), status);
    element.title = card.name;
    element.setAttribute("aria-label", `${card.name}. ${statusText}`);
    return element;
  }
  if (card.state === "failed") {
    const statusText = `Couldn't load ${card.name}. Open it to try again.`;
    const status = node(doc, "p", "hm-catchup-card-status", statusText);
    element.append(node(doc, "div", "hm-catchup-card-head", card.name), status);
    element.title = card.name;
    element.setAttribute("aria-label", `${card.name}. ${statusText}`);
    return element;
  }
  if (card.state === "open") {
    element.append(node(doc, "div", "hm-catchup-card-head", card.name), node(doc, "p", "hm-catchup-card-open", "Open"));
    element.title = card.name;
    element.setAttribute("aria-label", `${card.name}. Open`);
    return element;
  }
  const head = node(doc, "div", "hm-catchup-card-body");
  const title = node(doc, "div", "hm-catchup-card-title", card.name);
  const summary = node(doc, "div", "hm-catchup-card-summary", card.peopleSummary);
  head.append(title, summary);
  const capsules = node(doc, "div", "hm-catchup-card-capsules");
  const shown = card.capsules.slice(0, CARD_CAPSULES_MAX);
  capsules.dataset.count = String(shown.length);
  for (const group of shown) capsules.append(capsule(doc, group, { compact: true }));
  const hidden = card.capsules.length - shown.length;
  if (hidden > 0) {
    const more = node(doc, "span", "hm-catchup-card-more", `+${hidden}`);
    more.setAttribute("role", "img");
    more.setAttribute("aria-label", `${hidden} more ${plural(hidden, "person", "people")}`);
    capsules.append(more);
  }
  const sinceLastLooked = catchUpNewMessagesSinceLastLookedLine(card.newMessagesSinceLastLooked);
  const counts = catchUpWorkspaceCountsLine(card);
  const attention = catchUpAgentAttentionLine(card.agentsNeedingAttention);
  element.append(head, capsules);
  const footer = catchUpCardFooter(card);
  if (footer) {
    const foot = node(doc, "div", "hm-catchup-card-foot");
    foot.append(node(doc, "p", `hm-catchup-card-${footer.kind}`, footer.text));
    element.append(foot);
  }
  element.title = card.name;
  element.setAttribute("aria-label", [card.name, card.peopleSummary, sinceLastLooked, counts, attention].filter(Boolean).join(". "));
  return element;
}

function needsYouPreview(doc: Document, item: NeedsYouVM): HTMLElement {
  const article = node(doc, "article", "hm-catchup-needs-preview");
  const labelId = `hm-catchup-needs-${item.id}`;
  article.setAttribute("aria-labelledby", labelId);
  article.append(
    node(doc, "p", "hm-catchup-needs-eyebrow", `Needs you · ${item.workspace.name} · ${item.when}`),
    node(doc, "p", "hm-catchup-needs-what", item.what),
  );
  article.querySelector(".hm-catchup-needs-what")!.id = labelId;
  return article;
}

/** Author avatar when integration supplies the author record. A guessed initial could mislead ("Y" for "Your Claude"), so none is drawn without one. */
function latestAvatar(doc: Document, row: CatchUpLatestRowVM): HTMLElement | null {
  const author = row.author;
  if (!author) return null;
  const chain = node(doc, "div", "hm-catchup-latest-who");
  chain.append("label" in author ? agentOrb(doc, author, { size: 28, badge: true }) : personAvatar(doc, author, 28));
  return chain;
}

function latestRow(doc: Document, row: CatchUpLatestRowVM, sample: boolean): HTMLElement {
  const element = node(doc, "article", "hm-catchup-latest-row");
  element.dataset.latestId = row.id;
  const body = node(doc, "div", "hm-catchup-latest-body");
  const sentence = node(doc, "p", "hm-catchup-latest-excerpt");
  sentence.append(node(doc, "strong", "hm-catchup-latest-author", row.authorLabel), " ", node(doc, "span", "hm-catchup-latest-text", row.excerpt));
  body.append(sentence, node(doc, "time", "hm-catchup-latest-when", row.when));
  const pill = sample
    ? node(doc, "span", "hm-catchup-latest-workspace hm-catchup-latest-workspace--sample", row.workspace.name)
    : link(doc, row.workspace.href, "hm-catchup-latest-workspace", row.workspace.name);
  const avatar = latestAvatar(doc, row);
  if (avatar) element.append(avatar);
  element.append(body, pill);
  return element;
}

function legend(doc: Document): HTMLElement {
  const root = node(doc, "div", "hm-catchup-legend");
  for (const [shape, text] of [["person", "A person"], ["agent", "An agent, grouped with its owner"]] as const) {
    const item = node(doc, "span", "hm-catchup-legend-item");
    const mark = node(doc, "span", "hm-catchup-legend-mark");
    mark.dataset.shape = shape;
    mark.setAttribute("aria-hidden", "true");
    item.append(mark, node(doc, "span", "", text));
    root.append(item);
  }
  return root;
}

/** Pure DOM builder for Catch up. User text always goes through textContent. */
export function renderCatchUp(doc: Document, vm: CatchUpVM, callbacks: CatchUpCallbacks): HTMLElement {
  const expanded = vm.needsYouExpanded ?? false;
  const root = node(doc, "section", "hm-catchup");
  root.setAttribute("aria-labelledby", "hm-catchup-title");
  const header = node(doc, "header", "hm-catchup-header");
  const title = node(doc, "h1", "hm-catchup-title", catchUpGreeting(vm.now, vm.viewerFirstName));
  title.id = "hm-catchup-title";
  title.tabIndex = -1;
  header.append(node(doc, "p", "hm-catchup-date", catchUpDateLine(vm.now)), title, node(doc, "p", "hm-catchup-subline", catchUpSubline(vm)));
  root.append(header);

  const visibleNeedsYou = catchUpNeedsYouVisible(vm.needsYou, expanded);
  if (visibleNeedsYou.length) {
    const section = node(doc, "section", "hm-catchup-needs");
    section.setAttribute("aria-labelledby", "hm-catchup-needs-title");
    const needsTitle = node(doc, "h2", "hm-catchup-section-title hm-catchup-needs-title", "Needs you");
    needsTitle.id = "hm-catchup-needs-title";
    section.append(needsTitle);
    const list = node(doc, "div", "hm-catchup-needs-list");
    list.id = "hm-catchup-needs-list";
    // The first item is the lime band; the rest are quieter rows under it (catchup.css).
    for (const [index, item] of visibleNeedsYou.entries()) {
      const entry = vm.sample
        ? needsYouPreview(doc, item)
        : needsYouCard(doc, item, (action, need) => callbacks.onNeedsYouAction(action, need));
      entry.dataset.needsRank = index === 0 ? "first" : "more";
      list.append(entry);
    }
    section.append(list);
    const more = catchUpNeedsYouMoreCount(vm.needsYou, expanded);
    if (more > 0 && !vm.sample) {
      const button = node(doc, "button", "hm-catchup-show-more", `Show ${more} more`);
      button.type = "button";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", list.id);
      button.addEventListener("click", () => callbacks.onShowMoreNeedsYou());
      section.append(button);
    }
    root.append(section);
  }

  const workspaces = node(doc, "section", "hm-catchup-workspaces");
  workspaces.setAttribute("aria-labelledby", "hm-catchup-workspaces-title");
  const workspacesTitle = node(doc, "h2", "hm-catchup-section-title", "Your workspaces");
  workspacesTitle.id = "hm-catchup-workspaces-title";
  const workspacesHead = node(doc, "div", "hm-catchup-workspaces-head");
  workspacesHead.append(workspacesTitle, legend(doc));
  workspaces.append(workspacesHead);
  const grid = node(doc, "div", "hm-catchup-grid");
  for (const card of vm.workspaces) grid.append(workspaceCard(doc, card, vm.sample));
  workspaces.append(grid);
  root.append(workspaces);

  const visibleLatest = catchUpLatestVisible(vm.latest);
  if (visibleLatest.length) {
    const latest = node(doc, "section", "hm-catchup-latest");
    latest.setAttribute("aria-labelledby", "hm-catchup-latest-title");
    const latestTitle = node(doc, "h2", "hm-catchup-section-title", "Latest");
    latestTitle.id = "hm-catchup-latest-title";
    latest.append(latestTitle);
    const list = node(doc, "div", "hm-catchup-latest-list");
    for (const row of visibleLatest) list.append(latestRow(doc, row, vm.sample));
    latest.append(list);
    root.append(latest);
  }

  return root;
}
