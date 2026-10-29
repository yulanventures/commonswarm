import assert from "node:assert/strict";
import test from "node:test";
import {
  durableCommandFailure,
} from "../supabase/functions/command/failures.js";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

test("credentials and signal input are not fields of the durable row", () => {
  const token = `swm_agt_${"A".repeat(43)}`;
  const signalBody = "SECRET signal body that must not be durable";
  const request = {
    authorization: `Bearer ${token}`,
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: signalBody,
    },
  };
  const failure = durableCommandFailure({
    commandKind: String(request.command.kind),
    reason: "test_rollback",
    code: null,
    error: new Error("test rollback before step 15\u0000"),
    requestId: REQUEST_ID,
  });
  const stored = JSON.stringify(failure);

  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(signalBody), false);
  assert.equal(stored.includes("authorization"), false);
  assert.equal(stored.includes("body"), false);
  assert.equal(failure.detail.includes("\u0000"), false);
  assert.ok(failure.detail.length <= 512);
});
