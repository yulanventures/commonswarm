/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerChoiceCommand, answerNeedsV2, cleanOtherText, draftSubmission, orderedChoiceOptions, parseAskChoices } from "./choices.ts";

const SIGNAL = "44444444-4444-4444-8444-444444444444";
const ACTOR = "55555555-5555-4555-8555-555555555555";
const options = [{ id: "ship", label: "Ship it" }, { id: "wait", label: "Wait for tomorrow" }];

test("a v1 read parses with v2 defaults, and malformed replies are unavailable", () => {
  assert.deepEqual(parseAskChoices({ asks: [{ signal_id: SIGNAL, options, answer: null }] }),
    [{ signalId: SIGNAL, multi: false, options, answer: null }]);
  const answered = parseAskChoices({ asks: [{ signal_id: SIGNAL, options,
    answer: { option_id: "wait", by_viewer: true, reply_signal_id: SIGNAL, at: "2026-11-16T10:00:00Z" } }] });
  assert.deepEqual(answered[0].answer, { optionId: "wait", optionIds: ["wait"], otherText: null, byViewer: true, actorUserId: null, at: "2026-11-16T10:00:00Z" });
  const theirs = parseAskChoices({ asks: [{ signal_id: SIGNAL, options, answer: { option_id: "ship", by_viewer: false } }] });
  assert.equal(theirs[0].answer.byViewer, false);
  assert.equal(theirs[0].answer.at, null, "no time is invented");
  for (const bad of [null, {}, { asks: {} }, { asks: [{ signal_id: "x", options, answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [options[0]], answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [{ id: "Bad Id", label: "x" }, options[1]], answer: null }] },
    { asks: [{ signal_id: SIGNAL, options: [{ id: "a", label: "x".repeat(81) }, options[1]], answer: null }] },
    { asks: [{ signal_id: SIGNAL, options, answer: { option_id: 3, by_viewer: true } }] }]) {
    assert.equal(parseAskChoices(bad), null);
  }
});

test("a v2 read carries multi, descriptions, one recommended option, several choices, Other text and who answered", () => {
  const v2 = [{ id: "a", label: "Alpha", description: "First" }, { id: "b", label: "Beta", recommended: true },
    { id: "c", label: "Gamma", recommended: true, description: "" }];
  const [row] = parseAskChoices({ asks: [{ signal_id: SIGNAL, multi: true, options: v2,
    answer: { option_id: "a", option_ids: ["a", "c", "zzz"], other_text: "Both, later", actor_user_id: ACTOR, by_viewer: false, at: "2026-11-16T10:00:00Z" } }] });
  assert.equal(row.multi, true);
  assert.deepEqual(row.options, [{ id: "a", label: "Alpha", description: "First" }, { id: "b", label: "Beta", recommended: true }, { id: "c", label: "Gamma" }],
    "a second recommended and an empty description fall back to their defaults");
  assert.deepEqual(row.answer.optionIds, ["a", "c"], "option_ids alone names the chosen rows; unknown ids are dropped");
  assert.equal(row.answer.otherText, "Both, later");
  assert.equal(row.answer.actorUserId, ACTOR);
  assert.deepEqual(orderedChoiceOptions(row.options).map(option => option.id), ["b", "a", "c"], "recommended first");

  const other = parseAskChoices({ asks: [{ signal_id: SIGNAL, multi: false, options, answer: { option_id: "other", option_ids: [], other_text: "Neither", by_viewer: true } }] });
  assert.deepEqual([other[0].answer.optionIds, other[0].answer.otherText], [[], "Neither"], "the 'other' sentinel is never a row");
  const junk = parseAskChoices({ asks: [{ signal_id: SIGNAL, multi: "yes", options: [{ ...options[0], description: 7, recommended: "y" }, options[1]],
    answer: { option_id: "ship", option_ids: "ship", other_text: 4, actor_user_id: "nobody", by_viewer: true, at: "soon" } }] });
  assert.deepEqual(junk[0], { signalId: SIGNAL, multi: false, options,
    answer: { optionId: "ship", optionIds: ["ship"], otherText: null, byViewer: true, actorUserId: null, at: null } }, "malformed new fields take v1 defaults");
});

test("a single fixed option keeps v1's exact command; multi and Other send the v2 fields only when needed", () => {
  const single = answerChoiceCommand(SIGNAL, false, { optionIds: ["ship"], otherText: null });
  assert.deepEqual(single, { kind: "answer_choice", signal_id: SIGNAL, option_id: "ship" });
  assert.deepEqual(Object.keys(single).sort(), ["kind", "option_id", "signal_id"], "today's server refuses any other key");
  assert.equal(answerNeedsV2(single), false);
  const other = answerChoiceCommand(SIGNAL, false, { optionIds: [], otherText: "Next week" });
  assert.deepEqual(other, { kind: "answer_choice", signal_id: SIGNAL, other_text: "Next week" });
  assert.equal(answerNeedsV2(other), true);
  assert.deepEqual(answerChoiceCommand(SIGNAL, true, { optionIds: ["ship"], otherText: null }),
    { kind: "answer_choice", signal_id: SIGNAL, option_ids: ["ship"] });
  assert.deepEqual(answerChoiceCommand(SIGNAL, true, { optionIds: ["ship", "wait"], otherText: "and lunch" }),
    { kind: "answer_choice", signal_id: SIGNAL, option_ids: ["ship", "wait"], other_text: "and lunch" });
});

test("a draft sends only real options and clean Other text, and an empty draft sends nothing", () => {
  const state = { multi: true, options };
  assert.equal(draftSubmission(state, { selected: [], otherOpen: false, otherText: "" }), null);
  assert.equal(draftSubmission(state, { selected: [], otherOpen: true, otherText: "   " }), null);
  assert.equal(draftSubmission(state, { selected: [], otherOpen: false, otherText: "typed but closed" }), null, "closed Other sends nothing");
  assert.deepEqual(draftSubmission(state, { selected: ["wait", "gone", "wait"], otherOpen: true, otherText: "  soon " }),
    { optionIds: ["wait"], otherText: "soon" });
  assert.equal(cleanOtherText("x".repeat(501)), null);
  assert.equal(cleanOtherText("line\nbreak"), null);
  assert.equal(cleanOtherText(" ok "), "ok");
});
