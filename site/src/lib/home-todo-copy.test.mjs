import assert from "node:assert/strict";
import { test } from "node:test";
import { TODO_RESULT_UNKNOWN, TODO_SAVE_FAILED, ordinal, todoAssigneeLabel, todoMetaLine, todoStartChoice, todoStatus, todoSubline,
  whenAt, whenDay, whenStamp } from "./home-todo-copy.ts";
import { todoListOrder } from "./home-todo-list.ts";
import { personNames } from "./home-pickers.ts";

// Wed, Oct 7, 2026, 3:00 pm UTC. Every expected string below is typed from UI-SPEC 3.1 and the rulings.
const ctx = { now: Date.parse("2026-10-07T15:00:00Z"), timeZone: "UTC" };
const state = (over = {}) => ({ kind: "idle", word: "Idle", detail: "Active 2 hours ago", attention: false,
  fix: { action: null, allowed: false, askWho: null, sentence: "" }, ...over });
const agent = (name, over = {}) => ({ id: name.toLowerCase(), name, label: `Your ${name}`, nestedLabel: name, ownerId: "tom", ownerFirstName: "Tom",
  ownerInitial: "T", yours: true, tint: 0, hosted: false, state: state(), ...over });
const tom = { id: "tom", name: "Tom Langridge", firstName: "Tom", initials: "TL", you: true, role: "owner" };
const nikki = { id: "nikki", name: "Nikki Sato", firstName: "Nikki", initials: "NS", you: false, role: "member" };
const claude = agent("Claude");
const muse = agent("Muse", { label: "Nikki’s Muse", ownerId: "nikki", ownerFirstName: "Nikki", ownerInitial: "N", yours: false });
const disconnected = (fix) => agent("dot", { state: state({ kind: "disconnected", word: "Disconnected", detail: "Key turned off", attention: true, fix }) });
const may = { edit: true, assign: true, start: true, reorder: true, complete: true, comment: true };
const todo = (over = {}) => ({ id: "t1", workspaceId: "w1", title: "Book plumber", notes: "", state: "open", addedBy: nikki,
  addedAt: "2026-10-06T18:52:00Z", due: null, assignee: null, start: null, request: null, doneBy: null, doneAt: null, receipt: null,
  sample: false, may, comments: [], tagDelivers: false, ...over });
const toAgent = (a, start) => todo({ assignee: { kind: "agent", agent: a }, start: { position: null, gate: null, at: null, ...start } });

test("ordinals follow English, including the teens", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"]);
});

test("times read the local clock of the given zone and say today, tomorrow or the date", () => {
  assert.equal(whenAt("2026-10-07T21:00:00Z", ctx), "9:00 pm today");
  assert.equal(whenAt("2026-10-08T09:30:00Z", ctx), "9:30 am tomorrow");
  assert.equal(whenAt("2026-10-09T09:00:00Z", ctx), "Fri, Oct 9, 9:00 am");
  assert.equal(whenAt("2027-01-04T12:00:00Z", ctx), "Mon, Jan 4, 2027, 12:00 pm");
  assert.equal(whenAt("2026-10-07T00:05:00Z", ctx), "12:05 am today");
  // The same instant is tomorrow in UTC and still today in Los Angeles (positive and negative arm together).
  assert.equal(whenAt("2026-10-08T03:00:00Z", ctx), "3:00 am tomorrow");
  assert.equal(whenAt("2026-10-08T03:00:00Z", { ...ctx, timeZone: "America/Los_Angeles" }), "8:00 pm today");
  assert.equal(whenStamp("2026-10-07T10:40:00Z", ctx), "10:40 am");
  assert.equal(whenStamp("2026-10-06T18:52:00Z", ctx), "Yesterday, 6:52 pm");
  assert.equal(whenStamp("2026-10-01T18:52:00Z", ctx), "Thu, Oct 1, 6:52 pm");
  assert.equal(whenDay("2026-10-09", ctx), "Fri, Oct 9");
  assert.equal(whenDay("2026-10-07", { ...ctx, timeZone: "Pacific/Kiritimati" }), "yesterday", "a date-only value is a calendar day, not UTC midnight");
  assert.equal(whenAt("not a date", ctx), null); assert.equal(whenStamp("", ctx), null);
});

test("meta line names who added it, when, and the due day; unknown dates are left out", () => {
  assert.equal(todoMetaLine(todo({ due: "2026-10-09" }), ctx), "Added by Nikki yesterday · Due Fri, Oct 9");
  assert.equal(todoMetaLine(todo({ addedBy: tom, addedAt: "2026-10-07T08:00:00Z" }), ctx), "Added by you today");
  assert.equal(todoMetaLine(todo({ addedBy: claude, addedAt: "2026-10-01T08:00:00Z", due: "2026-10-08" }), ctx), "Added by your Claude on Thu, Oct 1 · Due tomorrow");
  assert.equal(todoMetaLine(todo({ addedBy: muse, addedAt: "garbage" }), ctx), "Added by Nikki’s Muse");
});

test("every row of the UI-SPEC 3.1 to-do table, with rulings R4 to R7 and R10", () => {
  const cases = [
    ["agent, in line", toAgent(claude, { mode: "queue", position: 2 }),
      { line: "2nd in line for your Claude.", more: ["Claude picks up work from its line itself."], warning: null }],
    ["start now, with the delivery record and the receive sentence", { ...toAgent(claude, { mode: "now", position: 1 }), receipt: "Delivered" },
      { line: "Moved to the front for your Claude and sent it a message.", more: ["Delivered", "Checks messages when you chat with it."], warning: null }],
    ["not yet, gated on a to-do", toAgent(claude, { mode: "gated", gate: { kind: "todo", todo: { id: "t2", title: "Get quotes", href: "?w=w1&todo=t2", done: false } } }),
      { line: "On hold until ‘Get quotes’ is done or dropped. It stays out of Claude’s line until then, or until someone releases it.", more: [], warning: null }],
    ["not yet, gated on a time", toAgent(claude, { mode: "gated", gate: { kind: "time", at: "2026-10-09T09:00:00Z" } }),
      { line: "On hold until Fri, Oct 9, 9:00 am.", more: [], warning: null }],
    ["not yet, gated on a note", toAgent(claude, { mode: "gated", gate: { kind: "note", note: "waiting on the landlord’s reply" } }),
      { line: "On hold: waiting on the landlord’s reply.", more: [], warning: null }],
    ["at a set time (R4: joins the line, no ping)", toAgent(claude, { mode: "at", at: "2026-10-07T21:00:00Z" }),
      { line: "Joins your Claude’s line at 9:00 pm today.", more: ["Claude sees it the next time it checks."], warning: null }],
    ["person", todo({ assignee: { kind: "person", person: nikki } }),
      { line: "Assigned to Nikki. People have no line order or start time.", more: [], warning: null }],
    ["someone else's agent, request pending (no pronoun is guessed)", { ...toAgent(muse, { mode: "queue" }), request: { status: "pending", ownerFirstName: "Nikki" } },
      { line: "Sent to Nikki as a request. It joins Muse’s line if Nikki accepts.", more: [], warning: null }],
    ["another person, request pending (R6)", todo({ assignee: { kind: "person", person: nikki }, request: { status: "pending", ownerFirstName: "Nikki" } }),
      { line: "Sent to Nikki as a request.", more: ["People have no line order or start time."], warning: null }],
    ["request declined", { ...toAgent(muse, { mode: "queue" }), request: { status: "declined", ownerFirstName: "Nikki" } },
      { line: "Nikki declined. Choose someone else.", more: [], warning: null }],
    ["disconnected assignee, fix not allowed to the viewer", toAgent(disconnected({ action: "new-key", allowed: false, askWho: "Tom", sentence: "Get a new key." }), { mode: "queue", position: 1 }),
      { line: "1st in line for your dot. dot is disconnected (key turned off), so nothing moves until it reconnects.", more: [], warning: "Ask Tom to reconnect it." }],
    ["disconnected assignee, fix allowed", toAgent(disconnected({ action: "new-key", allowed: true, askWho: null, sentence: "Get a new key to bring it back." }), { mode: "queue", position: 1 }),
      { line: "1st in line for your dot. dot is disconnected (key turned off), so nothing moves until it reconnects.", more: [], warning: "Get a new key to bring it back." }],
    ["done", todo({ state: "done", doneBy: claude, doneAt: "2026-10-07T10:40:00Z", assignee: { kind: "agent", agent: claude } }),
      { line: "Done by your Claude · 10:40 am", more: [], warning: null }],
    ["dropped (R5)", todo({ state: "dropped", assignee: { kind: "agent", agent: claude } }), { line: "Dropped.", more: [], warning: null }],
  ];
  for (const [name, value, expected] of cases) assert.deepEqual(todoStatus(value, { ...ctx, receive: "Checks messages when you chat with it." }), expected, name);
  assert.equal(TODO_SAVE_FAILED, "Not saved. Check your connection and try again.");
  assert.equal(TODO_RESULT_UNKNOWN, "The result is unknown. Reload to check.");
});

test("status edges: unknown facts are left out, never invented", () => {
  assert.deepEqual(todoStatus({ ...toAgent(claude, { mode: "now" }), receipt: null }, ctx), { line: "Moved to the front for your Claude.", more: [], warning: null },
    "no notice outcome and no delivery record: no claim that a message went out");
  assert.equal(todoStatus(toAgent(claude, { mode: "queue", position: null }), ctx).line, "In line for your Claude.");
  assert.equal(todoStatus(toAgent(claude, { mode: "gated", gate: null }), ctx).line, "On hold until someone releases it.");
  // The server clears an "after" gate when the dependency is done or dropped, so the line names both.
  assert.equal(todoStatus(toAgent(claude, { mode: "gated", gate: { kind: "todo", todo: { id: "t3", title: "Book the van", href: "?w=w1&todo=t3", done: false } } }), ctx).line,
    "On hold until ‘Book the van’ is done or dropped. It stays out of Claude’s line until then, or until someone releases it.");
  assert.equal(todoStatus(toAgent(claude, { mode: "gated", gate: { kind: "note", note: "Back from the trip?" } }), ctx).line, "On hold: Back from the trip?");
  assert.equal(todoStatus(toAgent(claude, { mode: "at", at: null }), ctx).line, "Joins your Claude’s line at a set time.");
  assert.equal(todoStatus(todo({ state: "done" }), ctx).line, "Done");
  assert.equal(todoStatus(todo({ state: "doing", assignee: { kind: "agent", agent: muse } }), ctx).line, "In Doing for Nikki’s Muse.");
  assert.equal(todoStatus(todo({ assignee: { kind: "person", person: tom } }), ctx).line, "Assigned to you. People have no line order or start time.");
  const waiting = agent("dot", { state: state({ kind: "disconnected", word: "Not picking up", detail: "A message has waited since 10:05 am", attention: true }) });
  assert.equal(todoStatus(toAgent(waiting, { mode: "queue", position: 3 }), ctx).line,
    "3rd in line for your dot. dot is not picking up messages (a message has waited since 10:05 am), so nothing moves until it checks them.");
  const offAt = todoStatus(toAgent(disconnected({ action: null, allowed: false, askWho: null, sentence: "" }), { mode: "at", at: "2026-10-07T21:00:00Z" }), ctx);
  assert.deepEqual(offAt, { line: "Joins your dot’s line at 9:00 pm today. dot is disconnected (key turned off), so nothing moves until it reconnects.",
    more: ["dot sees it the next time it checks."], warning: null });
});

test("no line says the agent starts, and none uses words kept off the screen", () => {
  const values = [toAgent(claude, { mode: "at", at: "2026-10-07T21:00:00Z" }), toAgent(claude, { mode: "now" }), toAgent(muse, { mode: "queue", position: 4 }),
    toAgent(disconnected({ action: null, allowed: false, askWho: "Tom", sentence: "" }), { mode: "gated", gate: { kind: "time", at: "2026-10-09T09:00:00Z" } })];
  const banned = /starts at|\bonline\b|\boffline\b|\bseat\b|\bgrant\b|\btoken\b|\bwake\b|\bturn\b|\bqueue\b/i;
  for (const control of ["Claude starts at 9:00 pm.", "dot is offline.", "3rd in the queue"]) assert.match(control, banned, "positive control");
  for (const value of values) {
    const copy = todoStatus(value, ctx);
    for (const text of [copy.line, ...copy.more, copy.warning ?? "", todoSubline(value, ctx)]) assert.doesNotMatch(text, banned, text);
  }
});

test("sublines for lists and cards", () => {
  assert.equal(todoSubline(toAgent(claude, { mode: "queue", position: 2 }), ctx), "Your Claude · 2nd in line");
  assert.equal(todoSubline(toAgent(disconnected({ action: null, allowed: false, askWho: null, sentence: "" }), { mode: "queue", position: 1 }), ctx), "Your dot · 1st in line · Disconnected");
  assert.equal(todoSubline(toAgent(claude, { mode: "gated" }), ctx), "Your Claude · on hold");
  assert.equal(todoSubline(toAgent(claude, { mode: "at", at: "2026-10-07T21:00:00Z" }), ctx), "Your Claude · joins its line at 9:00 pm today");
  assert.equal(todoSubline(todo({ assignee: { kind: "person", person: nikki } }), ctx), "Nikki");
  assert.equal(todoSubline({ ...toAgent(muse, { mode: "queue" }), request: { status: "pending", ownerFirstName: "Nikki" } }, ctx), "Nikki’s Muse · sent as a request");
  assert.equal(todoSubline({ ...toAgent(muse, { mode: "queue" }), request: { status: "declined", ownerFirstName: "Nikki" } }, ctx), "Nikki declined");
  assert.equal(todoSubline(todo(), ctx), "Not assigned yet");
  assert.equal(todoSubline(todo({ state: "done", doneBy: nikki }), ctx), "Done by Nikki");
  assert.equal(todoSubline(todo({ state: "dropped" }), ctx), "Dropped");
});

test("assignee label on the picker trigger", () => {
  assert.equal(todoAssigneeLabel(todo()), "Not assigned yet");
  assert.equal(todoAssigneeLabel(todo({ assignee: { kind: "person", person: tom } })), "Tom (you)");
  assert.equal(todoAssigneeLabel(todo({ assignee: { kind: "person", person: nikki } })), "Nikki");
  assert.equal(todoAssigneeLabel(todo({ assignee: { kind: "agent", agent: muse } })), "Nikki’s Muse");
});

test("start chips show only for an agent assignee the viewer may steer, with nothing preselected", () => {
  const chosen = todoStartChoice(toAgent(claude, { mode: "gated" }));
  assert.deepEqual(chosen.options.map((option) => option.label), ["When it’s free", "Now", "Not yet", "At a set time"]);
  assert.deepEqual(chosen.options.map((option) => option.value), ["queue", "now", "gated", "at"]);
  assert.equal(chosen.value, "gated");
  assert.equal(todoStartChoice(todo({ assignee: { kind: "agent", agent: claude } })).value, null);
  const hidden = {
    "person": todo({ assignee: { kind: "person", person: nikki } }),
    "no assignee": todo(),
    "pending request": { ...toAgent(muse, { mode: "queue" }), request: { status: "pending", ownerFirstName: "Nikki" } },
    "declined request": { ...toAgent(muse, { mode: "queue" }), request: { status: "declined", ownerFirstName: "Nikki" } },
    "done": { ...toAgent(claude, { mode: "queue" }), state: "done" },
    "dropped": { ...toAgent(claude, { mode: "queue" }), state: "dropped" },
    "no may.start (R7)": { ...toAgent(muse, { mode: "queue" }), may: { ...may, start: false } },
    "sample": { ...toAgent(claude, { mode: "queue" }), sample: true },
  };
  for (const [name, value] of Object.entries(hidden)) assert.equal(todoStartChoice(value), null, name);
});

test("To-dos pane order: open first, done then dropped only under All, input order kept", () => {
  const rows = [["a", "done"], ["b", "open"], ["c", "dropped"], ["d", "doing"], ["e", "done"], ["f", "open"]]
    .map(([id, value]) => ({ todo: todo({ id, state: value }), href: `?todo=${id}` }));
  assert.deepEqual(todoListOrder(rows, "open").map((row) => row.todo.id), ["b", "d", "f"]);
  assert.deepEqual(todoListOrder(rows, "all").map((row) => row.todo.id), ["b", "d", "f", "a", "e", "c"]);
  assert.deepEqual(todoListOrder([], "all"), []);
});

test("Start now says a message was sent only when the notice or a delivery record shows it (SERVER-PLAN A9)", () => {
  const now = toAgent(claude, { mode: "now", position: 1 });
  const receive = "Checks messages when you chat with it.";
  const sentClaim = /sent it a message/;
  assert.match(todoStatus({ ...now, receipt: "Delivered" }, { ...ctx, receive }).line, sentClaim, "positive control: a delivery record");
  assert.deepEqual(todoStatus(now, { ...ctx, receive, notice: "sent" }),
    { line: "Moved to the front for your Claude and sent it a message.", more: [receive], warning: null }, "the write reported the notice as sent");
  const notSent = { line: "Moved to the front for your Claude. The message to it could not be sent.", more: ["Claude sees it the next time it checks."], warning: null };
  assert.deepEqual(todoStatus(now, { ...ctx, receive, notice: "not_sent" }), notSent, "rate limited: the move commits, the message does not");
  assert.deepEqual(todoStatus({ ...now, receipt: "Delivered" }, { ...ctx, receive, notice: "not_sent" }), notSent, "the latest write's outcome wins over an older record");
  for (const notice of [undefined, null]) {
    const copy = todoStatus(now, { ...ctx, receive, notice });
    assert.doesNotMatch(copy.line, sentClaim); assert.deepEqual(copy.more, [], "the receive sentence is about a message, so it goes with the claim");
  }
  const off = toAgent(disconnected({ action: "new-key", allowed: false, askWho: "Tom", sentence: "" }), { mode: "now", position: 1 });
  assert.deepEqual(todoStatus(off, { ...ctx, notice: "not_sent" }), {
    line: "Moved to the front for your dot. The message to it could not be sent. dot is disconnected (key turned off), so nothing moves until it reconnects.",
    more: ["dot sees it the next time it checks."], warning: "Ask Tom to reconnect it." });
});

test("a disconnected agent gets its warning and fix in Doing and in a pending request too", () => {
  const off = disconnected({ action: "new-key", allowed: false, askWho: "Tom", sentence: "" });
  assert.deepEqual(todoStatus(todo({ state: "doing", assignee: { kind: "agent", agent: off } }), ctx), {
    line: "In Doing for your dot. dot is disconnected (key turned off), so nothing moves until it reconnects.", more: [], warning: "Ask Tom to reconnect it." });
  assert.deepEqual(todoStatus(todo({ state: "doing", assignee: { kind: "agent", agent: claude } }), ctx),
    { line: "In Doing for your Claude.", more: [], warning: null }, "positive control: a connected agent in Doing has no warning");
  const museOff = { ...muse, state: state({ kind: "disconnected", word: "Disconnected", detail: "Key turned off", attention: true,
    fix: { action: "new-key", allowed: false, askWho: "Nikki", sentence: "" } }) };
  assert.deepEqual(todoStatus({ ...toAgent(museOff, { mode: "queue" }), request: { status: "pending", ownerFirstName: "Nikki" } }, ctx), {
    line: "Sent to Nikki as a request. It joins Muse’s line if Nikki accepts. Muse is disconnected (key turned off), so nothing moves until it reconnects.",
    more: [], warning: "Ask Nikki to reconnect it." });
  assert.deepEqual(todoStatus({ ...toAgent(museOff, { mode: "queue" }), request: { status: "declined", ownerFirstName: "Nikki" } }, ctx),
    { line: "Nikki declined. Choose someone else.", more: [], warning: null }, "a declined request already asks for someone else");
  assert.equal(todoSubline(todo({ state: "doing", assignee: { kind: "agent", agent: off } }), ctx), "Your dot · in Doing · Disconnected");
  assert.equal(todoSubline(todo({ state: "doing", assignee: { kind: "agent", agent: claude } }), ctx), "Your Claude · in Doing");
  assert.equal(todoSubline({ ...toAgent(museOff, { mode: "queue" }), request: { status: "pending", ownerFirstName: "Nikki" } }, ctx),
    "Nikki’s Muse · sent as a request · Disconnected");
});

test("two people with one first name keep their full names after a pick, in status, meta and sublines", () => {
  const samLee = { id: "sl", name: "Sam Lee", firstName: "Sam", initials: "SL", you: false, role: "member" };
  const samOrtiz = { id: "so", name: "Sam Ortiz", firstName: "Sam", initials: "SO", you: true, role: "member" };
  const names = personNames([{ person: samLee, agents: [] }, { person: samOrtiz, agents: [] }, { person: nikki, agents: [] }]);
  const forLee = todo({ assignee: { kind: "person", person: samLee }, addedBy: samLee });
  assert.equal(todoAssigneeLabel(forLee, names), "Sam Lee");
  assert.equal(todoAssigneeLabel(todo({ assignee: { kind: "person", person: samOrtiz } }), names), "Sam Ortiz (you)");
  assert.equal(todoStatus(forLee, { ...ctx, names }).line, "Assigned to Sam Lee. People have no line order or start time.");
  assert.equal(todoMetaLine(forLee, { ...ctx, names }), "Added by Sam Lee yesterday");
  assert.equal(todoSubline(forLee, { ...ctx, names }), "Sam Lee");
  assert.equal(todoStatus(todo({ assignee: { kind: "person", person: nikki } }), { ...ctx, names }).line, "Assigned to Nikki. People have no line order or start time.",
    "a first name nobody shares stays short");
  assert.equal(todoAssigneeLabel(forLee), "Sam", "control: without the names the first name is all there is");
});

test("a request names its person through the shared-first-name map, for a person and for an agent's owner (UI-SPEC 2.3)", () => {
  const samLee = { id: "sl", name: "Sam Lee", firstName: "Sam", initials: "SL", you: false, role: "member" };
  const samOrtiz = { id: "so", name: "Sam Ortiz", firstName: "Sam", initials: "SO", you: false, role: "member" };
  const names = personNames([{ person: samLee, agents: [] }, { person: samOrtiz, agents: [] }, { person: tom, agents: [] }]);
  const withNames = { ...ctx, names };
  const pending = { status: "pending", ownerFirstName: "Sam" };
  const declined = { status: "declined", ownerFirstName: "Sam" };
  const toLee = (request) => todo({ assignee: { kind: "person", person: samLee }, request });
  assert.equal(todoStatus(toLee(pending), withNames).line, "Sent to Sam Lee as a request.");
  assert.equal(todoStatus(toLee(declined), withNames).line, "Sam Lee declined. Choose someone else.");
  assert.equal(todoSubline(toLee(declined), withNames), "Sam Lee declined");
  const ortizMuse = agent("Muse", { id: "muse-so", label: "Sam Ortiz’s Muse", ownerId: "so", ownerFirstName: "Sam", ownerInitial: "S", yours: false });
  const toMuse = (request) => ({ ...toAgent(ortizMuse, { mode: "queue" }), request });
  assert.equal(todoStatus(toMuse(pending), withNames).line, "Sent to Sam Ortiz as a request. It joins Muse’s line if Sam Ortiz accepts.");
  assert.equal(todoStatus(toMuse(declined), withNames).line, "Sam Ortiz declined. Choose someone else.");
  assert.equal(todoSubline(toMuse(declined), withNames), "Sam Ortiz declined");
  // Controls: a first name nobody shares stays short, and without the map the first name is all there is.
  assert.equal(todoStatus(toMuse(pending), ctx).line, "Sent to Sam as a request. It joins Muse’s line if Sam accepts.");
  const nikkiNames = personNames([{ person: nikki, agents: [muse] }, { person: tom, agents: [] }]);
  assert.equal(todoStatus({ ...toAgent(muse, { mode: "queue" }), request: { status: "declined", ownerFirstName: "Nikki" } }, { ...ctx, names: nikkiNames }).line,
    "Nikki declined. Choose someone else.");
});

test("someone else's agent at a set time names its line once, never a double possessive", () => {
  const line = todoStatus(toAgent(muse, { mode: "at", at: "2026-10-07T21:00:00Z" }), ctx).line;
  assert.equal(line, "Joins Muse’s line at 9:00 pm today.");
  assert.equal(todoStatus(toAgent(muse, { mode: "at", at: null }), ctx).line, "Joins Muse’s line at a set time.");
  const doubled = /’s \S+’s/u;
  assert.match("Joins Nikki’s Muse’s line", doubled, "positive control");
  for (const a of [muse, claude]) for (const mode of ["queue", "now", "gated", "at"]) {
    const copy = todoStatus(toAgent(a, { mode, at: "2026-10-07T21:00:00Z" }), ctx);
    for (const text of [copy.line, ...copy.more]) assert.doesNotMatch(text, doubled, text);
  }
});

test("an open to-do with no assignee has a status line of its own", () => {
  assert.deepEqual(todoStatus(todo(), ctx), { line: "Not assigned yet.", more: [], warning: null });
  assert.deepEqual(todoStatus(todo({ state: "doing" }), ctx), { line: "Not assigned yet.", more: [], warning: null });
});
