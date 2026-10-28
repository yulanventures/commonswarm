/** HM lane-7 endpoint pipeline coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// @ts-expect-error TS5097: the server suite imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE, McpJwtVerifier } from "../../supabase/functions/mcp/auth.ts";
// @ts-expect-error TS5097: the server suite imports the Deno source directly.
import { createMcpProtocolHandler, WWW_AUTHENTICATE } from "../../supabase/functions/mcp/protocol.ts";

const now = 1_800_000_000;
const subject = "11111111-1111-4111-8111-111111111111";

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    kid: "server-suite",
    alg: "ES256",
    use: "sig",
  };
  const issue = async (audience = MCP_RESOURCE) => {
    const header = b64(Buffer.from(JSON.stringify({ alg: "ES256", kid: "server-suite" })));
    const payload = b64(Buffer.from(JSON.stringify({
      iss: MCP_ISSUER,
      aud: audience,
      sub: subject,
      grant_id: "provider-grant-server-suite",
      scope: "mcp",
      iat: now,
      exp: now + 300,
    })));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      Buffer.from(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64(new Uint8Array(signature))}`;
  };
  const verifier = new McpJwtVerifier({
    now: () => now,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }),
  });
  const calls: string[] = [];
  const serve = createMcpProtocolHandler({
    issuer: MCP_ISSUER,
    resource: MCP_RESOURCE,
    publicEnabled: true,
    allowedOrigins: new Set(),
    limits: {
      maxBodyBytes: 4096,
      maxResponseBytes: 64 * 1024,
      requestTimeoutMs: 2_000,
      maxConcurrentRequests: 2,
    },
    verifyToken: (token, signal) => verifier.verify(token, signal),
    executeTool: async ({ name, token }) => {
      calls.push(`${name}:${token.providerGrantId}`);
      return { principal_id: "22222222-2222-4222-8222-222222222222" };
    },
  });
  return { issue, serve, calls };
}

test("HTTP MCP tool call verifies a real JWT before dispatch; bad audience cannot dispatch", async () => {
  const { issue, serve, calls } = await fixture();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "server-control",
    method: "tools/call",
    params: { name: "whoami", arguments: { seat: "seat_ABCDEFGHIJKLMNOPQRSTUV" } },
  });
  const control = await serve(new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await issue()}`,
      "content-type": "application/json",
    },
    body,
  }));
  assert.equal(control.status, 200);
  assert.deepEqual(calls, ["whoami:provider-grant-server-suite"]);

  const denied = await serve(new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await issue(`${MCP_RESOURCE}/wrong`)}`,
      "content-type": "application/json",
    },
    body,
  }));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), WWW_AUTHENTICATE);
  assert.equal(calls.length, 1, "invalid tokens never reach tool dispatch");
});


// Independent wire-contract proof: run each revision's actual protocol/catalog,
// rather than copying the tool table or reconstructing its descriptions/schema.
// A temporary source archive has no Git index or branch and is cleaned locally
// by this Linux test.
test("hosted tools/list bytes match the approved baseline through both actual catalog runners", { timeout: 150_000 }, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), "hosted-context-catalog-"));
  try {
    const baseline = join(temp, "baseline");
    mkdirSync(baseline);
    const archive = execFileSync("git", ["archive", "5ccc1bd057f703c9ff58892adb0ca61a12871485",
      "supabase/functions/mcp", "supabase/functions/_shared"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", baseline], { input: archive });
    const runner = join(temp, "catalog.ts");
    writeFileSync(runner, `
const { createMcpProtocolHandler } = await import(Deno.args[0]);
const serve = createMcpProtocolHandler({
  issuer: "https://mcp.commonswarm.com", resource: "https://mcp.commonswarm.com/mcp",
  publicEnabled: true, allowedOrigins: new Set(),
  limits: { maxBodyBytes: 4096, maxResponseBytes: 128 * 1024, requestTimeoutMs: 2000, maxConcurrentRequests: 1 },
  verifyToken: async () => ({ providerGrantId: "catalog-fixture", subject: "11111111-1111-4111-8111-111111111111", expiresAt: 1900000000 }),
  executeTool: async () => { throw new Error("tools/list must not execute"); },
});
const response = await serve(new Request("https://mcp.commonswarm.com/mcp", {
  method: "POST", headers: { authorization: "Bearer catalog.fixture.value", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "catalog", method: "tools/list", params: {} }),
}));
console.log(JSON.stringify({ status: response.status, text: await response.text() }));
`);
    const catalog = (source: string, enabled: string): { status: number; text: string } => JSON.parse(execFileSync("deno", [
      "run", "--no-lock", "--config", "supabase/functions/command/deno.json", "--allow-env", "--allow-read",
      runner, pathToFileURL(join(source, "supabase/functions/mcp/protocol.ts")).href,
    ], { cwd: root, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
        SWARM_MCP_TODOS_LISTS_ENABLED: enabled },
    }));
    for (const enabled of ["0", "1"]) {
      const before = catalog(baseline, enabled);
      const after = catalog(root, enabled);
      assert.equal(before.status, 200);
      assert.deepEqual(after, before, "serialized names/descriptions/input schemas/scopes/annotations remain byte-identical");
      if (enabled === "0") assert.equal(JSON.parse(after.text).result.tools.length, 8);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
