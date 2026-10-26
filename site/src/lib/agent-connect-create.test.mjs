/**
 * Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob.
 *
 * Drives createAgentIdentity against a stubbed transport. The server contract for
 * allow_duplicate_name is Lane A; these tests measure the browser envelope only.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const DEPLOYMENT_URL = "https://deployment.test";

globalThis.document = {
  querySelector(selector) {
    if (selector.includes("commonswarm:url")) return { content: DEPLOYMENT_URL };
    if (selector.includes("commonswarm:anon-key")) return { content: "anon-test-key" };
    return null;
  },
};

const {
  ALLOW_DUPLICATE_NAME_FIELD,
  AgentNameTaken,
  createAgentIdentity,
} = await import("./agent-connect.ts");

const SESSION = { access_token: "jwt", user: { id: "user" } };
const WORKSPACE = "9c8b7a65-4321-4def-8abc-0123456789ab";
const PRINCIPAL = "1f0a3c22-6f2f-4c1e-9d55-0a1b2c3d4e5f";

const sent = [];
const realFetch = globalThis.fetch;
let respond;

beforeEach(() => {
  sent.length = 0;
  respond = (envelope) => ({
    status: "accepted",
    principal_id: PRINCIPAL,
    command_id: envelope.command_id,
  });
  globalThis.fetch = (async (_url, init) => {
    const envelope = JSON.parse(init.body);
    sent.push({ raw: init.body, envelope, command: envelope.command });
    const body = respond(envelope);
    return { status: 200, text: async () => JSON.stringify(body) };
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an idempotent retry reuses the command id and does not mint a second principal", async () => {
  const commandId = "web_create_retry";
  const first = await createAgentIdentity(
    SESSION,
    commandId,
    WORKSPACE,
    "echo",
    undefined,
    true,
  );
  const second = await createAgentIdentity(
    SESSION,
    commandId,
    WORKSPACE,
    "echo",
    undefined,
    true,
  );
  assert.equal(sent.length, 2);
  assert.equal(sent[0].envelope.command_id, commandId);
  assert.equal(sent[1].envelope.command_id, commandId);
  assert.equal(first.principalId, PRINCIPAL);
  assert.equal(second.principalId, PRINCIPAL);
  assert.equal(first.principalId, second.principalId);
});
