import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MIN_LENGTH, PasswordCodeRequired, sendPasswordCode, setPassword } from "./commonswarm.ts";

// GoTrue is called directly with the given session's own token, never the SDK's current session.
const target = { url: "https://api.example.test", anonKey: "public-anon" };
const mine = { access_token: "account-a-token" };
const respond = (status, body = {}) => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
  return { calls, options: { fetcher, target } };
};
const good = "correct horse battery";

test("the minimum is 12 characters and a short password never reaches GoTrue", async () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  const { calls, options } = respond(200);
  await assert.rejects(setPassword(mine, "elevenchars", undefined, options), /at least 12/);
  assert.equal(calls.length, 0);
});

test("set password is PUT /auth/v1/user with this session's token; a code is sent trimmed as the nonce", async () => {
  const fresh = respond(200);
  await setPassword(mine, good, undefined, fresh.options);
  assert.equal(fresh.calls[0].url, "https://api.example.test/auth/v1/user");
  assert.equal(fresh.calls[0].init.method, "PUT");
  assert.equal(fresh.calls[0].init.headers.authorization, "Bearer account-a-token");
  assert.equal(fresh.calls[0].init.headers.apikey, "public-anon");
  assert.deepEqual(JSON.parse(fresh.calls[0].init.body), { password: good });
  const coded = respond(200);
  await setPassword(mine, good, " 123456 ", coded.options);
  assert.deepEqual(JSON.parse(coded.calls[0].init.body), { password: good, nonce: "123456" });
});

test("without a session nothing is sent", async () => {
  for (const missing of [null, {}, { access_token: "" }]) {
    const set = respond(200);
    await assert.rejects(setPassword(missing, good, undefined, set.options), /Sign in again/);
    const code = respond(200);
    await assert.rejects(sendPasswordCode(missing, code.options), /Sign in again/);
    assert.equal(set.calls.length + code.calls.length, 0);
  }
});

test("reauthentication_needed becomes PasswordCodeRequired; a code is GET /auth/v1/reauthenticate with this token", async () => {
  await assert.rejects(setPassword(mine, good, undefined, respond(400, { code: 400, error_code: "reauthentication_needed" }).options),
    (error) => error instanceof PasswordCodeRequired);
  const sent = respond(200);
  await sendPasswordCode(mine, sent.options);
  assert.equal(sent.calls[0].url, "https://api.example.test/auth/v1/reauthenticate");
  assert.equal(sent.calls[0].init.method, "GET");
  assert.equal(sent.calls[0].init.headers.authorization, "Bearer account-a-token");
});

test("GoTrue refusals map to fixed copy and never echo GoTrue text", async () => {
  const cases = [
    [400, "reauthentication_not_valid", /wrong or expired/],
    [422, "weak_password", /at least 12 characters, and avoid common/],
    [422, "same_password", /already your password/],
    [429, "over_request_rate_limit", /Too many attempts/],
    [401, "bad_jwt", /Sign in again/],
    [500, "unexpected_failure", /was not changed/],
  ];
  for (const [status, error_code, copy] of cases) {
    await assert.rejects(setPassword(mine, good, "123456", respond(status, { code: status, error_code, msg: "secret detail" }).options),
      (thrown) => copy.test(thrown.message) && !thrown.message.includes("secret"), error_code);
  }
  await assert.rejects(sendPasswordCode(mine, respond(429, { error_code: "over_email_send_rate_limit", msg: "secret" }).options), /Too many attempts/);
});
