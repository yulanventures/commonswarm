/** Worker-boundary contracts: synthetic host names produce exact environment
 * entries, preserving credential exclusions and gateway behavior. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DISABLED_FUNCTION_NAMES,
  FUNCTION_NAMES,
  environmentFor,
  handleGatewayRequest,
  rewriteFunctionRequest,
  resolveFunctionRoute,
  resolveGatewayRequest,
} from "../deploy/edge-runtime/main/router.js";

const repoRoot = process.cwd();

test("admin public and internal ingress reach one worker; unknown names never invoke it", async () => {
  const invoked: string[] = [];
  for (const path of ["/admin", "/functions/v1/admin", "/admin/.well-known/oauth-protected-resource",
    "/functions/v1/admin/.well-known/oauth-protected-resource"]) {
    const expectedPath = path.replace(/^\/functions\/v1/u, "");
    const request = new Request(`https://api.commonswarm.com${path}?trace=1`, {
      method: "POST", headers: { dpop: "proof", authorization: "DPoP credential" }, body: "payload",
    });
    const result = await handleGatewayRequest(request, false, async (route, original) => {
      assert.equal(route.functionName, "admin");
      const forwarded = rewriteFunctionRequest(original, route.pathname);
      assert.equal(new URL(forwarded.url).pathname, expectedPath);
      assert.equal(new URL(forwarded.url).search, "?trace=1");
      assert.equal(forwarded.method, "POST");
      assert.equal(forwarded.headers.get("dpop"), "proof");
      assert.equal(forwarded.headers.get("authorization"), "DPoP credential");
      assert.equal(await forwarded.text(), "payload");
      invoked.push(route.functionName);
      return new Response("admin worker");
    });
    assert.equal(await result.text(), "admin worker");
  }
  assert.equal(invoked.length, 4);
  for (const path of ["/administrator", "/unknown", "/functions/v1/unknown"]) {
    const result = await handleGatewayRequest(new Request(`https://api.commonswarm.com${path}`), false,
      async () => assert.fail("unknown name invoked a worker"));
    assert.equal(result.status, 404);
  }
});

/** Load repository-relative fixtures as UTF-8, preserving read failures. */
const source = (path: string): Promise<string> => readFile(resolve(repoRoot, path), "utf8");

test("HM7 keeps MCP dark in the main router until explicitly enabled", async () => {
  assert.deepEqual(FUNCTION_NAMES, [
    "command",
    "read",
    "capability",
    "activity",
    "h0",
    "mcp",
    "admin",
  ]);
  assert.deepEqual(DISABLED_FUNCTION_NAMES, ["mcp"]);
  assert.equal(resolveFunctionRoute("/functions/v1/mcp"), null);
  assert.deepEqual(resolveFunctionRoute("/functions/v1/mcp", true), {
    functionName: "mcp",
    pathname: "/mcp",
  });

  for (const path of [
    "/functions/v1/mcp",
    "/functions/v1/mcp/",
    "/functions/v1/mcp/.well-known/oauth-protected-resource/mcp",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const dark = resolveGatewayRequest(
        new Request(`https://edge.test${path}`, { method }),
        false,
      );
      assert.equal(dark.route, null);
      assert.equal(dark.response?.status, 503);
      assert.deepEqual(await dark.response?.json(), {
        error: "feature_disabled",
        feature: "hosted_mcp",
        message: "Hosted MCP is not available yet.",
      });
    }

    const enabled = resolveGatewayRequest(
      new Request(`https://edge.test${path}`, { method: "POST" }),
      true,
    );
    assert.equal(enabled.route?.functionName, "mcp");
    assert.equal(enabled.response, null);
  }

  const main = await source("deploy/edge-runtime/main/index.ts");
  assert.match(
    main,
    /const mcpPublicEnvironmentValue = Deno\.env\.get\(MCP_PUBLIC_ENABLED_ENV\);/,
  );
  assert.equal(
    (main.match(/Deno\.env\.get\(MCP_PUBLIC_ENABLED_ENV\)/g) ?? []).length,
    1,
  );
  assert.match(main, /return await handleGatewayRequest\(/);
  assert.equal(
    await readFile(resolve(repoRoot, "supabase/functions/mcp/index.ts"), "utf8")
      .then(() => true, () => false),
    true,
    "the routed worker module must exist",
  );
});

test("H1 worker environments admit storage only where needed and exclude OAuth secrets", () => {
  const database = ["SWARM_DATABASE_URL", "SUPABASE_DB_URL", "SWARM_DATABASE_TLS_CA_B64"];
  const hooks = ["SWARM_CMD_TEST_SLEEP_AFTER_STEP", "SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP"];
  const command = [...database, "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "SWARM_ENV", "SWARM_COMMAND_ALLOWED_ORIGINS", "SWARM_CAPABILITY_URLS", "SWARM_SELF_SERVE", ...hooks];
  const expected = [
    "SWARM_DATABASE_URL",
    "SUPABASE_DB_URL",
    "SWARM_DATABASE_TLS_CA_B64",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SWARM_ENV",
    "SWARM_MCP_ISSUER",
    "SWARM_MCP_RESOURCE",
    "SWARM_MCP_JWKS_URL",
    "SWARM_MCP_ALLOWED_ORIGINS",
    "SWARM_MCP_MAX_BODY_BYTES",
    "SWARM_MCP_MAX_RESPONSE_BYTES",
    "SWARM_MCP_REQUEST_TIMEOUT_MS",
    "SWARM_MCP_MAX_CONCURRENT_REQUESTS",
    "SWARM_MCP_JWKS_CACHE_TTL_SECONDS",
    "SWARM_MCP_CLOCK_SKEW_SECONDS",
    "SWARM_MCP_PUBLIC_ENABLED",
    "SWARM_MCP_TODOS_LISTS_ENABLED",
  ];
  const allowlists = {
    command, admin: command,
    read: [...database, "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
      "SWARM_ENV", "SWARM_COMMAND_ALLOWED_ORIGINS"],
    h0: command.filter(name => name !== "SUPABASE_SERVICE_ROLE_KEY"),
    activity: database,
    capability: [...database, "SWARM_ENV", "SWARM_CAPABILITY_URLS", "SWARM_CAPABILITY_ALLOWED_ORIGINS"],
    mcp: expected,
  };
  const oauthSecrets = ["MCP_OAUTH_SIGNING_KEYS_FILE", "MCP_OAUTH_COOKIE_KEYS_FILE",
    "MCP_OAUTH_DATABASE_CREDENTIALS_FILE", "MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE",
    "MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE", "OAUTH_CLIENT_SECRET"];
  const host = Object.fromEntries([...new Set([...Object.values(allowlists).flat(), ...oauthSecrets])]
    .map(name => [name, `synthetic:${name}`]));
  for (const flag of [undefined, "", "0", "true", "01", "1 ", "1"]) {
    for (const mode of ["production", "test"]) {
      const get = (name: string) => name === "SWARM_ENV" ? mode
        : name === "SWARM_MCP_TODOS_LISTS_ENABLED" ? flag : host[name];
      for (const worker of FUNCTION_NAMES) {
        const entries = environmentFor(worker, get);
        const names = entries.map(([name]) => name);
        const admitted = allowlists[worker].filter(name => (mode === "test" || !hooks.includes(name))
          && (worker !== "mcp" || name !== "SUPABASE_SERVICE_ROLE_KEY" || flag === "1")
          && get(name) !== undefined);
        assert.deepEqual(entries, admitted.map(name => [name, get(name)]), `${worker}/${mode}/${flag}`);
        assert.ok(names.includes("SWARM_DATABASE_URL"), `${worker} must receive its positive control`);
        assert.deepEqual(names.filter(name => oauthSecrets.includes(name)), []);
        if (["h0", "activity", "capability"].includes(worker)) {
          assert.equal(names.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
        }
        if (worker === "command" || worker === "admin" || worker === "read") {
          assert.ok(names.includes("SUPABASE_SERVICE_ROLE_KEY"), `${worker} storage control`);
        }
        if (worker === "mcp") assert.equal(names.includes("SUPABASE_SERVICE_ROLE_KEY"), flag === "1");
      }
    }
  }
  assert.deepEqual(environmentFor("read", () => undefined), [], "undefined host names are omitted");
});
