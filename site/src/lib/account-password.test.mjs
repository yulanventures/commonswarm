import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MIN_LENGTH, PasswordCodeRequired, sendPasswordCode, setPassword } from "./commonswarm.ts";

// A fake auth client that records calls and answers with the given GoTrue error (or success).
const auth = (error = null) => {
  const calls = [];
  return {
    calls,
    updateUser: async (attributes) => { calls.push(["updateUser", attributes]); return { data: {}, error }; },
    reauthenticate: async () => { calls.push(["reauthenticate"]); return { data: {}, error }; },
  };
};
const good = "correct horse battery";

test("the minimum is 12 characters and a short password never reaches GoTrue", async () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  const fake = auth();
  await assert.rejects(setPassword("elevenchars", undefined, fake), /at least 12/);
  assert.deepEqual(fake.calls, []);
});

test("a fresh session sets the password with no nonce; a code is sent trimmed as the nonce", async () => {
  const fresh = auth();
  await setPassword(good, undefined, fresh);
  assert.deepEqual(fresh.calls, [["updateUser", { password: good }]]);
  const coded = auth();
  await setPassword(good, " 123456 ", coded);
  assert.deepEqual(coded.calls, [["updateUser", { password: good, nonce: "123456" }]]);
});

test("reauthentication_needed becomes PasswordCodeRequired; sending a code calls reauthenticate", async () => {
  await assert.rejects(setPassword(good, undefined, auth({ status: 400, code: "reauthentication_needed" })),
    (error) => error instanceof PasswordCodeRequired);
  const fake = auth();
  await sendPasswordCode(fake);
  assert.deepEqual(fake.calls, [["reauthenticate"]]);
});

test("GoTrue refusals map to fixed copy and never echo GoTrue text", async () => {
  const cases = [
    [{ status: 400, code: "reauthentication_not_valid", message: "secret detail" }, /wrong or expired/],
    [{ status: 422, code: "weak_password", message: "secret detail" }, /at least 12 characters, and avoid common/],
    [{ status: 422, code: "same_password", message: "secret detail" }, /already your password/],
    [{ status: 429, code: "over_request_rate_limit", message: "secret detail" }, /Too many attempts/],
    [{ status: 401, code: "bad_jwt", message: "secret detail" }, /Sign in again/],
    [{ status: 500, code: "unexpected_failure", message: "secret detail" }, /was not changed/],
  ];
  for (const [error, copy] of cases) {
    await assert.rejects(setPassword(good, "123456", auth(error)), (thrown) => copy.test(thrown.message) && !thrown.message.includes("secret"), error.code);
  }
  await assert.rejects(sendPasswordCode(auth({ status: 429, code: "over_email_send_rate_limit", message: "secret" })), /Too many attempts/);
});
