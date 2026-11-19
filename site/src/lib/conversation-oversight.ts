/**
 * Read-only owner oversight for one owned agent on `?agent=<id>` (Step 3D-3).
 *
 * Strictly isolated from personal Direct messages, `#general`, unread/mention counts,
 * read marks, composer state, and Realtime member state. Pure DOM: every untrusted
 * string enters only through `textContent`.
 */
import { GENERAL_CHANNEL_SLUG, channelLabel } from "./channels";
import {
  CONVERSATION_UNAVAILABLE_TEXT,
  parseOversightListResponse,
  type ConversationCursor,
  type ConversationMemberRef,
  type OversightConversationSummary,
} from "./conversations";

export interface OversightMessage {
  id: string;
  from: string;
  fromKind: "user" | "agent";
  body: string;
  createdAt: string;
}

export type OversightListOutcome =
  | { status: "ready"; conversations: OversightConversationSummary[] }
  | { status: "not_found"; message: string }
  | { status: "unsupported"; message: string }
  | { status: "failed"; message: string };

const UNSUPPORTED_OVERSIGHT_ERRORS = new Set([
  "invalid_request",
  "invalid_resource",
  "unsupported_resource",
]);

function errorSentence(body: Record<string, unknown>, fallback: string): string {
  for (const key of ["message", "reason"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

/**
 * Classifies `POST /functions/v1/read` (`resource: "conversation_oversight"`).
 * - 200 with valid array -> ready (fail-closed if any row is malformed).
 * - 404 or `conversation_not_found` -> uniform non-oracle not_found.
 * - 400 with pre-Step-2b unsupported error -> unsupported (hides quietly on older servers).
 * - Anything else -> failed (shows Retry).
 */
export function parseOversightListOutcome(
  status: number,
  body: Record<string, unknown>,
): OversightListOutcome {
  if (status === 404 || body.error === "conversation_not_found") {
    return { status: "not_found", message: CONVERSATION_UNAVAILABLE_TEXT };
  }
  if (status === 200) {
    if (!Array.isArray(body.conversations)) {
      return { status: "failed", message: "Could not load agent conversations." };
    }
    const conversations = parseOversightListResponse(body);
    if (conversations.length !== body.conversations.length) {
      return { status: "failed", message: "Could not load agent conversations." };
    }
    return { status: "ready", conversations };
  }
  const code = typeof body.error === "string" ? body.error : "";
  if (status === 400 && UNSUPPORTED_OVERSIGHT_ERRORS.has(code)) {
    return { status: "unsupported", message: errorSentence(body, "Agent conversations are not available yet.") };
  }
  return { status: "failed", message: errorSentence(body, "Could not load agent conversations.") };
}

export interface OversightScopePin {
  viewerUserId: string;
  workspaceId: string;
  agentPrincipalId: string;
  requestGen: number;
}

export function oversightPinMatches(a: OversightScopePin | null, b: OversightScopePin | null): boolean {
  if (!a || !b) return false;
  return (
    a.viewerUserId === b.viewerUserId &&
    a.workspaceId === b.workspaceId &&
    a.agentPrincipalId === b.agentPrincipalId &&
    a.requestGen === b.requestGen
  );
}

export interface OversightPanelState {
  pin: OversightScopePin | null;
  listStatus: "idle" | "loading" | "ready" | "not_found" | "unsupported" | "failed";
  listError: string;
  conversations: OversightConversationSummary[];
  selectedId: string | null;
  historyStatus: "idle" | "loading" | "ready" | "not_found" | "failed";
  historyError: string;
  historyConversation: OversightConversationSummary | null;
  messages: OversightMessage[];
  hasMore: boolean;
  nextBefore: ConversationCursor | null;
  loadingOlder: boolean;
  olderError: string;
  /** On phone, tracks whether the detail reader is open over the list. */
  phoneDetailOpen: boolean;
}

export function createInitialOversightState(): OversightPanelState {
  return {
    pin: null,
    listStatus: "idle",
    listError: "",
    conversations: [],
    selectedId: null,
    historyStatus: "idle",
    historyError: "",
    historyConversation: null,
    messages: [],
    hasMore: false,
    nextBefore: null,
    loadingOlder: false,
    olderError: "",
    phoneDetailOpen: false,
  };
}

/**
 * Tears down all client-held oversight conversations, messages, cursors, pin, and errors
 * so any in-flight responses are discarded and re-entering the same agent starts fresh.
 */
export function teardownOversightState(_state: OversightPanelState, _nextGen: number): OversightPanelState {
  return createInitialOversightState();
}

/**
 * Retires a conversation after an authoritative server refusal (`404 conversation_not_found`)
 * from either the first history page or `Load older messages`: removes the denied row from the
 * list and clears its transcript, cursor, and member summary so no denied details remain on screen.
 */
export function retireRefusedOversightConversation(
  state: OversightPanelState,
  conversationId: string,
): OversightPanelState {
  return {
    ...state,
    conversations: state.conversations.filter(c => c.conversationId !== conversationId),
    selectedId: conversationId,
    historyStatus: "not_found",
    historyError: CONVERSATION_UNAVAILABLE_TEXT,
    historyConversation: null,
    messages: [],
    hasMore: false,
    nextBefore: null,
    loadingOlder: false,
    olderError: "",
  };
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "Direct message";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Human-readable title for an oversight conversation, from the watched agent's perspective. */
export function oversightConversationTitle(
  conv: Pick<OversightConversationSummary, "kind" | "slug" | "members">,
  agentPrincipalId: string,
  lookupName?: (member: ConversationMemberRef) => string | null | undefined,
): string {
  if (conv.kind === "general") return channelLabel(GENERAL_CHANNEL_SLUG);
  if (conv.kind === "public_channel" || conv.kind === "private_channel") {
    return conv.slug ? channelLabel(conv.slug) : "Channel";
  }
  const agentId = agentPrincipalId.toLowerCase();
  const live = conv.members.filter(m => !m.leftAt);
  const others = live.filter(m => !(m.kind === "agent" && m.id.toLowerCase() === agentId));
  if (others.length === 0) return "Notes to self";
  const names = others.map(m => {
    const resolved = (m.name ?? lookupName?.(m) ?? "").trim();
    return resolved || (m.kind === "agent" ? "Agent" : "Member");
  });
  return joinNames(names);
}

/** Live member summary line for group DMs in the read-only header. */
export function oversightMemberSummary(
  conv: Pick<OversightConversationSummary, "kind" | "members">,
  lookupName?: (member: ConversationMemberRef) => string | null | undefined,
): string {
  if (conv.kind !== "group_dm") return "";
  const live = conv.members.filter(m => !m.leftAt);
  if (live.length === 0) return "";
  const names = live.map(m => {
    const resolved = (m.name ?? lookupName?.(m) ?? "").trim();
    return resolved || (m.kind === "agent" ? "Agent" : "Member");
  });
  return `${live.length} members · ${names.join(", ")}`;
}

/** Newest-activity first, with conversationId as a deterministic tiebreak. */
export function sortOversightConversations(
  list: readonly OversightConversationSummary[],
): OversightConversationSummary[] {
  return [...list].sort((left, right) => {
    const a = left.lastMessageAt ?? "";
    const b = right.lastMessageAt ?? "";
    if (a !== b) return a > b ? -1 : 1;
    return left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0;
  });
}

/** Merges paged oversight messages, deduplicating by id and sorting oldest-first. */
export function mergeOversightMessages(
  existing: readonly OversightMessage[],
  incoming: readonly OversightMessage[],
): OversightMessage[] {
  const byId = new Map<string, OversightMessage>();
  for (const msg of existing) byId.set(msg.id.toLowerCase(), msg);
  for (const msg of incoming) byId.set(msg.id.toLowerCase(), msg);
  return [...byId.values()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    const a = left.id.toLowerCase();
    const b = right.id.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function cursorsEqual(a: ConversationCursor | null, b: ConversationCursor | null): boolean {
  if (!a || !b) return false;
  return a.createdAt === b.createdAt && a.id.toLowerCase() === b.id.toLowerCase();
}

export interface OversightPanelVM {
  agentId: string;
  agentName: string;
  state: OversightPanelState;
  formatTime: (iso: string) => string;
  resolveMemberName: (member: ConversationMemberRef) => string;
}

export interface OversightPanelCallbacks {
  onSelect: (conversationId: string) => void;
  onRetryList: () => void;
  onRetryHistory: () => void;
  onLoadOlder: () => void;
  onPhoneBack: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders the read-only Agent Oversight section inside `host`.
 * Zero composer, zero mark-read, zero star/notify/membership controls.
 */
export function renderOversightPanel(
  host: HTMLElement,
  vm: OversightPanelVM,
  callbacks: OversightPanelCallbacks,
): void {
  const { state } = vm;
  if (state.listStatus === "idle" || state.listStatus === "unsupported") {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  const doc = host.ownerDocument;
  const section = el(doc, "section", "cs-oversight");
  section.dataset.oversightPanel = vm.agentId;
  section.dataset.oversightReadonly = "true";
  section.dataset.oversightPhoneDetail = String(state.phoneDetailOpen && state.selectedId !== null);
  section.setAttribute("aria-labelledby", "cs-oversight-title");

  // Header: clearly names the agent and marks oversight read-only.
  const header = el(doc, "header", "cs-oversight__head");
  const title = el(doc, "h2", "cs-oversight__title", `${vm.agentName}’s conversations`);
  title.id = "cs-oversight-title";
  const badge = el(doc, "span", "cs-oversight__badge", "Read-only");
  badge.dataset.oversightBadge = "";
  header.append(title, badge);
  section.append(header);

  if (state.listStatus === "loading") {
    const p = el(doc, "p", "cs-oversight__state", "Loading conversations…");
    p.dataset.oversightState = "loading";
    section.append(p);
    host.replaceChildren(section);
    return;
  }

  if (state.listStatus === "not_found") {
    const p = el(doc, "p", "cs-oversight__state", CONVERSATION_UNAVAILABLE_TEXT);
    p.dataset.oversightState = "unavailable";
    section.append(p);
    host.replaceChildren(section);
    return;
  }

  if (state.listStatus === "failed") {
    const box = el(doc, "div", "cs-oversight__error-box");
    box.dataset.oversightState = "failed";
    const p = el(doc, "p", "cs-oversight__state", state.listError || "Could not load agent conversations.");
    p.setAttribute("role", "alert");
    const retry = el(doc, "button", "cs-oversight__action", "Retry");
    retry.type = "button";
    retry.dataset.oversightRetryList = "";
    retry.addEventListener("click", () => callbacks.onRetryList());
    box.append(p, retry);
    section.append(box);
    host.replaceChildren(section);
    return;
  }

  if (state.conversations.length === 0) {
    if (state.historyStatus === "not_found") {
      const p = el(doc, "p", "cs-oversight__state", CONVERSATION_UNAVAILABLE_TEXT);
      p.dataset.oversightHistoryState = "unavailable";
      section.append(p);
      host.replaceChildren(section);
      return;
    }
    const p = el(doc, "p", "cs-oversight__state", `No conversations for ${vm.agentName} yet.`);
    p.dataset.oversightState = "empty";
    section.append(p);
    host.replaceChildren(section);
    return;
  }

  const body = el(doc, "div", "cs-oversight__body");

  // Left pane: list of agent conversations (read-only selection buttons).
  const listPane = el(doc, "div", "cs-oversight__list-pane");
  const list = el(doc, "ul", "cs-oversight__list");
  list.dataset.oversightList = "";
  for (const conv of state.conversations) {
    const item = el(doc, "li", "cs-oversight__list-item");
    const btn = el(doc, "button", "cs-oversight__row");
    btn.type = "button";
    btn.dataset.oversightConv = conv.conversationId;
    const isSelected = state.selectedId === conv.conversationId;
    if (isSelected) btn.setAttribute("aria-current", "true");
    const convTitle = oversightConversationTitle(conv, vm.agentId, vm.resolveMemberName);
    const nameEl = el(doc, "span", "cs-oversight__row-title", convTitle);
    const metaParts: string[] = [];
    if (conv.kind === "group_dm") {
      const liveCount = conv.members.filter(m => !m.leftAt).length;
      if (liveCount > 0) metaParts.push(`${liveCount} members`);
    }
    if (conv.lastMessageAt) {
      const formatted = vm.formatTime(conv.lastMessageAt);
      if (formatted) metaParts.push(formatted);
    }
    btn.append(nameEl);
    if (metaParts.length > 0) {
      btn.append(" ", el(doc, "span", "cs-oversight__row-meta", metaParts.join(" · ")));
    }
    btn.addEventListener("click", () => callbacks.onSelect(conv.conversationId));
    item.append(btn);
    list.append(item);
  }
  listPane.append(list);

  // Right pane: read-only conversation history viewer.
  const detailPane = el(doc, "div", "cs-oversight__detail");
  detailPane.dataset.oversightDetail = "";
  detailPane.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.phoneDetailOpen) return;
    event.preventDefault();
    event.stopPropagation();
    callbacks.onPhoneBack();
  });

  const selectedSummary =
    state.historyConversation ??
    state.conversations.find(c => c.conversationId === state.selectedId) ??
    null;

  if (!state.selectedId) {
    detailPane.append(el(doc, "p", "cs-oversight__state", "Select a conversation to read."));
  } else if (state.historyStatus === "not_found") {
    const detailHead = el(doc, "div", "cs-oversight__detail-head cs-oversight__detail-head--back-only");
    const backBtn = el(doc, "button", "cs-oversight__back", "Back");
    backBtn.type = "button";
    backBtn.dataset.oversightBack = "";
    backBtn.addEventListener("click", () => callbacks.onPhoneBack());
    detailHead.append(backBtn);
    const box = el(doc, "div", "cs-oversight__error-box");
    box.dataset.oversightHistoryState = "unavailable";
    const msg = el(doc, "p", "cs-oversight__state", CONVERSATION_UNAVAILABLE_TEXT);
    msg.tabIndex = -1;
    msg.dataset.oversightDetailTitle = "";
    box.append(msg);
    detailPane.append(detailHead, box);
  } else {
    const detailHead = el(doc, "div", "cs-oversight__detail-head");
    const backBtn = el(doc, "button", "cs-oversight__back", "Back");
    backBtn.type = "button";
    backBtn.dataset.oversightBack = "";
    backBtn.addEventListener("click", () => callbacks.onPhoneBack());

    const headCopy = el(doc, "div", "cs-oversight__detail-copy");
    const detailTitleText = selectedSummary
      ? oversightConversationTitle(selectedSummary, vm.agentId, vm.resolveMemberName)
      : "Conversation";
    const detailTitle = el(doc, "h3", "cs-oversight__detail-title", detailTitleText);
    detailTitle.tabIndex = -1;
    detailTitle.dataset.oversightDetailTitle = "";
    headCopy.append(detailTitle);
    const memberLine = selectedSummary ? oversightMemberSummary(selectedSummary, vm.resolveMemberName) : "";
    if (memberLine) headCopy.append(el(doc, "p", "cs-oversight__detail-meta", memberLine));

    detailHead.append(backBtn, headCopy);
    detailPane.append(detailHead);

    if (state.historyStatus === "loading") {
      const p = el(doc, "p", "cs-oversight__state", "Loading messages…");
      p.dataset.oversightHistoryState = "loading";
      detailPane.append(p);
    } else if (state.historyStatus === "failed") {
      const box = el(doc, "div", "cs-oversight__error-box");
      box.dataset.oversightHistoryState = "failed";
      const p = el(doc, "p", "cs-oversight__state", state.historyError || "Could not load messages.");
      p.setAttribute("role", "alert");
      const retry = el(doc, "button", "cs-oversight__action", "Retry");
      retry.type = "button";
      retry.dataset.oversightRetryHistory = "";
      retry.addEventListener("click", () => callbacks.onRetryHistory());
      box.append(p, retry);
      detailPane.append(box);
    } else {
      const transcript = el(doc, "div", "cs-oversight__transcript");
      transcript.dataset.oversightTranscript = "";

      if (state.hasMore && state.nextBefore) {
        const olderWrap = el(doc, "div", "cs-oversight__older");
        const olderBtn = el(
          doc,
          "button",
          "cs-oversight__action",
          state.loadingOlder ? "Loading older…" : "Load older messages",
        );
        olderBtn.type = "button";
        olderBtn.dataset.oversightLoadOlder = "";
        if (state.loadingOlder) olderBtn.setAttribute("aria-disabled", "true");
        olderBtn.addEventListener("click", () => {
          if (!state.loadingOlder) callbacks.onLoadOlder();
        });
        olderWrap.append(olderBtn);
        if (state.olderError) {
          const err = el(doc, "p", "cs-oversight__error", state.olderError);
          err.setAttribute("role", "alert");
          olderWrap.append(err);
        }
        transcript.append(olderWrap);
      }

      if (state.messages.length === 0) {
        const p = el(doc, "p", "cs-oversight__state", "No messages yet.");
        p.dataset.oversightHistoryState = "empty";
        transcript.append(p);
      } else {
        const msgList = el(doc, "ol", "cs-oversight__messages");
        msgList.dataset.oversightMessages = "";
        for (const msg of state.messages) {
          const row = el(doc, "li", "cs-oversight__message");
          row.dataset.oversightMessage = msg.id;
          const byline = el(doc, "div", "cs-oversight__message-head");
          const fromId = msg.from.toLowerCase();
          const summaryMember = selectedSummary?.members.find(
            m => m.kind === msg.fromKind && m.id.toLowerCase() === fromId,
          );
          const sender = summaryMember?.name?.trim() || vm.resolveMemberName({ kind: msg.fromKind, id: msg.from });
          byline.append(el(doc, "span", "cs-oversight__message-sender", sender));
          const when = el(doc, "time", "cs-oversight__message-time", vm.formatTime(msg.createdAt));
          if (Number.isFinite(Date.parse(msg.createdAt))) when.dateTime = msg.createdAt;
          byline.append(" ", when);
          const text = el(doc, "p", "cs-oversight__message-body", msg.body);
          row.append(byline, text);
          msgList.append(row);
        }
        transcript.append(msgList);
      }

      detailPane.append(transcript);
    }
  }

  body.append(listPane, detailPane);
  section.append(body);
  host.replaceChildren(section);
}
