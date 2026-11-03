import assert from "node:assert/strict";
import { test } from "node:test";
import { PasswordSignInRefused, signInWithPassword } from "./commonswarm.ts";

// Password sign-in: one refusal for wrong password, unknown address or no password set.
const auth = (error) => {
  const calls = [];
  return { calls, signInWithPassword: async (input) => { calls.push(input); return { data: {}, error }; } };
};

test("passes the typed credentials through and resolves on success", async () => {
  const fake = auth(null);
  await signInWithPassword("tom@example.com", "correct horse", fake);
  assert.deepEqual(fake.calls, [{ email: "tom@example.com", password: "correct horse" }]);
});

test("wrong password, unknown address and no password share one message", async () => {
  const messages = new Set();
  for (const error of [{ status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    { status: 400, code: "", message: "Invalid login credentials" }, { status: 422, code: "validation_failed", message: "x" }]) {
    await assert.rejects(signInWithPassword("a@example.com", "pw", auth(error)), (caught) => {
      assert.ok(caught instanceof PasswordSignInRefused);
      messages.add(caught.message);
      return true;
    });
  }
  assert.equal(messages.size, 1);
  assert.match([...messages][0], /email link/);
});

test("rate limits, unconfirmed addresses and other failures say what to do", async () => {
  await assert.rejects(signInWithPassword("a@example.com", "pw", auth({ status: 429, code: "over_request_rate_limit", message: "x" })), /Too many sign-in attempts/);
  await assert.rejects(signInWithPassword("a@example.com", "pw", auth({ status: 400, code: "email_not_confirmed", message: "x" })), /Confirm your address/);
  await assert.rejects(signInWithPassword("a@example.com", "pw", auth({ status: 500, code: "unexpected_failure", message: "x" })), /could not be completed/);
});
