import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleInvites, cancelPeopleInvite, peopleInviteCancelLabel, peopleInviteConfirmCopy, peopleInviteDisplayDetail } from "./people-invites.ts";

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
    // Agents with no used key, as the pending read lists them. Grok has no key at all; River's unused key is above.
    { kind: "classic", principalId: "p-river", principalName: "River", joinCredentialId: null, ownerUserId: "sam", issuerDisplay: "Sam Rivera", issuedAt: at(-3), expiresAt: at(4), seatsUsed: null, seatCap: null },
  ], ...overrides });
const may = (rows) => Object.fromEntries(rows.map((row) => [row.kind, row.mayCancel]));

test("an owner or admin may cancel every invite; each row appears once", () => {
  const rows = peopleInvites(input({ userId: "ana", elevated: true }));
  assert.deepEqual(rows.map((row) => [row.kind, row.id]), [["person", "i-mei"], ["key", "t-river"], ["code", "c-code"]]);
  assert.deepEqual(may(rows), { person: true, key: true, code: true });
});
test("a member may cancel only what is their own, never a person's invitation", () => {
  assert.deepEqual(may(peopleInvites(input({ userId: "sam", elevated: false }))), { person: false, key: true, code: true });
  assert.deepEqual(may(peopleInvites(input({ userId: "ana", elevated: false }))), { person: false, key: false, code: false });
});
test("with no viewer nothing can be cancelled", () => {
  assert.deepEqual(may(peopleInvites(input(null))), { person: false, key: false, code: false });
});
test("an agent with no key is never an invite: a connected hosted agent and a pending local one both stay out", () => {
  // The pending read lists both the same way: no used key. A hosted agent is created without one, so it may be working right now.
  const tokenless = (principalId, principalName) => ({ kind: "classic", principalId, principalName, joinCredentialId: null, ownerUserId: "ana",
    issuerDisplay: "Ana Rivera", issuedAt: at(-6), expiresAt: null, seatsUsed: null, seatCap: null });
  const rows = peopleInvites(input({ userId: "ana", elevated: true }, { invites: [], access: [], pending: [tokenless("p-hosted", "Muse"), tokenless("p-local", "Grok")] }));
  assert.deepEqual(rows, []);
  for (const row of peopleInvites(input({ userId: "ana", elevated: true }))) assert.ok(!["p-grok", "p-river"].includes(row.id), "no row carries an agent id");
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
});
test("Cancel sends the row's own id through the command for its kind, and no other", async () => {
  for (const [kind, id] of [["person", "i-mei"], ["key", "t-river"], ["code", "c-code"]]) {
    const sent = [];
    const send = Object.fromEntries(["person", "key", "code"].map((name) => [name, async (value) => { sent.push([name, value]); }]));
    await cancelPeopleInvite({ kind, id }, send);
    assert.deepEqual(sent, [[kind, id]]);
  }
});
test("a refused cancellation reaches the caller", async () => {
  const refuse = async () => { throw new Error("refused"); };
  await assert.rejects(cancelPeopleInvite({ kind: "code", id: "c-code" }, { person: refuse, key: refuse, code: refuse }), /refused/);
});
test("confirmation names recipient email or agent, identifies connect code by workspace and row details without exposing a code, and keeps consequences specific", () => {
  const person = peopleInviteConfirmCopy({ kind: "person", name: "mei@example.test", workspaceName: "Herb garden" });
  assert.equal(person.title, "Cancel the invitation for mei@example.test?");
  assert.equal(person.button, "Cancel invitation");
  assert.deepEqual(person.stops, ["Cancelling this invitation stops the email link from working."]);
  assert.deepEqual(person.stays, ["You can send a new invitation later."]);

  const keyCopy = peopleInviteConfirmCopy({ kind: "key", name: "River", workspaceName: "Herb garden" });
  assert.equal(keyCopy.title, "Cancel the key for River?");
  assert.equal(keyCopy.button, "Cancel key");
  assert.match(keyCopy.stops[0], /connected with it since this list loaded, turning it off cuts off River and any access renewed from this key/);
  assert.deepEqual(keyCopy.stays, ["You can create a new key later."]);

  const detail = "Sam made it · 2 hours ago · 1 of 3 places used · ends in 22 hours";
  const code = peopleInviteConfirmCopy({ kind: "code", name: "Connect code", workspaceName: "Herb garden", detail });
  assert.equal(code.title, "Cancel this connect code for Herb garden?");
  assert.equal(code.context, detail);
  assert.equal(code.button, "Cancel code");
  assert.deepEqual(code.stops, ["This connect code stops working and leaves this list. No more agents can join with it."]);
  assert.deepEqual(code.stays, ["Agents that already joined with it stay. You can make a new code later."]);
  assert.equal(peopleInviteConfirmCopy({ kind: "code", name: "Connect code" }).title, "Cancel this connect code?");
  assert.equal(peopleInviteConfirmCopy({ kind: "code", name: "Connect code", workspaceName: "   ", detail: "   " }).context, undefined);
  assert.equal(peopleInviteCancelLabel({ kind: "code", name: "Connect code", detail }), `Cancel connect code: ${detail}`);
  assert.equal(peopleInviteCancelLabel({ kind: "code", name: "Connect code" }), "Cancel this connect code");
});

test("connect codes with matching creator, times, capacity and use count get distinct non-secret ids on the row, Cancel label and confirmation", () => {
  const idA = "11111111-1111-4111-8111-111111111111";
  const idB = "22222222-2222-4222-8222-222222222222";
  const shared = { kind: "join", principalId: null, principalName: null, ownerUserId: "sam", issuerDisplay: "Sam Rivera", issuedAt: at(0), expiresAt: at(1), seatsUsed: 1, seatCap: 3 };
  const rows = peopleInvites(input({ userId: "ana", elevated: true }, { invites: [], access: [], pending: [{ ...shared, joinCredentialId: idA }, { ...shared, joinCredentialId: idB }] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].detail, "code 11111111 · Sam made it · <2026-11-18> · 1 of 3 places used · ends <2026-11-19>");
  assert.equal(rows[1].detail, "code 22222222 · Sam made it · <2026-11-18> · 1 of 3 places used · ends <2026-11-19>");
  assert.notEqual(rows[0].detail, rows[1].detail);
  assert.notEqual(peopleInviteCancelLabel(rows[0]), peopleInviteCancelLabel(rows[1]));
  assert.equal(peopleInviteCancelLabel(rows[0]), `Cancel connect code: ${rows[0].detail}`);
  assert.equal(peopleInviteCancelLabel(rows[1]), `Cancel connect code: ${rows[1].detail}`);
  const copyA = peopleInviteConfirmCopy({ ...rows[0], workspaceName: "Herb garden" });
  const copyB = peopleInviteConfirmCopy({ ...rows[1], workspaceName: "Herb garden" });
  assert.equal(copyA.context, rows[0].detail);
  assert.equal(copyB.context, rows[1].detail);
  assert.notEqual(copyA.context, copyB.context);
  // Idempotent when applied again on already-disambiguated rows.
  assert.equal(peopleInviteDisplayDetail(rows[0], rows), rows[0].detail);

  // Prefix expands if two colliding credential ids share their first 8 characters.
  const twin1 = { kind: "code", id: "aaaaaaaa-1111-4111-8111-111111111111", detail: "Sam made it · today" };
  const twin2 = { kind: "code", id: "aaaaaaaa-2222-4111-8111-111111111111", detail: "Sam made it · today" };
  assert.equal(peopleInviteDisplayDetail(twin1, [twin1, twin2]), "code aaaaaaaa-111 · Sam made it · today");
  assert.equal(peopleInviteDisplayDetail(twin2, [twin1, twin2]), "code aaaaaaaa-222 · Sam made it · today");
});
