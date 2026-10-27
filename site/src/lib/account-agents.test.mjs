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

test('picker offers only live local identities in this organization and permits explicit membership restoration',async()=>{
  const {addableLocalAgents}=await import('./account-agents.ts');
  const target='sibling';
  const choices=[agent,{...agent,id:'hosted',transport:'hosted_mcp'},{...agent,id:'revoked',revokedAt:'now'},
    {...agent,id:'foreign',workspaces:[{...workspace,orgId:'elsewhere'}]},
    {...agent,id:'present',workspaces:[workspace,{...workspace,id:target}]},
    {...agent,id:'restore',workspaces:[{...workspace,id:target,revokedAt:'now'}]}];
  assert.deepEqual(addableLocalAgents(choices,target,'org').map(a=>a.id),['local','restore']);
});
