/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandPaletteItems, commandPaletteStart, filterCommandPaletteItems, rememberPalettePlace, renderCommandPaletteList } from "./home-command-palette.ts";

const input = { agents: [], members: [], channels: [], leadAgentPrincipalId: null, maySetLead: false };
const offersNewChannel = (extra) =>
  buildCommandPaletteItems({ ...input, ...extra }).some((item) => item.action.type === "new-channel");

test("the palette offers New channel unless the workspace keeps it from this person", () => {
  assert.equal(offersNewChannel({}), true);
  assert.equal(offersNewChannel({ mayCreateChannel: true }), true);
  assert.equal(offersNewChannel({ mayCreateChannel: false }), false);
});

const agent = (id, name) => ({ principalId: id, name, model: null, transport: "local", turnOnly: false, revokedAt: null });
const workspace = (extra = {}) => buildCommandPaletteItems({
  ...input,
  agents: [agent("a1", "Atlas"), agent("a2", "Ledger")],
  members: [{ userId: "u1", name: "Rivera" }],
  channels: ["design", "renovation", "boiler", "garden", "school", "travel"].map((slug) => ({ slug })),
  ...extra,
});
const ids = (items) => items.map((item) => item.id);

test("before anything is typed the palette offers a few places and a few actions, not the roster", () => {
  const items = workspace();
  const start = commandPaletteStart(items, []);
  assert.ok(items.length > 15, "the roster itself is long");
  assert.deepEqual(ids(start), [
    "channel:__all__", "channel:general", "channel:design", "channel:renovation", "channel:boiler",
    "action:new-channel", "action:connect-agent", "action:todos", "action:files", "action:people",
  ]);
  assert.deepEqual([...new Set(start.map((item) => item.section))], ["Jump to", "Actions"]);
  // The items themselves are untouched: typing still groups them by kind.
  assert.ok(items.every((item) => item.section === undefined));
});

test("recent places come first, newest first, and never the place the person is in", () => {
  const items = workspace();
  const start = commandPaletteStart(items, ["teammate:agent:a2", "channel:travel", "channel:gone", "channel:design"], "channel:travel");
  assert.deepEqual(ids(start).slice(0, 5), ["teammate:agent:a2", "channel:design", "channel:__all__", "channel:general", "channel:renovation"]);
  // Six recent places: five are offered.
  const many = commandPaletteStart(items, ["channel:travel", "channel:school", "channel:garden", "channel:boiler", "channel:renovation", "channel:design"]);
  assert.deepEqual(ids(many).slice(0, 5), ["channel:travel", "channel:school", "channel:garden", "channel:boiler", "channel:renovation"]);
  // An action is never remembered as a place.
  assert.equal(ids(commandPaletteStart(items, ["action:theme"]))[0], "channel:__all__");
});

test("New channel is not among the start actions for someone who may not create one", () => {
  assert.equal(ids(commandPaletteStart(workspace({ mayCreateChannel: false }), [])).includes("action:new-channel"), false);
});

test("a visited place moves to the front of the remembered ones, and only eight are kept", () => {
  assert.deepEqual(rememberPalettePlace(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(rememberPalettePlace([], "a"), ["a"]);
  assert.equal(rememberPalettePlace(["1", "2", "3", "4", "5", "6", "7", "8"], "9").join(""), "91234567");
});

test("typed results stay grouped by kind, the best match's kind first", () => {
  const items = buildCommandPaletteItems({
    ...input,
    agents: [agent("a1", "Design agent")],
    members: [{ userId: "u1", name: "Des" }],
    channels: [{ slug: "design" }, { slug: "redesign" }],
  });
  const kinds = filterCommandPaletteItems(items, "des").map((item) => item.category);
  assert.ok(kinds.length >= 4);
  // Each kind appears as one unbroken run.
  assert.equal(kinds.filter((kind, index) => index === 0 || kinds[index - 1] !== kind).length, new Set(kinds).size);
  assert.equal(kinds[0], "teammate");
  assert.equal(filterCommandPaletteItems(items, "").length, items.length);
});

/** The least of a DOM that the renderer touches. */
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.className = ""; this.id = ""; this.textContent = ""; this.listeners = {}; }
  get classList() { return { add: (name) => { this.className += ` ${name}`; } }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
}
const fakeDocument = { createElement: (tag) => new Node(tag) };

test("the results are a listbox the search box can name: named groups of options, each with an id", () => {
  const container = new Node("div");
  const items = commandPaletteStart(workspace(), []);
  const chosen = [];
  const selected = renderCommandPaletteList(fakeDocument, container, items, 7, (item) => chosen.push(item.id));
  const nodes = container.all();
  const groups = nodes.filter((node) => node.tag === "section");
  assert.deepEqual(groups.map((group) => group.attributes.role), ["group", "group"]);
  for (const group of groups) {
    const heading = group.children[0];
    assert.ok(heading.id && group.attributes["aria-labelledby"] === heading.id, "each group is named by its own heading");
  }
  assert.equal(new Set(groups.map((group) => group.children[0].id)).size, 2);
  // Nothing between the listbox and its options claims to be a list.
  for (const node of nodes.filter((n) => n.tag === "ul" || n.tag === "li")) assert.equal(node.attributes.role, "presentation");
  const options = nodes.filter((node) => node.tag === "button");
  assert.equal(options.length, items.length);
  assert.ok(options.every((option) => option.attributes.role === "option"));
  assert.deepEqual(options.map((option) => option.id), items.map((_, index) => `cp-option-${index}`));
  // Exactly one is selected, and it is the one handed back for the search box to name.
  assert.deepEqual(options.filter((option) => option.attributes["aria-selected"] === "true"), [selected]);
  assert.equal(selected.id, "cp-option-7");
  selected.listeners.click();
  assert.deepEqual(chosen, [items[7].id]);
  // No results: nothing is selected.
  assert.equal(renderCommandPaletteList(fakeDocument, container, [], 0, () => {}), null);
});
