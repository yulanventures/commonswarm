import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingOfferCards, offerCardText } from "./home-stream-approvals.ts";
import { evaluateInlineOfferTerms, formatExactOfferAt } from "./todo-offer-terms.ts";

const me = "u-me";
const row = (id, state, offer, extra = {}) => ({ todo_id: id, version: 2, title: `Task ${id}`, state, due_on: null, assignee: null, offer,
  has_notes: false, gate: { kind: "none", clear: true, todo_id: null, at: null }, queue_position: null, comment_count: 0, state_at: "2026-11-03T00:00:00Z", ...extra });
const offer = (to, decider = me, extra = {}) => ({ offer_id: `o-${to.id}`, to, decider_user_id: decider, start: "now", gate: { kind: "none" }, ...extra });

test("only offers the viewer decides, on open or doing to-dos, become cards with version and gate terms", () => {
  const rows = [
    row("1", "open", offer({ kind: "agent", id: "a-muse" }, me, { by: { user_id: "u-other", principal_id: null }, gate: { kind: "hold", note: "Wait for review" } }), { due_on: "2026-11-10" }),
    row("2", "doing", offer({ kind: "user", id: me })),
    row("3", "open", offer({ kind: "agent", id: "a-muse" }, "u-other")),
    row("4", "done", offer({ kind: "agent", id: "a-muse" })),
    row("5", "open", null),
  ];
  const cards = pendingOfferCards(rows, me, party => party.id === "a-muse" ? "Nikki’s Muse" : "Nikki");
  assert.deepEqual(cards.map(card => card.todoId), ["1", "2"]);
  assert.equal(offerCardText(cards[0]), "Nikki’s Muse wants to take “Task 1”");
  assert.equal(offerCardText(cards[1]), "“Task 2” is offered to you");
  assert.equal(cards[0].offerId, "o-a-muse");
  assert.equal(cards[0].version, 2);
  assert.equal(cards[0].dueOn, "2026-11-10");
  assert.equal(cards[0].requesterName, "Nikki");
  assert.equal(cards[0].start, "now");
  assert.deepEqual(cards[0].offerGate, { kind: "hold", note: "Wait for review" });
  assert.equal(cards[0].hasNotes, false);
  assert.deepEqual(pendingOfferCards(rows, "", () => "x"), [], "no viewer, no cards");
});

test("formatExactOfferAt distinguishes same-minute instants by seconds, milliseconds, explicit offsets, and DST fall-back overlap, and fails closed on invalid strings", () => {
  // 1. Same minute, different seconds
  const secA = formatExactOfferAt("2026-11-30T15:00:05Z", "UTC");
  const secB = formatExactOfferAt("2026-11-30T15:00:45Z", "UTC");
  assert.ok(secA && secB);
  assert.notEqual(secA, secB);
  assert.equal(secA, "Nov 30, 2026, 3:00:05 pm GMT");
  assert.equal(secB, "Nov 30, 2026, 3:00:45 pm GMT");

  // 2. Same second, different milliseconds (non-zero ms shown; .000 matches Z)
  const msA = formatExactOfferAt("2026-11-30T15:00:05.120Z", "UTC");
  const msB = formatExactOfferAt("2026-11-30T15:00:05.789Z", "UTC");
  const msZero = formatExactOfferAt("2026-11-30T15:00:05.000Z", "UTC");
  assert.ok(msA && msB && msZero);
  assert.notEqual(msA, msB);
  assert.notEqual(msA, msZero);
  assert.equal(msZero, secA);
  assert.equal(msA, "Nov 30, 2026, 3:00:05.120 pm GMT");
  assert.equal(msB, "Nov 30, 2026, 3:00:05.789 pm GMT");

  // 3. Same wall-clock digits, different offsets
  const offZ = formatExactOfferAt("2026-11-30T15:00:05Z", "UTC");
  const offPlus2 = formatExactOfferAt("2026-11-30T15:00:05+02:00", "UTC");
  assert.ok(offZ && offPlus2);
  assert.notEqual(offZ, offPlus2);
  assert.equal(offPlus2, "Nov 30, 2026, 1:00:05 pm GMT");

  // 4. DST fall-back overlap in America/Chicago (same local 1:30:15 am, distinct GMT-5 vs GMT-6)
  const dstBefore = formatExactOfferAt("2026-11-01T06:30:15Z", "America/Chicago");
  const dstAfter = formatExactOfferAt("2026-11-01T07:30:15Z", "America/Chicago");
  assert.ok(dstBefore && dstAfter);
  assert.notEqual(dstBefore, dstAfter);
  assert.equal(dstBefore, "Nov 1, 2026, 1:30:15 am GMT-5");
  assert.equal(dstAfter, "Nov 1, 2026, 1:30:15 am GMT-6");

  // 5. Invalid / offsetless / nonexistent calendar dates return null and fail closed
  for (const invalid of [
    "2026-11-30T15:00:05",
    "2026-02-30T15:00:05Z",
    "2026-11-30T15:00Z",
    "2026-11-30",
    "not-a-date",
    "",
  ]) {
    assert.equal(formatExactOfferAt(invalid, "UTC"), null, `expected null for ${JSON.stringify(invalid)}`);
    assert.deepEqual(
      evaluateInlineOfferTerms({ hasUnshownNotes: false, offerGate: { kind: "at", at: invalid }, timeZone: "UTC" }),
      { eligible: false, reason: "invalid_at" },
    );
  }
});
