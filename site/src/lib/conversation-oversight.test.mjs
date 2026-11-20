import assert from "node:assert/strict";
import { test } from "node:test";
import { CONVERSATION_UNAVAILABLE_TEXT } from "./conversations.ts";
import {
  createInitialOversightState,
  cursorsEqual,
  mergeOversightMessages,
  oversightConversationTitle,
  oversightMemberSummary,
  oversightPinMatches,
  parseOversightListOutcome,
  renderOversightPanel,
  retireRefusedOversightConversation,
  sortOversightConversations,
  teardownOversightState,
} from "./conversation-oversight.ts";

class FakeNode {
  tagName;
  ownerDocument;
  parentNode = null;
  children = [];
  attrs = new Map();
  dataset = {};
  className = "";
  id = "";
  hidden = false;
  type = "";
  tabIndex = 0;
  dateTime = "";
  listeners = new Map();
  _text = "";

  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }
  get textContent() {
    return this.children.length
      ? this.children.map(c => (typeof c === "string" ? c : c.textContent)).join("")
      : this._text;
  }
  set textContent(v) {
    this._text = String(v ?? "");
    this.children = [];
  }
  setAttribute(name, value) {
    if (name === "id") this.id = String(value);
    else if (name === "class") this.className = String(value);
    else this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, target: this, currentTarget: this, ...event };
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: "click", button: 0 }); }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") { this.children.push(n); continue; }
      n.parentNode = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  matches(selector) {
    if (selector.startsWith("[data-")) {
      const m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/u.exec(selector);
      if (!m) return false;
      const camel = m[1].replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
      if (!(camel in this.dataset)) return false;
      return m[2] === undefined ? true : this.dataset[camel] === m[2];
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (n) => {
      for (const c of n.children) {
        if (!(c instanceof FakeNode)) continue;
        if (c.matches(selector)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function makeDoc() {
  const doc = { createElement: (tag) => new FakeNode(doc, tag) };
  return doc;
}

const A1 = "aaaa1111-1111-4111-8111-111111111111";
const A2 = "aaaa2222-2222-4222-8222-222222222222";
const U1 = "bbbb1111-1111-4111-8111-111111111111";
const C1 = "cccc1111-1111-4111-8111-111111111111";
const C2 = "cccc2222-2222-4222-8222-222222222222";

const sampleDm = {
  conversationId: C1,
  kind: "dm",
  channelId: null,
  slug: null,
  description: null,
  archivedAt: null,
  generation: 1,
  members: [
    { kind: "agent", id: A1, name: "Lead", leftAt: null },
    { kind: "user", id: U1, name: "Alex", leftAt: null },
  ],
  lastMessageAt: "2026-11-19T15:10:00Z",
  lastMessageId: "dddd1111-1111-4111-8111-111111111111",
  readOnly: true,
};

const sampleGroup = {
  conversationId: C2,
  kind: "group_dm",
  channelId: null,
  slug: null,
  description: null,
  archivedAt: null,
  generation: 1,
  members: [
    { kind: "agent", id: A1, name: "Lead", leftAt: null },
    { kind: "user", id: U1, name: "Alex", leftAt: null },
    { kind: "agent", id: A2, name: "Builder", leftAt: null },
  ],
  lastMessageAt: "2026-11-19T15:20:00Z",
  lastMessageId: "dddd2222-2222-4222-8222-222222222222",
  readOnly: true,
};

test("parseOversightListOutcome classifies ready, fail-closed malformed 200, uniform 404, unsupported 400, and 5xx", () => {
  const ready = parseOversightListOutcome(200, {
    conversations: [{ conversation_id: C1, kind: "dm", members: [], read_only: true }],
  });
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    assert.equal(ready.conversations.length, 1);
    assert.equal(ready.conversations[0].readOnly, true);
  }

  assert.equal(parseOversightListOutcome(200, {}).status, "failed", "missing conversations array fails closed");
  assert.equal(
    parseOversightListOutcome(200, { conversations: [{ bad: true }] }).status,
    "failed",
    "malformed row fails closed",
  );

  const notFound = parseOversightListOutcome(404, { error: "conversation_not_found" });
  assert.deepEqual(notFound, { status: "not_found", message: CONVERSATION_UNAVAILABLE_TEXT });

  assert.equal(
    parseOversightListOutcome(400, { error: "unsupported_resource" }).status,
    "unsupported",
    "pre-Step-2b unsupported resource hides cleanly",
  );
  assert.equal(parseOversightListOutcome(500, { message: "boom" }).status, "failed");
});

test("oversight titles, member summaries, sorting, cursor dedupe, and pin/teardown isolation", () => {
  assert.equal(oversightConversationTitle(sampleDm, A1), "Alex");
  assert.equal(oversightConversationTitle(sampleGroup, A1), "Alex and Builder");
  assert.equal(oversightMemberSummary(sampleGroup), "3 members · Lead, Alex, Builder");
  assert.equal(oversightMemberSummary(sampleDm), "");

  const sorted = sortOversightConversations([sampleDm, sampleGroup]);
  assert.deepEqual(sorted.map(c => c.conversationId), [C2, C1]);

  const merged = mergeOversightMessages(
    [
      { id: "m2", from: A1, fromKind: "agent", body: "Second", createdAt: "2026-11-19T15:02:00Z" },
      { id: "m3", from: U1, fromKind: "user", body: "Third", createdAt: "2026-11-19T15:03:00Z" },
    ],
    [
      { id: "m1", from: U1, fromKind: "user", body: "First", createdAt: "2026-11-19T15:01:00Z" },
      { id: "M2", from: A1, fromKind: "agent", body: "Second", createdAt: "2026-11-19T15:02:00Z" },
    ],
  );
  assert.deepEqual(merged.map(m => m.body), ["First", "Second", "Third"]);
  assert.equal(cursorsEqual({ createdAt: "2026-11-19T15:01:00Z", id: "M1" }, { createdAt: "2026-11-19T15:01:00Z", id: "m1" }), true);

  const pinA = { viewerUserId: U1, workspaceId: "ws-1", agentPrincipalId: A1, requestGen: 1 };
  assert.equal(oversightPinMatches(pinA, { ...pinA }), true);
  assert.equal(oversightPinMatches(pinA, { ...pinA, agentPrincipalId: A2 }), false);
  assert.equal(oversightPinMatches(pinA, { ...pinA, requestGen: 2 }), false);

  const populated = {
    ...createInitialOversightState(),
    pin: pinA,
    listStatus: "ready",
    conversations: [sampleDm],
    selectedId: C1,
    historyStatus: "ready",
    messages: merged,
    hasMore: true,
    nextBefore: { createdAt: "2026-11-19T15:01:00Z", id: "m1" },
  };
  const torn = teardownOversightState(populated, 2);
  assert.equal(torn.listStatus, "idle");
  assert.equal(torn.pin, null, "teardown clears pin so re-entering the same agent starts fresh");
  assert.deepEqual(torn.conversations, []);
  assert.equal(torn.selectedId, null);
  assert.deepEqual(torn.messages, []);
  assert.equal(torn.hasMore, false);
  assert.equal(torn.nextBefore, null);
  assert.equal(oversightPinMatches(pinA, torn.pin), false);

  const retired = retireRefusedOversightConversation(
    {
      ...populated,
      conversations: [sampleGroup, sampleDm],
      selectedId: C2,
      historyConversation: sampleGroup,
      loadingOlder: true,
      olderError: "stale",
    },
    C2,
  );
  assert.deepEqual(retired.conversations.map(c => c.conversationId), [C1], "refused conversation is removed from list");
  assert.equal(retired.historyStatus, "not_found");
  assert.equal(retired.historyError, CONVERSATION_UNAVAILABLE_TEXT);
  assert.equal(retired.historyConversation, null);
  assert.deepEqual(retired.messages, []);
  assert.equal(retired.hasMore, false);
  assert.equal(retired.nextBefore, null);
  assert.equal(retired.loadingOlder, false);
  assert.equal(retired.olderError, "");
});

test("renderOversightPanel renders read-only agent conversations with zero write controls and uniform 404 non-oracle", () => {
  const doc = makeDoc();
  const host = doc.createElement("div");
  const selected = [];
  let loadOlderClicks = 0;
  let phoneBackClicks = 0;

  const baseCallbacks = {
    onSelect: (id) => selected.push(id),
    onRetryList() {},
    onRetryHistory() {},
    onLoadOlder: () => { loadOlderClicks += 1; },
    onPhoneBack: () => { phoneBackClicks += 1; },
  };

  const state = {
    ...createInitialOversightState(),
    listStatus: "ready",
    conversations: [sampleGroup, sampleDm],
    selectedId: C2,
    historyStatus: "ready",
    historyConversation: sampleGroup,
    messages: [
      { id: "m1", from: U1, fromKind: "user", body: "<img src=x onerror=1> Check status", createdAt: "2026-11-19T15:01:00Z" },
      { id: "m2", from: A1, fromKind: "agent", body: "All green.", createdAt: "2026-11-19T15:02:00Z" },
    ],
    hasMore: true,
    nextBefore: { createdAt: "2026-11-19T15:01:00Z", id: "m1" },
    phoneDetailOpen: true,
  };

  renderOversightPanel(
    host,
    {
      agentId: A1,
      agentName: "Lead",
      state,
      formatTime: () => "2m ago",
      resolveMemberName: (m) => (m.id === U1 ? "Alex" : m.id === A1 ? "Lead" : "Builder"),
    },
    baseCallbacks,
  );

  assert.equal(host.hidden, false);
  assert.equal(host.querySelector(".cs-oversight__title").textContent, "Lead’s conversations");
  assert.equal(host.querySelector("[data-oversight-badge]").textContent, "Read-only");
  assert.equal(host.querySelector("[data-oversight-detail-title]").textContent, "Alex and Builder");
  assert.equal(host.querySelector(".cs-oversight__detail-meta").textContent, "3 members · Lead, Alex, Builder");

  // Strict read-only DOM guarantee: zero inputs, textareas, forms, or write controls.
  assert.equal(host.querySelectorAll("textarea").length, 0);
  assert.equal(host.querySelectorAll("input").length, 0);
  assert.equal(host.querySelectorAll("form").length, 0);

  // Untrusted text stays plain text via textContent.
  const bodies = host.querySelectorAll(".cs-oversight__message-body").map(n => n.textContent);
  assert.deepEqual(bodies, ["<img src=x onerror=1> Check status", "All green."]);

  // Selection, Load older, and phone Escape/Back work cleanly.
  host.querySelector(`[data-oversight-conv="${C1}"]`).click();
  assert.deepEqual(selected, [C1]);
  host.querySelector("[data-oversight-load-older]").click();
  assert.equal(loadOlderClicks, 1);
  host.querySelector("[data-oversight-detail]").dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(phoneBackClicks, 1);

  // Uniform non-oracle 404 state retires denied row, title, member summary, cursor, and transcript.
  const retiredState = retireRefusedOversightConversation(state, C2);
  renderOversightPanel(
    host,
    {
      agentId: A1,
      agentName: "Lead",
      state: retiredState,
      formatTime: () => "2m ago",
      resolveMemberName: () => "Member",
    },
    baseCallbacks,
  );
  assert.equal(host.querySelector('[data-oversight-history-state="unavailable"]').textContent, CONVERSATION_UNAVAILABLE_TEXT);
  assert.equal(host.querySelector(`[data-oversight-conv="${C2}"]`), null, "denied row must not remain in list");
  assert.equal(host.querySelector(".cs-oversight__detail-meta"), null, "denied member summary must not remain");
  assert.equal(host.querySelector("[data-oversight-load-older]"), null, "denied cursor action must not remain");
  assert.equal(host.querySelectorAll(".cs-oversight__message-body").length, 0, "denied transcript must be cleared");
  assert.equal(host.textContent.includes("Alex and Builder"), false, "denied title must not remain");

  // When the refused conversation was the only row, uniform unavailable text still renders (not empty state).
  const retiredOnly = retireRefusedOversightConversation({ ...state, conversations: [sampleGroup] }, C2);
  renderOversightPanel(
    host,
    {
      agentId: A1,
      agentName: "Lead",
      state: retiredOnly,
      formatTime: () => "2m ago",
      resolveMemberName: () => "Member",
    },
    baseCallbacks,
  );
  assert.equal(host.querySelector('[data-oversight-history-state="unavailable"]').textContent, CONVERSATION_UNAVAILABLE_TEXT);
  assert.equal(host.querySelector('[data-oversight-state="empty"]'), null);
});
