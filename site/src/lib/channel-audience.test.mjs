/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_AUDIENCE_MAX, channelCreateAudience, createdAsRequested, filterAudience, renderChannelAudience,
} from "./channel-audience.ts";

const people = [
  { kind: "user", id: "u-dana", name: "Dana" },
  { kind: "user", id: "u-ravi", name: "Ravi" },
  { kind: "agent", id: "a-atlas", name: "Atlas", detail: "Dana's agent" },
];

test("the create request follows the choice, and an unreadable choice sends nothing", () => {
  assert.deepEqual(channelCreateAudience("open", [{ kind: "user", id: "u-dana" }], people), {},
    "open sends neither key: the server refuses members on an open channel");
  assert.deepEqual(channelCreateAudience("private", [{ kind: "user", id: "u-dana" }, { kind: "agent", id: "a-atlas" }], people),
    { visibility: "private", members: [{ kind: "user", id: "u-dana" }, { kind: "agent", id: "a-atlas" }] });
  assert.deepEqual(channelCreateAudience("private", [], people), { visibility: "private", members: [] },
    "private with nobody chosen is still private: the creator is added by the server");
  for (const unreadable of [undefined, null, "", "PRIVATE", "secret"]) {
    assert.equal(channelCreateAudience(unreadable, [{ kind: "user", id: "u-dana" }], people), null,
      `${String(unreadable)}: never treated as open`);
  }
  assert.deepEqual(channelCreateAudience("private", [{ kind: "user", id: "u-gone" }, { kind: "user", id: "u-dana" }, { kind: "user", id: "u-dana" }], people),
    { visibility: "private", members: [{ kind: "user", id: "u-dana" }] }, "someone who is no longer a candidate, and a repeat, are not sent");
  const many = Array.from({ length: CHANNEL_AUDIENCE_MAX + 1 }, (_, n) => ({ kind: "user", id: `u-${n}`, name: `P${n}` }));
  assert.equal(channelCreateAudience("private", many, many), null, "more than the server takes is not trimmed silently");
  assert.equal(channelCreateAudience("private", many.slice(1), many).members.length, CHANNEL_AUDIENCE_MAX);
});

test("a private request must come back private", () => {
  const asked = channelCreateAudience("private", [], people);
  assert.equal(createdAsRequested(asked, { visibility: "private" }), true);
  assert.equal(createdAsRequested(asked, { visibility: "open" }), false);
  assert.equal(createdAsRequested(asked, {}), false, "no visibility in the answer is not a confirmation");
  assert.equal(createdAsRequested({}, { visibility: "open" }), true);
});

test("the search narrows by every word, over names and details", () => {
  assert.deepEqual(filterAudience(people, "").map((row) => row.id), ["u-dana", "u-ravi", "a-atlas"]);
  assert.deepEqual(filterAudience(people, "dana").map((row) => row.id), ["u-dana", "a-atlas"], "an agent is found by its owner's name");
  assert.deepEqual(filterAudience(people, "dana agent").map((row) => row.id), ["a-atlas"]);
  assert.deepEqual(filterAudience(people, "zzz"), []);
});

/* Enough of a document for the control: elements with children, attributes and listeners. No layout. */
const element = (tag) => ({
  tag, children: [], dataset: {}, attributes: {}, listeners: {}, className: "", textContent: "", value: "", hidden: false, checked: false, disabled: false,
  append(...nodes) { this.children.push(...nodes); },
  replaceChildren(...nodes) { this.children = nodes; },
  setAttribute(name, value) { this.attributes[name] = value; },
  addEventListener(name, callback) { this.listeners[name] = callback; },
});
const control = () => {
  const root = element("div"); root.ownerDocument = { createElement: element };
  const audience = renderChannelAudience(root, people);
  const all = (node) => [node, ...node.children.flatMap(all)];
  const find = (predicate) => all(root).filter(predicate);
  const radio = (value) => find((node) => node.dataset.channelAudience === value)[0];
  const choose = (value) => { for (const other of ["open", "private"]) radio(other).checked = other === value; radio(value).listeners.change(); };
  const box = (key) => find((node) => node.dataset.channelAudienceMember === key)[0];
  const tick = (key, on = true) => { box(key).checked = on; box(key).listeners.change(); };
  const one = (name) => find((node) => name in node.dataset)[0];
  return { audience, radio, choose, box, tick, picker: one("channelAudiencePicker"), search: one("channelAudienceSearch"), count: one("channelAudienceCount"), find };
};

test("the control starts open with the list put away, and a private choice carries exactly what is ticked", () => {
  const ui = control();
  assert.deepEqual([ui.radio("open").checked, ui.radio("private").checked, ui.picker.hidden], [true, false, true]);
  assert.deepEqual(ui.audience.audience(), {});
  ui.choose("private");
  assert.equal(ui.picker.hidden, false);
  assert.deepEqual(ui.audience.audience(), { visibility: "private", members: [] });
  ui.tick("user:u-dana");
  assert.deepEqual(ui.audience.audience(), { visibility: "private", members: [{ kind: "user", id: "u-dana" }] },
    "a person's agent is its own choice and is not added with them");
  assert.equal(ui.box("agent:a-atlas").checked, false);
  ui.tick("agent:a-atlas");
  assert.equal(ui.count.textContent, "2 selected");
  // Back to open: nothing is sent, and the selection is kept for a change of mind.
  ui.choose("open");
  assert.deepEqual(ui.audience.audience(), {});
  ui.choose("private");
  assert.equal(ui.audience.audience().members.length, 2);
});

test("neither choice marked sends nothing, Enter in the search does not submit, and a hold stops every control", () => {
  const ui = control();
  ui.radio("open").checked = false; ui.radio("private").checked = false;
  assert.equal(ui.audience.audience(), null, "an unreadable choice is never read as open");
  let prevented = false;
  ui.search.listeners.keydown({ key: "Enter", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  ui.search.listeners.keydown({ key: "a", preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  // A search redraws the list and keeps what was ticked.
  ui.choose("private"); ui.tick("user:u-ravi");
  ui.search.value = "atlas"; ui.search.listeners.input();
  assert.equal(ui.box("user:u-ravi"), undefined, "the row is not drawn while it does not match");
  assert.deepEqual(ui.audience.audience().members, [{ kind: "user", id: "u-ravi" }], "but it is still chosen");
  ui.search.value = ""; ui.search.listeners.input();
  assert.equal(ui.box("user:u-ravi").checked, true);
  ui.audience.hold(true);
  assert.deepEqual([ui.radio("open").disabled, ui.radio("private").disabled, ui.search.disabled, ui.box("user:u-dana").disabled], [true, true, true, true]);
  ui.audience.hold(false);
  assert.deepEqual([ui.radio("private").disabled, ui.box("user:u-dana").disabled], [false, false]);
});
