import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createLogger, subscribeProviderErrors } from "../src/logger.js";

const GRANT = "AbCdEfGh_secret-remainder-of-grant-id";
const ACCOUNT = "0123abcd-1111-4111-8111-111111111111";

function harness() {
  const provider = new EventEmitter();
  const lines = [];
  let clock = Date.parse("2026-11-03T10:00:00.000Z");
  subscribeProviderErrors(provider, createLogger(line => lines.push(line)), { now: () => clock });
  const ctx = (route, entities = {}) => ({ oidc: { route, entities }, res: { getHeader: () => undefined } });
  return { provider, lines, ctx, advance: ms => { clock += ms; } };
}

test("grant.revoked at the token route emits one access_lost line with prefixes only", () => {
  const { provider, lines, ctx } = harness();
  provider.emit("grant.revoked", ctx("token", { RefreshToken: { accountId: ACCOUNT } }), GRANT);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "access_lost", class: "hosted_family_retired", principal_ref: null,
    owner_ref: "0123abcd", grant_ref: "AbCdEfGh", at: "2026-11-03T10:00:00.000Z",
  });
  assert.equal(lines[0].includes("secret-remainder"), false);
  assert.equal(lines[0].includes(ACCOUNT), false);
});

test("code reuse falls back to the Grant account and tolerates no entities", () => {
  const { provider, lines, ctx } = harness();
  provider.emit("grant.revoked", ctx("token", { Grant: { accountId: ACCOUNT } }), "grant-one-xyz");
  provider.emit("grant.revoked", ctx("token"), "grant-two-xyz");
  assert.deepEqual(lines.map(line => JSON.parse(line).owner_ref), ["0123abcd", null]);
});

test("a client revoking its own token at the revocation route does not emit", () => {
  const { provider, lines, ctx } = harness();
  provider.emit("grant.revoked", ctx("revocation", { RefreshToken: { accountId: ACCOUNT } }), GRANT);
  provider.emit("grant.revoked", { oidc: undefined }, GRANT);
  assert.deepEqual(lines, []);
});

test("one line per grant per 60 seconds", () => {
  const { provider, lines, ctx, advance } = harness();
  for (let i = 0; i < 5; i++) provider.emit("grant.revoked", ctx("token"), GRANT);
  provider.emit("grant.revoked", ctx("token"), "OtherGrant-1234");
  assert.equal(lines.length, 2);
  advance(59_999);
  provider.emit("grant.revoked", ctx("token"), GRANT);
  assert.equal(lines.length, 2);
  advance(1);
  provider.emit("grant.revoked", ctx("token"), GRANT);
  assert.equal(lines.length, 3);
});
