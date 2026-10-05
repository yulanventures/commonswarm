// Catch up view (UI-SPEC.md section 3.2). Lane C owns this file.
import { capsule, needsYouCard } from "./home-primitives";
import type { CapsuleVM, NeedsYouVM, PersonVM } from "./home-types";

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
  agentsNeedingAttention: number;
  state: "loading" | "ready" | "failed" | "open";
}

export interface CatchUpLatestRowVM {
  id: string;
  authorLabel: string;
  workspace: {
    name: string;
    href: string;
    sinceLastLooked?: { newMessages: number; lastSeenAt: string };
  };
  excerpt: string;
  when: string;
}

export interface CatchUpLatestGroupVM {
  heading: string;
  rows: CatchUpLatestRowVM[];
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

/** Local greeting until home-names.ts ships in lane P. */
export function catchUpGreeting(now: string, firstName: string): string {
  const hour = new Date(now).getHours();
  const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${period}, ${firstName}.`;
}

/** People summary for a workspace card (UI-SPEC.md section 2.3). */
export function catchUpPeopleSummary(members: PersonVM[]): string {
  const others = members.filter((member) => !member.you);
  if (others.length === 0) return "Just you";
  if (others.length === 1) return `You and ${others[0].firstName}`;
  if (others.length === 2) return `You, ${others[0].firstName} and ${others[1].firstName}`;
  return `You, ${others[0].firstName} and ${others.length - 1} others`;
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
  if (anyFailed) return `Checked ${checked} of ${total} workspaces.`;
  const count = vm.needsYou.length;
  if (count > 0) {
    const workspaces = vm.workspaces.length;
    const verb = count === 1 ? "needs" : "need";
    return `${count} ${plural(count, "thing")} ${verb} you across ${workspaces} ${plural(workspaces, "workspace")}.`;
  }
  if (anyPending || checked < total) return `Checked ${checked} of ${total} workspaces.`;
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

export function catchUpAgentAttentionLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 agent needs attention" : `${count} agents need attention`;
}

/** Per-workspace Latest heading (DECISIONS R9). */
export function catchUpLatestHeading(sinceLastLooked?: { newMessages: number; lastSeenAt: string }): string {
  if (sinceLastLooked && sinceLastLooked.newMessages > 0) {
    return `${sinceLastLooked.newMessages} new since you last looked`;
  }
  return "Latest";
}

export function catchUpLatestGroups(rows: CatchUpLatestRowVM[]): CatchUpLatestGroupVM[] {
  const groups: CatchUpLatestGroupVM[] = [];
  const seen = new Map<string, CatchUpLatestGroupVM>();
  for (const row of catchUpLatestVisible(rows)) {
    const key = row.workspace.href;
    let group = seen.get(key);
    if (!group) {
      group = { heading: catchUpLatestHeading(row.workspace.sinceLastLooked), rows: [] };
      seen.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export function catchUpNeedsYouVisible(items: NeedsYouVM[], expanded: boolean): NeedsYouVM[] {
  return expanded ? items : items.slice(0, NEEDS_YOU_PREVIEW);
}

export function catchUpNeedsYouMoreCount(items: NeedsYouVM[], expanded: boolean): number {
  return expanded ? 0 : Math.max(0, items.length - NEEDS_YOU_PREVIEW);
}

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
  for (const group of card.capsules) capsules.append(capsule(doc, group, { compact: true }));
  const foot = node(doc, "div", "hm-catchup-card-foot");
  const counts = catchUpWorkspaceCountsLine(card);
  if (counts) foot.append(node(doc, "p", "hm-catchup-card-counts", counts));
  const attention = catchUpAgentAttentionLine(card.agentsNeedingAttention);
  if (attention) foot.append(node(doc, "p", "hm-catchup-card-attention", attention));
  element.append(head, capsules, foot);
  element.title = card.name;
  element.setAttribute("aria-label", [card.name, card.peopleSummary, counts, attention].filter(Boolean).join(". "));
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

function latestRow(doc: Document, row: CatchUpLatestRowVM, sample: boolean): HTMLElement {
  const element = node(doc, "article", "hm-catchup-latest-row");
  element.dataset.latestId = row.id;
  const author = node(doc, "div", "hm-catchup-latest-author", row.authorLabel);
  const body = node(doc, "div", "hm-catchup-latest-body");
  body.append(node(doc, "p", "hm-catchup-latest-excerpt", row.excerpt), node(doc, "time", "hm-catchup-latest-when", row.when));
  const pill = sample
    ? node(doc, "span", "hm-catchup-latest-workspace hm-catchup-latest-workspace--sample", row.workspace.name)
    : link(doc, row.workspace.href, "hm-catchup-latest-workspace", row.workspace.name);
  element.append(author, body, pill);
  return element;
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
  header.append(title, node(doc, "p", "hm-catchup-subline", catchUpSubline(vm)));
  root.append(header);

  const visibleNeedsYou = catchUpNeedsYouVisible(vm.needsYou, expanded);
  if (visibleNeedsYou.length) {
    const section = node(doc, "section", "hm-catchup-needs");
    section.setAttribute("aria-labelledby", "hm-catchup-needs-title");
    const needsTitle = node(doc, "h2", "hm-catchup-section-title", "Needs you");
    needsTitle.id = "hm-catchup-needs-title";
    section.append(needsTitle);
    const list = node(doc, "div", "hm-catchup-needs-list");
    for (const item of visibleNeedsYou) {
      list.append(vm.sample
        ? needsYouPreview(doc, item)
        : needsYouCard(doc, item, (action, entry) => callbacks.onNeedsYouAction(action, entry)));
    }
    section.append(list);
    const more = catchUpNeedsYouMoreCount(vm.needsYou, expanded);
    if (more > 0 && !vm.sample) {
      const button = node(doc, "button", "hm-catchup-show-more", `Show ${more} more`);
      button.type = "button";
      button.addEventListener("click", () => callbacks.onShowMoreNeedsYou());
      section.append(button);
    }
    root.append(section);
  }

  const workspaces = node(doc, "section", "hm-catchup-workspaces");
  workspaces.setAttribute("aria-labelledby", "hm-catchup-workspaces-title");
  const workspacesTitle = node(doc, "h2", "hm-catchup-section-title", "Your workspaces");
  workspacesTitle.id = "hm-catchup-workspaces-title";
  workspaces.append(workspacesTitle);
  const grid = node(doc, "div", "hm-catchup-grid");
  for (const card of vm.workspaces) grid.append(workspaceCard(doc, card, vm.sample));
  workspaces.append(grid);
  root.append(workspaces);

  const latestGroups = catchUpLatestGroups(vm.latest);
  if (latestGroups.length) {
    const latest = node(doc, "section", "hm-catchup-latest");
    latestGroups.forEach((group, index) => {
      const groupEl = node(doc, "div", "hm-catchup-latest-group");
      const groupTitle = node(doc, "h2", "hm-catchup-section-title", group.heading);
      groupTitle.id = `hm-catchup-latest-title-${index}`;
      if (index === 0) latest.setAttribute("aria-labelledby", groupTitle.id);
      groupEl.append(groupTitle);
      const list = node(doc, "div", "hm-catchup-latest-list");
      for (const row of group.rows) list.append(latestRow(doc, row, vm.sample));
      groupEl.append(list);
      latest.append(groupEl);
    });
    root.append(latest);
  }

  return root;
}
