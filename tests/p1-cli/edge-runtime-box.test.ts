import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISABLED_FUNCTION_NAMES,
  FUNCTION_DISABLED_BODY,
  FUNCTION_DISABLED_STATUS,
  handleGatewayRequest,
  isMcpPublicEnabled,
  mainEnvironmentProblems,
  REQUIRED_MAIN_ENV,
  resolveFunctionRoute,
  resolveGatewayRequest,
  rewriteFunctionRequest,
  SELF_SERVE_ENV_REASON,
} from "../../deploy/edge-runtime/main/router.js";
// @ts-expect-error TS5097: this test reaches the Deno worker's pure protocol boundary.
import { createMcpProtocolHandler } from "../../supabase/functions/mcp/protocol.ts";

test("dark MCP POST stops before the worker factory", async () => {
  let workerFactoryCalls = 0;
  const response = await handleGatewayRequest(
    new Request("https://edge.test/functions/v1/mcp", { method: "POST" }),
    false,
    async () => {
      workerFactoryCalls += 1;
      return new Response("worker response");
    },
  );
  assert.equal(response.status, FUNCTION_DISABLED_STATUS);
  assert.deepEqual(await response.json(), FUNCTION_DISABLED_BODY);
  assert.equal(workerFactoryCalls, 0);
});

test("dark MCP OPTIONS is refused before the normal gateway preflight", async () => {
  const resolution = resolveGatewayRequest(
    new Request("https://edge.test/functions/v1/mcp", { method: "OPTIONS" }),
    false,
  );
  assert.equal(resolution.response?.status, FUNCTION_DISABLED_STATUS);
  assert.deepEqual(await resolution.response?.json(), FUNCTION_DISABLED_BODY);
});

test("MCP dark gate refuses every method before worker creation and routes when enabled", async () => {
  assert.deepEqual(DISABLED_FUNCTION_NAMES, ["mcp"]);
  let workerFactoryCalls = 0;
  const dispatch = async (request: Request, publicEnabled: boolean) =>
    await handleGatewayRequest(request, publicEnabled, async (route) => {
      workerFactoryCalls += 1;
      return new Response(route.functionName);
    });

  for (const suffix of ["", "/.well-known/oauth-protected-resource/mcp"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await dispatch(
        new Request(`https://edge.test/functions/v1/mcp${suffix}`, { method }),
        false,
      );
      assert.equal(response.status, FUNCTION_DISABLED_STATUS, `${method} ${suffix || "/mcp"}`);
      assert.deepEqual(await response.json(), FUNCTION_DISABLED_BODY);
    }
  }
  assert.equal(workerFactoryCalls, 0, "dark MCP must stop before the worker factory");

  for (const [method, suffix, pathname] of [
    ["POST", "", "/mcp"],
    ["GET", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource/mcp"],
  ] as const) {
    const response = await dispatch(
      new Request(`https://edge.test/functions/v1/mcp${suffix}`, { method }),
      true,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "mcp");
    assert.deepEqual(
      resolveGatewayRequest(
        new Request(`https://edge.test/functions/v1/mcp${suffix}`, { method }),
        true,
      ).route,
      { functionName: "mcp", pathname },
    );
  }
  assert.equal(workerFactoryCalls, 2, "enabled MCP reaches the worker factory");

  const enabledPreflight = await dispatch(
    new Request("https://edge.test/functions/v1/mcp", { method: "OPTIONS" }),
    true,
  );
  assert.equal(enabledPreflight.status, 200);
  assert.equal(workerFactoryCalls, 2, "enabled preflight stays in the main router");

  const request = () => new Request("https://edge.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test.jwt.value",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const handler = (publicEnabled: boolean, onVerify: () => void) =>
    createMcpProtocolHandler({
      issuer: "https://issuer.test",
      resource: "https://edge.test/mcp",
      publicEnabled,
      allowedOrigins: new Set(),
      limits: {
        maxBodyBytes: 4096,
        maxResponseBytes: 64 * 1024,
        requestTimeoutMs: 2_000,
        maxConcurrentRequests: 1,
      },
      verifyToken: async () => {
        onVerify();
        return {
          providerGrantId: "provider-grant",
          subject: "11111111-1111-4111-8111-111111111111",
          expiresAt: 1_900_000_000,
        };
      },
      executeTool: async () => ({}),
    });

  let darkVerifications = 0;
  const darkResponse = await handler(false, () => { darkVerifications += 1; })(request());
  assert.equal(darkResponse.status, FUNCTION_DISABLED_STATUS);
  assert.deepEqual(await darkResponse.json(), FUNCTION_DISABLED_BODY);
  assert.equal(darkVerifications, 0, "dark access stops before token verification");

  let enabledVerifications = 0;
  const enabledResponse = await handler(true, () => { enabledVerifications += 1; })(request());
  assert.equal(enabledResponse.status, 200, "enabled access reaches the MCP protocol");
  assert.equal(enabledVerifications, 1);
});

test("MCP public flag uses the exact value and ignores request headers", async () => {
  for (const [value, expected] of [
    [undefined, false],
    ["", false],
    ["0", false],
    ["true", false],
    [" 1", false],
    ["1", true],
  ] as const) {
    assert.equal(isMcpPublicEnabled(value), expected);
  }

  let workerFactoryCalls = 0;
  const response = await handleGatewayRequest(
    new Request("https://edge.test/functions/v1/mcp", {
      method: "POST",
      headers: { "SWARM_MCP_PUBLIC_ENABLED": "1" },
    }),
    false,
    async () => {
      workerFactoryCalls += 1;
      return new Response("worker response");
    },
  );
  assert.equal(response.status, FUNCTION_DISABLED_STATUS);
  assert.equal(workerFactoryCalls, 0);
});

test("edge runtime request rewrite preserves query, method, headers, and body", async () => {
  const original = new Request(
    "https://edge.test/functions/v1/command/deep/path?cursor=one%2Ftwo&limit=3",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-placeholder",
        apikey: "test-only-placeholder",
        "content-type": "application/json",
        "x-client-info": "router-test",
      },
      body: '{"test":true}',
    },
  );
  const route = resolveFunctionRoute(new URL(original.url).pathname);
  assert.deepEqual(route, {
    functionName: "command",
    pathname: "/command/deep/path",
  });
  const rewritten = rewriteFunctionRequest(original, route.pathname);
  const url = new URL(rewritten.url);
  assert.equal(url.pathname, "/command/deep/path");
  assert.equal(url.search, "?cursor=one%2Ftwo&limit=3");
  assert.equal(rewritten.method, "POST");
  assert.equal(
    rewritten.headers.get("authorization"),
    "Bearer test-only-placeholder",
  );
  assert.equal(rewritten.headers.get("apikey"), "test-only-placeholder");
  assert.equal(rewritten.headers.get("x-client-info"), "router-test");
  assert.equal(await rewritten.text(), '{"test":true}');
});

test("edge runtime requires the production feature gate at boot", () => {
  assert.deepEqual(REQUIRED_MAIN_ENV, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SWARM_SELF_SERVE",
  ]);

  const environment = new Map<string, string>([
    ["SUPABASE_URL", "local-test-url"],
    ["SUPABASE_ANON_KEY", "local-test-anon"],
    ["SUPABASE_SERVICE_ROLE_KEY", "local-test-service-role"],
    ["SUPABASE_DB_URL", "local-test-database"],
    ["SWARM_SELF_SERVE", "1"],
  ]);
  const get = (name: string) => environment.get(name);
  assert.deepEqual(mainEnvironmentProblems(get), []);

  for (const invalid of ["", "0", "true", " 1"]) {
    environment.set("SWARM_SELF_SERVE", invalid);
    assert.deepEqual(mainEnvironmentProblems(get), [SELF_SERVE_ENV_REASON]);
  }

  environment.delete("SWARM_SELF_SERVE");
  assert.deepEqual(mainEnvironmentProblems(get), [SELF_SERVE_ENV_REASON]);
});
