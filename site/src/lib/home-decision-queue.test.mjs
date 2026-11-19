import assert from "node:assert/strict";
import { test } from "node:test";
import { createHomeServer, parseDecisionQueue, HomeToolsUnavailable } from "./home/client.ts";
import { ASKS_UNAVAILABLE_ACTION, catchUpDetailFromOverview, homeNeedsYouCount, mapCatchUp } from "./home-map.ts";
import { needsYouCard } from "./home-primitives.ts";
import { catchUpSubline } from "./home-catchup.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { initialCatchUpData, overviewCatchUpData, fillCatchUpDetails, catchUpReadOrder } from "./home-map.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const ask = (id, createdAt, extra = {}) => ({ signal_id: id, from: { kind: "agent", id: "A", name: "Claude" }, body: `Body ${id}`,
  created_at: createdAt, until: "2026-11-05T12:00:00Z", reraised: null, ...extra });
const queue = (asks, extra = {}) => ({ workspace_id: "W", generated_at: "2026-11-04T12:00:00Z", total: asks.length, truncated: false, asks, ...extra });
const row = { workspace_id: "W", name: "Home", role: "owner", last_seen_at: null, new_messages: 0, content: null,
  people: [{ user_id: "zoe", display_name: "Zoe", role: "owner", is_viewer: true, agents: [] },
    { user_id: "amy", display_name: "Amy", role: "member", is_viewer: false, agents: [] }],
  needs_you: { asks: [], assigned: [], waiting: [] } };

const serverWith = rpc => createHomeServer({ user: { id: "zoe" } }, { client: () => ({ schema: name => ({ rpc: (fn, args) => rpc(name, fn, args) }) }) });

test("the client reads swarm_read.decision_queue for one workspace and keeps the server's order", async () => {
  const calls = [];
  const asks = [ask("old", "2026-11-01T09:00:00Z"), ask("mid", "2026-11-03T09:00:00Z", { reraised: { count: 2, last_at: "2026-11-04T08:00:00Z" } }),
    ask("new", "2026-11-04T11:00:00Z", { from: { kind: "user", id: "amy", name: null } })];
  const server = serverWith(async (schema, fn, args) => { calls.push([schema, fn, args]); return { data: queue(asks), error: null }; });
  const result = await server.decisionQueue("W");
  assert.deepEqual(calls, [["swarm_read", "decision_queue", { p_workspace_id: "W" }]]);
  assert.deepEqual(result.asks.map(item => item.signal_id), ["old", "mid", "new"]);
  assert.deepEqual(result.asks[1].reraised, { count: 2, last_at: "2026-11-04T08:00:00Z" });
  assert.equal(await serverWith(async () => ({ data: null, error: null })).decisionQueue("W"), null, "a non-member reads null");
  for (const code of ["PGRST202", "42883"]) {
    await assert.rejects(serverWith(async () => ({ data: null, error: { code } })).decisionQueue("W"), HomeToolsUnavailable);
  }
  await assert.rejects(serverWith(async () => ({ data: null, error: { code: "42501" } })).decisionQueue("W"), /home_decision_queue_failed/);
});

test("decisionQueue keyset-pages past 100 asks via decision_queue_page and stays truncated if any page fails or stops advancing", async () => {
  const makeAsk = n => ask(`ask-${String(n).padStart(3, "0")}`, new Date(Date.parse("2026-11-01T00:00:00Z") + n * 1000).toISOString());
  const all101 = Array.from({ length: 101 }, (_, i) => makeAsk(i + 1));
  const calls = [];
  const pagedServer = serverWith(async (schema, fn, args) => {
    calls.push([schema, fn, args]);
    if (fn === "decision_queue") {
      return { data: queue(all101.slice(0, 100), { total: 101, truncated: true }), error: null };
    }
    if (fn === "decision_queue_page") {
      assert.equal(args.p_after_id, "ask-100");
      assert.equal(args.p_after_created_at, all101[99].created_at);
      return { data: queue(all101.slice(100), { total: 101, truncated: false }), error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  const full = await pagedServer.decisionQueue("W");
  assert.equal(calls.length, 2);
  assert.equal(full.asks.length, 101);
  assert.equal(full.total, 101);
  assert.equal(full.truncated, false);
  assert.equal(full.asks[100].signal_id, "ask-101");

  // Unmigrated server (PGRST202 on decision_queue_page): keeps page 1 with truncated: true (never claims complete).
  const unmigrated = serverWith(async (_schema, fn) => {
    if (fn === "decision_queue") return { data: queue(all101.slice(0, 100), { total: 101, truncated: true }), error: null };
    return { data: null, error: { code: "PGRST202" } };
  });
  const partial = await unmigrated.decisionQueue("W");
  assert.equal(partial.asks.length, 100);
  assert.equal(partial.total, 101);
  assert.equal(partial.truncated, true);

  // Non-advancing cursor guard: stops and keeps truncated: true instead of looping forever.
  let stuckCalls = 0;
  const stuck = serverWith(async (_schema, fn) => {
    stuckCalls += 1;
    if (fn === "decision_queue") return { data: queue(all101.slice(0, 100), { total: 101, truncated: true }), error: null };
    return { data: queue(all101.slice(0, 100), { total: 101, truncated: true }), error: null };
  });
  const stopped = await stuck.decisionQueue("W");
  assert.equal(stuckCalls, 2);
  assert.equal(stopped.truncated, true);
});

test("a malformed queue throws instead of rendering a guess", () => {
  const good = queue([ask("a", "2026-11-01T09:00:00Z")]);
  assert.equal(parseDecisionQueue(good, "W").asks.length, 1);
  const bad = [
    "not an object", { ...good, workspace_id: "other" }, { ...good, asks: {} }, { ...good, total: -1 }, { ...good, total: 0 },
    { ...good, truncated: "no" }, { ...good, generated_at: "yesterday" },
    { ...good, asks: [{ ...good.asks[0], signal_id: 7 }] },
    { ...good, asks: [{ ...good.asks[0], from: { kind: "bot", id: "A", name: null } }] },
    { ...good, asks: [{ ...good.asks[0], from: { kind: "agent", id: "A" } }] },
    { ...good, asks: [{ ...good.asks[0], body: null }] },
    { ...good, asks: [{ ...good.asks[0], created_at: undefined }] },
    { ...good, asks: [{ ...good.asks[0], reraised: { count: 1.5, last_at: "2026-11-04T08:00:00Z" } }] },
    { ...good, asks: [{ ...good.asks[0], reraised: { count: 0, last_at: "2026-11-04T08:00:00Z" } }] },
    { ...good, asks: [{ ...good.asks[0], reraised: undefined }] },
  ];
  for (const data of bad) assert.throws(() => parseDecisionQueue(data, "W"), /home_decision_queue_malformed/, JSON.stringify(data));
});

test("Needs you takes every queued ask oldest first, with waited time and a compact re-raise count", () => {
  const asks = [ask("old", "2026-11-01T09:00:00Z", { reraised: { count: 3, last_at: "2026-11-04T08:00:00Z" } }),
    ask("mid", "2026-11-04T09:00:00Z", { from: { kind: "user", id: "amy", name: "Amy" } }),
    ask("new", "2026-11-04T11:30:00Z", { from: { kind: "user", id: "gone", name: "Former member" } })];
  // The overview's newest-first ten are replaced, not merged.
  const overviewAsk = { signal_id: "new", from: { kind: "user", id: "gone" }, created_at: "2026-11-04T11:30:00Z", until: "2026-11-05T12:00:00Z" };
  const detail = catchUpDetailFromOverview({ ...row, needs_you: { ...row.needs_you, asks: [overviewAsk] } }, "zoe", now, false, [], queue(asks));
  assert.deepEqual(detail.needsYou.map(item => item.id), ["old", "mid", "new"]);
  assert.deepEqual(detail.needsYou.map(item => item.when), ["3 days ago · re-raised ×3", "3 hours ago", "30 minutes ago"]);
  assert.equal(detail.needsYou[0].what, "Claude asked you: ‘Body old’");
  assert.equal(detail.needsYou[1].what, "Amy asked you: ‘Body mid’");
  assert.equal(detail.needsYou[2].what, "Former member asked you: ‘Body new’");
  assert.deepEqual(detail.needsYou[0].primary, { label: "Reply", href: "/app?w=W&m=old" });
  assert.equal(detail.needsYouComplete, true);
  const blank = catchUpDetailFromOverview(row, "zoe", now, false, [], queue([ask("blank", "2026-11-04T11:00:00Z", { body: " \n " })]));
  assert.equal(blank.needsYou[0].what, "Claude asked you.", "an empty body invents no quote");
  const vm = mapCatchUp([{ workspace: { id: "W", name: "Home" }, state: "ready", detail }], "zoe", "Zoe", now, false);
  assert.deepEqual(vm.needsYou.map(item => item.id), ["old", "mid", "new"]);
  const truncated = catchUpDetailFromOverview(row, "zoe", now, false, [], queue(asks, { total: 140, truncated: true }));
  assert.equal(homeNeedsYouCount({ workspace: { id: "W", name: "Home" }, state: "ready", detail: truncated }), 140);
  assert.equal(truncated.needsYouComplete, false);
});

function fakeDocument() {
  const element = tag => {
    const el = { tag, children: [], attrs: {}, dataset: {}, className: "", textContent: "", id: "", title: "",
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener() {},
      get childElementCount() { return this.children.filter(child => typeof child === "object").length; } };
    Object.defineProperty(el, "innerHTML", { set() { throw new Error("innerHTML used"); } });
    return el;
  };
  return { createElement: element };
}

test("a queued ask body renders as text, never markup", () => {
  const body = "<img src=x onerror=alert(1)> approve?";
  const detail = catchUpDetailFromOverview(row, "zoe", now, false, [], queue([ask("x", "2026-11-04T11:00:00Z", { body })]));
  const card = needsYouCard(fakeDocument(), detail.needsYou[0], () => {});
  const find = (node, cls) => node.className === cls ? node : node.children?.map(child => typeof child === "object" ? find(child, cls) : null).find(Boolean);
  assert.equal(find(card, "hm-needs-title").textContent, `Claude asked you: ‘${body}’`);
  assert.equal(find(card, "hm-eyebrow").textContent, "Needs you · Home · 1 hour ago");
});

test("the live Catch up loader takes asks from the queue; when the queue can't be read, asks show as unavailable with Retry, never the overview's list", async () => {
  const dashboard = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const file = ts.createSourceFile("dashboard.ts", dashboard.match(/<script>([\s\S]*?)<\/script>/u)[1], ts.ScriptTarget.Latest, true);
  let loader;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "loadHomeCatchUp") loader = node;
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(loader);
  const script = ts.transpile(`const ${loader.getText(file)}; loadHomeCatchUp();`, { target: ts.ScriptTarget.ES2022 });
  const overviewAsk = { signal_id: "new", from: { kind: "user", id: "amy" }, created_at: "2026-11-04T11:30:00Z", until: "2026-11-05T12:00:00Z" };
  const overview = { viewer_user_id: "zoe", generated_at: new Date(now).toISOString(), workspaces: [{ ...row, needs_you: { ...row.needs_you, asks: [overviewAsk] } }] };
  const load = async (decisionQueue, choiceRows = []) => {
    const paints = []; const reads = []; const choiceReads = [];
    const context = { catchUpGeneration: 0, catchUpChoiceTickets: new Map(), catchUpChoiceErrors: new Map(), ASK_CHOICES_BATCH: 50,
      askChoices: async (workspaceId, ids) => { choiceReads.push([workspaceId, ids]); return choiceRows; }, homeRoute: { view: "catchup" }, homeViewerId: () => "zoe",
      sampleMode: false, catchUpExpanded: false, catchUpData: [], workspaces: [{ id: "W", name: "Home" }],
      homeOverviewCounts: new Map(), Date: { now: () => now, parse: Date.parse },
      initialCatchUpData, overviewCatchUpData, mapCatchUp, fillCatchUpDetails, catchUpReadOrder, catchUpDetailFromOverview, homeNeedsYouCount,
      homeOverview: async () => overview,
      homeServer: () => ({ decisionQueue: async workspaceId => { reads.push(`queue:${workspaceId}`); return decisionQueue(); } }),
      homeOverviewAsks: async () => { reads.push("asks"); return []; },
      feed: async () => [],
      renderHomeCatchUp: () => paints.push(mapCatchUp(context.catchUpData, "zoe", "Zoe", now, false)) };
    await runInNewContext(script, context);
    return { vm: paints.at(-1), reads, choiceReads, count: context.homeOverviewCounts.get("W") };
  };
  const queued = await load(async () => queue([ask("old", "2026-11-01T09:00:00Z"), ask("new", "2026-11-04T11:30:00Z")]));
  assert.deepEqual(queued.reads, ["queue:W"]);
  assert.deepEqual(queued.vm.needsYou.map(item => item.id), ["old", "new"]);
  assert.equal(queued.count, 2);
  assert.deepEqual(queued.choiceReads, [["W", ["old", "new"]]], "the queued asks' stored choices are read once");
  assert.equal(queued.vm.needsYou.some(item => item.choices), false, "no stored choices, no buttons");
  const chosen = await load(async () => queue([ask("old", "2026-11-01T09:00:00Z")]),
    [{ signalId: "old", multi: false, options: [{ id: "ship", label: "Ship it", description: "Today" }, { id: "wait", label: "Wait", recommended: true }], answer: null }]);
  assert.deepEqual(chosen.vm.needsYou[0].choices, { options: [{ id: "ship", label: "Ship it", description: "Today" }, { id: "wait", label: "Wait", recommended: true }], multi: false });
  assert.equal(chosen.count, 1, "choices don't change the count");
  for (const missing of [async () => { throw new HomeToolsUnavailable(); }, async () => null]) {
    const failed = await load(missing);
    assert.deepEqual(failed.reads, ["queue:W"], "no fallback read of the overview's asks");
    assert.deepEqual(failed.vm.needsYou.map(item => item.id), ["W:asks-unavailable"], "never the overview's ask, never empty");
    assert.equal(failed.vm.needsYou[0].primary.label, "Retry");
    assert.equal(failed.vm.needsYou[0].primary.action, ASKS_UNAVAILABLE_ACTION);
    assert.equal(failed.count, null, "an unread queue is an unmeasured count, not zero");
    assert.equal(failed.vm.workspaces[0].state, "ready", "the rest of the workspace still shows");
  }
});

test("an unread queue never shows the overview's asks, and the count is unmeasured", () => {
  const withOverviewAsk = { ...row, needs_you: { ...row.needs_you, asks: [{ signal_id: "legacy", from: { kind: "user", id: "amy" }, created_at: "2026-11-04T11:30:00Z", until: "2026-11-05T12:00:00Z" }] } };
  const detail = catchUpDetailFromOverview(withOverviewAsk, "zoe", now, false, [], "unavailable");
  assert.deepEqual(detail.needsYou.map(item => item.id), [`${row.workspace_id}:asks-unavailable`]);
  assert.equal(detail.needsYouComplete, false);
  assert.equal(detail.measuredNeedsYou, undefined);
});

test("the Retry card isn't counted as a thing that needs you, and unread asks never read as all clear", () => {
  const entry = detail => [{ workspace: { id: "W", name: "Home" }, state: "ready", detail }];
  const unread = mapCatchUp(entry(catchUpDetailFromOverview(row, "zoe", now, false, [], "unavailable")), "zoe", "Zoe", now, false);
  assert.equal(unread.needsYou.length, 1, "the Retry card shows");
  assert.notEqual(catchUpSubline(unread), "Nothing needs you right now.");
  assert.equal(catchUpSubline(unread), "Checked 1 of 1 workspace.");
  const read = mapCatchUp(entry(catchUpDetailFromOverview(row, "zoe", now, false, [], queue([ask("x", "2026-11-04T11:00:00Z")]))), "zoe", "Zoe", now, false);
  assert.equal(catchUpSubline(read), "1 thing needs you across 1 workspace.");
});


test("Waiting on you gives a decision card only to an unanswered ask with stored choices, with descriptions, recommended and multi", () => {
  const options = [{ id: "ship", label: "Ship", description: "Today" }, { id: "wait", label: "Wait", recommended: true }];
  const choices = new Map([["x", { signalId: "x", multi: true, options, answer: null }],
    ["done", { signalId: "done", multi: false, options, answer: { optionId: "ship", optionIds: ["ship"], otherText: null, byViewer: true, actorUserId: null, at: null } }]]);
  const asks = [ask("x", "2026-11-04T11:00:00Z"), ask("done", "2026-11-04T11:00:00Z"), ask("plain", "2026-11-04T11:00:00Z")];
  const detail = catchUpDetailFromOverview(row, "zoe", now, false, [], queue(asks), choices);
  assert.deepEqual(detail.needsYou.map(item => [item.id, item.choices ?? null]), [["x", { options, multi: true }], ["plain", null]],
    "an ask the choices read already shows answered leaves Waiting on you");
  assert.notEqual(detail.needsYou[0].choices.options[0], options[0], "the card gets its own copy of each option");
  const entry = d => ({ workspace: { id: "W", name: "Home" }, state: "ready", detail: d });
  assert.equal(homeNeedsYouCount(entry(detail)), 2, "and leaves the count");
  assert.equal(detail.needsYouComplete, true, "the queue is still fully listed");
  // A truncated queue keeps its unlisted asks in the count; only the known answer comes off.
  const truncated = catchUpDetailFromOverview(row, "zoe", now, false, [], queue(asks, { total: 40, truncated: true }), choices);
  assert.deepEqual([homeNeedsYouCount(entry(truncated)), truncated.needsYouComplete], [39, false]);
  // A failed or missing choices read resolves nothing.
  const unread = catchUpDetailFromOverview(row, "zoe", now, false, [], queue(asks), new Map());
  assert.deepEqual([unread.needsYou.map(item => item.id), homeNeedsYouCount(entry(unread))], [["x", "done", "plain"], 3]);
});

test("a choice ask whose body is prose then a plain question is headed by that question in Waiting on you", () => {
  const options = [{ id: "ship", label: "Ship" }, { id: "wait", label: "Wait" }];
  const body = "All seven Intercom replies are drafted, and two need a refund.\n\nWhich Intercom replies should I send?";
  const choices = new Map([["x", { signalId: "x", multi: true, options, answer: null }]]);
  const what = (asks, read) => catchUpDetailFromOverview(row, "zoe", now, false, [], queue(asks), read).needsYou.map(item => item.what);
  assert.deepEqual(what([ask("x", "2026-11-04T11:00:00Z", { body })], choices), ["Claude asked you: ‘Which Intercom replies should I send?’"]);
  // No choices read, or a body kept whole: the body's start, as before.
  assert.match(what([ask("x", "2026-11-04T11:00:00Z", { body })], new Map())[0], /^Claude asked you: ‘All seven Intercom replies are drafted/u);
  assert.deepEqual(what([ask("x", "2026-11-04T11:00:00Z", { body: "Context.\n\n- a list?" })], choices), ["Claude asked you: ‘Context. - a list?’"]);
  // The question title is never cut to the 160-character excerpt.
  const long = `${"W".repeat(199)}?`;
  assert.deepEqual(what([ask("x", "2026-11-04T11:00:00Z", { body: `Context.\n\n${long}` })], choices), [`Claude asked you: ‘${long}’`]);
  assert.deepEqual(what([ask("x", "2026-11-04T11:00:00Z", { body: long })], choices), [`Claude asked you: ‘${long}’`]);
});
