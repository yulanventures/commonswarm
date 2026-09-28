import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE } from "../supabase/functions/mcp/auth.ts";
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

test("public tool access defaults dark at the protocol boundary", async () => {
  const response = await handler({ publicEnabled: false })(post({
    jsonrpc: "2.0", id: 1, method: "tools/list",
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "feature_disabled",
    feature: "hosted_mcp",
    message: "Hosted MCP is not available yet.",
  });
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
