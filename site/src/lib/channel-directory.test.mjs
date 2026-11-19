import assert from "node:assert/strict";
import { test } from "node:test";
import { renderChannelDirectory } from "./channel-directory.ts";

function hostFixture() {
  const doc = {
    activeElement: null,
    createDocumentFragment() {
      return {
        children: [],
        append(...nodes) { this.children.push(...nodes); },
      };
    },
    createElement(tag) {
      const el = {
        tag,
        className: "",
        textContent: "",
        href: "",
        id: "",
        type: "",
        disabled: false,
        children: [],
        dataset: {},
        attrs: {},
        listeners: {},
        get childElementCount() { return this.children.length; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) {
          this.children = nodes.flatMap((n) => (n && !n.tag && Array.isArray(n.children) ? n.children : [n]));
        },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k] ?? null; },
        addEventListener(k, fn) { this.listeners[k] = fn; },
        focus() { doc.activeElement = el; },
        contains(target) {
          if (!target) return false;
          if (target === this) return true;
          return this.children.some((c) => typeof c === "object" && c.contains?.(target));
        },
        querySelectorAll(selector) {
          const out = [];
          const visit = (node) => {
            if (!node || typeof node !== "object") return;
            if (selector === "[data-channel-directory-action]" && node.dataset?.channelDirectoryAction !== undefined) out.push(node);
            for (const child of node.children ?? []) visit(child);
          };
          visit(this);
          return out;
        },
      };
      return el;
    },
  };
  const host = doc.createElement("div");
  host.ownerDocument = doc;
  const walk = (node) => [node, ...(node.children ?? []).flatMap(walk)];
  return { doc, host, walk };
}

test("All channels shows Join on unjoined public channels, Joined on joined channels, and restores focus after Join", () => {
  const { doc, host, walk } = hostFixture();
  const joinedCalls = [];
  const rows = [
    { id: "c1", slug: "design", description: "UI", href: "/app?w=w&c=c1", archived: false, unread: false, manageable: false, joined: false },
    { id: "c2", slug: "ops", description: null, href: "/app?w=w&c=c2", archived: false, unread: true, manageable: false, joined: true },
  ];
  const actions = { open() {}, unarchive() {}, join: (id) => joinedCalls.push(id) };

  renderChannelDirectory(host, rows, "", new Set(), new Map(), actions);
  const joinBtn = walk(host).find((n) => n.dataset?.channelDirectoryAction === "join:c1");
  assert.ok(joinBtn, "unjoined channel has a Join button");
  assert.equal(joinBtn.textContent, "Join");
  assert.equal(joinBtn.attrs["aria-label"], "Join #design");
  const joinedMark = walk(host).find((n) => n.dataset?.channelDirectoryJoined === "c2");
  assert.equal(joinedMark?.textContent, "Joined");

  // Pending join disables the button with aria-busy and keeps focus on it.
  joinBtn.focus();
  joinBtn.listeners.click();
  assert.deepEqual(joinedCalls, ["c1"]);
  renderChannelDirectory(host, rows, "", new Set(["c1"]), new Map(), actions);
  const busyBtn = walk(host).find((n) => n.dataset?.channelDirectoryAction === "join:c1");
  assert.equal(busyBtn.disabled, true);
  assert.equal(busyBtn.attrs["aria-busy"], "true");
  assert.equal(doc.activeElement, busyBtn);

  // Once joined, the Join button disappears and keyboard focus moves to the channel link open:c1.
  renderChannelDirectory(host, [{ ...rows[0], joined: true }, rows[1]], "", new Set(), new Map(), actions);
  assert.equal(walk(host).find((n) => n.dataset?.channelDirectoryAction === "join:c1"), undefined);
  const openLink = walk(host).find((n) => n.dataset?.channelDirectoryAction === "open:c1");
  assert.equal(doc.activeElement, openLink, "focus moves to the channel link when Join completes");
});

test("legacy rows without joined omit Join and Joined controls", () => {
  const { host, walk } = hostFixture();
  renderChannelDirectory(
    host,
    [{ id: "c1", slug: "design", description: null, href: "/app?w=w&c=c1", archived: false, unread: null, manageable: false }],
    "",
    new Set(),
    new Map(),
    { open() {}, unarchive() {} },
  );
  assert.equal(walk(host).find((n) => n.dataset?.channelDirectoryAction === "join:c1"), undefined);
  assert.equal(walk(host).find((n) => n.dataset?.channelDirectoryJoined !== undefined), undefined);
});
