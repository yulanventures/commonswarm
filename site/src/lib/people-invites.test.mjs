import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleInvites, cancelPeopleInvite, peopleInviteConfirmCopy } from "./people-invites.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const at = (days) => new Date(NOW + days * 86_400_000).toISOString();
const W = "11111111-1111-4111-8111-111111111111";
const names = new Map([["ana", "Ana Rivera"], ["sam", "Sam Rivera"]]);
const key = (overrides = {}) => ({ workspaceId: W, principalId: "p-river", ownerUserId: "sam", agentName: "River", tokenId: "t-river",
  issuedAt: at(-3), expiresAt: at(4), firstUsedAt: null, revokedAt: null, ...overrides });
const input = (viewer, overrides = {}) => ({ workspaceId: W, now: NOW, viewer,
  nameOf: (id) => names.get(id) ?? null, relative: (iso) => `<${iso.slice(0, 10)}>`,
  invites: [{ workspaceId: W, invitationId: "i-mei", email: "mei@example.test", createdBy: "ana", createdAt: at(-2), expiresAt: at(5) }],
  access: [key()],
  pending: [
    { kind: "join", principalId: null, principalName: null, joinCredentialId: "c-code", ownerUserId: "sam", issuerDisplay: "Sam Rivera", issuedAt: at(0), expiresAt: at(1), seatsUsed: 1, seatCap: 3 },
    { kind: "classic", principalId: "p-grok", principalName: "Grok", joinCredentialId: null, ownerUserId: "sam", issuerDisplay: "Sam Rivera", issuedAt: at(-6), expiresAt: null, seatsUsed: null, seatCap: null },
    // The server lists River here too; its unused key already stands for it.
    { kind: "classic", principalId: "p-river", principalName: "River", joinCredentialId: null, ownerUserId: "sam", issuerDisplay: "Sam Rivera", issuedAt: at(-3), expiresAt: at(4), seatsUsed: null, seatCap: null },
  ], ...overrides });
const may = (rows) => Object.fromEntries(rows.map((row) => [row.kind, row.mayCancel]));

test("an owner or admin may cancel every invite; each row appears once", () => {
  const rows = peopleInvites(input({ userId: "ana", elevated: true }));
  assert.deepEqual(rows.map((row) => [row.kind, row.id]), [["person", "i-mei"], ["key", "t-river"], ["code", "c-code"], ["agent", "p-grok"]]);
  assert.deepEqual(may(rows), { person: true, key: true, code: true, agent: true });
});
test("a member may cancel only what is their own, never a person's invitation", () => {
  assert.deepEqual(may(peopleInvites(input({ userId: "sam", elevated: false }))), { person: false, key: true, code: true, agent: true });
  assert.deepEqual(may(peopleInvites(input({ userId: "ana", elevated: false }))), { person: false, key: false, code: false, agent: false });
});
test("with no viewer nothing can be cancelled", () => {
  assert.deepEqual(may(peopleInvites(input(null))), { person: false, key: false, code: false, agent: false });
});
test("a used, turned-off or ended key is not an invite", () => {
  for (const gone of [{ firstUsedAt: at(-1) }, { revokedAt: at(-1) }, { expiresAt: at(-1) }]) {
    const rows = peopleInvites(input({ userId: "ana", elevated: true }, { access: [key(gone)], pending: [] }));
    assert.deepEqual(rows.map((row) => row.kind), ["person"]);
  }
});
test("each row says who and when", () => {
  const rows = peopleInvites(input({ userId: "ana", elevated: true }));
  const detail = Object.fromEntries(rows.map((row) => [row.kind, row.detail]));
  assert.equal(detail.person, "You invited · <2026-11-16> · ends <2026-11-23>");
  assert.equal(detail.key, "Sam’s agent · made <2026-11-15> · ends <2026-11-22>");
  assert.equal(detail.code, "Sam made it · <2026-11-18> · 1 of 3 places used · ends <2026-11-19>");
  assert.equal(detail.agent, "Sam’s agent · added <2026-11-12> · never connected");
});
test("Cancel sends the row's own id through the command for its kind, and no other", async () => {
  for (const [kind, id] of [["person", "i-mei"], ["key", "t-river"], ["code", "c-code"], ["agent", "p-grok"]]) {
    const sent = [];
    const send = Object.fromEntries(["person", "key", "code", "agent"].map((name) => [name, async (value) => { sent.push([name, value]); }]));
    await cancelPeopleInvite({ kind, id }, send);
    assert.deepEqual(sent, [[kind, id]]);
  }
});
test("a refused cancellation reaches the caller", async () => {
  const refuse = async () => { throw new Error("refused"); };
  await assert.rejects(cancelPeopleInvite({ kind: "code", id: "c-code" }, { person: refuse, key: refuse, code: refuse, agent: refuse }), /refused/);
});
test("the confirmation for a never-connected agent says it is removed, not cancelled", () => {
  assert.equal(peopleInviteConfirmCopy({ kind: "agent", name: "Grok" }).button, "Remove Grok");
  assert.equal(peopleInviteConfirmCopy({ kind: "code", name: "Connect code" }).stays[0], "Agents that already joined with it stay.");
});
