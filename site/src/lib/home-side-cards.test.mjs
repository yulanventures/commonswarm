import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LISTS_DOOR_LEAD, LISTS_DOOR_TITLE, SIDE_OBJECT_LIMIT, SIDE_TODO_LIMIT, sharedAgentLines, sharedEveryoneLine, sideCapObjects, sideOpenTodos, sideShowsTodos } from "./home-side-cards.ts";

const todo = (id, state = "open", extra = {}) => ({ id, title: `To-do ${id}`, href: `/app?todo=${id}`, state, mayComplete: true, subline: "", ...extra });
const agent = (label, yours, extra = {}) => ({ id: label, name: label, label, nestedLabel: label, ownerId: "tom", ownerFirstName: "Tom", ownerInitial: "T", yours, tint: 0, hosted: false, state: {}, ...extra });

test("the limits are the spec's numbers: six to-dos, five lists, five files", () => {
  assert.equal(SIDE_TODO_LIMIT, 6);
  assert.equal(SIDE_OBJECT_LIMIT, 5);
});

test("only open and doing to-dos show, in the order given, and never more than six", () => {
  const items = [todo("a", "done"), todo("b", "doing"), todo("c", "dropped"), todo("d"), todo("e"), todo("f"), todo("g"), todo("h"), todo("i"), todo("j")];
  const { shown, more } = sideOpenTodos(items);
  assert.deepEqual(shown.map((row) => row.id), ["b", "d", "e", "f", "g", "h"]);
  assert.equal(more, 2);
  assert.deepEqual(sideOpenTodos([todo("a", "done")]), { shown: [], more: 0 });
  assert.deepEqual(sideOpenTodos([]), { shown: [], more: 0 });
});

test("a to-do row keeps the status subline the view model carried", () => {
  const { shown } = sideOpenTodos([todo("a", "open", { subline: "Your Claude · 2nd in line" })]);
  assert.equal(shown[0].subline, "Your Claude · 2nd in line");
});

test("lists and files are cut at five and the rest is counted, not hidden silently", () => {
  const cards = Array.from({ length: 8 }, (_, index) => ({ kind: "list", id: String(index), title: `List ${index}`, href: "#", meta: "", who: null }));
  const { shown, more } = sideCapObjects(cards);
  assert.deepEqual(shown.map((card) => card.id), ["0", "1", "2", "3", "4"]);
  assert.equal(more, 3);
  assert.deepEqual(sideCapObjects(cards.slice(0, 2)).more, 0);
});

test("every To-dos surface is absent when the to-dos read is absent", () => {
  assert.equal(sideShowsTodos({ todos: null }), false);
  assert.equal(sideShowsTodos({ todos: { items: [], allHref: "#", canAdd: false } }), true);
});

test("the shared card says exactly what the spec says for a workspace called Home", () => {
  assert.equal(sharedEveryoneLine("Home"), "Everyone in Home sees what is posted here, including what agents post.");
  assert.equal(sharedEveryoneLine("Summer trip"), "Everyone in Summer trip sees what is posted here, including what agents post.");
});

test("the agent line appears for the viewer's own agents only", () => {
  assert.deepEqual(sharedAgentLines([{ agent: agent("Your Claude", true), until: null }]), ["Your Claude can use Lists & docs here, until you withdraw it."]);
  assert.deepEqual(sharedAgentLines([{ agent: agent("Nikki’s Muse", false), until: null }]), []);
  assert.deepEqual(sharedAgentLines([{ agent: agent("Your Claude", true), until: null }, { agent: agent("Nikki’s Muse", false), until: null }, { agent: agent("Your dot", true), until: null }]),
    ["Your Claude can use Lists & docs here, until you withdraw it.", "Your dot can use Lists & docs here, until you withdraw it."]);
  assert.deepEqual(sharedAgentLines([]), []);
});

test("an approval with an end date says so instead of promising until withdrawn", () => {
  assert.deepEqual(sharedAgentLines([{ agent: agent("Your dot", true), until: "Oct 9" }]), ["Your dot can use Lists & docs here until Oct 9, or until you withdraw it."]);
});

// Independent source: the Lists pane's own consent form, read as text. If the pane's words change, the door must follow.
test("the refused Lists & docs door uses the words of the Lists pane form it stands for", () => {
  const pane = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const form = pane.slice(pane.indexOf("data-household-consent"));
  const plain = form.slice(0, form.indexOf("</p>")).replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
  assert.ok(plain.includes(LISTS_DOOR_TITLE), `the pane form says "${LISTS_DOOR_TITLE}"`);
  assert.ok(plain.includes(LISTS_DOOR_LEAD), "the pane form carries the same lead sentence");
  assert.equal(LISTS_DOOR_TITLE, "Turn on Lists & docs");
});
