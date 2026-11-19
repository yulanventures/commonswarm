import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSelectInviteCandidate,
  channelMembersPermissions,
  createChannelMembersDialogController,
  filterAddableMembers,
} from "./channel-members-dialog.ts";

function makeDialogHarness() {
  const focusLog = [];
  const doc = {
    createElement(tag) {
      const listeners = new Map();
      const el = {
        tagName: tag.toUpperCase(),
        id: "",
        className: "",
        textContent: "",
        value: "",
        type: "",
        placeholder: "",
        autocomplete: "",
        htmlFor: "",
        disabled: false,
        hidden: false,
        open: false,
        isConnected: true,
        children: [],
        dataset: {},
        attrs: {},
        ownerDocument: null,
        append(...nodes) {
          for (const node of nodes) {
            node.parentNode = el;
            el.children.push(node);
          }
        },
        replaceChildren(...nodes) {
          el.children = [];
          el.append(...nodes);
        },
        setAttribute(name, value) {
          el.attrs[name] = String(value);
          if (name === "open") el.open = true;
        },
        getAttribute(name) {
          return Object.hasOwn(el.attrs, name) ? el.attrs[name] : null;
        },
        removeAttribute(name) {
          delete el.attrs[name];
          if (name === "open") el.open = false;
        },
        addEventListener(type, fn) {
          const list = listeners.get(type) ?? [];
          list.push(fn);
          listeners.set(type, list);
        },
        dispatch(type, event = {}) {
          const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
          for (const fn of listeners.get(type) ?? []) fn(ev);
          return ev;
        },
        click() {
          if (el.disabled) return;
          el.dispatch("click");
        },
        focus() {
          focusLog.push(el);
        },
        showModal() {
          el.open = true;
        },
        close() {
          if (!el.open) return;
          el.open = false;
          el.dispatch("close");
        },
        querySelectorAll(selector) {
          const m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(selector);
          if (!m) return [];
          const camel = m[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          const expected = m[2];
          const found = [];
          const walk = (node) => {
            for (const child of node.children) {
              if (Object.hasOwn(child.dataset, camel) && (expected === undefined || child.dataset[camel] === expected)) {
                found.push(child);
              }
              walk(child);
            }
          };
          walk(el);
          return found;
        },
        querySelector(selector) {
          return el.querySelectorAll(selector)[0] ?? null;
        },
      };
      el.ownerDocument = doc;
      return el;
    },
  };
  const dialog = doc.createElement("dialog");
  return { dialog, focusLog };
}

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const ALEX_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const BOT_ID = "44444444-4444-4444-8444-444444444444";

test("channelMembersPermissions matches Step 2a and private-channel authorization matrix", () => {
  assert.deepEqual(
    channelMembersPermissions({ kind: "public_channel", archivedAt: null, joined: true }, false),
    { canAdd: true, canRemove: false, route: "conversation" },
  );
  assert.deepEqual(
    channelMembersPermissions({ kind: "public_channel", archivedAt: null, joined: true }, true),
    { canAdd: true, canRemove: true, route: "conversation" },
  );
  assert.deepEqual(
    channelMembersPermissions({ kind: "public_channel", archivedAt: null, joined: false }, true),
    { canAdd: false, canRemove: false, route: "readonly" },
  );
  assert.deepEqual(
    channelMembersPermissions({ kind: "private_channel", archivedAt: null, joined: true }, false),
    { canAdd: false, canRemove: false, route: "private_channel" },
  );
  assert.deepEqual(
    channelMembersPermissions({ kind: "private_channel", archivedAt: null, joined: true }, true),
    { canAdd: true, canRemove: true, route: "private_channel" },
  );
  assert.deepEqual(
    channelMembersPermissions({ kind: "public_channel", archivedAt: "2026-11-19T00:00:00Z", joined: true }, true),
    { canAdd: false, canRemove: false, route: "readonly" },
  );
  for (const kind of ["dm", "group_dm", "general"]) {
    assert.deepEqual(
      channelMembersPermissions({ kind, archivedAt: null, joined: true }, true),
      { canAdd: false, canRemove: false, route: "readonly" },
    );
  }
});

test("filterAddableMembers excludes current members and canSelectInviteCandidate caps at 50", () => {
  const candidates = [
    { kind: "user", id: VIEWER_ID, name: "Owner", self: true },
    { kind: "user", id: ALEX_ID, name: "Alex" },
    { kind: "agent", id: LEAD_ID, name: "Lead" },
  ];
  const addable = filterAddableMembers(candidates, [{ kind: "user", id: VIEWER_ID }], "");
  assert.deepEqual(addable.map((c) => c.name), ["Alex", "Lead"]);
  assert.deepEqual(filterAddableMembers(candidates, [{ kind: "user", id: VIEWER_ID }], "lead").map((c) => c.name), ["Lead"]);

  const fifty = Array.from({ length: 50 }, (_, i) => ({
    kind: "user",
    id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
  }));
  assert.equal(canSelectInviteCandidate(fifty, { kind: "agent", id: BOT_ID }), false);
  assert.equal(canSelectInviteCandidate(fifty, fifty[0]), true);
});

test("Channel Members sheet adds members, confirms before removing non-self members, and renders fixed-member DMs read-only", async () => {
  const { dialog, focusLog } = makeDialogHarness();
  const ctrl = createChannelMembersDialogController(dialog);
  const addedBatches = [];
  const removedMembers = [];
  const changedSnapshots = [];

  ctrl.open({
    title: "#ops members",
    viewerUserId: VIEWER_ID,
    permissions: { canAdd: true, canRemove: true, route: "conversation" },
    members: [
      { kind: "user", id: VIEWER_ID, name: "Owner", self: true },
      { kind: "user", id: ALEX_ID, name: "Alex" },
    ],
    candidates: [
      { kind: "user", id: VIEWER_ID, name: "Owner", self: true },
      { kind: "user", id: ALEX_ID, name: "Alex" },
      { kind: "agent", id: LEAD_ID, name: "Lead" },
      { kind: "agent", id: BOT_ID, name: "Archive Bot" },
    ],
    onAdd: async (members) => {
      addedBatches.push(members);
      return { ok: true, conversationId: "conv-ops", membersAdded: members };
    },
    onRemove: async (member) => {
      removedMembers.push(member);
      return { ok: true, conversationId: "conv-ops", changed: true };
    },
    onChanged: (next) => { changedSnapshots.push(next.map((m) => m.name)); },
  });

  // Self row never gets a Remove button; Alex gets one.
  assert.equal(dialog.querySelector(`[data-conversation-member-remove="user:${VIEWER_ID}"]`), null);
  assert.ok(dialog.querySelector(`[data-conversation-member-remove="user:${ALEX_ID}"]`));

  // Open Add panel, select Lead, submit.
  dialog.querySelector("[data-conversation-members-add-toggle]").click();
  const leadCandidate = dialog.querySelector(`[data-conversation-members-candidate="agent:${LEAD_ID}"]`);
  assert.ok(leadCandidate);
  leadCandidate.click();
  const addSubmit = dialog.querySelector("[data-conversation-members-add-submit]");
  assert.equal(addSubmit.textContent, "Add (1)");
  addSubmit.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(addedBatches, [[{ kind: "agent", id: LEAD_ID }]]);
  assert.deepEqual(changedSnapshots.at(-1), ["Owner", "Alex", "Lead"]);

  // Click Remove on Alex: must ask confirmation with Cancel focused, NOT send immediately.
  dialog.querySelector(`[data-conversation-member-remove="user:${ALEX_ID}"]`).click();
  assert.equal(removedMembers.length, 0);
  const cancelBtn = dialog.querySelector(`[data-conversation-member-remove-cancel="user:${ALEX_ID}"]`);
  const confirmBtn = dialog.querySelector(`[data-conversation-member-remove-confirm="user:${ALEX_ID}"]`);
  assert.ok(cancelBtn && confirmBtn);
  assert.equal(focusLog.at(-1), cancelBtn);

  // Cancel aborts removal without sending.
  cancelBtn.click();
  assert.equal(removedMembers.length, 0);
  assert.equal(dialog.querySelector(`[data-conversation-member-confirm="user:${ALEX_ID}"]`), null);

  // Re-open confirm and click destructive Remove: removes Alex.
  dialog.querySelector(`[data-conversation-member-remove="user:${ALEX_ID}"]`).click();
  dialog.querySelector(`[data-conversation-member-remove-confirm="user:${ALEX_ID}"]`).click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(removedMembers, [{ kind: "user", id: ALEX_ID }]);
  assert.deepEqual(changedSnapshots.at(-1), ["Owner", "Lead"]);
  assert.equal(dialog.querySelector(`[data-conversation-member-row="user:${ALEX_ID}"]`), null);

  // Fixed-member group DM opens strictly read-only: zero Add controls, zero Remove buttons.
  ctrl.open({
    title: "Members",
    viewerUserId: VIEWER_ID,
    permissions: channelMembersPermissions({ kind: "group_dm", archivedAt: null, joined: true }, true),
    members: [
      { kind: "user", id: VIEWER_ID, name: "Owner", self: true },
      { kind: "user", id: ALEX_ID, name: "Alex" },
      { kind: "agent", id: LEAD_ID, name: "Lead" },
    ],
    candidates: [],
  });
  assert.equal(dialog.querySelector("[data-conversation-members-add-toggle]").parentNode.hidden, true);
  assert.equal(dialog.querySelector("[data-conversation-members-add-panel]").hidden, true);
  assert.equal(dialog.querySelectorAll("[data-conversation-member-remove]").length, 0);
  assert.equal(dialog.querySelectorAll("[data-conversation-member-row]").length, 3);
});
