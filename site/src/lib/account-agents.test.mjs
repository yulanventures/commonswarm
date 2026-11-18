import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAccountAgents } from "./account-agents.ts";

const doc = { createElement: tag => ({ tag, children: [], append(...children) { this.children.push(...children); } }) };
const workspace = { id: "workspace & 1", name: "Home <script>", orgId: "org", orgName: "Yulan <img>", revokedAt: null, archivedAt: null };
const agent = { id: "local", name: "Claude <img>", model: "Opus <b>", transport: "local", revokedAt: null, workspaces: [workspace] };
const descendants = node => [node, ...node.children.flatMap(descendants)];

test("account agents show safe names, model, transport and workspace/org with an active workspace link", () => {
  const view = buildAccountAgents(doc, [agent, { ...agent, id: "hosted", transport: "hosted_mcp", model: null }]);
  const nodes = descendants(view);
  assert.equal(view.tag, "ul");
  assert.equal(view.children.length, 2, "separate identities are never collapsed by matching names");
  assert.deepEqual(nodes.filter(node => node.tag === "h3").map(node => node.textContent), ["Claude <img>", "Claude <img>"]);
  assert.deepEqual(nodes.filter(node => node.className === "account-agents__model").map(node => node.textContent),
    ["Opus <b> · Terminal", "Connected app"]);
  const link = nodes.find(node => node.tag === "a");
  assert.equal(link.textContent, "Home <script>");
  assert.equal(link.href, "/app?w=workspace%20%26%201");
  assert.equal(nodes.find(node => node.className === "account-agents__org").textContent, "Yulan <img>");
  assert.ok(nodes.every(node => node.innerHTML === undefined));
});

test("an organization is named beside a workspace only when its name says something the workspace's does not", () => {
  const orgs = (workspaces) => descendants(buildAccountAgents(doc, [{ ...agent, workspaces }]))
    .filter(node => node.className === "account-agents__org").map(node => node.textContent);
  // The usual case: one organization per workspace, with the same name. It is not said twice.
  assert.deepEqual(orgs([{ ...workspace, name: "Rivera household", orgName: "Rivera household" }]), []);
  assert.deepEqual(orgs([{ ...workspace, name: "Rivera household ", orgName: " Rivera household" }]), [], "spaces around a name do not make it a different name");
  assert.deepEqual(orgs([{ ...workspace, orgName: "" }]), [], "an empty name draws no empty element");
  // A different name is still shown, row by row.
  assert.deepEqual(orgs([{ ...workspace, name: "Design studio", orgName: "Yulan Ventures" }, { ...workspace, id: "w2", name: "Yulan Ventures", orgName: "Yulan Ventures" }]),
    ["Yulan Ventures"]);
});

test("removed agents/memberships and archived workspaces keep history without an active link", () => {
  for (const entry of [
    { ...agent, revokedAt: "2026-10-01" },
    { ...agent, workspaces: [{ ...workspace, revokedAt: "2026-10-01" }] },
    { ...agent, workspaces: [{ ...workspace, archivedAt: "2026-10-01" }] },
  ]) {
    const nodes = descendants(buildAccountAgents(doc, [entry]));
    assert.equal(nodes.filter(node => node.tag === "a").length, 0);
    assert.ok(nodes.some(node => ["Removed", "Archived"].includes(node.textContent)));
  }
});

test("empty accounts and owned agents without readable workspaces have honest empty states", () => {
  assert.equal(buildAccountAgents(doc, []).textContent, "No agents yet.");
  assert.ok(descendants(buildAccountAgents(doc, [{ ...agent, workspaces: [] }]))
    .some(node => node.textContent === "No workspaces"));
});

test('picker offers live local and hosted identities in this organization and permits explicit membership restoration',async()=>{
  const {addableAccountAgents}=await import('./account-agents.ts');
  const target='sibling';
  const choices=[agent,{...agent,id:'hosted',transport:'hosted_mcp'},{...agent,id:'revoked',revokedAt:'now'},
    {...agent,id:'foreign',workspaces:[{...workspace,orgId:'elsewhere'}]},
    {...agent,id:'present',workspaces:[workspace,{...workspace,id:target}]},
    {...agent,id:'restore',workspaces:[{...workspace,id:target,revokedAt:'now'}]}];
  assert.deepEqual(addableAccountAgents(choices,target,'org').map(a=>a.id),['local','hosted','restore']);
});

test("live local agents offer Reconnect and invoke onReconnect with the card panel", () => {
  const clicked = [];
  const interactiveDoc = {
    createElement: tag => ({
      tag,
      children: [],
      listeners: {},
      append(...children) { this.children.push(...children); },
      addEventListener(event, fn) { this.listeners[event] = fn; },
    }),
  };
  const view = buildAccountAgents(
    interactiveDoc,
    [agent, { ...agent, id: "hosted", transport: "hosted_mcp" }, { ...agent, id: "removed", revokedAt: "2026-11-01" }],
    (targetAgent, panel, button) => { clicked.push({ id: targetAgent.id, panelHidden: panel.hidden, label: button.textContent }); },
  );
  const buttons = descendants(view).filter(node => node.className === "account-agents__reconnect");
  assert.equal(buttons.length, 1);
  buttons[0].listeners.click();
  assert.deepEqual(clicked, [{ id: "local", panelHidden: true, label: "Reconnect" }]);
});
