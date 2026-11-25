import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingOfferCards, offerCardText } from "./home-stream-approvals.ts";

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
