import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";

import { ClientError } from "../src/client-error.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createLogger } from "../src/logger.js";
import { createHandler } from "../src/server.js";

const USER = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const INTERACTION = "interaction-client-errors";

function responseCapture() {
  return {
    headers: {},
    statusCode: 200,
    body: "",
    headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
    },
    end(body = "") { this.body += body; },
  };
}

function details(prompt = { name: "consent", details: {} }) {
  return {
    uid: INTERACTION,
    params: {
      client_id: "https://client.example/oauth.json",
      redirect_uri: "https://client.example/callback",
      resource: "https://mcp.commonswarm.com/mcp",
      scope: "openid mcp",
      code_challenge: "a".repeat(43),
    },
    prompt,
  };
}

function requestFor(path, source) {
  const request = Readable.from([Buffer.from(source)]);
  request.method = "POST";
  request.url = path;
  request.headers = {
    cookie: "__Host-cswarm-oauth=browser-session-long-enough",
    "content-type": "application/json",
    origin: "https://mcp.commonswarm.com",
    "x-cswarm-csrf": "csrf-token-long-enough",
  };
  return request;
}

function harness({
  interactionDetails = details,
  interactionMaxBodyBytes = 64 * 1024,
  bodyReadTimeoutMs = 10_000,
  selectedWorkspaceIds = () => [WORKSPACE],
  databaseCalls = [],
  logs = [],
} = {}) {
  const provider = {
    callback: () => () => { throw new Error("OIDC fallback must not run"); },
    interactionDetails: async () => {
      databaseCalls.push("interactionDetails");
      return interactionDetails();
    },
    Grant: {
      find: async () => undefined,
    },
    interactionFinished: async (_request, response) => {
      response.writeHead(204);
      response.end();
    },
  };
  provider.Grant = class Grant {
    addOIDCScope() {}
    addOIDCClaims() {}
    addResourceScope() {}
    async save() { return "provider-grant"; }
  };
  provider.Grant.find = async () => undefined;
  const store = {
    requireSession: async () => {
      databaseCalls.push("requireSession");
      return {
        user_id: USER,
        user_email: "human@example.test",
        user_display_name: "Human",
        authenticated_at: new Date().toISOString(),
      };
    },
    bindInteraction: async () => {
      databaseCalls.push("bindInteraction");
      return { user_id: USER, selected_workspace_ids: [WORKSPACE] };
    },
    selectWithToken: async ({ selectionVersion }) => ({
      interaction: { selection_version: selectionVersion + 1 },
      token: "replacement-csrf-token-long-enough",
    }),
    consumeConsent: async () => ({
      client_id: "https://client.example/oauth.json",
      selected_workspace_ids: selectedWorkspaceIds(),
      provider_grant_id: null,
      commonswarm_grant_id: "30000000-0000-4000-8000-000000000001",
    }),
    bindProviderGrant: async (_interaction, providerGrantId, commonswarmGrantId) => ({
      provider_grant_id: providerGrantId,
      commonswarm_grant_id: commonswarmGrantId,
    }),
    complete: async () => {},
  };
  const interactionHandler = createInteractionHandler({
    provider,
    store,
    gotrue: {},
    consentOrchestrator: { activate: async () => {} },
    workspaceReader: async () => [{ id: WORKSPACE, name: "Workspace" }],
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
    maxBodyBytes: interactionMaxBodyBytes,
    bodyReadTimeoutMs,
  });
  return createHandler({
    provider,
    pool: {},
    publicAuthorizationEnabled: true,
    maxBodyBytes: interactionMaxBodyBytes,
    logger: createLogger((line) => logs.push(JSON.parse(line))),
    interactionHandler,
  });
}

async function expectClientError(handler, path, source, status, error) {
  const response = responseCapture();
  await handler(requestFor(path, source), response);
  assert.equal(response.statusCode, status);
  assert.deepEqual(JSON.parse(response.body), { error });
}

async function expectServerError(handler, path, source) {
  const response = responseCapture();
  await handler(requestFor(path, source), response);
  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), ["error", "request_id"]);
  assert.equal(body.error, "internal_error");
  assert.equal(body.request_id, response.headers["x-request-id"]);
  return { body, response };
}

async function expectValidSelection(handler) {
  const response = responseCapture();
  await handler(requestFor(`/interaction/${INTERACTION}/selection`, JSON.stringify({
    selection_version: 0,
    workspace_ids: [WORKSPACE],
  })), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    selection_version: 1,
    csrf_token: "replacement-csrf-token-long-enough",
  });
}

async function expectValidConsent(handler) {
  const response = responseCapture();
  await handler(requestFor(`/interaction/${INTERACTION}/consent`, JSON.stringify({
    selection_version: 0,
    home_workspace_id: WORKSPACE,
  })), response);
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
}

async function waitForHandler(result, timeoutMs = 1_000) {
  let watchdog;
  try {
    await Promise.race([
      result,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("interaction handler did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

test("malformed interaction JSON is a fixed 400 response", async () => {
  const handler = harness();
  await expectClientError(handler, `/interaction/${INTERACTION}/selection`, "{", 400,
    "invalid_request");
  await expectValidSelection(handler);
});

test("an oversized interaction body is a fixed 413 response", async () => {
  const databaseCalls = [];
  const handler = harness({ interactionMaxBodyBytes: 128, databaseCalls });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    cookie: "__Host-cswarm-oauth=browser-session-long-enough",
    "content-type": "application/json",
    origin: "https://mcp.commonswarm.com",
    "x-cswarm-csrf": "csrf-token-long-enough",
  };
  try {
    const oversized = JSON.stringify({
      selection_version: 0,
      workspace_ids: [WORKSPACE],
      padding: "x".repeat(128),
    });
    const response = await fetch(`${origin}/interaction/${INTERACTION}/selection`, {
      method: "POST",
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_too_large" });
    assert.deepEqual(databaseCalls, []);

    const control = await fetch(`${origin}/interaction/${INTERACTION}/selection`, {
      method: "POST",
      headers,
      body: JSON.stringify({ selection_version: 0, workspace_ids: [WORKSPACE] }),
    });
    assert.equal(control.status, 200);
    assert.equal((await control.json()).selection_version, 1);
    assert.ok(databaseCalls.length > 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("interaction body limits start before database work and close an oversized request", async () => {
  const databaseCalls = [];
  const handler = harness({ interactionMaxBodyBytes: 8, databaseCalls });
  const request = new PassThrough();
  request.method = "POST";
  request.url = `/interaction/${INTERACTION}/selection`;
  request.headers = requestFor("/", "").headers;
  const response = responseCapture();

  const result = handler(request, response);
  request.write("{");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(databaseCalls, []);
  request.end("x".repeat(16));
  await result;

  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.body), { error: "request_too_large" });
  assert.equal(request.destroyed, true);
  assert.deepEqual(databaseCalls, []);
  await expectValidSelection(harness());
});

test("a slow interaction body is bounded before database work", async () => {
  const databaseCalls = [];
  const handler = harness({ bodyReadTimeoutMs: 20, databaseCalls });
  const request = new PassThrough();
  request.method = "POST";
  request.url = `/interaction/${INTERACTION}/selection`;
  request.headers = requestFor("/", "").headers;
  const response = responseCapture();

  const result = handler(request, response);
  request.write("{");
  await waitForHandler(result);

  assert.equal(request.destroyed, true);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "invalid_request" });
  assert.deepEqual(databaseCalls, []);
  await expectValidSelection(harness());
});

test("missing, null, and wrong-typed interaction fields are fixed 400 responses", async () => {
  for (const body of [
    null,
    { workspace_ids: [WORKSPACE] },
    { selection_version: "0", workspace_ids: [WORKSPACE] },
    { selection_version: 0, workspace_ids: null },
  ]) {
    const handler = harness();
    await expectClientError(handler, `/interaction/${INTERACTION}/selection`, JSON.stringify(body),
      400, "invalid_request");
    await expectValidSelection(handler);
  }
});

test("missing and wrong-typed server-side OAuth binding fields stay 500 faults", async () => {
  let currentDetails = details();
  const logs = [];
  const handler = harness({ interactionDetails: () => currentDetails, logs });
  for (const invalidParams of [
    undefined,
    { ...details().params, resource: ["https://mcp.commonswarm.com/mcp"] },
  ]) {
    currentDetails = { ...details(), params: invalidParams };
    const { body } = await expectServerError(handler, `/interaction/${INTERACTION}/selection`, JSON.stringify({
      selection_version: 0,
      workspace_ids: [WORKSPACE],
    }));
    assert.equal(logs.some((entry) => entry.event === "request_failed" &&
      entry.status === 500 && entry.request_id === body.request_id), true);
    currentDetails = details();
    await expectValidSelection(handler);
  }
});

test("a consent interaction without server-side prompt details stays a 500 fault", async () => {
  let prompt = { name: "consent" };
  const handler = harness({ interactionDetails: () => details(prompt) });
  await expectServerError(handler, `/interaction/${INTERACTION}/consent`, JSON.stringify({
    selection_version: 0,
    home_workspace_id: WORKSPACE,
  }));
  prompt = { name: "consent", details: {} };
  await expectValidConsent(handler);
});

test("wrong-typed server-side consent prompt fields stay 500 faults", async () => {
  let prompt = { name: "consent", details: { missingOIDCScope: "openid" } };
  const handler = harness({ interactionDetails: () => details(prompt) });
  await expectServerError(handler, `/interaction/${INTERACTION}/consent`, JSON.stringify({
    selection_version: 0,
    home_workspace_id: WORKSPACE,
  }));
  prompt = { name: "consent", details: { missingOIDCScope: ["openid"] } };
  await expectValidConsent(handler);
});

test("an unsupported server-side interaction prompt stays a 500 fault", async () => {
  const handler = harness({ interactionDetails: () => details({ name: "unsupported" }) });
  const request = requestFor(`/interaction/${INTERACTION}`, "");
  request.method = "GET";
  const response = responseCapture();
  await handler(request, response);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ["error", "request_id"]);
  await expectValidConsent(harness());
});

test("a null stored workspace selection is a fixed 400 response", async () => {
  let selection = null;
  const handler = harness({ selectedWorkspaceIds: () => selection });
  await expectClientError(handler, `/interaction/${INTERACTION}/consent`, JSON.stringify({
    selection_version: 0,
    home_workspace_id: WORKSPACE,
  }), 400, "invalid_request");
  selection = [WORKSPACE];
  await expectValidConsent(handler);
});

test("an undeclared server fault stays a detail-free 500 with the request id", async () => {
  const handler = harness({
    interactionDetails: () => { throw new Error("secret database failure"); },
  });
  const response = responseCapture();
  await handler(requestFor(`/interaction/${INTERACTION}/selection`, JSON.stringify({
    selection_version: 0,
    workspace_ids: [WORKSPACE],
  })), response);
  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), ["error", "request_id"]);
  assert.equal(body.error, "internal_error");
  assert.equal(body.request_id, response.headers["x-request-id"]);
  assert.doesNotMatch(response.body, /secret|database|failure/u);
});

test("a foreign error status cannot select a client response", async () => {
  for (const status of [400, 418, 499]) {
    const handler = harness({
      interactionDetails: () => { throw Object.assign(new Error("foreign failure"), { status }); },
    });
    const { response } = await expectServerError(handler,
      `/interaction/${INTERACTION}/selection`, JSON.stringify({
        selection_version: 0,
        workspace_ids: [WORKSPACE],
      }));
    assert.doesNotMatch(response.body, /foreign|failure/u);
  }
  await expectClientError(harness(), `/interaction/${INTERACTION}/selection`, "{", 400,
    "invalid_request");
});

test("the service-owned client error type has a closed status set", () => {
  const invalid = new ClientError(400);
  assert.equal(invalid.code, "invalid_request");
  assert.equal(new ClientError(413).code, "request_too_large");
  assert.throws(() => new ClientError(401), /unsupported client error status/u);
  assert.throws(() => new ClientError(418), /unsupported client error status/u);
  assert.throws(() => { invalid.status = 418; }, /read only|Cannot assign/u);
});
