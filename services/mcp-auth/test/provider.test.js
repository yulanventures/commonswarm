import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from "jose";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  CIMD_CACHE_DURATION_SECONDS,
  createMcpProvider,
  ISSUER,
  RESOURCE,
  TEST_ACCOUNT_ID,
} from "../src/provider.js";
import { createProductionFindAccount } from "../src/server.js";
import { createAtomicMemoryAdapter } from "../src/memory-adapter.js";
import {
  METADATA_BODY_LIMIT_BYTES,
  METADATA_FETCH_TIMEOUT_MS,
} from "../src/metadata-fetch.js";

const DEFAULT_REDIRECT_URI = "https://connector.example/oauth/callback";
const CODE_VERIFIER = "commonswarm-mcp-auth-spike-verifier-0123456789abcdef";
const CODE_CHALLENGE = createHash("sha256")
  .update(CODE_VERIFIER)
  .digest("base64url");

function clientMetadata(clientId, {
  applicationType = "web",
  redirectUris = [DEFAULT_REDIRECT_URI],
} = {}) {
  return {
    application_type: applicationType,
    client_id: clientId,
    client_name: "CommonSwarm MCP OAuth spike client",
    grant_types: ["authorization_code", "refresh_token"],
    id_token_signed_response_alg: "ES256",
    redirect_uris: redirectUris,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function metadataFetchFromMap(documents) {
  return async (url) => {
    const document = documents.get(String(url));
    if (!document) {
      return new Response("not found", { status: 404 });
    }
    return document instanceof Response ? document : jsonResponse(document);
  };
}

async function autoApprove(provider, request, response) {
  const details = await provider.interactionDetails(request, response);
  const { prompt, params, session, grantId } = details;

  if (prompt.name === "login") {
    await provider.interactionFinished(request, response, {
      login: { accountId: TEST_ACCOUNT_ID },
    });
    return;
  }

  if (prompt.name !== "consent") {
    throw new Error(`unexpected interaction prompt: ${prompt.name}`);
  }

  let grant = grantId ? await provider.Grant.find(grantId) : undefined;
  if (!grant) {
    grant = new provider.Grant({
      accountId: session.accountId,
      clientId: params.client_id,
    });
  }

  if (prompt.details.missingOIDCScope) {
    grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
  }
  if (prompt.details.missingOIDCClaims) {
    grant.addOIDCClaims(prompt.details.missingOIDCClaims);
  }
  for (const [resource, scopes] of Object.entries(prompt.details.missingResourceScopes ?? {})) {
    grant.addResourceScope(resource, scopes.join(" "));
  }

  await provider.interactionFinished(request, response, {
    consent: { grantId: await grant.save() },
  });
}

async function startProvider(injectedFetch, options = {}) {
  const provider = await createMcpProvider({ ...options, fetch: injectedFetch });
  const oidcCallback = provider.callback();
  const server = createServer((request, response) => {
    const path = new URL(request.url, ISSUER).pathname;
    const operation = path.startsWith("/interaction/")
      ? autoApprove(provider, request, response)
      : oidcCallback(request, response);
    Promise.resolve(operation).catch((error) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "text/plain");
      }
      response.end(error.stack ?? String(error));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const loopbackOrigin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map();

  async function request(target, options = {}) {
    const original = new URL(target, ISSUER);
    const local = new URL(`${original.pathname}${original.search}`, loopbackOrigin);
    const headers = new Headers(options.headers);
    headers.set("host", new URL(ISSUER).host);
    headers.set("x-forwarded-host", new URL(ISSUER).host);
    headers.set("x-forwarded-proto", "https");
    if (cookies.size) {
      headers.set("cookie", [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "));
    }

    const result = await fetch(local, { ...options, headers, redirect: "manual" });
    for (const cookie of result.headers.getSetCookie()) {
      const [pair] = cookie.split(";", 1);
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return result;
  }

  return {
    provider,
    request,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function authorizationUrl({
  clientId,
  redirectUri = DEFAULT_REDIRECT_URI,
  resource = RESOURCE,
  challenge = CODE_CHALLENGE,
  challengeMethod = "S256",
  state = "spike-state",
} = {}) {
  const url = new URL("/authorize", ISSUER);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid offline_access mcp");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  if (resource !== undefined) url.searchParams.set("resource", resource);
  if (challenge !== null) url.searchParams.set("code_challenge", challenge);
  if (challengeMethod !== null) url.searchParams.set("code_challenge_method", challengeMethod);
  return url;
}

async function followAuthorization(server, url) {
  let current = url;
  for (let step = 0; step < 10; step += 1) {
    const response = await server.request(current);
    assert.ok([302, 303].includes(response.status), `expected redirect, got ${response.status}: ${await response.text()}`);
    const location = new URL(response.headers.get("location"), ISSUER);
    if (location.origin !== ISSUER) {
      return location;
    }
    current = location;
  }
  throw new Error("authorization interaction did not finish");
}

async function tokenRequest(server, parameters) {
  const response = await server.request(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });
  const body = await response.json();
  return { response, body };
}

async function assertAuthorizationError(response, error) {
  assert.equal(response.status, 400);
  assert.match(await response.text(), new RegExp(`<strong>error</strong>: ${error}`, "u"));
}

async function authorizeAndExchange(server, {
  clientId,
  redirectUri = DEFAULT_REDIRECT_URI,
} = {}) {
  const callback = await followAuthorization(server, authorizationUrl({ clientId, redirectUri }));
  assert.equal(callback.searchParams.get("error"), null);
  assert.equal(callback.searchParams.get("state"), "spike-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const exchanged = await tokenRequest(server, {
    client_id: clientId,
    code,
    code_verifier: CODE_VERIFIER,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
  assert.equal(exchanged.response.status, 200, JSON.stringify(exchanged.body));
  return { callback, tokens: exchanged.body };
}

let sharedServer;
const sharedDocuments = new Map();

before(async () => {
  sharedServer = await startProvider(metadataFetchFromMap(sharedDocuments), {
    nativeLoopbackEnabled: true,
  });
});

after(async () => {
  await sharedServer.close();
});

test("1. discovery publishes the required OAuth and OIDC metadata", async () => {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ]) {
    const response = await sharedServer.request(`${ISSUER}${path}`);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.issuer, ISSUER);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.ok(metadata.scopes_supported.includes("offline_access"));
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  }
});

test("2. CIMD uses injected fetch and rejects unsafe or invalid metadata", async () => {
  const exactId = "https://client-exact.example/oauth-client.json";
  let observedOptions;
  const documents = new Map([[exactId, clientMetadata(exactId)]]);
  const fetchedUrls = [];
  const server = await startProvider(async (url, options) => {
    fetchedUrls.push(String(url));
    observedOptions = options;
    return metadataFetchFromMap(documents)(url);
  });

  try {
    const accepted = await server.request(authorizationUrl({ clientId: exactId }));
    assert.equal(accepted.status, 303);
    assert.match(accepted.headers.get("location"), /^\/interaction\//u);
    assert.equal(observedOptions.redirect, "manual");

    const mismatchId = "https://client-mismatch.example/oauth-client.json";
    documents.set(mismatchId, clientMetadata("https://different.example/oauth-client.json"));
    const mismatch = await server.request(authorizationUrl({ clientId: mismatchId }));
    await assertAuthorizationError(mismatch, "invalid_client_metadata");

    const redirectMismatchId = "https://redirect-mismatch.example/oauth-client.json";
    documents.set(redirectMismatchId, clientMetadata(redirectMismatchId));
    const redirectMismatch = await server.request(authorizationUrl({
      clientId: redirectMismatchId,
      redirectUri: "https://connector.example/not-registered",
    }));
    await assertAuthorizationError(redirectMismatch, "invalid_redirect_uri");

    const fetchesBeforeBlockedUrls = fetchedUrls.length;
    const httpClient = await server.request(authorizationUrl({
      clientId: "http://client.example/oauth-client.json",
    }));
    await assertAuthorizationError(httpClient, "invalid_client");

    for (const clientId of [
      "https://127.0.0.1/oauth-client.json",
      "https://192.168.1.20/oauth-client.json",
      "https://localhost/oauth-client.json",
      "https://[::ffff:192.168.1.20]/oauth-client.json",
      "https://[::ffff:7f00:1]/oauth-client.json",
      "https://[2002:c0a8::]/oauth-client.json",
      "https://[2002:c0a8::1]/oauth-client.json",
      "https://[2002:a00::]/oauth-client.json",
      "https://[2002:7f00::]/oauth-client.json",
      "https://[2002:c0a8:114::]/oauth-client.json",
      "https://[64:ff9b::7f00:1]/oauth-client.json",
    ]) {
      const blocked = await server.request(authorizationUrl({ clientId }));
      await assertAuthorizationError(blocked, "invalid_client");
    }
    assert.equal(fetchedUrls.length, fetchesBeforeBlockedUrls);

    const redirectId = "https://redirecting.example/oauth-client.json";
    documents.set(redirectId, new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/client.json" },
    }));
    const redirected = await server.request(authorizationUrl({ clientId: redirectId }));
    await assertAuthorizationError(redirected, "invalid_client");

    const oversizedId = "https://oversized.example/oauth-client.json";
    documents.set(oversizedId, new Response("x".repeat(METADATA_BODY_LIMIT_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const oversized = await server.request(authorizationUrl({ clientId: oversizedId }));
    await assertAuthorizationError(oversized, "invalid_client");

    const slowId = "https://slow.example/oauth-client.json";
    const slowBody = new ReadableStream({
      start(controller) {
        this.timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(clientMetadata(slowId))));
          controller.close();
        }, METADATA_FETCH_TIMEOUT_MS * 3);
      },
      cancel() {
        clearTimeout(this.timer);
      },
    });
    documents.set(slowId, new Response(slowBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const slow = await server.request(authorizationUrl({ clientId: slowId }));
    await assertAuthorizationError(slow, "invalid_client");
  } finally {
    await server.close();
  }
});

test("2b. CIMD cache has bounded duration, expires, and revalidates through the injected fetch", async (t) => {
  // oidc-provider's CIMD cache reads Date.now(); keep it fixed between requests.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  assert.deepEqual(CIMD_CACHE_DURATION_SECONDS, { min: 30, max: 300 });
  const clientId = "https://cache-expiry.example/oauth-client.json";
  let fetches = 0;
  const server = await startProvider(async () => {
    fetches += 1;
    return jsonResponse(clientMetadata(clientId));
  }, { cimdCacheDuration: { min: 0.02, max: 0.02 } });
  try {
    const first = await server.request(authorizationUrl({ clientId, state: "cache-one" }));
    assert.equal(first.status, 303);
    const cached = await server.request(authorizationUrl({ clientId, state: "cache-two" }));
    assert.equal(cached.status, 303);
    assert.equal(fetches, 1);
    t.mock.timers.tick(21);
    const revalidated = await server.request(authorizationUrl({ clientId, state: "cache-three" }));
    assert.equal(revalidated.status, 303);
    assert.equal(fetches, 2);
  } finally {
    await server.close();
  }
});

test("3. PKCE requires S256 and refuses plain or missing challenges", async () => {
  const clientId = "https://pkce.example/oauth-client.json";
  sharedDocuments.set(clientId, clientMetadata(clientId));

  const accepted = await sharedServer.request(authorizationUrl({ clientId }));
  assert.equal(accepted.status, 303);

  for (const overrides of [
    { challenge: CODE_VERIFIER, challengeMethod: "plain" },
    { challenge: null, challengeMethod: null },
  ]) {
    const callback = await followAuthorization(sharedServer, authorizationUrl({ clientId, ...overrides }));
    assert.equal(callback.searchParams.get("error"), "invalid_request");
    assert.equal(callback.searchParams.has("code"), false);
  }
});

test("4. RFC 8707 binds authorization and token requests to the one MCP resource", async () => {
  const clientId = "https://resource.example/oauth-client.json";
  sharedDocuments.set(clientId, clientMetadata(clientId));

  const missingResourceUrl = authorizationUrl({ clientId });
  missingResourceUrl.searchParams.delete("resource");
  const missingAtAuthorize = await followAuthorization(sharedServer, missingResourceUrl);
  assert.equal(missingAtAuthorize.searchParams.get("error"), "invalid_target");

  const rejectedAtAuthorize = await followAuthorization(sharedServer, authorizationUrl({
    clientId,
    resource: "https://other.example/mcp",
  }));
  assert.equal(rejectedAtAuthorize.searchParams.get("error"), "invalid_target");

  const callback = await followAuthorization(sharedServer, authorizationUrl({ clientId }));
  const rejectedAtToken = await tokenRequest(sharedServer, {
    client_id: clientId,
    code: callback.searchParams.get("code"),
    code_verifier: CODE_VERIFIER,
    grant_type: "authorization_code",
    redirect_uri: DEFAULT_REDIRECT_URI,
    resource: "https://other.example/mcp",
  });
  assert.equal(rejectedAtToken.response.status, 400);
  assert.equal(rejectedAtToken.body.error, "invalid_target");

  const missingTokenCallback = await followAuthorization(sharedServer, authorizationUrl({ clientId }));
  const missingAtToken = await tokenRequest(sharedServer, {
    client_id: clientId,
    code: missingTokenCallback.searchParams.get("code"),
    code_verifier: CODE_VERIFIER,
    grant_type: "authorization_code",
    redirect_uri: DEFAULT_REDIRECT_URI,
  });
  assert.equal(missingAtToken.response.status, 400);
  assert.equal(missingAtToken.body.error, "invalid_target");

  for (const secondResource of [RESOURCE, "https://evil.example/mcp"]) {
    const duplicateTokenCallback = await followAuthorization(sharedServer, authorizationUrl({ clientId }));
    const duplicateResources = new URLSearchParams({
      client_id: clientId,
      code: duplicateTokenCallback.searchParams.get("code"),
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: DEFAULT_REDIRECT_URI,
    });
    duplicateResources.append("resource", RESOURCE);
    duplicateResources.append("resource", secondResource);
    const duplicateAtToken = await tokenRequest(sharedServer, duplicateResources);
    assert.equal(duplicateAtToken.response.status, 400);
    assert.equal(duplicateAtToken.body.error, "invalid_target");
  }
});

test("m1-admin-interaction-reserve: live AS still refuses admin authorization/code/refresh with ordinary MCP controls", async () => {
  const clientId = "https://admin-reserve.example/oauth-client.json";
  sharedDocuments.set(clientId, clientMetadata(clientId));
  const adminResource = "https://api.commonswarm.com/admin";
  const callback = await followAuthorization(sharedServer, authorizationUrl({ clientId, resource: adminResource }));
  assert.equal(callback.searchParams.get("error"), "invalid_target");

  const mcpCallback = await followAuthorization(sharedServer, authorizationUrl({ clientId }));
  const deniedCode = await tokenRequest(sharedServer, {
    client_id: clientId, code: mcpCallback.searchParams.get("code"), code_verifier: CODE_VERIFIER,
    grant_type: "authorization_code", redirect_uri: DEFAULT_REDIRECT_URI, resource: adminResource,
  });
  assert.equal(deniedCode.response.status, 400);
  assert.equal(deniedCode.body.error, "invalid_target");

  const issued = await authorizeAndExchange(sharedServer, { clientId });
  const deniedRefresh = await tokenRequest(sharedServer, {
    client_id: clientId, refresh_token: issued.tokens.refresh_token,
    grant_type: "refresh_token", resource: adminResource,
  });
  assert.equal(deniedRefresh.response.status, 400);
  assert.equal(deniedRefresh.body.error, "invalid_target");
  // A refused exchange may revoke its family; use an independent live MCP
  // family for the ordinary refresh control, preserving provider behavior.
  const control = await authorizeAndExchange(sharedServer, { clientId });
  const refreshed = await tokenRequest(sharedServer, {
    client_id: clientId, refresh_token: control.tokens.refresh_token,
    grant_type: "refresh_token", resource: RESOURCE,
  });
  assert.equal(refreshed.response.status, 200);
  assert.ok(refreshed.body.scope.split(" ").includes("mcp"));
});

test("5. RFC 9207 adds the configured issuer to the authorization response", async () => {
  const clientId = "https://response-issuer.example/oauth-client.json";
  sharedDocuments.set(clientId, clientMetadata(clientId));
  const callback = await followAuthorization(sharedServer, authorizationUrl({ clientId }));
  assert.equal(callback.searchParams.get("iss"), ISSUER);
});

test("6. access token is an independently verifiable five-minute ES256 JWT", async () => {
  const clientId = "https://jwt.example/oauth-client.json";
  sharedDocuments.set(clientId, clientMetadata(clientId));
  const { tokens } = await authorizeAndExchange(sharedServer, { clientId });

  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(tokens.access_token.split(".").length, 3);

  const jwksResponse = await sharedServer.request(`${ISSUER}/jwks`);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  const verified = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    audience: RESOURCE,
    issuer: ISSUER,
  });
  assert.equal(verified.protectedHeader.alg, "ES256");
  assert.equal(verified.payload.iss, ISSUER);
  assert.equal(verified.payload.aud, RESOURCE);
  assert.equal(verified.payload.exp - verified.payload.iat, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(verified.payload.sub, TEST_ACCOUNT_ID);
  assert.equal(typeof verified.payload.grant_id, "string");
  assert.ok(verified.payload.grant_id.length > 0);
});

async function refresh(server, clientId, refreshToken) {
  return tokenRequest(server, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: RESOURCE,
  });
}

test("7. refresh rotation rejects replay, revokes the family, and has one race winner", async () => {
  const replayClientId = "https://refresh-replay.example/oauth-client.json";
  sharedDocuments.set(replayClientId, clientMetadata(replayClientId));
  const { tokens } = await authorizeAndExchange(sharedServer, { clientId: replayClientId });
  assert.ok(tokens.refresh_token);

  const rotated = await refresh(sharedServer, replayClientId, tokens.refresh_token);
  assert.equal(rotated.response.status, 200, JSON.stringify(rotated.body));
  assert.ok(rotated.body.refresh_token);
  assert.notEqual(rotated.body.refresh_token, tokens.refresh_token);

  const replay = await refresh(sharedServer, replayClientId, tokens.refresh_token);
  assert.equal(replay.response.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  const revokedReplacement = await refresh(sharedServer, replayClientId, rotated.body.refresh_token);
  assert.equal(revokedReplacement.response.status, 400);
  assert.equal(revokedReplacement.body.error, "invalid_grant");

  let consumeArrivals = 0;
  let releaseConsumers;
  const bothConsumersArrived = new Promise((resolve) => {
    releaseConsumers = resolve;
  });
  const raceServer = await startProvider(metadataFetchFromMap(sharedDocuments), {
    adapter: createAtomicMemoryAdapter({
      beforeRefreshTokenConsume: async () => {
        consumeArrivals += 1;
        if (consumeArrivals === 2) releaseConsumers();
        await bothConsumersArrived;
      },
    }),
  });

  try {
    const raceClientId = "https://refresh-race.example/oauth-client.json";
    sharedDocuments.set(raceClientId, clientMetadata(raceClientId));
    const raceSeed = await authorizeAndExchange(raceServer, { clientId: raceClientId });
    const contenders = await Promise.all([
      refresh(raceServer, raceClientId, raceSeed.tokens.refresh_token),
      refresh(raceServer, raceClientId, raceSeed.tokens.refresh_token),
    ]);
    assert.equal(consumeArrivals, 2);
    const winners = contenders.filter(({ response }) => response.status === 200);
    const losers = contenders.filter(({ response }) => response.status === 400);
    assert.equal(winners.length, 1, JSON.stringify(contenders.map(({ response, body }) => ({ status: response.status, body }))));
    assert.equal(losers.length, 1);
    assert.equal(losers[0].body.error, "invalid_grant");

    const raceReplacement = await refresh(raceServer, raceClientId, winners[0].body.refresh_token);
    assert.equal(raceReplacement.response.status, 200, JSON.stringify(raceReplacement.body));
    assert.ok(raceReplacement.body.refresh_token);
    assert.notEqual(raceReplacement.body.refresh_token, winners[0].body.refresh_token);
  } finally {
    await raceServer.close();
  }
});

test("7b. production refresh account lookup outlives the browser session and rejects revoked grants", async () => {
  const clientId = "https://production-account.example/oauth-client.json";
  let browserSessionLive = true;
  let grantActive = true;
  let personExists = true;
  const queries = [];
  const pool = {
    query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (sql.includes("resolve_hosted_grant_status")) {
        return { rowCount: grantActive && personExists ? 1 : 0, rows: [{ active: true }] };
      }
      return { rowCount: browserSessionLive ? 1 : 0, rows: [{ present: true }] };
    },
  };
  const server = await startProvider(metadataFetchFromMap(new Map([
    [clientId, clientMetadata(clientId)],
  ])), { findAccount: createProductionFindAccount(pool) });
  try {
    const { tokens } = await authorizeAndExchange(server, { clientId });
    browserSessionLive = false;
    const afterBrowserExpiry = await refresh(server, clientId, tokens.refresh_token);
    assert.equal(afterBrowserExpiry.response.status, 200, JSON.stringify(afterBrowserExpiry.body));
    assert.ok(queries.some(({ sql }) => sql.includes("resolve_hosted_grant_status")));
    grantActive = false;
    const afterGrantRevocation = await refresh(server, clientId, afterBrowserExpiry.body.refresh_token);
    assert.equal(afterGrantRevocation.response.status, 400);
    assert.equal(afterGrantRevocation.body.error, "invalid_grant");
    grantActive = true;
    personExists = false;
    const afterPersonRemoval = await refresh(server, clientId, afterBrowserExpiry.body.refresh_token);
    assert.equal(afterPersonRemoval.response.status, 400);
    assert.equal(afterPersonRemoval.body.error, "invalid_grant");
  } finally {
    await server.close();
  }
});

test("8. registered native loopback redirects match any port but not another host or path", async () => {
  const cases = [
    {
      clientId: "https://loopback-ip.example/oauth-client.json",
      registered: "http://127.0.0.1:41000/callback",
      requested: "http://127.0.0.1:49152/callback",
      unregistered: "http://localhost:49152/callback",
    },
    {
      clientId: "https://loopback-localhost.example/oauth-client.json",
      registered: "http://localhost:41000/callback",
      requested: "http://localhost:49153/callback",
      unregistered: "http://localhost:49153/other",
    },
  ];

  for (const entry of cases) {
    sharedDocuments.set(entry.clientId, clientMetadata(entry.clientId, {
      applicationType: "native",
      redirectUris: [entry.registered],
    }));
    const accepted = await sharedServer.request(authorizationUrl({
      clientId: entry.clientId,
      redirectUri: entry.requested,
    }));
    assert.equal(accepted.status, 303);
    assert.match(accepted.headers.get("location"), /^\/interaction\//u);

    const refused = await sharedServer.request(authorizationUrl({
      clientId: entry.clientId,
      redirectUri: entry.unregistered,
    }));
    await assertAuthorizationError(refused, "invalid_redirect_uri");
  }
});

test("9. native loopback behavior is separately gated and disabled by default", async () => {
  const clientId = "https://loopback-disabled.example/oauth-client.json";
  const documents = new Map([[clientId, clientMetadata(clientId, {
    applicationType: "native",
    redirectUris: ["http://127.0.0.1:41000/callback"],
  })]]);
  const server = await startProvider(metadataFetchFromMap(documents));
  try {
    const webClientId = "https://web-enabled.example/oauth-client.json";
    documents.set(webClientId, clientMetadata(webClientId));
    const web = await server.request(authorizationUrl({ clientId: webClientId }));
    assert.equal(web.status, 303);
    const response = await server.request(authorizationUrl({
      clientId,
      redirectUri: "http://127.0.0.1:49152/callback",
    }));
    await assertAuthorizationError(response, "invalid_client");
  } finally {
    await server.close();
  }
});

test("10. signing-key overlap publishes both kids and signs with the active first key", async () => {
  const keys = [];
  for (const kid of ["next-kid", "previous-kid"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...await exportJWK(privateKey), alg: "ES256", kid, use: "sig" });
  }
  const clientId = "https://key-overlap.example/oauth-client.json";
  const documents = new Map([[clientId, clientMetadata(clientId)]]);
  const server = await startProvider(metadataFetchFromMap(documents), { jwks: { keys } });
  try {
    const published = await (await server.request(`${ISSUER}/jwks`)).json();
    assert.deepEqual(published.keys.map(({ kid }) => kid).sort(), ["next-kid", "previous-kid"]);
    assert.ok(published.keys.every((key) => key.d === undefined));
    const { tokens } = await authorizeAndExchange(server, { clientId });
    assert.equal(decodeProtectedHeader(tokens.access_token).kid, "next-kid");
  } finally {
    await server.close();
  }
});
