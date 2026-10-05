import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RAIL_OWNERSHIP_NOTE, RAIL_WORKSPACE_CAP, narrowRailPeopleToViewer, needsYouBadge, orderCapsules, orderRailPeople,
  railAgentName, railMoreLabel, railPersonName, railWorkspaceRows,
} from "./home-rail.ts";

const state = (kind, word, detail) => ({ kind, word, detail, attention: kind === "disconnected", fix: { action: null, allowed: false, askWho: null, sentence: "" } });
const person = (id, name, you = false) => ({ id, name, firstName: name.split(" ")[0], initials: name.slice(0, 2).toUpperCase(), you, role: "member" });
const agent = (id, name, owner, overrides = {}) => ({
  id, name, label: name, nestedLabel: name, ownerId: owner?.id ?? null, ownerFirstName: owner && !owner.you ? owner.firstName : null,
  ownerInitial: owner?.name[0] ?? "", yours: !!owner?.you, tint: 0, hosted: false, state: state("idle", "Idle", "Active 2 hours ago"), ...overrides,
});
const workspace = (id, current = false, needsYou = null) => ({ id, name: `Space ${id}`, href: `?w=${id}`, current, needsYou });

const tom = person("tom", "Tom Langridge", true);
const nikki = person("nikki", "Nikki Hale");
const priya = person("priya", "priya Shah");
const marcus = person("marcus", "Marcus Ode");
const people = {
  title: "People & agents",
  groups: [
    { person: priya, agents: [agent("p1", "Claude", priya)] },
    { person: nikki, agents: [agent("n2", "Muse", nikki), agent("n1", "atlas", nikki)] },
    { person: tom, agents: [agent("t2", "dot", tom), agent("t1", "Claude", tom), agent("t3", "Grok", tom)] },
    { person: marcus, agents: [] },
  ],
  other: [agent("o2", "Zed (owner left)", null), agent("o1", "Echo (owner left)", null)],
};

test("the viewer comes first with their agents nested; then others alphabetically; Other agents stay separate and last", () => {
  const ordered = orderRailPeople(people);
  assert.deepEqual(ordered.groups.map((group) => group.person.id), ["tom", "marcus", "nikki", "priya"]);
  assert.deepEqual(ordered.groups[0].agents.map((a) => a.nestedLabel), ["Claude", "dot", "Grok"]);
  assert.deepEqual(ordered.groups[2].agents.map((a) => a.nestedLabel), ["atlas", "Muse"]);
  assert.deepEqual(ordered.other.map((a) => a.id), ["o1", "o2"]);
  assert.equal(ordered.title, "People & agents");
  assert.deepEqual(people.groups.map((group) => group.person.id), ["priya", "nikki", "tom", "marcus"], "the view model is not reordered in place");
  assert.deepEqual(orderCapsules(people.groups).map((group) => group.person.id), ["tom", "marcus", "nikki", "priya"]);
});

test("Catch up narrows the section to you and your own agents", () => {
  const narrowed = narrowRailPeopleToViewer({ ...people, groups: [...people.groups, { person: tom, agents: [agent("x", "Lent", nikki)] }] });
  assert.equal(narrowed.title, "You and your agents");
  assert.deepEqual(narrowed.groups.map((group) => group.person.id), ["tom", "tom"]);
  assert.deepEqual(narrowed.groups.flatMap((group) => group.agents.map((a) => a.id)), ["t2", "t1", "t3"]);
  assert.deepEqual(narrowed.other, []);
});

test("workspaces cap at six behind Show N more, and the current one is never hidden", () => {
  assert.equal(RAIL_WORKSPACE_CAP, 6);
  const nine = Array.from({ length: 9 }, (_, index) => workspace(String(index + 1)));
  const collapsed = railWorkspaceRows(nine, false);
  assert.deepEqual(collapsed.rows.filter((row) => !row.hidden).map((row) => row.workspace.id), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(collapsed.overflowCount, 3);
  assert.equal(railMoreLabel(collapsed.overflowCount, false), "Show 3 more");
  assert.equal(railMoreLabel(collapsed.overflowCount, true), "Show fewer");
  assert.deepEqual(railWorkspaceRows(nine, true).rows.filter((row) => row.hidden), []);

  const currentLate = nine.map((ws) => ({ ...ws, current: ws.id === "8" }));
  const late = railWorkspaceRows(currentLate, false);
  assert.deepEqual(late.rows.filter((row) => !row.hidden).map((row) => row.workspace.id), ["1", "2", "3", "4", "5", "8"],
    "a current workspace past the cap takes the sixth place; six rows show, never seven");
  assert.equal(late.overflowCount, 3);
  assert.equal(railMoreLabel(late.overflowCount, false), "Show 3 more");
  assert.deepEqual(late.rows.map((row) => row.workspace.id), ["1", "2", "3", "4", "5", "6", "7", "8", "9"], "rows keep their order");
  assert.deepEqual(railWorkspaceRows(currentLate, true).rows.filter((row) => row.hidden), []);

  for (let current = 1; current <= 9; current += 1) {
    const marked = nine.map((ws) => ({ ...ws, current: ws.id === String(current) }));
    const { rows, overflowCount } = railWorkspaceRows(marked, false);
    const visible = rows.filter((row) => !row.hidden);
    assert.equal(visible.length, 6, `current ${current}: exactly six rows show`);
    assert.ok(visible.some((row) => row.workspace.current), `current ${current}: the current workspace shows`);
    assert.equal(overflowCount, 3, `current ${current}: the count is every hidden row`);
  }
  const lastOfSeven = railWorkspaceRows(nine.slice(0, 7).map((ws) => ({ ...ws, current: ws.id === "7" })), false);
  assert.deepEqual(lastOfSeven.rows.filter((row) => !row.hidden).map((row) => row.workspace.id), ["1", "2", "3", "4", "5", "7"]);
  assert.equal(lastOfSeven.overflowCount, 1);

  const six = railWorkspaceRows(nine.slice(0, 6), false);
  assert.equal(six.overflowCount, 0);
  assert.equal(railMoreLabel(six.overflowCount, false), null, "six or fewer need no Show more");
  assert.equal(railMoreLabel(0, true), null);
});

test("the needs-you badge shows only a measured count above zero", () => {
  assert.equal(needsYouBadge(null), null, "not measured: no badge");
  assert.equal(needsYouBadge(0), null, "measured zero: nothing needs you, so no badge");
  assert.equal(needsYouBadge(Number.NaN), null);
  assert.equal(needsYouBadge(-1), null);
  assert.deepEqual(needsYouBadge(1), { text: "1", label: "1 needs you" });
  assert.deepEqual(needsYouBadge(2), { text: "2", label: "2 need you" });
  assert.deepEqual(needsYouBadge(140), { text: "99+", label: "140 need you" });
});

test("accessible names carry ownership, the status word and the measured detail", () => {
  assert.equal(railAgentName(agent("n2", "Muse", nikki)), "Muse, Nikki’s agent, Idle, Active 2 hours ago");
  assert.equal(railAgentName(agent("t1", "Claude", tom, { state: state("working", "Working", "Said it’s working on ‘Budget sheet’ · 12 minutes ago") })),
    "Claude, your agent, Working, Said it’s working on ‘Budget sheet’ · 12 minutes ago");
  assert.equal(railAgentName(agent("o1", "Echo (owner left)", null, { state: state("disconnected", "Disconnected", "Key ended") })),
    "Echo (owner left), Disconnected, Key ended");
  assert.equal(railAgentName(agent("x", "dot", tom, { state: state("idle", "Idle", "") })), "dot, your agent, Idle");
  assert.equal(railPersonName(tom), "Tom Langridge (you)");
  assert.equal(railPersonName(nikki), "Nikki Hale");
  assert.equal(railPersonName({ ...nikki, dashed: true }), "Nikki Hale, invited");
});

test("the ownership line is the shipped sentence", () => {
  assert.equal(RAIL_OWNERSHIP_NOTE, "Every agent belongs to a person, who connects it.");
});

test("rail copy uses plain words only", () => {
  const copy = [
    RAIL_OWNERSHIP_NOTE, railMoreLabel(3, false), railMoreLabel(3, true), needsYouBadge(2).label,
    railAgentName(agent("n2", "Muse", nikki)), railPersonName(tom), narrowRailPeopleToViewer(people).title,
  ].join(" ");
  assert.doesNotMatch(copy, /online|offline|seat|grant|token|turn|wake|principal/iu);
});
