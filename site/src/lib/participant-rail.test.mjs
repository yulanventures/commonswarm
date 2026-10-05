import assert from "node:assert/strict";
import { test } from "node:test";
import { groupParticipantsByOwner } from "./participant-rail.ts";

const members = [
  { userId: "zoe", name: "Zoe", role: "member" },
  { userId: "b-alex", name: "Alex", role: "owner" },
  { userId: "tom", name: "Tom", role: "admin" },
  { userId: "a-alex", name: "alex", role: "admin" },
];
const agents = [
  { principalId: "z", name: "zeta", ownerUserId: "tom" },
  { principalId: "a", name: "alpha", ownerUserId: "tom" },
  { principalId: "m", name: "muse", ownerUserId: "zoe" },
  { principalId: "o", name: "orphan", ownerUserId: "left" },
];
const headings = (groups) => groups.map((group) => group.kind === "member" ? group.member.userId : group.label);

test("without a viewer the order stays alphabetical, with unresolved owners last", () => {
  assert.deepEqual(headings(groupParticipantsByOwner(members, agents)), ["a-alex", "b-alex", "tom", "zoe", "Owner unavailable"]);
  assert.deepEqual(headings(groupParticipantsByOwner(members, agents, {})), ["a-alex", "b-alex", "tom", "zoe", "Owner unavailable"]);
  assert.deepEqual(headings(groupParticipantsByOwner(members, agents, { viewerId: null })), ["a-alex", "b-alex", "tom", "zoe", "Owner unavailable"]);
});

test("the viewer's group comes first; everyone else keeps the alphabetical order", () => {
  const groups = groupParticipantsByOwner(members, agents, { viewerId: "tom" });
  assert.deepEqual(headings(groups), ["tom", "a-alex", "b-alex", "zoe", "Owner unavailable"]);
  assert.deepEqual(groups[0].agents.map((agent) => agent.principalId), ["a", "z"], "the viewer's agents stay nested under the viewer");
  assert.deepEqual(headings(groupParticipantsByOwner(members, agents, { viewerId: "zoe" })), ["zoe", "a-alex", "b-alex", "tom", "Owner unavailable"]);
});

test("a viewer who is not a member changes nothing, and never moves the unresolved group", () => {
  assert.deepEqual(headings(groupParticipantsByOwner(members, agents, { viewerId: "left" })), ["a-alex", "b-alex", "tom", "zoe", "Owner unavailable"]);
  assert.deepEqual(groupParticipantsByOwner(members, agents, { viewerId: "left" }).at(-1).agents.map((agent) => agent.principalId), ["o"]);
});

test("the input arrays are not reordered", () => {
  const before = members.map((member) => member.userId);
  groupParticipantsByOwner(members, agents, { viewerId: "zoe" });
  assert.deepEqual(members.map((member) => member.userId), before);
});
