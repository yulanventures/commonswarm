import assert from "node:assert/strict";
import { test } from "node:test";
import { waitingName, waitingText, waitingTotal } from "./waiting-count.ts";

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
});

test("the control's name starts with the words and the number drawn on it", () => {
  for (const total of [{ min: 0, complete: true }, { min: 3, complete: true }, { min: 3, complete: false }, { min: 0, complete: false }]) {
    const shown = `Waiting on you ${waitingText(total)}`.trim();
    assert.ok(waitingName(total).startsWith(shown), `${waitingName(total)} starts with ${shown}`);
  }
  assert.equal(waitingName({ min: 0, complete: false }), "Waiting on you, still counting");
});
