import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionPolicyFields, connectionPolicyCopy, connectionPolicyState, grantRiskBadge, type GrantRiskInput } from "../../lib/standing-grants";
const now = Date.parse("2026-10-20T12:00:00Z");
const live: GrantRiskInput = { kind: "standing", horizonExpiresAt: null, boundDeviceId: "device", lastUsedAt: null,
  issuedAt: "2026-01-01T00:00:00Z", newHostAt: null, suspendedAt: null, revokedAt: null };
// Authoring gate: display contract independent of kind/technical lease, never backend authority proof.
test("only a confirmed live connection with two explicit NULLs promises continuity", () => {
  for (const row of [{}, { connection_expires_at: null }, { connection_expired_at: null },
    { connection_expires_at: "2026-02-30T00:00:00Z", connection_expired_at: null },
    { connection_expires_at: null, connection_expired_at: false }]) {
    assert.equal(connectionPolicyCopy(connectionPolicyFields(row), true, now), "Connection settings are managed by the server.");
  }
  const policy = connectionPolicyFields({ connection_expires_at: null, connection_expired_at: null });
  assert.equal(connectionPolicyCopy(policy, true, now), "Stays connected until you remove it");
  assert.equal(connectionPolicyState(policy, false, now), "unknown");
  assert.equal(connectionPolicyCopy({}, true, now), "Connection settings are managed by the server.");
  assert.equal(connectionPolicyState(connectionPolicyFields({ connection_expires_at: "2027-01-01T00:00:00+00:00", connection_expired_at: null }), true, now), "dated");
});

test("canonical elapsed policy and security beat device facts without an idle or horizon warning", () => {
  const ended = { ...live, connectionExpiresAt: new Date(now).toISOString(), connectionExpiredAt: null, newHostAt: "2026-10-20T00:00:00Z" };
  assert.equal(connectionPolicyCopy(ended, true, now), "Connection ended");
  assert.equal(grantRiskBadge(ended, now), "ENDED");
  assert.equal(grantRiskBadge({ ...ended, suspendedAt: "2026-10-19T00:00:00Z" }, now), "SUSPENDED");
  assert.equal(grantRiskBadge({ ...ended, revokedAt: "2026-10-19T00:00:00Z" }, now), "REVOKED");
  assert.equal(connectionPolicyState({ connectionExpiredAt: "2026-10-19T00:00:00Z" }, true, now), "ended");
  assert.equal(grantRiskBadge(live, now), null);
  assert.equal(grantRiskBadge({ ...live, kind: "timeboxed", horizonExpiresAt: "2026-01-02T00:00:00Z" }, now), null);
});

test("device warnings remain distinct, below terminal and security facts", () => {
  assert.equal(grantRiskBadge({ ...live, newHostAt: "2026-10-19T00:00:00Z", boundDeviceId: null }, now), "NEW HOST");
  assert.equal(grantRiskBadge({ ...live, boundDeviceId: null }, now), "UNBOUND");
  assert.equal(grantRiskBadge({ ...live, boundDeviceId: null, revokedAt: "2026-10-19T00:00:00Z" }, now), "REVOKED");
});

import { resumeRenewalGrant } from "../../lib/commonswarm";
// Real exported transport, not a private declaration with an injected command function.
test("Resume preserves its wire identity and public refusal without retrying", async () => {
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const calls: any[] = [];
  let status = 200;
  try {
    globalThis.document = { querySelector: (selector: string) => ({ content: selector.includes("commonswarm:url") ? "https://synthetic.invalid" : "synthetic-public" }) } as unknown as Document;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      calls.push(JSON.parse(init.body));
      return { status, text: async () => JSON.stringify(status === 200 ? { status: "accepted" } : { error: "forbidden" }) };
    }) as typeof fetch;
    const session = { access_token: "synthetic", user: { id: "owner" } } as any;
    await resumeRenewalGrant(session, "request", "workspace", "exact-grant");
    assert.deepEqual(calls[0].command, { kind: "resume_renewal_grant", renewal_grant_id: "exact-grant" });
    assert.equal(calls[0].workspace_id, "workspace");
    status = 403;
    await assert.rejects(resumeRenewalGrant(session, "refused", "workspace", "exact-grant"), /This key cannot be resumed with your current access/);
    status = 503;
    await assert.rejects(resumeRenewalGrant(session, "unknown", "workspace", "exact-grant"), /Resume was not confirmed/);
    assert.equal(calls.length, 3);
  } finally { globalThis.document = originalDocument; globalThis.fetch = originalFetch; }
});

// Authoring gate: presence validation is owned here; malformed must never be coerced into permanent NULL.
test("canonical projection retains absent, explicit NULL and present malformed separately", () => {
  const missing = connectionPolicyFields({});
  const explicit = connectionPolicyFields({ connection_expires_at: null, connection_expired_at: null });
  const malformed = connectionPolicyFields({ connection_expires_at: "2026-02-30T00:00:00Z", connection_expired_at: false });
  assert.equal(Object.hasOwn(missing, "connectionExpiresAt"), false);
  assert.equal(Object.hasOwn(missing, "connectionExpiredAt"), false);
  assert.deepEqual(explicit, { connectionExpiresAt: null, connectionExpiredAt: null });
  assert.equal(Object.hasOwn(malformed, "connectionExpiresAt"), true);
  assert.equal(Object.hasOwn(malformed, "connectionExpiredAt"), true);
  assert.equal(malformed.connectionExpiresAt, undefined);
  assert.equal(malformed.connectionExpiredAt, undefined);
  assert.equal(connectionPolicyState(malformed, true, now), "unknown");
  const chosen = connectionPolicyFields({ connection_expires_at: "2027-01-02T03:04:05Z", connection_expired_at: null });
  assert.equal(chosen.connectionExpiresAt, "2027-01-02T03:04:05Z");
  assert.equal(connectionPolicyState(chosen, true, now), "dated");
});
