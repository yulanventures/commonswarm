import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { REACTION_PICKER_EMOJIS, pickerMove, reactionNames, reactionPillLabel } from "../../lib/reactions";

/*
 * Reactions in the feed: the real dashboard functions run against a small fake DOM. Only the network
 * (addReaction, removeReaction, signalReactions) and the feed's row builder are stand-ins; the row builder
 * calls the same appendReactions and reactionAddButton the real one does.
 */

const REACTION_FUNCTIONS = [
  "reactionKey", "REACTION_PICKER_COLUMNS", "reactionsAllowed", "reactionTicketLive", "reactionIsPending",
  "refreshSignalReactions", "repaintReactions", "applyOwnReaction", "showReactionError", "syncReactionPending",
  "toggleReaction", "reactionOpener", "syncReactionOpeners", "reactionOpenerShown", "placeReactionPicker", "syncReactionPicker",
  "onReactionPickerOutside", "onReactionPickerFocusOut", "onReactionPickerKey", "closeReactionPicker",
  "openReactionPicker", "reactionAddButton", "appendReactions", "resetSignalReactions",
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

/* ---- A fake DOM: a tree, attributes (dataset is data-*), focus, events and a small selector engine. ---- */
type Listener = (event: any) => void;
class FakeNode {
  children: FakeNode[] = []; parent: FakeNode | null = null; textContent = ""; className = ""; type = ""; title = "";
  tabIndex = 0; style: Record<string, string> = {}; attributes = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  rect = { left: 600, right: 628, top: 100, bottom: 128, width: 28, height: 28 };
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
  get isConnected(): boolean { let node: FakeNode | null = this; while (node.parent) node = node.parent; return node === this.doc.root; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) {
      if (typeof node === "string") { const text = new FakeNode("#text", this.doc); text.textContent = node; this.append(text); continue; }
      node.remove(); node.parent = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() {
    if (!this.parent) return;
    const active = this.doc.activeElement;
    if (active && (active === this || this.contains(active))) this.doc.activeElement = this.doc.body;
    this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null;
  }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  descendants(): FakeNode[] { return this.children.flatMap(node => [node, ...node.descendants()]); }
  get firstElementChild() { return this.children[0] ?? null; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  fire(type: string, event: Record<string, unknown> = {}) {
    const full = { target: this, preventDefault() { (this as any).defaultPrevented = true; }, stopPropagation() {}, ...event };
    for (let node: FakeNode | null = this; node; node = node.parent) for (const listener of node.listeners.get(type) ?? []) listener(full);
    return full;
  }
  click() { this.fire("click"); }
  focus() {
    const previous = this.doc.activeElement;
    if (previous && previous !== this) previous.fire("focusout", { relatedTarget: this });
    this.doc.activeElement = this;
  }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.isConnected ? [this.rect] : []; }
  matches(selector: string): boolean { return selector.split(",").some(part => matchesChain(this, part.trim().split(/\s+/))); }
  closest<T>(selector: string): T | null { for (let node: FakeNode | null = this; node; node = node.parent) if (node.matches(selector)) return node as T; return null; }
  querySelectorAll(selector: string): FakeNode[] { return this.descendants().filter(node => node.tag !== "#text" && node.matches(selector)); }
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
  activeElement: FakeNode | null = null;
  root: FakeNode; body: FakeNode; listeners = new Map<string, Listener[]>();
  constructor() { this.root = new FakeNode("html", this); this.body = new FakeNode("body", this); this.root.append(this.body); this.activeElement = this.body; }
  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_namespace: string, tag: string) { return new FakeNode(tag, this); }
  querySelector(selector: string) { return this.root.querySelector(selector); }
  querySelectorAll(selector: string) { return this.root.querySelectorAll(selector); }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  pointerdown(target: FakeNode) { for (const listener of this.listeners.get("pointerdown") ?? []) listener({ target }); }
}

const VIEWER = "viewer";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(options: { sample?: boolean } = {}) {
  const doc = new FakeDocument();
  const app = doc.createElement("live-dashboard");
  const list = doc.createElement("ol");
  app.append(list); doc.body.append(app);
  const commands: Array<{ kind: string; workspaceId: string; signalId: string; emoji: string }> = [];
  const reads: string[][] = [];
  let groups = new Map<string, unknown[]>();
  let commandReply: unknown = { ok: true, changed: true };
  let renders = 0;
  const command = (kind: string) => async (_session: unknown, _id: string, workspaceId: string, signalId: string, emoji: string) => {
    commands.push({ kind, workspaceId, signalId, emoji }); return commandReply;
  };
  const context = createContext({
    document: doc, app, HTMLElement: FakeNode, Node: FakeNode, CSS: { escape: (value: string) => value },
    window: { innerWidth: 360, innerHeight: 640, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
    REACTION_PICKER_EMOJIS, pickerMove, reactionNames, reactionPillLabel,
    signalReactions: async (_workspaceId: string, ids: string[]) => { reads.push([...ids]); return groups; },
    addReaction: command("add_reaction"), removeReaction: command("remove_reaction"), uuid: () => "command-id",
    entityName: (entity: { kind: string; id: string }) => ({ dana: "Dana", muse: "Muse" } as Record<string, string>)[entity.id] ?? "Workspace member",
    addAgentViewOpen: () => false,
  });
  runInContext(`
    let sampleMode = ${options.sample ? "true" : "false"}, session = { user: { id: '${VIEWER}' } }, activeWorkspaceId = 'W', requestVersion = 1;
    let signals = [{ id: '${S1}' }, { id: '${S2}' }, { id: 'composer-pending-1' }];
    let signalReactionRows = new Map(), signalReactionGeneration = 0, signalReactionEpoch = 0, signalReactionReading = false, signalReactionAgain = false;
    const reactionTickets = new Map(), reactionErrors = new Map(); let reactionErrorTimer;
    let reactionPicker = null, reactionPickerNode = null;
  `, context);
  runInContext(await dashboardFunctions(REACTION_FUNCTIONS), context);
  // The feed's rebuild, reduced to what reactions touch: each row's body, its reactions, then its tools.
  context.renderFeed = () => {
    renders += 1;
    const rows = (runInContext("signals", context) as Array<{ id: string }>).map(signal => {
      const row = doc.createElement("li"); row.dataset.signalId = signal.id;
      const body = doc.createElement("article"); body.className = "dashboard__message-body";
      runInContext("appendReactions", context)(body, signal);
      const add = runInContext("reactionAddButton", context)(signal);
      if (add) {
        const tools = doc.createElement("div"); tools.className = "dashboard__message-tools";
        const actions = doc.createElement("div"); actions.className = "dashboard__message-actions";
        actions.append(add); tools.append(actions); body.append(tools);
      }
      row.append(body); return row;
    });
    list.replaceChildren(...rows);
    runInContext("syncReactionPicker", context)();
  };
  const run = (code: string) => runInContext(code, context);
  return {
    doc, app, list, commands, reads, run, context, renders: () => renders,
    setGroups: (next: Record<string, unknown[]>) => { groups = new Map(Object.entries(next)); },
    setReply: (reply: unknown) => { commandReply = reply; },
    row: (id: string) => list.querySelector(`[data-signal-id="${id}"]`)!,
    pills: (id: string) => list.querySelector(`[data-signal-id="${id}"]`)!.querySelectorAll("[data-reaction-emoji]"),
    picker: () => app.querySelector("[data-reaction-picker]"),
  };
}

const THUMBS = "\u{1F44D}", EYES = "\u{1F440}";
const twoGroups = {
  [S1]: [
    { emoji: EYES, count: 1, actors: [{ kind: "agent", id: "muse" }], mine: false },
    { emoji: THUMBS, count: 2, actors: [{ kind: "person", id: "dana" }, { kind: "person", id: VIEWER }], mine: true },
  ],
};

test("pills come from the read: one per emoji, in order, with counts, pressed state, names and the add pill", async () => {
  const f = await fixture();
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  assert.deepEqual(f.reads, [[S1, S2]], "every loaded message is asked about; a row still being posted is not");
  const pills = f.pills(S1);
  assert.deepEqual(pills.map(pill => pill.dataset.reactionEmoji), [EYES, THUMBS]);
  assert.deepEqual(pills.map(pill => pill.getAttribute("aria-pressed")), ["false", "true"]);
  assert.equal(pills[0]!.getAttribute("aria-label"), `${EYES} 1, Muse; add yours`, "an agent's ack is an ordinary reaction");
  assert.equal(pills[1]!.getAttribute("aria-label"), `${THUMBS} 2, you and Dana; remove yours`);
  assert.equal(pills[1]!.title, "you and Dana");
  assert.equal(pills[1]!.querySelector(".dashboard__reaction-count")?.textContent, "2");
  const line = f.row(S1).querySelector(".dashboard__message-reactions")!;
  assert.equal(line.getAttribute("role"), "group");
  assert.ok(line.querySelector("[data-reaction-more]"), "a row with pills also offers the compact add pill");
  const body = f.row(S1).querySelector(".dashboard__message-body")!;
  assert.ok(body.children.indexOf(line) < body.children.indexOf(body.querySelector(".dashboard__message-tools")!),
    "the pills come before the row's tools, never inside them");
  assert.equal(f.row(S2).querySelector(".dashboard__message-reactions"), null, "a message without reactions has no pills line");
  assert.ok(f.row(S2).querySelector(".dashboard__message-tools [data-reaction-add]"), "every message offers Add reaction in its tools");
  assert.equal(f.row("composer-pending-1").querySelector("[data-reaction-add]"), null, "a row still being posted has no reactions UI");

  const before = f.renders();
  await f.run("refreshSignalReactions('W', 1)");
  assert.equal(f.renders(), before, "an unchanged answer does not repaint");
});

test("a pressed pill takes the person's emoji back, an unpressed one adds it, and only that pill waits", async () => {
  const f = await fixture();
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  let release!: () => void;
  f.context.removeReaction = async (_session: unknown, _id: string, workspaceId: string, signalId: string, emoji: string) => {
    f.commands.push({ kind: "remove_reaction", workspaceId, signalId, emoji });
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, changed: true };
  };
  f.pills(S1)[1]!.focus();
  f.pills(S1)[1]!.click();
  assert.deepEqual(f.commands, [{ kind: "remove_reaction", workspaceId: "W", signalId: S1, emoji: THUMBS }]);
  assert.equal(f.pills(S1)[1]!.getAttribute("aria-disabled"), "true", "the clicked pill waits");
  assert.equal(f.pills(S1)[0]!.getAttribute("aria-disabled"), null, "its neighbour does not");
  f.pills(S1)[1]!.click();
  assert.equal(f.commands.length, 1, "a waiting pill sends nothing more");
  f.setGroups({ [S1]: [twoGroups[S1]![0]!, { emoji: THUMBS, count: 1, actors: [{ kind: "person", id: "dana" }], mine: false }] });
  release(); await settle(); await settle();
  const thumbs = f.pills(S1)[1]!;
  assert.equal(thumbs.getAttribute("aria-pressed"), "false");
  assert.equal(thumbs.getAttribute("aria-label"), `${THUMBS} 1, Dana; add yours`);
  assert.equal(thumbs.getAttribute("aria-disabled"), null);
  assert.equal(f.doc.activeElement, thumbs, "focus stays on the pill across the repaint, although its name changed");
  assert.deepEqual(f.reads.at(-1), [S1], "that message's reactions are read again");

  thumbs.click(); await settle(); await settle();
  assert.deepEqual(f.commands.at(-1), { kind: "add_reaction", workspaceId: "W", signalId: S1, emoji: THUMBS });
});

test("a refused reaction says why beside the message, and a read that started before the change cannot undo it", async () => {
  const f = await fixture();
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  // A read in flight while the person's own change settles carries the old answer.
  let releaseRead!: () => void;
  const staleGroups = new Map(Object.entries(twoGroups));
  f.context.signalReactions = async (_w: string, ids: string[]) => { f.reads.push([...ids]); await new Promise<void>(r => { releaseRead = r; }); return staleGroups; };
  const reading = f.run("refreshSignalReactions('W', 1)") as Promise<void>;
  f.pills(S1)[1]!.click(); await settle();
  assert.equal(f.pills(S1)[1]!.getAttribute("aria-pressed"), "false", "the person's own removal shows at once");
  let releaseFresh!: () => void;
  f.context.signalReactions = async (_w: string, ids: string[]) => {
    f.reads.push([...ids]); await new Promise<void>(r => { releaseFresh = r; });
    return new Map([[S1, [twoGroups[S1]![0], { emoji: THUMBS, count: 1, actors: [{ kind: "person", id: "dana" }], mine: false }]]]);
  };
  const readsBefore = f.reads.length;
  releaseRead(); await reading; await settle();
  assert.equal(f.pills(S1)[1]!.getAttribute("aria-pressed"), "false", "the read that started before the change was dropped");
  assert.equal(f.reads.length, readsBefore + 1, "and asked again");
  releaseFresh(); await settle(); await settle();
  assert.equal(f.pills(S1)[1]!.getAttribute("aria-pressed"), "false");

  f.setReply({ ok: false, reason: "reaction_limit_reached", message: "You have added as many reactions to this message as one person can." });
  f.pills(S1)[0]!.click(); await settle(); await settle();
  const alert = f.row(S1).querySelector(".dashboard__reaction-error");
  assert.equal(alert?.getAttribute("role"), "alert");
  assert.match(alert?.textContent ?? "", /as many reactions/);
});

test("the picker opens from the tools, moves with arrows, picks with a click, and Escape returns focus", async () => {
  const f = await fixture();
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  const opener = () => f.row(S2).querySelector("[data-reaction-add]")!;
  assert.equal(opener().getAttribute("aria-label"), "Add reaction");
  assert.equal(opener().getAttribute("aria-haspopup"), "menu");
  opener().click();
  const picker = f.picker()!;
  assert.ok(picker, "the picker opens outside the feed list");
  assert.equal(f.list.contains(picker), false);
  assert.equal(opener().getAttribute("aria-expanded"), "true");
  const options = picker.querySelectorAll("[data-reaction-option]");
  assert.deepEqual(options.map(option => option.textContent), [...REACTION_PICKER_EMOJIS]);
  assert.equal(f.doc.activeElement, options[0]);
  assert.ok(Number.parseFloat(picker.style.left!) >= 8, "kept inside a 360px viewport");
  picker.fire("keydown", { key: "ArrowRight" });
  assert.equal(f.doc.activeElement, options[1]);
  picker.fire("keydown", { key: "ArrowDown" });
  assert.equal(f.doc.activeElement, options[7]);
  assert.equal(options[7]!.tabIndex, 0);
  const escape = picker.fire("keydown", { key: "Escape" });
  assert.equal((escape as { defaultPrevented?: boolean }).defaultPrevented, true);
  assert.equal(f.picker(), null, "Escape closes it");
  assert.equal(f.doc.activeElement, opener(), "and focus is back on its opener");
  assert.equal(opener().getAttribute("aria-expanded"), "false");

  opener().click();
  f.picker()!.querySelectorAll("[data-reaction-option]")[5]!.click();
  await settle(); await settle();
  assert.equal(f.picker(), null);
  assert.deepEqual(f.commands.at(-1), { kind: "add_reaction", workspaceId: "W", signalId: S2, emoji: REACTION_PICKER_EMOJIS[5] });
  assert.equal(f.doc.activeElement, opener(), "after the pick and its repaint, focus is back on Add reaction in the tools");

  // From the add pill too; one picker at a time; a click outside closes it without moving focus.
  f.row(S1).querySelector("[data-reaction-more]")!.click();
  assert.equal(f.picker()!.dataset.reactionPicker, S1);
  assert.equal(f.picker()!.querySelectorAll("[data-reaction-option]")[1]!.getAttribute("aria-checked"), "true", "your own emoji is marked");
  opener().click();
  assert.equal(f.app.querySelectorAll("[data-reaction-picker]").length, 1);
  assert.equal(f.picker()!.dataset.reactionPicker, S2);
  f.doc.pointerdown(f.list);
  assert.equal(f.picker(), null);
});

test("a repaint keeps the picker on its new opener, and a workspace reset closes it", async () => {
  const f = await fixture();
  await f.run("refreshSignalReactions('W', 1)");
  f.context.renderFeed();
  f.row(S2).querySelector("[data-reaction-add]")!.click();
  f.context.renderFeed();
  assert.ok(f.picker(), "the rebuilt row's control is found again");
  assert.equal(f.row(S2).querySelector("[data-reaction-add]")!.getAttribute("aria-expanded"), "true");
  f.run("signals = [{ id: '" + S1 + "' }]");
  f.context.renderFeed();
  assert.equal(f.picker(), null, "its message left the feed, so it closed");
  f.row(S1).querySelector("[data-reaction-add]")!.click();
  f.run("resetSignalReactions()");
  assert.equal(f.picker(), null);
});

test("the sample and a signed-out page have no reactions UI and read nothing", async () => {
  const f = await fixture({ sample: true });
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  f.context.renderFeed();
  assert.deepEqual(f.reads, []);
  assert.equal(f.list.querySelector("[data-reaction-add]"), null);
  assert.equal(f.list.querySelector("[data-reaction-emoji]"), null);
  f.run("openReactionPicker('" + S1 + "', 'tools')");
  assert.equal(f.picker(), null);
  const g = await fixture();
  g.run("session = null");
  g.context.renderFeed();
  assert.equal(g.list.querySelector("[data-reaction-add]"), null);
});

test("a scroll that carries the opener out of view closes the picker; while in view it stays inside the window", async () => {
  const f = await fixture();
  f.setGroups(twoGroups);
  await f.run("refreshSignalReactions('W', 1)");
  const opener = () => f.row(S2).querySelector("[data-reaction-add]")!;
  // Near the bottom edge: the picker opens above its opener and stays inside the window.
  opener().rect = { left: 300, right: 328, top: 600, bottom: 628, width: 28, height: 28 };
  opener().click();
  const picker = f.picker()!;
  picker.rect = { left: 0, right: 200, top: 0, bottom: 120, width: 200, height: 120 };
  f.run("placeReactionPicker()");
  const top = Number.parseFloat(picker.style.top!);
  assert.ok(top >= 8 && top + 120 <= 640 - 8, `inside the 640px window: ${top}`);
  // Scrolled above the top of the window: closed, without taking focus anywhere.
  opener().rect = { left: 300, right: 328, top: -60, bottom: -32, width: 28, height: 28 };
  f.run("placeReactionPicker()");
  assert.equal(f.picker(), null, "out of view, so closed");
  assert.equal(opener().getAttribute("aria-expanded"), "false");
});
