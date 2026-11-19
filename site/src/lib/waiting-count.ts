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
  link.append(mark, label, " ", count);
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href, event);
  });
  link.addEventListener("keydown", (event) => {
    if (event.key !== " " || link.getAttribute("role") !== "button") return;
    event.preventDefault();
    link.click();
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
  link.setAttribute("aria-description", "Count across all workspaces");
  link.title = "Waiting on you across all workspaces";
}

/** In a channel view the control toggles the Waiting on you column or phone sheet; elsewhere it stays a link to Catch up. */
export function syncWaitingButtonToggle(link: HTMLElement, toggle: { active: boolean; expanded: boolean; controlsId: string }): void {
  if (toggle.active) {
    link.setAttribute("role", "button");
    link.setAttribute("aria-expanded", String(toggle.expanded));
    link.setAttribute("aria-controls", toggle.controlsId);
  } else {
    link.removeAttribute("role");
    link.removeAttribute("aria-expanded");
    link.removeAttribute("aria-controls");
  }
}

export interface WaitingParticipantRef {
  kind: "user" | "agent";
  id: string;
}

export interface DirectConversationIndexEntry {
  conversationId: string;
  kind: "dm" | "group_dm";
}

/**
 * Canonical sorted unique key for a DM or group DM's participant set so asks from the same sender
 * in a 1:1 DM vs. a 3+ member group DM never collide even before conversation_id is attached.
 */
export function conversationParticipantKey(participants: readonly WaitingParticipantRef[]): string {
  const keys = new Set<string>();
  for (const p of participants) {
    const id = p.id.trim().toLowerCase();
    if (!id) continue;
    keys.add(`${p.kind}:${id}`);
  }
  return [...keys].sort().join("|");
}

/**
 * Maps canonical participant keys to unique direct conversations (`dm` / `group_dm`).
 * If two generations share the exact same member roster, the key maps to `null` (ambiguous) so
 * legacy signals without an explicit `conversationId` never guess the wrong generation.
 */
export function indexDirectConversations(
  conversations: readonly {
    conversationId: string;
    kind: string;
    members: readonly { kind: "user" | "agent"; id: string; leftAt?: string | null }[];
  }[],
): Map<string, DirectConversationIndexEntry | null> {
  const out = new Map<string, DirectConversationIndexEntry | null>();
  for (const conv of conversations) {
    if (conv.kind !== "dm" && conv.kind !== "group_dm") continue;
    const key = conversationParticipantKey(conv.members);
    if (!key) continue;
    if (out.has(key)) {
      out.set(key, null);
    } else {
      out.set(key, { conversationId: conv.conversationId.toLowerCase(), kind: conv.kind });
    }
  }
  return out;
}

export type WaitingConversation =
  | { kind: "channel"; channelId: string }
  | { kind: "general" }
  | {
    kind: "dm";
    partnerKind: "person" | "agent";
    partnerId: string;
    conversationId?: string;
    participantKey?: string;
  }
  | {
    kind: "group_dm";
    conversationId?: string;
    participantKey: string;
  }
  | { kind: "unknown" };

export interface WaitingSignalPlacement {
  channelId: string | null;
  to: string | null;
  toAgent: string | null;
  threadRootId: string | null;
  from: string;
  fromKind: string;
  conversationId?: string | null;
  recipients?: readonly WaitingParticipantRef[];
}

export interface ClassifyAskOptions {
  directByParticipantKey?: ReadonlyMap<string, DirectConversationIndexEntry | null>;
}

function collectParticipants(
  source: Pick<WaitingSignalPlacement, "to" | "toAgent"> & Partial<Pick<WaitingSignalPlacement, "from" | "fromKind" | "recipients">>,
): WaitingParticipantRef[] {
  const seen = new Set<string>();
  const out: WaitingParticipantRef[] = [];
  const push = (kind: "user" | "agent", rawId: string | null | undefined) => {
    const id = rawId?.trim().toLowerCase() ?? "";
    if (!id) return;
    const k = `${kind}:${id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, id });
  };
  if (source.from) push(source.fromKind === "agent" ? "agent" : "user", source.from);
  if (source.recipients && source.recipients.length > 0) {
    for (const r of source.recipients) push(r.kind, r.id);
  } else {
    if (source.to) push("user", source.to);
    if (source.toAgent) push("agent", source.toAgent);
  }
  return out;
}

/**
 * Classifies where an ask lives using the same placement rule as swarm.conversation_placement:
 * - non-null channelId -> named channel
 * - thread reply without channelId -> its root's conversation (unknown if root wasn't read)
 * - null channelId and unaddressed -> #general
 * - null channelId and addressed (or with explicit conversationId) -> 1:1 DM or group DM
 *   (3+ distinct participants or matched group_dm conversation never bleeds into a 1:1 DM)
 * - missing/failed placement lookup -> unknown (never #general)
 */
export function classifyAskConversation(
  loc: WaitingSignalPlacement | null,
  rootLoc: (Pick<WaitingSignalPlacement, "channelId" | "to" | "toAgent"> &
    Partial<Pick<WaitingSignalPlacement, "from" | "fromKind" | "conversationId" | "recipients">>) | null = null,
  options?: ClassifyAskOptions,
): WaitingConversation {
  if (!loc) return { kind: "unknown" };
  if (loc.channelId !== null) return { kind: "channel", channelId: loc.channelId };

  const isUnaddressed = (
    row: Pick<WaitingSignalPlacement, "to" | "toAgent"> & Partial<Pick<WaitingSignalPlacement, "conversationId" | "recipients">>,
  ): boolean =>
    row.to === null &&
    row.toAgent === null &&
    !(row.recipients && row.recipients.length > 0) &&
    !(row.conversationId && row.conversationId.trim() !== "");

  let source: Pick<WaitingSignalPlacement, "to" | "toAgent"> &
    Partial<Pick<WaitingSignalPlacement, "from" | "fromKind" | "conversationId" | "recipients">> = loc;
  let explicitConversationId: string | null = loc.conversationId?.trim() ? loc.conversationId.trim().toLowerCase() : null;

  if (loc.threadRootId !== null) {
    if (!rootLoc) return { kind: "unknown" };
    if (rootLoc.channelId !== null) return { kind: "channel", channelId: rootLoc.channelId };
    if (isUnaddressed(rootLoc)) return { kind: "general" };
    if (rootLoc.conversationId?.trim()) explicitConversationId = rootLoc.conversationId.trim().toLowerCase();
    if (rootLoc.from || (rootLoc.recipients && rootLoc.recipients.length > 0)) {
      source = rootLoc;
    }
  } else if (isUnaddressed(loc)) {
    return { kind: "general" };
  }

  const participants = collectParticipants(source);
  const participantKey = conversationParticipantKey(participants);
  const matched = participantKey ? options?.directByParticipantKey?.get(participantKey) ?? null : null;
  const conversationId = explicitConversationId ?? matched?.conversationId;

  if (participants.length >= 3 || matched?.kind === "group_dm") {
    return {
      kind: "group_dm",
      ...(conversationId ? { conversationId } : {}),
      participantKey,
    };
  }
  if (!loc.from && !conversationId) return { kind: "unknown" };
  const includeParticipantKey =
    Boolean(participantKey) &&
    (source.recipients !== undefined || explicitConversationId !== null || matched !== null);
  return {
    kind: "dm",
    partnerKind: loc.fromKind === "agent" ? "agent" : "person",
    partnerId: loc.from,
    ...(conversationId ? { conversationId } : {}),
    ...(includeParticipantKey ? { participantKey } : {}),
  };
}
