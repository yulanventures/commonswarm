import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CHOICE_ANSWER_FAILED } from "./choices.ts";

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
const SHIP = { optionIds: ["ship"], otherText: null };

function feedHarness(state = { signalId: "ask", multi: false, options: [{ id: "ship", label: "Ship" }], answer: null }) {
  const sends = []; const paints = []; const refreshes = [];
  const context = {
    session: { user: { id: "zoe" } }, activeWorkspaceId: "W", requestVersion: 1,
    choiceTickets: new Map(), choiceEpoch: 0, choiceErrors: new Map(), choiceDrafts: new Map(),
    choiceRows: new Map([["ask", state]]), CHOICE_ANSWER_FAILED,
    document: { activeElement: null, body: {} }, CSS: { escape: value => value }, Element: class {},
    window: { requestAnimationFrame: fn => fn() }, queueMicrotask, one: () => null,
    uuid: () => "cmd", renderFeed: () => paints.push(1),
    refreshChoices: (...args) => { refreshes.push(args); return Promise.resolve(); },
    answerChoice: (_session, _id, workspaceId, signalId, multi, submission) => { const d = deferred(); sends.push({ workspaceId, signalId, multi, submission, d }); return d.promise; },
  };
  runInNewContext(lift(["choiceTicketLive", "choiceIsPending", "choiceDraftKey", "sendChoice"]), context);
  return { context, sends, paints, refreshes };
}

test("a feed answer's completion lands only on the account, workspace and request it was made in", async () => {
  const h = feedHarness();
  h.context.choiceDrafts.set(h.context.choiceDraftKey("W", "ask"), { selected: [], otherOpen: true, otherText: "draft" });
  const pending = h.context.sendChoice("ask", SHIP);
  assert.equal(h.context.choiceIsPending("ask"), true);
  h.context.sendChoice("ask", { optionIds: [], otherText: "again" });
  assert.equal(h.sends.length, 1, "a pending ask takes no second answer, Other included");
  assert.equal(JSON.stringify(h.sends[0].submission), JSON.stringify(SHIP));
  h.sends[0].d.resolve({ ok: true, optionIds: ["ship"], otherText: null });
  await pending;
  assert.equal(JSON.stringify(h.context.choiceRows.get("ask").answer),
    JSON.stringify({ optionId: "ship", optionIds: ["ship"], otherText: null, byViewer: true, actorUserId: "zoe", at: null }),
    "the chooser is the account the server accepted; the time waits for the read");
  assert.equal(h.context.choiceDrafts.size, 0, "an accepted answer clears the draft");
  assert.equal(JSON.stringify(h.refreshes), JSON.stringify([["W", 1, true]]));

  for (const change of [c => { c.session = { user: { id: "amy" } }; }, c => { c.requestVersion += 1; }, c => { c.activeWorkspaceId = "V"; },
    c => { c.choiceEpoch += 1; c.choiceTickets = new Map(); }]) {
    const s = feedHarness();
    const run = s.context.sendChoice("ask", SHIP);
    const paintsBefore = s.paints.length;
    change(s.context);
    assert.equal(s.context.choiceIsPending("ask"), false, "a stale ticket is never pending");
    s.sends[0].d.resolve({ ok: false, status: 409, error: "ask_answered", message: "This ask already has an answer." });
    await run;
    assert.equal(s.paints.length, paintsBefore, "no repaint");
    assert.equal(s.refreshes.length, 0, "no refresh");
    assert.equal(s.context.choiceErrors.size, 0, "no error written");
    assert.equal(s.context.choiceRows.get("ask").answer, null, "no answer written");
  }
});

test("a refused answer keeps the draft and says why beside the card; a thrown send reads as a neutral line", async () => {
  const h = feedHarness({ signalId: "ask", multi: true, options: [{ id: "ship", label: "Ship" }, { id: "wait", label: "Wait" }], answer: null });
  const key = h.context.choiceDraftKey("W", "ask");
  h.context.choiceDrafts.set(key, { selected: ["ship"], otherOpen: true, otherText: "and later" });
  const run = h.context.sendChoice("ask", { optionIds: ["ship"], otherText: "and later" });
  assert.equal(h.sends[0].multi, true);
  h.sends[0].d.resolve({ ok: false, status: 400, error: "invalid_request", message: "This kind of answer can't be sent here yet." });
  await run;
  assert.equal(h.context.choiceErrors.get("ask"), "This kind of answer can't be sent here yet.");
  assert.equal(h.context.choiceDrafts.get(key).otherText, "and later");
  assert.equal(h.context.choiceRows.get("ask").answer, null);
  assert.equal(h.context.choiceIsPending("ask"), false, "the rows work again for a retry");

  const t = feedHarness();
  t.context.answerChoice = () => Promise.reject(new Error("offline"));
  await t.context.sendChoice("ask", SHIP);
  assert.equal(t.context.choiceErrors.get("ask"), CHOICE_ANSWER_FAILED);

  const answered = feedHarness({ signalId: "ask", multi: false, options: [], answer: { optionId: "ship", optionIds: ["ship"], otherText: null, byViewer: false, actorUserId: null, at: null } });
  await answered.context.sendChoice("ask", SHIP);
  assert.equal(answered.sends.length, 0, "an answered ask sends nothing");
});

test("an old feed completion can't clear a newer answer on the same ask", async () => {
  const h = feedHarness();
  const first = h.context.sendChoice("ask", SHIP);
  h.context.requestVersion += 1; // leave and come back: the first ticket is stale
  const second = h.context.sendChoice("ask", SHIP);
  assert.equal(h.sends.length, 2);
  h.sends[0].d.resolve({ ok: false, status: 409, error: "x", message: "old" });
  await first;
  assert.equal(h.context.choiceIsPending("ask"), true, "the newer answer is still pending");
  assert.equal(h.context.choiceErrors.size, 0);
  h.sends[1].d.resolve({ ok: false, status: 409, error: "x", message: "new" });
  await second;
  assert.equal(h.context.choiceErrors.get("ask"), "new");
  assert.equal(h.context.choiceIsPending("ask"), false);
});

function catchUpHarness() {
  const sends = []; const paints = []; const reloads = [];
  const context = {
    session: { user: { id: "zoe" } }, sampleMode: false, catchUpGeneration: 3, homeRoute: { view: "catchup" },
    homeViewerId() { return context.session?.user.id ?? ""; }, activeWorkspaceId: "W", CHOICE_ANSWER_FAILED,
    catchUpChoiceTickets: new Map(), catchUpChoiceErrors: new Map(), choiceDrafts: new Map(), uuid: () => "cmd",
    renderHomeCatchUp: () => paints.push(1), loadHomeCatchUp: () => { reloads.push(1); return Promise.resolve(); },
    answerChoice: (_session, _id, workspaceId, signalId, multi, submission) => { const d = deferred(); sends.push({ workspaceId, signalId, multi, submission, d }); return d.promise; },
  };
  runInNewContext(lift(["choiceDraftKey", "catchUpChoiceTicketLive", "catchUpChoiceIsPending", "sendCatchUpChoice"]), context);
  return { context, sends, paints, reloads };
}
const item = { id: "ask", workspace: { id: "W" }, choices: { options: [{ id: "ship", label: "Ship" }], multi: false } };

test("a Waiting on you answer reloads Catch up on success and changes nothing once stale", async () => {
  const h = catchUpHarness();
  h.context.choiceDrafts.set(h.context.choiceDraftKey("W", "ask"), { selected: [], otherOpen: true, otherText: "x" });
  const run = h.context.sendCatchUpChoice(item, SHIP);
  assert.deepEqual([h.sends[0].workspaceId, h.sends[0].signalId, h.sends[0].multi], ["W", "ask", false]);
  assert.equal(h.context.catchUpChoiceIsPending("ask"), true);
  h.sends[0].d.resolve({ ok: true, optionIds: ["ship"], otherText: null });
  await run;
  assert.equal(h.reloads.length, 1);
  assert.equal(h.context.choiceDrafts.size, 0);

  for (const change of [c => { c.session = { user: { id: "amy" } }; }, c => { c.catchUpGeneration += 1; }, c => { c.homeRoute = { view: "chat" }; }]) {
    const s = catchUpHarness();
    const stale = s.context.sendCatchUpChoice(item, SHIP);
    const paintsBefore = s.paints.length;
    change(s.context);
    assert.equal(s.context.catchUpChoiceIsPending("ask"), false);
    s.sends[0].d.resolve({ ok: false, status: 409, error: "x", message: "refused" });
    await stale;
    assert.deepEqual([s.paints.length, s.reloads.length, s.context.catchUpChoiceErrors.size], [paintsBefore, 0, 0]);
  }
});
