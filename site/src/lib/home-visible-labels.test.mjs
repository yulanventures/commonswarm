import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { foldIdentityName } from "./identity-label.ts";
import { disambiguateVisibleLabels } from "./home-visible-labels.ts";
import { catchUpSubline } from "./home-catchup.ts";
import { mapHomePeople, homeNeedsYouCount, catchUpRailPeople, catchUpDetailFromOverview, mapHomeRail, mapCatchUp } from "./home-map.ts";
import { agentAccessibleName } from "./home-primitives.ts";
import { buildHomeRail, railAgentName } from "./home-rail.ts";

const claudeA = "3dab8f40-1111-4111-8111-111111111111";
const claudeB = "9c0e1a22-2222-4222-8222-222222222222";
const muse = "c1c1c1c1-3333-4333-8333-333333333333";
const now = Date.parse("2026-10-05T12:00:00Z");
const labels = rows => disambiguateVisibleLabels(rows);

test("a visible id suffix appears only when labels in the same context match", () => {
  assert.deepEqual([...labels([
    { id: claudeA, label: "Your Claude" },
    { id: claudeB, label: "Priya’s Claude" },
  ])], [[claudeA, "Your Claude"], [claudeB, "Priya’s Claude"]]);
  assert.deepEqual([...labels([
    { id: claudeA, label: "Claude" },
    { id: claudeB, label: "Claude" },
  ])], [[claudeA, "Claude · 3dab8f40"], [claudeB, "Claude · 9c0e1a22"]]);
  assert.deepEqual([...labels([
    { id: claudeA, label: "Your Claude" },
    { id: claudeB, label: "your claude" },
  ])], [[claudeA, "Your Claude · 3dab8f40"], [claudeB, "your claude · 9c0e1a22"]]);
  const grownA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
  const grownB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
  assert.deepEqual([...labels([
    { id: grownA, label: "Your Claude" },
    { id: grownB, label: "Your Claude" },
  ])], [
    [grownA, "Your Claude · aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1"],
    [grownB, "Your Claude · aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2"],
  ]);
  assert.deepEqual([...labels([
    { id: claudeA, label: "Your Claude" },
    { id: claudeB, label: "Your Claude" },
    { id: muse, label: "Your Claude · 3dab8f40" },
  ])], [
    [claudeA, "Your Claude · 3dab8f40-"],
    [claudeB, "Your Claude · 9c0e1a22"],
    [muse, "Your Claude · 3dab8f40"],
  ]);
});

test("a full id suffix stays unique when that label is already visible", () => {
  const grownA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
  const grownB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
  const literalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const tailId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const literal = `Claude · ${grownA}`;
  const takenTail = `Claude · ${grownA} · 2`;
  const foldedUnique = rows => {
    const result = labels(rows);
    assert.equal(new Set([...result.values()].map(foldIdentityName)).size, rows.length);
    return result;
  };
  const result = foldedUnique([
    { id: grownA, label: "Claude" },
    { id: grownB, label: "Claude" },
    { id: literalId, label: literal },
  ]);
  assert.equal(result.get(literalId), literal);
  assert.equal(result.get(grownB), `Claude · ${grownB}`);
  assert.equal(result.get(grownA), takenTail);
  const reversed = foldedUnique([
    { id: literalId, label: literal },
    { id: grownB, label: "Claude" },
    { id: grownA, label: "Claude" },
  ]);
  assert.equal(reversed.get(grownA), takenTail);
  assert.equal(reversed.get(literalId), literal);
  const foldedName = literal.toUpperCase();
  const crowded = foldedUnique([
    { id: grownA, label: "Claude" },
    { id: grownB, label: "Claude" },
    { id: literalId, label: foldedName },
    { id: tailId, label: takenTail },
  ]);
  assert.equal(crowded.get(literalId), foldedName);
  assert.equal(crowded.get(tailId), takenTail);
  assert.equal(crowded.get(grownA), `Claude · ${grownA} · 3`);
  assert.notEqual(foldIdentityName(crowded.get(grownA)), foldIdentityName(foldedName));
  const members = [{ userId: "zoe", name: "Zoe", role: "owner" }];
  const people = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [], members, agents: [
    { principalId: grownA, name: "Claude", ownerUserId: "zoe" },
    { principalId: grownB, name: "Claude", ownerUserId: "zoe" },
    { principalId: literalId, name: literal, ownerUserId: "zoe" },
  ] });
  const agents = people.groups[0].agents;
  assert.equal(agents.length, 3);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  assert.equal(byId.get(literalId).nestedLabel, literal);
  assert.equal(byId.get(grownA).nestedLabel, takenTail);
  assert.equal(byId.get(grownB).nestedLabel, `Claude · ${grownB}`);
  assert.equal(new Set(agents.map(agent => foldIdentityName(agent.nestedLabel))).size, agents.length);
  assert.equal(new Set(agents.map(agent => foldIdentityName(agent.label))).size, agents.length);
  assert.equal(new Set(agents.map(agent => foldIdentityName(railAgentName(agent)))).size, agents.length);
  assert.equal(byId.get(grownA).label, `Your Claude · ${grownA} · 2`);
  assert.notEqual(foldIdentityName(byId.get(grownA).label), foldIdentityName(byId.get(literalId).label));
});

test("home labels keep the suffix off when a possessive or a different owner already distinguishes them", () => {
  const members = [{ userId: "zoe", name: "Zoe", role: "owner" }, { userId: "amy", name: "Amy", role: "member" }, { userId: "priya", name: "Priya Shah", role: "member" }];
  const base = { viewerId: "zoe", now, sample: false, access: [], signals: [], members };
  const split = mapHomePeople({ ...base, agents: [
    { principalId: claudeA, name: "Claude", ownerUserId: "zoe" },
    { principalId: claudeB, name: "Claude", ownerUserId: "priya" },
    { principalId: muse, name: "Muse", ownerUserId: "amy" },
  ] });
  assert.deepEqual(split.groups[0].agents.map(agent => [agent.name, agent.label, agent.nestedLabel]), [["Claude", "Your Claude", "Claude"]]);
  assert.deepEqual(split.groups[1].agents.map(agent => [agent.label, agent.nestedLabel]), [["Amy’s Muse", "Muse"]]);
  assert.deepEqual(split.groups[2].agents.map(agent => [agent.label, agent.nestedLabel]), [["Priya’s Claude", "Claude"]]);
  const twins = mapHomePeople({ ...base, agents: [
    { principalId: claudeA, name: "Claude", ownerUserId: "zoe" },
    { principalId: claudeB, name: "Claude", ownerUserId: "zoe" },
  ] });
  assert.deepEqual(twins.groups[0].agents.map(agent => agent.label), ["Your Claude · 3dab8f40", "Your Claude · 9c0e1a22"]);
  assert.deepEqual(twins.groups[0].agents.map(agent => agent.nestedLabel), ["Claude · 3dab8f40", "Claude · 9c0e1a22"]);
  const amyTwins = mapHomePeople({ ...base, agents: [
    { principalId: claudeA, name: "Claude", ownerUserId: "amy" },
    { principalId: claudeB, name: "Claude", ownerUserId: "amy" },
    { principalId: muse, name: "Muse", ownerUserId: "zoe" },
  ] });
  assert.equal(amyTwins.groups[0].agents[0].label, "Your Muse");
  assert.deepEqual(amyTwins.groups[1].agents.map(agent => agent.label), ["Amy’s Claude · 3dab8f40", "Amy’s Claude · 9c0e1a22"]);
  assert.deepEqual(amyTwins.groups[1].agents.map(agent => agent.nestedLabel), ["Claude · 3dab8f40", "Claude · 9c0e1a22"]);
});

test("accessible names keep a disambiguation suffix that follows a name containing ·", () => {
  const grownA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
  const grownB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
  const literalA = "11111111-1111-4111-8111-111111111111";
  const literalB = "22222222-2222-4222-8222-222222222222";
  const members = [{ userId: "zoe", name: "Zoe", role: "owner" }];
  const people = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [], members, agents: [
    { principalId: grownA, name: "Claude", ownerUserId: "zoe" },
    { principalId: grownB, name: "Claude", ownerUserId: "zoe" },
    { principalId: literalA, name: `Claude · ${grownA}`, ownerUserId: "zoe" },
    { principalId: literalB, name: `Claude · ${grownB}`, ownerUserId: "zoe" },
  ] });
  const byId = new Map(people.groups[0].agents.map(agent => [agent.id, agent]));
  assert.equal(byId.get(grownA).nestedLabel, `Claude · ${grownA} · 2`);
  assert.equal(byId.get(grownB).nestedLabel, `Claude · ${grownB} · 2`);
  assert.equal(byId.get(literalA).nestedLabel, `Claude · ${grownA}`);
  assert.equal(byId.get(literalB).nestedLabel, `Claude · ${grownB}`);
  assert.equal(agentAccessibleName(byId.get(grownA)), `Claude · ${grownA} · 2, your agent, Idle`);
  assert.equal(agentAccessibleName(byId.get(grownB)), `Claude · ${grownB} · 2, your agent, Idle`);
  assert.equal(agentAccessibleName(byId.get(literalA)), `Claude · ${grownA}, your agent, Idle`);
  assert.equal(agentAccessibleName(byId.get(literalB)), `Claude · ${grownB}, your agent, Idle`);
  assert.equal(new Set(people.groups[0].agents.map(agent => agentAccessibleName(agent))).size, 4);
  for (const agent of people.groups[0].agents) assert.notEqual(agentAccessibleName(agent), "Claude · 2, your agent, Idle");
});

test("accessible names stay distinct when owners share a name and the agent name contains ·", () => {
  const members = [
    { userId: "zoe", name: "Zoe", role: "owner" },
    { userId: "n1", name: "Nikki Smith", role: "member" },
    { userId: "n2", name: "Nikki Smith", role: "member" },
  ];
  const people = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [], members, agents: [
    { principalId: claudeA, name: "Nikki’s Muse · night", ownerUserId: "n1" },
    { principalId: claudeB, name: "Nikki’s Muse · night", ownerUserId: "n2" },
  ] });
  const byId = new Map(people.groups.flatMap(group => group.agents).map(agent => [agent.id, agent]));
  assert.equal(byId.get(claudeA).label, "Nikki Smith’s Muse · night · 3dab8f40");
  assert.equal(byId.get(claudeB).label, "Nikki Smith’s Muse · night · 9c0e1a22");
  assert.equal(byId.get(claudeA).nestedLabel, "Nikki’s Muse · night · 3dab8f40");
  assert.equal(byId.get(claudeB).nestedLabel, "Nikki’s Muse · night · 9c0e1a22");
  assert.equal(agentAccessibleName(byId.get(claudeA)), "Nikki’s Muse · night · 3dab8f40, Nikki Smith’s agent, Idle");
  assert.equal(agentAccessibleName(byId.get(claudeB)), "Nikki’s Muse · night · 9c0e1a22, Nikki Smith’s agent, Idle");
  assert.equal(new Set([agentAccessibleName(byId.get(claudeA)), agentAccessibleName(byId.get(claudeB))]).size, 2);
  assert.notEqual(agentAccessibleName(byId.get(claudeA)), "Nikki’s Muse · night, Nikki Smith’s agent, Idle");
  assert.notEqual(agentAccessibleName(byId.get(claudeB)), "Nikki’s Muse · night, Nikki Smith’s agent, Idle");
});

class RailNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    const attributes = this.attributes;
    this.dataset = new Proxy({}, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return attributes.get(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
      },
      set(_target, key, value) {
        attributes.set(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  append(...nodes) {
    for (const node of nodes) {
      if (node == null || node === false) continue;
      node.parent = this;
      this.children.push(node);
    }
  }
}

test("two owners with the same full name get distinct names on the rail buttons", () => {
  const members = [
    { userId: "n1", name: "Nikki Smith", role: "member" },
    { userId: "n2", name: "Nikki Smith", role: "member" },
  ];
  const people = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [], members, agents: [
    { principalId: claudeA, name: "Claude", ownerUserId: "n1" },
    { principalId: claudeB, name: "Claude", ownerUserId: "n2" },
  ] });
  const vm = mapHomeRail([{ id: "W", name: "Home" }], { view: "chat", workspaceId: "W" }, people, false);
  const rail = buildHomeRail({ createElement: tag => new RailNode(tag) }, vm, { openPerson() {}, openAgent() {} });
  const nodes = [];
  const walk = node => { nodes.push(node); for (const child of node.children) walk(child); };
  walk(rail);
  const buttons = nodes.filter(node => node.tag === "button" && node.dataset.railAgent);
  const byAgent = new Map(buttons.map(button => [button.dataset.railAgent, button]));
  assert.equal(buttons.length, 2);
  const nameOf = button => button.getAttribute("aria-label");
  assert.equal(nameOf(byAgent.get(claudeA)), "Claude · 3dab8f40, Nikki Smith’s agent, Idle, No activity reported yet");
  assert.equal(nameOf(byAgent.get(claudeB)), "Claude · 9c0e1a22, Nikki Smith’s agent, Idle, No activity reported yet");
  assert.notEqual(nameOf(byAgent.get(claudeA)), nameOf(byAgent.get(claudeB)));
  for (const button of buttons) {
    assert.equal(button.getAttribute("aria-hidden"), null);
    assert.equal(button.getAttribute("role"), null);
    const shown = button.children.find(child => child.className.split(" ").includes("hm-rail__name"));
    assert.equal(shown.textContent, button.dataset.railAgent === claudeA ? "Claude · 3dab8f40" : "Claude · 9c0e1a22");
    const orb = button.children.find(child => child.className.split(" ").includes("hm-rail__orb"));
    assert.equal(orb.getAttribute("aria-hidden"), "true");
    assert.equal(nodes.includes(orb), true);
    assert.notEqual(orb.tag, "button");
  }
});

test("a card list with no overview tally counts only when that list is complete", () => {
  const workspace = { id: "W", name: "Home" };
  const people = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [],
    members: [{ userId: "zoe", name: "Zoe", role: "owner" }, { userId: "amy", name: "Amy", role: "member" }],
    agents: [{ principalId: claudeA, name: "Claude", ownerUserId: "zoe" }] });
  const ask = { id: "ask", kind: "ask", workspace: { ...workspace, href: "/app?w=W" }, from: people.groups[1].person,
    what: "Amy asked you: ‘Call?’", when: "now", primary: { label: "Reply", href: "/app?w=W" } };
  const detail = { people, signals: [], openTodos: 4, lists: 1, files: 2, newMessages: 12, needsYou: [ask], needsYouComplete: true };
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail }), 1);
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail: { ...detail, needsYou: [], needsYouComplete: true } }), 0);
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail: { ...detail, needsYou: [], needsYouComplete: false } }), null);
  assert.equal(homeNeedsYouCount({ workspace, state: "loading" }), null);
  assert.equal(homeNeedsYouCount({ workspace, state: "failed", detail }), null);
  const disconnected = mapHomePeople({ viewerId: "zoe", now, sample: false, access: [], signals: [],
    members: [{ userId: "zoe", name: "Zoe", role: "owner" }],
    agents: [{ principalId: claudeA, name: "Claude", ownerUserId: "zoe", work: { work: "disconnected", facts: {
      transport: "hosted_mcp", turn_only: true, connection: "connection_off", last_activity_at: "2026-10-05T11:59:00Z",
      messages_waiting_since: null, doing: null, working_on: null } } }] });
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail: {
    people: disconnected, signals: [], openTodos: null, lists: null, files: null, newMessages: 8,
    needsYou: [], needsYouComplete: false } }), null, "one rendered fix is not a measured count");
});

const disconnectedStatus = { work: "disconnected", facts: {
  transport: "local", turn_only: false, connection: "key_off", last_activity_at: "2026-10-05T11:00:00Z",
  messages_waiting_since: null, doing: null, working_on: null } };
const todoRef = (todo_id, title) => ({ todo_id, title, state: "open", due_on: null });
test("rail badges match the cards, including an ask whose preview failed", () => {
  const home = {
    workspace_id: "W", name: "Home", role: "owner", last_seen_at: "2026-10-05T08:00:00Z", new_messages: 12,
    content: { open_todos: 9, lists: 1, docs: 0, files: 1 },
    people: [{ user_id: "zoe", display_name: "Zoe", role: "owner", is_viewer: true, agents: [
      { principal_id: claudeA, name: "Claude", status: disconnectedStatus, queue: null }] }],
    needs_you: {
      asks: [
        { signal_id: "ask", from: { kind: "user", id: "zoe" }, created_at: "2026-10-05T11:00:00Z", until: "2026-10-06T12:00:00Z" },
        { signal_id: "old", from: { kind: "user", id: "zoe" }, created_at: "2026-10-04T11:00:00Z", until: "2026-10-05T11:00:00Z" },
      ],
      assigned: [todoRef("t1", "Renew"), todoRef("t2", "Collect")],
      waiting: [todoRef("t3", "Research"), todoRef("t4", "File"), todoRef("t5", "Wait"), todoRef("t1", "Renew again")],
    },
  };
  const failed = catchUpDetailFromOverview(home, "zoe", now, false, []);
  assert.deepEqual(failed.needsYou.map(item => [item.kind, item.what, item.primary.label]), [
    ["ask", "Zoe asked you.", "Reply"],
    ["todo", "‘Renew’ is assigned to you.", "Open"],
    ["todo", "‘Collect’ is assigned to you.", "Open"],
    ["todo", "Waiting on you: ‘Research’.", "Open"],
    ["todo", "Waiting on you: ‘File’.", "Open"],
    ["todo", "Waiting on you: ‘Wait’.", "Open"],
  ]);
  assert.equal(failed.needsYou[0].what.includes("‘"), false);
  assert.equal(failed.needsYou[0].primary.href, "/app?w=W&m=ask");
  assert.equal(failed.needsYouComplete, true);
  assert.equal(failed.measuredNeedsYou, 7, "one unexpired ask, two assigned, three waiting ids, and the disconnected agent");
  const failedVm = mapCatchUp([{ workspace: { id: "W", name: "Home" }, state: "ready", detail: failed }], "zoe", "Zoe", now, false);
  assert.equal(failedVm.needsYou.length, 7);
  assert.equal(catchUpSubline(failedVm), "7 things need you across 1 workspace.");
  assert.equal(failed.newMessages, 12);
  const workspace = { id: "W", name: "Home" };
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail: failed }), 7);
  const preview = { id: "ask", kind: "ask", from: "zoe", fromKind: "user", body: "Sign this?", createdAt: "2026-10-05T11:00:00Z" };
  const drawn = catchUpDetailFromOverview(home, "zoe", now, false, [preview]);
  assert.equal(drawn.needsYou.filter(item => item.kind === "ask").length, 1);
  assert.equal(drawn.needsYou.length, 6);
  assert.equal(homeNeedsYouCount({ workspace, state: "ready", detail: drawn }), 7, "drawing the ask does not change the tally");
  const trip = {
    workspace_id: "X", name: "Trip", role: "owner", last_seen_at: null, new_messages: 0, content: null,
    people: [{ user_id: "zoe", display_name: "Zoe", role: "owner", is_viewer: true, agents: [] }],
    needs_you: { asks: [], assigned: [todoRef("trip", "Pickup")], waiting: [] },
  };
  const tripDetail = catchUpDetailFromOverview(trip, "zoe", now, false, []);
  assert.equal(tripDetail.needsYou.length, 1);
  assert.equal(tripDetail.needsYou[0].what, "‘Pickup’ is assigned to you.");
  assert.equal(tripDetail.needsYou[0].primary.label, "Open");
  assert.equal(homeNeedsYouCount({ workspace: { id: "X", name: "Trip" }, state: "ready", detail: tripDetail }), 1);
  const clear = catchUpDetailFromOverview({ ...trip, workspace_id: "Y", name: "Paper", needs_you: { asks: [], assigned: [], waiting: [] } }, "zoe", now, false, []);
  assert.equal(homeNeedsYouCount({ workspace: { id: "Y", name: "Paper" }, state: "ready", detail: clear }), 0);
  const homeCount = homeNeedsYouCount({ workspace, state: "ready", detail: failed });
  const tripCount = homeNeedsYouCount({ workspace: { id: "X", name: "Trip" }, state: "ready", detail: tripDetail });
  const paperCount = homeNeedsYouCount({ workspace: { id: "Y", name: "Paper" }, state: "ready", detail: clear });
  const rail = mapHomeRail(
    [{ id: "W", name: "Home" }, { id: "X", name: "Trip" }, { id: "Y", name: "Paper" }],
    { view: "catchup" }, null, false,
    new Map([["W", homeCount], ["X", tripCount], ["Y", paperCount]]));
  assert.equal(rail.catchUp.needsYou, 8);
  assert.deepEqual(rail.workspaces.map(row => row.needsYou), [7, 1, 0]);
  const askOnly = catchUpDetailFromOverview({
    ...home, new_messages: 4, content: null,
    needs_you: { asks: home.needs_you.asks.slice(0, 1), assigned: [], waiting: [] },
  }, "zoe", now, false, []);
  assert.equal(askOnly.needsYou.length, 1);
  assert.equal(askOnly.needsYou[0].what, "Zoe asked you.");
  assert.equal(askOnly.needsYou[0].primary.label, "Reply");
  const askOnlyEntry = { workspace, state: "ready", detail: askOnly };
  const askOnlyVm = mapCatchUp([askOnlyEntry], "zoe", "Zoe", now, false);
  assert.equal(homeNeedsYouCount(askOnlyEntry), 2);
  assert.equal(askOnlyVm.needsYou.length, 2);
  assert.equal(catchUpSubline(askOnlyVm), "2 things need you across 1 workspace.");
  assert.deepEqual(askOnlyVm.needsYou.map(item => [item.kind, item.primary.label]), [["ask", "Reply"], ["agent-fix", "What to do"]]);
});

test("Catch up suffixes two own agents that were unique inside different workspaces", () => {
  const members = [{ userId: "zoe", name: "Zoe", role: "owner" }];
  const base = { viewerId: "zoe", now, sample: false, access: [], signals: [], members };
  const home = mapHomePeople({ ...base, agents: [{ principalId: claudeA, name: "Claude", ownerUserId: "zoe" }] });
  const trip = mapHomePeople({ ...base, agents: [{ principalId: claudeB, name: "Claude", ownerUserId: "zoe" }] });
  assert.equal(home.groups[0].agents[0].nestedLabel, "Claude");
  assert.equal(trip.groups[0].agents[0].nestedLabel, "Claude");
  const rail = catchUpRailPeople([{ detail: { people: home } }, { detail: { people: trip } }]);
  assert.equal(rail.title, "You and your agents");
  assert.deepEqual(rail.groups[0].agents.map(agent => agent.nestedLabel), ["Claude · 3dab8f40", "Claude · 9c0e1a22"]);
  assert.equal(home.groups[0].agents[0].nestedLabel, "Claude", "the workspace label stays bare");
  assert.equal(trip.groups[0].agents[0].nestedLabel, "Claude");
  const same = catchUpRailPeople([{ detail: { people: home } }, { detail: { people: home } }]);
  assert.deepEqual(same.groups[0].agents.map(agent => [agent.id, agent.nestedLabel]), [[claudeA, "Claude"]]);
  const museHome = mapHomePeople({ ...base, agents: [{ principalId: muse, name: "Muse", ownerUserId: "zoe" }] });
  const distinct = catchUpRailPeople([{ detail: { people: home } }, { detail: { people: museHome } }]);
  assert.deepEqual(distinct.groups[0].agents.map(agent => agent.nestedLabel), ["Claude", "Muse"]);
  const dashboard = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const body = dashboard.slice(dashboard.indexOf("const renderHomeRail"), dashboard.indexOf("const renderHomeShell"));
  assert.match(body, /catchUpRailPeople\(catchUpData\)/);
});
