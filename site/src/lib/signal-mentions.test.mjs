/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserSignalCommand, signalMentionsFromRows } from "./commonswarm.ts";
import { chatSignalShapeProblem } from "../../../supabase/functions/_shared/channels.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const SIGNAL = "33333333-3333-4333-8333-333333333333";

test("a public post carries its mentions by id and no recipient", () => {
  const command = browserSignalCommand("@Wren and @Dana, look", [], "note", [],
    { channel: "design", mentions: [{ kind: "agent", id: AGENT }, { kind: "person", id: PERSON }] });
  assert.deepEqual(command.mentions, [{ kind: "agent", id: AGENT }, { kind: "user", id: PERSON }]);
  assert.equal(Object.hasOwn(command, "to"), false);
  assert.equal(command.to_user_id, null);
  assert.equal(command.to_agent_principal_id, null);
  assert.equal(command.channel, "design");
  const reply = browserSignalCommand("@Wren", [], "note", [], { threadRootId: SIGNAL, mentions: [{ kind: "agent", id: AGENT }] });
  assert.deepEqual(reply.mentions, [{ kind: "agent", id: AGENT }]);
  assert.equal(reply.thread_root_id, SIGNAL);
});

test("a public post always carries the mentions key, empty when nobody is tagged; an addressed one never does", () => {
  // The key is what makes a deployment with mentions off refuse the post instead of re-addressing it to the lead.
  for (const placement of [{ mentions: [] }, { channel: "design", mentions: [] }, { threadRootId: SIGNAL, mentions: [] }]) {
    const command = browserSignalCommand("hello", [], "note", [], placement);
    assert.deepEqual(command.mentions, [], JSON.stringify(placement));
    assert.equal(Object.hasOwn(command, "to"), false);
  }
  // A Direct Message, and any caller that states no public intent, sends the body installed clients always sent.
  assert.equal(Object.hasOwn(browserSignalCommand("hi", [{ kind: "agent", id: AGENT }], "ask"), "mentions"), false);
  assert.equal(Object.hasOwn(browserSignalCommand("hi", [], "note", [], { channel: "design" }), "mentions"), false);
});

test("a message is addressed or it mentions, never both", () => {
  assert.throws(() => browserSignalCommand("hi", [{ kind: "agent", id: AGENT }], "ask", [],
    { mentions: [{ kind: "person", id: PERSON }] }), /addressed or it mentions/);
  assert.throws(() => browserSignalCommand("hi", [{ kind: "agent", id: AGENT }], "ask", [], { mentions: [] }),
    /addressed or it mentions/, "even an empty public intent cannot ride on an addressed message");
});

test("mention rows are read by id, in the author's order, and anything malformed is dropped", () => {
  const rows = signalMentionsFromRows([
    { signal_id: SIGNAL, position: 1, kind: "user", id: PERSON.toUpperCase(), source: "author" },
    { signal_id: SIGNAL.toUpperCase(), position: 0, kind: "agent", id: AGENT, source: "author" },
    { signal_id: SIGNAL, position: 2, kind: "agent", id: "44444444-4444-4444-8444-444444444444", source: "lead" },
    { signal_id: SIGNAL, position: 3, kind: "robot", id: AGENT, source: "author" },
    { signal_id: SIGNAL, position: 4, kind: "agent", id: AGENT, source: "guess" },
    { signal_id: SIGNAL, position: "5", kind: "agent", id: AGENT, source: "author" },
    { position: 6, kind: "agent", id: AGENT, source: "author" },
    null,
  ]);
  assert.deepEqual(rows.map((row) => `${row.position}:${row.kind}:${row.id}:${row.source}`), [
    `0:agent:${AGENT}:author`,
    `1:person:${PERSON}:author`,
    "2:agent:44444444-4444-4444-8444-444444444444:lead",
  ]);
  assert.ok(rows.every((row) => row.signalId === SIGNAL));
  assert.deepEqual(signalMentionsFromRows(null), []);
});

test("the command function's own shape check accepts exactly what the browser sends", () => {
  // The browser body always carries the scalar recipient fields and in_reply_to as null. The edge refuses mentions
  // beside a recipient or a private reply, and that rule has to read null as absent.
  const mentions = [{ kind: "agent", id: AGENT }, { kind: "person", id: PERSON }];
  for (const placement of [{ channel: "design", mentions }, { mentions }, { threadRootId: SIGNAL, mentions },
    { threadRootId: SIGNAL, broadcastToChannel: true, mentions }]) {
    assert.equal(chatSignalShapeProblem(browserSignalCommand("@Wren @Dana look", [], "note", [], placement)), null, JSON.stringify(placement));
  }
  assert.equal(chatSignalShapeProblem(browserSignalCommand("hello", [], "note", [], { channel: "design", mentions: [] })), null,
    "an untagged public post, as the composer sends it");
  assert.equal(chatSignalShapeProblem(browserSignalCommand("hi", [{ kind: "agent", id: AGENT }], "ask")), null, "a Direct Message is unchanged");
});
