import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catchUpAgentAttentionLine,
  catchUpCardFooter,
  catchUpDateLine,
  catchUpGreeting,
  catchUpLatestVisible,
  catchUpNeedsYouMoreCount,
  catchUpNeedsYouVisible,
  catchUpNewMessagesSinceLastLookedLine,
  catchUpPeopleSummary,
  catchUpSubline,
  catchUpWorkspaceCheckTotals,
  catchUpWorkspaceCountsLine,
} from "./home-catchup.ts";

const person = (id, firstName, you = false, name = firstName) => ({ id, name, firstName, initials: firstName[0], you, role: "member" });
const workspace = (id, state, overrides = {}) => ({
  id, name: id, href: `?w=${id}`, peopleSummary: "Just you", capsules: [], openTodos: null, lists: null, files: null,
  agentsNeedingAttention: null, newMessagesSinceLastLooked: null, state, ...overrides,
});
const needsYou = (id, workspaceId) => ({
  id, kind: "ask", workspace: { id: workspaceId, name: workspaceId, href: `?w=${workspaceId}` },
  from: person("a", "Claude"), what: "Ping", when: "9:00 am", primary: { label: "Reply" },
});
const vm = (overrides = {}) => ({
  sample: false, viewerFirstName: "Tom", now: "2026-10-05T09:00:00", needsYou: [], workspaces: [], latest: [], ...overrides,
});

test("greeting follows the local clock without home-names", () => {
  assert.equal(catchUpGreeting("2026-10-05T08:30:00", "Tom"), "Good morning, Tom.");
  assert.equal(catchUpGreeting("2026-10-05T13:00:00", "Tom"), "Good afternoon, Tom.");
  assert.equal(catchUpGreeting("2026-10-05T20:00:00", "Tom"), "Good evening, Tom.");
});

test("people summaries match the possessive naming table", () => {
  assert.equal(catchUpPeopleSummary([person("t", "Tom", true)]), "Just you");
  assert.equal(catchUpPeopleSummary([person("t", "Tom", true), person("n", "Nikki")]), "You and Nikki");
  assert.equal(catchUpPeopleSummary([person("t", "Tom", true), person("p", "Priya"), person("m", "Marcus")]), "You, Priya and Marcus");
  assert.equal(catchUpPeopleSummary([
    person("t", "Tom", true), person("n", "Nikki"), person("p", "Priya"), person("m", "Marcus"), person("a", "Alex"),
  ]), "You, Nikki and 3 others");
  assert.equal(catchUpPeopleSummary([
    person("t", "Tom", true),
    person("n1", "Nikki", false, "Nikki Smith"),
    person("n2", "Nikki", false, "Nikki Jones"),
  ]), "You, Nikki Smith and Nikki Jones");
  assert.equal(catchUpPeopleSummary([
    person("v", "Nikki", true, "Nikki Smith"),
    person("n2", "Nikki", false, "Nikki Jones"),
  ]), "You and Nikki Jones");
});

test("subline prefers partial failure over the empty state", () => {
  const partial = vm({
    workspaces: [workspace("a", "ready"), workspace("b", "ready"), workspace("c", "failed"), workspace("d", "loading")],
  });
  assert.equal(catchUpSubline(partial), "Checked 2 of 4 workspaces.");
  const resolvedFailure = vm({
    workspaces: [workspace("a", "ready"), workspace("b", "ready"), workspace("c", "ready"), workspace("d", "failed")],
  });
  assert.equal(catchUpSubline(resolvedFailure), "Checked 3 of 4 workspaces.");
  const busy = vm({
    needsYou: [needsYou("1", "home"), needsYou("2", "trip")],
    workspaces: [workspace("home", "ready"), workspace("trip", "ready"), workspace("crew", "ready"), workspace("paper", "ready")],
  });
  assert.equal(catchUpSubline(busy), "2 things need you across 4 workspaces.");
  const oneNeed = vm({
    needsYou: [needsYou("1", "home")],
    workspaces: [workspace("home", "ready"), workspace("trip", "ready")],
  });
  assert.equal(catchUpSubline(oneNeed), "1 thing needs you across 2 workspaces.");
  const clear = vm({ workspaces: [workspace("home", "ready"), workspace("trip", "ready")] });
  assert.equal(catchUpSubline(clear), "Nothing needs you right now.");
  assert.equal(catchUpSubline(vm({ workspaces: [workspace("home", "loading")] })), "Checked 0 of 1 workspace.");
});

test("workspace counts omit unknown reads and never invent zero", () => {
  assert.equal(catchUpWorkspaceCountsLine(workspace("home", "ready", { openTodos: 4, lists: 3, files: 3 })),
    "4 open to-dos · 3 lists · 3 files");
  assert.equal(catchUpWorkspaceCountsLine(workspace("home", "ready", { openTodos: 1, lists: null, files: 2 })),
    "1 open to-do · 2 files");
  assert.equal(catchUpWorkspaceCountsLine(workspace("home", "ready", { openTodos: null, lists: null, files: null })), null);
});

test("needs-you preview and latest caps are independent of the builder", () => {
  const items = Array.from({ length: 5 }, (_, index) => needsYou(`n${index}`, `w${index % 2}`));
  assert.equal(catchUpNeedsYouVisible(items, false).length, 3);
  assert.equal(catchUpNeedsYouMoreCount(items, false), 2);
  assert.equal(catchUpNeedsYouMoreCount(items, true), 0);
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: String(index), authorLabel: "Your Claude", workspace: { name: "Home", href: "?w=home" }, excerpt: "Hi", when: "now",
  }));
  assert.equal(catchUpLatestVisible(rows).length, 8);
  const interleaved = [
    { id: "a", authorLabel: "A", workspace: { name: "Home", href: "?w=home" }, excerpt: "one", when: "9:03" },
    { id: "b", authorLabel: "B", workspace: { name: "Trip", href: "?w=trip" }, excerpt: "two", when: "9:02" },
    { id: "c", authorLabel: "C", workspace: { name: "Home", href: "?w=home" }, excerpt: "three", when: "9:01" },
  ];
  const visible = catchUpLatestVisible(interleaved);
  assert.deepEqual(visible.map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual(visible.map((row) => row.workspace.name), ["Home", "Trip", "Home"]);
});

test("new messages since you last looked stays on workspace cards", () => {
  assert.equal(catchUpNewMessagesSinceLastLookedLine(null), null);
  assert.equal(catchUpNewMessagesSinceLastLookedLine(0), null);
  assert.equal(catchUpNewMessagesSinceLastLookedLine(1), "1 new message since you last looked");
  assert.equal(catchUpNewMessagesSinceLastLookedLine(5), "5 new messages since you last looked");
});

test("agent attention line prints nothing when unknown", () => {
  assert.equal(catchUpAgentAttentionLine(null), null);
  assert.equal(catchUpAgentAttentionLine(0), null);
  assert.equal(catchUpAgentAttentionLine(1), "1 agent needs attention");
  assert.equal(catchUpAgentAttentionLine(2), "2 agents need attention");
});

test("workspace check totals count only ready cards as checked", () => {
  const cards = [workspace("a", "loading"), workspace("b", "ready"), workspace("c", "failed"), workspace("d", "open")];
  assert.deepEqual(catchUpWorkspaceCheckTotals(cards), { checked: 1, total: 4, anyFailed: true, anyPending: true });
});

test("date eyebrow names the weekday, month and day from the same clock as the greeting", () => {
  assert.equal(catchUpDateLine("2026-10-05T08:30:00"), "Monday, October 5");
});

test("card footer is one measured line: new messages, then agent attention, then counts", () => {
  const all = workspace("home", "ready", { openTodos: 4, lists: 3, files: 3, agentsNeedingAttention: 1, newMessagesSinceLastLooked: 6 });
  assert.deepEqual(catchUpCardFooter(all), { kind: "since", text: "6 new messages since you last looked" });
  assert.deepEqual(catchUpCardFooter({ ...all, newMessagesSinceLastLooked: 0 }), { kind: "attention", text: "1 agent needs attention" });
  assert.deepEqual(catchUpCardFooter({ ...all, newMessagesSinceLastLooked: null, agentsNeedingAttention: 0 }),
    { kind: "counts", text: "4 open to-dos · 3 lists · 3 files" });
  assert.equal(catchUpCardFooter(workspace("x", "ready")), null);
});
