// Home UI: stream decorations (UI-SPEC 3.3, lane W). Small builders plus the pure helpers behind them:
// day dividers, the author line, an open ask in place, file cards and to-do cards. Builders are pure DOM and
// put user text in through textContent only. Nothing here claims who can see a message.
import { formatFileSize } from "./file-list";
import type { AgentVM, NeedsYouVM, ObjectCardVM, PersonVM } from "./home-types";
import { agentOrb, needsYouCard, objectCard, personAvatar } from "./home-primitives";

export type StreamAuthor = PersonVM | AgentVM;

/** One file on a message, already resolved to a link by the caller. */
export interface StreamAttachmentVM { fileId: string; versionN: number; name: string; contentType: string; sizeBytes: number; href: string }

/** One message as the decorations need it. The author arrives resolved; `when` arrives formatted. */
export interface StreamSignalVM {
  id: string; kind: string; body: string; about: string | null; createdAt: string; when: string;
  author: StreamAuthor;
  /** The viewer is the addressee (a directed ask), measured by the caller from the signal's recipient. */
  addressedToViewer: boolean;
  /** A reply to the ask already exists. */
  answered: boolean;
  attachments: StreamAttachmentVM[];
}

/** A to-do the caller knows about, so a `todo:<uuid>` reference can render as a card. */
export interface StreamTodoRefVM { id: string; title: string; href: string; meta: string; who: StreamAuthor | null; done: boolean }

export interface StreamContext { workspace: { id: string; name: string; href: string }; todos: ReadonlyMap<string, StreamTodoRefVM> }
export interface StreamExtrasVM { ask: NeedsYouVM | null; attachments: ObjectCardVM[]; todo: ObjectCardVM | null }

export type StreamRow<T> = { type: "divider"; key: string; label: string } | { type: "item"; item: T };

export const ASK_EXCERPT_MAX = 160;

export function isAgentAuthor(author: StreamAuthor): author is AgentVM { return "state" in author; }

/** The name shown beside the author's picture. Agent labels arrive already computed in AgentVM.label. */
export function authorLabel(author: StreamAuthor): string { return isAgentAuthor(author) ? author.label : author.name; }

function dayParts(ms: number, timeZone?: string): { y: number; m: number; d: number } | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const y = pick("year"), m = pick("month"), d = pick("day");
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? { y, m, d } : null;
}
const dayNumber = (p: { y: number; m: number; d: number }): number => Date.UTC(p.y, p.m - 1, p.d) / 86_400_000;

/** A sortable calendar-day key for one timestamp in one time zone, or null when the timestamp is not a date. */
export function dayKey(iso: string, timeZone?: string): string | null {
  const p = dayParts(Date.parse(iso), timeZone);
  return p ? `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : null;
}

/** "Today", "Yesterday", then a short date (the year appears only when it differs from now's). Null for a non-date. */
export function dayDividerLabel(iso: string, now: number, locale: string, timeZone?: string): string | null {
  const then = dayParts(Date.parse(iso), timeZone), today = dayParts(now, timeZone);
  if (!then || !today) return null;
  const apart = dayNumber(today) - dayNumber(then);
  if (apart === 0) return "Today";
  if (apart === 1) return "Yesterday";
  return new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric", ...(then.y === today.y ? {} : { year: "numeric" }) }).format(new Date(Date.parse(iso)));
}

/** Inserts a divider before the first message of each calendar day, in the order given. A message with no date gets none. */
export function groupByDay<T extends { createdAt: string }>(items: readonly T[], now: number, locale: string, timeZone?: string): StreamRow<T>[] {
  const rows: StreamRow<T>[] = []; let previous: string | null = null;
  for (const item of items) {
    const key = dayKey(item.createdAt, timeZone), label = key ? dayDividerLabel(item.createdAt, now, locale, timeZone) : null;
    if (key && label && key !== previous) { rows.push({ type: "divider", key, label }); previous = key; }
    rows.push({ type: "item", item });
  }
  return rows;
}

const TODO_ABOUT_RE = /^todo:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** The to-do id in an `about` of the form `todo:<uuid>`, lower-cased; null for anything else. */
export function todoIdFromAbout(about: string | null): string | null { return about ? TODO_ABOUT_RE.exec(about)?.[1]?.toLowerCase() ?? null : null; }

/** The to-do object card for a reference whose to-do is known. An unknown to-do adds nothing. */
export function streamTodoCard(about: string | null, todos: ReadonlyMap<string, StreamTodoRefVM>): ObjectCardVM | null {
  const id = todoIdFromAbout(about); const todo = id ? todos.get(id) : undefined;
  return todo ? { kind: "todo", id: todo.id, title: todo.title, href: todo.href, meta: todo.meta, who: todo.who, ...(todo.done ? { done: true } : {}) } : null;
}

/** A file attachment as an object card. */
export function streamFileCard(file: StreamAttachmentVM, who: StreamAuthor | null = null): ObjectCardVM {
  return { kind: "file", id: file.fileId, title: file.name, href: file.href, meta: formatFileSize(file.sizeBytes), who };
}

/** One line of the message for a card: whitespace collapsed, cut on a character boundary. */
export function askExcerpt(body: string, max = ASK_EXCERPT_MAX): string {
  const flat = Array.from(body.replace(/\s+/gu, " ").trim());
  return flat.length > max ? `${flat.slice(0, max - 1).join("").trimEnd()}…` : flat.join("");
}

/** True only for an ask addressed to the viewer that nobody has answered yet. */
export function isOpenAskToViewer(signal: Pick<StreamSignalVM, "kind" | "addressedToViewer" | "answered">): boolean {
  return signal.kind === "ask" && signal.addressedToViewer && !signal.answered;
}

/** The needs-you card for an open ask to the viewer; null otherwise. The only action is Reply. */
export function streamAskCard(signal: StreamSignalVM, workspace: StreamContext["workspace"]): NeedsYouVM | null {
  if (!isOpenAskToViewer(signal)) return null;
  const who = isAgentAuthor(signal.author) ? signal.author.label : signal.author.firstName;
  return { id: signal.id, kind: "ask", workspace, from: signal.author, what: `${who} asked you: ‘${askExcerpt(signal.body)}’`, when: signal.when,
    primary: { label: "Reply", action: "reply" } };
}

/** Everything extra one message gets beside its text. */
export function deriveStreamExtras(signal: StreamSignalVM, context: StreamContext): StreamExtrasVM {
  return { ask: streamAskCard(signal, context.workspace), attachments: signal.attachments.map((file) => streamFileCard(file, signal.author)),
    todo: streamTodoCard(signal.about, context.todos) };
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A divider row for the message list. */
export function buildDayDivider(doc: Document, label: string, key?: string): HTMLElement {
  const row = node(doc, "li", "hm-day"); row.dataset.dayDivider = key ?? label;
  row.append(node(doc, "span", "hm-day__label", label)); return row;
}

/** Picture sizes on the stream (Space.dc.html): 36 px for a message, 28 px for a reply inside a thread. */
export type StreamAvatarSize = 28 | 36;

/** Author line: picture (an agent shows its orb with the owner badge), name, and when. */
export function buildAuthorLine(doc: Document, signal: Pick<StreamSignalVM, "author" | "when" | "createdAt">, size: StreamAvatarSize = 28): HTMLElement {
  const line = node(doc, "div", "hm-author"); const author = signal.author;
  line.dataset.authorKind = isAgentAuthor(author) ? "agent" : "person";
  line.append(isAgentAuthor(author) ? agentOrb(doc, author, { size, badge: true }) : personAvatar(doc, author, size));
  const name = node(doc, "span", "hm-author__name", authorLabel(author)); name.title = authorLabel(author); line.append(name);
  if (!isAgentAuthor(author) && author.you) line.append(node(doc, "span", "hm-author__you", "you"));
  const time = node(doc, "time", "hm-author__when", signal.when);
  if (Number.isFinite(Date.parse(signal.createdAt))) time.dateTime = signal.createdAt;
  line.append(time); return line;
}

/** The cards that sit under a message's text, or null when it gets none. */
export function buildStreamExtras(doc: Document, extras: StreamExtrasVM, onAction: (action: string, ask: NeedsYouVM) => void): HTMLElement | null {
  if (!extras.ask && extras.attachments.length === 0 && !extras.todo) return null;
  const box = node(doc, "div", "hm-extras"); box.dataset.streamExtras = "";
  if (extras.ask) { const slot = node(doc, "div", "hm-extras__ask"); slot.dataset.streamAsk = extras.ask.id; slot.append(needsYouCard(doc, extras.ask, onAction)); box.append(slot); }
  if (extras.todo) { const slot = node(doc, "div", "hm-extras__object"); slot.dataset.streamTodo = extras.todo.id; slot.append(objectCard(doc, extras.todo)); box.append(slot); }
  if (extras.attachments.length) {
    const list = node(doc, "div", "hm-extras__files"); list.dataset.streamFiles = String(extras.attachments.length);
    for (const file of extras.attachments) { const slot = node(doc, "div", "hm-extras__object"); slot.append(objectCard(doc, file)); list.append(slot); }
    box.append(list);
  }
  return box;
}
