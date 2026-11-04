/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentEntityView } from "./entity-panel.ts";

const agent = { principalId: "p", name: "Wren", model: null, ownerUserId: "u" };
const live = {
  tokenId: "t", issuedAt: "2026-10-08T18:04:54Z", expiresAt: "2026-11-07T18:04:54Z",
  firstUsedAt: null, revokedAt: null, grantKind: "standing", grantRevokedAt: null, suspendedAt: null,
};
const label = (status) => agentEntityView(agent, status, "Owner", (value) => value).expiresLabel;

test("a live standing grant's token end reads as a rotation, never an expiry", () => {
  assert.equal(label(live), "Token rotates");
  assert.equal(agentEntityView(agent, live, "Owner", (value) => value).expiresAt, "2026-11-07T18:04:54Z");
});

test("Expires stays for timeboxed, revoked, paused or unknown access", () => {
  assert.equal(label({ ...live, grantKind: "timeboxed" }), "Expires");
  assert.equal(label({ ...live, revokedAt: "2026-11-01T00:00:00Z" }), "Expires");
  assert.equal(label({ ...live, grantRevokedAt: "2026-11-01T00:00:00Z" }), "Expires");
  assert.equal(label({ ...live, suspendedAt: "2026-11-01T00:00:00Z" }), "Expires");
  assert.equal(label({ ...live, grantKind: undefined }), "Expires");
  assert.equal(label(undefined), "Expires");
});
