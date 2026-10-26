import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleRoleBeginSave, peopleRoleFinishSave } from "./people-dialog-view.ts";

// Role change (UI-SPEC 3.6). Expected strings are the spec's literals, not read back from the code under test.
test("a person has one role save in flight, and a superseded completion is dropped", () => {
  const state = { selected: null, collapsed: new Set(), showAllAttention: false, query: "" };
  const admin = peopleRoleBeginSave(state, "nikki", "admin");
  assert.ok(admin);
  // Owner is submitted before Admin finishes: refused, so the receipt can never name a role that did not win.
  assert.equal(peopleRoleBeginSave(state, "nikki", "owner"), null);
  assert.equal(peopleRoleBeginSave(state, "nikki", "admin"), null);
  // Another person is independent.
  const other = peopleRoleBeginSave(state, "sam", "member"); assert.ok(other);
  assert.equal(peopleRoleFinishSave(state, "nikki", admin), true);
  assert.equal(peopleRoleFinishSave(state, "nikki", admin), false);
  assert.equal(peopleRoleFinishSave(state, "sam", other), true);
  // A save that lost its slot (state replaced, entry cleared) must not report.
  const stale = peopleRoleBeginSave(state, "nikki", "admin"); state.rolePending.clear();
  const fresh = peopleRoleBeginSave(state, "nikki", "owner"); assert.ok(fresh);
  assert.equal(peopleRoleFinishSave(state, "nikki", stale), false);
  assert.equal(state.rolePending.get("nikki"), fresh);
  assert.equal(peopleRoleFinishSave(state, "nikki", fresh), true);
  assert.equal(peopleRoleBeginSave(state, "nikki", "owner") !== null, true);
});
