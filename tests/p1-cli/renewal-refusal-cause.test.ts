/** Renewal answers are server samples. A single refusal cannot establish local loss. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  AgentCredentialSession,
  RenewalCredentialCheckError,
  RenewalMalformedResponseError,
  RenewalOutcomeUnknown,
  RenewalRetryError,
  RenewalRevoked,
  RenewalUpgradeRequiredError,
  requestSuccessor,
} from "../../src/cloud/renewal.js";
import type { AgentCredentialRecord, AgentCredentialStore } from "../../src/cloud/agent-credential.js";
import { cloudTarget } from "../../src/cloud/config.js";

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
  const options = { target, workspaceId: randomUUID(), predecessor: token, commandId: randomUUID(), now: () => NOW };
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
  const options = { target, workspaceId: randomUUID(), predecessor: token, commandId: randomUUID(), now: () => NOW };
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
