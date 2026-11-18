import assert from "node:assert/strict";
import test from "node:test";
import { peopleTabView } from "./people/states.ts";

const view = (over = {}) => peopleTabView({ tab: "agents", read: "ready", invitesFailed: false, shown: 0, searching: false, ...over });

test("every tab answers with rows, loading, empty, or could not load with Retry", () => {
  assert.deepEqual(view({ shown: 3 }), { state: "rows", message: "", retry: false, rows: true });
  assert.deepEqual(view({ read: "pending" }), { state: "loading", message: "Loading…", retry: false, rows: false });
  assert.equal(view().message, "No agents yet.");
  assert.equal(view({ tab: "people" }).message, "No people yet.");
  assert.equal(view({ tab: "invites" }).message, "No invites waiting.");
  assert.deepEqual(view({ read: "failed" }), { state: "error", message: "Agents could not load.", retry: true, rows: false });
});

test("a failed read keeps the rows that did arrive and says they may be out of date", () => {
  assert.deepEqual(view({ read: "failed", shown: 2 }), { state: "error", message: "This list may be out of date.", retry: true, rows: true });
});

test("invites fail on their own read, and the roster's failure does not mark them", () => {
  assert.equal(view({ tab: "invites", invitesFailed: true }).message, "Invites could not load.");
  assert.equal(view({ tab: "invites", read: "failed", shown: 1 }).state, "rows");
  assert.equal(view({ tab: "people", invitesFailed: true, shown: 1 }).state, "rows");
});

test("a search with no match leaves the answer to the search line, even while loading", () => {
  assert.deepEqual(view({ searching: true }), { state: "no-match", message: "", retry: false, rows: false });
  assert.equal(view({ searching: true, read: "pending" }).state, "no-match");
});
