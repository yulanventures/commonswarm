import assert from "node:assert/strict";
import { test } from "node:test";
import { directConversationFilter, signalIsDirectBetween } from "./signal-feed.ts";

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

/** Reads the filter the way PostgREST does for this shape: a top-level or of and-groups of column.eq.value. */
const matches = (filter, row) => filter.slice(4, -1).split("),and(").some(group =>
  group.split(",").every(term => {
    const [column, op, value] = term.split(".");
    assert.equal(op, "eq");
    const key = { from_kind: "fromKind", to_agent: "toAgent" }[column] ?? column;
    return row[key] === value;
  }));

test("the conversation query selects exactly the rows the 1:1 view keeps", () => {
  const viewer = "11111111-1111-4111-8111-111111111111";
  const person = "22222222-2222-4222-8222-222222222222";
  const agent = "33333333-3333-4333-8333-333333333333";
  const stranger = "44444444-4444-4444-8444-444444444444";
  const partners = [{ kind: "person", id: person }, { kind: "agent", id: agent }];
  const ids = [viewer, person, agent, stranger];
  const rows = [];
  for (const from of ids) for (const fromKind of ["user", "agent"]) for (const to of [null, ...ids]) for (const toAgent of [null, ...ids]) {
    rows.push(s(from, fromKind, to, toAgent));
  }
  for (const partner of partners) {
    const filter = directConversationFilter(viewer, partner);
    assert.ok(filter !== null);
    let kept = 0;
    for (const row of rows) {
      const want = signalIsDirectBetween(row, viewer, partner);
      assert.equal(matches(filter, row), want, `${partner.kind} ${JSON.stringify(row)}`);
      if (want) kept++;
    }
    assert.ok(kept > 0, "control: the table holds rows of the conversation");
  }
  assert.equal(
    directConversationFilter(viewer, { kind: "agent", id: agent }),
    `and(from_kind.eq.user,from.eq.${viewer},to_agent.eq.${agent}),and(from_kind.eq.agent,from.eq.${agent},to.eq.${viewer})`,
  );
  // tests/p1-server/multiworkspace-agent-reads.test.ts sends this exact shape through PostgREST.
  assert.equal(
    directConversationFilter(viewer, { kind: "person", id: person }),
    `and(from_kind.eq.user,from.eq.${viewer},to.eq.${person}),and(from_kind.eq.user,from.eq.${person},to.eq.${viewer})`,
  );
});

test("no conversation query without a viewer, with yourself, or with an id that is not a UUID", () => {
  const viewer = "11111111-1111-4111-8111-111111111111";
  assert.equal(directConversationFilter("", { kind: "person", id: "22222222-2222-4222-8222-222222222222" }), null);
  assert.equal(directConversationFilter(viewer, { kind: "person", id: viewer }), null);
  assert.equal(directConversationFilter(viewer, { kind: "agent", id: "x),or(to.is.null" }), null);
  assert.equal(directConversationFilter("sample-owner", { kind: "agent", id: "22222222-2222-4222-8222-222222222222" }), null);
});
