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
      focus() {},
      select() {},
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

test("rename is offered only when allowed, saves a changed name once, and keeps the field on refusal", async () => {
  const find = (nodes, key) => nodes.find((node) => key in node.dataset);
  assert.equal(find(fixture(), "workspaceRename"), undefined, "no Rename without canRename");
  const calls = [];
  let refuse = true;
  const nodes = fixture({ canRename: true, onRename: async (name) => {
    calls.push(name);
    if (refuse) throw new Error("Only an owner or admin can rename this workspace.");
  } });
  const open = find(nodes, "workspaceRename");
  const row = nodes.find((node) => node.className === "dashboard__workspace-settings-title-row");
  open.listeners.click();
  const form = row.children[0];
  assert.ok("workspaceRenameForm" in form.dataset, "the form replaces the title");
  const [input, save, , error] = form.children;
  assert.equal(input.value, "Science");
  assert.equal(save.disabled, true, "an unchanged name cannot be saved");
  input.value = "  Science   Lab ";
  input.listeners.input();
  assert.equal(save.disabled, false);
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls, ["Science Lab"], "spaces are collapsed and trimmed");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Only an owner or admin can rename this workspace.");
  assert.equal(input.disabled, false, "the field stays editable after a refusal");
  input.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(row.children[1], open, "Escape puts the title and Rename back");
  open.listeners.click();
  const again = row.children[0];
  again.children[0].value = "Lab";
  again.children[0].listeners.input();
  refuse = false;
  await again.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls, ["Science Lab", "Lab"]);
  assert.equal(again.children[1].disabled, true, "saved: busy until the panel repaints with the new name");
});

function policyFixture(channelPolicy) {
  const nodes = fixture(channelPolicy ? { channelPolicy } : {});
  const group = nodes.find((node) => "workspaceChannelPolicy" in node.dataset);
  const choice = (value) => nodes.find((node) => node.dataset.workspaceChannelPolicyChoice === value);
  const status = nodes.find((node) => "workspaceChannelPolicyStatus" in node.dataset);
  return { group, choice, status };
}

test("who can create channels is offered only when the caller passes it, and marks the policy held", () => {
  assert.equal(policyFixture(null).group, undefined, "a member's settings have no such control");
  const { group, choice } = policyFixture({ value: "admins", onChange: async (policy) => policy });
  assert.equal(group.attributes.role, "radiogroup");
  assert.equal(group.children[0].textContent, "Who can create channels");
  assert.equal(group.attributes["aria-labelledby"], group.children[0].id);
  assert.deepEqual([choice("members").checked, choice("admins").checked], [false, true]);
  const unknown = policyFixture({ value: null, onChange: async (policy) => policy });
  assert.deepEqual([unknown.choice("members").checked, unknown.choice("admins").checked], [false, false],
    "a policy this build cannot name marks neither choice");
});

test("a policy change is sent once, held while it is answered, and then shows what the server holds", async () => {
  let finish;
  const sent = [];
  const { group, choice, status } = policyFixture({
    value: "members",
    onChange: (policy) => { sent.push(policy); return new Promise((resolve) => { finish = resolve; }); },
  });
  choice("admins").checked = true; choice("members").checked = false;
  const pending = choice("admins").listeners.change();
  assert.deepEqual(sent, ["admins"]);
  assert.deepEqual([choice("members").disabled, choice("admins").disabled], [true, true]);
  assert.equal(group.attributes["aria-busy"], "true");
  finish("admins");
  await pending;
  assert.deepEqual([choice("members").checked, choice("admins").checked], [false, true]);
  assert.deepEqual([choice("members").disabled, choice("admins").disabled], [false, false]);
  assert.equal(group.attributes["aria-busy"], undefined);
  assert.equal(status.textContent, "Saved");
  // Choosing what is already held sends nothing.
  await choice("admins").listeners.change();
  assert.deepEqual(sent, ["admins"]);
});

test("a refused policy change goes back to the policy held and says why", async () => {
  const { choice, status } = policyFixture({
    value: "members",
    onChange: async () => { throw new Error("Only a workspace owner or admin can change who may create channels."); },
  });
  choice("admins").checked = true; choice("members").checked = false;
  await choice("admins").listeners.change();
  assert.deepEqual([choice("members").checked, choice("admins").checked], [true, false]);
  assert.equal(status.textContent, "Only a workspace owner or admin can change who may create channels.");
  assert.equal("problem" in status.dataset, true);
  assert.equal(choice("admins").disabled, false);
});
