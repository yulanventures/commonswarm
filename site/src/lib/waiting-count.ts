/**
 * Waiting on you: one count across every workspace the person belongs to, drawn in the top bar on a phone and on a
 * desktop. It opens Catch up, which lists what the count counts.
 *
 * A workspace is counted or it is not. An uncounted workspace is never a zero: the total is then a minimum, and a
 * minimum of nothing draws no number at all.
 */

export const WAITING_LABEL = "Waiting on you";

/** `min` is what is known to be waiting; `complete` says every workspace was counted. */
export interface WaitingTotal { min: number; complete: boolean }

/** The total over the person's workspaces. A workspace with no entry, or a null one, was not counted. */
export function waitingTotal(workspaceIds: readonly string[], counts: ReadonlyMap<string, number | null>): WaitingTotal {
  let min = 0, complete = true;
  for (const id of workspaceIds) {
    const count = counts.get(id);
    if (typeof count === "number") min += count; else complete = false;
  }
  return { min, complete };
}

/** What is drawn beside the label: "3", "3+" while some workspace is uncounted, "0" only when all were counted,
 *  nothing when nothing is known, and "99+" past ninety-nine. */
export function waitingText(total: WaitingTotal): string {
  // Never more than three characters, so the control keeps one width whatever it counts.
  if (total.min > 99) return "99+";
  if (total.complete) return String(total.min);
  return total.min > 0 ? `${total.min}+` : "";
}

/** The control's name. It starts with exactly the words and the number drawn on it, so a voice command for what is
 *  seen finds it (WCAG 2.5.3). */
export function waitingName(total: WaitingTotal): string {
  return [WAITING_LABEL, waitingText(total)].filter(Boolean).join(" ") + (total.complete ? "" : ", still counting");
}

/** One control, a link to Catch up. The same node is used wherever it is mounted; `updateWaitingButton` redraws it. */
export function buildWaitingButton(doc: Document, href: string, navigate: (href: string, event: MouseEvent) => void): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.className = "cs-waiting";
  link.href = href;
  link.dataset.waitingOpen = "";
  // The rail's own inbox mark (home/rail.css draws it from this class and attribute), so the two read as one thing.
  const mark = doc.createElement("span"); mark.className = "hm-rail__icon"; mark.dataset.icon = "inbox"; mark.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span"); label.className = "cs-waiting__label"; label.textContent = WAITING_LABEL;
  const count = doc.createElement("span"); count.className = "cs-waiting__count"; count.dataset.waitingCount = "";
  link.append(mark, label, count);
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href, event);
  });
  updateWaitingButton(link, { min: 0, complete: false });
  return link;
}

export function updateWaitingButton(link: HTMLElement, total: WaitingTotal): void {
  const count = link.querySelector<HTMLElement>("[data-waiting-count]");
  if (count) count.textContent = waitingText(total);
  // Something is waiting: the control reads as ink, not as chrome.
  link.toggleAttribute("data-waiting", total.min > 0);
  link.setAttribute("aria-label", waitingName(total));
}
