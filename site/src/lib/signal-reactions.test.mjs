/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addReaction, removeReaction, signalReactionGroupsFromRows } from "./commonswarm.ts";
import { REACTION_PICKER_EMOJIS, joinNames, pickerMove, reactionNames, reactionPillLabel } from "./reactions.ts";

const SIGNAL = "44444444-4444-4444-8444-444444444444";
const OTHER_SIGNAL = "66666666-6666-4666-8666-666666666666";
const VIEWER = "55555555-5555-4555-8555-555555555555";
const PERSON = "77777777-7777-4777-8777-777777777777";
const AGENT = "22222222-2222-4222-8222-222222222222";

const row = (overrides = {}) => ({
  reaction_id: "r", signal_id: SIGNAL, kind: "user", id: VIEWER, emoji: "\u{1F44D}", source: "manual",
  created_at: "2026-11-16T10:00:00.000Z", ...overrides,
});

test("reactions group per message and emoji, in the order each emoji was first added, with counts and mine", () => {
  const groups = signalReactionGroupsFromRows([
    // Out of order on purpose: grouping follows created_at, not the order rows arrive in.
    row({ reaction_id: "3", id: PERSON, created_at: "2026-11-16T10:00:03.000Z" }),
    row({ reaction_id: "1", kind: "agent", id: AGENT, emoji: "\u{1F440}", source: "ack", created_at: "2026-11-16T10:00:01.000Z" }),
    row({ reaction_id: "2", id: VIEWER.toUpperCase(), created_at: "2026-11-16T10:00:02.000Z" }),
    row({ reaction_id: "4", signal_id: OTHER_SIGNAL.toUpperCase(), id: PERSON, emoji: "\u{1F389}" }),
  ], VIEWER);
  assert.deepEqual(groups.get(SIGNAL), [
    { emoji: "\u{1F440}", count: 1, actors: [{ kind: "agent", id: AGENT }], mine: false },
    { emoji: "\u{1F44D}", count: 2, actors: [{ kind: "person", id: VIEWER }, { kind: "person", id: PERSON }], mine: true },
  ]);
  assert.deepEqual(groups.get(OTHER_SIGNAL), [{ emoji: "\u{1F389}", count: 1, actors: [{ kind: "person", id: PERSON }], mine: false }]);
});

test("an agent with the viewer's id is not the viewer, and a repeated row counts once", () => {
  const groups = signalReactionGroupsFromRows([row({ kind: "agent", id: VIEWER }), row({ kind: "agent", id: VIEWER, reaction_id: "x" })], VIEWER);
  assert.deepEqual(groups.get(SIGNAL), [{ emoji: "\u{1F44D}", count: 1, actors: [{ kind: "agent", id: VIEWER }], mine: false }]);
});

test("malformed rows are dropped and anything but an array is no reactions", () => {
  for (const bad of [null, {}, "x"]) assert.equal(signalReactionGroupsFromRows(bad, VIEWER).size, 0);
  const groups = signalReactionGroupsFromRows([
    null, row({ kind: "robot" }), row({ emoji: "" }), row({ signal_id: 7 }), row({ id: null }), row({ created_at: "soon" }), row(),
  ], VIEWER);
  assert.deepEqual([...groups.keys()], [SIGNAL]);
  assert.equal(groups.get(SIGNAL)?.[0]?.count, 1);
});

test("the picker offers each shortcode's emoji once, in shortcode order", () => {
  assert.equal(REACTION_PICKER_EMOJIS.length, 12);
  assert.equal(new Set(REACTION_PICKER_EMOJIS).size, 12);
  assert.deepEqual(REACTION_PICKER_EMOJIS.slice(0, 4), ["\u{1F440}", "\u{1F44D}", "\u{1F44E}", "✅"]);
  assert.equal(REACTION_PICKER_EMOJIS.at(-1), "\u{1F4AF}");
});

test("a pill names who reacted, the viewer as you, and what a click does", () => {
  const group = { emoji: "\u{1F44D}", count: 3, actors: [{ kind: "person", id: PERSON }, { kind: "person", id: VIEWER }, { kind: "agent", id: AGENT }], mine: true };
  const names = reactionNames(group, VIEWER, actor => (actor.kind === "agent" ? "Muse" : "Dana"));
  assert.equal(names, "you, Dana and Muse");
  assert.equal(reactionPillLabel(group, names), "\u{1F44D} 3, you, Dana and Muse; remove yours");
  assert.equal(reactionPillLabel({ ...group, mine: false }, "Dana"), "\u{1F44D} 3, Dana; add yours");
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["A", "B"]), "A and B");
});

test("arrow keys move through the picker's grid", () => {
  assert.equal(pickerMove("ArrowRight", 11, 12, 6), 0);
  assert.equal(pickerMove("ArrowLeft", 0, 12, 6), 11);
  assert.equal(pickerMove("ArrowDown", 2, 12, 6), 8);
  assert.equal(pickerMove("ArrowDown", 8, 12, 6), 11);
  assert.equal(pickerMove("ArrowUp", 8, 12, 6), 2);
  assert.equal(pickerMove("Home", 5, 12, 6), 0);
  assert.equal(pickerMove("End", 5, 12, 6), 11);
  assert.equal(pickerMove("a", 5, 12, 6), null);
});

test("a person's add and remove send the command the edge takes, and a refusal keeps its reason", async (t) => {
  const realDocument = globalThis.document, realFetch = globalThis.fetch;
  t.after(() => { globalThis.document = realDocument; globalThis.fetch = realFetch; });
  globalThis.document = { querySelector: (selector) => selector.includes("commonswarm:url") ? { content: "https://deployment.test" }
    : selector.includes("commonswarm:anon-key") ? { content: "anon-test-key" } : null };
  const sent = [];
  let reply = { status: 200, body: { status: "accepted", signal_id: SIGNAL, emoji: "\u{1F44D}", added: true } };
  globalThis.fetch = async (url, init) => {
    sent.push({ url, envelope: JSON.parse(init.body) });
    return { status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  const session = { access_token: "jwt", user: { id: VIEWER } };
  assert.deepEqual(await addReaction(session, "web_1", "W", SIGNAL, "\u{1F44D}"), { ok: true, changed: true });
  reply = { status: 200, body: { status: "accepted", signal_id: SIGNAL, emoji: "\u{1F44D}", removed: false } };
  assert.deepEqual(await removeReaction(session, "web_2", "W", SIGNAL, "\u{1F44D}"), { ok: true, changed: false });
  assert.equal(sent[0].url, "https://deployment.test/functions/v1/command");
  // A person never sends source: the edge takes exactly {kind, signal_id, emoji} from them.
  assert.deepEqual(sent.map(({ envelope }) => ({ ...envelope, client_version: undefined })), [
    { command_id: "web_1", client_version: undefined, command: { kind: "add_reaction", signal_id: SIGNAL, emoji: "\u{1F44D}" }, workspace_id: "W", stream: { kind: "workspace" } },
    { command_id: "web_2", client_version: undefined, command: { kind: "remove_reaction", signal_id: SIGNAL, emoji: "\u{1F44D}" }, workspace_id: "W", stream: { kind: "workspace" } },
  ]);
  reply = { status: 409, body: { error: "reaction_limit_reached", message: "a reactor may add at most 64 emojis to one message" } };
  const refused = await addReaction(session, "web_3", "W", SIGNAL, "\u{1F525}");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "reaction_limit_reached");
  reply = { status: 404, body: { error: "signal_not_found" } };
  assert.equal((await removeReaction(session, "web_4", "W", SIGNAL, "\u{1F525}")).reason, "signal_not_found");
});
