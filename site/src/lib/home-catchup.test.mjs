import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catchUpAgentAttentionLine,
  catchUpGreeting,
  catchUpLatestGroups,
  catchUpLatestHeading,
  catchUpLatestVisible,
  catchUpNeedsYouMoreCount,
  catchUpNeedsYouVisible,
  catchUpPeopleSummary,
  catchUpSubline,
  catchUpWorkspaceCheckTotals,
  catchUpWorkspaceCountsLine,
} from "./home-catchup.ts";

const person = (id, firstName, you = false) => ({ id, name: firstName, firstName, initials: firstName[0], you, role: "member" });
const workspace = (id, state, overrides = {}) => ({
  id, name: id, href: `?w=${id}`, peopleSummary: "Just you", capsules: [], openTodos: null, lists: null, files: null,
  agentsNeedingAttention: 0, state, ...overrides,
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
  assert.equal(catchUpSubline(vm({ workspaces: [workspace("home", "loading")] })), "Checked 0 of 1 workspaces.");
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
});

test("latest heading follows ruling R9 per workspace", () => {
  assert.equal(catchUpLatestHeading(), "Latest");
  assert.equal(catchUpLatestHeading({ newMessages: 5, lastSeenAt: "2026-10-04T20:00:00" }), "5 new since you last looked");
  assert.equal(catchUpLatestHeading({ newMessages: 0, lastSeenAt: "2026-10-04T20:00:00" }), "Latest");
  const rows = [
    { id: "1", authorLabel: "Claude", workspace: { name: "Home", href: "?w=home", sinceLastLooked: { newMessages: 3, lastSeenAt: "2026-10-04T22:00:00" } }, excerpt: "Hi", when: "8:12 am" },
    { id: "2", authorLabel: "Muse", workspace: { name: "Summer trip", href: "?w=trip" }, excerpt: "Plans?", when: "7:40 am" },
  ];
  const groups = catchUpLatestGroups(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].heading, "3 new since you last looked");
  assert.equal(groups[1].heading, "Latest");
});

test("agent attention line pluralises independently", () => {
  assert.equal(catchUpAgentAttentionLine(0), null);
  assert.equal(catchUpAgentAttentionLine(1), "1 agent needs attention");
  assert.equal(catchUpAgentAttentionLine(2), "2 agents need attention");
});

test("workspace check totals count only ready cards as checked", () => {
  const cards = [workspace("a", "loading"), workspace("b", "ready"), workspace("c", "failed"), workspace("d", "open")];
  assert.deepEqual(catchUpWorkspaceCheckTotals(cards), { checked: 1, total: 4, anyFailed: true, anyPending: true });
});
