import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOUSEHOLD_CONTENT_OPERATIONS,
  HOUSEHOLD_CONTENT_ROLES,
} from "../../../src/protocol/household-object-policy.ts";
import {
  CONTENT_OPERATION_LABELS,
  CONTENT_ROLE_COPY,
  PURPOSE_COPY,
  CREATE_PURPOSE_DETAILS,
  accessRefusalMessage,
  approvalUntil,
  withdrawRefusalMessage,
  removedAgentLabel,
} from "./household-access.ts";

test("every enforced role and operation has plain words, and no extra ones exist", () => {
  assert.deepEqual(Object.keys(CONTENT_ROLE_COPY).sort(), [...HOUSEHOLD_CONTENT_ROLES].sort());
  assert.deepEqual(Object.keys(CONTENT_OPERATION_LABELS).sort(), [...HOUSEHOLD_CONTENT_OPERATIONS].sort());
  // The two purposes are the server's accepted values (household-permissions.ts).
  assert.deepEqual(Object.keys(PURPOSE_COPY).sort(), ["personal", "shared"]);
});

test("the personal choice is scoped to Lists & docs, says it is final and blocks invitations", () => {
  assert.match(PURPOSE_COPY.personal.detail, /^Only you can use Lists & docs here\./u);
  assert.match(PURPOSE_COPY.personal.detail, /Invitations to this workspace will not work/u);
  assert.match(PURPOSE_COPY.personal.detail, /cannot be changed later/u);
  assert.match(PURPOSE_COPY.personal.detail, /To share with people later, create another workspace/u);
  /* Messages and Files are not governed by this choice; the copy must not imply privacy for them. */
  assert.match(PURPOSE_COPY.personal.detail, /still see its messages and files/u);
  assert.doesNotMatch(PURPOSE_COPY.personal.detail, /Private to you/u);
  assert.match(PURPOSE_COPY.shared.detail, /including their history/u);
});

test("refusals map by stable code, and unknown codes say nothing changed", () => {
  assert.match(accessRefusalMessage("owner_confirmation_required"), /owner chooses/u);
  assert.match(accessRefusalMessage("connection_access_refused"), /Connect it again/u);
  assert.equal(accessRefusalMessage("content_consent_required"), "Confirm your own access to Lists & docs first. Nothing was changed.");
  assert.equal(withdrawRefusalMessage("connection_access_refused"), "Only the person who connected this agent can withdraw its Lists & docs access. Nothing was changed.");
  assert.equal(withdrawRefusalMessage("workspace_access_refused"), accessRefusalMessage("workspace_access_refused"));
  assert.equal(withdrawRefusalMessage("unknown"), "CommonSwarm refused this change. Nothing was changed.");
  assert.equal(accessRefusalMessage("some_new_code"), "CommonSwarm refused this change. Nothing was changed.");
  assert.equal(accessRefusalMessage(undefined), "CommonSwarm refused this change. Nothing was changed.");
});

test("approval end reads as a time, tomorrow, or ended", () => {
  const now = new Date(2026, 9, 4, 10, 0, 0).getTime();
  const tomorrow = new Date(2026, 9, 5, 10, 0, 0).toISOString();
  assert.match(approvalUntil(tomorrow, now), /^Allowed until .+ tomorrow\. Allow it again after that\.$/u);
  const later = new Date(2026, 9, 4, 18, 30, 0).toISOString();
  assert.match(approvalUntil(later, now), / today\./u);
  assert.match(approvalUntil(new Date(now - 1000).toISOString(), now), /has ended/u);
  assert.equal(approvalUntil(null, now), "Allowed until you withdraw it.");
  assert.equal(approvalUntil("not a date", now), "Allowed.");
});

test("a removed identity's name is labelled without changing its spelling", () => {
  assert.equal(removedAgentLabel("Muse"), "Muse (removed)");
  assert.equal(removedAgentLabel("<img src=x>"), "<img src=x> (removed)");
});

test("creation details describe the people invited next, with finality only in the warning", () => {
  assert.deepEqual(Object.keys(CREATE_PURPOSE_DETAILS).sort(), Object.keys(PURPOSE_COPY).sort());
  assert.equal(CREATE_PURPOSE_DETAILS.shared, "You and the people you invite can see and use Lists & docs, including their history.");
  assert.equal(CREATE_PURPOSE_DETAILS.personal, "Only you can use Lists & docs. Nobody can be invited to this workspace.");
});
