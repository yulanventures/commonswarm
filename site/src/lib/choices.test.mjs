/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceAnswerText, parseAskChoices } from "./choices.ts";

const SIGNAL = "44444444-4444-4444-8444-444444444444";
const options = [{ id: "ship", label: "Ship it" }, { id: "wait", label: "Wait for tomorrow" }];

test("ask choices parse with and without an answer, and malformed replies are unavailable", () => {
  assert.deepEqual(parseAskChoices({ asks: [{ signal_id: SIGNAL, options, answer: null }] }),
    [{ signalId: SIGNAL, options, answer: null }]);
  const answered = parseAskChoices({ asks: [{ signal_id: SIGNAL, options, answer: { option_id: "wait", by_viewer: true } }] });
  assert.equal(choiceAnswerText(answered[0]), "You chose: Wait for tomorrow");
  const theirs = parseAskChoices({ asks: [{ signal_id: SIGNAL, options, answer: { option_id: "ship", by_viewer: false } }] });
  assert.equal(choiceAnswerText(theirs[0]), "Answered: Ship it");
  for (const bad of [null, {}, { asks: {} }, { asks: [{ signal_id: "x", options, answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [options[0]], answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [{ id: "Bad Id", label: "x" }, options[1]], answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [{ id: "a", label: "x".repeat(81) }, options[1]], answer: null }] }]) {
    assert.equal(parseAskChoices(bad), null);
  }
});
