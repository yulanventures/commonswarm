/** Protocol classification only; authority and recovery are owned by the real M3 gate. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCredentialSession, RenewalCredentialCheckError, RenewalOutcomeUnknown,
  RenewalRevoked, RenewalRetryError, RenewalSuspended, requestSuccessor } from "../../src/cloud/renewal.js";
import { agentCredentialStore, credentialLineageKey } from "../../src/cloud/agent-credential.js";
import { cloudTarget } from "../../src/cloud/config.js";

const NOW = 1_700_000_000_000;
const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
const options = { target, workspaceId: randomUUID(), predecessor: token, commandId: randomUUID(), now: () => NOW };

// These fixed envelopes test parsing/classification, not a simulated renewal server.
test("generic HTTP auth refusals never invent expiry or revocation causes", async () => {
  for (const expiresAt of [null, NOW - 1, NOW + 60_000]) {
    for (const listenerMode of [false, true]) {
      for (const row of [
        { status: 401, body: { error: "unauthenticated" }, type: RenewalCredentialCheckError },
        { status: 401, body: { error: "forbidden" }, type: RenewalOutcomeUnknown },
        { status: 403, body: { error: "forbidden" }, type: RenewalOutcomeUnknown },
      ]) {
        await assert.rejects(() => requestSuccessor({ ...options, expiresAt, listenerMode,
          fetcher: (async () => Response.json(row.body, { status: row.status })) as typeof fetch }),
          (error: unknown) => error instanceof row.type && !(error instanceof RenewalRevoked));
      }
    }
  }
});

test("recognized domain revocation and security suspension stay authoritative", async () => {
  for (const row of [
    { reason: "renewal_lineage_revoked", type: RenewalRevoked },
    { reason: "renewal_grant_revoked", type: RenewalRevoked },
    { reason: "predecessor_revoked", type: RenewalRevoked },
    { reason: "renewal_grant_suspended", type: RenewalSuspended },
  ]) {
    for (const listenerMode of [false, true]) {
      await assert.rejects(() => requestSuccessor({ ...options, expiresAt: NOW - 1, listenerMode,
        fetcher: (async () => Response.json({ status: "rejected", reason: row.reason })) as typeof fetch }), row.type);
    }
  }
});

test("a malformed success never authorizes fresh-id recovery and an outage retains durable intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-renewal-wire-"));
  try {
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: directory });
    let calls = 0;
    const ids: string[] = [];
    const session = await AgentCredentialSession.open({ target, workspaceId: options.workspaceId,
      presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW - 1 },
      store, now: () => NOW, warn: () => {}, fetcher: (async (_input, init) => {
        calls++; ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
        return Response.json({ status: "accepted" });
      }) as typeof fetch,
    });
    await assert.rejects(() => session.bearer(), RenewalRetryError);
    await assert.rejects(() => session.bearer(), RenewalRetryError);
    assert.equal(calls, 2, "malformed acceptance must not spend a fresh-id request");
    assert.equal(ids[0], ids[1], "ambiguous responses retain the original id");
    assert.equal((await store.read())?.pendingRenewal?.commandId, ids[0]);
    assert.equal((await store.read())?.token, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
