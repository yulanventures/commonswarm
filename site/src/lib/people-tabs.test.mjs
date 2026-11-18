import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleSearchLabel, peopleSearchResult, peopleTab, peopleTabAction, peopleTabOf, peopleTabs } from "./people/tabs.ts";

const model = (overrides = {}) => ({ people: ["ana", "sam"], agents: ["atlas", "harbor", "ledger"], invites: ["mei"], sample: false, ...overrides });

test("the dialog opens on Agents, keeps a tab that exists, and never opens Invites in the sample workspace", () => {
  assert.equal(peopleTab(model(), undefined), "agents");
  for (const tab of ["people", "agents", "invites"]) assert.equal(peopleTab(model(), tab), tab);
  for (const unknown of ["all", "admins", "", null, 3]) assert.equal(peopleTab(model(), unknown), "agents", String(unknown));
  assert.equal(peopleTab(model({ sample: true }), "invites"), "agents");
  assert.equal(peopleTab(model({ sample: true }), "people"), "people");
});

test("each tab carries its own count, and exactly one is selected", () => {
  const tabs = peopleTabs(model(), "invites");
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.label, tab.count, tab.selected]),
    [["people", "People", 2, false], ["agents", "Agents", 3, false], ["invites", "Invites", 1, true]]);
  assert.deepEqual(tabs.map((tab) => tab.name), ["People, 2", "Agents, 3", "Invites, 1 waiting"]);
  assert.deepEqual(peopleTabs(model({ sample: true }), "invites").map((tab) => [tab.id, tab.selected]), [["people", false], ["agents", true]],
    "the sample workspace has no Invites tab and falls back to Agents");
});

test("each tab offers one main action: an owner or admin may invite, anyone may add an agent, the sample offers neither", () => {
  const owner = { mayInvite: true, sample: false }, member = { mayInvite: false, sample: false }, sample = { mayInvite: true, sample: true };
  assert.deepEqual(["people", "agents", "invites"].map((tab) => peopleTabAction(tab, owner)), ["invite", "add-agent", "invite"]);
  assert.deepEqual(["people", "agents", "invites"].map((tab) => peopleTabAction(tab, member)), [null, "add-agent", null]);
  assert.deepEqual(["people", "agents", "invites"].map((tab) => peopleTabAction(tab, sample)), [null, null, null]);
});

test("a person lives on People and an agent on Agents; search names what it searches and says when nothing matched", () => {
  assert.equal(peopleTabOf("person"), "people"); assert.equal(peopleTabOf("agent"), "agents");
  assert.deepEqual(["people", "agents", "invites"].map(peopleSearchLabel), ["Find a person", "Find an agent", "Find an invite"]);
  assert.equal(peopleSearchResult("agents", 2), "2 agents"); assert.equal(peopleSearchResult("people", 1), "1 person");
  assert.equal(peopleSearchResult("invites", 0), "0 invites. No matches. Try another name.");
});
