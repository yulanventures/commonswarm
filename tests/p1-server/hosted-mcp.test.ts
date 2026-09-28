/** HM lane-7 endpoint pipeline coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
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
