/** Protocol classification only; authority and recovery are owned by the real M3 gate. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCredentialSession, RenewalCredentialCheckError, RenewalOutcomeUnknown,
  RenewalRevoked, RenewalRetryError, RenewalSuspended, RenewalUnsupported, RenewalRefused, requestSuccessor } from "../../src/cloud/renewal.js";
import { agentCredentialStore, credentialLineageKey } from "../../src/cloud/agent-credential.js";
import { ThinCommandClient, CommandHttpError } from "../../src/cloud/command-client.js";
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

// Transport ownership only: fixed refusals check the trigger and exact replay,
// while the real M3 gate owns whether any opaque proof can receive a successor.
test("command recovery is agent-only, exact-code and at most one identical replay", async () => {
  for (const row of [
    { status: 401, code: "unauthenticated", credential: token, recover: true },
    { status: 403, code: "unauthenticated", credential: token, recover: false },
    { status: 401, code: "forbidden", credential: token, recover: false },
    { status: 401, code: "fresh_auth_required", credential: token, recover: false },
    { status: 500, code: "unauthenticated", credential: token, recover: false },
    { status: 401, code: "unauthenticated", credential: "human-access", recover: false },
  ]) {
    const bodies: string[] = [], bearers: string[] = [];
    let recoveries = 0;
    const client = new ThinCommandClient(target, (async (_input, init) => {
      bodies.push(String(init?.body));
      bearers.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({ error: row.code }, { status: row.status });
    }) as typeof fetch);
    await assert.rejects(() => client.send({ workspaceId: options.workspaceId,
      stream: { kind: "workspace" }, command: { kind: "create", task_id: randomUUID(), slug: "transport" },
      credential: row.credential,
    }, async (rejected) => {
      assert.equal(rejected, token); recoveries++;
      return `swm_agt_${"N".repeat(43)}`;
    }), CommandHttpError);
    assert.equal(recoveries, row.recover ? 1 : 0);
    assert.equal(bodies.length, row.recover ? 2 : 1);
    if (row.recover) {
      assert.equal(bodies[1], bodies[0], "original generated id and body survive replay");
      assert.notEqual(bearers[1], bearers[0], "only the authorized bearer changes");
    }
  }
});

test("unknown-expiry sessions leave live proof untouched and keep recovery outages bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-unknown-wire-"));
  try {
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: directory });
    const ids: string[] = [];
    const session = await AgentCredentialSession.open({ target, workspaceId: options.workspaceId,
      presented: { token, tokenId: null, principalId: null, runId: null, expiresAt: null }, store,
      fetcher: (async (_input, init) => {
        ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
        throw new TypeError("injected outage");
      }) as typeof fetch,
    });
    assert.equal(await session.bearer(), token);
    assert.equal(ids.length, 0, "unknown metadata never proactively rotates live proof");
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(() => session.recoverUnauthenticated(token), RenewalRetryError);
      assert.equal(ids.length, attempt + 1, "one request per bounded recovery operation");
    }
    assert.equal(ids[0], ids[1], "ambiguous recovery retains pending id");
    assert.equal((await store.read())?.token, null, "no invented successor or metadata");
    for (const row of [
      { status: 200, body: { status: "rejected", reason: "renewal_unsupported" }, type: RenewalUnsupported },
      { status: 200, body: { status: "rejected", reason: "renewal_grant_revoked" }, type: RenewalRevoked },
      { status: 200, body: { status: "rejected", reason: "renewal_grant_suspended" }, type: RenewalSuspended },
      { status: 426, body: { error: "upgrade_required", min_client_version: "999.0.0" }, type: RenewalRefused },
    ]) {
      const refused = await AgentCredentialSession.open({ target, workspaceId: options.workspaceId,
        presented: { token, tokenId: null, principalId: null, runId: null, expiresAt: null }, store,
        fetcher: (async () => Response.json(row.body, { status: row.status })) as typeof fetch });
      await assert.rejects(() => refused.recoverUnauthenticated(token), row.type,
        "confirmed refusals must retain their cause rather than becoming a retry");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
