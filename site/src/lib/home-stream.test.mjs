import assert from "node:assert/strict";
import { test } from "node:test";
import { askExcerpt, authorLabel, dayDividerLabel, dayKey, deriveStreamExtras, groupByDay, isOpenAskToViewer, streamAskCard, streamFileCard, streamTodoCard, todoIdFromAbout } from "./home-stream.ts";

const NOW = Date.parse("2026-10-05T15:00:00Z");
const ID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const workspace = { id: "w", name: "Home", href: "/app?w=w" };
const person = { id: "u1", name: "Nikki Rao", firstName: "Nikki", initials: "NR", you: false, role: "member" };
const claude = { id: "a1", name: "Claude", label: "Your Claude", nestedLabel: "Claude", state: { kind: "idle" }, yours: true };
const signal = (extra = {}) => ({ id: "s1", kind: "ask", body: "Which plumber?", about: null, createdAt: "2026-10-05T14:00:00Z", when: "10:00 am", author: claude,
  addressedToViewer: true, answered: false, attachments: [], ...extra });

test("day labels: today, yesterday, then a short date, by the calendar day in the given zone", () => {
  assert.equal(dayDividerLabel("2026-10-05T01:00:00Z", NOW, "en-US", "UTC"), "Today");
  assert.equal(dayDividerLabel("2026-10-04T23:59:00Z", NOW, "en-US", "UTC"), "Yesterday");
  assert.equal(dayDividerLabel("2026-10-03T12:00:00Z", NOW, "en-US", "UTC"), "Oct 3");
  assert.equal(dayDividerLabel("2025-12-31T12:00:00Z", NOW, "en-US", "UTC"), "Dec 31, 2025");
  assert.equal(dayDividerLabel("2026-10-06T12:00:00Z", NOW, "en-US", "UTC"), "Oct 6");
});

test("the same instant is today in one zone and yesterday in another", () => {
  const instant = "2026-10-05T03:30:00Z";
  assert.equal(dayDividerLabel(instant, NOW, "en-US", "UTC"), "Today");
  assert.equal(dayDividerLabel(instant, NOW, "en-US", "America/Los_Angeles"), "Yesterday");
});

test("yesterday survives a daylight-saving change", () => {
  const now = Date.parse("2026-11-01T18:00:00Z");
  assert.equal(dayDividerLabel("2026-10-31T18:00:00Z", now, "en-US", "America/Los_Angeles"), "Yesterday");
  assert.equal(dayDividerLabel("2026-10-30T18:00:00Z", now, "en-US", "America/Los_Angeles"), "Oct 30");
});

test("the short date follows the locale", () => {
  assert.equal(dayDividerLabel("2026-10-03T12:00:00Z", NOW, "en-GB", "UTC"), "3 Oct");
});

test("a timestamp that is not a date gets no label and no key", () => {
  assert.equal(dayDividerLabel("not a date", NOW, "en-US", "UTC"), null);
  assert.equal(dayKey("", "UTC"), null);
  assert.equal(dayKey("2026-10-05T23:59:59Z", "UTC"), "2026-10-05");
});

test("dividers go before the first message of each day and not between messages of one day", () => {
  const items = [{ createdAt: "2026-10-03T08:00:00Z", n: 1 }, { createdAt: "2026-10-04T09:00:00Z", n: 2 }, { createdAt: "2026-10-04T10:00:00Z", n: 3 },
    { createdAt: "bad", n: 4 }, { createdAt: "2026-10-05T11:00:00Z", n: 5 }];
  const rows = groupByDay(items, NOW, "en-US", "UTC").map((row) => row.type === "divider" ? `[${row.label}]` : String(row.item.n));
  assert.deepEqual(rows, ["[Oct 3]", "1", "[Yesterday]", "2", "3", "4", "[Today]", "5"]);
  assert.deepEqual(groupByDay([], NOW, "en-US", "UTC"), []);
});

test("a to-do reference needs the exact todo:<uuid> shape", () => {
  assert.equal(todoIdFromAbout(`todo:${ID}`), ID);
  assert.equal(todoIdFromAbout(`todo:${ID.toUpperCase()}`), ID);
  for (const about of [null, "", "field trial", `todo:${ID}x`, ` todo:${ID}`, `Todo:${ID}`, "todo:123", `list:${ID}`, `todo:${ID}/extra`]) assert.equal(todoIdFromAbout(about), null, String(about));
});

test("a known to-do becomes a to-do card; an unknown one adds nothing", () => {
  const todos = new Map([[ID, { id: ID, title: "Call the plumber", href: `/app?w=w&todo=${ID}`, meta: "Added by Nikki", who: person, done: false }]]);
  assert.deepEqual(streamTodoCard(`todo:${ID}`, todos), { kind: "todo", id: ID, title: "Call the plumber", href: `/app?w=w&todo=${ID}`, meta: "Added by Nikki", who: person });
  todos.set(ID, { ...todos.get(ID), done: true });
  assert.equal(streamTodoCard(`todo:${ID}`, todos).done, true);
  assert.equal(streamTodoCard("todo:11111111-1111-1111-1111-111111111111", todos), null);
  assert.equal(streamTodoCard("a plain topic", todos), null);
  assert.equal(streamTodoCard(null, todos), null);
});

test("a file attachment becomes a file card with its size", () => {
  const card = streamFileCard({ fileId: "f1", versionN: 2, name: "Quote.pdf", contentType: "application/pdf", sizeBytes: 214_000, href: "/app?w=w&v=files" }, person);
  assert.deepEqual(card, { kind: "file", id: "f1", title: "Quote.pdf", href: "/app?w=w&v=files", meta: "214 KB", who: person });
  assert.equal(streamFileCard({ fileId: "f2", versionN: 1, name: "n.txt", contentType: "text/plain", sizeBytes: 12, href: "#" }).meta, "12 B");
});

test("only an open ask addressed to the viewer becomes a needs-you card", () => {
  assert.equal(isOpenAskToViewer(signal()), true);
  assert.equal(isOpenAskToViewer(signal({ answered: true })), false);
  assert.equal(isOpenAskToViewer(signal({ addressedToViewer: false })), false);
  assert.equal(isOpenAskToViewer(signal({ kind: "note" })), false);
  assert.equal(streamAskCard(signal({ kind: "note" }), workspace), null);
  assert.deepEqual(streamAskCard(signal(), workspace), { id: "s1", kind: "ask", workspace, from: claude, what: "Your Claude asked you: ‘Which plumber?’", when: "10:00 am",
    primary: { label: "Reply", action: "reply" } });
  assert.equal(streamAskCard(signal({ author: person }), workspace).what, "Nikki asked you: ‘Which plumber?’");
});

test("an ask excerpt is one line and is cut with an ellipsis, never mid-character", () => {
  assert.equal(askExcerpt("  Which\n\n plumber,\tplease? "), "Which plumber, please?");
  assert.equal(askExcerpt("abcdefghij", 5), "abcd…");
  assert.equal(askExcerpt("😀😀😀😀😀😀", 4), "😀😀😀…");
  assert.equal(askExcerpt("short", 5), "short");
});

test("the author label is the computed label for an agent and the name for a person", () => {
  assert.equal(authorLabel(claude), "Your Claude");
  assert.equal(authorLabel({ ...claude, label: "Nikki’s Muse", yours: false }), "Nikki’s Muse");
  assert.equal(authorLabel(person), "Nikki Rao");
});

test("a message with nothing extra derives nothing extra", () => {
  const extras = deriveStreamExtras(signal({ kind: "note", about: "field trial" }), { workspace, todos: new Map() });
  assert.deepEqual(extras, { ask: null, attachments: [], todo: null });
});

test("a message carries its ask, its files and its to-do together", () => {
  const todos = new Map([[ID, { id: ID, title: "Call the plumber", href: "#", meta: "", who: null, done: false }]]);
  const attachments = [{ fileId: "f1", versionN: 1, name: "a.pdf", contentType: "application/pdf", sizeBytes: 1500, href: "#a" }, { fileId: "f2", versionN: 1, name: "b.png", contentType: "image/png", sizeBytes: 2_500_000, href: "#b" }];
  const extras = deriveStreamExtras(signal({ about: `todo:${ID}`, attachments }), { workspace, todos });
  assert.equal(extras.ask.id, "s1");
  assert.deepEqual(extras.attachments.map((card) => [card.title, card.meta]), [["a.pdf", "1.5 KB"], ["b.png", "2.5 MB"]]);
  assert.equal(extras.todo.title, "Call the plumber");
});
