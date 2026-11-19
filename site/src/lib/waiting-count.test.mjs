import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWaitingButton, updateWaitingButton, waitingName, waitingText, waitingTotal } from "./waiting-count.ts";

test("the total counts every workspace, and an uncounted one makes it a minimum, never a zero", () => {
  const nine = Array.from({ length: 9 }, (_, n) => "W" + n);
  const quiet = new Map(nine.map(id => [id, 0]));
  assert.deepEqual(waitingTotal(nine, quiet), { min: 0, complete: true });
  assert.deepEqual(waitingTotal(nine, new Map([...quiet, ["W8", 1]])), { min: 1, complete: true }, "a question in the ninth workspace is in the total");
  assert.deepEqual(waitingTotal(nine, new Map([...quiet, ["W8", null]])), { min: 0, complete: false }, "an uncounted workspace is not a zero");
  const missing = new Map(quiet); missing.delete("W3");
  assert.deepEqual(waitingTotal(nine, new Map([...missing, ["W8", 2]])), { min: 2, complete: false }, "a workspace with no entry was not counted");
  assert.deepEqual(waitingTotal([], new Map()), { min: 0, complete: true });
});

test("zero is drawn only when every workspace was counted; a minimum says so; nothing known draws no number", () => {
  assert.equal(waitingText({ min: 0, complete: true }), "0");
  assert.equal(waitingText({ min: 3, complete: true }), "3");
  assert.equal(waitingText({ min: 3, complete: false }), "3+");
  assert.equal(waitingText({ min: 0, complete: false }), "");
  // At most three characters, so the control never changes width as the count changes.
  for (const total of [{ min: 99, complete: false }, { min: 100, complete: true }, { min: 4000, complete: false }]) assert.equal(waitingText(total), "99+");
  assert.equal(waitingText({ min: 99, complete: true }), "99");
});

test("the control's name starts with the words and the number drawn on it", () => {
  for (const total of [{ min: 0, complete: true }, { min: 3, complete: true }, { min: 3, complete: false }, { min: 0, complete: false }]) {
    const shown = `Waiting on you ${waitingText(total)}`.trim();
    assert.ok(waitingName(total).startsWith(shown), `${waitingName(total)} starts with ${shown}`);
  }
  assert.equal(waitingName({ min: 0, complete: false }), "Waiting on you, still counting");
});

test("buildWaitingButton separates Waiting on you from its count across zero, partial, and unknown counts", () => {
  const makeEl = (tag) => ({
    tag, className: "", href: "", title: "", textContent: "",
    children: [], attrs: {}, dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this.attrs[name] = value; },
    toggleAttribute(name, force) { if (force) this.attrs[name] = ""; else delete this.attrs[name]; },
    addEventListener() {},
    querySelector(selector) {
      if (selector !== "[data-waiting-count]") return null;
      return this.children.find(n => typeof n === "object" && n.dataset?.waitingCount !== undefined) ?? null;
    },
  });
  const textOf = (node) => typeof node === "string"
    ? node
    : (node.textContent || "") + (node.children ?? []).map(textOf).join("");
  const link = buildWaitingButton({ createElement: makeEl }, "/app?v=catchup", () => {});

  // Unknown count: no number drawn; accessible name still starts with visible words.
  assert.equal(textOf(link).trim(), "Waiting on you");
  assert.equal(link.attrs["aria-label"], "Waiting on you, still counting");

  // Zero count: real space between label and "0".
  updateWaitingButton(link, { min: 0, complete: true });
  assert.equal(textOf(link), "Waiting on you 0");
  assert.equal(link.attrs["aria-label"], "Waiting on you 0");

  // Partial count: real space between label and "3+".
  updateWaitingButton(link, { min: 3, complete: false });
  assert.equal(textOf(link), "Waiting on you 3+");
  assert.equal(link.attrs["aria-label"], "Waiting on you 3+, still counting");
});
