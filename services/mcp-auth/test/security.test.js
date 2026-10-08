import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  assertAllowedOrigin,
  consentSecurityHeaders,
  INTERACTION_SECURITY_HEADERS,
  hashOpaque,
  opaqueMatches,
  SESSION_COOKIE_ATTRIBUTES,
  sessionCookie,
} from "../src/browser-security.js";
import { createConsentOrchestrator } from "../src/consent.js";
import { createGoTrueClient } from "../src/gotrue.js";
import { createLogger } from "../src/logger.js";
import {
  addressIsPublic,
  createPinnedMetadataFetch,
  createPostgresCimdFetch,
} from "../src/metadata-fetch.js";
import { createHandler } from "../src/server.js";

test("browser cookie and Origin contract fail closed", () => {
  assert.equal(SESSION_COOKIE_ATTRIBUTES, "Secure; HttpOnly; Path=/; SameSite=Lax");
  assert.equal(sessionCookie("opaque").includes("Domain="), false);
  const allowed = new Set(["https://commonswarm.com"]);
  assert.doesNotThrow(() => assertAllowedOrigin("https://commonswarm.com", allowed));
  for (const origin of [undefined, "https://www.commonswarm.com", "null", "https://commonswarm.com.evil"]){
    assert.throws(() => assertAllowedOrigin(origin, allowed), { code: "origin_forbidden" });
  }
});

test("opaque comparison returns false when the expected hash is absent", () => {
  assert.equal(opaqueMatches("value", null), false);
  assert.equal(opaqueMatches("value"), false);
  assert.equal(opaqueMatches("value", hashOpaque("value")), true);
});

test("consent orchestration uses every lane-2 management command with only verified identity", async () => {
  const calls = [];
  const orchestrator = createConsentOrchestrator({
    command: async (...args) => {
      calls.push(args);
      return { status: 200, body: { ok: true } };
    },
  });
  const identity = {
    userId: "10000000-0000-4000-8000-000000000001",
    email: "human@example.test",
    displayName: "Human",
    identityVerified: true,
    interactiveAuthAtSeconds: 1,
  };
  const activation = {
    interactionRef: "interaction-1",
    providerGrantId: "provider-grant-1",
    clientId: "https://client.example/metadata.json",
    identity,
    workspaceIds: [
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000001",
    ],
    homeWorkspaceId: "20000000-0000-4000-8000-000000000001",
    grantId: "30000000-0000-4000-8000-000000000001",
  };
  await orchestrator.activate(activation);
  assert.ok(calls.every((args) => args.length === 2));
  assert.deepEqual(calls.map(([body]) => body.command.kind), [
    "begin_hosted_mcp_grant",
    "consent_hosted_mcp_workspace",
    "consent_hosted_mcp_workspace",
    "activate_hosted_mcp_grant",
  ]);
  assert.ok(calls.every(([, commandIdentity]) => commandIdentity === identity));
  assert.equal(calls[0][0].command.resource, "https://mcp.commonswarm.com/mcp");
  assert.equal(calls[0][0].command.owner_user_id, identity.userId);
  await orchestrator.revoke({
    interactionRef: activation.interactionRef,
    grantId: activation.grantId,
    homeWorkspaceId: activation.homeWorkspaceId,
    identity,
  });
  assert.equal(calls.at(-1)[0].command.kind, "revoke_hosted_mcp_grant");
});

test("GoTrue PKCE sign-in round-trips the one-use state in the callback URL", async () => {
  const requests = [];
  const client = createGoTrueClient({
    baseUrl: "https://api.commonswarm.com/auth/v1",
    anonKey: "public-test-anon-key",
    provider: "github",
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/token")) return Response.json({ access_token: "server-held-token", expires_in: 3600 });
      return Response.json({ id: "10000000-0000-4000-8000-000000000001", email: "human@example.test" });
    },
  });
  const begun = client.begin({
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
    interactionUid: "interaction-1",
  });
  const redirectTo = new URL(begun.url.searchParams.get("redirect_to"));
  assert.equal(redirectTo.searchParams.get("state"), begun.state);
  assert.equal(redirectTo.searchParams.get("interaction"), "interaction-1");
  const exchanged = await client.exchange({ code: "one-use-code", verifier: begun.verifier });
  assert.equal(exchanged.identity.userId, "10000000-0000-4000-8000-000000000001");
  assert.equal(JSON.stringify(exchanged).includes("server-held-token"), false);
  assert.equal(requests.length, 2);
});

test("CIMD transport rejects every non-public DNS answer before opening a socket", async () => {
  const denied = ["127.0.0.1", "10.0.0.1", "172.20.0.2", "192.168.1.1",
    "169.254.169.254", "192.31.196.1", "192.52.193.1", "192.88.99.1",
    "192.175.48.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1",
    "fe80::1", "::ffff:127.0.0.1", "64:ff9b::0808:0808",
    "64:ff9b:1::0808:0808", "100::1", "2001::1", "2001:100::1",
    "2001:db8::1", "2002:0808:0808::", "2620:4f:8000::1", "3fff::1", "5f00::1"];
  for (const address of denied) {
    assert.equal(addressIsPublic(address), false, address);
    let socketOpens = 0;
    const fetchMetadata = createPinnedMetadataFetch({
      lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      request: () => {
        socketOpens += 1;
        throw new Error("socket must not open");
      },
    });
    await assert.rejects(
      fetchMetadata("https://client.example/metadata.json"),
      /exclusively to public/u,
    );
    assert.equal(socketOpens, 0, address);
  }
  assert.equal(addressIsPublic("8.8.8.8"), true);
  let publicSocketOpens = 0;
  const publicFetch = createPinnedMetadataFetch({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    request: () => {
      publicSocketOpens += 1;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
      request.end = () => request.destroy(new Error("public socket opened"));
      return request;
    },
  });
  await assert.rejects(publicFetch("https://client.example/metadata.json"), /public socket opened/u);
  assert.equal(publicSocketOpens, 1);

  const mixedFetch = createPinnedMetadataFetch({
    lookup: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "172.20.0.2", family: 4 },
    ],
  });
  await assert.rejects(
    mixedFetch("https://client.example/metadata.json"),
    /exclusively to public/u,
  );
});

test("PostgreSQL CIMD cache serves live validated metadata and revalidates after expiry", async () => {
  const clientId = "https://cached.example/metadata.json";
  const metadata = { client_id: clientId, redirect_uris: ["https://cached.example/callback"] };
  let cacheFresh = true;
  let networkFetches = 0;
  const fetchMetadata = createPostgresCimdFetch({
    query: async (_sql, parameters) => {
      assert.deepEqual(parameters, [clientId]);
      return cacheFresh
        ? { rowCount: 1, rows: [{ metadata, max_age: 30 }] }
        : { rowCount: 0, rows: [] };
    },
  }, async () => {
    networkFetches += 1;
    return Response.json({ ...metadata, client_name: "revalidated" });
  });
  const cached = await fetchMetadata(clientId);
  assert.deepEqual(await cached.json(), metadata);
  assert.equal(cached.headers.get("cache-control"), "private, max-age=30");
  assert.equal(networkFetches, 0);
  cacheFresh = false;
  assert.equal((await (await fetchMetadata(clientId)).json()).client_name, "revalidated");
  assert.equal(networkFetches, 1);
});

test("structured logging omits headers, bodies, cookies, codes, and tokens", () => {
  const lines = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info({
    event: "request_complete",
    method: "POST",
    path: "/token?code=secret-code",
    status: 400,
    authorization: "Bearer secret-token",
    cookie: "session=secret-cookie",
    body: "refresh_token=secret-refresh",
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "request_complete", method: "POST", path: "/token", status: 400,
  });
  assert.doesNotMatch(lines[0], /secret-|authorization|cookie|body|refresh_token/u);
});

test("public authorization is disabled while health and discovery remain reachable", async () => {
  let providerCalls = 0;
  const handler = createHandler({
    provider: { callback: () => (_request, response) => {
      providerCalls += 1;
      response.end("provider");
    } },
    pool: { query: async () => ({ rows: [{ healthy: 1 }] }) },
    publicAuthorizationEnabled: false,
    maxBodyBytes: 1024,
    logger: createLogger(() => {}),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    const authorize = await fetch(`${origin}/authorize`, { redirect: "manual" });
    assert.equal(authorize.status, 503);
    assert.equal((await authorize.json()).error, "authorization_service_disabled");
    const discovery = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(await discovery.text(), "provider");
    assert.equal(providerCalls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("interaction pages send a same-origin referrer policy so form POSTs carry a real Origin", () => {
  // Under "no-referrer" browsers serialize a form POST's Origin as "null", which assertAllowedOrigin
  // must keep refusing; the page header therefore has to allow the same-origin Origin through.
  assert.equal(INTERACTION_SECURITY_HEADERS["referrer-policy"], "same-origin");
  const csp = INTERACTION_SECURITY_HEADERS["content-security-policy"];
  assert.doesNotMatch(csp, /(^|;)\s*sandbox\b/);
  assert.match(csp, /form-action 'self'/);
  assert.throws(() => assertAllowedOrigin("null", new Set(["https://mcp.commonswarm.com"])), { code: "origin_forbidden" });
});

test("consent CSP serializes only a safe HTTPS or explicitly allowed loopback origin", () => {
  for (const [uri, options, origin] of [
    ["https://claude.ai/api/mcp/auth_callback?state=synthetic", {}, "https://claude.ai"],
    ["https://client.example:8443/callback", {}, "https://client.example:8443"],
    ["http://127.0.0.1:49152/callback", { allowLoopback: true }, "http://127.0.0.1:49152"],
    ["http://localhost:49152/callback", { allowLoopback: true }, "http://localhost:49152"],
    ["http://[::1]:49152/callback", { allowLoopback: true }, "http://[::1]:49152"],
  ]) {
    const headers = consentSecurityHeaders(uri, options);
    assert.equal(headers["content-security-policy"],
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'; script-src 'self'; script-src-attr 'none'`);
    for (const name of ["cache-control", "referrer-policy", "x-content-type-options"]) {
      assert.equal(headers[name], INTERACTION_SECURITY_HEADERS[name]);
    }
  }
  for (const uri of [
    undefined, "not-a-url", "https://claude.ai;form-action *", "https://claude.ai/\n; form-action *",
    "https://claude.ai/callback\u0000", "https://claude.ai/callback\u007f",
    "https://claude.ai%3bform-action.example/callback", "https://claude.ai/callback#fragment",
    "https://user:password@claude.ai/callback", "https://claude.ai\\@attacker.example/callback",
    "https://bad_host.example/callback", "https://[2001:db8::1]/callback",
    "javascript:alert(1)", "data:text/html,hello", "file:///callback", "custom:/callback",
    "http://attacker.example/callback", "http://127.0.0.2/callback",
    "http://127.0.0.1.attacker.example/callback",
  ]) {
    assert.throws(() => consentSecurityHeaders(uri, { allowLoopback: true }), TypeError, String(uri));
  }
  assert.throws(() => consentSecurityHeaders("http://127.0.0.1:49152/callback"), TypeError);
});
