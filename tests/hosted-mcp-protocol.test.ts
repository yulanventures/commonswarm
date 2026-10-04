import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE, McpJwtVerifier } from "../supabase/functions/mcp/auth.ts";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { createMcpProtocolHandler, PROTECTED_RESOURCE_METADATA_PATH, RESOURCE_METADATA_URL, WWW_AUTHENTICATE } from "../supabase/functions/mcp/protocol.ts";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { HOSTED_TOOL_TABLE, validateHostedToolArguments, type HostedToolExecutor } from "../supabase/functions/mcp/tools.ts";

// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { HostedToolFailure } from "../supabase/functions/mcp/tool-errors.ts";

const verified = {
  providerGrantId: "provider-grant",
  subject: "11111111-1111-4111-8111-111111111111",
  expiresAt: 1_900_000_000,
};

function handler(overrides: { publicEnabled?: boolean; allowedOrigins?: string[]; executeTool?: HostedToolExecutor } = {}) {
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
    executeTool: overrides.executeTool ?? (async ({ name }) => ({ called: name })),
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

async function authenticatedHandler(
  claims: Record<string, unknown> = {},
  executeTool: HostedToolExecutor = async () => { throw new Error("initialize and list must not execute a tool"); },
) {
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
    scope: "mcp", client_id: "claude-fixture-client", ...claims,
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
    executeTool,
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
        InitializeResultSchema.parse(initialize.result);
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
        ListToolsResultSchema.parse(tools.result);
        assert.equal(tools.id, `${id}-list`);
        assert.equal(tools.result.tools.length, 8);
        assert.ok(tools.result.tools.every((tool: { name: unknown; inputSchema: unknown }) =>
          typeof tool.name === "string" && typeof tool.inputSchema === "object"));
        for (const tool of tools.result.tools) {
          assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["mcp"] }]);
        }
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

test("tools/list snapshots eight hosted titles, safety annotations and OAuth security schemes after 2025-06-18 negotiation", async (t) => {
  const fixture = await authenticatedHandler();
  const initialized = await fixture.serve(post({
    jsonrpc: "2.0", id: "metadata-initialize", method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "metadata-reviewer", version: "1.0.0" } },
  }, fixture.headers));
  assert.equal(initialized.status, 200);
  const protocolVersion = (await initialized.json()).result.protocolVersion;
  assert.equal(protocolVersion, "2025-06-18");
  const response = await fixture.serve(post({
    jsonrpc: "2.0", id: "metadata-list", method: "tools/list",
  }, { ...fixture.headers, "mcp-protocol-version": protocolVersion }));
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.id, "metadata-list");
  // Independent review contract: read-only, destructive, idempotent.
  // check can acknowledge a batch and advance the durable inbox cursor.
  const expected = [
    ["claim_seat", "Claim a named seat", false, false, true],
    ["whoami", "Show seat identity", true, false, true],
    ["check", "Check and acknowledge inbox", false, true, false],
    ["ask", "Ask workspace participants", false, false, true],
    ["note", "Share a workspace note", false, false, true],
    ["reply", "Reply to a signal", false, false, true],
    ["working_on", "Share current work", false, false, true],
    ["members", "List workspace participants", true, false, true],
  ] as const;
  const tools = envelope.result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), expected.map(([name]) => name));
  for (const [index, [name, title, readOnlyHint, destructiveHint, idempotentHint]] of expected.entries()) {
    await t.test(name, () => {
      assert.deepEqual({ title: tools[index].title, annotations: tools[index].annotations, securitySchemes: tools[index].securitySchemes }, {
        title,
        annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false },
        securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
      });
    });
  }
});

test("tool auth errors carry safe WWW-Authenticate metadata while ordinary errors and success do not", async (t) => {
  let outcome = "ok";
  const serve = handler({ executeTool: async () => {
    if (outcome !== "ok") throw new HostedToolFailure(outcome);
    return { ok: true };
  } });
  t.mock.method(console, "error", () => undefined);
  const challenge = `Bearer resource_metadata="https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Authorization is no longer valid. Reconnect your account."`;
  for (const code of ["ok", "hosted_grant_forbidden", "hosted_seat_forbidden", "hosted_seat_revoked", "hosted_check_batch_forbidden", "hosted_command_failed", "private-error-must-not-leak"]) {
    outcome = code;
    const response = await serve(post({
      jsonrpc: "2.0", id: "auth-metadata", method: "tools/call",
      params: { name: "whoami", arguments: { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV" } },
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.id, "auth-metadata");
    assert.equal(envelope.jsonrpc, "2.0");
    const result = envelope.result;
    CallToolResultSchema.parse(result);
    const needsAuth = ["hosted_grant_forbidden", "hosted_seat_forbidden", "hosted_seat_revoked"].includes(code);
    assert.deepEqual(result._meta, needsAuth ? { "mcp/www_authenticate": [challenge] } : undefined);
    const output = JSON.parse(result.content[0].text);
    if (code === "ok") assert.deepEqual(output, { ok: true });
    else assert.equal(output.error, ["private-error-must-not-leak", "hosted_command_failed"].includes(code) ? "tool_failed" : code);
    assert.equal(result.isError, code === "ok" ? undefined : true);
  }
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

test("signed hosted tokens enforce scope on initialize, list and tools with OAuth challenges", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: { seat: "seat_" + "x".repeat(32) } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "claim_seat", arguments: { name: "Scope test", request_id: "scope-test-request" } } },
  ];
  for (const scope of [undefined, "openid offline_access", "mcp:read", "admin:read", ["mcp"]]) {
    const fixture = await authenticatedHandler({ scope });
    for (const body of requests) {
      const response = await fixture.serve(post(body, fixture.headers));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "insufficient_scope" });
      assert.equal(response.headers.get("www-authenticate"),
        `${WWW_AUTHENTICATE}, error="insufficient_scope", scope="mcp"`);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  // Client registration and grant/seat use do not change the resource permission.
  for (const [client_id, grant_id, scope] of [
    ["ordinary-client", "ordinary-grant", "mcp"],
    ["https://client.example/oauth/client.json", "cimd-grant", "mcp"],
    ["registered-public-client", "dcr-grant", "mcp"],
    ["ordinary-client", "refreshed-seat-grant", "openid mcp offline_access"],
  ]) {
    const calls: string[] = [];
    const fixture = await authenticatedHandler({ client_id, grant_id, scope }, async ({ name, token }) => {
      assert.equal(token.providerGrantId, grant_id);
      calls.push(name);
      return { called: name };
    });
    for (const body of requests) {
      const response = await fixture.serve(post(body, fixture.headers));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("www-authenticate"), null);
      const result = (await response.json()).result;
      assert.equal(result.isError, undefined);
    }
    assert.deepEqual(calls, ["whoami", "claim_seat"]);
  }
  const invalid = await authenticatedHandler({ scope: undefined, aud: "https://wrong.invalid" });
  const response = await invalid.serve(post(requests[0], invalid.headers));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `${WWW_AUTHENTICATE}, error="invalid_token"`);
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

test("claim_seat advertises and accepts an omitted workspace_id beside an explicit control", async () => {
  const serve = handler();
  const base = { name: "Claim regression", request_id: "claim_request_123" };
  const call = (arguments_: Record<string, unknown>) => serve(post({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "claim_seat", arguments: arguments_ },
  }));
  const explicit = await call({ ...base, workspace_id: verified.subject });
  assert.equal(explicit.status, 200, "explicit UUID positive control");
  assert.equal((await explicit.json()).result.isError, undefined);
  const omitted = await call(base);
  assert.equal(omitted.status, 200, "omitted workspace reaches the executor");
  assert.equal((await omitted.json()).result.isError, undefined);
  const listed = await serve(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const claim = (await listed.json()).result.tools.find((tool: { name: string }) => tool.name === "claim_seat");
  assert.deepEqual(claim.inputSchema.required, ["name", "request_id"]);
  assert.equal(claim.inputSchema.properties.workspace_id.type, "string");
  assert.match(claim.description, /omit workspace_id.*home workspace/iu);
});

test("claim_seat routes through the grant home and preserves explicit consent checks", async () => {
  // Load the production claim path lazily so the schema regression can run on main.
  // @ts-expect-error TS5097: this service-free test imports the Deno source directly.
  const { executeClaimSeat } = await import("../supabase/functions/mcp/claim-seat.ts");
  // @ts-expect-error TS5097: this service-free test imports the Deno source directly.
  const { revalidateHostedGrantCommand } = await import("../supabase/functions/_shared/hosted-seat-auth.ts");
  type Dependencies = Parameters<typeof executeClaimSeat>[1];
  type Sql = Parameters<Parameters<Dependencies["withAuthTransaction"]>[0]>[0];
  const home = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  const forbidden = "44444444-4444-4444-8444-444444444444";
  const grantId = "55555555-5555-4555-8555-555555555555";
  // Database fixtures provide consented rows; the production auth module still
  // constructs and revalidates the opaque capability used by the command path.
  const authorizationRows = [home, other].map((workspace_id) => ({
    grant_id: grantId, owner_user_id: verified.subject,
    provider_grant_id: verified.providerGrantId, workspace_id,
    stream_id: "66666666-6666-4666-8666-666666666666", manifest_digest: "a".repeat(64),
  }));
  const authorizedWorkspaces: unknown[] = [];
  const commands: unknown[] = [];
  let grantLookups = 0;
  let providerActive = true;
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM swarm.hosted_mcp_grants")) {
      grantLookups += 1;
      assert.deepEqual(values, [verified.providerGrantId, verified.subject]);
      assert.match(query, /SELECT grant_id, owner_user_id, home_workspace_id/u);
      return [{ grant_id: grantId, owner_user_id: verified.subject, home_workspace_id: home }];
    }
    assert.match(query, /swarm.resolve_hosted_grant_authorization/u);
    assert.equal(values[3], "claim_hosted_seat");
    authorizedWorkspaces.push(values[2]);
    return authorizationRows.filter((row) =>
      row.grant_id === values[0] && row.owner_user_id === values[1] && row.workspace_id === values[2]);
  }) as unknown as Sql;
  const serve = handler({
    executeTool: async (call) => {
      const result = await executeClaimSeat(call, {
        withAuthTransaction: async (run) => await run(tx),
        providerStatus: async () => ({ active: providerActive }),
        handleCommand: async (input, capability) => {
          const authorization = await revalidateHostedGrantCommand(tx, capability);
          assert.ok(authorization, "command revalidates the real opaque capability");
          assert.equal(input.workspace_id, authorization.workspace_id);
          commands.push(input);
          return { status: 200, body: { workspace_id: input.workspace_id } };
        },
      });
      return result.body;
    },
  });
  const base = { name: "Claim regression", request_id: "claim_request_123" };
  for (const [workspace_id, expected] of [[undefined, home], [other, other], [forbidden, "hosted_grant_forbidden"]]) {
    const response = await serve(post({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "claim_seat", arguments: { ...base, ...(workspace_id === undefined ? {} : { workspace_id }) } },
    }));
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    const output = JSON.parse(result.content[0].text);
    if (expected === "hosted_grant_forbidden") {
      assert.equal(result.isError, true);
      assert.deepEqual(output, { error: expected, message: "Workspace access is missing or no longer authorized. Ask a workspace admin to restore your membership, then reconnect and approve this workspace." });
    } else {
      assert.equal(result.isError, undefined);
      assert.deepEqual(output, { workspace_id: expected });
    }
  }
  assert.deepEqual(authorizedWorkspaces, [home, home, other, other, forbidden]);
  assert.deepEqual(commands, [home, other].map((workspace_id) => ({
    command_id: base.request_id, client_version: "0.1.80", workspace_id,
    stream: { kind: "workspace" }, command: { kind: "claim_hosted_seat", name: base.name },
  })));
  providerActive = false;
  const revoked = await serve(post({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "claim_seat", arguments: base },
  }));
  const revokedResult = (await revoked.json()).result;
  assert.deepEqual(JSON.parse(revokedResult.content[0].text), { error: "hosted_grant_forbidden", message: "Workspace access is missing or no longer authorized. Ask a workspace admin to restore your membership, then reconnect and approve this workspace." });
  assert.equal(revokedResult.isError, true);
  CallToolResultSchema.parse(revokedResult);
  assert.deepEqual(revokedResult._meta, {
    "mcp/www_authenticate": [`${WWW_AUTHENTICATE}, error="invalid_token", error_description="Authorization is no longer valid. Reconnect your account."`],
  });
  assert.equal(commands.length, 2, "inactive provider never issues a command");
  const lookupsBeforeInvalidInput = grantLookups;
  for (const workspace_id of ["00000000-0000-4000-8000-000000000000", "00000000-0000-0000-0000-000000000000", null, "invalid"]) {
    const response = await serve(post({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "claim_seat", arguments: { ...base, workspace_id } },
    }));
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, -32602);
    assert.match(error.message, /Invalid workspace_id.*omit.*home workspace/u);
  }
  assert.equal(grantLookups, lookupsBeforeInvalidInput, "invalid IDs never reach grant authorization");
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
      /Invalid body: provide 1 to 8000 characters/u,
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
  const throttled = await serve(call());
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "1");
  assert.deepEqual(await throttled.json(), { error: "too_many_requests", message: "Too many concurrent requests. Retry in 1 second." });
  const timedOut = await waiting;
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { error: "request_timeout", message: "The request timed out. Retry with the same request_id; if it repeats, contact support@commonswarm.com." });
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
  const claimSource = await readFile(new URL("../supabase/functions/mcp/claim-seat.ts", import.meta.url), "utf8");
  assert.match(source, /executeClaimSeat/);
  assert.match(claimSource, /authenticateHostedGrantCapability/);
  assert.match(source, /authenticateHostedSeatCapability/);
  assert.match(source, /handleHostedCommand/);
  assert.match(source, /handleHostedRead/);
  assert.match(source, /open_hosted_mcp_check_batch/);
  assert.match(source, /ack_hosted_mcp_check_batch/);
  assert.doesNotMatch(source, /getUser|getClaims|authorization:\s*`Bearer|SUPABASE_SERVICE_ROLE_KEY/);
});
