import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WAITING_PANEL_ID,
  WAITING_SHEET_ID,
  classifyAskConversation,
  conversationParticipantKey,
  createWaitingSurface,
  filterWaitingItems,
  filterWaitingTodos,
  focusWaitingPanelAfterAction,
  indexDirectConversations,
  renderWaitingPanel,
} from "./waiting-panel.ts";
import { buildWaitingButton, syncWaitingButtonToggle, updateWaitingButton } from "./waiting-count.ts";
import { answerChoice, answerPlainAsk, plainAskReplyCommand, STALE_ASK_CLOSE_BODY } from "./commonswarm.ts";
import { parseDecisionQueue, parseWaitingTodosQueue } from "./home/client.ts";

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
    total: 1,
    truncated: false,
    asks: [{
      signal_id: "sig-1",
      from: { kind: "agent", id: "ag-1", name: "Scout" },
      body: "Approve?",
      created_at: "2026-11-19T11:55:00Z",
      until: "2026-11-20T11:55:00Z",
      conversation_id: "CONV-GEN1",
      conversation_kind: "group_dm",
      reraised: null,
    }],
  }, "ws-1");
  assert.equal(decodedQueue.asks[0].conversation_id, "conv-gen1");
  assert.equal(decodedQueue.asks[0].conversation_kind, "group_dm");

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
    access_token: "synthetic-a",
    refresh_token: "synthetic-refresh-a",
    token_type: "bearer",
    expires_in: 3600,
    user: { id: "u-a" },
  };
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
    globalThis.document = prevDocument;
    globalThis.fetch = prevFetch;
  }
});
