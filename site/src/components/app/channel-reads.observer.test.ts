import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import {
  CHANNEL_READ_RETRY_MS, CONTINUE_LOADING_LABEL, MARK_ALL_AS_READ_LABEL, MARK_AS_READ_LABEL, UNREAD_DIVIDER_LABEL,
  UNREAD_JUMP_PAGES, channelReadRowFor, firstUnreadOlderThanLoaded, newestChannelMessage, oldestChannelMessage,
  readChannelIdOf, newestMarkableChannelMessage, unreadJumpLabel, withChannelRead,
} from "../../lib/channel-reads";
import { GENERAL_CHANNEL_ID, channelUnreadFor } from "../../lib/channels";
import { buildWorkspaceMenu } from "../../lib/home-shell";

/*
 * Read positions in the chat: the real dashboard functions run against a small fake DOM. Only the network
 * (markChannelRead, the unread re-read and older pages) and the rail's paint are stand-ins.
 */

const READ_FUNCTIONS = [
  "channelReadViewId", "channelReadVisitKey", "applyChannelRead", "sendChannelRead", "channelReadTarget", "noteVisitMarked",
  "feedRowFor", "firstUnreadPlace", "paintUnreadDivider", "changeUnreadDivider", "renderUnreadBar", "dismissUnreadBar",
  "markViewRead", "autoMarkChannelRead", "syncChannelRead", "revealFeedRow", "jumpToFirstUnread", "channelReadMenuState",
  "channelReadEscape", "openChannelRowMenu", "closeReceiptsOnEscape", "feedMenuAction",
];

async function dashboardFunctions(names: string[]): Promise<string> {
  const raw = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      found.set(node.name.text, `const ${node.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  return ts.transpileModule(names.map(name => found.get(name)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/* ---- A fake DOM: a tree, attributes (dataset is data-*), events, focus, geometry and a small selector engine. ---- */
type Rect = { top: number; bottom: number; height: number };
type Listener = (event: any) => void;
class FakeNode {
  children: FakeNode[] = []; parent: FakeNode | null = null; textContent = ""; className = ""; hidden = false;
  attributes = new Map<string, string>(); listeners = new Map<string, Listener[]>(); rect: Rect = { top: 100, bottom: 140, height: 40 };
  selectionStart = 0; selectionEnd = 0; scrollTop = 0; scrollHeight = 2000; value = "";
  dataset: Record<string, string>;
  constructor(readonly tag: string, readonly doc: FakeDocument) {
    const attr = (key: string) => `data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_target, key) => typeof key === "string" ? this.attributes.get(attr(key)) : undefined,
      set: (_target, key, value) => { this.attributes.set(attr(String(key)), String(value)); return true; },
      has: (_target, key) => typeof key === "string" && this.attributes.has(attr(key)),
      deleteProperty: (_target, key) => { this.attributes.delete(attr(String(key))); return true; },
    });
  }
  get parentElement() { return this.parent; }
  get classList() { return { add: (name: string) => { this.className = `${this.className} ${name}`.trim(); } }; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  toggleAttribute(name: string, on: boolean) { if (on) this.attributes.set(name, ""); else this.attributes.delete(name); }
  append(...nodes: FakeNode[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  prepend(...nodes: FakeNode[]) { for (const node of nodes.reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
  insertBefore(node: FakeNode, before: FakeNode) {
    node.remove(); node.parent = this; this.children.splice(this.children.indexOf(before), 0, node);
  }
  remove() {
    if (!this.parent) return;
    if (this.doc.activeElement && this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null;
  }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  descendants(): FakeNode[] { return this.children.flatMap(node => [node, ...node.descendants()]); }
  addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
    const wrapped: Listener = options?.once ? (event) => { this.removeEventListener(type, wrapped); listener(event); } : listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  fire(type: string) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ target: this, preventDefault() {} }); }
  click() { this.fire("click"); }
  focus() {
    const previous = this.doc.activeElement;
    if (previous && previous !== this) previous.fire("blur");
    this.doc.activeElement = this;
  }
  /** The Unread line sits just above the row after it. */
  getBoundingClientRect(): Rect {
    if (this.attributes.has("data-unread-divider") && this.parent) {
      const next = this.parent.children[this.parent.children.indexOf(this) + 1];
      if (next) { const top = next.getBoundingClientRect().top - 40; return { top, bottom: top + 40, height: 40 }; }
    }
    return this.rect;
  }
  matches(selector: string): boolean { return selector.split(",").some(part => matchesChain(this, part.trim().split(/\s+/))); }
  closest(selector: string): FakeNode | null { for (let node: FakeNode | null = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector: string): FakeNode[] { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null; }
}
const matchesCompound = (node: FakeNode, compound: string): boolean => {
  for (const [token] of compound.matchAll(/^[a-z]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/gu)) {
    if (token.startsWith(".")) { if (!node.className.split(" ").includes(token.slice(1))) return false; }
    else if (token.startsWith("[")) {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/u.exec(token)!;
      if (!node.attributes.has(name!) || (value !== undefined && node.attributes.get(name!) !== value)) return false;
    } else if (node.tag !== token) return false;
  }
  return true;
};
const matchesChain = (node: FakeNode, chain: string[]): boolean => {
  if (!matchesCompound(node, chain.at(-1)!)) return false;
  let rest = chain.slice(0, -1);
  for (let ancestor = node.parent; ancestor && rest.length; ancestor = ancestor.parent) {
    if (matchesCompound(ancestor, rest.at(-1)!)) rest = rest.slice(0, -1);
  }
  return rest.length === 0;
};
class FakeDocument {
  activeElement: FakeNode | null = null; focused = true; visibilityState = "visible"; selectionCollapsed = true;
  root: FakeNode; body: FakeNode;
  constructor() { this.root = new FakeNode("html", this); this.body = new FakeNode("body", this); this.root.append(this.body); this.activeElement = this.body; }
  createElement(tag: string) { return new FakeNode(tag, this); }
  querySelector(selector: string) { return this.root.querySelector(selector); }
  hasFocus() { return this.focused; }
  getSelection() { return { isCollapsed: this.selectionCollapsed }; }
}

const VIEWER = "viewer";
type Message = { id: string; from: string; fromKind: string; to: string | null; toAgent: string | null; createdAt: string;
  channelId: string | null; threadRootId: string | null; broadcastToChannel: boolean };
/** Message ids are server ids (UUIDs); tests name them ("m3") and U gives the id, NAMES the name back. */
const NAMES = new Map<string, string>();
const U = (name: string): string => {
  const id = `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0").slice(-12)}`;
  NAMES.set(id, name);
  return id;
};
const message = (name: string, minute: number, extra: Partial<Message> = {}): Message => ({
  id: U(name), from: "dana", fromKind: "user", to: null, toAgent: null, createdAt: `2026-11-16T10:${String(minute).padStart(2, "0")}:00Z`,
  channelId: "c1", threadRootId: null, broadcastToChannel: false, ...extra,
});
const unreadRow = (extra: Record<string, unknown> = {}) => ({
  channelId: "c1", slug: "design", unread: true, starred: false, starRank: null, involvement: "everything",
  unreadCount: 3, firstUnreadId: U("m3"), firstUnreadAt: "2026-11-16T10:03:00Z", ...extra,
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
type Reply = string | Promise<string> | Error;

async function fixture(options: { sample?: boolean; rows?: unknown[]; signals?: Message[] } = {}) {
  const doc = new FakeDocument();
  const app = doc.createElement("live-dashboard");
  app.dataset.state = "channel"; app.dataset.channelView = "feed";
  const scroller = doc.createElement("section");
  scroller.rect = { top: 0, bottom: 600, height: 600 };
  const bar = doc.createElement("div"); bar.dataset.unreadBar = ""; bar.hidden = true;
  const jump = doc.createElement("button"); jump.dataset.unreadJump = "";
  const mark = doc.createElement("button"); mark.dataset.unreadMark = "";
  bar.append(jump, mark);
  const list = doc.createElement("ol"); list.dataset.feedList = "";
  // The scroller's height follows its rows, 40px each, so a line added or taken away above the screen shows.
  Object.defineProperty(scroller, "scrollHeight", { get: () => list.children.length * 40 });
  const composer = doc.createElement("textarea"); composer.dataset.composerInput = "";
  const mentions = doc.createElement("div"); mentions.dataset.mentionPicker = ""; mentions.hidden = true;
  scroller.append(bar, list); app.append(scroller, composer, mentions); doc.body.append(app);

  const marks: Array<{ id: string; workspaceId: string; target: Record<string, unknown> }> = [];
  let replies: Reply[] = [];
  let ids = 0, refreshes = 0, railPaints = 0, olderLoads = 0, bottom = true;
  let older: Message[][] = [];
  const menus: Array<Array<{ label: string; run: () => void } | null>> = [];
  const context = createContext({
    document: doc, app, HTMLElement: FakeNode, CSS: { escape: (value: string) => value },
    window: {}, Date: { now: () => clock },
    CHANNEL_READ_RETRY_MS, CONTINUE_LOADING_LABEL, MARK_AS_READ_LABEL, UNREAD_DIVIDER_LABEL, UNREAD_JUMP_PAGES,
    GENERAL_CHANNEL_ID, channelReadRowFor, channelUnreadFor, firstUnreadOlderThanLoaded, newestChannelMessage,
    oldestChannelMessage, readChannelIdOf, newestMarkableChannelMessage, unreadJumpLabel, withChannelRead,
    markChannelRead: async (_session: unknown, id: string, workspaceId: string, target: Record<string, unknown>) => {
      // Copied out of the vm's realm, so deepEqual compares values rather than prototypes.
      marks.push({ id, workspaceId, target: JSON.parse(JSON.stringify(target)) });
      const reply = replies.shift() ?? "ok";
      if (reply instanceof Error) throw reply;
      return await reply;
    },
    uuid: () => `command-${++ids}`,
    one: (selector: string) => doc.querySelector(selector),
    all: (selector: string) => doc.root.querySelectorAll(selector),
    feedScroller: () => scroller,
    atBottom: () => bottom,
    scrollToNewest: () => { scroller.scrollTop = scroller.scrollHeight; },
    composerIsReplying: () => false,
    // The re-read after every answer; a test can make it answer and sync, as the page does.
    refreshChannelUnread: async () => { refreshes += 1; await onRefresh(); },
    renderHomeRail: () => { railPaints += 1; }, renderHomeShell: () => {}, renderChannelDirectoryDialog: () => {},
    loadOlderSignals: async () => {
      olderLoads += 1;
      const page = older.shift() ?? [];
      context.signals = [...(context.signals as Message[]), ...page];
      if (!older.length) context.signalHasMore = hasMoreAfterLast;
      paint();
    },
    // The ⋯ menu's other entries (moves and settings) have their own tests.
    channelById: () => null, viewerMayManageChannel: () => false, railOrderListOf: () => null,
    channelLabel: (slug: string) => `#${slug}`, GENERAL_CHANNEL_SLUG: "general",
    openContextMenu: (_event: unknown, _anchor: unknown, entries: Array<{ label: string; run: () => void } | null>) => {
      menus.push(Array.from(entries, entry => entry && { label: entry.label, run: entry.run }));
    },
  });
  let clock = 1_000_000, hasMoreAfterLast = true;
  let onRefresh: () => unknown = () => {};
  runInContext(`
    var sampleMode = ${options.sample ? "true" : "false"}, session = { user: { id: '${VIEWER}' } }, activeWorkspaceId = 'W';
    var homeRoute = { view: 'chat', workspaceId: 'W' }, activeWorkspaceView = 'signals', activeDm = null, unknownChannelId = null;
    var activeChannelId = 'c1', signalFilter = 'all', signalHasMore = true, channels = [];
    var channelUnreadRows = ${JSON.stringify(options.rows ?? [unreadRow()])}, channelUnreadGeneration = 0;
    var channelReadUnsupported = false; const channelReadMarked = new Map(), channelReadRetryAt = new Map(), channelReadRefusedIds = new Set(); var unreadVisit = null;
  `, context);
  context.signals = options.signals ?? [message("m5", 5), message("m4", 4), message("m3", 3), message("m2", 2)];
  runInContext(await dashboardFunctions(READ_FUNCTIONS), context);
  /** The feed's rebuild, reduced to what read positions touch: one row per loaded message, oldest first, each placed
   *  on the screen by `places` (top, in px against a 0..600 screen); then the real divider paint and sync. */
  const places = new Map<string, number>();
  const paint = () => {
    for (const child of [...list.children]) child.remove();
    for (const signal of [...(context.signals as Message[])].reverse()) {
      const row = doc.createElement("li"); row.dataset.signalId = signal.id;
      const top = places.get(NAMES.get(signal.id) ?? signal.id) ?? 500;
      row.rect = { top, bottom: top + 40, height: 40 };
      list.append(row);
    }
    runInContext("paintUnreadDivider()", context);
    runInContext("syncChannelRead()", context);
  };
  const run = (code: string) => runInContext(code, context);
  const keyEvent = (key: string, extra: Record<string, unknown> = {}) => {
    const event = { key, keyCode: 27, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; }, ...extra };
    return event;
  };
  /** One keydown through the page's own document handlers, in their registration order. */
  const key = (key: string, extra: Record<string, unknown> = {}) => {
    const event = keyEvent(key, extra);
    run("closeReceiptsOnEscape")(event);
    run("channelReadEscape")(event);
    return event;
  };
  return {
    doc, app, scroller, list, bar, jump, mark, composer, mentions, marks, menus, run, key, paint, places, context,
    setBottom: (value: boolean) => { bottom = value; },
    setReplies: (next: Reply[]) => { replies = next; },
    setOlder: (pages: Message[][], moreAfter = true) => { older = pages; hasMoreAfterLast = moreAfter; },
    tick: (ms: number) => { clock += ms; },
    setOnRefresh: (next: () => unknown) => { onRefresh = next; },
    refreshes: () => refreshes, railPaints: () => railPaints, olderLoads: () => olderLoads,
    rows: () => run("channelUnreadRows") as Array<Record<string, unknown>>,
    setRows: (rows: unknown[]) => run(`channelUnreadRows = ${JSON.stringify(rows)}`),
    row: (name: string) => list.querySelector(`[data-signal-id="${U(name)}"]`)!,
    divider: () => list.querySelector("[data-unread-divider]"),
    nextAfterDivider: () => { const divider = list.querySelector("[data-unread-divider]")!; return list.children[list.children.indexOf(divider) + 1]; },
  };
}

test("the bottom of an unread channel in a focused tab marks it read through the newest message, once per message", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  f.paint();
  await settle();
  assert.deepEqual(f.marks.map(({ workspaceId, target }) => [workspaceId, target]),
    [["W", { channelId: "c1", throughSignalId: U("m5") }]]);
  assert.equal(f.rows()[0]!.unread, false, "the rail's dot clears at once");
  assert.ok(f.railPaints() > 0);
  assert.equal(f.refreshes(), 1, "the rail is read again after the answer");

  // A re-read that still says unread (it raced the mark) does not send the same accepted mark again.
  f.setRows([unreadRow()]);
  f.paint();
  await settle();
  assert.equal(f.marks.length, 1);

  // A message that arrived during the mark is past the accepted position: it is marked on its own.
  f.context.signals = [message("m6", 6), ...(f.context.signals as Message[])];
  f.paint();
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target.throughSignalId), [U("m5"), U("m6")]);
});

test("nothing is marked while the tab is hidden or unfocused, or the bottom is off screen, or the channel is read", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  f.doc.visibilityState = "hidden"; f.paint();
  f.doc.visibilityState = "visible"; f.doc.focused = false; f.run("syncChannelRead()");
  f.doc.focused = true; f.setBottom(false); f.run("syncChannelRead()");
  f.setBottom(true); f.app.dataset.channelView = "feed-error"; f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 0);
  assert.equal(f.rows()[0]!.unread, true, "the dot stays until the channel is read");
  f.app.dataset.channelView = "feed"; f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 1);

  const read = await fixture({ rows: [unreadRow({ unread: false, unreadCount: 0, firstUnreadId: null, firstUnreadAt: null })] });
  read.paint(); await settle();
  assert.equal(read.marks.length, 0);
});

test("a mark in flight is not sent twice; a failed one is not a read: the dot comes back and it is tried again later", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  let answer!: (outcome: string) => void;
  f.setReplies([new Promise<string>(resolve => { answer = resolve; })]);
  f.paint();
  f.run("syncChannelRead()"); f.run("syncChannelRead()");
  assert.equal(f.marks.length, 1, "pending work is deduplicated");
  answer("channel_not_found");
  await settle();
  assert.equal(f.refreshes(), 1, "a refusal reads the unread state again, so the optimistic clear does not stay");

  f.setRows([unreadRow()]); // what the re-read says
  f.setReplies([new Error("network")]);
  f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 1, "not at once: the view waits before trying again");
  f.tick(CHANNEL_READ_RETRY_MS + 1);
  f.run("syncChannelRead()");
  assert.equal(f.rows()[0]!.unread, true, "a retry leaves the dot until it lands: no flicker while marks keep failing");
  await settle();
  assert.equal(f.marks.length, 2, "then the same message is tried again");
  assert.equal(f.refreshes(), 2, "an unknown result reads the unread state again too");
  f.setRows([unreadRow()]);
  f.tick(CHANNEL_READ_RETRY_MS + 1);
  f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 3);
  assert.deepEqual(f.marks.map(({ target }) => target.throughSignalId), [U("m5"), U("m5"), U("m5")]);
});

/** A mark on view never reaches past what was loaded: every one names a message. */
const assertBounded = (marks: Array<{ target: Record<string, unknown> }>) => {
  for (const { target } of marks) {
    assert.equal(typeof target.throughSignalId, "string", `a mark on view without a message: ${JSON.stringify(target)}`);
  }
};

test("a refused message on view gives way to the next loaded one after the re-read, never to up to now", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  // The re-read after each answer says the channel is still unread, and syncs, as the page does.
  f.setOnRefresh(() => { f.setRows([unreadRow()]); f.run("syncChannelRead()"); });
  f.setReplies(["signal_not_found", "signal_not_found", "ok"]);
  f.paint();
  for (let turn = 0; turn < 5; turn += 1) await settle();
  assert.deepEqual(f.marks.map(({ id, target }) => [id, target]), [
    ["command-1", { channelId: "c1", throughSignalId: U("m5") }],
    ["command-2", { channelId: "c1", throughSignalId: U("m4") }],
    ["command-3", { channelId: "c1", throughSignalId: U("m3") }],
  ]);
  assertBounded(f.marks);

  // Every loaded message refused: nothing is sent and the dot stays.
  const g = await fixture({ signals: [message("m5", 5), message("m4", 4)] });
  g.setOnRefresh(() => { g.setRows([unreadRow()]); g.run("syncChannelRead()"); });
  g.setReplies(["signal_not_found", "signal_not_found"]);
  g.paint();
  for (let turn = 0; turn < 5; turn += 1) await settle();
  assert.equal(g.marks.length, 2);
  assertBounded(g.marks);
  assert.equal(g.rows()[0]!.unread, true, "the dot stays for a later view");
});

test("the person's own addressed message is passed over on view: the mark goes through the newest message they can name", async () => {
  const f = await fixture({ signals: [message("own", 6, { from: VIEWER, to: "dana" }), message("m5", 5), message("m3", 3)] });
  f.places.set("m3", 300);
  f.paint();
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1", throughSignalId: U("m5") }]);

  // Only the person's own addressed messages loaded: there is nothing to mark through, so nothing is sent.
  const only = await fixture({ signals: [message("own2", 6, { from: VIEWER, toAgent: "orbit" }),
    message("own1", 5, { from: VIEWER, recipients: [{ kind: "user", id: "dana" }] } as Partial<Message>)] });
  only.paint();
  only.run("syncChannelRead()");
  await settle();
  assert.equal(only.marks.length, 0);
  assert.equal(only.rows()[0]!.unread, true);
});

test("an explicit Mark as read prefers a loaded message, and only it may fall back to up to now when that is refused", async () => {
  const f = await fixture();
  f.setBottom(false);
  f.paint();
  f.setReplies(["signal_not_found", "ok"]);
  f.run("markViewRead(channelReadViewId())");
  for (let turn = 0; turn < 3; turn += 1) await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [
    { channelId: "c1", throughSignalId: U("m5") },
    { channelId: "c1" },
  ]);
  // The next mark on view skips the refused message.
  f.setRows([unreadRow()]);
  f.setBottom(true);
  f.run("syncChannelRead()");
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { channelId: "c1", throughSignalId: U("m4") });
});

test("the visit keeps its own snapshot: the bar and line stay after the mark and later reads, then drop the stale count", async () => {
  const f = await fixture({ rows: [unreadRow({ unreadCount: 12 })] });
  f.places.set("m3", -400);
  let answer!: (outcome: string) => void;
  f.setReplies([new Promise<string>(resolve => { answer = resolve; })]);
  f.paint();
  assert.equal(f.bar.hidden, false);
  assert.equal(f.jump.textContent, "12 unread · Jump to first unread");
  assert.equal(f.nextAfterDivider(), f.row("m3"), "the Unread line is directly above the first unread message");
  assert.equal(f.divider()!.querySelector(".hm-day__label")?.textContent, "Unread");
  answer("ok");
  await settle();
  assert.equal(f.jump.textContent, "Jump to first unread", "after the visit's mark the count is stale and goes");

  // Later reads (a new arrival elsewhere in the channel) neither erase the visit's target nor move its line.
  f.setRows([unreadRow({ unreadCount: 1, firstUnreadId: U("m6"), firstUnreadAt: "2026-11-16T10:06:00Z" })]);
  f.context.signals = [message("m6", 6), ...(f.context.signals as Message[])];
  f.paint();
  f.setRows([unreadRow({ unread: false, unreadCount: 0, firstUnreadId: null, firstUnreadAt: null })]);
  f.paint();
  assert.equal(f.bar.hidden, false);
  assert.equal(f.nextAfterDivider(), f.row("m3"));

  // Leaving and coming back is a new visit: a fresh snapshot from the read at that time.
  f.run("activeChannelId = 'c2'; syncChannelRead(); activeChannelId = 'c1'");
  f.setRows([unreadRow({ unreadCount: 2, firstUnreadId: U("m4"), firstUnreadAt: "2026-11-16T10:04:00Z" })]);
  f.places.set("m4", -100);
  f.paint();
  assert.equal(f.nextAfterDivider(), f.row("m4"));
  assert.equal(f.jump.textContent, "2 unread · Jump to first unread");
});

test("a server without counts never shows 0 unread, and without a first unread message shows no bar", async () => {
  const noCount = await fixture({ rows: [unreadRow({ unreadCount: 0 })] });
  noCount.setReplies([new Promise<string>(() => {})]);
  noCount.places.set("m3", -400);
  noCount.paint();
  assert.equal(noCount.jump.textContent, "Jump to first unread");

  const old = await fixture({ rows: [unreadRow({ unreadCount: 0, firstUnreadId: null, firstUnreadAt: null })] });
  old.places.set("m3", -400);
  old.paint();
  assert.equal(old.bar.hidden, true);
  assert.equal(old.divider(), null);
});

test("Jump puts the first unread message inside the feed's scrollport and focuses it with a visible ring", async () => {
  const f = await fixture();
  f.places.set("m3", -400);
  f.paint();
  f.composer.value = "half a reply";
  f.scroller.scrollTop = 1000;
  f.jump.focus();
  let composerFocused = false;
  const focusComposer = f.composer.focus.bind(f.composer);
  f.composer.focus = () => { composerFocused = true; focusComposer(); };
  await f.run("jumpToFirstUnread()");
  assert.equal(f.scroller.scrollTop, 1000 + (-440) - 8, "the Unread line above it lands at the top of the scrollport");
  assert.equal(f.doc.activeElement, f.row("m3"), "focus moves to the message");
  assert.equal(composerFocused, false, "never through the composer");
  assert.equal(f.row("m3").dataset.unreadJumped, "", "a visible focus ring");
  f.composer.focus();
  assert.equal(f.row("m3").dataset.unreadJumped, undefined, "the ring goes with the focus");
  assert.equal(f.bar.hidden, true);
  assert.ok(f.divider(), "the Unread line stays for the visit");
  assert.equal(f.olderLoads(), 0, "a loaded message needs no older page");
  assert.equal(f.composer.value, "half a reply", "the draft is untouched");
});

test("Jump loads older pages toward a message above the loaded ones, and offers Continue loading until it is reached", async () => {
  const f = await fixture({ rows: [unreadRow({ firstUnreadId: U("m0"), firstUnreadAt: "2026-11-16T09:00:00Z", unreadCount: 9 })],
    signals: [message("m5", 5), message("m4", 4)] });
  f.paint();
  assert.equal(f.bar.hidden, false, "older than the loaded page is above the screen");
  const pages = Array.from({ length: UNREAD_JUMP_PAGES }, (_, n) => [message(`o${n}`, 0, { createdAt: `2026-11-16T09:5${9 - n}:00Z` })]);
  f.setOlder([...pages, [message("m0", 0, { createdAt: "2026-11-16T09:00:00Z" })]]);
  f.jump.focus();
  await f.run("jumpToFirstUnread()");
  assert.equal(f.olderLoads(), UNREAD_JUMP_PAGES, "a few pages at a time");
  assert.equal(f.bar.hidden, false, "not reached: the bar stays");
  assert.equal(f.jump.textContent, CONTINUE_LOADING_LABEL);
  assert.equal(f.doc.activeElement, f.jump, "focus is not moved to some other message as if the jump had worked");

  await f.run("jumpToFirstUnread()");
  assert.equal(f.olderLoads(), UNREAD_JUMP_PAGES + 1);
  assert.equal(f.doc.activeElement, f.row("m0"), "reached: the message itself");
  assert.equal(f.nextAfterDivider(), f.row("m0"));
  assert.equal(f.bar.hidden, true);

  // Reached by scrolling up instead: there is nothing left to continue, so the bar says Jump again.
  const g = await fixture({ rows: [unreadRow({ firstUnreadId: U("m0"), firstUnreadAt: "2026-11-16T09:00:00Z", unreadCount: 9 })],
    signals: [message("m5", 5), message("m4", 4)] });
  g.setBottom(false);
  g.paint();
  g.setOlder([...pages, [message("m0", 0, { createdAt: "2026-11-16T09:00:00Z" })]]);
  await g.run("jumpToFirstUnread()");
  assert.equal(g.jump.textContent, CONTINUE_LOADING_LABEL);
  g.places.set("m0", -200);
  await g.run("loadOlderSignals()");
  assert.equal(g.bar.hidden, false);
  assert.equal(g.jump.textContent, "9 unread · Jump to first unread");
});

test("a first unread message beyond the page by microseconds or by id alone still shows the bar and is reached", async () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  for (const [name, firstAt, firstId] of [
    ["the same time, a smaller id", "2026-11-16T10:04:00.123456Z", id(1)],
    ["the same millisecond, fewer microseconds", "2026-11-16T10:04:00.123100Z", id(9)],
  ] as const) {
    const floor = message("floor", 4, { id: id(2), createdAt: "2026-11-16T10:04:00.123456Z" });
    const f = await fixture({ rows: [unreadRow({ firstUnreadId: firstId, firstUnreadAt: firstAt })], signals: [message("m5", 5), floor] });
    f.setBottom(false);
    f.paint();
    assert.equal(f.bar.hidden, false, name);
    f.setOlder([[message("first", 4, { id: firstId, createdAt: firstAt })]]);
    await f.run("jumpToFirstUnread()");
    assert.equal(f.olderLoads(), 1, name);
    assert.equal(f.doc.activeElement?.dataset.signalId, firstId, `${name}: reached, not given up as gone`);
  }
});

test("a first unread message that is gone ends the jump quietly and reads the unread state again", async () => {
  const f = await fixture({ rows: [unreadRow({ firstUnreadId: U("gone"), firstUnreadAt: "2026-11-16T09:00:00Z" })],
    signals: [message("m5", 5), message("m4", 4)] });
  f.setBottom(false);
  f.paint();
  f.setOlder([[message("o1", 0, { createdAt: "2026-11-16T08:00:00Z" })]], false);
  const before = f.refreshes();
  await f.run("jumpToFirstUnread()");
  assert.equal(f.bar.hidden, true);
  assert.equal(f.divider(), null);
  assert.equal(f.refreshes(), before + 1);
  assert.notEqual(f.doc.activeElement, f.row("o1"), "nothing pretends to be the first unread message");
});

test("Mark as read marks through the newest loaded message, takes the bar and line away and keeps the reader's place", async () => {
  const f = await fixture();
  f.places.set("m3", -400);
  f.setBottom(false);
  f.paint();
  assert.ok(f.divider());
  f.scroller.scrollTop = 500;
  f.composer.value = "draft";
  // On a phone the button's focus does not go to the composer (that would raise the keyboard).
  (f.context.window as Record<string, unknown>).matchMedia = (query: string) => ({ matches: query === "(max-width: 52rem)" });
  f.mark.focus();
  f.run("markViewRead(channelReadViewId())");
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { channelId: "c1", throughSignalId: U("m5") }, "through the accepted snapshot, not up to now");
  assert.notEqual(f.doc.activeElement, f.composer);
  assert.equal(f.bar.hidden, true);
  assert.equal(f.divider(), null);
  assert.equal(f.scroller.scrollTop, 460, "the line above the screen went, and the message under the eye stayed put");
  assert.equal(f.composer.value, "draft");
  f.paint();
  assert.equal(f.divider(), null, "not drawn again on the next rebuild");
});

test("a reader in history keeps their place when the Unread line first appears above them", async () => {
  const f = await fixture();
  f.setBottom(false);
  f.places.set("m3", -400);
  f.scroller.scrollTop = 300;
  f.paint();
  assert.ok(f.divider());
  assert.equal(f.scroller.scrollTop, 340);
});

test("Escape marks the open channel read and Shift+Escape every channel; whatever uses Escape keeps it", async () => {
  const f = await fixture();
  f.setBottom(false);
  f.places.set("m3", 300);
  f.paint();
  assert.equal(f.marks.length, 0);

  // A receipt card closes on its own Escape, and that Escape is consumed: neither key below is also a mark.
  const receipt = f.doc.createElement("details"); receipt.className = "dashboard__message-receipt";
  Object.defineProperty(receipt, "open", { get: () => receipt.hasAttribute("open"), set: (on: boolean) => receipt.toggleAttribute("open", on) });
  receipt.setAttribute("open", ""); f.list.append(receipt);
  assert.equal(f.key("Escape").defaultPrevented, true);
  assert.equal(receipt.hasAttribute("open"), false, "the card closed");
  receipt.setAttribute("open", "");
  f.key("Escape", { shiftKey: true });
  assert.equal(receipt.hasAttribute("open"), false);
  receipt.remove();
  await settle();
  assert.equal(f.marks.length, 0, "a consumed Escape is never also a mark, Shift or not");

  const blocked: Array<[string, () => () => void]> = [
    ["an open dialog", () => { const n = f.doc.createElement("dialog"); n.setAttribute("open", ""); f.app.append(n); return () => n.remove(); }],
    ["an open menu", () => { const n = f.doc.createElement("div"); n.dataset.contextMenu = ""; f.app.append(n); return () => n.remove(); }],
    ["an open reaction picker", () => { const n = f.doc.createElement("div"); n.dataset.reactionPicker = "x"; f.app.append(n); return () => n.remove(); }],
    ["the mention list", () => { f.mentions.hidden = false; return () => { f.mentions.hidden = true; }; }],
    ["another field", () => { const n = f.doc.createElement("input"); f.app.append(n); n.focus(); return () => { n.remove(); f.composer.focus(); }; }],
    ["focus in a menu", () => { const m = f.doc.createElement("ul"); m.setAttribute("role", "menu"); const b = f.doc.createElement("button");
      m.append(b); f.app.append(m); b.focus(); return () => { m.remove(); f.composer.focus(); }; }],
    ["focus in an open disclosure", () => { const d = f.doc.createElement("details"); d.setAttribute("open", ""); const b = f.doc.createElement("button");
      d.append(b); f.app.append(d); b.focus(); return () => { d.remove(); f.composer.focus(); }; }],
    ["a selection in the composer", () => { f.composer.focus(); f.composer.selectionEnd = 3; return () => { f.composer.selectionEnd = 0; }; }],
    ["a selection on the page", () => { f.doc.selectionCollapsed = false; return () => { f.doc.selectionCollapsed = true; }; }],
    ["a reply", () => { f.context.composerIsReplying = () => true; return () => { f.context.composerIsReplying = () => false; }; }],
  ];
  f.composer.focus();
  for (const [name, set] of blocked) {
    const undo = set();
    for (const shiftKey of [false, true]) assert.equal(f.key("Escape", { shiftKey }).defaultPrevented, false, `${name}${shiftKey ? " (Shift)" : ""}`);
    undo();
  }
  for (const extra of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    for (const shiftKey of [false, true]) f.key("Escape", { ...extra, shiftKey });
  }
  await settle();
  assert.equal(f.marks.length, 0);

  // The composer focused on entry, nothing selected: Escape marks the channel.
  f.composer.value = "draft";
  assert.equal(f.key("Escape").defaultPrevented, true);
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1", throughSignalId: U("m5") }]);
  assert.equal(f.rows()[0]!.unread, false);
  assert.equal(f.composer.value, "draft");
  assert.equal(f.key("Escape").defaultPrevented, false, "a read channel leaves Escape alone");

  assert.equal(f.key("Escape", { shiftKey: true }).defaultPrevented, true);
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { all: true });

  // #general is null on the wire.
  const general = await fixture({ rows: [unreadRow({ channelId: null, slug: "general" })], signals: [message("g1", 1, { channelId: null })] });
  general.setBottom(false);
  general.run(`activeChannelId = ${JSON.stringify(GENERAL_CHANNEL_ID)}`);
  general.key("Escape");
  await settle();
  assert.deepEqual(general.marks.map(({ target }) => target), [{ channelId: null, throughSignalId: U("g1") }]);
});

test("every member reaches Mark as read and Mark all as read from the header's ⋯, #general included", async () => {
  const f = await fixture({ rows: [unreadRow({ channelId: null, slug: "general" }), unreadRow({ channelId: "c2", slug: "ops" })],
    signals: [message("g1", 1, { channelId: null })] });
  f.setBottom(false);
  f.run(`activeChannelId = ${JSON.stringify(GENERAL_CHANNEL_ID)}`);
  assert.deepEqual({ ...f.run("channelReadMenuState()") }, { channel: true, all: true });
  f.run("feedMenuAction({ kind: 'mark-read' })");
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { channelId: null, throughSignalId: U("g1") });
  assert.deepEqual({ ...f.run("channelReadMenuState()") }, { channel: false, all: true }, "the rest of the workspace is still unread");
  f.run("feedMenuAction({ kind: 'mark-all-read' })");
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { all: true });
  assert.equal(f.run("channelReadMenuState()"), null, "nothing left to mark: no entries");

  // The menu the header and the phone bar build: Mark as read first, where focus lands; Mark all as read, which cannot
  // be undone, beside All channels.
  const doc = new FakeDocument();
  const chosen: unknown[] = [];
  const menu = buildWorkspaceMenu(doc as unknown as Document, { name: "Home", sample: false, menu: { settings: false, adminAccess: false } } as never, {
    menu: () => {}, feed: (action: unknown) => chosen.push(action),
    feedMenu: () => ({ channels: [], mayCreateChannel: true, filters: [], refresh: null, read: { channel: true, all: true } }),
  } as never, "t") as unknown as FakeNode;
  const trigger = menu.querySelector(".hm-menu__trigger")!;
  trigger.click();
  const entries = menu.querySelectorAll(".hm-menu__item");
  assert.deepEqual(entries.slice(0, 4).map(item => item.textContent), [MARK_AS_READ_LABEL, "All channels", MARK_ALL_AS_READ_LABEL, "New channel"]);
  assert.equal(doc.activeElement, entries[0], "focus opens on Mark as read");
  assert.ok(entries[0]!.hasAttribute("data-menu-mark-read") && entries[2]!.hasAttribute("data-menu-mark-all-read"));
  entries[0]!.click();
  trigger.click();
  menu.querySelector("[data-menu-mark-all-read]")!.click();
  assert.deepEqual(chosen, [{ kind: "mark-read" }, { kind: "mark-all-read" }]);
});

test("the channel row's menu offers Mark as read while the channel is unread", async () => {
  const f = await fixture();
  const event = {}, anchor = f.doc.createElement("a");
  f.run("openChannelRowMenu")("c1", event, anchor);
  assert.deepEqual(f.menus[0]!.filter(Boolean).map(entry => entry!.label), [MARK_AS_READ_LABEL]);
  f.menus[0]!.find(entry => entry?.label === MARK_AS_READ_LABEL)!.run();
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1", throughSignalId: U("m5") }]);
  f.run("openChannelRowMenu")("c1", event, anchor);
  assert.deepEqual(f.menus[1]!.filter(Boolean), [], "a read channel has nothing to mark");
});

test("the sample marks nothing and shows no bar or menu entries", async () => {
  const f = await fixture({ sample: true });
  f.places.set("m3", -400);
  f.paint();
  f.key("Escape"); f.key("Escape", { shiftKey: true });
  f.run("markViewRead('c1')");
  f.run("openChannelRowMenu")("c1", {}, f.doc.createElement("a"));
  await settle();
  assert.equal(f.marks.length, 0);
  assert.equal(f.bar.hidden, true);
  assert.equal(f.divider(), null);
  assert.deepEqual(f.menus[0]!.filter(Boolean), []);
  assert.equal(f.run("channelReadMenuState()"), null);
});

test("a server from before read positions (400) is asked once; nothing shows an error and the rail is read again", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  f.setReplies(["unsupported"]);
  f.paint();
  await settle();
  assert.equal(f.marks.length, 1);
  assert.equal(f.refreshes(), 1, "the re-read puts back what the server says");
  f.setRows([unreadRow()]);
  f.context.signals = [message("m6", 6), ...(f.context.signals as Message[])];
  f.tick(CHANNEL_READ_RETRY_MS + 1);
  f.paint();
  f.key("Escape"); f.key("Escape", { shiftKey: true });
  await settle();
  assert.equal(f.marks.length, 1, "nothing more is sent");
  assert.equal(f.rows()[0]!.unread, true, "the dot is not cleared by a mark that cannot land");
  assert.equal(f.run("channelReadMenuState()"), null, "and the menu offers no mark");
});
