/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeatAdminConfirmation, workspaceAdminLater, workspaceAdminSummary } from "./seat-admin-view.ts";
import { SEAT_ADMIN_ROLE_COPY } from "../../../src/protocol/seat-admin-copy.ts";

/* A minimal DOM: enough for the confirmation builder's own calls. */
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false;
    this.className = ""; this._text = ""; this.value = ""; this.classList = { add: (name) => { this.className += ` ${name}`; } }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  all() { return [this, ...this.children.flatMap((child) => child.all())]; }
}
const doc = { createElement: (tag) => new Node(tag), documentElement: { lang: "en" } };
const build = (options = {}) => buildSeatAdminConfirmation(doc, { principalId: "agent-1", agentName: "Atlas", level: "workspace",
  scopes: [{ id: "w1", name: "Rivera household" }], scopeId: "w1", confirm() {}, signIn() {}, refresh() {}, ...options });
const body = (dialog) => dialog.all().find((node) => node.className === "sa-confirm__body");
const copy = SEAT_ADMIN_ROLE_COPY["role:workspace_admin"];

test("the workspace grant leads with the decision; the full lists are under Show permissions", () => {
  const { dialog } = build();
  const parts = body(dialog).children;
  const more = parts.at(-1);
  // Before Grant, with Show permissions closed: who and what (the title), where, what it can do now, what comes later, when it ends.
  assert.equal(dialog.all().find((node) => node.tag === "h2").textContent, "Make Atlas a workspace admin?");
  const visible = parts.filter((node) => node !== more && !node.hidden);
  assert.deepEqual(visible.map((node) => Object.keys(node.dataset)[0] ?? node.className), ["seatAdminScopeName", "seatAdminSummary", "seatAdminLater", "sa-field", "sa-confirm__end-note"]);
  assert.equal(visible[0].textContent, "Workspace: Rivera household", "a single eligible workspace is said as text");
  assert.equal(visible[1].textContent, workspaceAdminSummary("Atlas"));
  assert.equal(visible[2].textContent, workspaceAdminLater("Atlas", copy.deferred.length));
  assert.ok(visible[3].textContent.startsWith("End date"));
  assert.equal(visible[4].textContent, "Admin access stays on until you remove it or retire this agent.");
  // The chooser is still there and still carries the value; it is only out of sight.
  const chooser = dialog.all().find((node) => "seatAdminScope" in node.dataset);
  assert.equal(chooser.value, "w1"); assert.equal(parts[0].hidden, true);
  // Show permissions: closed, and holding all three lists, every line unchanged.
  assert.equal(more.tag, "details"); assert.notEqual(more.open, true);
  assert.equal(more.children[0].tag, "summary"); assert.equal(more.children[0].textContent, "Show permissions");
  const lists = more.children.slice(1);
  assert.deepEqual(lists.map((section) => section.children[0].textContent), ["Available now", "Included, not available yet", "Not allowed"]);
  assert.deepEqual(lists.map((section) => section.children[1].children.map((line) => line.textContent)), [[...copy.included], [...copy.deferred], [...copy.excluded]]);
  // Cancel comes first for the keyboard, and the final action is named.
  const footer = dialog.all().find((node) => node.tag === "footer");
  assert.equal(footer.children[0].textContent, "Cancel");
  assert.equal(footer.children.find((node) => "seatAdminGrant" in node.dataset).textContent, "Grant workspace admin");
});

test("several workspaces keep the chooser in view; the count of later powers follows the fixed list", () => {
  const { dialog } = build({ scopes: [{ id: "w1", name: "Rivera household" }, { id: "w2", name: "Reading club" }] });
  const parts = body(dialog).children;
  assert.equal(parts[0].hidden, false, "the chooser shows when there is a choice");
  assert.ok(!parts.some((node) => "seatAdminScopeName" in node.dataset));
  assert.equal(workspaceAdminLater("Atlas", 5), "This grant also includes 5 permissions that aren’t available yet. If they’re enabled for this grant while it’s active, Atlas can use them without another approval.");
  assert.equal(workspaceAdminLater("Atlas", 1), "This grant also includes 1 permission that isn’t available yet. If it’s enabled for this grant while it’s active, Atlas can use it without another approval.");
});

test("the organization grant keeps its layout until its own change", () => {
  const { dialog } = build({ level: "organization", scopes: [{ id: "o1", name: "Rivera family" }], scopeId: "o1" });
  const parts = body(dialog).children;
  assert.ok(!parts.some((node) => node.tag === "details"));
  assert.equal(parts.filter((node) => node.className === "sa-confirm__permissions").length, 3);
  assert.equal(parts[0].hidden, false);
});

test("the summary is tied to the fixed lists: it reflects Available now, and the later count follows the deferred list", () => {
  // The summary sentence restates exactly these six lines. If the fixed list changes, this fails so the sentence is reread.
  assert.deepEqual([...copy.included], [
    "Rename this workspace",
    "Choose one of your agents in this workspace as its lead",
    "Add your agents to this workspace or remove them",
    "Remove members, including their agents and Lists & docs access in this workspace",
    "Cancel member invitations you created",
    "Create new agent seats you own in this workspace",
  ]);
  const summary = workspaceAdminSummary("Atlas");
  assert.equal(summary, "Atlas can rename this workspace, choose one of your agents here as its lead, add or remove your agents here, cancel member invitations you created here, and create agent seats you own here. Atlas can also remove eligible members, which removes their agents and Lists & docs access from this workspace.");
  // The limits the security reviewer asked to keep in view: "member" on invitations, and what removing a member takes with it.
  assert.match(summary, /cancel member invitations you created/); assert.match(summary, /removes their agents and Lists & docs access/);
  // Nothing from the deferred or excluded lists is promised as available now.
  for (const word of ["invite people", "renew", "roles", "billing", "owners or admins"]) assert.ok(!summary.toLowerCase().includes(word), word);
  // The count beside the decision is the deferred list's own length.
  const { dialog } = build();
  assert.ok(dialog.all().find((node) => "seatAdminLater" in node.dataset).textContent.includes(`${copy.deferred.length} permissions`));
  // And all three lists can be opened: they are inside the one disclosure.
  const more = dialog.all().find((node) => "seatAdminPermissions" in node.dataset);
  assert.equal(more.children.filter((node) => node.className === "sa-confirm__permissions").length, 3);
});
