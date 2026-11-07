import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The click paths are lifted from the dashboard source and run against stubs, so the fences tested are the real ones.
const dashboard = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
const file = ts.createSourceFile("dashboard.ts", dashboard.match(/<script>([\s\S]*?)<\/script>/u)[1], ts.ScriptTarget.Latest, true);
function lift(names) {
  const found = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(file)) && !found.has(node.name.getText(file))) found.set(node.name.getText(file), node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of names) assert.ok(found.get(name), name);
  return ts.transpile(names.map(name => `var ${found.get(name).getText(file)};`).join("\n"), { target: ts.ScriptTarget.ES2022 });
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function feedHarness() {
  const sends = []; const paints = []; const refreshes = [];
  const context = {
    session: { user: { id: "zoe" } }, activeWorkspaceId: "W", requestVersion: 1,
    choiceTickets: new Map(), choiceEpoch: 0, choiceErrors: new Map(),
    choiceRows: new Map([["ask", { signalId: "ask", options: [{ id: "ship", label: "Ship" }], answer: null }]]),
    uuid: () => "cmd", renderFeed: () => paints.push(1),
    refreshChoices: (...args) => { refreshes.push(args); return Promise.resolve(); },
    answerChoice: (_session, _id, workspaceId, signalId, optionId) => { const d = deferred(); sends.push({ workspaceId, signalId, optionId, d }); return d.promise; },
  };
  runInNewContext(lift(["choiceTicketLive", "choiceIsPending", "sendChoice"]), context);
  return { context, sends, paints, refreshes };
}

test("a feed click's completion lands only on the account, workspace and request it was made in", async () => {
  const h = feedHarness();
  const pending = h.context.sendChoice("ask", "ship");
  assert.equal(h.context.choiceIsPending("ask"), true);
  h.context.sendChoice("ask", "ship");
  assert.equal(h.sends.length, 1, "a pending ask takes no second click");
  h.sends[0].d.resolve({ ok: true, optionId: "ship" });
  await pending;
  assert.equal(JSON.stringify(h.context.choiceRows.get("ask").answer), JSON.stringify({ optionId: "ship", byViewer: true }));
  assert.equal(JSON.stringify(h.refreshes), JSON.stringify([["W", 1, true]]));

  for (const change of [c => { c.session = { user: { id: "amy" } }; }, c => { c.requestVersion += 1; }, c => { c.activeWorkspaceId = "V"; },
    c => { c.choiceEpoch += 1; c.choiceTickets = new Map(); }]) {
    const s = feedHarness();
    const run = s.context.sendChoice("ask", "ship");
    const paintsBefore = s.paints.length;
    change(s.context);
    assert.equal(s.context.choiceIsPending("ask"), false, "a stale ticket is never pending");
    s.sends[0].d.resolve({ ok: false, message: "That ask was already answered." });
    await run;
    assert.equal(s.paints.length, paintsBefore, "no repaint");
    assert.equal(s.refreshes.length, 0, "no refresh");
    assert.equal(s.context.choiceErrors.size, 0, "no error written");
    assert.equal(s.context.choiceRows.get("ask").answer, null, "no answer written");
  }
});

test("an old feed completion can't clear a newer click on the same ask", async () => {
  const h = feedHarness();
  const first = h.context.sendChoice("ask", "ship");
  h.context.requestVersion += 1; // leave and come back: the first ticket is stale
  const second = h.context.sendChoice("ask", "ship");
  assert.equal(h.sends.length, 2);
  h.sends[0].d.resolve({ ok: false, message: "old" });
  await first;
  assert.equal(h.context.choiceIsPending("ask"), true, "the newer click is still pending");
  assert.equal(h.context.choiceErrors.size, 0);
  h.sends[1].d.resolve({ ok: false, message: "new" });
  await second;
  assert.equal(h.context.choiceErrors.get("ask"), "new");
  assert.equal(h.context.choiceIsPending("ask"), false);
});

function catchUpHarness() {
  const sends = []; const paints = []; const reloads = [];
  const context = {
    session: { user: { id: "zoe" } }, sampleMode: false, catchUpGeneration: 3, homeRoute: { view: "catchup" },
    homeViewerId() { return context.session?.user.id ?? ""; },
    catchUpChoiceTickets: new Map(), catchUpChoiceErrors: new Map(), uuid: () => "cmd",
    renderHomeCatchUp: () => paints.push(1), loadHomeCatchUp: () => { reloads.push(1); return Promise.resolve(); },
    answerChoice: (_session, _id, workspaceId, signalId, optionId) => { const d = deferred(); sends.push({ workspaceId, signalId, optionId, d }); return d.promise; },
  };
  runInNewContext(lift(["catchUpChoiceTicketLive", "catchUpChoiceIsPending", "sendCatchUpChoice"]), context);
  return { context, sends, paints, reloads };
}
const item = { id: "ask", workspace: { id: "W" } };

test("a Waiting on you click reloads Catch up on success and changes nothing once stale", async () => {
  const h = catchUpHarness();
  const run = h.context.sendCatchUpChoice(item, "ship");
  assert.deepEqual([h.sends[0].workspaceId, h.sends[0].signalId, h.sends[0].optionId], ["W", "ask", "ship"]);
  assert.equal(h.context.catchUpChoiceIsPending("ask"), true);
  h.sends[0].d.resolve({ ok: true, optionId: "ship" });
  await run;
  assert.equal(h.reloads.length, 1);

  for (const change of [c => { c.session = { user: { id: "amy" } }; }, c => { c.catchUpGeneration += 1; }, c => { c.homeRoute = { view: "chat" }; }]) {
    const s = catchUpHarness();
    const stale = s.context.sendCatchUpChoice(item, "ship");
    const paintsBefore = s.paints.length;
    change(s.context);
    assert.equal(s.context.catchUpChoiceIsPending("ask"), false);
    s.sends[0].d.resolve({ ok: false, message: "refused" });
    await stale;
    assert.deepEqual([s.paints.length, s.reloads.length, s.context.catchUpChoiceErrors.size], [paintsBefore, 0, 0]);
  }
});
