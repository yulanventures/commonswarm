import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenMembersPayload,
  canSelectConversationCandidate,
  createConversationPickerController,
  filterConversationCandidates,
} from "./conversation-picker.ts";

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
const CANDIDATES = [
  { kind: "user", id: VIEWER_ID, name: "Owner", self: true },
  ...Array.from({ length: 10 }, (_, i) => ({
    kind: i % 2 === 0 ? "user" : "agent",
    id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`,
    name: i % 2 === 0 ? `Person ${i + 1}` : `Agent ${i + 1}`,
  })),
];

test("filterConversationCandidates filters case-insensitively and canSelectConversationCandidate caps at 9 including caller", () => {
  assert.equal(filterConversationCandidates(CANDIDATES, "agent").length, 5);
  assert.equal(filterConversationCandidates(CANDIDATES, "  PERSON 1 ").map((c) => c.name)[0], "Person 1");

  // Self alone (Notes to self) counts as 1 member (<= 9).
  assert.equal(canSelectConversationCandidate([], CANDIDATES[0], VIEWER_ID), true);

  // Up to 8 OTHER members (plus caller = 9) are allowed; a 9th other is blocked.
  const eightOthers = CANDIDATES.slice(1, 9);
  assert.equal(eightOthers.length, 8);
  assert.equal(canSelectConversationCandidate(eightOthers, CANDIDATES[9], VIEWER_ID), false);
  // Deselecting an already-selected member is still allowed.
  assert.equal(canSelectConversationCandidate(eightOthers, CANDIDATES[1], VIEWER_ID), true);
  // Selecting self while 8 others are selected stays at 9 distinct members including caller.
  assert.equal(canSelectConversationCandidate(eightOthers, CANDIDATES[0], VIEWER_ID), true);

  // Payload deduplicates and lowercases IDs.
  const payload = buildOpenMembersPayload([
    { kind: "user", id: VIEWER_ID.toUpperCase() },
    { kind: "user", id: VIEWER_ID },
    { kind: "agent", id: CANDIDATES[2].id },
  ]);
  assert.deepEqual(payload, [
    { kind: "user", id: VIEWER_ID },
    { kind: "agent", id: CANDIDATES[2].id },
  ]);
});

test("New message picker handles conversation_left without restart, conversation_member_left with Start new group, and focus restore", async () => {
  const { dialog, focusLog } = makeDialogHarness();
  const ctrl = createConversationPickerController(dialog);
  const calls = [];
  let openedConv = null;
  let restored = 0;
  let mode = "caller_left";

  ctrl.open({
    viewerUserId: VIEWER_ID,
    candidates: CANDIDATES.slice(0, 4),
    onOpen: async (members, newGroup) => {
      calls.push({ members, newGroup });
      if (mode === "caller_left") {
        return {
          ok: false,
          code: "conversation_left",
          message: "You left this group. Ask a current member to start a new group with you.",
          canStartNewGroup: false,
        };
      }
      if (mode === "member_left" && !newGroup) {
        return {
          ok: false,
          code: "conversation_member_left",
          message: "Person 1 left this group. To include everyone again, start a new group.",
          canStartNewGroup: true,
        };
      }
      return {
        ok: true,
        created: true,
        conversation: {
          conversationId: "99999999-9999-4999-8999-999999999999",
          kind: "group_dm",
          generation: 2,
          members,
        },
      };
    },
    onOpened: (conv) => { openedConv = conv; },
    restoreFocus: () => { restored += 1; },
  });

  assert.equal(dialog.open, true);
  const submit = dialog.querySelector("[data-conversation-picker-submit]");
  const restart = dialog.querySelector("[data-conversation-picker-restart]");
  const error = dialog.querySelector("[data-conversation-picker-error]");
  assert.equal(submit.disabled, true);
  assert.equal(restart.hidden, true);

  // Pick two others.
  dialog.querySelector(`[data-conversation-picker-option="user:${CANDIDATES[1].id}"]`).click();
  dialog.querySelector(`[data-conversation-picker-option="agent:${CANDIDATES[2].id}"]`).click();
  assert.equal(submit.disabled, false);

  // 1. conversation_left: exact message, NO Start new group button.
  submit.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].newGroup, false);
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "You left this group. Ask a current member to start a new group with you.");
  assert.equal(restart.hidden, true);
  assert.equal(submit.hidden, false);

  // 2. conversation_member_left: exact message + Start new group button calling new_group=true.
  mode = "member_left";
  submit.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(error.textContent, "Person 1 left this group. To include everyone again, start a new group.");
  assert.equal(restart.hidden, false);
  assert.equal(submit.hidden, true);
  assert.equal(focusLog.at(-1), restart);

  // Clicking Start new group submits newGroup=true and closes without calling restoreFocus.
  restart.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.at(-1).newGroup, true);
  assert.equal(dialog.open, false);
  assert.equal(openedConv?.conversationId, "99999999-9999-4999-8999-999999999999");
  assert.equal(restored, 0);

  // 3. Reopen and Cancel: restores focus.
  ctrl.open({
    viewerUserId: VIEWER_ID,
    candidates: CANDIDATES.slice(0, 2),
    onOpen: async () => ({ ok: false, code: "other", message: "unused", canStartNewGroup: false }),
    onOpened: () => {},
    restoreFocus: () => { restored += 1; },
  });
  dialog.querySelector("[data-conversation-picker-cancel]").click();
  assert.equal(dialog.open, false);
  assert.equal(restored, 1);
});

test("New message picker enforces single-flight busy state and blocks Escape cancel while submitting", async () => {
  const { dialog } = makeDialogHarness();
  const ctrl = createConversationPickerController(dialog);
  let resolveOpen;
  let calls = 0;

  ctrl.open({
    viewerUserId: VIEWER_ID,
    candidates: CANDIDATES.slice(0, 2),
    onOpen: () => {
      calls += 1;
      return new Promise((resolve) => { resolveOpen = resolve; });
    },
    onOpened: () => {},
  });

  dialog.querySelector(`[data-conversation-picker-option="user:${CANDIDATES[1].id}"]`).click();
  const submit = dialog.querySelector("[data-conversation-picker-submit]");
  submit.click();
  submit.click();
  assert.equal(calls, 1);
  assert.equal(submit.textContent, "Opening…");

  const cancelEv = dialog.dispatch("cancel");
  assert.equal(cancelEv.defaultPrevented, true);

  resolveOpen({
    ok: false,
    code: "other",
    message: "Temporary error.",
    canStartNewGroup: false,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(submit.disabled, false);
  assert.equal(dialog.querySelector("[data-conversation-picker-error]").textContent, "Temporary error.");
});

test("New message picker disambiguates duplicate names, reuses commandId across transient retries, and retires lifetime on close", async () => {
  const { dialog } = makeDialogHarness();
  const ctrl = createConversationPickerController(dialog);
  let seq = 0;
  const seenCmdIds = [];
  let retired = 0;
  const dupA = "aaaa1111-1111-4111-8111-111111111111";
  const dupB = "bbbb2222-2222-4222-8222-222222222222";

  ctrl.open({
    viewerUserId: VIEWER_ID,
    candidates: [
      { kind: "user", id: dupA, name: "Alex" },
      { kind: "user", id: dupB, name: "Alex" },
    ],
    newCommandId: () => `cmd-${++seq}`,
    onOpen: async (_members, _newGroup, commandId) => {
      seenCmdIds.push(commandId);
      return { ok: false, code: "other", message: "Lost receipt.", canStartNewGroup: false };
    },
    onOpened: () => {},
    onRetire: () => { retired += 1; },
  });

  const optA = dialog.querySelector(`[data-conversation-picker-option="user:${dupA}"]`);
  const optB = dialog.querySelector(`[data-conversation-picker-option="user:${dupB}"]`);
  assert.equal(optA.children[0].textContent, "Alex · aaaa11");
  assert.equal(optB.children[0].textContent, "Alex · bbbb22");

  // Retry unchanged selection after transient failure reuses the same commandId.
  optA.click();
  const submit = dialog.querySelector("[data-conversation-picker-submit]");
  submit.click();
  await Promise.resolve();
  await Promise.resolve();
  submit.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seenCmdIds, ["cmd-1", "cmd-1"]);

  // Editing selection mints a fresh commandId.
  optB.click();
  submit.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(seenCmdIds, ["cmd-1", "cmd-1", "cmd-2"]);

  // Explicit reset close(false) retires the operation lifetime.
  ctrl.close(false);
  assert.equal(retired, 1);
});
