import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WAITING_PANEL_ID,
  WAITING_SHEET_ID,
  createWaitingSurface,
  filterWaitingItems,
  renderWaitingPanel,
} from "./waiting-panel.ts";
import { buildWaitingButton, syncWaitingButtonToggle, updateWaitingButton } from "./waiting-count.ts";

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
    channelId: "ch-1",
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

test("filterWaitingItems scopes accurately by named channel, #general, DM, workspace, and all workspaces", () => {
  const items = [
    sampleAsk({ id: "in-ch1", workspaceId: "ws-1", channelId: "ch-1" }),
    sampleAsk({ id: "in-gen", workspaceId: "ws-1", channelId: null, fromKind: "agent", fromId: "a1" }),
    sampleAsk({ id: "in-dm-u1", workspaceId: "ws-1", channelId: null, from: person, fromKind: "user", fromId: "u1" }),
    sampleAsk({ id: "in-ws2", workspaceId: "ws-2", workspaceName: "Studio", channelId: "ch-2" }),
  ];
  const ch1 = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "channel", channelId: "ch-1", label: "#household" };
  const gen = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "general", channelId: null, label: "#general" };
  const dm = { workspaceId: "ws-1", workspaceName: "Rivera", kind: "dm", channelId: null, label: "Alex", dm: { kind: "person", id: "u1" } };

  assert.deepEqual(filterWaitingItems(items, "channel", ch1).map(i => i.id), ["in-ch1"]);
  assert.deepEqual(filterWaitingItems(items, "channel", gen).map(i => i.id), ["in-gen", "in-dm-u1"]);
  assert.deepEqual(filterWaitingItems(items, "channel", dm).map(i => i.id), ["in-dm-u1"]);
  assert.deepEqual(filterWaitingItems(items, "workspace", ch1).map(i => i.id), ["in-ch1", "in-gen", "in-dm-u1"]);
  assert.deepEqual(filterWaitingItems(items, "all", ch1).map(i => i.id), ["in-ch1", "in-gen", "in-dm-u1", "in-ws2"]);
});

test("renderWaitingPanel names the channel, sends single choice on tap, gives Other a Send button, preserves failed drafts with Retry, and announces Sent", () => {
  const { doc } = makeFakeDoc(false);
  const host = doc.createElement("aside");
  doc.root.append(host);

  const submitted = [];
  const retried = [];
  const drafts = [];
  const scopes = [];
  const place = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "channel", channelId: "ch-1", label: "#household" };
  const handlers = {
    onScopeChange: s => scopes.push(s),
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: (item, sub) => submitted.push({ id: item.id, sub }),
    onRetryChoice: item => retried.push(item.id),
    onDraftChoice: (item, draft) => drafts.push({ id: item.id, draft }),
  };

  const ask = sampleAsk();
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [ask],
    counts: { channel: 1, workspace: 3, all: 7 },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  }, handlers);

  assert.equal(host.querySelector("[data-waiting-place]").textContent, "#household");
  const select = host.querySelector("[data-waiting-scope]");
  assert.deepEqual(select.options.map(o => o.textContent), ["This channel (1)", "All channels (3)", "All workspaces (7)"]);

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
    counts: { channel: 1, workspace: 3, all: 7 },
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
    counts: { channel: 1, workspace: 3, all: 7 },
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

  // After answering succeeds, empty channel coexists with nonzero all-workspace count and announces Sent.
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [],
    counts: { channel: 0, workspace: 2, all: 6 },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "Sent",
    statusSeq: 1,
  }, handlers);
  assert.equal(host.querySelector("[data-waiting-status]").textContent, "Sent");
  assert.ok(host.querySelector(".cs-waiting-panel__state-text").textContent.includes("#household"));
  const switchBtn = host.querySelector("[data-waiting-switch-scope]");
  assert.equal(switchBtn.textContent, "Show all channels (2)");
  switchBtn.click();
  assert.deepEqual(scopes, ["workspace"]);
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
