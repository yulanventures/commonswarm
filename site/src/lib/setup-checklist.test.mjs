import assert from "node:assert/strict";
import { test } from "node:test";

import { setupProgress, setupSteps } from "./setup-checklist.ts";

const owner = {
  isOwner: true,
  canInvite: true,
  accessConfirmed: false,
  myAgentCount: 0,
  otherMemberCount: 0,
  pendingInviteCount: 0,
};

test("an owner with refused access sees three open steps in order", () => {
  const steps = setupSteps(owner);
  assert.deepEqual(steps.map((step) => step.id), ["access", "agent", "invite"]);
  assert.deepEqual(steps.map((step) => step.done), [false, false, false]);
  assert.equal(steps[0].title, "Choose who shares Lists & docs");
  assert.deepEqual(setupProgress(steps), { done: 0, total: 3, complete: false });
});

test("steps follow the facts, including a pending invite and an unknown access read", () => {
  const steps = setupSteps({ ...owner, accessConfirmed: null, myAgentCount: 2, pendingInviteCount: 1 });
  assert.deepEqual(steps.map((step) => step.id), ["agent", "invite"]);
  assert.equal(steps[0].done, true);
  assert.match(steps[0].detail, /2 connected/u);
  assert.equal(steps[1].done, true);
  assert.match(steps[1].detail, /pending until they join/u);
  assert.deepEqual(setupProgress(steps), { done: 2, total: 2, complete: true });
  const all = setupSteps({ ...owner, accessConfirmed: true, myAgentCount: 1, otherMemberCount: 1 });
  assert.deepEqual(setupProgress(all), { done: 2, total: 2, complete: true });
});

test("a member who cannot invite gets their own two steps", () => {
  const steps = setupSteps({ ...owner, isOwner: false, canInvite: false });
  assert.deepEqual(steps.map((step) => step.id), ["access", "agent"]);
  assert.equal(steps[0].title, "Choose your access");
  assert.equal(steps[1].title, "Connect your own agents");
  assert.deepEqual(setupProgress([]), { done: 0, total: 0, complete: false });
});

test("confirmed and unknown access omit the access step for owners, admins and members", () => {
  for (const accessConfirmed of [true, null]) {
    for (const [isOwner, canInvite, ids] of [[true, true, ["agent", "invite"]], [false, true, ["agent", "invite"]], [false, false, ["agent"]]]) {
      const steps = setupSteps({ ...owner, isOwner, canInvite, accessConfirmed, myAgentCount: 1 });
      assert.deepEqual(steps.map(step => step.id), ids);
      assert.deepEqual(setupProgress(steps), { done: 1, total: ids.length, complete: ids.length === 1 });
    }
  }
  const admin = setupSteps({ ...owner, isOwner: false, canInvite: true });
  assert.deepEqual(admin.map(step => step.id), ["access", "agent", "invite"]);
  assert.equal(admin[0].title, "Choose your access");
});

test("a failed creation permissions step stays in setup through unknown reads until access is confirmed", () => {
  for (const accessConfirmed of [null, false, true]) {
    const steps = setupSteps({ ...owner, accessNeedsSetup: true, accessConfirmed });
    assert.deepEqual(steps.map(step => step.id), accessConfirmed === true ? ["agent", "invite"] : ["access", "agent", "invite"]);
  }
});
