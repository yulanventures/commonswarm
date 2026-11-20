import assert from "node:assert/strict";
import test from "node:test";
import { openContextMenu, resolveContextMenuReturnTarget } from "./context-menu.ts";

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.tabIndex = tagName === "h1" || tagName === "h2" || tagName === "div" ? -1 : 0;
    this.dataset = {};
    this.style = {};
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.ownerDocument = doc;
    this.offsetWidth = 140;
    this.offsetHeight = 80;
    this.visibleRects = [{ top: 20, left: 20, width: 32, height: 32 }];
    this.focused = false;
  }

  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === this.ownerDocument.body) return true;
      cur = cur.parent;
    }
    return false;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parent) node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, value);
    if (name === "id") this.id = value;
    if (name === "tabindex") this.tabIndex = Number(value);
  }

  getAttribute(name) {
    if (name === "id" && this.id) return this.id;
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
  }

  getBoundingClientRect() {
    return this.visibleRects[0] ?? { top: 0, left: 0, width: 0, height: 0 };
  }

  getClientRects() {
    return this.visibleRects;
  }

  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSimple(cur, selector)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    const visit = (node) => {
      for (const child of node.children) {
        if (parts.some((p) => matchesSelector(child, p))) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }
}

function matchesSimple(el, selector) {
  for (const part of selector.split(",").map((s) => s.trim())) {
    if (part === "[hidden]" && el.hasAttribute("hidden")) return true;
    if (part === "[inert]" && el.hasAttribute("inert")) return true;
    if (part === "dialog[open]" && el.tagName === "DIALOG" && el.hasAttribute("open")) return true;
    if (part === "live-dashboard" && el.tagName === "LIVE-DASHBOARD") return true;
    if (part.startsWith(".") && el.className.split(/\s+/).includes(part.slice(1))) return true;
    if (part.startsWith("#") && el.id === part.slice(1)) return true;
    if (part.startsWith("[")) {
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
      if (m) {
        const val = el.getAttribute(m[1]);
        if (m[2] === undefined ? val !== null : val === m[2]) return true;
      }
    }
    if (/^[a-z0-9-]+$/i.test(part) && el.tagName === part.toUpperCase()) return true;
  }
  return false;
}

function matchesSelector(el, selector) {
  const tokens = selector.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (last === "button:not([disabled])") {
    if (el.tagName !== "BUTTON" || el.hasAttribute("disabled")) return false;
  } else if (last === "h1[tabindex]") {
    if (el.tagName !== "H1" || !el.hasAttribute("tabindex")) return false;
  } else if (!matchesSimple(el, last)) {
    return false;
  }
  if (tokens.length === 1) return true;
  const ancestorSel = tokens[0];
  let cur = el.parent;
  while (cur) {
    if (matchesSimple(cur, ancestorSel)) return true;
    cur = cur.parent;
  }
  return false;
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body", this);
    this.activeElement = this.body;
    this.defaultView = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {},
    };
  }

  createElement(tag) {
    return new FakeElement(tag, this);
  }

  addEventListener() {}
  removeEventListener() {}
}

test("context-menu Escape returns focus to the re-rendered equivalent trigger when a background renderHomeRail() detaches the original anchor", () => {
  const doc = new FakeDocument();
  const shell = doc.createElement("live-dashboard");
  const rail = doc.createElement("nav");
  rail.className = "hm-rail";
  const heading = doc.createElement("h2");
  heading.textContent = "Direct messages";
  const originalTrigger = doc.createElement("button");
  originalTrigger.setAttribute("data-rail-conversation-menu", "conv-group-1");
  rail.append(heading, originalTrigger);
  shell.append(rail);
  doc.body.append(shell);

  openContextMenu(
    { preventDefault() {}, detail: 1, clientX: 40, clientY: 60 },
    originalTrigger,
    [{ label: "Star", run() {} }],
    "Alex and Lead options",
  );

  const menu = shell.children.find((c) => c.className === "cs-context-menu");
  assert.ok(menu, "context menu should be mounted");

  // Simulate background renderHomeRail() detaching originalTrigger and mounting a fresh equivalent trigger.
  originalTrigger.remove();
  assert.equal(originalTrigger.isConnected, false);
  const rerenderedTrigger = doc.createElement("button");
  rerenderedTrigger.setAttribute("data-rail-conversation-menu", "conv-group-1");
  rail.append(rerenderedTrigger);

  menu.dispatchEvent({
    type: "keydown",
    key: "Escape",
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(doc.activeElement, rerenderedTrigger, "Escape must return focus to the re-rendered trigger, never <body>");
  assert.notEqual(doc.activeElement, doc.body);
});

test("context-menu Escape falls back to the rail heading (never <body>) when the detached anchor row no longer exists", () => {
  const doc = new FakeDocument();
  const shell = doc.createElement("live-dashboard");
  const rail = doc.createElement("nav");
  rail.className = "hm-rail";
  const heading = doc.createElement("h2");
  heading.textContent = "Direct messages";
  const originalTrigger = doc.createElement("button");
  originalTrigger.setAttribute("data-menu-key", "row-deleted");
  rail.append(heading, originalTrigger);
  shell.append(rail);
  doc.body.append(shell);

  openContextMenu(
    { preventDefault() {}, detail: 0, clientX: 0, clientY: 0 },
    originalTrigger,
    [{ label: "Leave group", run() {} }],
    "Deleted group options",
  );

  const menu = shell.children.find((c) => c.className === "cs-context-menu");
  assert.ok(menu);
  originalTrigger.remove();

  menu.dispatchEvent({
    type: "keydown",
    key: "Escape",
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(doc.activeElement, heading, "Escape must fall back to the rail heading when row disappeared, never <body>");
  assert.equal(heading.getAttribute("tabindex"), "-1");
  assert.notEqual(doc.activeElement, doc.body);
});

test("resolveContextMenuReturnTarget supports data-channel-id and prefers connected visible triggers", () => {
  const doc = new FakeDocument();
  const shell = doc.createElement("live-dashboard");
  const stale = doc.createElement("button");
  stale.setAttribute("data-channel-id", "ch-ops");
  const replacement = doc.createElement("button");
  replacement.setAttribute("data-channel-id", "ch-ops");
  shell.append(replacement);
  doc.body.append(shell);

  const resolved = resolveContextMenuReturnTarget(
    stale,
    '[data-channel-id="ch-ops"]',
    shell,
  );
  assert.equal(resolved, replacement);
});

test("context-menu Escape and Tab return focus to re-rendered channel and DM links (data-rail-channel, data-rail-conversation)", () => {
  for (const [attr, id] of [
    ["data-rail-channel", "ch-ops"],
    ["data-rail-conversation", "conv-group-1"],
  ]) {
    for (const dismissKey of ["Escape", "Tab"]) {
      const doc = new FakeDocument();
      const shell = doc.createElement("live-dashboard");
      const rail = doc.createElement("nav");
      rail.className = "hm-rail";
      const heading = doc.createElement("h2");
      heading.textContent = "Channels";
      const originalLink = doc.createElement("a");
      originalLink.setAttribute(attr, id);
      rail.append(heading, originalLink);
      shell.append(rail);
      doc.body.append(shell);

      openContextMenu(
        { preventDefault() {}, detail: 0, clientX: 0, clientY: 0 },
        originalLink,
        [{ label: "Star", run() {} }],
        "Link options",
      );

      const menu = shell.children.find((c) => c.className === "cs-context-menu");
      assert.ok(menu, `${attr}/${dismissKey}: menu should mount`);

      originalLink.remove();
      const rerenderedLink = doc.createElement("a");
      rerenderedLink.setAttribute(attr, id);
      rail.append(rerenderedLink);

      menu.dispatchEvent({
        type: "keydown",
        key: dismissKey,
        preventDefault() {},
        stopPropagation() {},
      });

      assert.equal(
        doc.activeElement,
        rerenderedLink,
        `${attr}/${dismissKey}: must return focus to re-rendered link, not heading or <body>`,
      );
      assert.notEqual(doc.activeElement, heading);
      assert.notEqual(doc.activeElement, doc.body);
    }
  }
});
