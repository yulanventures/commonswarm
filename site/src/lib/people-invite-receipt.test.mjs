import assert from "node:assert/strict";
import { test } from "node:test";
import { runInviteCreate } from "./invite-submit.ts";
import { bindDialogInvite, dialogInviteCurrent, dialogInviteLink, dialogInviteNotice, settleDialogInvite } from "./people/invite-receipt.ts";

// Synthetic links only: nothing here is a real invitation.
const receipt = (over = {}) => ({ invitationId: "inv-1", link: "https://example.test/invite#synthetic-1", workspaceId: "w1", email: "mei@example.test", ...over });
const io = (over = {}) => {
  const log = [];
  const base = { workspaceId: "w1", owns: () => true, create: async () => receipt(), accepted: (r) => log.push(["accepted", r.link]),
    refreshList: async () => { log.push(["list"]); }, listFailed: () => log.push(["listFailed"]), failed: (error) => { log.push(["failed"]); return String(error.message); } };
  return { log, io: { ...base, ...over } };
};

test("an accepted create hands its link over once, then reads the list", async () => {
  const { log, io: deps } = io();
  assert.deepEqual(await runInviteCreate(deps), { status: "made", invitationId: "inv-1", listed: true });
  assert.deepEqual(log, [["accepted", "https://example.test/invite#synthetic-1"], ["list"]]);
});

test("an answer that arrives after its workspace generation ended is dropped before any surface sees it", async () => {
  const { log, io: deps } = io({ owns: () => false });
  assert.deepEqual(await runInviteCreate(deps), { status: "stale" });
  assert.deepEqual(log, [], "no link handed over, no list read, no error sentence");
  const refused = io({ owns: () => false, create: async () => { throw new Error("refused"); } });
  assert.deepEqual(await runInviteCreate(refused.io), { status: "stale" });
  assert.deepEqual(refused.log, []);
});

test("an accepted create stays accepted when the list cannot be read afterwards", async () => {
  const { log, io: deps } = io({ refreshList: async () => { throw new Error("read failed"); } });
  assert.deepEqual(await runInviteCreate(deps), { status: "made", invitationId: "inv-1", listed: false });
  assert.deepEqual(log, [["accepted", "https://example.test/invite#synthetic-1"], ["listFailed"]], "reported as a list failure, never as a failed create");
  let current = true;
  const moved = io({ owns: () => current, refreshList: async () => { current = false; throw new Error("read failed"); } });
  assert.equal((await runInviteCreate(moved.io)).status, "made");
  assert.deepEqual(moved.log.map(([step]) => step), ["accepted"], "a generation that ended during the read is not told the list failed");
});

test("a refusal, an unknown outcome and an answer for another workspace are errors with nothing handed over", async () => {
  const refused = io({ create: async () => { throw new Error("This address cannot be invited."); } });
  assert.deepEqual(await runInviteCreate(refused.io), { status: "error", message: "This address cannot be invited." });
  assert.deepEqual(refused.log, [["failed"]]);
  const elsewhere = io({ create: async () => receipt({ workspaceId: "w2" }) });
  assert.equal((await runInviteCreate(elsewhere.io)).status, "error");
  assert.deepEqual(elsewhere.log, [["failed"]], "the link for another workspace is never handed over");
});

const form = {}; const asked = { form, userId: "u1", workspaceId: "w1", generation: 7 };
const scope = (over = {}) => ({ open: true, form, userId: "u1", workspaceId: "w1", generation: 7, ...over });

test("the dialog keeps a link only for the form, account, workspace and generation that asked", () => {
  const held = bindDialogInvite(receipt(), asked, scope());
  assert.equal(held.link, "https://example.test/invite#synthetic-1"); assert.equal(held.listed, false);
  for (const [why, now] of [["the dialog closed", scope({ open: false })], ["the form was closed", scope({ form: null })], ["another form is open", scope({ form: {} })],
    ["another account", scope({ userId: "u2" })], ["another workspace", scope({ workspaceId: "w2" })], ["the same workspace reloaded", scope({ generation: 8 })]]) {
    assert.equal(bindDialogInvite(receipt(), asked, now), null, `a late answer is not stored when ${why}`);
    assert.equal(dialogInviteCurrent(held, now), false, `a stored link is no longer current when ${why}`);
    assert.equal(dialogInviteLink(held, now), "", `and is neither shown nor copied when ${why}`);
  }
  assert.equal(bindDialogInvite(receipt({ workspaceId: "w2" }), asked, scope()), null);
  assert.equal(dialogInviteLink(held, scope()), "https://example.test/invite#synthetic-1");
  assert.equal(dialogInviteLink(null, scope()), "");
});

test("an invite the list has shown and no longer shows takes its link with it; one not shown yet is kept", () => {
  const held = bindDialogInvite(receipt(), asked, scope());
  assert.equal(settleDialogInvite(held, []), held, "the list may not have caught up");
  const listed = settleDialogInvite(held, ["other", "inv-1"]); assert.equal(listed.listed, true);
  assert.equal(settleDialogInvite(listed, ["inv-1"]), listed);
  assert.equal(settleDialogInvite(listed, ["other"]), null, "cancelled, used or expired");
});

test("a cleared link says the invite is still pending, and only claims the list shows it when a read confirmed it", () => {
  assert.equal(dialogInviteNotice({ email: "mei@example.test", why: "reloaded" }, true),
    "The link for mei@example.test was cleared when this workspace reloaded. The invite is still in the list below. Cancel it and create another if you need a new link.");
  assert.equal(dialogInviteNotice({ email: "mei@example.test", why: "closed" }, false),
    "The link for mei@example.test was cleared when its form was closed. If the invite is in the list below, cancel it and create another.");
});
