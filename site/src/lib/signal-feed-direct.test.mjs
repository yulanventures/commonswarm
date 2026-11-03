import assert from "node:assert/strict";
import { test } from "node:test";
import { signalIsDirectBetween } from "./signal-feed.ts";

const me = "u-me", nikki = "u-nikki", muse = "a-muse", other = "a-other";
const s = (from, fromKind, to, toAgent) => ({ from, fromKind, to, toAgent });

test("a 1:1 view holds only what the viewer and that teammate addressed to each other", () => {
  const agent = { kind: "agent", id: muse };
  assert.equal(signalIsDirectBetween(s(me, "user", null, muse), me, agent), true, "viewer to the agent");
  assert.equal(signalIsDirectBetween(s(muse, "agent", me, null), me, agent), true, "the agent to the viewer");
  assert.equal(signalIsDirectBetween(s(me, "user", null, null), me, agent), false, "a broadcast is not a DM");
  assert.equal(signalIsDirectBetween(s(me, "user", null, other), me, agent), false, "another agent");
  assert.equal(signalIsDirectBetween(s(muse, "agent", nikki, null), me, agent), false, "the agent to someone else");
  assert.equal(signalIsDirectBetween(s(nikki, "user", null, muse), me, agent), false, "someone else to the agent");

  const person = { kind: "person", id: nikki };
  assert.equal(signalIsDirectBetween(s(me, "user", nikki, null), me, person), true);
  assert.equal(signalIsDirectBetween(s(nikki, "user", me, null), me, person), true);
  assert.equal(signalIsDirectBetween(s(nikki, "agent", me, null), me, person), false, "an agent that shares the id is not the person");
  assert.equal(signalIsDirectBetween(s(me, "user", me, null), me, { kind: "person", id: me }), false, "no DM with yourself");
  assert.equal(signalIsDirectBetween(s(me, "user", null, muse), "", agent), false, "no viewer, no DM");
});
