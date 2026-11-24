import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WAITING_PANEL_ID,
  WAITING_SHEET_ID,
  classifyAskConversation,
  conversationParticipantKey,
  createWaitingSurface,
  filterWaitingArchived,
  filterWaitingItems,
  filterWaitingTodos,
  focusWaitingPanelAfterAction,
  indexDirectConversations,
  mapWaitingArchivedEntry,
  renderWaitingPanel,
} from "./waiting-panel.ts";
import { buildWaitingButton, syncWaitingButtonToggle, updateWaitingButton } from "./waiting-count.ts";
import { answerChoice, answerPlainAsk, client, dismissWaitingItem, dismissWaitingItemCommand, plainAskReplyCommand, restoreWaitingItem, restoreWaitingItemCommand, STALE_ASK_CLOSE_BODY } from "./commonswarm.ts";
import { createWaitingDismissalController } from "./waiting-dismissal.ts";
import { parseDecisionQueue, parseWaitingArchivedPage, parseWaitingTodosQueue } from "./home/client.ts";

class FakeNode {
  tagName;
  nodeType = 1;
  ownerDocument;
  parentNode = null;
  children = [];
  attrs = new Map();
  dataset = {};
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  type = "";
  value = "";
  open = false;
  title = "";
  dateTime = "";
  placeholder = "";
  maxLength = 0;
  autocomplete = "";
  noValidate = false;
  listeners = new Map();
  onclick = null;
  onchange = null;
  _text = "";
  visible = true;

  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }
  get textContent() {
    return this.children.length ? this.children.map(c => (typeof c === "string" ? c : c.textContent)).join("") : this._text;
  }
  set textContent(v) {
    this._text = String(v ?? "");
    this.children = [];
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? this.parentNode.children[i + 1] ?? null : null;
  }
  get options() { return this.children.filter(c => c instanceof FakeNode && c.tagName === "OPTION"); }
  get isConnected() {
    let cur = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur === this.ownerDocument.root;
  }
  get classList() {
    return {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      contains: (n) => this.className.split(/\s+/).includes(n),
    };
  }
  getClientRects() { return this.visible && !this.hidden ? [{ width: 44, height: 44 }] : []; }
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
  removeAttribute(name) {
    if (name === "id") this.id = "";
    this.attrs.delete(name);
  }
  toggleAttribute(name, force) {
    if (force) this.attrs.set(name, "");
    else this.attrs.delete(name);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter(f => f !== fn));
  }
  dispatchEvent(event) {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, target: this, currentTarget: this, ...event };
    if (ev.type === "click" && typeof this.onclick === "function") this.onclick(ev);
    if (ev.type === "change" && typeof this.onchange === "function") this.onchange(ev);
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: "click", button: 0 }); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") { this.children.push(n); continue; }
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.push(n);
    }
  }
  prepend(...nodes) {
    for (const n of [...nodes].reverse()) {
      if (typeof n === "string") { this.children.unshift(n); continue; }
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.unshift(n);
    }
  }
  insertBefore(node, ref) {
    if (ref !== null && ref !== undefined && ref.parentNode !== this) {
      throw new Error("NotFoundError: reference node is not a child of this node");
    }
    if (node.parentNode) node.remove();
    node.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx >= 0) this.children.splice(idx, 0, node);
    else this.children.push(node);
  }
  before(node) {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(node, this);
  }
  after(node) {
    if (!this.parentNode) return;
    if (node.parentNode) node.remove();
    node.parentNode = this.parentNode;
    const idx = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(idx + 1, 0, node);
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const idx = parent.children.indexOf(this);
    if (node.parentNode) node.remove();
    node.parentNode = parent;
    parent.children.splice(idx, 1, node);
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const c of this.children) if (c instanceof FakeNode) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  matches(selector) {
    const sel = selector.trim();
    if (sel.startsWith("[data-")) {
      const m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/u.exec(sel);
      if (!m) return false;
      const camel = m[1].replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
      if (!(camel in this.dataset)) return false;
      return m[2] === undefined ? true : this.dataset[camel] === m[2];
    }
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  closest(selector) {
    let cur = this;
    while (cur instanceof FakeNode) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (!(c instanceof FakeNode)) continue;
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function makeFakeDoc(phone = false) {
  const mediaListeners = [];
  const media = {
    matches: phone,
    addEventListener(_t, fn) { mediaListeners.push(fn); },
    removeEventListener(_t, fn) {
      const i = mediaListeners.indexOf(fn);
      if (i >= 0) mediaListeners.splice(i, 1);
    },
    setMatches(v) {
      this.matches = v;
      for (const fn of [...mediaListeners]) fn();
    },
  };
  const doc = {
    activeElement: null,
    defaultView: { matchMedia: () => media },
    root: null,
    createElement(tag) { return new FakeNode(doc, tag); },
    createComment(text) {
      const n = new FakeNode(doc, "#comment");
      n.nodeType = 8;
      n._text = text;
      return n;
    },
    getElementById(id) {
      return doc.root.querySelector(`#${id}`);
    },
  };
  doc.root = new FakeNode(doc, "div");
  return { doc, media };
}

const person = { id: "u1", name: "Alex", firstName: "Alex", initials: "A", you: false, role: "member" };
const agent = {
  id: "a1", name: "Atlas", label: "Atlas", nestedLabel: "Atlas", ownerId: "u1",
  ownerFirstName: "Alex", ownerInitial: "A", yours: false, tint: 0, hosted: true,
  state: { kind: "idle", word: "Idle", detail: "", attention: false, fix: { action: null, allowed: false, askWho: null, sentence: "" } },
};

function sampleAsk(overrides = {}) {
  return {
    id: "ask-1",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    conversation: { kind: "channel", channelId: "ch-1" },
    channelLabel: "#household",
    from: agent,
    fromKind: "agent",
    fromId: "a1",
    what: "Which boiler quote should we book?",
    when: "2m ago",
    createdAt: "2026-11-19T12:00:00Z",
    until: "2026-11-20T12:00:00Z",
    choices: {
      multi: false,
      options: [
        { id: "harbor", label: "Harbor Heating", description: "Includes expansion vessel", recommended: true },
        { id: "north", label: "North Plumbing" },
      ],
    },
    ...overrides,
  };
}

test("classifyAskConversation and filterWaitingItems separate #general and DM asks from the same sender and never turn unknown lookups into #general", () => {
  const genConv = classifyAskConversation({ channelId: null, to: null, toAgent: null, threadRootId: null, from: "a1", fromKind: "agent" });
  const dmConv = classifyAskConversation({ channelId: null, to: "u-viewer", toAgent: null, threadRootId: null, from: "a1", fromKind: "agent" });
  const threadGenConv = classifyAskConversation(
    { channelId: null, to: "u-viewer", toAgent: null, threadRootId: "root-1", from: "a1", fromKind: "agent" },
    { channelId: null, to: null, toAgent: null },
  );
  const chConv = classifyAskConversation({ channelId: "ch-1", to: "u-viewer", toAgent: null, threadRootId: null, from: "a1", fromKind: "agent" });
  const unknownConv = classifyAskConversation(null);

  assert.deepEqual(genConv, { kind: "general" });
  assert.deepEqual(dmConv, { kind: "dm", partnerKind: "agent", partnerId: "a1" });
  assert.deepEqual(threadGenConv, { kind: "general" });
  assert.deepEqual(chConv, { kind: "channel", channelId: "ch-1" });
  assert.deepEqual(unknownConv, { kind: "unknown" });

  // Same sender (Atlas, a1) has one #general ask, one DM ask, one named-channel ask, and one unknown-location ask.
  const items = [
    sampleAsk({ id: "in-ch1", workspaceId: "ws-1", conversation: chConv }),
    sampleAsk({ id: "in-gen", workspaceId: "ws-1", conversation: genConv, channelLabel: "#general" }),
    sampleAsk({ id: "in-dm-a1", workspaceId: "ws-1", conversation: dmConv, channelLabel: "Direct message" }),
    sampleAsk({ id: "in-unknown", workspaceId: "ws-1", conversation: unknownConv, channelLabel: "" }),
    sampleAsk({ id: "in-ws2", workspaceId: "ws-2", workspaceName: "Studio", conversation: { kind: "channel", channelId: "ch-2" } }),
  ];
  const ch1 = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "channel", channelId: "ch-1", label: "#household" };
  const gen = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "general", channelId: null, label: "#general" };
  const dm = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "dm", channelId: null, label: "Atlas", dm: { kind: "agent", id: "a1" } };

  assert.deepEqual(filterWaitingItems(items, "channel", ch1).map(i => i.id), ["in-ch1"]);
  assert.deepEqual(filterWaitingItems(items, "channel", gen).map(i => i.id), ["in-gen"], "DM and unknown asks must not appear in #general");
  assert.deepEqual(filterWaitingItems(items, "channel", dm).map(i => i.id), ["in-dm-a1"], "#general and unknown asks must not appear in DM");
  assert.deepEqual(filterWaitingItems(items, "workspace", ch1).map(i => i.id), ["in-ch1", "in-gen", "in-dm-a1", "in-unknown"]);
  assert.deepEqual(filterWaitingItems(items, "all", ch1).map(i => i.id), ["in-ch1", "in-gen", "in-dm-a1", "in-unknown", "in-ws2"]);
});

test("renderWaitingPanel names the channel, sends single choice on tap, gives Other a Send button, preserves failed drafts with Retry, shows visible Sent, and never fakes zero on failed reads", () => {
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);

  const submitted = [];
  const retried = [];
  const drafts = [];
  const scopes = [];
  let loadRetries = 0;
  const place = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "channel", channelId: "ch-1", label: "#household" };
  const handlers = {
    onScopeChange: s => scopes.push(s),
    onClose: () => {},
    onRetryLoad: () => { loadRetries += 1; },
    onSubmitChoice: (item, sub) => submitted.push({ id: item.id, sub }),
    onRetryChoice: item => retried.push(item.id),
    onDraftChoice: (item, draft) => drafts.push({ id: item.id, draft }),
  };

  const ask = sampleAsk();
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [ask],
    counts: {
      channel: { min: 1, complete: true },
      workspace: { min: 3, complete: true },
      all: { min: 7, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);

  assert.equal(host.querySelector("[data-waiting-place]").textContent, "#household");
  const select = host.querySelector("[data-waiting-scope]");
  assert.deepEqual(select.options.map(o => o.textContent), ["This channel (1)", "All channels (3)", "All workspaces (7)"]);
  assert.equal(host.querySelector("[data-waiting-status]").hidden, true);

  // Recommended option is marked and one tap sends immediately.
  const harborBtn = host.querySelector('[data-decision-option="harbor"]');
  assert.ok(harborBtn.textContent.includes("Recommended"));
  harborBtn.click();
  assert.deepEqual(submitted, [{ id: "ask-1", sub: { optionIds: ["harbor"], otherText: null } }]);

  // Submit button for Other is labelled "Send".
  const submitBtn = host.querySelector("[data-decision-submit]");
  assert.equal(submitBtn.textContent, "Send");

  // Unchanged background refresh keeps the exact same card DOM node (focus & draft preserved).
  const firstCard = host.querySelector('[data-waiting-card="ask-1"]');
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [{ ...ask, when: "3m ago" }],
    counts: {
      channel: { min: 1, complete: true },
      workspace: { min: 3, complete: true },
      all: { min: 7, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);
  assert.strictEqual(host.querySelector('[data-waiting-card="ask-1"]'), firstCard);
  assert.equal(firstCard.querySelector(".cs-waiting-card__when").textContent, "3m ago");

  // Failed answer keeps typed draft editable, shows alert, and offers Retry.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [sampleAsk({
      choices: {
        ...ask.choices,
        error: "Could not save your answer.",
        retryable: true,
        draft: { selected: [], otherOpen: true, otherText: "Ask for a third quote" },
      },
    })],
    counts: {
      channel: { min: 1, complete: true },
      workspace: { min: 3, complete: true },
      all: { min: 7, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);
  const input = host.querySelector("[data-decision-other-input]");
  assert.equal(input.value, "Ask for a third quote");
  assert.equal(input.readOnly, false);
  const retryBtn = host.querySelector("[data-waiting-card-retry]");
  assert.ok(retryBtn);
  retryBtn.click();
  assert.deepEqual(retried, ["ask-1"]);

  // After answering succeeds, visible Sent banner shows even after the last card leaves, and empty channel coexists with nonzero all-channel count.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    counts: {
      channel: { min: 0, complete: true },
      workspace: { min: 2, complete: true },
      all: { min: 6, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "Sent",
    statusSeq: 1,
  }, handlers);
  const statusEl = host.querySelector("[data-waiting-status]");
  assert.equal(statusEl.hidden, false, "Sent confirmation must be visible in the panel");
  assert.equal(statusEl.textContent, "Sent");
  assert.ok(host.querySelector(".cs-waiting-panel__state-text").textContent.includes("#household"));
  const switchBtn = host.querySelector("[data-waiting-switch-scope]");
  assert.equal(switchBtn.textContent, "Show all channels (2)");
  switchBtn.click();
  assert.deepEqual(scopes, ["workspace"]);

  // Failed read: never renders (0) or "Nothing waiting", shows Retry and minimum counts.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    counts: {
      channel: { min: 0, complete: false },
      workspace: { min: 0, complete: false },
      all: { min: 2, complete: false },
    },
    loading: false,
    complete: false,
    failed: true,
    statusMessage: "",
    statusSeq: 1,
  }, handlers);
  assert.deepEqual(select.options.map(o => o.textContent), ["This channel", "All channels", "All workspaces (2+)"]);
  assert.equal(host.querySelector('[data-waiting-state="failed"]') !== null, true);
  host.querySelector("[data-waiting-retry]").click();
  assert.equal(loadRetries, 1);

  // Partial failure with loaded items shows the known items plus an inline Retry notice.
  renderWaitingPanel(host, {
    scope: "all",
    place,
    items: [ask],
    counts: {
      channel: { min: 1, complete: true },
      workspace: { min: 1, complete: true },
      all: { min: 1, complete: false },
    },
    loading: false,
    complete: false,
    failed: true,
    statusMessage: "",
    statusSeq: 1,
  }, handlers);
  assert.equal(host.querySelector("[data-waiting-incomplete]") !== null, true);
  assert.equal(select.options[2].textContent, "All workspaces (1+)");
});

test("createWaitingSurface starts closed, stays open across desktop updates, and uses a modal dialog sheet on phone returning focus on close", () => {
  // Desktop
  const { doc: dDoc } = makeFakeDoc(false);
  const dApp = dDoc.createElement("div");
  const dTrigger = dDoc.createElement("a");
  dTrigger.dataset.waitingOpen = "";
  const dPanel = dDoc.createElement("aside");
  dPanel.dataset.waitingPanel = "";
  dPanel.hidden = true;
  dApp.append(dTrigger, dPanel);
  dDoc.root.append(dApp);

  const dSurface = createWaitingSurface(dApp);
  dSurface.setEnabled(true);
  assert.equal(dSurface.isOpen(), false);
  assert.equal(dPanel.hidden, true);
  assert.equal(dSurface.controlsId(), WAITING_PANEL_ID);

  dSurface.open(dTrigger);
  assert.equal(dSurface.isOpen(), true);
  assert.equal(dPanel.hidden, false);

  // Staying in channel view across channel switches keeps desktop panel open.
  dSurface.setEnabled(true);
  assert.equal(dSurface.isOpen(), true);

  // Leaving channel view hides the panel cleanly.
  dSurface.setEnabled(false);
  assert.equal(dSurface.isOpen(), false);
  assert.equal(dPanel.hidden, true);
  dSurface.destroy();

  // Phone
  const { doc: pDoc } = makeFakeDoc(true);
  const pApp = pDoc.createElement("div");
  const pTrigger = pDoc.createElement("a");
  pTrigger.dataset.waitingOpen = "";
  const pPanel = pDoc.createElement("aside");
  pPanel.dataset.waitingPanel = "";
  pPanel.hidden = true;
  const closeBtn = pDoc.createElement("button");
  closeBtn.dataset.waitingClose = "";
  pPanel.append(closeBtn);
  pApp.append(pTrigger, pPanel);
  pDoc.root.append(pApp);

  const pSurface = createWaitingSurface(pApp);
  pSurface.setEnabled(true);
  assert.equal(pSurface.isOpen(), false);
  assert.equal(pSurface.controlsId(), WAITING_SHEET_ID);

  pSurface.open(pTrigger);
  const dialog = pApp.querySelector(`#${WAITING_SHEET_ID}`);
  assert.equal(dialog.open, true);
  assert.strictEqual(pPanel.parentNode, dialog);
  assert.strictEqual(pDoc.activeElement, closeBtn);

  pSurface.close(true);
  assert.equal(dialog.open, false);
  assert.strictEqual(pPanel.parentNode, pApp);
  assert.strictEqual(pDoc.activeElement, pTrigger);
  pSurface.destroy();
});

test("waiting button labels its badge as an all-workspace count and toggles role/aria-expanded in channel view", () => {
  const { doc } = makeFakeDoc(false);
  const clicks = [];
  const btn = buildWaitingButton(doc, "/app", href => clicks.push(href));
  updateWaitingButton(btn, { min: 4, complete: true });
  assert.equal(btn.getAttribute("aria-label"), "Waiting on you 4");
  assert.equal(btn.getAttribute("aria-description"), "Count across all workspaces");

  syncWaitingButtonToggle(btn, { active: true, expanded: true, controlsId: WAITING_PANEL_ID });
  assert.equal(btn.getAttribute("role"), "button");
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(btn.getAttribute("aria-controls"), WAITING_PANEL_ID);

  syncWaitingButtonToggle(btn, { active: false, expanded: false, controlsId: WAITING_PANEL_ID });
  assert.equal(btn.getAttribute("role"), null);
  assert.equal(btn.getAttribute("aria-expanded"), null);
});

test("renderWaitingPanel keeps truncated queues incomplete, avoids false channel zero, and offers Catch up", () => {
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const openedCatchUp = [];
  const scopes = [];
  const place = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "general", channelId: null, label: "#general" };
  const handlers = {
    onScopeChange: s => scopes.push(s),
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onOpenCatchUp: href => openedCatchUp.push(href),
  };

  // Truncated queue with 0 of the oldest 100 in #general: never shows This channel (0) or false empty state.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    counts: {
      channel: { min: 0, complete: false },
      workspace: { min: 100, complete: false },
      all: { min: 100, complete: false },
    },
    loading: false,
    complete: false,
    failed: false,
    truncated: true,
    catchUpHref: "/app",
    statusMessage: "",
    statusSeq: 0,
  }, handlers);

  const select = host.querySelector("[data-waiting-scope]");
  assert.deepEqual(select.options.map(o => o.textContent), ["This channel", "All channels (99+)", "All workspaces (99+)"]);
  assert.ok(host.querySelector('[data-waiting-state="truncated"]'));
  assert.equal(host.querySelector('[data-waiting-state="empty"]'), null);
  const switchWs = host.querySelector('[data-waiting-switch-scope="workspace"]');
  assert.equal(switchWs.textContent, "Show all channels (99+)");
  switchWs.click();
  assert.deepEqual(scopes, ["workspace"]);
  const catchUpLink = host.querySelector("[data-waiting-open-catchup]");
  assert.equal(catchUpLink.textContent, "Open Catch up");
  catchUpLink.click();
  assert.deepEqual(openedCatchUp, ["/app"]);

  // Loaded cards alongside a truncated queue keep an inline truncation notice with Open Catch up.
  renderWaitingPanel(host, {
    scope: "workspace",
    place,
    items: [sampleAsk()],
    counts: {
      channel: { min: 0, complete: false },
      workspace: { min: 100, complete: false },
      all: { min: 100, complete: false },
    },
    loading: false,
    complete: false,
    failed: false,
    truncated: true,
    catchUpHref: "/app",
    statusMessage: "",
    statusSeq: 0,
  }, handlers);
  assert.ok(host.querySelector('[data-waiting-card="ask-1"]'));
  const truncatedNotice = host.querySelector("[data-waiting-truncated]");
  assert.ok(truncatedNotice);
  assert.ok(truncatedNotice.querySelector("[data-waiting-open-catchup]"));
});

test("filterWaitingTodos separates channel-origin, #general, and workspace-only to-dos, and focusWaitingPanelAfterAction keeps focus inside the panel", () => {
  const todoBoiler = {
    id: "todo-boiler",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    title: "Confirm boiler quote <urgent>",
    state: "open",
    dueOn: "2026-11-22",
    reason: "assigned",
    href: "/app?w=ws-1&v=todo&id=todo-boiler",
    canMarkDone: true,
    placement: "channel",
    channelId: "ch-boiler",
    channelLabel: "#boiler-quotes",
  };
  const todoReno = {
    id: "todo-reno",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    title: "Approve tile sample",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: "/app?w=ws-1&v=todo&id=todo-reno",
    canMarkDone: true,
    placement: "channel",
    channelId: "ch-reno",
    channelLabel: "#renovation",
  };
  const todoGeneral = {
    id: "todo-general",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    title: "Review household checklist",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: "/app?w=ws-1&v=todo&id=todo-general",
    canMarkDone: true,
    placement: "general",
    channelId: null,
    channelLabel: "#general",
  };
  const todoWs = {
    id: "todo-ws",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    title: "Drop off spare keys",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: "/app?w=ws-1&v=todo&id=todo-ws",
    canMarkDone: true,
    placement: "workspace",
    channelId: null,
    channelLabel: "",
  };
  const todoOtherWs = {
    id: "todo-2",
    workspaceId: "ws-2",
    workspaceName: "Studio",
    title: "Approve contractor request",
    state: "open",
    dueOn: null,
    reason: "request",
    href: "/app?w=ws-2&v=todo&id=todo-2",
    canMarkDone: false,
    placement: "workspace",
    channelId: null,
    channelLabel: "",
  };
  const allTodos = [todoBoiler, todoReno, todoGeneral, todoWs, todoOtherWs];
  const boilerPlace = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "channel", channelId: "ch-boiler", label: "#boiler-quotes" };
  const renoPlace = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "channel", channelId: "ch-reno", label: "#renovation" };
  const generalPlace = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "general", channelId: null, label: "#general" };
  const dmPlace = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "dm", channelId: null, label: "Sam", dm: { kind: "person", id: "u-2" } };
  const allMessagesPlace = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "all", channelId: null, label: "All messages" };

  assert.deepEqual(filterWaitingTodos(allTodos, "channel", boilerPlace).map(t => t.id), ["todo-boiler"]);
  assert.deepEqual(filterWaitingTodos(allTodos, "channel", renoPlace).map(t => t.id), ["todo-reno"]);
  assert.deepEqual(filterWaitingTodos(allTodos, "channel", generalPlace).map(t => t.id), ["todo-general"]);
  assert.deepEqual(filterWaitingTodos(allTodos, "channel", dmPlace), []);
  assert.deepEqual(filterWaitingTodos(allTodos, "channel", allMessagesPlace).map(t => t.id), ["todo-boiler", "todo-reno", "todo-general", "todo-ws"]);
  assert.deepEqual(filterWaitingTodos(allTodos, "workspace", boilerPlace).map(t => t.id), ["todo-boiler", "todo-reno", "todo-general", "todo-ws"]);
  assert.deepEqual(filterWaitingTodos(allTodos, "all", boilerPlace).map(t => t.id), ["todo-boiler", "todo-reno", "todo-general", "todo-ws", "todo-2"]);

  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const doneClicks = [];
  const retryClicks = [];
  const openClicks = [];
  const handlers = {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onMarkTodoDone: item => doneClicks.push(item.id),
    onRetryTodo: item => retryClicks.push(item.id),
    onOpenTodo: item => openClicks.push(item.id),
  };

  renderWaitingPanel(host, {
    scope: "all",
    place: boilerPlace,
    items: [],
    todos: [todoBoiler, todoOtherWs],
    counts: {
      channel: { min: 1, complete: true },
      workspace: { min: 1, complete: true },
      all: { min: 2, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);

  const card1 = host.querySelector('[data-waiting-todo="todo-boiler"]');
  const card2 = host.querySelector('[data-waiting-todo="todo-2"]');
  assert.ok(card1 && card2);
  assert.equal(card1.querySelector(".cs-waiting-card__question").textContent, "Confirm boiler quote <urgent>");
  assert.equal(card1.querySelector(".cs-waiting-card__todo-due").textContent, "Due Nov 22");
  assert.equal(card1.querySelector(".cs-waiting-card__place").textContent, "Rivera Household · #boiler-quotes");
  const doneBtn = card1.querySelector('[data-waiting-todo-done="todo-boiler"]');
  assert.equal(doneBtn.textContent, "Mark done");
  doneBtn.click();
  assert.deepEqual(doneClicks, ["todo-boiler"]);

  // Request to-do has Open (no direct Mark done) and Open delegates in-app navigation without completing it.
  assert.equal(card2.querySelector('[data-waiting-todo-done="todo-2"]'), null);
  const openLink = card2.querySelector('[data-waiting-todo-open="todo-2"]');
  assert.equal(openLink.textContent, "Open");
  openLink.click();
  assert.deepEqual(openClicks, ["todo-2"]);

  // Unchanged refresh preserves exact to-do card DOM node.
  renderWaitingPanel(host, {
    scope: "all",
    place: boilerPlace,
    items: [],
    todos: [todoBoiler, todoOtherWs],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 1, complete: true }, all: { min: 2, complete: true } },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);
  assert.strictEqual(host.querySelector('[data-waiting-todo="todo-boiler"]'), card1);

  // Failed Mark done keeps the card visible with role="alert", Retry, and focuses Retry on the same card.
  renderWaitingPanel(host, {
    scope: "all",
    place: boilerPlace,
    items: [],
    todos: [{ ...todoBoiler, error: "Could not save to-do.", retryable: true }, todoOtherWs],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 1, complete: true }, all: { min: 2, complete: true } },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);
  const failedCard = host.querySelector('[data-waiting-todo="todo-boiler"]');
  assert.equal(failedCard.querySelector(".cs-waiting-card__error").textContent, "Could not save to-do.");
  const retryBtn = failedCard.querySelector('[data-waiting-todo-retry="todo-boiler"]');
  focusWaitingPanelAfterAction(host, { kind: "retry-todo", todoId: "todo-boiler" });
  assert.strictEqual(doc.activeElement, retryBtn, "failure must focus Retry on the same card");
  retryBtn.click();
  assert.deepEqual(retryClicks, ["todo-boiler"]);

  // Completing card 1 when card 2 remains focuses card 2's action.
  renderWaitingPanel(host, {
    scope: "all",
    place: boilerPlace,
    items: [],
    todos: [todoOtherWs],
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 1, complete: true } },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "Done",
    statusSeq: 1,
  }, handlers);
  focusWaitingPanelAfterAction(host, { kind: "completed-todo", prevIndex: 0 });
  assert.strictEqual(doc.activeElement, host.querySelector('[data-waiting-todo-open="todo-2"]'));

  // After last item completes, visible Done banner shows and focus lands on a stable panel control (not body).
  renderWaitingPanel(host, {
    scope: "workspace",
    place: boilerPlace,
    items: [],
    todos: [],
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "Done",
    statusSeq: 2,
  }, handlers);
  assert.equal(host.querySelector("[data-waiting-status]").hidden, false);
  assert.equal(host.querySelector("[data-waiting-status]").textContent, "Done");
  focusWaitingPanelAfterAction(host, { kind: "completed-todo", prevIndex: 0 });
  assert.strictEqual(doc.activeElement, host.querySelector("[data-waiting-scope]"));
});

test("Step 2b DM and group DM convergence: zero cross-DM bleed from the same sender, exact conversationId & generation separation, and This conversation scope label", () => {
  const viewer = "u-viewer";
  const alice = "u-alice";
  const bob = "u-bob";
  const carol = "u-carol";
  const atlas = "a-atlas";

  const conversations = [
    {
      conversationId: "conv-dm-alice",
      kind: "dm",
      members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }],
    },
    {
      conversationId: "conv-dm-atlas",
      kind: "dm",
      members: [{ kind: "user", id: viewer }, { kind: "agent", id: atlas }],
    },
    {
      conversationId: "conv-self",
      kind: "dm",
      members: [{ kind: "user", id: viewer }],
    },
    {
      conversationId: "conv-grp-ab",
      kind: "group_dm",
      members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: bob }],
    },
    {
      conversationId: "conv-grp-ac",
      kind: "group_dm",
      members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: carol }],
    },
  ];
  const directByParticipantKey = indexDirectConversations(conversations);

  // Same sender (Alice) sends asks in her 1:1 DM, in group DM {viewer, Alice, Bob}, in group DM {viewer, Alice, Carol},
  // and as a thread reply inside group DM {viewer, Alice, Bob} where only the root carries all 3 participants.
  const conv1to1 = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }],
    },
    null,
    { directByParticipantKey },
  );
  const convGrpAB = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: bob }],
    },
    null,
    { directByParticipantKey },
  );
  const convGrpAC = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: carol }],
    },
    null,
    { directByParticipantKey },
  );
  const convGrpABThread = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: "root-grp-ab", from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }],
    },
    {
      channelId: null, to: viewer, toAgent: null, from: bob, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: alice }],
    },
    { directByParticipantKey },
  );
  const convSelf = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: viewer, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }],
    },
    null,
    { directByParticipantKey },
  );
  // Pre-Step-2b server (no conversations index): 3+ participants STILL classify as group_dm and never bleed into 1:1 DM.
  const convGrpLegacy = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: bob }],
    },
    null,
  );
  // Re-created group generation (same members, different authoritative conversationId).
  const convGrpGen1 = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      conversationId: "conv-grp-ab-gen1",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: bob }],
    },
    null,
    { directByParticipantKey },
  );

  assert.equal(conv1to1.kind, "dm");
  assert.equal(conv1to1.conversationId, "conv-dm-alice");
  assert.equal(convGrpAB.kind, "group_dm");
  assert.equal(convGrpAB.conversationId, "conv-grp-ab");
  assert.equal(convGrpAC.kind, "group_dm");
  assert.equal(convGrpAC.conversationId, "conv-grp-ac");
  assert.equal(convGrpABThread.kind, "group_dm");
  assert.equal(convGrpABThread.conversationId, "conv-grp-ab");
  assert.equal(convSelf.kind, "dm");
  assert.equal(convSelf.conversationId, "conv-self");
  assert.equal(convGrpLegacy.kind, "group_dm");
  assert.equal(convGrpLegacy.conversationId, undefined);
  assert.equal(convGrpGen1.kind, "group_dm");
  assert.equal(convGrpGen1.conversationId, "conv-grp-ab-gen1");

  const items = [
    sampleAsk({ id: "ask-1to1", conversation: conv1to1, channelLabel: "Alice" }),
    sampleAsk({ id: "ask-grp-ab", conversation: convGrpAB, channelLabel: "Alice and Bob" }),
    sampleAsk({ id: "ask-grp-ab-thread", conversation: convGrpABThread, channelLabel: "Alice and Bob" }),
    sampleAsk({ id: "ask-grp-ac", conversation: convGrpAC, channelLabel: "Alice and Carol" }),
    sampleAsk({ id: "ask-grp-legacy", conversation: convGrpLegacy, channelLabel: "Group direct message" }),
    sampleAsk({ id: "ask-grp-gen1", conversation: convGrpGen1, channelLabel: "Alice and Bob" }),
    sampleAsk({ id: "ask-self", conversation: convSelf, channelLabel: "Notes to self" }),
    sampleAsk({ id: "ask-general", conversation: { kind: "general" }, channelLabel: "#general" }),
  ];

  const key1to1 = conversationParticipantKey([{ kind: "user", id: viewer }, { kind: "user", id: alice }]);
  const keyGrpAB = conversationParticipantKey([{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: bob }]);
  const keyGrpAC = conversationParticipantKey([{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: carol }]);
  const keySelf = conversationParticipantKey([{ kind: "user", id: viewer }]);

  const place1to1 = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "dm", channelId: null, label: "Alice",
    conversationId: "conv-dm-alice", participantKey: key1to1, dm: { kind: "person", id: alice },
  };
  const placeGrpAB = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Alice and Bob",
    conversationId: "conv-grp-ab", participantKey: keyGrpAB,
  };
  const placeGrpAC = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Alice and Carol",
    conversationId: "conv-grp-ac", participantKey: keyGrpAC,
  };
  const placeSelf = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "dm", channelId: null, label: "Notes to self",
    conversationId: "conv-self", participantKey: keySelf, dm: { kind: "person", id: viewer },
  };
  const placeUnknownDm = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "dm", channelId: null, label: "Direct message",
    conversationId: "conv-unknown-404",
  };

  assert.deepEqual(filterWaitingItems(items, "channel", place1to1).map(i => i.id), ["ask-1to1"], "1:1 DM must not include group DM or self DM asks");
  assert.deepEqual(
    filterWaitingItems(items, "channel", placeGrpAB).map(i => i.id),
    ["ask-grp-ab", "ask-grp-ab-thread", "ask-grp-legacy"],
    "group DM AB includes direct + thread + legacy-key asks for AB, excludes 1:1 DM, group AC, and gen-1 conversationId",
  );
  assert.deepEqual(filterWaitingItems(items, "channel", placeGrpAC).map(i => i.id), ["ask-grp-ac"]);
  assert.deepEqual(filterWaitingItems(items, "channel", placeSelf).map(i => i.id), ["ask-self"]);
  assert.deepEqual(filterWaitingItems(items, "channel", placeUnknownDm).map(i => i.id), [], "unknown ?dm=<id> must never bleed asks");

  // To-dos: workspace-only and channel-origin to-dos stay out of DMs; DM-origin to-dos match strictly by conversationId.
  const todos = [
    { id: "todo-ws", workspaceId: "ws-1", workspaceName: "Rivera", title: "Ws task", state: "open", dueOn: null, reason: "assigned", href: "/t1", canMarkDone: true, placement: "workspace" },
    { id: "todo-dm", workspaceId: "ws-1", workspaceName: "Rivera", title: "DM task", state: "open", dueOn: null, reason: "assigned", href: "/t2", canMarkDone: true, placement: "group_dm", conversationId: "conv-grp-ab" },
  ];
  assert.deepEqual(filterWaitingTodos(todos, "channel", place1to1).map(t => t.id), []);
  assert.deepEqual(filterWaitingTodos(todos, "channel", placeGrpAB).map(t => t.id), ["todo-dm"]);
  assert.deepEqual(filterWaitingTodos(todos, "channel", placeGrpAC).map(t => t.id), []);

  // Ambiguous generations in indexDirectConversations map to null; omitting participantKey on place prevents
  // a legacy signal without conversationId from appearing in both restarted generations, and classifying
  // a direct ask without conversationId against an ambiguous participant key returns "unknown" (never a false zero).
  const ambiguous = indexDirectConversations([
    { conversationId: "conv-gen1", kind: "group_dm", members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: bob }] },
    { conversationId: "conv-gen2", kind: "group_dm", members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: bob }] },
  ]);
  assert.equal(ambiguous.get(keyGrpAB), null);
  const ambiguousUnresolved = classifyAskConversation(
    {
      channelId: null, to: viewer, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: bob }],
    },
    null,
    { directByParticipantKey: ambiguous },
  );
  assert.deepEqual(ambiguousUnresolved, { kind: "unknown" }, "ambiguous restarted group DM without conversationId must stay unknown (never false zero)");
  const authoritativeGen1 = classifyAskConversation(
    {
      channelId: null, to: null, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      conversationId: "conv-gen1", conversationKind: "group_dm",
    },
    null,
    { directByParticipantKey: ambiguous },
  );
  assert.equal(authoritativeGen1.kind, "group_dm");
  assert.equal(authoritativeGen1.conversationId, "conv-gen1");
  const placeAmbiguousGen1 = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Alice and Bob",
    conversationId: "conv-gen1",
  };
  const placeAmbiguousGen2 = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Alice and Bob",
    conversationId: "conv-gen2",
  };
  const genAsk = sampleAsk({ id: "ask-gen1-auth", conversation: authoritativeGen1, channelLabel: "Alice and Bob" });
  assert.deepEqual(filterWaitingItems([genAsk], "channel", placeAmbiguousGen1).map(i => i.id), ["ask-gen1-auth"]);
  assert.deepEqual(filterWaitingItems([genAsk], "channel", placeAmbiguousGen2).map(i => i.id), []);

  // Decoders accept authoritative conversation_id / conversation_kind on decision_queue and dm/group_dm origins on waiting_todos_page.
  const decodedQueue = parseDecisionQueue({
    workspace_id: "ws-1",
    generated_at: "2026-11-19T12:00:00Z",
    total: 3,
    truncated: false,
    asks: [
      {
        signal_id: "sig-1",
        from: { kind: "agent", id: "ag-1", name: "Scout" },
        body: "Approve?",
        created_at: "2026-11-19T11:55:00Z",
        until: "2026-11-20T11:55:00Z",
        conversation_id: "CONV-GEN1",
        conversation_kind: "group_dm",
        reraised: null,
      },
      {
        signal_id: "sig-redacted",
        from: { kind: "user", id: alice, name: "Alice" },
        body: "Left group ask",
        created_at: "2026-11-19T11:56:00Z",
        until: "2026-11-20T11:56:00Z",
        conversation_id: null,
        conversation_kind: null,
        reraised: null,
      },
      {
        signal_id: "sig-legacy",
        from: { kind: "user", id: alice, name: "Alice" },
        body: "Pre-migration ask",
        created_at: "2026-11-19T11:57:00Z",
        until: "2026-11-20T11:57:00Z",
        reraised: null,
      },
    ],
  }, "ws-1");
  assert.equal(decodedQueue.asks[0].conversation_id, "conv-gen1");
  assert.equal(decodedQueue.asks[0].conversation_kind, "group_dm");
  assert.equal(decodedQueue.asks[1].conversation_id, null);
  assert.equal(decodedQueue.asks[1].conversation_kind, null);
  assert.equal(decodedQueue.asks[2].conversation_id, undefined);
  assert.equal(decodedQueue.asks[2].conversation_kind, undefined);

  // Explicit null/null redaction (viewer left group DM gen 1 while restarted gen 2 is uniquely active)
  // stays unattached ("redacted"): excluded from gen 2 / This conversation, shown in All channels / All workspaces,
  // and never classified as "unknown".
  const onlyGen2Active = indexDirectConversations([
    { conversationId: "conv-gen2", kind: "group_dm", members: [{ kind: "user", id: viewer }, { kind: "user", id: alice }, { kind: "user", id: bob }] },
  ]);
  const redactedConv = classifyAskConversation(
    {
      channelId: null, to: null, toAgent: null, threadRootId: null, from: alice, fromKind: "user",
      conversationId: decodedQueue.asks[1].conversation_id,
      conversationKind: decodedQueue.asks[1].conversation_kind,
      recipients: [{ kind: "user", id: viewer }, { kind: "user", id: bob }],
    },
    null,
    { directByParticipantKey: onlyGen2Active },
  );
  assert.deepEqual(redactedConv, { kind: "redacted" }, "explicit null/null must classify as redacted, never gen 2 or unknown");
  const redactedAsk = sampleAsk({ id: "ask-left-gen1", conversation: redactedConv, channelLabel: "" });
  const placeOnlyGen2 = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Alice and Bob",
    conversationId: "conv-gen2", participantKey: keyGrpAB,
  };
  const placeAllMessages = {
    workspaceId: "ws-1", workspaceName: "Rivera", kind: "all", channelId: null, label: "All messages",
  };
  assert.deepEqual(filterWaitingItems([redactedAsk], "channel", placeOnlyGen2).map(i => i.id), [], "redacted left-gen-1 ask must stay out of restarted gen 2");
  assert.deepEqual(filterWaitingItems([redactedAsk], "channel", place1to1).map(i => i.id), [], "redacted ask must stay out of 1:1 DM");
  assert.deepEqual(filterWaitingItems([redactedAsk], "workspace", placeOnlyGen2).map(i => i.id), ["ask-left-gen1"], "redacted ask remains visible in All channels");
  assert.deepEqual(filterWaitingItems([redactedAsk], "all", placeOnlyGen2).map(i => i.id), ["ask-left-gen1"], "redacted ask remains visible in All workspaces");
  assert.deepEqual(filterWaitingItems([redactedAsk], "channel", placeAllMessages).map(i => i.id), ["ask-left-gen1"], "redacted ask remains visible in All messages");

  const decodedTodos = parseWaitingTodosQueue({
    workspace_id: "ws-1",
    generated_at: "2026-11-19T12:00:00Z",
    total: 2,
    truncated: false,
    todos: [
      {
        todo_id: "t-group", title: "Group task", state: "open", due_on: null, reason: "assigned",
        agent_id: null, state_at: "2026-11-19T11:55:00Z", placement: "group_dm", channel_id: null, conversation_id: "CONV-GEN1",
      },
      {
        todo_id: "t-dm", title: "DM task", state: "open", due_on: null, reason: "assigned",
        agent_id: null, state_at: "2026-11-19T11:54:00Z", placement: "dm", channel_id: null, conversation_id: "CONV-DM-1",
      },
    ],
  }, "ws-1");
  assert.deepEqual(decodedTodos.todos.map(t => [t.todo_id, t.placement, t.conversation_id]), [
    ["t-group", "group_dm", "conv-gen1"],
    ["t-dm", "dm", "conv-dm-1"],
  ]);
  assert.throws(() => parseWaitingTodosQueue({
    workspace_id: "ws-1", generated_at: "2026-11-19T12:00:00Z", total: 1, truncated: false,
    todos: [{
      todo_id: "t-bad", title: "Missing conv", state: "open", due_on: null, reason: "assigned",
      agent_id: null, state_at: "2026-11-19T11:55:00Z", placement: "group_dm", channel_id: null, conversation_id: null,
    }],
  }, "ws-1"), /home_waiting_todos_malformed/);

  // Scope option 0 says "This conversation" for 1:1 DM and group DM, and "This channel" for channels.
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const noopHandlers = {
    onScopeChange: () => {}, onClose: () => {}, onRetryLoad: () => {},
    onSubmitChoice: () => {}, onRetryChoice: () => {}, onDraftChoice: () => {},
  };
  renderWaitingPanel(host, {
    scope: "channel",
    place: placeGrpAB,
    items: [items[1]],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 4, complete: true }, all: { min: 4, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, noopHandlers);
  assert.equal(host.querySelector("[data-waiting-place]").textContent, "Alice and Bob");
  assert.deepEqual(
    host.querySelector("[data-waiting-scope]").options.map(o => o.textContent),
    ["This conversation (1)", "All channels (4)", "All workspaces (4)"],
  );

  renderWaitingPanel(host, {
    scope: "channel",
    place: { workspaceId: "ws-1", workspaceName: "Rivera", kind: "general", channelId: null, label: "#general" },
    items: [items[7]],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 4, complete: true }, all: { min: 4, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, noopHandlers);
  assert.deepEqual(
    host.querySelector("[data-waiting-scope]").options.map(o => o.textContent),
    ["This channel (1)", "All channels (4)", "All workspaces (4)"],
  );
});

test("Check F historical plain-text asks: inline answer, one-tap Clear as stale, DOM preservation while typing, and keyboard focus recovery on failure and completion", () => {
  assert.ok(STALE_ASK_CLOSE_BODY.length > 0 && !STALE_ASK_CLOSE_BODY.includes("\u2014"));
  assert.deepEqual(plainAskReplyCommand("sig-old-1", STALE_ASK_CLOSE_BODY), {
    kind: "post_signal",
    signal_kind: "note",
    body: STALE_ASK_CLOSE_BODY,
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: "sig-old-1",
    about: null,
  });

  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);

  const submitted = [];
  const retried = [];
  const drafted = [];
  const place = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "general", channelId: null, label: "#general" };
  const handlers = {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onSubmitPlainAsk: (item, bodyText, mode) => submitted.push({ id: item.id, bodyText, mode }),
    onRetryPlainAsk: (item) => retried.push(item.id),
    onDraftPlainAsk: (item, text) => drafted.push({ id: item.id, text }),
  };

  const plain1 = {
    id: "plain-1",
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    conversation: { kind: "general" },
    channelLabel: "#general",
    from: agent,
    fromKind: "agent",
    fromId: "a1",
    what: "Should we renew the lawn service for spring?",
    when: "2d ago",
    createdAt: "2026-11-17T12:00:00Z",
    until: "2026-11-24T12:00:00Z",
  };
  const plain2 = {
    ...plain1,
    id: "plain-2",
    what: "Did the electrician call back?",
  };

  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    plainAsks: [plain1, plain2],
    counts: { channel: { min: 2, complete: true }, workspace: { min: 2, complete: true }, all: { min: 2, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, handlers);

  const card1 = host.querySelector('[data-waiting-plain-ask="plain-1"]');
  assert.ok(card1);
  const input1 = card1.querySelector('[data-waiting-plain-input="plain-1"]');
  const send1 = card1.querySelector('[data-waiting-plain-send="plain-1"]');
  const stale1 = card1.querySelector('[data-waiting-plain-stale="plain-1"]');
  assert.equal(send1.disabled, true, "Send stays disabled while answer input is empty");

  // Typing updates draft, enables Send, and survives an unchanged background refresh without replacing the DOM node.
  input1.focus();
  input1.value = "Yes, book them for April";
  input1.dispatchEvent({ type: "input" });
  assert.equal(send1.disabled, false);
  assert.deepEqual(drafted, [{ id: "plain-1", text: "Yes, book them for April" }]);

  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    plainAsks: [{ ...plain1, when: "2d ago", draftText: "Yes, book them for April" }, plain2],
    counts: { channel: { min: 2, complete: true }, workspace: { min: 2, complete: true }, all: { min: 2, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, handlers);
  assert.strictEqual(host.querySelector('[data-waiting-plain-ask="plain-1"]'), card1, "typing must keep exact DOM node");
  assert.strictEqual(doc.activeElement, input1);

  // Submitting the form sends the typed inline answer.
  card1.querySelector("form").dispatchEvent({ type: "submit" });
  assert.deepEqual(submitted, [{ id: "plain-1", bodyText: "Yes, book them for April", mode: "answer" }]);

  // One tap on Clear as stale sends the fixed stale-close body.
  stale1.click();
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[1], { id: "plain-1", bodyText: STALE_ASK_CLOSE_BODY, mode: "stale" });

  // Failed delivery renders role="alert" + Retry and focusWaitingPanelAfterAction focuses Retry on that card.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    plainAsks: [{ ...plain1, draftText: "Yes, book them for April", error: "Could not deliver answer.", retryable: true }, plain2],
    counts: { channel: { min: 2, complete: true }, workspace: { min: 2, complete: true }, all: { min: 2, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, handlers);
  const retryBtn = host.querySelector('[data-waiting-plain-retry="plain-1"]');
  assert.ok(retryBtn);
  const failedCard = host.querySelector('[data-waiting-plain-ask="plain-1"]');
  assert.equal(failedCard.querySelector(".cs-waiting-card__error").textContent, "Could not deliver answer.");
  focusWaitingPanelAfterAction(host, { kind: "retry-plain", signalId: "plain-1" });
  assert.strictEqual(doc.activeElement, retryBtn);
  retryBtn.click();
  assert.deepEqual(retried, ["plain-1"]);

  // Completing plain-1 removes it, displays Cleared banner, and moves focus to plain-2 (never document.body).
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    plainAsks: [plain2],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 1, complete: true }, all: { min: 1, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "Cleared", statusSeq: 1,
  }, handlers);
  assert.equal(host.querySelector('[data-waiting-plain-ask="plain-1"]'), null);
  assert.equal(host.querySelector("[data-waiting-status]").textContent, "Cleared");
  focusWaitingPanelAfterAction(host, { kind: "completed-plain", prevIndex: 0 });
  assert.strictEqual(doc.activeElement, host.querySelector('[data-waiting-plain-stale="plain-2"]'));
});

test("answerChoice and answerPlainAsk forward isAlive to fence dispatch and 401 retry when login retires", async () => {
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  const calls = [];
  globalThis.document = {
    querySelector(sel) {
      if (sel === 'meta[name="commonswarm:url"]') return { content: "https://api.test.invalid" };
      if (sel === 'meta[name="commonswarm:anon-key"]') return { content: "synthetic-public" };
      return null;
    },
  };
  let nextStatus = 200;
  let nextBody = { status: "accepted", choice_answer: { option_id: "yes", other_text: null } };
  let onFetch = null;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    onFetch?.();
    return new Response(JSON.stringify(nextBody), { status: nextStatus, headers: { "content-type": "application/json" } });
  };
  const fakeSession = {
    access_token: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ sub: "u-a", session_id: "sess-a" })).toString("base64url")}.sig`,
    refresh_token: "synthetic-refresh-a",
    token_type: "bearer",
    expires_in: 3600,
    user: { id: "u-a" },
  };
  const supa = client();
  assert.ok(supa, "authoritative client initialized for guarded action test");
  const origGetSession = supa.auth.getSession.bind(supa.auth);
  supa.auth.getSession = async () => ({ data: { session: fakeSession }, error: null });
  try {
    // 1. Pre-retired guard blocks dispatch with zero HTTP calls for both wrappers.
    const choiceBlocked = await answerChoice(fakeSession, "cmd-1", "ws-1", "sig-1", false, { optionIds: ["yes"], otherText: null }, { isAlive: () => false });
    const plainBlocked = await answerPlainAsk(fakeSession, "cmd-2", "ws-1", "sig-2", "Answer text", { isAlive: () => false });
    assert.equal(choiceBlocked.ok, false);
    assert.equal(choiceBlocked.error, "operation_retired");
    assert.equal(plainBlocked.ok, false);
    assert.equal(plainBlocked.error, "operation_retired");
    assert.equal(calls.length, 0);

    // 2. Flipping isAlive to false upon a 401 response fences the 401 retry cleanly with zero second fetch.
    let alive = true;
    nextStatus = 401;
    nextBody = { error: "unauthenticated" };
    onFetch = () => { alive = false; };
    const plain401 = await answerPlainAsk(fakeSession, "cmd-3", "ws-1", "sig-3", "Answer text", { isAlive: () => alive });
    assert.equal(plain401.ok, false);
    assert.equal(plain401.error, "operation_retired");
    assert.equal(calls.length, 1);

    // 3. Unchanged-login control (isAlive stays true) delivers normally.
    nextStatus = 200;
    nextBody = { status: "accepted", ok: true, signal: { id: "sig-reply" } };
    onFetch = null;
    const plainOk = await answerPlainAsk(fakeSession, "cmd-4", "ws-1", "sig-4", "Control answer", { isAlive: () => true });
    assert.deepEqual(plainOk, { ok: true });
    assert.equal(calls.length, 2);
  } finally {
    supa.auth.getSession = origGetSession;
    try { await supa.auth.stopAutoRefresh(); } catch { /* ignore */ }
    globalThis.document = prevDocument;
    globalThis.fetch = prevFetch;
  }
});

test("Waiting on you Archived view: decoder validation, scope/redaction isolation, tabs, cards, Load older, and PGRST202 unavailable fallback", () => {
  const page = parseWaitingArchivedPage({
    workspace_id: "ws-1",
    generated_at: "2026-11-20T12:00:00Z",
    untrusted_content: true,
    total: 4,
    truncated: true,
    items: [
      {
        item_key: "ask:11111111-1111-4111-8111-111111111111",
        kind: "ask",
        id: "11111111-1111-4111-8111-111111111111",
        todo_id: null,
        ask_kind: "choice",
        title: "Context line\n\nApprove <boiler> quote?",
        from: { kind: "agent", id: "ag-1", name: "Scout" },
        outcome_kind: "answered",
        outcome_text: "Approve quote · Check warranty",
        archived_at: "2026-11-20T11:55:00Z",
        answered_by: { kind: "user", id: "u-viewer", name: "Owner", by_viewer: true },
        placement: "group_dm",
        channel_id: null,
        conversation_id: "CONV-GEN1",
        conversation_kind: "group_dm",
      },
      {
        item_key: "todo:22222222-2222-4222-8222-222222222222",
        kind: "todo",
        id: "22222222-2222-4222-8222-222222222222",
        todo_id: "22222222-2222-4222-8222-222222222222",
        ask_kind: null,
        title: "Book plumber",
        from: { kind: "user", id: "u-viewer", name: "Owner" },
        outcome_kind: "done",
        outcome_text: "Done",
        archived_at: "2026-11-20T11:50:00Z",
        answered_by: { kind: "user", id: "u-viewer", name: "Owner", by_viewer: true },
        placement: "group_dm",
        channel_id: null,
        conversation_id: "CONV-GEN1",
        conversation_kind: "group_dm",
      },
      {
        item_key: "review:33333333-3333-4333-8333-333333333333",
        kind: "review",
        id: "33333333-3333-4333-8333-333333333333",
        todo_id: "44444444-4444-4444-8444-444444444444",
        ask_kind: null,
        title: "Review proposal",
        from: { kind: "user", id: "u-maya", name: "Maya" },
        outcome_kind: "accepted",
        outcome_text: "Accepted",
        archived_at: "2026-11-20T11:45:00Z",
        answered_by: { kind: "user", id: "u-viewer", name: "Owner", by_viewer: true },
        placement: "channel",
        channel_id: "CH-BOILER",
        conversation_id: null,
        conversation_kind: null,
      },
      {
        item_key: "ask:55555555-5555-4555-8555-555555555555",
        kind: "ask",
        id: "55555555-5555-4555-8555-555555555555",
        todo_id: null,
        ask_kind: "plain",
        title: "Left group question?",
        from: { kind: "agent", id: "ag-1", name: "Scout" },
        outcome_kind: "cleared_stale",
        outcome_text: "Cleared as stale",
        archived_at: "2026-11-20T11:40:00Z",
        answered_by: { kind: "user", id: "u-viewer", name: "Owner", by_viewer: true },
        placement: "redacted",
        channel_id: null,
        conversation_id: null,
        conversation_kind: null,
      },
    ],
  }, "ws-1");
  assert.ok(page);
  assert.equal(page.total, 4);
  assert.equal(page.truncated, true);
  assert.equal(page.items[0].conversation_id, "conv-gen1");
  assert.equal(page.items[2].channel_id, "ch-boiler");
  assert.equal(parseWaitingArchivedPage(null, "ws-1"), null);
  assert.throws(() => parseWaitingArchivedPage({
    workspace_id: "ws-1", generated_at: "2026-11-20T12:00:00Z", total: 1, truncated: false,
    items: [{
      item_key: "ask:1", kind: "ask", id: "1", todo_id: null, ask_kind: "plain", title: "Bad",
      from: null, outcome_kind: "answered", outcome_text: "ok", archived_at: "2026-11-20T11:55:00Z",
      answered_by: null, placement: "group_dm", channel_id: null, conversation_id: null, conversation_kind: null,
    }],
  }, "ws-1"), /home_waiting_archived_malformed/);

  const mapped = page.items.map(entry => mapWaitingArchivedEntry(entry, {
    workspaceId: "ws-1",
    workspaceName: "Rivera",
    channelLabel: entry.placement === "group_dm" ? "Scout and Maya" : entry.placement === "channel" ? "#boiler-quotes" : "",
    href: entry.todo_id
      ? `/app?w=ws-1&todo=${entry.todo_id}`
      : entry.placement === "group_dm" && entry.conversation_id
        ? `/app?w=ws-1&dm=${entry.conversation_id}&m=${entry.id}`
        : null,
    viewerId: "u-viewer",
    now: Date.parse("2026-11-20T12:00:00Z"),
  }));
  assert.equal(mapped[0].title, "Approve <boiler> quote?", "choice prompt strips preamble cleanly");

  const placeGen1 = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Scout and Maya", conversationId: "conv-gen1" };
  const placeGen2 = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "group_dm", channelId: null, label: "Scout and Maya", conversationId: "conv-gen2" };
  const placeBoiler = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "channel", channelId: "ch-boiler", label: "#boiler-quotes" };

  assert.deepEqual(filterWaitingArchived(mapped, "channel", placeGen1).map(i => i.kind), ["ask", "todo"]);
  assert.deepEqual(filterWaitingArchived(mapped, "channel", placeGen2).map(i => i.kind), [], "restarted Gen 2 must have zero bleed from Gen 1 or redacted asks");
  assert.deepEqual(filterWaitingArchived(mapped, "channel", placeBoiler).map(i => i.kind), ["review"]);
  assert.equal(filterWaitingArchived(mapped, "workspace", placeGen2).length, 4, "All channels includes redacted left-group item");

  // Render Waiting | Archived tabs, switch to Archived, check cards + Load older + Open + PGRST202 unavailable.
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const tabsPicked = [];
  const opened = [];
  let loadMoreCount = 0;
  const handlers = {
    onTabChange: (t) => tabsPicked.push(t),
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onLoadMoreArchived: () => { loadMoreCount += 1; },
    onOpenArchivedTodo: (item) => opened.push(item.itemKey),
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
  };

  renderWaitingPanel(host, {
    tab: "archived",
    scope: "workspace",
    place: placeGen1,
    items: [],
    archived: {
      items: mapped,
      counts: {
        channel: { min: 2, complete: false },
        workspace: { min: 4, complete: true },
        all: { min: 4, complete: true },
      },
      loading: false,
      loadingMore: false,
      complete: true,
      failed: false,
      hasMore: true,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, handlers);

  const tabActive = host.querySelector('[data-waiting-tab="active"]');
  const tabArchived = host.querySelector('[data-waiting-tab="archived"]');
  assert.equal(tabActive.getAttribute("aria-selected"), "false");
  assert.equal(tabArchived.getAttribute("aria-selected"), "true");
  tabActive.click();
  assert.deepEqual(tabsPicked, ["active"]);

  const askCard = host.querySelector('[data-waiting-archived-item="ask:11111111-1111-4111-8111-111111111111"]');
  assert.ok(askCard);
  assert.equal(askCard.querySelector(".cs-waiting-card__question").textContent, "Approve <boiler> quote?");
  assert.equal(askCard.querySelector(".cs-waiting-archived__answer").textContent, "Approve quote · Check warranty");
  assert.equal(askCard.querySelector(".cs-waiting-archived__meta").dateTime, "2026-11-20T11:55:00Z");
  assert.equal(askCard.querySelector(".cs-waiting-card__place").textContent, "Scout and Maya");
  const openAsk = askCard.querySelector('[data-waiting-archived-open="ask:11111111-1111-4111-8111-111111111111"]');
  assert.ok(openAsk, "visible archived ask renders an Open source link");
  assert.equal(openAsk.href, "/app?w=ws-1&dm=conv-gen1&m=11111111-1111-4111-8111-111111111111");
  const redactedAskCard = host.querySelector('[data-waiting-archived-item="ask:55555555-5555-4555-8555-555555555555"]');
  assert.ok(redactedAskCard);
  assert.equal(redactedAskCard.querySelector("[data-waiting-archived-open]"), null, "redacted ask omits source link");

  const openReview = host.querySelector('[data-waiting-archived-open="review:33333333-3333-4333-8333-333333333333"]');
  assert.ok(openReview);
  openReview.click();
  assert.deepEqual(opened, ["review:33333333-3333-4333-8333-333333333333"]);

  const loadMoreBtn = host.querySelector("[data-waiting-archived-more]");
  assert.ok(loadMoreBtn);
  assert.equal(loadMoreBtn.textContent, "Load older");
  loadMoreBtn.click();
  assert.equal(loadMoreCount, 1);

  // PGRST202 unavailable fallback renders cleanly without crashing.
  renderWaitingPanel(host, {
    tab: "archived",
    scope: "workspace",
    place: placeGen1,
    items: [],
    archived: {
      items: [],
      counts: { channel: { min: 0, complete: false }, workspace: { min: 0, complete: false }, all: { min: 0, complete: false } },
      loading: false, loadingMore: false, complete: true, failed: false, unavailable: true, hasMore: false,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, handlers);
  assert.equal(host.querySelector('[data-waiting-archived-state="unavailable"]').textContent, "Archived history is unavailable on this server.");

  // Designer CHANGES witness: when the current channel (#garden) has 0 matches on page 1 but older
  // archive pages remain (hasMore: true), NEVER say "No archived items in #garden." — keep Load older
  // available in the current scope, and show the empty message ONLY after the last page (hasMore: false).
  const placeGarden = { workspaceId: "ws-1", workspaceName: "Home", kind: "channel", channelId: "ch-garden", label: "#garden" };
  let gardenLoadMore = 0;
  const gardenHandlers = { ...handlers, onLoadMoreArchived: () => { gardenLoadMore += 1; } };
  renderWaitingPanel(host, {
    tab: "archived",
    scope: "channel",
    place: placeGarden,
    items: [],
    archived: {
      items: [],
      counts: {
        channel: { min: 0, complete: false },
        workspace: { min: 35, complete: true },
        all: { min: 35, complete: true },
      },
      loading: false,
      loadingMore: false,
      complete: true,
      failed: false,
      hasMore: true,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, gardenHandlers);
  assert.equal(host.querySelector('[data-waiting-archived-state="empty"]'), null, "must not show empty state while older archive pages remain");
  assert.ok(host.querySelector('[data-waiting-archived-state="more"]'), "renders more-pages state in #garden scope");
  assert.equal(host.textContent.includes("No archived items in #garden."), false, "must not claim #garden is empty before exhausting older pages");
  const gardenMoreBtn = host.querySelector("[data-waiting-archived-more]");
  assert.ok(gardenMoreBtn, "Load older stays available in #garden scope");
  assert.equal(gardenMoreBtn.textContent, "Load older");
  gardenMoreBtn.click();
  assert.equal(gardenLoadMore, 1);

  // Once the final page finishes with still zero matches (hasMore: false), NOW show the empty message.
  renderWaitingPanel(host, {
    tab: "archived",
    scope: "channel",
    place: placeGarden,
    items: [],
    archived: {
      items: [],
      counts: {
        channel: { min: 0, complete: true },
        workspace: { min: 35, complete: true },
        all: { min: 35, complete: true },
      },
      loading: false,
      loadingMore: false,
      complete: true,
      failed: false,
      hasMore: false,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, gardenHandlers);
  assert.ok(host.querySelector('[data-waiting-archived-state="empty"]'), "empty state appears after archive is exhausted");
  assert.equal(host.querySelector(".cs-waiting-panel__state-text").textContent, "No archived items in #garden.");
  assert.equal(host.querySelector("[data-waiting-archived-more]"), null);
});

test("Waiting panel Dismiss, in-place Undo, failure recovery, and Archived Dismissed with Restore", async () => {
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);

  const place = { workspaceId: "ws-1", workspaceName: "Home", kind: "general", channelId: null, label: "#general" };
  const ask1 = {
    id: "ask-1",
    workspaceId: "ws-1",
    workspaceName: "Home",
    conversation: { kind: "general" },
    channelLabel: "#general",
    from: { id: "a-1", name: "Scout", label: "Scout", nestedLabel: "Scout", ownerId: null, ownerFirstName: null, ownerInitial: "", yours: false, tint: "sage", hosted: false, state: { kind: "idle", word: "Idle", detail: "", attention: false, fix: { action: null, allowed: false, askWho: null, sentence: "" } } },
    fromKind: "agent",
    fromId: "a-1",
    what: "Approve deploy?",
    when: "1m ago",
    createdAt: "2026-11-23T10:00:00Z",
    until: "9999-12-31T23:59:59Z",
    choices: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], multi: false },
  };
  const plain1 = {
    id: "plain-1",
    workspaceId: "ws-1",
    workspaceName: "Home",
    conversation: { kind: "general" },
    channelLabel: "#general",
    from: ask1.from,
    fromKind: "agent",
    fromId: "a-1",
    what: "Legacy plain ask?",
    when: "2m ago",
    createdAt: "2026-11-23T09:59:00Z",
    until: "9999-12-31T23:59:59Z",
  };
  const todo1 = {
    id: "todo-1",
    workspaceId: "ws-1",
    workspaceName: "Home",
    title: "Call electrician",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: "/app?w=ws-1&todo=todo-1",
    canMarkDone: true,
    placement: "general",
    channelId: null,
  };
  const review1 = {
    id: "todo-review-1",
    workspaceId: "ws-1",
    workspaceName: "Home",
    title: "Scout roof inspection",
    state: "open",
    dueOn: null,
    reason: "request",
    href: "/app?w=ws-1&todo=todo-review-1",
    canMarkDone: false,
    placement: "general",
    channelId: null,
  };

  let items = [ask1];
  let plainAsks = [plain1];
  let todos = [todo1, review1];
  let placeholders = [];
  const dismissedCalls = [];
  const undoCalls = [];
  const restoreCalls = [];

  const renderActive = () => {
    const count = items.length + plainAsks.length + todos.length;
    renderWaitingPanel(host, {
      tab: "active",
      scope: "channel",
      place,
      items,
      plainAsks,
      todos,
      dismissedPlaceholders: placeholders,
      counts: {
        channel: { min: count, complete: true },
        workspace: { min: count, complete: true },
        all: { min: count, complete: true },
      },
      loading: false,
      complete: true,
      failed: false,
      statusMessage: "",
      statusSeq: 0,
    }, {
      onScopeChange: () => {},
      onClose: () => {},
      onRetryLoad: () => {},
      onSubmitChoice: () => {},
      onRetryChoice: () => {},
      onDraftChoice: () => {},
      onDismissAsk: (item) => {
        dismissedCalls.push(["ask", item.id]);
        items = items.filter(i => i.id !== item.id);
        placeholders = [{ key: `ask:${item.id}`, itemKind: "ask", itemId: item.id, cardId: item.id, workspaceId: item.workspaceId, position: 0 }];
        renderActive();
      },
      onDismissPlainAsk: (item) => {
        dismissedCalls.push(["plain", item.id]);
        plainAsks = plainAsks.filter(i => i.id !== item.id);
        renderActive();
      },
      onDismissTodo: (item) => {
        dismissedCalls.push([item.reason === "request" ? "review" : "todo", item.id]);
        todos = todos.filter(t => t.id !== item.id);
        renderActive();
      },
      onUndoDismiss: (ph) => {
        undoCalls.push(ph.key);
        placeholders = placeholders.map(p => (p.key === ph.key ? { ...p, pendingUndo: true } : p));
        renderActive();
      },
      onRestoreArchived: (item) => {
        restoreCalls.push(item.itemKey);
      },
    });
  };

  renderActive();

  // Every card kind renders a real <button> labeled "Dismiss", and plain asks KEEP "Clear as stale".
  const dismissButtons = host.querySelectorAll("[data-waiting-dismiss]");
  assert.equal(dismissButtons.length, 4);
  for (const btn of dismissButtons) {
    assert.equal(btn.tagName, "BUTTON");
    assert.equal(btn.textContent, "Dismiss");
  }
  assert.deepEqual(dismissButtons.map(b => b.dataset.waitingDismiss), ["ask", "todo", "review", "ask"]);
  assert.ok(host.querySelector('[data-waiting-plain-stale="plain-1"]'), "plain ask keeps Clear as stale alongside Dismiss");

  // Clicking Dismiss removes the card, updates count, and shows "Dismissed" + "Undo" in place (with zero item content).
  dismissButtons[0].click();
  assert.deepEqual(dismissedCalls, [["ask", "ask-1"]]);
  assert.equal(host.querySelector('[data-waiting-card="ask-1"]'), null);
  const dismissedRow = host.querySelector('[data-waiting-dismissed="ask:ask-1"]');
  assert.ok(dismissedRow);
  assert.equal(dismissedRow.querySelector(".cs-waiting-dismissed__label").textContent, "Dismissed");
  assert.equal(dismissedRow.textContent.includes(ask1.what), false, "Dismissed row renders no content from the item");
  const undoBtn = dismissedRow.querySelector('[data-waiting-undo="ask:ask-1"]');
  assert.ok(undoBtn);
  assert.equal(undoBtn.tagName, "BUTTON");
  assert.equal(undoBtn.textContent, "Undo");
  assert.equal(host.querySelector("[data-waiting-scope]").options[0].textContent, "This channel (3)");

  // Focus helper targets the in-place Undo button.
  focusWaitingPanelAfterAction(host, { kind: "dismissed", dismissedKey: "ask:ask-1" });
  assert.strictEqual(doc.activeElement, undoBtn);

  // Clicking Undo switches the row to "Undoing…" and does NOT re-insert the card itself before reload.
  undoBtn.click();
  assert.deepEqual(undoCalls, ["ask:ask-1"]);
  assert.equal(host.querySelector('[data-waiting-card="ask-1"]'), null);
  const undoingBtn = host.querySelector('[data-waiting-undo="ask:ask-1"]');
  assert.ok(undoingBtn);
  assert.equal(undoingBtn.textContent, "Undoing…");
  assert.equal(undoingBtn.getAttribute("aria-disabled"), "true");

  // Card reappears only after the server reload supplies it and removes the placeholder.
  placeholders = [];
  items = [ask1];
  renderActive();
  assert.ok(host.querySelector('[data-waiting-card="ask-1"]'));
  assert.equal(host.querySelector('[data-waiting-dismissed="ask:ask-1"]'), null);
  assert.equal(host.querySelector("[data-waiting-scope]").options[0].textContent, "This channel (4)");

  // Failed non-404 dismiss reloads card with role="alert" error treatment.
  items = [{ ...ask1, choices: { ...ask1.choices, error: "Could not dismiss. Try again." } }];
  placeholders = [];
  renderActive();
  const restoredCard = host.querySelector('[data-waiting-card="ask-1"]');
  assert.ok(restoredCard);
  assert.ok(restoredCard.textContent.includes("Could not dismiss. Try again."));

  // Dismissing the LAST remaining card still renders the in-place "Dismissed · Undo" row (not empty state).
  items = [];
  plainAsks = [];
  todos = [];
  placeholders = [{ key: "ask:ask-1", itemKind: "ask", itemId: "ask-1", cardId: "ask-1", workspaceId: "ws-1", position: 0 }];
  renderActive();
  assert.ok(host.querySelector('[data-waiting-dismissed="ask:ask-1"]'));
  assert.equal(host.querySelector('[data-waiting-state="empty"]'), null);

  // Archived tab parses and renders outcome_kind="dismissed" with muted tone and "Restore" button.
  const parsedArchived = parseWaitingArchivedPage({
    workspace_id: "ws-1",
    generated_at: "2026-11-23T12:00:00Z",
    total: 1,
    truncated: false,
    items: [{
      item_key: "ask:11111111-2222-4333-8444-555555555555",
      kind: "ask",
      id: "11111111-2222-4333-8444-555555555555",
      todo_id: null,
      ask_kind: "choice",
      title: "Approve deploy?",
      from: { kind: "agent", id: "a-1", name: "Scout" },
      outcome_kind: "dismissed",
      outcome_text: "Dismissed",
      archived_at: "2026-11-23T11:55:00Z",
      answered_by: { kind: "user", id: "u-1", name: "Alice", by_viewer: true },
      placement: "general",
      channel_id: null,
      conversation_id: null,
      conversation_kind: "general",
    }],
  }, "ws-1");
  assert.equal(parsedArchived.items[0].outcome_kind, "dismissed");
  const mappedArchived = mapWaitingArchivedEntry(parsedArchived.items[0], {
    workspaceId: "ws-1",
    workspaceName: "Home",
    channelLabel: "#general",
    href: "/app?w=ws-1&m=11111111-2222-4333-8444-555555555555",
    viewerId: "u-1",
    now: Date.parse("2026-11-23T12:00:00Z"),
  });

  renderWaitingPanel(host, {
    tab: "archived",
    scope: "workspace",
    place,
    items: [],
    archived: {
      items: [mappedArchived],
      counts: { channel: { min: 1, complete: true }, workspace: { min: 1, complete: true }, all: { min: 1, complete: true } },
      loading: false, loadingMore: false, complete: true, failed: false, hasMore: false,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onRestoreArchived: (item) => restoreCalls.push(item.itemKey),
  });

  const outcome = host.querySelector('[data-waiting-archived-outcome="dismissed"]');
  assert.ok(outcome);
  assert.equal(outcome.dataset.outcomeTone, "muted");
  assert.equal(outcome.querySelector(".cs-waiting-archived__answer").textContent, "Dismissed");
  const restoreBtn = host.querySelector(`[data-waiting-archived-restore="${mappedArchived.itemKey}"]`);
  assert.ok(restoreBtn);
  assert.equal(restoreBtn.tagName, "BUTTON");
  assert.equal(restoreBtn.textContent, "Restore");
  restoreBtn.click();
  assert.deepEqual(restoreCalls, [mappedArchived.itemKey]);

  // Wire command builders match server contract.
  assert.deepEqual(dismissWaitingItemCommand("review", "offer-1"), {
    kind: "dismiss_waiting_item",
    item_kind: "review",
    item_id: "offer-1",
  });
  assert.deepEqual(restoreWaitingItemCommand("todo", "todo-1"), {
    kind: "restore_waiting_item",
    item_kind: "todo",
    item_id: "todo-1",
  });
  assert.equal(typeof dismissWaitingItem, "function");
  assert.equal(typeof restoreWaitingItem, "function");
});

test("C3 dismissal controller: Undo reloads without inserting a saved card; access loss retires rows and fences late refusals; unchanged-access control restores after reload", async () => {
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const place = { workspaceId: "ws-1", workspaceName: "Home", kind: "all", channelId: null, label: "All channels" };
  const placeKey = "ws-1:all::::";

  const makeChoiceAsk = (id, what, conversation) => ({
    id,
    workspaceId: "ws-1",
    workspaceName: "Home",
    conversation,
    channelLabel: conversation.kind === "channel" ? "#secret" : conversation.kind === "dm" ? "DM" : "#general",
    from: { id: "a-1", name: "Scout", label: "Scout", nestedLabel: "Scout", ownerId: "u-1", ownerFirstName: "Alice", ownerInitial: "A", yours: true, tint: "amber", hosted: true, state: { kind: "idle", word: "Idle", detail: "", attention: false, fix: { action: null, allowed: false, askWho: null, sentence: "" } } },
    fromKind: "agent",
    fromId: "a-1",
    what,
    when: "1m",
    createdAt: "2026-11-23T12:00:00Z",
    until: "2026-11-24T12:00:00Z",
    choices: { multi: false, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  });

  const dmAsk = makeChoiceAsk("ask-dm", "Secret DM question?", { kind: "dm", partnerKind: "person", partnerId: "u-2", conversationId: "conv-dm" });
  const privAsk = makeChoiceAsk("ask-priv", "Private channel question?", { kind: "channel", channelId: "ch-priv" });
  const genAsk = makeChoiceAsk("ask-gen", "General question?", { kind: "general" });

  // Server-backed fixture lists (mutated only to simulate authoritative server state).
  let serverAsks = [dmAsk, privAsk, genAsk];
  let clientAsks = [...serverAsks];
  let cardErrors = new Map();
  let statusMessage = "";
  let statusSeq = 0;
  let reloadCount = 0;

  let nextDismiss = () => Promise.resolve({ ok: true, itemKind: "ask", itemId: "", dismissed: true, dismissedAt: "2026-11-23T12:01:00Z" });
  let nextRestore = () => Promise.resolve({ ok: true, itemKind: "ask", itemId: "", restored: true, restoredAt: "2026-11-23T12:02:00Z" });

  let ctrl;
  const render = () => {
    const items = clientAsks.map(item => (cardErrors.has(item.id)
      ? { ...item, choices: { ...item.choices, error: cardErrors.get(item.id) } }
      : item));
    renderWaitingPanel(host, {
      tab: "active",
      scope: "workspace",
      place,
      items,
      plainAsks: [],
      todos: [],
      dismissedPlaceholders: ctrl.placeholdersFor(placeKey, "workspace"),
      counts: {
        channel: { min: items.length, complete: true },
        workspace: { min: items.length, complete: true },
        all: { min: items.length, complete: true },
      },
      loading: false,
      complete: true,
      failed: false,
      statusMessage,
      statusSeq,
    }, {
      onScopeChange: () => {},
      onClose: () => {},
      onRetryLoad: () => {},
      onSubmitChoice: () => {},
      onRetryChoice: () => {},
      onDraftChoice: () => {},
      onDismissAsk: (item) => void ctrl.dismiss({
        slotKind: "ask",
        itemKind: "ask",
        itemId: item.id,
        cardId: item.id,
        workspaceId: item.workspaceId,
        channelId: item.conversation.kind === "channel" ? item.conversation.channelId : null,
        conversationId: item.conversation.kind === "dm" || item.conversation.kind === "group_dm" ? item.conversation.conversationId ?? null : null,
        placementKind: item.conversation.kind,
        position: 0,
        placeKey,
        scope: "workspace",
      }),
      onUndoDismiss: (ph) => void ctrl.undo(ph.key),
    });
  };

  ctrl = createWaitingDismissalController({
    sendDismiss: (ws, kind, id) => nextDismiss(ws, kind, id),
    sendRestore: (ws, kind, id) => nextRestore(ws, kind, id),
    isAlive: () => true,
    removeCardFromClient: (target) => {
      clientAsks = clientAsks.filter(i => i.id !== target.cardId);
      cardErrors.delete(target.cardId);
    },
    onRetireAccessLoss: (ev) => {
      if (ev.kind === "conversation") {
        clientAsks = clientAsks.filter(i => !(i.conversation.kind === "dm" && i.conversation.conversationId === ev.conversationId));
      } else if (ev.kind === "channel") {
        clientAsks = clientAsks.filter(i => !(i.conversation.kind === "channel" && i.conversation.channelId === ev.channelId));
      }
    },
    reloadWaiting: async () => {
      reloadCount += 1;
      const pending = ctrl.pendingDismissCardIds("ws-1");
      clientAsks = serverAsks.filter(i => !pending.has(i.id));
      render();
    },
    invalidateArchived: () => {},
    setCardError: (_slot, id, msg) => { cardErrors.set(id, msg); },
    setStatusError: (msg) => { statusMessage = msg; statusSeq += 1; },
    setArchivedError: () => {},
    clearArchivedError: () => {},
    render,
  });

  render();

  // 1. Held Dismiss refusal arriving AFTER authoritative DM conversation loss paints NOTHING (no card, no row, no error).
  let settleDmDismiss;
  nextDismiss = () => new Promise(resolve => { settleDmDismiss = resolve; });
  const dmDismissPromise = ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: dmAsk.id, cardId: dmAsk.id,
    workspaceId: "ws-1", channelId: null, conversationId: "conv-dm", placementKind: "dm",
    position: 0, placeKey, scope: "workspace",
  });
  assert.ok(host.querySelector('[data-waiting-dismissed="ask:ask-dm"]'), "in-place Dismissed row shown while in flight");
  assert.equal(host.textContent.includes(dmAsk.what), false, "DM question text is gone from DOM");

  // Authoritative conversation loss happens BEFORE Dismiss settles!
  serverAsks = serverAsks.filter(i => i.id !== dmAsk.id);
  const retired = ctrl.retireForConversation("ws-1", "conv-dm", null);
  assert.equal(retired, true);
  assert.equal(host.querySelector('[data-waiting-dismissed="ask:ask-dm"]'), null, "Dismissed row retired synchronously");
  assert.equal(host.querySelector('[data-waiting-card="ask-dm"]'), null);

  // Late refusal (even a 500 or 404) settles -> fenced out, paints nothing, sets no error!
  const reloadsBeforeLateRefusal = reloadCount;
  settleDmDismiss({ ok: false, status: 500, error: "server_error", message: "Should never appear" });
  await dmDismissPromise;
  assert.equal(reloadCount, reloadsBeforeLateRefusal, "retired dismiss settlement is ignored");
  assert.equal(host.querySelector('[data-waiting-card="ask-dm"]'), null);
  assert.equal(host.querySelector('[data-waiting-dismissed="ask:ask-dm"]'), null);
  assert.equal(cardErrors.has(dmAsk.id), false);
  assert.equal(host.textContent.includes(dmAsk.what), false);

  // 2. Undo refused (404) after private-channel loss paints NOTHING.
  nextDismiss = async () => {
    serverAsks = serverAsks.filter(i => i.id !== privAsk.id);
    return { ok: true, itemKind: "ask", itemId: privAsk.id, dismissed: true, dismissedAt: "2026-11-23T12:01:00Z" };
  };
  await ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: privAsk.id, cardId: privAsk.id,
    workspaceId: "ws-1", channelId: "ch-priv", conversationId: null, placementKind: "channel",
    position: 0, placeKey, scope: "workspace",
  });
  assert.ok(host.querySelector('[data-waiting-dismissed="ask:ask-priv"]'));

  let settlePrivUndo;
  nextRestore = () => new Promise(resolve => { settlePrivUndo = resolve; });
  const privUndoPromise = ctrl.undo("ask:ask-priv");
  // While Undo waits, row shows "Undoing…" and does NOT insert privAsk!
  assert.equal(host.querySelector('[data-waiting-undo="ask:ask-priv"]').textContent, "Undoing…");
  assert.equal(host.querySelector('[data-waiting-card="ask-priv"]'), null);
  await Promise.resolve();

  // Server refuses restore with 404 (caller removed from private channel); reload returns no privAsk.
  settlePrivUndo({ ok: false, status: 404, error: "not_found", message: "Waiting item not found." });
  await privUndoPromise;
  assert.equal(host.querySelector('[data-waiting-card="ask-priv"]'), null);
  assert.equal(host.querySelector('[data-waiting-dismissed="ask:ask-priv"]'), null);
  assert.equal(statusMessage, "", "404 refusal reloads silently with no error");
  assert.equal(host.textContent.includes(privAsk.what), false);

  // 3. Unchanged-access control (#general ask): Dismiss, then Undo -> shows "Undoing…", inserts nothing itself,
  //    then restores the card ONLY after server reload returns it.
  nextDismiss = async () => {
    serverAsks = serverAsks.filter(i => i.id !== genAsk.id);
    return { ok: true, itemKind: "ask", itemId: genAsk.id, dismissed: true, dismissedAt: "2026-11-23T12:03:00Z" };
  };
  await ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: genAsk.id, cardId: genAsk.id,
    workspaceId: "ws-1", channelId: null, conversationId: null, placementKind: "general",
    position: 0, placeKey, scope: "workspace",
  });
  assert.equal(host.querySelector('[data-waiting-card="ask-gen"]'), null);
  assert.ok(host.querySelector('[data-waiting-dismissed="ask:ask-gen"]'));

  let settleGenUndo;
  nextRestore = () => new Promise(resolve => { settleGenUndo = resolve; });
  const reloadsBeforeUndo = reloadCount;
  const genUndoPromise = ctrl.undo("ask:ask-gen");
  assert.equal(host.querySelector('[data-waiting-undo="ask:ask-gen"]').textContent, "Undoing…");
  assert.equal(host.querySelector('[data-waiting-card="ask-gen"]'), null, "Undo inserts nothing before server reload");
  await Promise.resolve();

  // Server accepts restore and includes genAsk on the subsequent reload.
  serverAsks = [genAsk];
  settleGenUndo({ ok: true, itemKind: "ask", itemId: genAsk.id, restored: true, restoredAt: "2026-11-23T12:04:00Z" });
  await genUndoPromise;
  assert.ok(reloadCount > reloadsBeforeUndo, "Undo triggers authoritative server reload");
  assert.ok(host.querySelector('[data-waiting-card="ask-gen"]'), "unchanged-access control card reappears after reload");
  assert.equal(host.querySelector('[data-waiting-dismissed="ask:ask-gen"]'), null);

  // 4. Failed Dismiss (non-404) reloads from server with error treatment (never re-inserting a saved card);
  //    404 Dismiss reloads silently with no error.
  nextDismiss = async () => ({ ok: false, status: 500, error: "server_error", message: "Server busy." });
  const reloadsBefore500 = reloadCount;
  await ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: genAsk.id, cardId: genAsk.id,
    workspaceId: "ws-1", channelId: null, conversationId: null, placementKind: "general",
    position: 0, placeKey, scope: "workspace",
  });
  assert.ok(reloadCount > reloadsBefore500);
  assert.equal(cardErrors.get(genAsk.id), "Server busy.");
  assert.ok(host.querySelector('[data-waiting-card="ask-gen"]').textContent.includes("Server busy."));

  cardErrors.clear();
  serverAsks = [];
  nextDismiss = async () => ({ ok: false, status: 404, error: "not_found", message: "Waiting item not found." });
  const reloadsBefore404 = reloadCount;
  await ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: genAsk.id, cardId: genAsk.id,
    workspaceId: "ws-1", channelId: null, conversationId: null, placementKind: "general",
    position: 0, placeKey, scope: "workspace",
  });
  assert.ok(reloadCount > reloadsBefore404);
  assert.equal(cardErrors.has(genAsk.id), false, "404 dismiss reloads with no error");
  assert.equal(host.querySelector('[data-waiting-card="ask-gen"]'), null);
});

test("waiting-dismissal controller (C3): passes scoped action lifetime guard to send ports and bumps workspaceAccessGeneration", async () => {
  const capturedGuards = [];
  let pendingResolve = null;
  const ctrl = createWaitingDismissalController({
    sendDismiss: (_ws, _kind, _id, isAlive) => {
      capturedGuards.push({ op: "dismiss", isAlive });
      return new Promise(resolve => { pendingResolve = resolve; });
    },
    sendRestore: (_ws, _kind, _id, isAlive) => {
      capturedGuards.push({ op: "restore", isAlive });
      return new Promise(resolve => { pendingResolve = resolve; });
    },
    isAlive: () => true,
    removeCardFromClient: () => {},
    reloadWaiting: () => {},
    invalidateArchived: () => {},
    setCardError: () => {},
    setStatusError: () => {},
    setArchivedError: () => {},
    clearArchivedError: () => {},
    render: () => {},
  });

  const ws1Before = ctrl.workspaceAccessGeneration("ws-1");
  const ws2Before = ctrl.workspaceAccessGeneration("ws-2");

  const dismissP = ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: "ask-dm", cardId: "ask-dm",
    workspaceId: "ws-1", channelId: null, conversationId: "conv-dm", placementKind: "dm",
    position: 0, placeKey: "ws-1:general", scope: "workspace",
  });
  assert.equal(capturedGuards.length, 1);
  assert.equal(capturedGuards[0].isAlive(), true, "guard starts alive");

  // Unrelated channel loss in ws-2 leaves ws-1 DM guard alive and ws-1 generation unchanged.
  ctrl.retireForChannel("ws-2", "ch-other");
  assert.equal(capturedGuards[0].isAlive(), true);
  assert.equal(ctrl.workspaceAccessGeneration("ws-1"), ws1Before);
  assert.ok(ctrl.workspaceAccessGeneration("ws-2") > ws2Before);

  // Losing conv-dm retires the in-flight guard synchronously and bumps ws-1 generation.
  ctrl.retireForConversation("ws-1", "conv-dm", null);
  assert.equal(capturedGuards[0].isAlive(), false, "conversation loss retires in-flight transport guard");
  assert.ok(ctrl.workspaceAccessGeneration("ws-1") > ws1Before);
  pendingResolve({ ok: false, status: 0, error: "operation_retired", message: "Action cancelled." });
  await dismissP;

  // Archived Restore also passes a scoped lifetime guard retired by channel loss.
  const restoreP = ctrl.restoreArchived({
    itemKey: "ask:ask-priv", kind: "ask", id: "ask-priv", todoId: null, askKind: "choice",
    workspaceId: "ws-1", workspaceName: "Home", title: "Secret?", from: null,
    outcomeKind: "dismissed", outcomeText: "Dismissed", archivedAt: "2026-11-23T12:00:00Z",
    when: "now", answeredBy: null, placement: "channel", channelId: "ch-priv",
    conversationId: null, conversationKind: null, channelLabel: "#secret", href: null,
  });
  assert.equal(capturedGuards.length, 2);
  assert.equal(capturedGuards[1].isAlive(), true);
  ctrl.retireForChannel("ws-1", "ch-priv");
  assert.equal(capturedGuards[1].isAlive(), false, "channel loss retires Archived Restore transport guard");
  pendingResolve({ ok: false, status: 0, error: "operation_retired", message: "Action cancelled." });
  await restoreP;
});

test("Waiting Archived decodes and renders auto-clear outcomes (muted, no Restore) and tolerates unknown future outcomes", () => {
  const cases = [
    { kind: "ask", item_key: "ask:10000000-0000-4000-8000-000000000001", id: "10000000-0000-4000-8000-000000000001", todo_id: null, ask_kind: "choice", title: "Removed agent ask?", outcome_kind: "agent_removed", outcome_text: "Agent removed", archived_at: "2026-11-23T11:55:00Z", answered_by: null },
    { kind: "ask", item_key: "ask:10000000-0000-4000-8000-000000000002", id: "10000000-0000-4000-8000-000000000002", todo_id: null, ask_kind: "plain", title: "Departed sender ask?", outcome_kind: "sender_left", outcome_text: "Sender left", archived_at: "2026-11-23T11:54:00Z", answered_by: null },
    { kind: "ask", item_key: "ask:10000000-0000-4000-8000-000000000003", id: "10000000-0000-4000-8000-000000000003", todo_id: null, ask_kind: "choice", title: "Archived channel ask?", outcome_kind: "channel_archived", outcome_text: "Channel archived", archived_at: "2026-11-23T11:53:00Z", answered_by: null },
    { kind: "review", item_key: "review:10000000-0000-4000-8000-000000000004", id: "10000000-0000-4000-8000-000000000004", todo_id: "20000000-0000-4000-8000-000000000004", ask_kind: null, title: "Withdrawn work request", outcome_kind: "withdrawn", outcome_text: "Withdrawn", archived_at: "2026-11-23T11:52:00Z", answered_by: { kind: "user", id: "u-maya", name: "Maya", by_viewer: false } },
    { kind: "ask", item_key: "ask:10000000-0000-4000-8000-000000000005", id: "10000000-0000-4000-8000-000000000005", todo_id: null, ask_kind: "plain", title: "Timed ask?", outcome_kind: "expired", outcome_text: "Expired", archived_at: "2026-11-23T11:51:00Z", answered_by: null },
    { kind: "ask", item_key: "ask:10000000-0000-4000-8000-000000000006", id: "10000000-0000-4000-8000-000000000006", todo_id: null, ask_kind: "choice", title: "Future outcome ask?", outcome_kind: "future_superseded", outcome_text: "Replaced by newer ask", archived_at: "2026-11-23T11:50:00Z", answered_by: null },
  ];

  const page = parseWaitingArchivedPage({
    workspace_id: "ws-1",
    generated_at: "2026-11-23T12:00:00Z",
    total: cases.length,
    truncated: false,
    items: cases.map(c => ({
      ...c,
      from: { kind: "agent", id: "a-1", name: "Scout" },
      placement: "general",
      channel_id: null,
      conversation_id: null,
      conversation_kind: "general",
    })),
  }, "ws-1");
  assert.ok(page);
  assert.equal(page.items.length, cases.length);
  assert.deepEqual(page.items.map(i => i.outcome_kind), cases.map(c => c.outcome_kind));

  // Empty/whitespace or non-string outcome_kind still fails closed as malformed.
  for (const badOutcome of ["", "   ", null, 42]) {
    assert.throws(() => parseWaitingArchivedPage({
      workspace_id: "ws-1",
      generated_at: "2026-11-23T12:00:00Z",
      total: 1,
      truncated: false,
      items: [{
        ...cases[0],
        outcome_kind: badOutcome,
        from: null,
        placement: "general",
        channel_id: null,
        conversation_id: null,
        conversation_kind: "general",
      }],
    }, "ws-1"), /home_waiting_archived_malformed/);
  }

  const mapped = page.items.map(entry => mapWaitingArchivedEntry(entry, {
    workspaceId: "ws-1",
    workspaceName: "Home",
    channelLabel: "#general",
    href: null,
    viewerId: "u-viewer",
    now: Date.parse("2026-11-23T12:00:00Z"),
  }));

  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);
  const place = { workspaceId: "ws-1", workspaceName: "Home", kind: "general", channelId: null, label: "#general" };
  renderWaitingPanel(host, {
    tab: "archived",
    scope: "workspace",
    place,
    items: [],
    archived: {
      items: mapped,
      counts: {
        channel: { min: mapped.length, complete: true },
        workspace: { min: mapped.length, complete: true },
        all: { min: mapped.length, complete: true },
      },
      loading: false,
      loadingMore: false,
      complete: true,
      failed: false,
      hasMore: false,
    },
    counts: { channel: { min: 0, complete: true }, workspace: { min: 0, complete: true }, all: { min: 0, complete: true } },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onRestoreArchived: () => { throw new Error("auto-cleared and unknown outcomes must never expose Restore"); },
  });

  for (const c of cases) {
    const card = host.querySelector(`[data-waiting-archived-item="${c.item_key}"]`);
    assert.ok(card, `card rendered for ${c.outcome_kind}`);
    const outcome = card.querySelector(`[data-waiting-archived-outcome="${c.outcome_kind}"]`);
    assert.ok(outcome, `outcome node rendered for ${c.outcome_kind}`);
    assert.equal(outcome.dataset.outcomeTone, "muted", `${c.outcome_kind} must render with muted tone`);
    assert.equal(outcome.querySelector(".cs-waiting-archived__answer").textContent, c.outcome_text);
    assert.equal(card.querySelector("[data-waiting-archived-restore]"), null, `${c.outcome_kind} must not render Restore`);
  }
});

test("waiting-dismissal controller (C3): attempt ownership prevents retired Dismiss, Undo, and Archived Restore from touching fresh overlapping attempts across all settlement forms", async () => {
  const outcomes = [
    { label: "success", dismiss: { ok: true, itemKind: "ask", itemId: "ask-1", dismissed: true, dismissedAt: "2026-11-23T12:00:00Z" }, restore: { ok: true, itemKind: "ask", itemId: "ask-1", restored: true, restoredAt: "2026-11-23T12:00:00Z" } },
    { label: "404", dismiss: { ok: false, status: 404, error: "not_found", message: "Not found." }, restore: { ok: false, status: 404, error: "not_found", message: "Not found." } },
    { label: "error", dismiss: { ok: false, status: 500, error: "server_error", message: "Stale 500." }, restore: { ok: false, status: 500, error: "server_error", message: "Stale 500." } },
    { label: "retired", dismiss: { ok: false, status: 0, error: "operation_retired", message: "Action cancelled." }, restore: { ok: false, status: 0, error: "operation_retired", message: "Action cancelled." } },
  ];

  const makeTarget = () => ({
    slotKind: "ask",
    itemKind: "ask",
    itemId: "ask-1",
    cardId: "ask-1",
    workspaceId: "ws-1",
    channelId: null,
    conversationId: null,
    placementKind: "general",
    position: 0,
    placeKey: "ws-1:general",
    scope: "workspace",
  });

  const makeArchived = () => ({
    itemKey: "ask:ask-1",
    kind: "ask",
    id: "ask-1",
    todoId: null,
    askKind: "choice",
    workspaceId: "ws-1",
    workspaceName: "Home",
    title: "Question?",
    from: null,
    outcomeKind: "dismissed",
    outcomeText: "Dismissed",
    archivedAt: "2026-11-23T12:00:00Z",
    when: "now",
    answeredBy: null,
    placement: "general",
    channelId: null,
    conversationId: null,
    conversationKind: null,
    channelLabel: "#general",
    href: null,
  });

  // 1. Dismiss overlap for every settlement form (success, 404, error, retired).
  for (const outcome of outcomes) {
    let loginGen = 1;
    let renders = 0;
    let reloads = 0;
    let invalidations = 0;
    const errors = [];
    const dispatches = [];
    const resolvers = [];
    const ctrl = createWaitingDismissalController({
      captureAccountGuard: () => {
        const pinnedGen = loginGen;
        return () => loginGen === pinnedGen;
      },
      sendDismiss: (_ws, _kind, itemId) => {
        dispatches.push({ loginGen, itemId });
        return new Promise(resolve => { resolvers.push(resolve); });
      },
      sendRestore: async () => outcome.restore,
      isAlive: () => true,
      removeCardFromClient: () => {},
      reloadWaiting: () => { reloads += 1; },
      invalidateArchived: () => { invalidations += 1; },
      setCardError: (_slot, _id, msg) => errors.push(msg),
      setStatusError: (msg) => errors.push(msg),
      setArchivedError: (_key, msg) => errors.push(msg),
      clearArchivedError: () => {},
      render: () => { renders += 1; },
    });

    const pA = ctrl.dismiss(makeTarget());
    assert.equal(ctrl.has("ask:ask-1"), true);
    assert.equal(dispatches.length, 1);

    // Same-person login replacement retires login 1 synchronously.
    loginGen += 1;
    ctrl.retireAll();
    assert.equal(ctrl.has("ask:ask-1"), false);

    // Fresh Dismiss B for the SAME item starts under login 2.
    const pB = ctrl.dismiss(makeTarget());
    assert.equal(ctrl.has("ask:ask-1"), true);
    assert.equal(ctrl.pendingDismissCardIds("ws-1").has("ask-1"), true);
    assert.equal(dispatches.filter(d => d.loginGen === 2).length, 1, `Dismiss(${outcome.label}): B dispatched once`);

    const rendersBeforeA = renders;
    const reloadsBeforeA = reloads;
    const invalidationsBeforeA = invalidations;
    resolvers[0](outcome.dismiss);
    await pA;

    assert.equal(ctrl.has("ask:ask-1"), true, `Dismiss(${outcome.label}): B row must remain`);
    assert.equal(ctrl.pendingDismissCardIds("ws-1").has("ask-1"), true, `Dismiss(${outcome.label}): B must remain pending`);
    assert.equal(renders, rendersBeforeA, `Dismiss(${outcome.label}): A must not repaint`);
    assert.equal(reloads, reloadsBeforeA, `Dismiss(${outcome.label}): A must not reload`);
    assert.equal(invalidations, invalidationsBeforeA, `Dismiss(${outcome.label}): A must not invalidate`);
    assert.deepEqual(errors, [], `Dismiss(${outcome.label}): A must set no error`);
    assert.equal(dispatches.filter(d => d.loginGen === 2).length, 1, `Dismiss(${outcome.label}): B still dispatched exactly once`);

    resolvers[1]({ ok: true, itemKind: "ask", itemId: "ask-1", dismissed: true, dismissedAt: "2026-11-23T12:01:00Z" });
    await pB;
    assert.equal(ctrl.has("ask:ask-1"), true);
    assert.equal(ctrl.pendingDismissCardIds("ws-1").has("ask-1"), false);
  }

  // 2. Undo overlap for every settlement form (success, 404, error, retired).
  for (const outcome of outcomes) {
    let loginGen = 1;
    let renders = 0;
    let reloads = 0;
    let invalidations = 0;
    const errors = [];
    const restoreDispatches = [];
    const restoreResolvers = [];
    const ctrl = createWaitingDismissalController({
      captureAccountGuard: () => {
        const pinnedGen = loginGen;
        return () => loginGen === pinnedGen;
      },
      sendDismiss: async () => ({ ok: true, itemKind: "ask", itemId: "ask-1", dismissed: true, dismissedAt: "2026-11-23T12:00:00Z" }),
      sendRestore: (_ws, _kind, itemId) => {
        restoreDispatches.push({ loginGen, itemId });
        return new Promise(resolve => { restoreResolvers.push(resolve); });
      },
      isAlive: () => true,
      removeCardFromClient: () => {},
      reloadWaiting: () => { reloads += 1; },
      invalidateArchived: () => { invalidations += 1; },
      setCardError: (_slot, _id, msg) => errors.push(msg),
      setStatusError: (msg) => errors.push(msg),
      setArchivedError: (_key, msg) => errors.push(msg),
      clearArchivedError: () => {},
      render: () => { renders += 1; },
    });

    await ctrl.dismiss(makeTarget());
    const undoA = ctrl.undo("ask:ask-1");
    await Promise.resolve();
    assert.equal(restoreDispatches.length, 1);

    // Same-person login replacement retires login 1 synchronously.
    loginGen += 1;
    ctrl.retireAll();
    assert.equal(ctrl.has("ask:ask-1"), false);

    // Fresh Dismiss + Undo B for the SAME item starts under login 2.
    await ctrl.dismiss(makeTarget());
    const undoB = ctrl.undo("ask:ask-1");
    await Promise.resolve();
    assert.equal(restoreDispatches.filter(d => d.loginGen === 2).length, 1, `Undo(${outcome.label}): B dispatched once`);
    assert.equal(ctrl.placeholdersFor("ws-1:general", "workspace")[0]?.pendingUndo, true);

    const rendersBeforeA = renders;
    const reloadsBeforeA = reloads;
    const invalidationsBeforeA = invalidations;
    restoreResolvers[0](outcome.restore);
    await undoA;

    assert.equal(ctrl.has("ask:ask-1"), true, `Undo(${outcome.label}): B row must remain`);
    assert.equal(ctrl.placeholdersFor("ws-1:general", "workspace")[0]?.pendingUndo, true, `Undo(${outcome.label}): B must stay pendingUndo`);
    assert.equal(renders, rendersBeforeA, `Undo(${outcome.label}): A must not repaint`);
    assert.equal(reloads, reloadsBeforeA, `Undo(${outcome.label}): A must not reload`);
    assert.equal(invalidations, invalidationsBeforeA, `Undo(${outcome.label}): A must not invalidate`);
    assert.deepEqual(errors, [], `Undo(${outcome.label}): A must set no error`);
    assert.equal(restoreDispatches.filter(d => d.loginGen === 2).length, 1, `Undo(${outcome.label}): B still dispatched exactly once`);

    restoreResolvers[1]({ ok: true, itemKind: "ask", itemId: "ask-1", restored: true, restoredAt: "2026-11-23T12:01:00Z" });
    await undoB;
    assert.equal(ctrl.has("ask:ask-1"), false);
  }

  // 3. Archived Restore overlap for every settlement form (success, 404, error, retired).
  for (const outcome of outcomes) {
    let loginGen = 1;
    let renders = 0;
    let reloads = 0;
    let invalidations = 0;
    const errors = [];
    const restoreDispatches = [];
    const restoreResolvers = [];
    const ctrl = createWaitingDismissalController({
      captureAccountGuard: () => {
        const pinnedGen = loginGen;
        return () => loginGen === pinnedGen;
      },
      sendDismiss: async () => outcome.dismiss,
      sendRestore: (_ws, _kind, itemId) => {
        restoreDispatches.push({ loginGen, itemId });
        return new Promise(resolve => { restoreResolvers.push(resolve); });
      },
      isAlive: () => true,
      removeCardFromClient: () => {},
      reloadWaiting: () => { reloads += 1; },
      invalidateArchived: () => { invalidations += 1; },
      setCardError: (_slot, _id, msg) => errors.push(msg),
      setStatusError: (msg) => errors.push(msg),
      setArchivedError: (_key, msg) => errors.push(msg),
      clearArchivedError: () => {},
      render: () => { renders += 1; },
    });

    const restoreA = ctrl.restoreArchived(makeArchived());
    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), true);
    assert.equal(restoreDispatches.length, 1);

    loginGen += 1;
    ctrl.retireAll();
    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), false);

    const restoreB = ctrl.restoreArchived(makeArchived());
    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), true);
    assert.equal(restoreDispatches.filter(d => d.loginGen === 2).length, 1, `ArchivedRestore(${outcome.label}): B dispatched once`);

    const rendersBeforeA = renders;
    const reloadsBeforeA = reloads;
    const invalidationsBeforeA = invalidations;
    restoreResolvers[0](outcome.restore);
    await restoreA;

    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), true, `ArchivedRestore(${outcome.label}): B marker must remain`);
    assert.equal(renders, rendersBeforeA, `ArchivedRestore(${outcome.label}): A must not repaint`);
    assert.equal(reloads, reloadsBeforeA, `ArchivedRestore(${outcome.label}): A must not reload`);
    assert.equal(invalidations, invalidationsBeforeA, `ArchivedRestore(${outcome.label}): A must not invalidate`);
    assert.deepEqual(errors, [], `ArchivedRestore(${outcome.label}): A must set no error`);
    assert.equal(restoreDispatches.filter(d => d.loginGen === 2).length, 1, `ArchivedRestore(${outcome.label}): B still dispatched exactly once`);

    restoreResolvers[1]({ ok: true, itemKind: "ask", itemId: "ask-1", restored: true, restoredAt: "2026-11-23T12:01:00Z" });
    await restoreB;
    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), false);
  }

  // 4. Still-owned cancelled attempts (Dismiss, Undo, Archived Restore) clear their own visual pending
  //    indicator with no stale error and no data reload/invalidation.
  {
    const retiredResult = { ok: false, status: 0, error: "operation_retired", message: "Action cancelled." };
    let renders = 0;
    let reloads = 0;
    let invalidations = 0;
    const errors = [];
    let nextDismissResult = retiredResult;
    let nextRestoreResult = retiredResult;
    const ctrl = createWaitingDismissalController({
      sendDismiss: async () => nextDismissResult,
      sendRestore: async () => nextRestoreResult,
      isAlive: () => true,
      removeCardFromClient: () => {},
      reloadWaiting: () => { reloads += 1; },
      invalidateArchived: () => { invalidations += 1; },
      setCardError: (_slot, _id, msg) => errors.push(msg),
      setStatusError: (msg) => errors.push(msg),
      setArchivedError: (_key, msg) => errors.push(msg),
      clearArchivedError: () => {},
      render: () => { renders += 1; },
    });

    // Still-owned cancelled Dismiss clears its row + re-renders indicator, zero error/reload.
    await ctrl.dismiss(makeTarget());
    assert.equal(ctrl.has("ask:ask-1"), false);
    assert.equal(renders, 2, "optimistic render + pending-indicator clear render");
    assert.equal(reloads, 0);
    assert.equal(invalidations, 0);
    assert.deepEqual(errors, []);

    // Still-owned cancelled Undo clears its "Undoing…" row + re-renders indicator, zero error/reload.
    nextDismissResult = { ok: true, itemKind: "ask", itemId: "ask-1", dismissed: true, dismissedAt: "2026-11-23T12:00:00Z" };
    await ctrl.dismiss(makeTarget());
    renders = 0;
    reloads = 0;
    invalidations = 0;
    await ctrl.undo("ask:ask-1");
    assert.equal(ctrl.has("ask:ask-1"), false);
    assert.equal(renders, 2, "Undoing… render + pending-indicator clear render");
    assert.equal(reloads, 0);
    assert.equal(invalidations, 0);
    assert.deepEqual(errors, []);

    // Still-owned cancelled Archived Restore clears its "Restoring…" marker + re-renders indicator, zero error/reload.
    renders = 0;
    await ctrl.restoreArchived(makeArchived());
    assert.equal(ctrl.isArchivedRestoring("ask:ask-1"), false);
    assert.equal(renders, 2, "Restoring… render + pending-indicator clear render");
    assert.equal(reloads, 0);
    assert.equal(invalidations, 0);
    assert.deepEqual(errors, []);
  }
});
