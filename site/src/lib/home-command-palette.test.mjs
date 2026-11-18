/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandPaletteItems, commandPaletteStart, filterCommandPaletteItems, rememberPalettePlace } from "./home-command-palette.ts";

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
