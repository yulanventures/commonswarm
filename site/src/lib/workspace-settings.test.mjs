import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkspaceSettings } from "./workspace-settings.ts";

// Exercise the DOM builder and its real event handlers without a browser process.
function fixture(options = {}) {
  const doc = {
    createElement: (tag) => ({
      tag,
      children: [],
      dataset: {},
      listeners: {},
      value: "",
      attributes: {},
      append(...nodes) {
        this.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        this.children = nodes;
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      removeAttribute(key) {
        delete this.attributes[key];
      },
      addEventListener(key, value) {
        this.listeners[key] = value;
      },
    }),
  };
  const root = doc.createElement("div");
  root.ownerDocument = doc;
  renderWorkspaceSettings(root, {
    name: "Science",
    workspaceId: "workspace",
    memberCount: 2,
    agentCount: 1,
    canClose: true,
    onCopy: async () => {},
    onClose: async () => {},
    ...options,
  });
  const nodes = function* (node) {
    if (typeof node === "string") return;
    yield node;
    for (const child of node.children) yield* nodes(child);
  };
  return [...nodes(root)];
}

test("settings offers only supplied destinations and sends the selected organization once while busy", async () => {
  let finish;
  const calls = [];
  const nodes = fixture({
    moveDestinations: [{ id: "dest", name: "<Yulan>" }],
    onMove: async (id) => {
      calls.push(id);
      await new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const form = nodes.find((node) => "workspaceMoveForm" in node.dataset);
  const picker = nodes.find((node) =>
    "workspaceMoveDestination" in node.dataset
  );
  const move = form.children.find((node) => node.tag === "button");
  assert.equal(move.disabled, true);
  assert.deepEqual(
    picker.children.map((node) => [node.value, node.textContent]),
    [["", "Select organization"], ["dest", "<Yulan>"]],
  );
  picker.value = "dest";
  picker.listeners.change();
  assert.equal(move.disabled, false);
  const pending = form.listeners.submit({ preventDefault() {} });
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(picker.disabled, true);
  assert.deepEqual(calls, ["dest"]);
  finish();
  await pending;
  assert.equal(picker.disabled, false);
});

test("failed move stays actionable with the selected destination and error", async () => {
  const nodes = fixture({
    moveDestinations: [{ id: "dest", name: "Yulan" }],
    onMove: async () => {
      throw new Error("Move refused");
    },
  });
  const form = nodes.find((node) => "workspaceMoveForm" in node.dataset);
  const picker = nodes.find((node) =>
    "workspaceMoveDestination" in node.dataset
  );
  picker.value = "dest";
  picker.listeners.change();
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(picker.value, "dest");
  assert.equal(picker.disabled, false);
  assert.equal(
    form.children.find((node) => node.tag === "button").disabled,
    false,
  );
  assert.equal(
    form.children.find((node) => node.tag === "p").textContent,
    "Move refused",
  );
});

test("settings without eligible destinations offers no move action", () => {
  assert.equal(
    fixture({ moveDestinations: [], onMove: async () => {} }).some((node) =>
      "workspaceMoveForm" in node.dataset
    ),
    false,
  );
});
