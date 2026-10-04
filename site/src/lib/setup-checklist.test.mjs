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

test("a new owner sees three open steps in order", () => {
  const steps = setupSteps(owner);
  assert.deepEqual(steps.map((step) => step.id), ["access", "agent", "invite"]);
  assert.deepEqual(steps.map((step) => step.done), [false, false, false]);
  assert.equal(steps[0].title, "Choose who can see it");
  assert.deepEqual(setupProgress(steps), { done: 0, total: 3, complete: false });
});

test("steps follow the facts, including a pending invite and an unknown access read", () => {
  const steps = setupSteps({ ...owner, accessConfirmed: null, myAgentCount: 2, pendingInviteCount: 1 });
  assert.equal(steps[0].done, false, "an unanswered access read is not done");
  assert.equal(steps[1].done, true);
  assert.match(steps[1].detail, /2 connected/u);
  assert.equal(steps[2].done, true);
  assert.match(steps[2].detail, /pending until they join/u);
  const all = setupSteps({ ...owner, accessConfirmed: true, myAgentCount: 1, otherMemberCount: 1 });
  assert.deepEqual(setupProgress(all), { done: 3, total: 3, complete: true });
});

test("a member who cannot invite gets their own two steps", () => {
  const steps = setupSteps({ ...owner, isOwner: false, canInvite: false });
  assert.deepEqual(steps.map((step) => step.id), ["access", "agent"]);
  assert.equal(steps[0].title, "Choose your access");
  assert.equal(steps[1].title, "Connect your own agents");
  assert.deepEqual(setupProgress([]), { done: 0, total: 0, complete: false });
});
