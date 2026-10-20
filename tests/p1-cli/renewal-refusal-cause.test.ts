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

test("unknown or malformed issuance retains durable intent across repeated attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-renewal-wire-"));
  try {
    for (const [index, answer] of [
      { status: "accepted" },
      { status: "accepted", ok: true, agent_token: "bad" },
      { status: "rejected" },
      null, // A request whose reply was lost, rather than a decided rejection.
    ].entries()) {
      const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: join(directory, String(index)) });
      let current = NOW;
      const ids: string[] = [];
      const settings = { target, workspaceId: options.workspaceId,
        presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW + 60_000 },
        store, now: () => current, warn: () => {}, fetcher: (async (_input, init) => {
          ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
          if (answer === null) throw new TypeError("injected reply loss");
          return Response.json(answer);
        }) as typeof fetch,
      };
      let session = await AgentCredentialSession.open(settings);
      assert.equal(await session.bearer(), token, "live predecessor may continue after an unknown outcome");
      current = NOW + 60_000;
      for (let attempt = 0; attempt < 2; attempt++) {
        session = await AgentCredentialSession.open(settings);
        await assert.rejects(() => session.bearer(), RenewalRetryError);
      }
      assert.equal(ids.length, 3, "one bounded exchange per ambiguous attempt");
      assert.ok(ids.every((id) => id === ids[0]), "unknown outcomes retain the same id across reopen and expiry");
      assert.equal((await store.read())?.pendingRenewal?.commandId, ids[0]);
      assert.equal((await store.read())?.token, null, "unknown issuance never publishes a credential");
    }
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

// Fixed wire envelopes exercise request intent and durable publication. Real M3
// eligibility, supersession and policy authority stay in agent-credential-file.
test("decided renewal refusals preserve the saved successor and allow a fresh attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-decided-renewal-"));
  try {
    for (const listenerMode of [false, true]) {
      for (const row of [
        { status: 200, body: { status: "rejected", reason: "predecessor_pending_first_use" }, code: "predecessor_pending_first_use", type: RenewalRefused, remedy: /workspace owner/ },
        { status: 200, body: { status: "rejected", reason: "new_server_reason" }, code: "new_server_reason", type: RenewalRefused, remedy: /workspace owner/ },
        { status: 200, body: { status: "rejected", reason: "renewal_device_mismatch" }, code: "renewal_device_mismatch", type: RenewalRefused, remedy: /intended device/ },
        { status: 200, body: { status: "rejected", reason: "renewal_unsupported" }, code: null, type: RenewalUnsupported, remedy: /Ask whoever issued it/ },
      ]) {
        const root = `swm_agt_${randomBytes(32).toString("base64url")}`;
        const savedToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
        const successor = `swm_agt_${randomBytes(32).toString("base64url")}`;
        const principalId = randomUUID(), runId = randomUUID(), rootTokenId = randomUUID();
        const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(root), stateDirectory: directory });
        await store.write({ version: 1, rootTokenId, generation: 1, token: savedToken,
          tokenId: randomUUID(), principalId, runId, issuedAt: NOW - 3_600_001, expiresAt: NOW - 1,
          horizonExpiresAt: null, successorsRemaining: null, pendingRenewal: null });
        const ids: string[] = [], bodies: Record<string, unknown>[] = [];
        const durableIds: Array<string | undefined> = [], bearers: Array<string | null> = [];
        const settings = { target, workspaceId: randomUUID(), listenerMode, store,
          presented: { token: root, tokenId: rootTokenId, principalId, runId, expiresAt: NOW - 1 },
          now: () => NOW, warn: () => {}, fetcher: (async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            ids.push(String(body.command_id)); bodies.push(body);
            bearers.push(new Headers(init?.headers).get("authorization"));
            durableIds.push((await store.read())?.pendingRenewal?.commandId);
            return ids.length === 1 ? Response.json(row.body, { status: row.status }) : Response.json({
              status: "accepted", ok: true, agent_token: successor, token_id: randomUUID(),
              principal_id: principalId, run_id: runId, issued_at: NOW, expires_at: NOW + 3_600_000,
            });
          }) as typeof fetch };
        const session = await AgentCredentialSession.open(settings);
        await assert.rejects(() => session.bearer(), (error: unknown) => {
          if (listenerMode) return error instanceof RenewalRetryError;
          assert.ok(error instanceof row.type, "expired one-shot retains the actual refusal type");
          assert.match(error.message, row.remedy);
          if (error instanceof RenewalRefused) {
            assert.equal(error.status, row.status);
            assert.equal(error.code, row.code);
          }
          return true;
        });
        const retained = await store.read();
        assert.equal(retained?.pendingRenewal, null, "decided rejection is no longer replayed");
        assert.equal(retained?.token, savedToken, "last durable successor is retained");
        assert.equal(retained?.generation, 1);
        const reopened = await AgentCredentialSession.open(settings);
        assert.equal(await reopened.bearer(), successor);
        assert.equal(ids.length, 2);
        assert.deepEqual(durableIds, ids, "each intent is durable before HTTP");
        assert.deepEqual(bearers, [`Bearer ${savedToken}`, `Bearer ${savedToken}`]);
        assert.notEqual(ids[0], ids[1], "a decided refusal permits a fresh id next invocation");
        assert.deepEqual({ ...bodies[0], command_id: null }, { ...bodies[1], command_id: null });
        assert.equal((await store.read())?.generation, 2);
        assert.equal((await store.read())?.token, successor);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTP refusals retain lost-reply intent across reopen without authorizing expired work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-http-renewal-"));
  try {
    for (const listenerMode of [false, true]) {
      for (const status of [426, 400, 404, 429]) {
        const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token),
          stateDirectory: join(directory, String(listenerMode), String(status)) });
        const ids: string[] = [], durableIds: Array<string | undefined> = [];
        const principalId = randomUUID(), runId = randomUUID();
        const successor = "swm_agt_" + randomBytes(32).toString("base64url");
        const settings = { target, workspaceId: options.workspaceId, listenerMode, store,
          presented: { token, tokenId: randomUUID(), principalId, runId, expiresAt: NOW - 1 },
          now: () => NOW, warn: () => {}, fetcher: (async (_input, init) => {
            ids.push((JSON.parse(String(init?.body)) as { command_id: string }).command_id);
            durableIds.push((await store.read())?.pendingRenewal?.commandId);
            if (ids.length === 1) throw new TypeError("injected reply loss");
            if (ids.length === 2) return Response.json(status === 426
              ? { error: "upgrade_required", min_client_version: "999.0.0" }
              : { error: "proxy_refusal", status: "rejected", reason: "predecessor_pending_first_use" }, { status });
            return Response.json({ status: "accepted", ok: true, agent_token: successor,
              token_id: randomUUID(), principal_id: principalId, run_id: runId,
              issued_at: NOW, expires_at: NOW + 3_600_000 });
          }) as typeof fetch };
        let session = await AgentCredentialSession.open(settings);
        await assert.rejects(() => session.bearer(), RenewalRetryError);
        const uncertain = await store.read();
        assert.equal(uncertain?.pendingRenewal?.commandId, ids[0]);
        session = await AgentCredentialSession.open(settings);
        await assert.rejects(() => session.bearer(), (error: unknown) => {
          if (listenerMode && status !== 426) return error instanceof RenewalRetryError;
          assert.ok(error instanceof RenewalRefused);
          assert.equal(error.status, status);
          assert.equal(error.code, status === 426 ? "upgrade_required" : "proxy_refusal");
          if (status === 426) assert.match(error.message, /Update cswarm/);
          return true;
        });
        assert.deepEqual(await store.read(), uncertain, "HTTP refusal cannot discard lost-reply evidence");
        session = await AgentCredentialSession.open(settings);
        assert.equal(await session.bearer(), successor);
        assert.equal(ids.length, 3, "each invocation makes one bounded exchange");
        assert.ok(ids.every((id) => id === ids[0]), "recovery retains the original command id");
        assert.deepEqual(durableIds, ids, "pending intent was durable before every HTTP request");
        const recovered = await store.read();
        assert.equal(recovered?.token, successor);
        assert.equal(recovered?.generation, 1);
        assert.equal(recovered?.pendingRenewal, null);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("live refusal guidance preserves the current command outcome without asking to repeat work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-live-refusal-"));
  try {
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: directory });
    const warnings: string[] = [];
    const session = await AgentCredentialSession.open({ target, workspaceId: options.workspaceId, store,
      presented: { token, tokenId: randomUUID(), principalId: randomUUID(), runId: randomUUID(), expiresAt: NOW + 60_000 },
      now: () => NOW, warn: (message) => warnings.push(message),
      fetcher: (async () => Response.json({ status: "rejected", reason: "predecessor_pending_first_use" })) as typeof fetch });
    assert.equal(await session.bearer(), token, "a live bearer still serves the current command");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /this command went ahead/);
    assert.match(warnings[0]!, /workspace owner/);
    assert.doesNotMatch(warnings[0]!, /run the command again|repeat|rerun/i);
    assert.equal(await store.read(), null, "the actual stored rejection releases pending intent");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a first fresh null result retains intent; only a saved-id null replay permits one recovery id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-null-replay-"));
  try {
    const store = await agentCredentialStore({ target, lineageKey: credentialLineageKey(token), stateDirectory: directory });
    const principalId = randomUUID(), runId = randomUUID();
    const ids: string[] = [], bodies: Record<string, unknown>[] = [];
    const durableIds: Array<string | undefined> = [];
    const settings = { target, workspaceId: options.workspaceId, store, now: () => NOW, warn: () => {},
      presented: { token, tokenId: randomUUID(), principalId, runId, expiresAt: NOW - 1 },
      fetcher: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        ids.push(String(body.command_id)); bodies.push(body);
        durableIds.push((await store.read())?.pendingRenewal?.commandId);
        return Response.json({ status: "accepted", ok: true, token_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          principal_id: principalId, run_id: runId, issued_at: NOW, expires_at: NOW + 3_600_000 });
      }) as typeof fetch };
    await assert.rejects(() => AgentCredentialSession.open(settings).then((session) => session.bearer()), RenewalRetryError);
    assert.equal(ids.length, 1, "the first new request is not a replay");
    assert.deepEqual(durableIds, ids, "the first intent is durable before HTTP");
    assert.equal((await store.read())?.pendingRenewal?.commandId, ids[0]);
    const reopened = await AgentCredentialSession.open(settings);
    await assert.rejects(() => reopened.bearer(), RenewalRetryError);
    assert.equal(ids.length, 3, "one saved-id replay and at most one fresh-id request");
    assert.deepEqual(durableIds, ids, "all replay and recovery intents are durable before HTTP");
    assert.equal(ids[1], ids[0]);
    assert.notEqual(ids[2], ids[1]);
    assert.equal((await store.read())?.pendingRenewal?.commandId, ids[2], "latest uncertain request remains durable");
    assert.equal((await store.read())?.token, null, "null envelopes never authorize ordinary work");
    for (const body of bodies) assert.deepEqual({ ...body, command_id: null }, { ...bodies[0], command_id: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
