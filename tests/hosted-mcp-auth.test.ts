import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE, McpJwtVerifier, McpTokenError } from "../supabase/functions/mcp/auth.ts";

const subject = "11111111-1111-4111-8111-111111111111";
const now = 1_800_000_000;

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function key(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...await crypto.subtle.exportKey("jwk", pair.publicKey),
      kid,
      alg: "ES256",
      use: "sig",
    },
  };
}

async function token(
  signing: Awaited<ReturnType<typeof key>>,
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = base64url(Buffer.from(JSON.stringify({
    alg: "ES256",
    kid: signing.kid,
    typ: "at+jwt",
    ...headerOverrides,
  })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: MCP_ISSUER,
    aud: MCP_RESOURCE,
    sub: subject,
    grant_id: "provider-grant-1",
    client_id: "fixture-client-id",
    scope: "mcp",
    iat: now,
    exp: now + 300,
    ...overrides,
  })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.privateKey,
    Buffer.from(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

function jwksFetch(documents: Array<Record<string, unknown>>) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      const body = documents[Math.min(calls, documents.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

test("hosted JWT accepts a real ES256 token and rejects algorithm and key URL substitution", async () => {
  const signing = await key("active");
  const source = jwksFetch([{ keys: [signing.publicJwk] }]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  assert.deepEqual(await verifier.verify(await token(signing)), {
    providerGrantId: "provider-grant-1",
    subject,
    expiresAt: now + 300,
  });
  await assert.rejects(
    verifier.verify(await token(signing, {}, { alg: "HS256" })),
    /invalid_token/u,
  );
  await assert.rejects(
    verifier.verify(await token(signing, {}, { jku: "https://attacker.invalid/jwks" })),
    /invalid_token/u,
  );
  assert.equal(source.calls(), 1, "token headers never steer another key fetch");
});

test("hosted JWT mismatch denials share a valid issuer and audience control", async () => {
  const signing = await key("active");
  const source = jwksFetch([{ keys: [signing.publicJwk] }]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  await verifier.verify(await token(signing));
  await assert.rejects(verifier.verify(await token(signing, { iss: "https://wrong.invalid" })), /invalid_token/u);
  await assert.rejects(verifier.verify(await token(signing, { aud: `${MCP_RESOURCE}/wrong` })), /invalid_token/u);
});

test("an unknown kid performs one bounded JWKS refresh and then fails closed", async () => {
  const first = await key("first");
  const rotated = await key("rotated");
  const absent = await key("absent");
  const source = jwksFetch([
    { keys: [first.publicJwk] },
    { keys: [first.publicJwk, rotated.publicJwk] },
    { keys: [first.publicJwk, rotated.publicJwk] },
  ]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  await verifier.verify(await token(first));
  await verifier.verify(await token(rotated));
  assert.equal(source.calls(), 2);
  await assert.rejects(verifier.verify(await token(absent)), /invalid_token/u);
  assert.equal(source.calls(), 3, "one refresh is attempted for the unknown kid");
});

test("hosted JWT requires the exact mcp scope after signature and claim validation", async () => {
  const signing = await key("scope-enforcement");
  const source = jwksFetch([{ keys: [signing.publicJwk] }]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  for (const scope of [undefined, "", "openid offline_access", "notmcp", "mcp:read", "MCP", "admin:read", ["mcp"]]) {
    await assert.rejects(verifier.verify(await token(signing, { scope })),
      (error: unknown) => error instanceof McpTokenError && error.code === "insufficient_scope");
  }
  for (const scope of ["mcp", "openid mcp offline_access"]) {
    assert.deepEqual(await verifier.verify(await token(signing, { scope })), {
      providerGrantId: "provider-grant-1", subject, expiresAt: now + 300,
    });
  }
  // Invalid tokens cannot obtain an authenticated insufficient-scope response.
  for (const overrides of [
    { scope: undefined, iat: now - 301, exp: now - 31 },
    { scope: undefined, aud: "https://wrong.invalid" },
  ]) {
    await assert.rejects(verifier.verify(await token(signing, overrides)),
      (error: unknown) => error instanceof McpTokenError && error.code === "invalid_token");
  }
  const attacker = await key("scope-enforcement");
  await assert.rejects(verifier.verify(await token(attacker, { scope: undefined })),
    (error: unknown) => error instanceof McpTokenError && error.code === "invalid_token");
});
