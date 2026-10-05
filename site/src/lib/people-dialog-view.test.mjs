import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleDialogGroups, peopleDialogCounts, peopleDialogAccessUntil, peopleDialogCanAct, peopleConfirmationCopy } from "./people-dialog-view.ts";
const person = (id, name, role = "member", own = false, mayRemove = false) => ({ id, name, role, own, mayRemove });
const agent = (id, ownerId, overrides = {}) => ({ id, ownerId, name: id, app: null, model: null, ownerName: ownerId === "tom" ? "Tom Langridge" : "Mei Langridge", own: false, mayManage: false, liveKey: false, access: null, status: { kind: "active", attention: false, fix: { allowed: false } }, ...overrides });
const model = () => ({ people: [person("tom", "Tom Langridge", "owner"), person("mei", "Mei Langridge")], agents: [agent("Claude", "tom"), agent("Dot", "mei", { app: "ChatGPT" }), agent("Muse", "mei", { model: "Muse Spark" }), agent("Orphan", "gone")], invites: [{ id: "invite", kind: "invite", name: "friend@example.test", mayCancel: false }], sample: false });

test("counts separate people, agents and attention without asserting health", () => {
  const data = model(); data.agents[2].status.attention = true;
  assert.equal(peopleDialogCounts(data), "2 people · 4 agents · 1 need attention");
  data.agents[2].status.attention = false; assert.equal(peopleDialogCounts(data), "2 people · 4 agents");
  assert.equal(peopleDialogCounts({ ...data, people: [data.people[0]], agents: [] }), "1 person · 0 agents");
});
test("grouping excludes orphans from people cards and searches names, apps and models", () => {
  const data = model();
  assert.deepEqual(peopleDialogGroups(data, "").groups.map((group) => [group.person.id, group.agents.map((agent) => agent.id)]), [["tom",["Claude"]],["mei",["Dot","Muse"]]]);
  assert.deepEqual(peopleDialogGroups(data, "").other.map((agent) => agent.id), ["Orphan"]);
  assert.deepEqual(peopleDialogGroups(data, "Mei").groups.map((group) => group.agents.map((agent) => agent.id)), [["Dot","Muse"]]);
  assert.deepEqual(peopleDialogGroups(data, "chatgpt").groups[0].agents.map((agent) => agent.id), ["Dot"]);
  assert.deepEqual(peopleDialogGroups(data, "spark").groups[0].agents.map((agent) => agent.id), ["Muse"]);
  assert.equal(peopleDialogGroups(data, "absent").groups.length, 0);
});
test("Lists & docs duration names the person who can withdraw, or uses the returned date", () => {
  const value = agent("Muse", "mei", { access: { until: null } });
  assert.equal(peopleDialogAccessUntil(value), "Allowed until Mei withdraws it.");
  assert.equal(peopleDialogAccessUntil({ ...value, own: true }), "Allowed until you withdraw it.");
  assert.equal(peopleDialogAccessUntil({ ...value, access: { until: "Oct 9, 2026" } }), "Allowed until Oct 9, 2026.");
  assert.equal(peopleDialogAccessUntil({ ...value, access: null }), "Not allowed.");
});
test("read-only, elevated, owner and sample action gates are distinct", () => {
  const data = model(); const value = data.agents[2];
  for (const action of ["resume","new-key","remove-agent","turn-off-key","withdraw","remove-person","cancel-invite"]) assert.equal(peopleDialogCanAct(data, action, value.id), false);
  value.mayManage = true; value.liveKey = true; value.access = { until: null }; value.status = { kind: "paused", fix: { allowed: true } };
  for (const action of ["resume","remove-agent","turn-off-key"]) assert.equal(peopleDialogCanAct(data, action, value.id), true);
  assert.equal(peopleDialogCanAct(data, "withdraw", value.id), false); assert.equal(peopleDialogCanAct(data, "new-key", value.id), false);
  value.own = true; assert.equal(peopleDialogCanAct(data, "withdraw", value.id), true); assert.equal(peopleDialogCanAct(data, "new-key", value.id), true);
  value.status.kind = "key-off"; value.liveKey = false; assert.equal(peopleDialogCanAct(data, "resume", value.id), false); assert.equal(peopleDialogCanAct(data, "turn-off-key", value.id), false);
  data.people[1].mayRemove = true; assert.equal(peopleDialogCanAct(data, "remove-person", "mei"), true);
  data.people[1].own = true; assert.equal(peopleDialogCanAct(data, "remove-person", "mei"), false);
  data.invites[0].mayCancel = true; assert.equal(peopleDialogCanAct(data, "cancel-invite", "invite"), true);
  data.sample = true; for (const action of ["new-key","remove-agent","withdraw","connected-apps","allow"]) assert.equal(peopleDialogCanAct(data, action, value.id), false);
  assert.equal(peopleDialogCanAct(data, "cancel-invite", "invite"), false);
});
test("confirm consequences distinguish permanent identity removal, key timing and reversible access", () => {
  const removed = peopleConfirmationCopy("remove-agent", { name: "Muse", hosted: true });
  assert.deepEqual(removed.stops, ["Muse will lose access to this space. Its identity and every connection will end.", "This cannot be undone."]);
  assert.deepEqual(removed.stays, ["Its history stays as “Muse (removed)”.", "Its owner can connect a new agent with the same name."]);
  assert.equal(peopleConfirmationCopy("turn-off-key", { name: "Muse" }).stops[0], "Muse stops when its current access ends.");
  assert.equal(peopleConfirmationCopy("withdraw", { name: "Muse" }).stays[0], "Existing lists, docs and history stay.");
  assert.equal(peopleConfirmationCopy("remove-person", { name: "Mei" }).stays[0], "History stays. Their other spaces are unaffected.");
  assert.equal(peopleConfirmationCopy("cancel-invite", { name: "Mei", kind: "invite" }).title, "Cancel this invitation?");
  assert.equal(peopleConfirmationCopy("cancel-invite", { name: "Muse", kind: "agent" }).title, "Cancel this unused key?");
});
