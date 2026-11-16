import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import {
  MARK_AS_READ_LABEL, UNREAD_DIVIDER_LABEL, UNREAD_JUMP_PAGES, channelReadRowFor, firstUnreadOlderThanLoaded,
  newestChannelMessage, oldestChannelMessage, readChannelIdOf, throughSignalFor, unreadJumpLabel, withChannelRead,
} from "../../lib/channel-reads";
import { GENERAL_CHANNEL_ID, channelUnreadFor } from "../../lib/channels";

/*
 * Read positions in the chat: the real dashboard functions run against a small fake DOM. Only the network
 * (markChannelRead, the unread re-read and older pages) and the rail's paint are stand-ins.
 */

const READ_FUNCTIONS = [
  "channelReadViewId", "channelReadVisitKey", "applyChannelRead", "sendChannelRead", "feedRowFor", "firstUnreadPlace",
  "paintUnreadDivider", "removeUnreadDivider", "renderUnreadBar", "dismissUnreadBar", "markViewRead",
  "autoMarkChannelRead", "syncChannelRead", "jumpToFirstUnread", "channelReadEscape", "openChannelRowMenu",
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

/* ---- A fake DOM: a tree, attributes (dataset is data-*), focus, geometry and a small selector engine. ---- */
type Rect = { top: number; bottom: number; height: number };
class FakeNode {
  children: FakeNode[] = []; parent: FakeNode | null = null; textContent = ""; className = ""; hidden = false;
  attributes = new Map<string, string>(); rect: Rect = { top: 100, bottom: 140, height: 40 };
  scrolledIntoView = 0; selectionStart = 0; selectionEnd = 0; scrollTop = 0; scrollHeight = 2000;
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
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: FakeNode[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
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
  focus() { this.doc.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView += 1; }
  getBoundingClientRect() { return this.rect; }
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
  const composer = doc.createElement("textarea"); composer.dataset.composerInput = "";
  const mentions = doc.createElement("div"); mentions.dataset.mentionPicker = ""; mentions.hidden = true;
  scroller.append(bar, list); app.append(scroller, composer, mentions); doc.body.append(app);

  const marks: Array<{ id: string; workspaceId: string; target: Record<string, unknown> }> = [];
  let replies: string[] = [];
  let ids = 0, refreshes = 0, railPaints = 0, olderLoads = 0, bottom = true;
  let older: Message[][] = [];
  const menus: Array<Array<{ label: string; run: () => void } | null>> = [];
  const context = createContext({
    document: doc, app, HTMLElement: FakeNode, CSS: { escape: (value: string) => value },
    window: { setTimeout: () => 1 },
    MARK_AS_READ_LABEL, UNREAD_DIVIDER_LABEL, UNREAD_JUMP_PAGES, GENERAL_CHANNEL_ID, channelReadRowFor, channelUnreadFor,
    firstUnreadOlderThanLoaded, newestChannelMessage, oldestChannelMessage, readChannelIdOf, throughSignalFor,
    unreadJumpLabel, withChannelRead,
    markChannelRead: async (_session: unknown, id: string, workspaceId: string, target: Record<string, unknown>) => {
      // Copied out of the vm's realm, so deepEqual compares values rather than prototypes.
      marks.push({ id, workspaceId, target: JSON.parse(JSON.stringify(target)) }); return replies.shift() ?? "ok";
    },
    uuid: () => `command-${++ids}`,
    one: (selector: string) => doc.querySelector(selector),
    feedScroller: () => scroller,
    atBottom: () => bottom,
    scrollToNewest: () => {},
    composerIsReplying: () => false,
    refreshChannelUnread: async () => { refreshes += 1; },
    renderHomeRail: () => { railPaints += 1; }, renderHomeShell: () => {}, renderChannelDirectoryDialog: () => {},
    loadOlderSignals: async () => {
      olderLoads += 1;
      const page = older.shift() ?? [];
      context.signals = [...(context.signals as Message[]), ...page];
      paint();
    },
    // The ⋯ menu's other entries (moves and settings) have their own tests.
    channelById: () => null, viewerMayManageChannel: () => false, railOrderListOf: () => null,
    channelLabel: (slug: string) => `#${slug}`, GENERAL_CHANNEL_SLUG: "general",
    openContextMenu: (_event: unknown, _anchor: unknown, entries: Array<{ label: string; run: () => void } | null>) => {
      menus.push(Array.from(entries, entry => entry && { label: entry.label, run: entry.run }));
    },
  });
  runInContext(`
    var sampleMode = ${options.sample ? "true" : "false"}, session = { user: { id: '${VIEWER}' } }, activeWorkspaceId = 'W';
    var homeRoute = { view: 'chat', workspaceId: 'W' }, activeWorkspaceView = 'signals', activeDm = null, unknownChannelId = null;
    var activeChannelId = 'c1', signalFilter = 'all', signalHasMore = true, channels = [];
    var channelUnreadRows = ${JSON.stringify(options.rows ?? [unreadRow()])}, channelUnreadGeneration = 0;
    var channelReadUnsupported = false; const channelReadMarked = new Set(); var unreadVisit = null;
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
  const key = (key: string, extra: Record<string, unknown> = {}) => {
    const event = { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; }, ...extra };
    run("channelReadEscape")(event);
    return event;
  };
  return {
    doc, app, list, bar, jump, mark, composer, mentions, marks, menus, run, key, paint, places, context,
    setBottom: (value: boolean) => { bottom = value; },
    setReplies: (next: string[]) => { replies = next; },
    setOlder: (pages: Message[][]) => { older = pages; },
    refreshes: () => refreshes, railPaints: () => railPaints, olderLoads: () => olderLoads,
    rows: () => run("channelUnreadRows") as Array<Record<string, unknown>>,
    row: (name: string) => list.querySelector(`[data-signal-id="${U(name)}"]`)!,
    divider: () => list.querySelector("[data-unread-divider]"),
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

  // A re-read that still says unread (it raced the mark) does not send the same mark again.
  f.run(`channelUnreadRows = ${JSON.stringify([unreadRow()])}`);
  f.paint(); f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 1);

  // A newer message: one more mark, through it.
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
  await settle();
  assert.equal(f.marks.length, 0);
  assert.equal(f.rows()[0]!.unread, true, "the dot stays until the channel is read");
  f.setBottom(true); f.run("syncChannelRead()");
  await settle();
  assert.equal(f.marks.length, 1);

  const read = await fixture({ rows: [unreadRow({ unread: false, unreadCount: 0, firstUnreadId: null, firstUnreadAt: null })] });
  read.paint(); await settle();
  assert.equal(read.marks.length, 0);
});

test("a message the person may not name is marked again without it, under a new command id", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  f.setReplies(["signal_not_found", "ok"]);
  f.paint();
  await settle();
  assert.deepEqual(f.marks.map(({ id, target }) => [id, target]), [
    ["command-1", { channelId: "c1", throughSignalId: U("m5") }],
    ["command-2", { channelId: "c1" }],
  ]);
});

test("the person's own message addressed to someone is marked up to now, without naming it", async () => {
  const f = await fixture({ signals: [message("own", 6, { from: VIEWER, to: "dana" }), message("m5", 5), message("m3", 3)] });
  f.places.set("m3", 300);
  f.paint();
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1", throughSignalId: null }]);
});

test("a first unread message above the screen keeps the bar and the Unread line for the visit; Jump brings it on screen", async () => {
  const f = await fixture({ rows: [unreadRow({ unreadCount: 12 })] });
  f.places.set("m3", -400);
  f.paint();
  await settle();
  assert.equal(f.bar.hidden, false);
  assert.equal(f.jump.textContent, "12 unread · Jump to first unread");
  assert.equal(f.marks.length, 1, "viewing the bottom still marks the channel read");
  assert.equal(f.rows()[0]!.unread, false);
  const divider = f.divider()!;
  assert.ok(divider, "the Unread line is drawn");
  assert.equal(divider.querySelector(".hm-day__label")?.textContent, "Unread");
  assert.equal(f.list.children[f.list.children.indexOf(divider) + 1], f.row("m3"), "directly above the first unread message");

  // Still latched after the mark and a rebuild: the bar is not hidden before it can be used.
  f.paint(); await settle();
  assert.equal(f.bar.hidden, false);
  assert.ok(f.divider());

  f.jump.focus();
  let composerFocused = false;
  const focusComposer = f.composer.focus.bind(f.composer);
  f.composer.focus = () => { composerFocused = true; focusComposer(); };
  await f.run("jumpToFirstUnread()");
  assert.equal(composerFocused, false, "focus goes straight to the message, never through the composer");
  assert.equal(f.row("m3").scrolledIntoView, 1);
  assert.equal(f.doc.activeElement, f.row("m3"), "focus moves to the message");
  assert.equal(f.bar.hidden, true);
  assert.ok(f.divider(), "the Unread line stays for the visit");
  assert.equal(f.olderLoads(), 0, "a loaded message needs no older page");
});

test("scrolling to the first unread message retires the bar; a first unread message already on screen never shows it", async () => {
  const f = await fixture();
  f.places.set("m3", -400);
  f.paint();
  assert.equal(f.bar.hidden, false);
  f.row("m3").rect = { top: 200, bottom: 240, height: 40 };
  f.run("syncChannelRead()");
  assert.equal(f.bar.hidden, true);

  const shown = await fixture();
  shown.places.set("m3", 300);
  shown.paint();
  assert.equal(shown.bar.hidden, true);
  assert.equal(shown.divider(), null);
});

test("Jump loads older pages, a bounded number, to reach a first unread message above the loaded ones", async () => {
  const f = await fixture({ rows: [unreadRow({ firstUnreadId: U("m0"), firstUnreadAt: "2026-11-16T10:00:00Z", unreadCount: 6 })],
    signals: [message("m5", 5), message("m4", 4)] });
  f.paint();
  assert.equal(f.bar.hidden, false, "older than the loaded page is above the screen");
  f.setOlder([[message("m3", 3), message("m2", 2)], [message("m1", 1), message("m0", 0)]]);
  await f.run("jumpToFirstUnread()");
  assert.equal(f.olderLoads(), 2);
  assert.equal(f.row("m0").scrolledIntoView, 1);
  assert.equal(f.doc.activeElement, f.row("m0"));
  assert.ok(f.divider(), "the line is drawn once the message is loaded");

  const far = await fixture({ rows: [unreadRow({ firstUnreadId: U("gone"), firstUnreadAt: "2026-11-15T10:00:00Z" })],
    signals: [message("m5", 5), message("m4", 4)] });
  far.paint();
  far.setOlder(Array.from({ length: 10 }, (_, n) => [message(`o${n}`, 0, { createdAt: `2026-11-16T0${9 - n}:00:00Z` })]));
  await far.run("jumpToFirstUnread()");
  assert.equal(far.olderLoads(), UNREAD_JUMP_PAGES, "at most a few pages");
  const oldest = far.list.querySelector("[data-signal-id]")!;
  assert.equal(far.doc.activeElement, oldest, "then the oldest loaded message");
  assert.equal(far.bar.hidden, true);
});

test("Mark as read marks everything up to now and takes the bar and the line away", async () => {
  const f = await fixture();
  f.places.set("m3", -400);
  f.paint(); await settle();
  // On a phone the button's focus does not go to the composer (that would raise the keyboard).
  (f.context.window as Record<string, unknown>).matchMedia = (query: string) => ({ matches: query === "(max-width: 52rem)" });
  f.mark.focus();
  f.run("markViewRead(channelReadViewId())");
  await settle();
  assert.deepEqual(f.marks.at(-1)!.target, { channelId: "c1" });
  assert.notEqual(f.doc.activeElement, f.composer);
  assert.equal(f.bar.hidden, true);
  assert.equal(f.divider(), null);
  f.paint();
  assert.equal(f.divider(), null, "not drawn again on the next rebuild");
});

test("Escape marks the open channel read and Shift+Escape every channel; whatever uses Escape itself keeps it", async () => {
  const f = await fixture();
  f.setBottom(false);
  f.places.set("m3", 300);
  f.paint();
  assert.equal(f.marks.length, 0);

  // Each of these keeps the key, and nothing is sent.
  const dialog = f.doc.createElement("dialog"); dialog.setAttribute("open", ""); f.app.append(dialog);
  assert.equal(f.key("Escape").defaultPrevented, false, "an open dialog");
  dialog.remove();
  const menu = f.doc.createElement("div"); menu.dataset.contextMenu = ""; f.app.append(menu);
  assert.equal(f.key("Escape").defaultPrevented, false, "an open menu");
  menu.remove();
  const picker = f.doc.createElement("div"); picker.dataset.reactionPicker = "m5"; f.app.append(picker);
  assert.equal(f.key("Escape").defaultPrevented, false, "an open reaction picker");
  picker.remove();
  f.mentions.hidden = false;
  assert.equal(f.key("Escape").defaultPrevented, false, "the mention list");
  f.mentions.hidden = true;
  const field = f.doc.createElement("input"); f.app.append(field); field.focus();
  assert.equal(f.key("Escape").defaultPrevented, false, "another field");
  f.composer.focus(); f.composer.selectionStart = 0; f.composer.selectionEnd = 3;
  assert.equal(f.key("Escape").defaultPrevented, false, "a selection in the composer");
  f.composer.selectionEnd = 0; f.doc.selectionCollapsed = false;
  assert.equal(f.key("Escape").defaultPrevented, false, "a selection on the page");
  f.doc.selectionCollapsed = true;
  f.context.composerIsReplying = () => true;
  assert.equal(f.key("Escape").defaultPrevented, false, "a reply");
  f.context.composerIsReplying = () => false;
  assert.equal(f.key("Escape", { defaultPrevented: true }).defaultPrevented, true);
  await settle();
  assert.equal(f.marks.length, 0);

  // The composer focused on entry, nothing selected: Escape marks the channel.
  assert.equal(f.key("Escape").defaultPrevented, true);
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1" }]);
  assert.equal(f.rows()[0]!.unread, false);
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
  assert.deepEqual(general.marks.map(({ target }) => target), [{ channelId: null }]);
});

test("the channel row's menu offers Mark as read while the channel is unread", async () => {
  const f = await fixture();
  const event = {}, anchor = f.doc.createElement("a");
  f.run("openChannelRowMenu")("c1", event, anchor);
  assert.deepEqual(f.menus[0]!.filter(Boolean).map(entry => entry!.label), [MARK_AS_READ_LABEL]);
  f.menus[0]!.find(entry => entry?.label === MARK_AS_READ_LABEL)!.run();
  await settle();
  assert.deepEqual(f.marks.map(({ target }) => target), [{ channelId: "c1" }]);
  f.run("openChannelRowMenu")("c1", event, anchor);
  assert.deepEqual(f.menus[1]!.filter(Boolean), [], "a read channel has nothing to mark");
});

test("the sample marks nothing and shows no bar", async () => {
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
});

test("a server from before read positions (400) is asked once; nothing shows an error and the rail is read again", async () => {
  const f = await fixture();
  f.places.set("m3", 300);
  f.setReplies(["unsupported"]);
  f.paint();
  await settle();
  assert.equal(f.marks.length, 1);
  assert.equal(f.refreshes(), 1, "the re-read puts back what the server says");
  f.run(`channelUnreadRows = ${JSON.stringify([unreadRow()])}`);
  f.context.signals = [message("m6", 6), ...(f.context.signals as Message[])];
  f.paint();
  f.key("Escape"); f.key("Escape", { shiftKey: true });
  await settle();
  assert.equal(f.marks.length, 1, "nothing more is sent");
  assert.equal(f.rows()[0]!.unread, true, "the dot is not cleared by a mark that cannot land");
});
