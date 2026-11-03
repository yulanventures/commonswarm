import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingOfferCards, offerCardText } from "./home-stream-approvals.ts";

const me = "u-me";
const row = (id, state, offer) => ({ todo_id: id, version: 1, title: `Task ${id}`, state, due_on: null, assignee: null, offer,
  gate: { kind: "none", clear: true, todo_id: null, at: null }, queue_position: null, comment_count: 0, state_at: "2026-11-03T00:00:00Z" });
const offer = (to, decider = me) => ({ offer_id: `o-${to.id}`, to, decider_user_id: decider, start: { kind: "now" } });

test("only offers the viewer decides, on open or doing to-dos, become cards", () => {
  const rows = [
    row("1", "open", offer({ kind: "agent", id: "a-muse" })),
    row("2", "doing", offer({ kind: "user", id: me })),
    row("3", "open", offer({ kind: "agent", id: "a-muse" }, "u-other")),
    row("4", "done", offer({ kind: "agent", id: "a-muse" })),
    row("5", "open", null),
  ];
  const cards = pendingOfferCards(rows, me, party => party.id === "a-muse" ? "Nikki’s Muse" : "Someone");
  assert.deepEqual(cards.map(card => card.todoId), ["1", "2"]);
  assert.equal(offerCardText(cards[0]), "Nikki’s Muse wants to take “Task 1”");
  assert.equal(offerCardText(cards[1]), "“Task 2” is offered to you");
  assert.equal(cards[0].offerId, "o-a-muse");
  assert.deepEqual(pendingOfferCards(rows, "", () => "x"), [], "no viewer, no cards");
});
