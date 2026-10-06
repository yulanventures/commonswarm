import assert from "node:assert/strict";
import { test } from "node:test";
import { homeStructureKey, homeFocusKey, homeFocusTargetKey } from "./home-focus.ts";

const state = { kind: "idle", word: "Idle", detail: "Active 3 minutes ago", attention: false,
  fix: { action: null, allowed: false, askWho: null, sentence: "" } };
const person = { id: "tom", name: "Tom", firstName: "Tom", initials: "T", you: true, role: "owner" };
const agent = { id: "claude", name: "Claude", label: "Your Claude", nestedLabel: "Claude", ownerId: "tom",
  ownerFirstName: "Tom", ownerInitial: "T", yours: true, tint: 0, hosted: true, state };
const group = { person, agents: [agent] };
const workspace = { id: "trip", name: "Trip", href: "/app?w=trip", current: false, needsYou: null };
const rail = { sample: false, catchUp: { href: "/app?v=catchup", current: false, needsYou: null },
  workspaces: [workspace], people: { title: "People & agents", groups: [group], other: [] } };
const shell = { sample: false, workspaceId: "trip", name: "Trip", people: [group], pane: "chat", todosAvailable: false,
  hrefs: { chat: "/app?w=trip", todos: "/app?w=trip&v=todos", lists: "/app?w=trip&v=lists", files: "/app?w=trip&v=files",
    wiki: "/app?w=trip&v=wiki", workspaces: "/app?v=catchup" }, menu: { settings: true, adminAccess: true } };
const catchup = { sample: false, viewerFirstName: "Tom", now: "2026-10-05T12:00:00Z", needsYouExpanded: false,
  needsYou: [{ id: "ask", kind: "ask", workspace, from: agent, what: "Quotes?", when: "3 minutes ago",
    primary: { label: "Reply", href: "/app?w=trip&m=ask" } }],
  workspaces: [{ ...workspace, peopleSummary: "Just you", capsules: [group], openTodos: null, lists: 2, files: 3,
    agentsNeedingAttention: 0, newMessagesSinceLastLooked: null, state: "ready" }],
  latest: [{ id: "note", authorLabel: "Tom", workspace, excerpt: "Quotes arrived.", when: "3 minutes ago" }] };

test("clock-only changes keep each region's controls; identity, status, count and action changes rebuild", () => {
  for (const vm of [rail, shell, catchup]) {
    const later = JSON.parse(JSON.stringify(vm).replaceAll("3 minutes ago", "4 minutes ago").replaceAll("12:00:00Z", "12:01:00Z"));
    assert.equal(homeStructureKey(later), homeStructureKey(vm));
    const renamed = JSON.parse(JSON.stringify(vm).replaceAll('"Trip"', '"Summer trip"'));
    assert.notEqual(homeStructureKey(renamed), homeStructureKey(vm));
    const working = JSON.parse(JSON.stringify(vm).replaceAll('"idle"', '"working"').replaceAll('"Idle"', '"Working"'));
    assert.notEqual(homeStructureKey(working), homeStructureKey(vm));
  }
  assert.notEqual(homeStructureKey({ ...rail, workspaces: [{ ...workspace, needsYou: 1 }] }), homeStructureKey(rail));
  assert.notEqual(homeStructureKey({ ...rail, workspaces: [] }), homeStructureKey(rail));
  assert.notEqual(homeStructureKey({ ...shell, menu: { settings: false, adminAccess: true } }), homeStructureKey(shell));
  assert.notEqual(homeStructureKey({ ...catchup, needsYou: [{ ...catchup.needsYou[0], what: "New question" }] }), homeStructureKey(catchup));
  assert.notEqual(homeStructureKey({ ...catchup, needsYouExpanded: true }), homeStructureKey(catchup));
  assert.notEqual(homeStructureKey({ ...catchup, workspaces: [{ ...catchup.workspaces[0], files: 4 }] }), homeStructureKey(catchup));
});

test("an attention sentence with an aging time updates in place; a new fix still rebuilds", () => {
  const item = { ...catchup.needsYou[0], kind: "agent-fix", what: "Your Claude: A message has waited since 3 minutes ago." };
  const vm = { ...catchup, needsYou: [item] };
  assert.equal(homeStructureKey({ ...vm, needsYou: [{ ...item, what: "Your Claude: A message has waited since 4 minutes ago." }] }), homeStructureKey(vm));
  assert.notEqual(homeStructureKey({ ...vm, needsYou: [{ ...item, primary: { label: "Resume", action: "resume" } }] }), homeStructureKey(vm));
});

test("focus identities survive reordering and distinguish regions, entities and primary/secondary actions", () => {
  const trip = homeFocusKey({ region: "rail", kind: "workspace", id: "trip" });
  const home = homeFocusKey({ region: "rail", kind: "workspace", id: "home" });
  const heading = homeFocusKey({ region: "rail", kind: "element", id: "hm-rail-workspaces-title" });
  assert.equal(trip, '["rail","workspace","trip",""]');
  assert.equal(homeFocusTargetKey(trip, [home, trip], heading), trip);
  assert.equal(homeFocusTargetKey(trip, [trip, home], heading), trip);
  assert.equal(homeFocusTargetKey(trip, [home], heading), heading);
  assert.notEqual(homeFocusKey({ region: "catchup", kind: "workspace", id: "trip" }), trip);
  assert.notEqual(homeFocusKey({ region: "rail", kind: "person", id: "trip" }), trip);
  assert.notEqual(homeFocusKey({ region: "catchup", kind: "needs", id: 'a:b"c', action: "true" }),
    homeFocusKey({ region: "catchup", kind: "needs", id: 'a:b"c', action: "false" }));
});
