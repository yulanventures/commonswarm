import assert from "node:assert/strict";
import { test } from "node:test";
import { signOutEverywhere, signOutOtherDevices } from "./commonswarm.ts";

// Sign out other devices succeeds only on GoTrue's accepted logout (204), with this session's token.
const target = { url: "https://api.example.test", anonKey: "public-anon" };
const session = { access_token: "caller-access-token" };
const respond = (status) => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(status === 204 ? null : "{}", { status }); };
  return { calls, fetcher };
};

test("sends a strict scope=others logout with the caller's own token and the public key", async () => {
  const { calls, fetcher } = respond(204);
  await signOutOtherDevices(session, { fetcher, target });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/auth/v1/logout?scope=others");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer caller-access-token", apikey: "public-anon" });
});

test("a missing session never calls logout and never claims success", async () => {
  for (const missing of [null, {}, { access_token: "" }]) {
    const { calls, fetcher } = respond(204);
    await assert.rejects(signOutOtherDevices(missing, { fetcher, target }), /No device was signed out/);
    assert.equal(calls.length, 0);
  }
});

test("401, 403 and 404 are refusals, not success", async () => {
  for (const status of [401, 403, 404]) {
    const { fetcher } = respond(status);
    await assert.rejects(signOutOtherDevices(session, { fetcher, target }), /No device was signed out/, String(status));
  }
});

test("any other status, a network failure or a timeout is an unknown outcome", async () => {
  for (const status of [200, 400, 429, 500, 503]) {
    const { fetcher } = respond(status);
    await assert.rejects(signOutOtherDevices(session, { fetcher, target }), /could not confirm/, String(status));
  }
  await assert.rejects(signOutOtherDevices(session, { fetcher: async () => { throw new TypeError("network"); }, target }), /could not confirm/);
  await assert.rejects(signOutOtherDevices(session, { fetcher: async () => respond(204).fetcher(), target: null }), /not configured/);
});

test("after a password change, every session ends with scope=global and the same strict rules", async () => {
  const { calls, fetcher } = respond(204);
  await signOutEverywhere(session, { fetcher, target });
  assert.equal(calls[0].url, "https://api.example.test/auth/v1/logout?scope=global");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer caller-access-token", apikey: "public-anon" });
  for (const status of [401, 500]) {
    await assert.rejects(signOutEverywhere(session, { fetcher: respond(status).fetcher, target }), /signed out/, String(status));
  }
  await assert.rejects(signOutEverywhere(null, { fetcher, target }), /No device was signed out/);
});
