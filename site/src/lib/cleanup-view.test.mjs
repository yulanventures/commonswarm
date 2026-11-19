import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupAgentRows, cleanupFileRows, confirmNameLines, summaryText } from "./cleanup-view.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const day = 86_400_000;
const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();

test("agent rows: least active first, owner and kind shown, duplicate names told apart by id", () => {
  const rows = cleanupAgentRows([
    { principalId: "aaaaaaaa-1", name: "HezLead", transport: "local", ownerUserId: "u1", lastActiveAt: iso(0) },
    { principalId: "bbbbbbbb-2", name: "hezlead", transport: "hosted_mcp", ownerUserId: "u1", lastActiveAt: iso(9) },
    { principalId: "cccccccc-3", name: "Quiet <b>", transport: "local", ownerUserId: "u2", lastActiveAt: null },
  ], (id) => (id === "u1" ? "Tom" : "Sam"), now);
  assert.deepEqual(rows.map((r) => r.id), ["cccccccc-3", "bbbbbbbb-2", "aaaaaaaa-1"]);
  assert.equal(rows[0].label, "Quiet <b>", "labels are raw text for textContent");
  assert.match(rows[0].detail, /terminal · owner Sam · no activity recorded/);
  assert.match(rows[1].detail, /connected app · owner Tom · active 9 days ago · same name as another agent · id bbbbbbbb/);
  assert.match(rows[2].detail, /active today · same name as another agent · id aaaaaaaa/);
});

test("file rows: live only, filtered by age and by uploaders no longer here, oldest first", () => {
  const files = [
    { fileId: "f1", name: "old.txt", sizeBytes: 4096, uploadedByKind: "agent", uploadedBy: "gone", committedAt: iso(200), tombstonedAt: null },
    { fileId: "f2", name: "new.txt", sizeBytes: 10, uploadedByKind: "user", uploadedBy: "u1", committedAt: iso(2), tombstonedAt: null },
    { fileId: "f3", name: "mid.txt", sizeBytes: 2048, uploadedByKind: "agent", uploadedBy: "here", committedAt: iso(100), tombstonedAt: null },
    { fileId: "f4", name: "dead.txt", sizeBytes: 1, uploadedByKind: "user", uploadedBy: "u1", committedAt: iso(300), tombstonedAt: iso(1) },
  ];
  const name = (kind, id) => (id === "gone" ? null : id === "u1" ? "Tom" : "Builder");
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: false }, name, now).map((r) => r.id), ["f1", "f3", "f2"]);
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 90, uploaderGone: false }, name, now).map((r) => r.id), ["f1", "f3"]);
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: true }, name, now).map((r) => r.id), ["f1"]);
  assert.match(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: true }, name, now)[0].detail, /4 KB · uploaded by an agent no longer here · 200 days ago/);
});

test("confirmations name up to 20 items, and results count every outcome class", () => {
  assert.deepEqual(confirmNameLines(["a", "b"]), ["a", "b"]);
  assert.deepEqual(confirmNameLines(Array.from({ length: 25 }, (_, i) => `n${i}`)).slice(-2), ["n19", "and 5 more"]);
  const results = new Map([["1", "accepted"], ["2", "already_done"], ["3", "unknown"], ["4", "refused"], ["5", "not_attempted"]]);
  assert.equal(summaryText(results), "1 done · 1 already done · 1 refused · 1 outcome unknown · 1 not started");
});

/* A minimal DOM: enough for mountCleanup's own calls. */
class FakeNode {
  constructor(doc, tag) { this.ownerDocument = doc; this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this._text = ""; this.attributes = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ""; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn(); }
  focus() { this.ownerDocument.focused = this; }
  all() { return [this, ...this.children.filter((c) => typeof c !== "string").flatMap((c) => c.all())]; }
  querySelectorAll(selector) {
    const key = selector.replace(/^\[data-|\]$/g, "").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    return this.all().filter((node) => node !== this && key in node.dataset);
  }
}
const fakeDoc = { createElement: (tag) => new FakeNode(fakeDoc, tag) };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const find = (root, key, value) => root.all().find((node) => node.dataset[key] !== undefined && (value === undefined || node.dataset[key] === value));

test("a switch mid-run scrubs at once, starts nothing more and never repaints from late replies", async () => {
  const { mountCleanup } = await import("./cleanup-view.ts");
  const root = new FakeNode(fakeDoc, "div");
  let now = { userId: "u1", workspaceId: "w1" };
  const pending = [];
  let sent = 0;
  const handle = mountCleanup(root, {
    context: () => now,
    agents: () => Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `Agent ${i}`, detail: "terminal" })),
    files: async () => [],
    send: () => { sent++; return new Promise((resolve) => pending.push(resolve)); },
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
  await flush();
  for (const box of root.all().filter((node) => node.dataset.cleanupItem !== undefined)) { box.checked = true; box.fire("change"); }
  find(root, "cleanupAct").fire("click");
  find(root, "cleanupGo").fire("click");
  await flush();
  assert.equal(sent, 4, "four in flight");
  assert.ok(root.textContent.includes("Agent 0"), "the confirmed names are on screen before the switch");

  // Account switch: the dashboard disposes the mount.
  now = { userId: "u2", workspaceId: "w1" };
  handle.dispose();
  assert.equal(root.children.length, 0, "scrubbed at once");
  assert.equal(handle.disposed, true);
  for (const resolve of pending.splice(0)) resolve({ status: 200, body: { status: "accepted" } });
  await flush(); await flush();
  assert.equal(sent, 4, "nothing new was scheduled after the boundary");
  assert.equal(root.children.length, 0, "late replies never repaint");
  handle.dispose();
  assert.equal(root.children.length, 0, "dispose is idempotent");
});

test("the confirmation names its final action, keeps the names and consequence in view, and opens on Back", async () => {
  const { mountCleanup, confirmAction } = await import("./cleanup-view.ts");
  assert.equal(confirmAction("remove_agent", 1), "Remove 1 agent"); assert.equal(confirmAction("remove_agent", 3), "Remove 3 agents");
  assert.equal(confirmAction("tombstone_file", 1), "Remove 1 file"); assert.equal(confirmAction("tombstone_file", 12), "Remove 12 files");

  const root = new FakeNode(fakeDoc, "div");
  let sent = 0;
  mountCleanup(root, {
    context: () => ({ userId: "u1", workspaceId: "w1" }),
    agents: () => Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, label: `Agent ${i}`, detail: "terminal" })),
    files: async () => [],
    send: async () => { sent++; return { status: 200, body: { status: "accepted" } }; },
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
  await flush();
  const boxes = root.all().filter((node) => node.dataset.cleanupItem !== undefined);
  for (const box of boxes.slice(0, 2)) { box.checked = true; box.fire("change"); }
  find(root, "cleanupAct").fire("click");
  const confirm = find(root, "cleanupConfirm"), go = find(root, "cleanupGo"), back = find(root, "cleanupBack");
  assert.equal(confirm.hidden, false);
  assert.equal(go.textContent, "Remove 2 agents", "the button says what it will do, and to how many");
  assert.notEqual(go.textContent, "Confirm");
  assert.equal(fakeDoc.focused, back, "the keyboard starts on the way out, not on the action");
  assert.equal(go.dataset.tone, "danger", "the action is drawn as destructive");
  const tabs = root.all().find((node) => node.children.some((child) => typeof child !== "string" && child.dataset.cleanupTab !== undefined));
  assert.equal(tabs.hidden, true, "the tabs are out of the way during the confirmation");
  // Each chosen name has a line of its own.
  const nameList = confirm.children.find((child) => child.tag === "ul");
  assert.deepEqual(nameList.children.map((line) => line.textContent), ["Agent 0", "Agent 1"]);
  assert.ok(confirm.textContent.includes("Removes each agent from this workspace."), "so does what it does");
  // Back sends nothing and returns to the list.
  back.fire("click");
  await flush();
  assert.equal(confirm.hidden, true); assert.equal(sent, 0);
  assert.equal(tabs.hidden, false, "the tabs come back with the list");
  assert.equal(fakeDoc.focused, find(root, "cleanupAct"), "Back returns the keyboard to the button that opened the confirmation");
});

test("Files: the list leads, the filters sit under one closed Filter that names what is on, and filtering sends nothing", async () => {
  const { mountCleanup } = await import("./cleanup-view.ts");
  const root = new FakeNode(fakeDoc, "div");
  const asked = []; let sent = 0;
  const files = [{ id: "f1", label: "boiler-quote.pdf", detail: "" }, { id: "f2", label: "school-forms.zip", detail: "" }, { id: "f3", label: "IMG_2231.heic", detail: "" }];
  mountCleanup(root, {
    context: () => ({ userId: "u1", workspaceId: "w1" }),
    agents: () => [],
    files: async (filter) => { asked.push({ ...filter }); return filter.uploaderGone ? [] : filter.olderThanDays > 0 ? files.slice(0, 1) : files; },
    send: async () => { sent++; return { status: 200, body: { status: "accepted" } }; },
    newId: () => "x",
  });
  await flush();
  find(root, "cleanupTab", "tombstone_file").fire("click");
  await flush();
  const filter = find(root, "cleanupFilter"), active = find(root, "cleanupFilterActive");
  // One disclosure, closed on entry, before the list; "Filter" is its whole label while nothing is on.
  assert.equal(filter.tag, "details"); assert.notEqual(filter.open, true); assert.equal(filter.hidden, false);
  assert.equal(filter.children[0].tag, "summary"); assert.equal(filter.children[0].textContent, "Filter");
  assert.ok(root.children.indexOf(filter) < root.children.indexOf(find(root, "cleanupList")));
  // The age and uploader controls are inside it.
  assert.ok(filter.all().includes(find(root, "cleanupAge")) && filter.all().includes(find(root, "cleanupUploaderGone")));
  // Check two files, then open and close Filter: the checked files and their count stay, and nothing is reloaded.
  for (const box of root.all().filter((node) => node.dataset.cleanupItem !== undefined).slice(0, 2)) { box.checked = true; box.fire("change"); }
  const counted = () => root.all().find((node) => node.className === "cleanup__count").textContent;
  assert.equal(counted(), "2 selected");
  const loads = asked.length;
  filter.open = true; filter.fire("toggle"); filter.open = false; filter.fire("toggle");
  assert.equal(counted(), "2 selected"); assert.equal(asked.length, loads);
  assert.equal(root.all().filter((node) => node.dataset.cleanupItem !== undefined && node.checked).length, 2);
  // Changing a filter reloads the list and clears the selection, as before; its value is then said beside "Filter".
  const age = find(root, "cleanupAge"); age.value = "90"; age.fire("change");
  await flush();
  assert.deepEqual(asked.at(-1), { olderThanDays: 90, uploaderGone: false });
  assert.equal(counted(), "0 selected");
  assert.equal(active.textContent, " · Older than 90 days");
  assert.equal(filter.children[0].textContent, "Filter · Older than 90 days");
  assert.equal(root.all().filter((node) => node.dataset.cleanupItem !== undefined).length, 1);
  // Nothing matches: the list says so, and the reason stays beside "Filter".
  const gone = find(root, "cleanupUploaderGone"); gone.checked = true; gone.fire("change");
  await flush();
  assert.ok(find(root, "cleanupList").textContent.includes("No files match."));
  assert.equal(active.textContent, " · Older than 90 days · From people or agents no longer here");
  // Clearing both says nothing extra again.
  age.value = "0"; age.fire("change"); gone.checked = false; gone.fire("change");
  await flush();
  assert.equal(active.textContent, "");
  // Filtering never sends a removal.
  assert.equal(sent, 0);
});

test("a delayed file list from a disposed mount never paints, and a new mount starts clean", async () => {
  const { mountCleanup } = await import("./cleanup-view.ts");
  const root = new FakeNode(fakeDoc, "div");
  let release;
  const handle = mountCleanup(root, {
    context: () => ({ userId: "u1", workspaceId: "w1" }),
    agents: () => [],
    files: () => new Promise((resolve) => { release = resolve; }),
    send: async () => ({ status: 200, body: {} }),
    newId: () => "x",
  });
  await flush();
  find(root, "cleanupTab", "tombstone_file").fire("click");
  await flush();
  handle.dispose();
  release([{ id: "f1", label: "old account secret.txt", detail: "" }]);
  await flush(); await flush();
  assert.equal(root.children.length, 0);
  assert.equal(root.textContent.includes("secret"), false);

  const fresh = mountCleanup(root, {
    context: () => ({ userId: "u2", workspaceId: "w1" }),
    agents: () => [{ id: "b1", label: "New account agent", detail: "" }],
    files: async () => [], send: async () => ({ status: 200, body: {} }), newId: () => "y",
  });
  await flush();
  assert.equal(root.textContent.includes("New account agent"), true);
  assert.equal(root.textContent.includes("secret"), false);
  fresh.dispose();
});
