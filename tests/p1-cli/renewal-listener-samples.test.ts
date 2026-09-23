/** Renewal answers are server samples. A single refusal cannot establish local loss. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  AgentCredentialSession,
  RenewalCredentialCheckError,
  RenewalMalformedResponseError,
  RenewalOutcomeUnknown,
  RenewalReauthorisationRequired,
  RenewalRetryError,
  RenewalRevoked,
  RenewalSuspended,
  RenewalUpgradeRequiredError,
  requestSuccessor,
} from "../../src/cloud/renewal.js";
import type { AgentCredentialRecord, AgentCredentialStore } from "../../src/cloud/agent-credential.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { parseSignalAttachments, SignalAttachmentMalformedError } from "../../src/cloud/attachments.js";
import { classifySignalReadFailure } from "../../src/cloud/signals.js";
import { isFollowRenewalCredentialFailure } from "../../src/cli.js";

const NOW = 1_700_000_000_000;
const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
const fetchAnswer = (status: number, body: string): typeof fetch =>
  (async () => new Response(body, { status })) as typeof fetch;

function store(): AgentCredentialStore {
  let record: AgentCredentialRecord | null = null;
  return {
    location: "memory://renewal-refusal-cause",
    read: async () => record,
    write: async (next) => { record = next; },
    delete: async () => { record = null; },
    withLock: async (work) => work(),
  };
}

async function session(fetcher: typeof fetch, listenerMode: boolean): Promise<AgentCredentialSession> {
  return AgentCredentialSession.open({
    target, workspaceId: randomUUID(),
    presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW + 60_000 },
    store: store(), fetcher, listenerMode, now: () => NOW, warn: () => {},
  });
}

test("only a recognized renewal 401 is a credential-check sample", { timeout: 10_000 }, async () => {
  const options = { target, workspaceId: randomUUID(), predecessor: token, commandId: randomUUID(), listenerMode: true, now: () => NOW };
  await assert.rejects(() => requestSuccessor({ ...options, fetcher: fetchAnswer(401, '{"error":"unauthenticated"}') }),
    (error: unknown) => error instanceof RenewalCredentialCheckError && error.code === "unauthenticated");
  for (const [status, body] of [[401, "<html>foreign</html>"], [403, '{"error":"forbidden"}'], [404, "<html>foreign</html>"]] as const) {
    await assert.rejects(() => requestSuccessor({ ...options, fetcher: fetchAnswer(status, body) }),
      (error: unknown) => error instanceof RenewalOutcomeUnknown && !(error instanceof RenewalCredentialCheckError));
  }
});

test("listener renewal samples reach bearer and foreign answers retry without disabling renewal", { timeout: 10_000 }, async () => {
  const checked = await session(fetchAnswer(401, '{"error":"unauthenticated"}'), true);
  await assert.rejects(() => checked.bearer(), RenewalCredentialCheckError);
  let calls = 0;
  const foreign = await session((async () => { calls++; return new Response("<html>foreign</html>", { status: 404 }); }) as typeof fetch, true);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => foreign.bearer(), (error: unknown) =>
      error instanceof RenewalRetryError && error.expiresAt === NOW + 60_000);
  }
  assert.equal(calls, 2);
  assert.equal(foreign.expiry, NOW + 60_000);
});

test("ordinary one-shot commands keep using a live token during a foreign renewal answer", { timeout: 10_000 }, async () => {
  const ordinary = await session(fetchAnswer(404, "<html>foreign</html>"), false);
  assert.equal(await ordinary.bearer(), token);
});

test("malformed successful renewal is tagged and a measured domain revocation remains local", { timeout: 10_000 }, async () => {
  const options = { target, workspaceId: randomUUID(), predecessor: token, commandId: randomUUID(), listenerMode: true, now: () => NOW };
  await assert.rejects(() => requestSuccessor({ ...options, fetcher: fetchAnswer(200, "[]") }), RenewalMalformedResponseError);
  await assert.rejects(() => requestSuccessor({ ...options, fetcher: fetchAnswer(200, '{"status":"rejected","reason":"renewal_lineage_revoked"}') }), RenewalRevoked);
});

test("recognized renewal version gate stops while a foreign 426 retries", { timeout: 10_000 }, async () => {
  const upgrade = await session(fetchAnswer(426, '{"error":"upgrade_required","min_client_version":"9.0.0"}'), true);
  await assert.rejects(() => upgrade.bearer(), RenewalUpgradeRequiredError);
  const foreign = await session(fetchAnswer(426, '{"error":"other"}'), true);
  await assert.rejects(() => foreign.bearer(), RenewalRetryError);
});

test("listener retries foreign renewal until the known token expiry", { timeout: 10_000 }, async () => {
  let current = NOW;
  let calls = 0;
  const expiring = await AgentCredentialSession.open({
    target, workspaceId: randomUUID(),
    presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW + 60_000 },
    store: store(), listenerMode: true, now: () => current, warn: () => {},
    fetcher: (async () => { calls++; return new Response("<html>foreign</html>", { status: 404 }); }) as typeof fetch,
  });
  await assert.rejects(() => expiring.bearer(), RenewalRetryError);
  current = NOW + 60_000;
  await assert.rejects(() => expiring.bearer(), (error: unknown) =>
    error instanceof RenewalRevoked && error.code === "predecessor_expired_local");
  assert.equal(calls, 2);
});

test("named renewal domain refusals retry before token expiry", { timeout: 10_000 }, async () => {
  for (const reason of ["renewal_unsupported", "renewal_device_mismatch"] as const) {
    const credential = await session(fetchAnswer(200, JSON.stringify({ status: "rejected", reason })), true);
    await assert.rejects(() => credential.bearer(), (error: unknown) =>
      error instanceof RenewalRetryError && error.expiresAt === NOW + 60_000);
  }
});

test("one-shot bearer preserves a9846955 outcomes across renewal answers", { timeout: 15_000 }, async () => {
  // Expected outcomes come from a9846955: requestSuccessor maps 400/404 to
  // RenewalUnsupported; bearer latches it, warns and uses a live predecessor.
  // Only revoked, reauthorisation and suspension throw with that predecessor.
  const cases = [
    { name: "unsupported", status: 200, body: '{"status":"rejected","reason":"renewal_unsupported"}', outcome: "latch", warning: "this credential was issued without a renewal window" },
    { name: "missing grant", status: 200, body: '{"status":"rejected","reason":"renewal_grant_not_found"}', outcome: "latch" },
    { name: "wrong device", status: 200, body: '{"status":"rejected","reason":"renewal_device_mismatch"}', outcome: "warn", warning: "The standing grant is bound to another device" },
    { name: "missing device", status: 200, body: '{"status":"rejected","reason":"renewal_device_unavailable"}', outcome: "warn" },
    { name: "upgrade", status: 426, body: '{"error":"upgrade_required","min_client_version":"9.0.0"}', outcome: "warn", warning: "This copy of cswarm is older than the deployment accepts (minimum 9.0.0)" },
    { name: "http 400", status: 400, body: '{}', outcome: "latch", warning: "this deployment does not offer credential renewal yet" },
    { name: "http 404", status: 404, body: '{}', outcome: "latch" },
    { name: "http 500", status: 500, body: '{}', outcome: "warn" },
    { name: "http 429", status: 429, body: '{"error":"rate_limited"}', outcome: "warn", warning: "The deployment did not renew this credential (HTTP 429)" },
    { name: "http 418", status: 418, body: '{}', outcome: "warn" },
    { name: "http 302", status: 302, body: '{}', outcome: "warn" },
    { name: "unknown rejection", status: 200, body: '{"status":"rejected","reason":"new_reason"}', outcome: "warn" },
    { name: "malformed successor", status: 200, body: '{"status":"accepted","agent_token":"bad"}', outcome: "warn" },
    { name: "empty accepted answer", status: 200, body: '{"status":"accepted"}', outcome: "revoked" },
    { name: "grant suspended", status: 200, body: '{"status":"rejected","reason":"renewal_grant_suspended"}', outcome: "suspended" },
    { name: "horizon reached", status: 200, body: '{"status":"rejected","reason":"renewal_horizon_reached"}', outcome: "reauthorise" },
    { name: "successors exhausted", status: 200, body: '{"status":"rejected","reason":"renewal_successors_exhausted"}', outcome: "reauthorise" },
    { name: "foreign 401", status: 401, body: "<html>wrong edge</html>", outcome: "revoked" },
    { name: "foreign 403", status: 403, body: "<html>wrong edge</html>", outcome: "revoked" },
    { name: "revoked", status: 200, body: '{"status":"rejected","reason":"renewal_lineage_revoked"}', outcome: "revoked" },
  ] as const;
  let checked = 0;
  for (const row of cases) {
    let calls = 0;
    const warnings: string[] = [];
    const credential = await AgentCredentialSession.open({
      target, workspaceId: randomUUID(),
      presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW + 60_000 },
      store: store(), now: () => NOW, warn: (warning) => warnings.push(warning),
      fetcher: (async () => { calls++; return new Response(row.body, { status: row.status }); }) as typeof fetch,
    });
    if (row.outcome === "revoked" || row.outcome === "suspended" || row.outcome === "reauthorise") {
      const expected = row.outcome === "revoked" ? RenewalRevoked
        : row.outcome === "suspended" ? RenewalSuspended : RenewalReauthorisationRequired;
      await assert.rejects(() => credential.bearer(), expected, row.name);
      assert.equal(warnings.length, 0, row.name);
    } else {
      assert.equal(await credential.bearer(), token, row.name);
      assert.equal(warnings.length, 1, row.name);
      if ("warning" in row) assert.ok(warnings[0]?.includes(row.warning), row.name);
      assert.equal(calls, 1, row.name);
      if (row.outcome === "latch") {
        assert.equal(await credential.bearer(), token, row.name);
        assert.equal(calls, 1, row.name);
      }
    }
    checked++;
  }
  assert.equal(checked, cases.length);
});

test("one-shot 401 and 403 remain fatal even when the response body is foreign", { timeout: 10_000 }, async () => {
  for (const status of [401, 403]) {
    const credential = await session(fetchAnswer(status, "<html>foreign</html>"), false);
    await assert.rejects(() => credential.bearer(), (error: unknown) =>
      error instanceof RenewalRevoked && error.code === "forbidden" &&
      /does not say why/.test(error.message));
  }
});

test("attachment parser failures have a retryable response tag", () => {
  for (const value of [null, [{}], Array(9).fill({})]) {
    assert.throws(() => parseSignalAttachments(value), (error: unknown) =>
      error instanceof SignalAttachmentMalformedError &&
      classifySignalReadFailure(error).code === "malformed_response");
  }
});

test("follow treats a renewal credential sample as a credential stop", () => {
  assert.equal(isFollowRenewalCredentialFailure(new RenewalCredentialCheckError(401, "unauthenticated")), true);
  assert.equal(isFollowRenewalCredentialFailure(new RenewalOutcomeUnknown("foreign answer")), false);
});
