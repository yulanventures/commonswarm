import assert from "node:assert/strict";
import { test } from "node:test";
import { homeBootRoute, resolveHomeRoute, homeViewTitle, initialCatchUpData, overviewCatchUpData, homeOverviewUnavailable, homeObjectState } from "./home-map.ts";
const now = Date.parse("2026-10-05T12:00:00Z");
const workspaces = [{ id: "W", name: "Home" }, { id: "X", name: "Trip" }];

test("boot chooses the only workspace; foreign and missing addresses never select a foreign object", () => {
  assert.deepEqual(homeBootRoute(workspaces), { view: "catchup" });
  assert.deepEqual(resolveHomeRoute("", workspaces.slice(0, 1)), { view: "chat", workspaceId: "W" });
  assert.deepEqual(resolveHomeRoute("?w=foreign&todo=T", workspaces), { view: "catchup" });
  assert.deepEqual(resolveHomeRoute("?w=foreign&agent=A", workspaces.slice(0, 1)), { view: "chat", workspaceId: "W" });
  assert.deepEqual(resolveHomeRoute("?w=W&todo=missing", workspaces), { view: "todo", workspaceId: "W", todoId: "missing" });
  assert.deepEqual(resolveHomeRoute("?w=W&c=C&m=M", workspaces), { view: "chat", workspaceId: "W", channelId: "C", messageId: "M" });
  assert.equal(homeViewTitle({ view: "files", workspaceId: "W" }, "Home"), "Files · Home · CommonSwarm");
});
test("the overview cannot add a foreign workspace and missing content remains unknown", () => {
  const row = { workspace_id: "W", name: "Home", role: "owner", last_seen_at: null, new_messages: 4,
    content: null, people: [], needs_you: { asks: [], assigned: [], waiting: [] } };
  const data = overviewCatchUpData(initialCatchUpData(workspaces), { viewer_user_id: "zoe", generated_at: new Date(now).toISOString(), workspaces: [row, { ...row, workspace_id: "foreign" }] }, false);
  assert.deepEqual(data.map(entry => entry.workspace.id), ["W", "X"]);
  assert.equal(data[1].state, "failed"); assert.equal(data[0].detail.newMessages, null);
  assert.equal(data[0].detail.openTodos, null);
});

test("only a missing overview RPC allows silent fallback, never a refusal or outage", () => {
  for (const [status, code] of [[404, undefined], [400, "PGRST202"], [400, "42883"]]) assert.equal(homeOverviewUnavailable(status, code), true);
  for (const [status, code] of [[200, undefined], [401, "unauthenticated"], [403, "42501"], [500, "XX000"]]) assert.equal(homeOverviewUnavailable(status, code), false);
});

test("an object link distinguishes a failed read from confirmed absence in its own workspace", () => {
  assert.equal(homeObjectState("missing", [], "pending"), "checking");
  assert.equal(homeObjectState("missing", [], "failed"), "failed");
  assert.equal(homeObjectState("A", ["A"], "ready"), "found");
  assert.equal(homeObjectState("foreign", ["A"], "ready"), "missing");
});

// Exercise the real optional read with a transport double: no client init, network, or credentials.
// The to-do reducer is the assignment record. These helpers only run it; they do not describe the card.
/** Nikki offers the to-do; the accepter commits it. assigned_by is that accepter. */
/** The owner's agent assigns the to-do straight to that owner. */
/** The owner already holds the to-do. Another member asks that owner's agent to take it. */

/** Recipient filter of swarm_read.signals. Independent of the client. */
/** Answer rule of home_overview: a swarm.signals reply by the viewer or an agent they own. */
