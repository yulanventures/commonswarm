/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHomeRail } from "./home-rail.ts";

/* A minimal element: enough for the rail builder, no layout. */
const element = (tag) => ({
  tag, children: [], attrs: {}, listeners: {}, dataset: {}, hidden: false, className: "", textContent: "", title: "", href: "", id: "", type: "",
  append(...children) { this.children.push(...children); },
  setAttribute(name, value) { this.attrs[name] = value; },
  getAttribute(name) { return this.attrs[name] ?? null; },
  addEventListener(name, callback) { this.listeners[name] = callback; },
  querySelectorAll() { return []; },
});
const doc = { createElement: element };
const walk = (node) => [node, ...(node.children ?? []).flatMap(walk)];
const find = (root, predicate) => walk(root).filter((node) => typeof node === "object" && predicate(node));

const row = (id, slug, extra = {}) => ({ id, slug, href: `/app?w=w&c=${id}`, current: false, unread: null, manageable: false, ...extra });
const rail = (channels, sample = false, options = {}) => buildHomeRail(doc, {
  sample, catchUp: { href: "/app?v=catchup", current: false, needsYou: null }, workspaces: [], people: null, channels,
}, { openPerson() {}, openAgent() {}, selectChannel() {}, channelMenu() {}, newChannel() {}, retryChannels() {} }, options);
const ready = (named, extra = {}) => ({ state: "ready", general: row("general", "general"), channels: named, archived: [], mayCreate: true, ...extra });

test("Channels lists #general first; the + is New channel and the ⋯ sits beside a manageable row only", () => {
  const root = rail(ready([row("a", "design", { manageable: true }), row("b", "ops")]));
  const links = find(root, (node) => node.dataset?.railChannel !== undefined);
  assert.deepEqual(links.map((link) => link.dataset.railChannel), ["general", "a", "b"]);
  assert.equal(find(root, (node) => node.tag === "h2")[0].textContent, "Channels");
  const create = find(root, (node) => node.dataset?.homeNewChannel !== undefined);
  assert.equal(create.length, 1);
  assert.equal(create[0].attrs["aria-label"], "New channel");
  const menus = find(root, (node) => node.dataset?.railChannelMenu !== undefined);
  assert.deepEqual(menus.map((menu) => menu.dataset.railChannelMenu), ["a"], "#general and unmanageable rows have no menu");
  // The menu is a sibling of the link, never inside it.
  const item = find(root, (node) => node.tag === "li" && node.children.includes(menus[0]))[0];
  assert.equal(item.children[0].tag, "a");
  assert.equal(find(item.children[0], (node) => node.tag === "button").length, 0);
});

test("unread: a dot and 'unread' only when the read said true; false and unknown look the same and claim nothing", () => {
  const root = rail(ready([row("a", "design", { unread: true }), row("b", "ops", { unread: false }), row("c", "qa", { unread: null })],
    { general: row("general", "general", { unread: true }) }));
  const byId = (id) => find(root, (node) => node.dataset?.railChannel === id)[0];
  for (const id of ["general", "a"]) {
    assert.equal(byId(id).dataset.unread, "");
    assert.match(byId(id).attrs["aria-label"], /, unread$/);
    assert.equal(find(byId(id), (node) => node.className === "hm-rail__unread").length, 1);
  }
  for (const id of ["b", "c"]) {
    assert.equal(byId(id).dataset.unread, undefined);
    assert.doesNotMatch(byId(id).attrs["aria-label"], /unread|read/);
    assert.equal(find(byId(id), (node) => node.className === "hm-rail__unread").length, 0);
  }
  assert.equal(walk(root).some((node) => typeof node === "object" && /^\d+$/.test(node.textContent ?? "") && node.className?.includes("badge")), false,
    "no numeric counts");
});

test("loading shows #general and skeletons; a failed read keeps the list and offers Retry", () => {
  const loading = rail({ ...ready([row("a", "design")]), state: "loading" });
  assert.deepEqual(find(loading, (node) => node.dataset?.railChannel !== undefined).map((node) => node.dataset.railChannel), ["general"]);
  assert.equal(find(loading, (node) => node.className === "hm-rail__channel-skeleton").length, 3);
  const failed = rail({ ...ready([row("a", "design")]), state: "failed" });
  assert.deepEqual(find(failed, (node) => node.dataset?.railChannel !== undefined).map((node) => node.dataset.railChannel), ["general", "a"]);
  assert.ok(find(failed, (node) => node.textContent === "Couldn’t load channels").length === 1);
  assert.ok(find(failed, (node) => node.dataset?.homeChannelsRetry !== undefined).length === 1);
});

test("no named channels: #general and the +, with no helper block", () => {
  const root = rail(ready([]));
  assert.deepEqual(find(root, (node) => node.dataset?.railChannel !== undefined).map((node) => node.dataset.railChannel), ["general"]);
  assert.equal(find(root, (node) => node.tag === "p").length, 0);
  assert.equal(find(root, (node) => node.dataset?.homeArchivedToggle !== undefined).length, 0, "no archived disclosure without archived rows");
});

test("overflow: Show N more counts hidden rows; a selected overflow channel stays visible", () => {
  const named = Array.from({ length: 8 }, (_, index) => row(`c${index}`, `c${index}`, { current: index === 6 }));
  const root = rail(ready(named));
  const visible = find(root, (node) => node.tag === "li" && !node.hidden && node.children[0]?.dataset?.railChannel !== undefined)
    .map((node) => node.children[0].dataset.railChannel);
  assert.deepEqual(visible, ["general", "c0", "c1", "c2", "c3", "c6"]);
  assert.equal(find(root, (node) => node.dataset?.homeChannelsMore !== undefined)[0].textContent, "Show 3 more");
  const expanded = rail(ready(named), false, { channelsExpanded: true });
  assert.equal(find(expanded, (node) => node.dataset?.homeChannelsMore !== undefined)[0].textContent, "Show fewer");
});

test("archived channels keep their manager menu, open when selected, and never show unread", () => {
  const archived = [row("x", "old", { unread: true, manageable: true })];
  const closed = rail(ready([], { archived }));
  const toggle = find(closed, (node) => node.dataset?.homeArchivedToggle !== undefined)[0];
  assert.equal(toggle.attrs["aria-expanded"], "false");
  const list = find(closed, (node) => node.id === "hm-rail-archived-list")[0];
  assert.equal(list.hidden, true);
  const link = find(list, (node) => node.dataset?.railChannel === "x")[0];
  assert.equal(link.dataset.unread, undefined);
  assert.equal(find(list, (node) => node.dataset?.railChannelMenu !== undefined).length, 1, "archived channels remain manageable");
  const open = rail(ready([], { archived: [{ ...archived[0], current: true }] }));
  assert.equal(find(open, (node) => node.id === "hm-rail-archived-list")[0].hidden, false);
});

test("a sample rail selects channels but offers no create or manage controls", () => {
  const root = rail(ready([row("a", "design", { manageable: true })]), true);
  assert.equal(find(root, (node) => node.dataset?.homeNewChannel !== undefined).length, 0);
  assert.equal(find(root, (node) => node.dataset?.railChannelMenu !== undefined).length, 0);
  assert.equal(find(root, (node) => node.dataset?.railChannel !== undefined).length, 2);
});

test("Catch up has no Channels section", () => {
  const root = rail(undefined);
  assert.equal(find(root, (node) => node.dataset?.railChannel !== undefined).length, 0);
});

test("Starred sits above Channels in the viewer's order, and a starred place is listed once", () => {
  const general = row("general", "general");
  const ops = row("b", "ops", { manageable: true });
  const root = rail(ready([row("a", "design")], { general, starred: [ops, general] }));
  assert.deepEqual(find(root, (node) => node.tag === "h2").map((node) => node.textContent), ["Starred", "Channels"]);
  const sections = find(root, (node) => node.tag === "section");
  const ids = (section) => find(section, (node) => node.dataset?.railChannel !== undefined).map((link) => link.dataset.railChannel);
  assert.deepEqual(sections.map(ids), [["b", "general"], ["a"]], "#general leaves Channels when it is starred");
  assert.equal(find(sections[0], (node) => node.dataset?.railChannelMenu === "b").length, 1, "a starred row keeps its menu");
  assert.equal(find(sections[0], (node) => node.dataset?.homeNewChannel !== undefined).length, 0, "the + stays with Channels");
});

test("nothing starred: no Starred heading; and none while the list is still loading", () => {
  for (const channels of [ready([row("a", "design")]), ready([row("a", "design")], { starred: [] }),
    { ...ready([]), state: "loading", starred: [row("a", "design")] }]) {
    assert.deepEqual(find(rail(channels), (node) => node.tag === "h2").map((node) => node.textContent), ["Channels"]);
  }
});

test("a muted channel is marked, says so, and never shows unread even if a row claims it", () => {
  const root = rail(ready([row("a", "design", { muted: true, unread: true }), row("b", "ops", { unread: true })]));
  const byId = (id) => find(root, (node) => node.dataset?.railChannel === id)[0];
  assert.equal(byId("a").dataset.muted, "");
  assert.equal(byId("a").dataset.unread, undefined);
  assert.equal(byId("a").attrs["aria-label"], "#design, muted");
  assert.equal(find(byId("a"), (node) => node.className === "hm-rail__unread").length, 0);
  assert.equal(find(byId("a"), (node) => node.className === "hm-rail__muted").length, 1, "the row carries a struck bell, not colour alone");
  assert.equal(find(byId("b"), (node) => node.className === "hm-rail__muted").length, 0);
  assert.equal(byId("b").dataset.muted, undefined);
  assert.equal(byId("b").attrs["aria-label"], "#ops, unread");
});

test("a movable row steps with Alt+Arrow, can be dragged onto another row of its own list only, and always has a ⋯", () => {
  const moves = [], drops = [];
  const general = row("general", "general", { reorder: "starred" });
  const ops = row("b", "ops", { reorder: "starred" });
  const root = buildHomeRail(doc, { sample: false, catchUp: { href: "/app?v=catchup", current: false, needsYou: null }, workspaces: [], people: null,
    channels: ready([row("a", "design", { reorder: "channels" }), row("c", "qa", { reorder: "channels" }), row("d", "fixed")], { general, starred: [ops, general] }) },
    { openPerson() {}, openAgent() {}, selectChannel() {}, channelMenu() {}, newChannel() {}, retryChannels() {},
      moveChannel: (...args) => moves.push(args), dropChannel: (...args) => drops.push(args) });
  const link = (id) => find(root, (node) => node.dataset?.railChannel === id)[0];
  const item = (id) => find(root, (node) => node.tag === "li" && node.children.includes(link(id)))[0];
  const key = (id, event) => { let prevented = false; link(id).listeners.keydown({ ctrlKey: false, metaKey: false, altKey: false, ...event, preventDefault() { prevented = true; } }); return prevented; };

  assert.equal(key("b", { altKey: true, key: "ArrowDown" }), true);
  assert.equal(key("a", { altKey: true, key: "ArrowUp" }), true);
  assert.equal(key("a", { key: "ArrowUp" }), false, "a plain arrow is not a move");
  assert.equal(key("a", { altKey: true, metaKey: true, key: "ArrowUp" }), false);
  assert.deepEqual(moves, [["starred", "b", 1], ["channels", "a", -1]]);
  assert.equal(link("d").listeners.keydown, undefined, "a row that cannot move has no shortcut");
  assert.equal(link("a").attrs["aria-keyshortcuts"], "Alt+ArrowUp Alt+ArrowDown");

  assert.deepEqual(["general", "b", "a", "c", "d"].map((id) => [item(id).draggable === true, item(id).dataset.railReorder]),
    [[true, "starred"], [true, "starred"], [true, "channels"], [true, "channels"], [false, undefined]]);
  assert.deepEqual(find(root, (node) => node.dataset?.railChannelMenu !== undefined).map((menu) => menu.dataset.railChannelMenu),
    ["b", "general", "a", "c"], "a movable row has a ⋯ even when the viewer cannot manage the channel");

  const transfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  const fire = (id, name) => { let prevented = false; item(id).listeners[name]({ dataTransfer: transfer, preventDefault() { prevented = true; } }); return prevented; };
  fire("a", "dragstart");
  assert.equal(fire("c", "dragover"), true, "a row of the same list accepts it");
  assert.equal(fire("b", "dragover"), false, "a row of the other list does not");
  assert.equal(fire("a", "dragover"), false, "nor does the row itself");
  fire("b", "drop");
  assert.deepEqual(drops, []);
  fire("c", "drop");
  assert.deepEqual(drops, [["channels", "a", "c"]]);
  assert.equal(fire("c", "dragover"), false, "nothing is being dragged once it has dropped");
});

test("a sample rail and an archived row never move", () => {
  const vm = ready([row("a", "design", { reorder: "channels" }), row("c", "qa", { reorder: "channels" })],
    { archived: [row("z", "old", { reorder: "channels" })], channelsExpanded: true });
  const build = (sample) => buildHomeRail(doc, { sample, catchUp: { href: "/app?v=catchup", current: false, needsYou: null }, workspaces: [], people: null, channels: vm },
    { openPerson() {}, openAgent() {}, selectChannel() {}, channelMenu() {}, moveChannel() {}, dropChannel() {} }, { archivedOpen: true });
  const shortcut = (root, id) => typeof find(root, (node) => node.dataset?.railChannel === id)[0].listeners.keydown;
  assert.deepEqual(["a", "c", "z"].map((id) => shortcut(build(false), id)), ["function", "function", "undefined"],
    "live rows move; an archived row does not");
  assert.deepEqual(["a", "c", "z"].map((id) => shortcut(build(true), id)), ["undefined", "undefined", "undefined"]);
});
