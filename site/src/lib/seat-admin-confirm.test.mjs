/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeatAdminConfirmation, organizationAdminCoverage, organizationAdminSummary, workspaceAdminLater, workspaceAdminSummary } from "./seat-admin-view.ts";
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
const endOf = (dialog) => dialog.all().find((node) => node.className === "sa-confirm__end");
const copy = SEAT_ADMIN_ROLE_COPY["role:workspace_admin"];

test("the workspace grant leads with the decision; the full lists are under Show permissions", () => {
  const { dialog } = build();
  const parts = body(dialog).children;
  const more = parts.at(-1);
  // Before Grant, with Show permissions closed: who and what (the title), where, what it can do now, what comes later, when it ends.
  assert.equal(dialog.all().find((node) => node.tag === "h2").textContent, "Make Atlas a workspace admin?");
  const visible = parts.filter((node) => node !== more && !node.hidden);
  assert.deepEqual(visible.map((node) => Object.keys(node.dataset)[0] ?? node.className), ["seatAdminScopeName", "seatAdminSummary", "seatAdminLater"]);
  assert.equal(visible[0].textContent, "Workspace: Rivera household", "a single eligible workspace is said as text");
  assert.equal(visible[1].textContent, workspaceAdminSummary());
  assert.equal(visible[2].textContent, workspaceAdminLater(copy.deferred.length));
  // When it ends is pinned with the buttons, outside the part that scrolls, so it is on screen beside Grant.
  const form = dialog.all().find((node) => node.className === "sa-confirm__form");
  assert.deepEqual(form.children.map((node) => node.tag === "header" || node.tag === "footer" ? node.tag : node.className), ["header", "sa-confirm__body", "sa-confirm__end", "sa-confirm__notice", "footer"]);
  const end = endOf(dialog);
  assert.ok(end.children[0].textContent.startsWith("End date"));
  assert.equal(end.children[1].textContent, "Admin access stays on until you remove it or retire this agent.");
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
  assert.equal(workspaceAdminLater(5), "This grant also includes 5 permissions that aren’t available yet. If they’re enabled for this grant while it’s active, this agent can use them without another approval.");
  assert.equal(workspaceAdminLater(1), "This grant also includes 1 permission that isn’t available yet. If it’s enabled for this grant while it’s active, this agent can use it without another approval.");
});

test("the organization grant has the same shape, and keeps both conditions on its workspace powers in view", () => {
  const orgCopy = SEAT_ADMIN_ROLE_COPY["role:organization_admin"];
  const { dialog } = build({ level: "organization", scopes: [{ id: "o1", name: "Rivera family" }], scopeId: "o1" });
  const parts = body(dialog).children, more = parts.at(-1);
  assert.equal(dialog.all().find((node) => node.tag === "h2").textContent, "Make Atlas an organization admin?");
  const visible = parts.filter((node) => node !== more && !node.hidden);
  assert.deepEqual(visible.map((node) => Object.keys(node.dataset)[0] ?? node.className), ["seatAdminScopeName", "seatAdminSummary", "seatAdminCoverage", "seatAdminLater"]);
  // The end date is not in the scrolling part: it sits with the buttons.
  assert.ok(endOf(dialog).children[0].textContent.startsWith("End date"));
  assert.ok(!parts.some((node) => node.className === "sa-confirm__end-note"));
  assert.equal(visible[0].textContent, "Organization: Rivera family");
  // The summary restates exactly these two fixed lines. If the fixed list changes, this fails so the sentence is reread.
  assert.deepEqual([...orgCopy.included], [
    "Everything available now to a workspace admin, in this organization's workspaces you own and this agent belongs to",
    "Rename the organization's display name",
  ]);
  const summary = organizationAdminSummary();
  assert.equal(visible[1].textContent, summary);
  assert.equal(summary, "From a workspace in this organization that you own and this agent belongs to, it can rename the organization’s display name and use the same powers as an agent with workspace admin access. Those powers include removing eligible members, which removes their agents and Lists & docs access from that workspace.");
  // Both conditions are in the sentence a person reads before Grant, and they lead it, because they bind the rename too.
  assert.match(summary, /^From a workspace in this organization that you own and this agent belongs to,/);
  assert.match(summary, /an agent with workspace admin access/, "the role whose powers are meant is named");
  // Coverage follows the organization over time, and says when a later workspace qualifies.
  assert.equal(visible[2].textContent, organizationAdminCoverage());
  assert.equal(organizationAdminCoverage(), "While this grant is active and you own the organization, it also covers workspaces there that you later come to own or this agent later joins, once you own the workspace and the agent is a member.");
  // Nothing excluded is promised: members and roles, owners or admins, billing.
  for (const word of ["roles", "billing", "owners or admins", "archiving", "invite people"]) assert.ok(!summary.toLowerCase().includes(word), word);
  assert.equal(visible[3].textContent, workspaceAdminLater(orgCopy.deferred.length));
  // Show permissions: closed, with all three lists exactly as the fixed copy has them.
  assert.equal(more.tag, "details"); assert.notEqual(more.open, true); assert.equal(more.children[0].textContent, "Show permissions");
  const lists = more.children.slice(1);
  assert.deepEqual(lists.map((section) => section.children[0].textContent), ["Available now", "Workspace admin powers", "Included, not available yet", "Not allowed"]);
  // The three fixed lists are the only "permissions" sections; the workspace admin's lines are marked as their detail.
  assert.deepEqual(lists.map((section) => section.className), ["sa-confirm__permissions", "sa-confirm__detail", "sa-confirm__permissions", "sa-confirm__permissions"]);
  // The three fixed lists are verbatim; the workspace admin's six lines sit beside the list that refers to them.
  assert.deepEqual(lists.map((section) => section.children[1].children.map((line) => line.textContent)),
    [[...orgCopy.included], [...copy.included], [...orgCopy.deferred], [...orgCopy.excluded]]);
  const footer = dialog.all().find((node) => node.tag === "footer");
  assert.equal(footer.children[0].textContent, "Cancel");
  assert.equal(footer.children.find((node) => "seatAdminGrant" in node.dataset).textContent, "Grant organization admin");
  // Several organizations: the chooser stays, nothing is preselected, and no name is asserted as text.
  const several = build({ level: "organization", scopes: [{ id: "o1", name: "Rivera family" }, { id: "o2", name: "Studio" }], scopeId: undefined });
  assert.equal(body(several.dialog).children[0].hidden, false);
  assert.ok(!body(several.dialog).children.some((node) => "seatAdminScopeName" in node.dataset));
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
  const summary = workspaceAdminSummary();
  assert.equal(summary, "This agent can rename this workspace, choose one of your agents here as its lead, add or remove your agents here, cancel member invitations you created here, and create agent seats you own here. It can also remove eligible members, which removes their agents and Lists & docs access from this workspace.");
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
