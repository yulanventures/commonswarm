import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("hosted JWT requires exact mcp scope after claim checks without logging credentials", async (t) => {
  const signing = await key("scope-enforcement");
  const source = jwksFetch([{ keys: [signing.publicJwk] }]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  const logging = t.mock.method(console, "warn", () => undefined);
  for (const [scope, hasMcp] of [
    ["mcp", true], ["openid mcp offline_access", true], [undefined, false],
    ["", false], ["openid", false], ["openid offline_access", false], ["mcpx", false], ["MCP", false], ["mcp\topenid", false], ["notmcp", false], ["mcp:read", false], [["mcp"], false],
  ] as const) {
    logging.mock.resetCalls();
    const encoded = await token(signing, { scope, email: "private-user@example.invalid" });
    if (hasMcp) {
      assert.deepEqual(await verifier.verify(encoded), {
        providerGrantId: "provider-grant-1", subject, expiresAt: now + 300,
      });
    } else {
      // Undefined scope is omitted by JSON.stringify: ordinary audience with
      // no scope claim, matching the issuer's narrowed-refresh JWT shape.
      await assert.rejects(verifier.verify(encoded), (error: unknown) =>
        error instanceof McpTokenError && error.code === "insufficient_scope");
    }
    assert.deepEqual(logging.mock.calls.map(({ arguments: args }) => {
      assert.equal(args.length, 1);
      assert.equal(args[0].includes(encoded), false);
      return JSON.parse(args[0]);
    }), hasMcp ? [] : [{
      event: "insufficient_scope",
      client_kind: "opaque",
      client_host: null,
      client_id_sha256_12: createHash("sha256").update("fixture-client-id", "utf8").digest("hex").slice(0, 12),
    }]);
  }

  // Only verified, otherwise-valid tokens reach scope enforcement.
  logging.mock.resetCalls();
  await assert.rejects(verifier.verify(await token(signing, { scope: undefined, iat: now - 301, exp: now - 31 })), /invalid_token/u);
  await assert.rejects(verifier.verify(await token(signing, { scope: undefined, aud: "https://wrong.invalid" })), /invalid_token/u);
  assert.equal(logging.mock.callCount(), 0);

});

test("insufficient scope logs a client host and exact UTF-8 fingerprint without credentials or claims", async (t) => {
  const signing = await key("client-identification");
  const source = jwksFetch([{ keys: [signing.publicJwk] }]);
  const verifier = new McpJwtVerifier({ fetch: source.fetch, now: () => now });
  const logging = t.mock.method(console, "warn", () => undefined);
  const scope = "private-scope-value";
  const email = "private-user@example.invalid";
  await verifier.verify(await token(signing));
  assert.equal(logging.mock.callCount(), 0, "valid scope does not emit a refusal");

  for (const { client_id, kind, host, forbidden = [] } of [
    { client_id: "https://connector.example/private-client-path?private-query=value#private-fragment", kind: "url", host: "connector.example", forbidden: ["private-client-path", "private-query", "private-fragment"] },
    { client_id: "opaque-private-client-id", kind: "opaque", host: null, forbidden: ["opaque-"] },
    { client_id: undefined, kind: "absent", host: null },
    { client_id: null, kind: "absent", host: null },
    { client_id: 42, kind: "absent", host: null },
    { client_id: "https://private-user:private-password@BÜCHER.Example:8443/private-hostile-path?private-hostile-query=value", kind: "url", host: "xn--bcher-kva.example", forbidden: ["private-user", "private-password", "8443", "private-hostile-path", "private-hostile-query"] },
    { client_id: "https://bad_host.example/private-invalid-host-path", kind: "url", host: null, forbidden: ["bad_host", "private-invalid-host-path"] },
    { client_id: "https://127.0.0.1/private-ip-path", kind: "url", host: null, forbidden: ["127.0.0.1", "private-ip-path"] },
    { client_id: "https://[::1]/private-ipv6-path", kind: "url", host: null, forbidden: ["::1", "private-ipv6-path"] },
    { client_id: "https://not a url/private-malformed-path", kind: "opaque", host: null, forbidden: ["not a url", "private-malformed-path"] },
    { client_id: "tiny", kind: "opaque", host: null },
    { client_id: "bad\n\"\\id-private-雪", kind: "opaque", host: null, forbidden: ["id-private", "雪"] },
    { client_id: "", kind: "opaque", host: null },
  ] as const) {
    logging.mock.resetCalls();
    const encoded = await token(signing, { scope, client_id, email });
    await assert.rejects(verifier.verify(encoded), (error: unknown) =>
      error instanceof McpTokenError && error.code === "insufficient_scope");
    assert.equal(logging.mock.callCount(), 1);
    const args = logging.mock.calls[0]!.arguments;
    assert.equal(args.length, 1);
    const line = args[0] as string;
    for (const secret of [encoded, scope, email, subject, "provider-grant-1", ...forbidden]) {
      assert.equal(line.includes(secret), false, "log must redact credentials and claims");
    }
    if (typeof client_id === "string" && client_id !== "") {
      assert.equal(line.includes(client_id), false, "never emit the full client ID");
    }
    assert.deepEqual(JSON.parse(line), {
      event: "insufficient_scope",
      client_kind: kind,
      client_host: host,
      client_id_sha256_12: typeof client_id === "string"
        ? createHash("sha256").update(client_id, "utf8").digest("hex").slice(0, 12)
        : null,
    });
  }
});
