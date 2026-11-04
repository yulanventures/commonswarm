/*
 * The Clean up dialog body (owners and admins). All text goes through textContent.
 * Run semantics live in cleanup.ts; this file only builds rows and drives the DOM.
 */
import {
  CLEANUP_MAX_ITEMS,
  cleanupConsequence,
  freezePass,
  retryable,
  runPass,
  summarize,
  type CleanupContext,
  type CleanupOperation,
  type CleanupOutcome,
  type CleanupPass,
  type SendItem,
} from "./cleanup.ts";

export interface CleanupAgentInput {
  principalId: string;
  name: string;
  transport?: "local" | "hosted_mcp";
  ownerUserId: string;
  lastActiveAt: string | null;
}
export interface CleanupFileInput {
  fileId: string;
  name: string;
  sizeBytes: number;
  uploadedByKind: "user" | "agent";
  uploadedBy: string;
  committedAt: string;
  tombstonedAt: string | null;
}
export interface CleanupRow { id: string; label: string; detail: string }

const DAY = 86_400_000;

function ago(at: string | null, now: number): string {
  const time = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return "no activity recorded";
  const days = Math.floor(Math.max(0, now - time) / DAY);
  return days === 0 ? "active today" : `active ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Agents, least recently active first. Duplicate names are marked so the owner can tell them apart. */
export function cleanupAgentRows(agents: readonly CleanupAgentInput[], ownerName: (userId: string) => string, now = Date.now()): CleanupRow[] {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.name.toLowerCase(), (counts.get(agent.name.toLowerCase()) ?? 0) + 1);
  return [...agents]
    .sort((a, b) => (Date.parse(a.lastActiveAt ?? "") || 0) - (Date.parse(b.lastActiveAt ?? "") || 0))
    .map((agent) => ({
      id: agent.principalId,
      label: agent.name,
      detail: [
        agent.transport === "hosted_mcp" ? "connected app" : "terminal",
        `owner ${ownerName(agent.ownerUserId)}`,
        ago(agent.lastActiveAt, now),
        ...(counts.get(agent.name.toLowerCase())! > 1 ? [`same name as another agent · id ${agent.principalId.slice(0, 8)}`] : []),
      ].join(" · "),
    }));
}

export interface FileFilter { olderThanDays: number; uploaderGone: boolean }

/** Live files matching the filter, oldest first. A filter only narrows the list; nothing runs from it. */
export function cleanupFileRows(
  files: readonly CleanupFileInput[],
  filter: FileFilter,
  uploaderName: (kind: "user" | "agent", id: string) => string | null,
  now = Date.now(),
): CleanupRow[] {
  return files
    .filter((file) => file.tombstonedAt === null)
    .filter((file) => filter.olderThanDays <= 0 || now - Date.parse(file.committedAt) >= filter.olderThanDays * DAY)
    .filter((file) => !filter.uploaderGone || uploaderName(file.uploadedByKind, file.uploadedBy) === null)
    .sort((a, b) => Date.parse(a.committedAt) - Date.parse(b.committedAt))
    .map((file) => ({
      id: file.fileId,
      label: file.name,
      detail: [
        `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB`,
        `uploaded by ${uploaderName(file.uploadedByKind, file.uploadedBy) ?? "an agent no longer here"}`,
        `${Math.floor(Math.max(0, now - Date.parse(file.committedAt)) / DAY)} days ago`,
      ].join(" · "),
    }));
}

const OUTCOME_LABEL: Record<CleanupOutcome, string> = {
  accepted: "done",
  already_done: "already done",
  refused: "refused",
  rate_limited: "paused by a rate limit",
  unknown: "outcome unknown",
  not_attempted: "not started",
};

/** The names a confirmation lists: up to 20, then a count. */
export function confirmNames(labels: readonly string[]): string {
  const shown = labels.slice(0, 20).join(", ");
  return labels.length > 20 ? `${shown}, and ${labels.length - 20} more` : shown;
}

export function summaryText(results: ReadonlyMap<string, CleanupOutcome>): string {
  const counts = summarize(results);
  return (Object.keys(OUTCOME_LABEL) as CleanupOutcome[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${OUTCOME_LABEL[key]}`)
    .join(" · ");
}

export interface CleanupDeps {
  /** The verified account and workspace, or null when signed out or no longer owner/admin. */
  context(): CleanupContext | null;
  agents(): CleanupRow[];
  files(filter: FileFilter): Promise<CleanupRow[]>;
  send: SendItem;
  newId(): string;
  onFinished?(operation: CleanupOperation): void;
}

export function mountCleanup(root: HTMLElement, deps: CleanupDeps): void {
  const document = root.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  root.replaceChildren();
  let operation: CleanupOperation = "remove_agent";
  let rows: CleanupRow[] = [];
  const selected = new Set<string>();
  let pass: CleanupPass | null = null;
  let results: Map<string, CleanupOutcome> | null = null;
  let filter: FileFilter = { olderThanDays: 0, uploaderGone: false };

  const tabs = el("div", "cleanup__tabs");
  tabs.setAttribute("role", "tablist");
  const tab = (op: CleanupOperation, text: string) => {
    const button = el("button", "dashboard__text-button cleanup__tab", text);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.cleanupTab = op;
    button.addEventListener("click", () => { if (pass === null || results !== null) void show(op); });
    return button;
  };
  tabs.append(tab("remove_agent", "Agents"), tab("tombstone_file", "Files"));

  const filters = el("div", "cleanup__filters");
  const age = el("select", "cleanup__age");
  age.dataset.cleanupAge = "";
  age.setAttribute("aria-label", "Uploaded");
  for (const [value, text] of [["0", "Any age"], ["30", "Older than 30 days"], ["90", "Older than 90 days"], ["180", "Older than 180 days"]]) {
    const option = el("option", undefined, text);
    option.value = value;
    age.append(option);
  }
  const goneLabel = el("label", "cleanup__gone");
  const gone = el("input");
  gone.type = "checkbox";
  gone.dataset.cleanupUploaderGone = "";
  goneLabel.append(gone, " From people or agents no longer here");
  filters.append(age, goneLabel);
  const refilter = () => { filter = { olderThanDays: Number(age.value), uploaderGone: gone.checked }; void show("tombstone_file"); };
  age.addEventListener("change", refilter);
  gone.addEventListener("change", refilter);

  const list = el("ul", "cleanup__list");
  list.dataset.cleanupList = "";
  const footer = el("div", "cleanup__footer");
  const count = el("p", "cleanup__count");
  count.setAttribute("aria-live", "polite");
  const act = el("button", "dashboard__danger-button");
  act.type = "button";
  act.dataset.cleanupAct = "";
  footer.append(count, act);

  const confirm = el("section", "cleanup__confirm");
  confirm.dataset.cleanupConfirm = "";
  confirm.hidden = true;
  const consequence = el("p", "cleanup__consequence");
  const names = el("p", "cleanup__names");
  const confirmRow = el("div", "cleanup__confirm-actions");
  const go = el("button", "dashboard__danger-button", "Confirm");
  go.type = "button";
  go.dataset.cleanupGo = "";
  const back = el("button", "dashboard__text-button", "Back");
  back.type = "button";
  confirmRow.append(go, back);
  confirm.append(consequence, names, confirmRow);

  const report = el("section", "cleanup__report");
  report.dataset.cleanupReport = "";
  report.hidden = true;
  const reportSummary = el("p", "cleanup__summary");
  reportSummary.setAttribute("role", "status");
  const reportList = el("ul", "cleanup__report-list");
  const retry = el("button", "dashboard__text-button", "Retry the unknown ones");
  retry.type = "button";
  retry.dataset.cleanupRetry = "";
  report.append(reportSummary, reportList, retry);

  root.append(tabs, filters, list, footer, confirm, report);

  const syncFooter = () => {
    const n = selected.size;
    count.textContent = n > CLEANUP_MAX_ITEMS ? `${n} selected; one pass takes at most ${CLEANUP_MAX_ITEMS}.` : `${n} selected`;
    act.textContent = operation === "remove_agent"
      ? `Remove ${n} from this workspace…` : `Tombstone ${n} ${n === 1 ? "file" : "files"}…`;
    act.disabled = n === 0 || n > CLEANUP_MAX_ITEMS || deps.context() === null;
  };

  const renderRows = () => {
    list.replaceChildren(...rows.map((row) => {
      const item = el("li", "cleanup__row");
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = selected.has(row.id);
      box.dataset.cleanupItem = row.id;
      box.addEventListener("change", () => { if (box.checked) selected.add(row.id); else selected.delete(row.id); syncFooter(); });
      label.append(box, el("span", "cleanup__label", row.label), el("span", "cleanup__detail", row.detail));
      item.append(label);
      return item;
    }));
    if (rows.length === 0) list.append(el("li", "cleanup__empty", operation === "remove_agent" ? "No agents in this workspace." : "No files match."));
    syncFooter();
  };

  const show = async (op: CleanupOperation) => {
    operation = op;
    pass = null;
    results = null;
    selected.clear();
    confirm.hidden = true;
    report.hidden = true;
    list.hidden = false;
    footer.hidden = false;
    filters.hidden = op !== "tombstone_file";
    for (const button of tabs.querySelectorAll<HTMLButtonElement>("[data-cleanup-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.cleanupTab === op));
    }
    rows = op === "remove_agent" ? deps.agents() : [];
    renderRows();
    if (op === "tombstone_file") {
      list.replaceChildren(el("li", "cleanup__empty", "Loading files…"));
      try { rows = await deps.files(filter); } catch { rows = []; list.replaceChildren(el("li", "cleanup__empty", "Files could not be loaded. Try again.")); return; }
      if (operation === "tombstone_file") renderRows();
    }
  };

  act.addEventListener("click", () => {
    const chosen = rows.filter((row) => selected.has(row.id));
    const context = deps.context();
    if (chosen.length === 0 || context === null) return;
    pass = freezePass(context, operation, chosen, deps.newId);
    consequence.textContent = cleanupConsequence(operation);
    names.textContent = confirmNames(pass.items.map((item) => item.label));
    list.hidden = true;
    footer.hidden = true;
    filters.hidden = true;
    confirm.hidden = false;
    go.focus();
  });
  back.addEventListener("click", () => { pass = null; confirm.hidden = true; list.hidden = false; footer.hidden = false; filters.hidden = operation !== "tombstone_file"; });

  const execute = async (only?: ReadonlySet<string>) => {
    if (pass === null) return;
    const frozen = pass;
    confirm.hidden = true;
    report.hidden = false;
    retry.hidden = true;
    go.disabled = true;
    reportSummary.textContent = "Working…";
    const outcome = await runPass(frozen, deps.send, deps.context, {
      only,
      onProgress: () => { reportSummary.textContent = "Working…"; },
    });
    results = new Map([...(results ?? new Map()), ...outcome]);
    const labels = new Map(frozen.items.map((item) => [item.id, item.label]));
    reportSummary.textContent = `${summaryText(results)}. ${cleanupConsequence(frozen.operation)}`;
    reportList.replaceChildren(...[...results]
      .filter(([, value]) => value !== "accepted" && value !== "already_done")
      .map(([id, value]) => el("li", undefined, `${labels.get(id) ?? id}: ${OUTCOME_LABEL[value]}`)));
    const context = deps.context();
    retry.hidden = retryable(results).size === 0 || context === null ||
      context.userId !== frozen.context.userId || context.workspaceId !== frozen.context.workspaceId;
    go.disabled = false;
    deps.onFinished?.(frozen.operation);
  };
  go.addEventListener("click", () => { void execute(); });
  retry.addEventListener("click", () => { if (results) void execute(retryable(results)); });

  void show("remove_agent");
}
