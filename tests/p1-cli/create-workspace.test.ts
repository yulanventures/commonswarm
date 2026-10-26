import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assertWorkspaceName,
  ThinCommandClient,
  WORKSPACE_NAME_MAX_LENGTH,
} from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";

function accepted(workspaceId: string): Response {
  return new Response(
    JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      workspace_id: workspaceId,
      stream_id: randomUUID(),
      min_client_version: "0.1.0",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("workspace names are bounded before the round trip", () => {
  assert.equal(WORKSPACE_NAME_MAX_LENGTH, 80);
  assert.doesNotThrow(() => assertWorkspaceName("a"));
  assert.doesNotThrow(() => assertWorkspaceName("x".repeat(80)));
  assert.throws(() => assertWorkspaceName(""), /workspace name is required/);
  assert.throws(
    () => assertWorkspaceName("x".repeat(81)),
    /at most 80 characters; this one is 81/,
  );
  // The name is printed straight to a terminal on success, so the escape and
  // bidi ranges the command function refuses are refused here too.
  assert.throws(
    () => assertWorkspaceName(`red${"\u001b"}[31m`),
    /control characters/,
  );
  assert.throws(() => assertWorkspaceName(`a${"\u202e"}b`), /control characters/);
});

test("create_workspace refuses to be routed to an existing workspace", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  let called = false;
  const fetcher = (async () => {
    called = true;
    return accepted(randomUUID());
  }) as typeof fetch;

  await assert.rejects(
    new ThinCommandClient(target, fetcher).sendConnect({
      workspaceId: randomUUID(),
      command: {
        kind: "create_workspace",
        workspace_id: randomUUID(),
        name: "Ridge",
      },
      credential: "human-jwt",
    }),
    /client-generated workspace_id/,
  );
  assert.equal(called, false);
});

test("an unusable name never reaches the network", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon-key");
  let called = false;
  const fetcher = (async () => {
    called = true;
    return accepted(randomUUID());
  }) as typeof fetch;

  await assert.rejects(
    new ThinCommandClient(target, fetcher).sendConnect({
      command: {
        kind: "create_workspace",
        workspace_id: randomUUID(),
        name: "x".repeat(81),
      },
      credential: "human-jwt",
    }),
    /at most 80 characters/,
  );
  assert.equal(called, false);
});
