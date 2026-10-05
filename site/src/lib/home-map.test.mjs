import assert from "node:assert/strict";
import { test } from "node:test";
import { homeBootRoute, resolveHomeRoute, homeViewTitle, mapHomePeople, mapHomeRail,
  initialCatchUpData, mapCatchUp, fillCatchUpDetails, overviewCatchUpData, homeOverviewUnavailable, homeObjectState, catchUpDetailFromOverview, homeNotFound, homeFileCount } from "./home-map.ts";
const now = Date.parse("2026-10-05T12:00:00Z");
const workspaces = [{ id: "W", name: "Home" }, { id: "X", name: "Trip" }];
const input = { viewerId: "zoe", now, sample: false, access: [], signals: [],
  members: [{ userId: "amy", name: "Amy", role: "member" }, { userId: "zoe", name: "Zoe", role: "owner" }],
  agents: [{ principalId: "A", name: "Claude", ownerUserId: "zoe", transport: "hosted_mcp" },
    { principalId: "B", name: "Muse", ownerUserId: "amy", transport: "hosted_mcp" },
    { principalId: "C", name: "Echo", ownerUserId: "gone" }] };

test("boot chooses the only workspace; foreign and missing addresses never select a foreign object", () => {
  assert.deepEqual(homeBootRoute(workspaces), { view: "catchup" });
  assert.deepEqual(resolveHomeRoute("", workspaces.slice(0, 1)), { view: "chat", workspaceId: "W" });
  assert.deepEqual(resolveHomeRoute("?w=foreign&todo=T", workspaces), { view: "catchup" });
  assert.deepEqual(resolveHomeRoute("?w=foreign&agent=A", workspaces.slice(0, 1)), { view: "chat", workspaceId: "W" });
  assert.deepEqual(resolveHomeRoute("?w=W&todo=missing", workspaces), { view: "todo", workspaceId: "W", todoId: "missing" });
  assert.deepEqual(resolveHomeRoute("?w=W&c=C&m=M", workspaces), { view: "chat", workspaceId: "W", channelId: "C", messageId: "M" });
  assert.equal(homeViewTitle({ view: "files", workspaceId: "W" }, "Home"), "Files · Home · CommonSwarm");
});
test("mapping groups the viewer first and preserves agent ownership and unknown activity", () => {
  const people = mapHomePeople(input);
  assert.deepEqual(people.groups.map(group => group.person.id), ["zoe", "amy"]);
  assert.equal(people.groups[0].agents[0].label, "Your Claude");
  assert.equal(people.groups[1].agents[0].label, "Amy’s Muse");
  assert.equal(people.other[0].label, "Echo (owner left)");
  assert.equal(people.groups[0].agents[0].state.detail, "No activity reported yet");
  const work = { id: "claim", from: "A", fromKind: "agent", kind: "working-on", body: "Budget", until: "2026-10-06T12:00:00Z", createdAt: "2026-10-05T11:59:00Z" };
  assert.equal(mapHomePeople({ ...input, signals: [work] }).groups[0].agents[0].state.word, "Working");
});
test("rail badges require measured counts for every workspace", () => {
  const vm = mapHomeRail(workspaces, { view: "catchup" }, null, false, new Map([["W", 2]]));
  assert.equal(vm.catchUp.needsYou, null);
  assert.equal(vm.workspaces[1].needsYou, null);
  assert.equal(mapHomeRail(workspaces, { view: "catchup" }, null, false, new Map([["W", 2], ["X", 0]])).catchUp.needsYou, 2);
});
test("Catch up renders membership cards immediately and never converts unknown counts into zero", () => {
  const initial = initialCatchUpData(Array.from({ length: 10 }, (_, id) => ({ id: String(id), name: "Workspace " + id })));
  const vm = mapCatchUp(initial, "zoe", "Zoe", now, false);
  assert.deepEqual(vm.workspaces.map(card => card.state), ["loading", "loading", "loading", "loading", "loading", "loading", "loading", "loading", "open", "open"]);
  assert.ok(vm.workspaces.every(card => card.openTodos === null && card.lists === null && card.files === null && card.agentsNeedingAttention === null));
  const detail = { people: mapHomePeople(input), signals: [], openTodos: null, lists: null, files: 0, newMessages: null };
  const filled = mapCatchUp([{ ...initial[0], state: "ready", detail }], "zoe", "Zoe", now, false);
  assert.equal(filled.workspaces[0].files, 0);
  assert.equal(filled.workspaces[0].openTodos, null);
  assert.equal(filled.emptySummary, "Checked 1 of 1 workspace.", "a loaded fallback is not an unchecked workspace or an all-clear");
  const complete = mapCatchUp([{ ...initial[0], state: "ready", detail: { ...detail, needsYou: [] } }], "zoe", "Zoe", now, false);
  assert.equal(complete.emptySummary, null, "a complete overview may show the all-clear empty state");
});
test("fan-out checks only eight workspaces and limits pending reads to three, including failures", async () => {
  const initial = initialCatchUpData(Array.from({ length: 10 }, (_, id) => ({ id: String(id), name: String(id) })));
  const pending = []; const seen = []; const updates = []; let active = 0; let maximum = 0;
  const run = fillCatchUpDetails(initial, workspace => {
    seen.push(workspace.id); maximum = Math.max(maximum, ++active);
    return new Promise((resolve, reject) => pending.push(() => { --active;
      workspace.id === "1" ? reject(new Error("failed")) : resolve({ people: { groups: [], other: [], title: "People & agents" }, signals: [], openTodos: null, lists: null, files: null, newMessages: null }); }));
  }, entry => updates.push(entry));
  assert.deepEqual(seen, ["0", "1", "2"]);
  while (pending.length) { pending.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  await run;
  assert.equal(maximum, 3); assert.equal(active, 0);
  assert.deepEqual(seen, ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(updates.length, 8); assert.equal(updates.find(entry => entry.workspace.id === "1").state, "failed");
});
test("the overview cannot add a foreign workspace and missing content remains unknown", () => {
  const row = { workspace_id: "W", name: "Home", role: "owner", last_seen_at: null, new_messages: 4,
    content: null, people: [], needs_you: { asks: [], assigned: [], waiting: [] } };
  const data = overviewCatchUpData(initialCatchUpData(workspaces), { viewer_user_id: "zoe", generated_at: new Date(now).toISOString(), workspaces: [row, { ...row, workspace_id: "foreign" }] }, false);
  assert.deepEqual(data.map(entry => entry.workspace.id), ["W", "X"]);
  assert.equal(data[1].state, "failed"); assert.equal(data[0].detail.newMessages, null);
  assert.equal(data[0].detail.openTodos, null);
});

test("only a missing overview RPC allows silent fallback, never a refusal or outage", () => {
  for (const [status, code] of [[404, undefined], [400, "PGRST202"], [400, "42883"]]) assert.equal(homeOverviewUnavailable(status, code), true);
  for (const [status, code] of [[200, undefined], [401, "unauthenticated"], [403, "42501"], [500, "XX000"]]) assert.equal(homeOverviewUnavailable(status, code), false);
});

test("an object link distinguishes a failed read from confirmed absence in its own workspace", () => {
  assert.equal(homeObjectState("missing", [], "pending"), "checking");
  assert.equal(homeObjectState("missing", [], "failed"), "failed");
  assert.equal(homeObjectState("A", ["A"], "ready"), "found");
  assert.equal(homeObjectState("foreign", ["A"], "ready"), "missing");
});

test("successful fallback reads, failed checks, and overflow workspaces have honest summaries", () => {
  const detail = { people: mapHomePeople(input), signals: [], openTodos: null, lists: null, files: null, newMessages: null };
  assert.equal(mapCatchUp(workspaces.map(workspace => ({ workspace, state: "ready", detail })), "zoe", "Zoe", now, false).emptySummary, "Checked 2 of 2 workspaces.");
  assert.equal(mapCatchUp([{ workspace: workspaces[0], state: "ready", detail }, { workspace: workspaces[1], state: "failed" }], "zoe", "Zoe", now, false).emptySummary, "Checked 1 of 2 workspaces.");
  const entries = initialCatchUpData(Array.from({ length: 10 }, (_, id) => ({ id: String(id), name: String(id) })))
    .map(entry => entry.state === "loading" ? { ...entry, state: "ready", detail: { ...detail, needsYou: [] } } : entry);
  assert.equal(mapCatchUp(entries, "zoe", "Zoe", now, false).emptySummary, "Checked 8 of 8 workspaces.");
});
const overviewRow = { workspace_id: "W", name: "Home", role: "owner", last_seen_at: null, new_messages: 0, content: null,
  people: [{ user_id: "zoe", display_name: "Zoe", role: "owner", is_viewer: true, agents: [] },
    { user_id: "amy", display_name: "Amy", role: "member", is_viewer: false, agents: [] }],
  needs_you: { asks: [{ signal_id: "ask", from: { kind: "user", id: "amy" }, created_at: "2026-10-05T11:59:00Z", until: "2026-10-06T12:00:00Z" }], assigned: [], waiting: [] } };
test("overview asks use their immutable body; missing author/body never fabricates a preview", () => {
  const message = { id: "ask", kind: "ask", from: "amy", fromKind: "user", body: "<img> Call the plumber?", createdAt: "2026-10-05T11:59:00Z" };
  const detail = catchUpDetailFromOverview(overviewRow, "zoe", now, false, [message]);
  assert.equal(detail.needsYou[0].what, "Amy asked you: ‘<img> Call the plumber?’");
  assert.equal(detail.needsYou[0].from.id, "amy");
  assert.equal(detail.needsYou[0].primary.href, "/app?w=W&m=ask");
  assert.equal(detail.needsYouComplete, true);
  const incomplete = catchUpDetailFromOverview(overviewRow, "zoe", now, false);
  assert.deepEqual(incomplete.needsYou, []);
  assert.equal(incomplete.needsYouComplete, false);
});
test("overview to-do references without assignment authors never name the reader as sender or claim all-clear", () => {
  const row = { ...overviewRow, needs_you: { asks: [], assigned: [{ todo_id: "T", title: "Call plumber", state: "open", due_on: null }], waiting: [] } };
  const detail = catchUpDetailFromOverview(row, "zoe", now, false);
  assert.deepEqual(detail.needsYou, []);
  assert.equal(detail.needsYouComplete, false);
  assert.equal(mapCatchUp([{ workspace: workspaces[0], state: "ready", detail }], "zoe", "Zoe", now, false).emptySummary, "Checked 1 of 1 workspace.");
});
test("overview credentials retain each measured fault and last activity without an access or presence row", () => {
  const facts = { transport: "hosted_mcp", turn_only: true, last_activity_at: "2026-10-05T10:00:00Z", messages_waiting_since: null, doing: null, working_on: null };
  for (const [connection, detail, action] of [["removed", "Removed", null], ["key_off", "Key turned off", "new-key"], ["key_ended", "Key ended", "new-key"], ["paused", "Paused: unused for 14 days", "resume"], ["live", "Active 2 hours ago", null]]) {
    const people = mapHomePeople({ ...input, agents: [{ ...input.agents[0], work: { work: "idle", facts: { ...facts, connection } } }] });
    const state = people.groups[0].agents[0].state;
    assert.equal(state.word, connection === "live" ? "Idle" : "Disconnected");
    assert.equal(state.detail, detail);
    assert.equal(state.fix.action, action);
  }
});
test("confirmed not-found links use the exact Home copy and Catch up address; removed files never count as current files", () => {
  assert.deepEqual(homeNotFound(), { heading: "Nothing with this link in Home.", label: "Home", href: "/app?v=catchup" });
  assert.equal(homeFileCount([{ tombstonedAt: null }, { tombstonedAt: "2026-10-05" }]), 1);
  assert.equal(homeFileCount([]), 0);
  assert.equal(homeFileCount(Array.from({ length: 500 }, () => ({ tombstonedAt: "2026-10-05" }))), null);
});

// Exercise the real optional read with a transport double: no client init, network, or credentials.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
test("live Catch up keeps a successful overview when ask previews fail, without claiming all-clear", async () => {
  const dashboard = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const file = ts.createSourceFile("dashboard.ts", dashboard.match(/<script>([\s\S]*?)<\/script>/u)[1], ts.ScriptTarget.Latest, true);
  let loader;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "loadHomeCatchUp") loader = node;
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(loader);
  const script = ts.transpile(`const ${loader.getText(file)}; loadHomeCatchUp();`, { target: ts.ScriptTarget.ES2022 });
  const row = { ...overviewRow, content: { open_todos: 4, lists: 3, files: 2 } };
  const overview = { viewer_user_id: "zoe", generated_at: new Date(now).toISOString(), workspaces: [row] };
  const ask = { id: "ask", kind: "ask", from: "amy", fromKind: "user", body: "Call the plumber?", createdAt: "2026-10-05T11:59:00Z" };
  const latest = { id: "note", kind: "note", from: "amy", fromKind: "user", body: "Quotes arrived.", until: null, createdAt: "2026-10-05T11:58:00Z" };
  const outcomes = [null, Object.assign(new Error("Read failed"), { status: 500 }),
    new DOMException("Deadline", "TimeoutError"), new TypeError("Failed to fetch")];
  for (const failure of outcomes) {
    const paints = []; const reads = [];
    const context = { catchUpGeneration: 0, homeRoute: { view: "catchup" }, homeViewerId: () => "zoe",
      sampleMode: false, catchUpExpanded: false, catchUpData: [], workspaces: workspaces.slice(0, 1),
      homeOverviewCounts: new Map(), Date: { now: () => now, parse: Date.parse },
      initialCatchUpData, overviewCatchUpData, mapCatchUp, fillCatchUpDetails, catchUpDetailFromOverview,
      homeOverview: async () => overview,
      homeOverviewAsks: async (workspaceId, ids) => {
        reads.push("asks"); assert.equal(workspaceId, "W"); assert.deepEqual(Array.from(ids), ["ask"]);
        if (failure) throw failure;
        return [ask];
      },
      feed: async (workspaceId, limit) => {
        reads.push("latest"); assert.equal(workspaceId, "W"); assert.equal(limit, 50); return [latest];
      },
      renderHomeCatchUp: () => paints.push(mapCatchUp(context.catchUpData, "zoe", "Zoe", now, false)),
    };
    await runInNewContext(script, context);
    assert.equal(paints[0].workspaces[0].state, "loading", "membership cards paint before detail reads");
    assert.ok(paints.slice(1).every(vm => vm.workspaces[0].state === "ready"), "a preview failure cannot discard a loaded overview");
    const vm = paints.at(-1);
    assert.equal(vm.workspaces[0].peopleSummary, "You and Amy");
    assert.deepEqual([vm.workspaces[0].openTodos, vm.workspaces[0].lists, vm.workspaces[0].files], [4, 3, 2]);
    assert.deepEqual(reads, ["asks", "latest"], "both positive and failed previews reach the real loading path");
    assert.equal(vm.latest[0].excerpt, "Quotes arrived.");
    assert.equal(context.homeOverviewCounts.get("W"), 1);
    assert.equal(context.catchUpData[0].detail.needsYouComplete, failure === null);
    assert.deepEqual(vm.needsYou.map(item => item.what), failure ? [] : ["Amy asked you: ‘Call the plumber?’"]);
    assert.equal(vm.emptySummary, failure ? "Checked 1 of 1 workspace." : null);
  }
});
test("optional working-on reads keep loaded chat usable on returned errors, timeouts and thrown network errors", async () => {
  const source = readFileSync(new URL("./commonswarm.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "homeWorkingOn");
  assert.ok(declaration);
  const script = ts.transpile(declaration.getText(file).replace(/^export /u, ""), { target: ts.ScriptTarget.ES2022 });
  let calls = 0;
  for (const outcome of [{ data: [{ id: "claim" }], error: null }, { data: null, error: { code: "42501" } }, new DOMException("Deadline", "TimeoutError"), new TypeError("Failed to fetch")]) {
    const read = runInNewContext(script + ";homeWorkingOn", { client: () => ({}), Date, BROWSER_SIGNAL_COLUMNS: "signal_id", browserSignalFromRow: row => row,
      readWithDeadline: async () => { ++calls; if (outcome instanceof Error) throw outcome; return outcome; } });
    const result = await read("W");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), outcome.data?.length ? [{ id: "claim" }] : []);
  }
  assert.equal(calls, 4, "positive and negative controls all reach the status read");
});
