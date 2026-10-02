import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE, McpJwtVerifier } from "../supabase/functions/mcp/auth.ts";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { createMcpProtocolHandler, PROTECTED_RESOURCE_METADATA_PATH, RESOURCE_METADATA_URL, WWW_AUTHENTICATE } from "../supabase/functions/mcp/protocol.ts";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { HOSTED_TOOL_TABLE, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";

const verified = {
  providerGrantId: "provider-grant",
  subject: "11111111-1111-4111-8111-111111111111",
  expiresAt: 1_900_000_000,
};

function handler(overrides: { publicEnabled?: boolean; allowedOrigins?: string[] } = {}) {
  return createMcpProtocolHandler({
    issuer: MCP_ISSUER,
    resource: MCP_RESOURCE,
    publicEnabled: overrides.publicEnabled ?? true,
    allowedOrigins: new Set(overrides.allowedOrigins ?? ["https://claude.ai"]),
    limits: {
      maxBodyBytes: 4096,
      maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 2_000,
      maxConcurrentRequests: 2,
    },
    verifyToken: async () => verified,
    executeTool: async ({ name }) => ({ called: name }),
  });
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://mcp.commonswarm.com/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test.jwt.value",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function authenticatedHandler() {
  const now = 1_800_000_000;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const publicJwk = {
    ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    kid: "claude-fixture", alg: "ES256", use: "sig",
  };
  const verifier = new McpJwtVerifier({
    now: () => now,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] })),
  });
  const header = Buffer.from(JSON.stringify({
    alg: "ES256", kid: publicJwk.kid, typ: "at+jwt",
  })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: MCP_ISSUER, aud: MCP_RESOURCE, sub: verified.subject,
    grant_id: verified.providerGrantId, iat: now, exp: now + 300,
  })).toString("base64url");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey,
    Buffer.from(`${header}.${payload}`),
  );
  const authorization = `Bearer ${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
  const serve = createMcpProtocolHandler({
    issuer: MCP_ISSUER, resource: MCP_RESOURCE, publicEnabled: true,
    allowedOrigins: new Set(["https://claude.ai"]),
    limits: {
      maxBodyBytes: 4096, maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 2_000, maxConcurrentRequests: 2,
    },
    verifyToken: (token: string, signal: AbortSignal) => verifier.verify(token, signal),
    executeTool: async () => { throw new Error("initialize and list must not execute a tool"); },
  });
  return {
    serve,
    headers: {
      authorization, "user-agent": "Claude-User",
      accept: "application/json, text/event-stream",
    },
  };
}

test("Claude initialization negotiates versions before initialized and tools/list", async (t) => {
  const fixture = await authenticatedHandler();
  const logging = t.mock.method(console, "error", () => undefined);
  const id = "x".repeat(26);
  for (const requested of ["2025-03-26", "2025-06-18", "2025-11-25", "2099-01-01"]) {
    for (const withHeader of [false, true]) {
      await t.test(`${requested}, initialize header ${withHeader ? "present" : "absent"}`, async () => {
        const response = await fixture.serve(post({
          jsonrpc: "2.0", id, method: "initialize",
          params: {
            protocolVersion: requested,
            capabilities: {
              roots: { listChanged: true }, sampling: {},
              experimental: { futureCapability: { enabled: true } },
            },
            clientInfo: { name: "claude-ai", version: "0.1.0" },
          },
        }, {
          ...fixture.headers,
          ...(withHeader ? { "mcp-protocol-version": requested } : {}),
          "content-type": withHeader ? "application/json; charset=utf-8" : "application/json",
        }));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, /^application\/json/u);
        const initialize = await response.json();
        const negotiated = requested === "2025-03-26" ? requested : "2025-06-18";
        assert.deepEqual(initialize, {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "commonswarm", version: "1.0.0" },
            instructions: "Use an explicit seat handle for every CommonSwarm tool call.",
          },
        });
        const headers = { ...fixture.headers, "mcp-protocol-version": negotiated };
        const initialized = await fixture.serve(post({
          jsonrpc: "2.0", method: "notifications/initialized",
        }, headers));
        assert.equal(initialized.status, 202);
        assert.equal(await initialized.text(), "");
        const listed = await fixture.serve(post({
          jsonrpc: "2.0", id: `${id}-list`, method: "tools/list", params: {},
        }, headers));
        assert.equal(listed.status, 200);
        const tools = await listed.json();
        assert.equal(tools.id, `${id}-list`);
        assert.equal(tools.result.tools.length, 8);
        assert.ok(tools.result.tools.every((tool: { name: unknown; inputSchema: unknown }) =>
          typeof tool.name === "string" && typeof tool.inputSchema === "object"));
      });
    }
  }
  assert.equal(logging.mock.callCount(), 0, "successful negotiation and discovery do not log failures");
  const get = await fixture.serve(new Request(MCP_RESOURCE, {
    headers: { ...fixture.headers, accept: "text/event-stream" },
  }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("tools/list accepts optional cursor and metadata without pagination", async (t) => {
  const fixture = await authenticatedHandler();
  const logging = t.mock.method(console, "error", () => undefined);
  const cases: Array<{ name: string; params?: unknown; status: number }> = [
    { name: "omitted params", status: 200 },
    { name: "empty compatibility control", params: {}, status: 200 },
    { name: "cursor", params: { cursor: "x" }, status: 200 },
    { name: "empty metadata", params: { _meta: {} }, status: 200 },
    { name: "progress metadata", params: { _meta: { progressToken: 1 } }, status: 200 },
    { name: "cursor and metadata", params: { cursor: "", _meta: { progressToken: "progress" } }, status: 200 },
    { name: "unknown key", params: { bogus: 1 }, status: 400 },
    { name: "unknown key with cursor", params: { cursor: "x", bogus: 1 }, status: 400 },
    ...[null, [], "x", 1, false].map((params) => ({ name: `non-object ${JSON.stringify(params)}`, params, status: 400 })),
    ...[null, 1, [], {}].map((cursor) => ({ name: `invalid cursor ${JSON.stringify(cursor)}`, params: { cursor }, status: 400 })),
    ...[null, 1, [], "x"].map((_meta) => ({ name: `invalid metadata ${JSON.stringify(_meta)}`, params: { _meta }, status: 400 })),
  ];
  for (const { name, params, status } of cases) {
    await t.test(name, async () => {
      const response = await fixture.serve(post({
        jsonrpc: "2.0", id: name, method: "tools/list",
        ...(params === undefined ? {} : { params }),
      }, { ...fixture.headers, "mcp-protocol-version": "2025-06-18" }));
      assert.equal(response.status, status);
      const envelope = await response.json();
      assert.equal(envelope.id, name);
      assert.equal(envelope.jsonrpc, "2.0");
      if (status === 200) {
        assert.deepEqual(envelope.result, { tools: HOSTED_TOOL_TABLE });
        assert.equal("nextCursor" in envelope.result, false);
      } else {
        assert.deepEqual(envelope.error, { code: -32602, message: "Invalid params" });
      }
    });
  }
  assert.equal(logging.mock.callCount(), cases.filter(({ status }) => status === 400).length);
});

test("MCP denials log only stable error codes and known method names", async (t) => {
  const fixture = await authenticatedHandler();
  const logging = t.mock.method(console, "error", () => undefined);
  const id = "private-id-must-not-be-logged";
  const initialize = (params: unknown) => ({ jsonrpc: "2.0", id, method: "initialize", params });
  // The body, not an early header, controls initialization negotiation.
  const good = await fixture.serve(post(initialize({ protocolVersion: "2025-03-26" }), {
    ...fixture.headers, "mcp-protocol-version": "2099-01-01",
  }));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).result.protocolVersion, "2025-03-26");
  assert.equal(logging.mock.callCount(), 0);

  for (const params of [{}, { protocolVersion: null }, { protocolVersion: 42 }, { protocolVersion: {} }]) {
    const invalid = await fixture.serve(post(initialize(params), fixture.headers));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, -32602);
  }
  const list = { jsonrpc: "2.0", id, method: "tools/list" };
  const later = await fixture.serve(post(list, {
    ...fixture.headers, "mcp-protocol-version": "2099-01-01",
  }));
  assert.equal(later.status, 400);
  assert.equal((await later.json()).error.code, -32600);

  const unauthenticated = await fixture.serve(post(initialize({ protocolVersion: "2099-01-01" }), {
    ...fixture.headers, authorization: "Bearer invalid.jwt.value",
    "mcp-protocol-version": "2099-01-01",
  }));
  assert.equal(unauthenticated.status, 401, "authentication precedes version negotiation");
  const forbidden = await fixture.serve(post(list, {
    ...fixture.headers, origin: "https://attacker.invalid",
  }));
  assert.equal(forbidden.status, 403);
  const parse = await fixture.serve(new Request(MCP_RESOURCE, {
    method: "POST",
    headers: { ...fixture.headers, "content-type": "application/json" },
    body: "private-body-must-not-be-logged",
  }));
  assert.equal(parse.status, 400);
  const unknown = await fixture.serve(post({
    jsonrpc: "2.0", id, method: "private-method-must-not-be-logged",
  }, fixture.headers));
  assert.equal(unknown.status, 404);
  assert.deepEqual(logging.mock.calls.map(({ arguments: args }) => {
    assert.equal(args.length, 1);
    return JSON.parse(args[0]);
  }), [
    ...Array.from({ length: 4 }, () => ({
      event: "request_failed", error_code: -32602, method: "initialize",
    })),
    { event: "request_failed", error_code: -32600, method: "tools/list" },
    { event: "request_failed", error_code: "unauthorized", method: null },
    { event: "request_failed", error_code: "origin_not_allowed", method: null },
    { event: "request_failed", error_code: -32700, method: null },
    { event: "request_failed", error_code: -32601, method: "unknown" },
  ]);
});

test("protected-resource metadata and the unauthenticated challenge name exact URLs", async () => {
  const serve = handler();
  const metadata = await serve(new Request(`https://mcp.commonswarm.com${PROTECTED_RESOURCE_METADATA_PATH}`));
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "CommonSwarm hosted MCP",
  });
  const denied = await serve(new Request(MCP_RESOURCE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), WWW_AUTHENTICATE);
  assert.equal(WWW_AUTHENTICATE, `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
});

test("hosted tool table is closed and exposes no local or credential operations", () => {
  assert.deepEqual(HOSTED_TOOL_TABLE.map(({ name }) => name), [
    "claim_seat", "whoami", "check", "ask", "note", "reply", "working_on", "members",
  ]);
  for (const tool of HOSTED_TOOL_TABLE) {
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.throws(
    () => validateHostedToolArguments("whoami", { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV", token: "secret" }),
    /Unknown tool argument/u,
  );
  assert.deepEqual(
    validateHostedToolArguments("whoami", { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV" }),
    { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV" },
  );
});

test("signal bodies accept multiline whitespace and refuse other control characters", () => {
  const base = {
    seat: "seat_ABCDEFGHIJKLMNOPQRSTUV",
    request_id: "request_123",
  };
  const multiline = "first line\n\tindented\rthird line";
  const signalTools = [
    ["ask", { ...base, recipients: [{ kind: "user", id: verified.subject }] }],
    ["note", base],
    ["reply", { ...base, signal_id: verified.subject }],
    ["working_on", base],
  ] as const;
  for (const [name, arguments_] of signalTools) {
    assert.equal(
      validateHostedToolArguments(name, { ...arguments_, body: multiline }).body,
      multiline,
      `${name} accepts tab, line feed, and carriage return`,
    );
  }
  for (const control of ["\u0000", "\u001b"]) {
    assert.throws(
      () => validateHostedToolArguments("working_on", {
        ...base,
        body: `before${control}after`,
      }),
      /Invalid tool argument/u,
    );
  }
});

test("origin and schema denials include authenticated positive controls", async () => {
  const serve = handler();
  const list = await serve(post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    origin: "https://claude.ai",
  }));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).result.tools.length, 8);

  const originDenied = await serve(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, {
    origin: "https://attacker.invalid",
  }));
  assert.equal(originDenied.status, 403);

  const schemaDenied = await serve(post({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "whoami",
      arguments: { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV", extra: true },
    },
  }));
  assert.equal(schemaDenied.status, 400);
  assert.equal((await schemaDenied.json()).error.code, -32602);
});

test("worker dark gate refuses protected-resource metadata before serving it", async () => {
  const response = await handler({ publicEnabled: false })(
    new Request(`https://mcp.commonswarm.com${PROTECTED_RESOURCE_METADATA_PATH}`),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "feature_disabled",
    feature: "hosted_mcp",
    message: "Hosted MCP is not available yet.",
  });
});

test("public access defaults dark for every MCP and metadata method", async () => {
  const serve = handler({ publicEnabled: false });
  for (const path of [
    "/mcp",
    PROTECTED_RESOURCE_METADATA_PATH,
    `/mcp${PROTECTED_RESOURCE_METADATA_PATH}`,
  ]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await serve(new Request(`https://mcp.commonswarm.com${path}`, { method }));
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), {
        error: "feature_disabled",
        feature: "hosted_mcp",
        message: "Hosted MCP is not available yet.",
      });
    }
  }
});

test("body, response, duration, and concurrency limits deny beside a small positive control", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mode: "small" | "large" | "wait" = "small";
  const serve = createMcpProtocolHandler({
    issuer: MCP_ISSUER,
    resource: MCP_RESOURCE,
    publicEnabled: true,
    allowedOrigins: new Set(),
    limits: {
      maxBodyBytes: 512,
      maxResponseBytes: 1024,
      requestTimeoutMs: 30,
      maxConcurrentRequests: 1,
    },
    verifyToken: async () => verified,
    executeTool: async () => {
      if (mode === "large") return { value: "x".repeat(2000) };
      if (mode === "wait") await gate;
      return { ok: true };
    },
  });
  const call = () => post({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "whoami", arguments: { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV" } },
  });
  assert.equal((await serve(call())).status, 200, "small positive control");
  assert.equal((await serve(post({ padding: "x".repeat(600) }))).status, 413);
  mode = "large";
  assert.equal((await serve(call())).status, 500);
  mode = "wait";
  const waiting = serve(call());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await serve(call())).status, 429);
  assert.equal((await waiting).status, 504);
  assert.equal((await serve(call())).status, 429, "timed-out work keeps its slot until settled");
  release!();
  await gate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  mode = "small";
  assert.equal((await serve(call())).status, 200, "settled work releases its slot");
});

test("runtime dispatch stays in process and names both durable revocation boundaries", async () => {
  const source = await readFile(
    new URL("../supabase/functions/mcp/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /commonswarm_oauth\.provider_family_active/);
  assert.match(source, /authenticateHostedGrantCapability/);
  assert.match(source, /authenticateHostedSeatCapability/);
  assert.match(source, /handleHostedCommand/);
  assert.match(source, /handleHostedRead/);
  assert.match(source, /open_hosted_mcp_check_batch/);
  assert.match(source, /ack_hosted_mcp_check_batch/);
  assert.doesNotMatch(source, /getUser|getClaims|authorization:\s*`Bearer|SUPABASE_SERVICE_ROLE_KEY/);
});
