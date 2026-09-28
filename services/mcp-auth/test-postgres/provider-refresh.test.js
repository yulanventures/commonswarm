import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { decodeJwt } from "jose";
import { Pool } from "pg";

import { createPostgresAdapter } from "../src/postgres-adapter.js";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";

const databaseUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const redirectUri = "https://connector.example/oauth/callback";
const verifier = "commonswarm-postgres-refresh-verifier-0123456789abcdef";
const challenge = createHash("sha256").update(verifier).digest("base64url");

after(async () => pool.end());

function metadata(clientId) {
  return {
    application_type: "web",
    client_id: clientId,
    client_name: "PostgreSQL refresh acceptance client",
    grant_types: ["authorization_code", "refresh_token"],
    id_token_signed_response_alg: "ES256",
    redirect_uris: [redirectUri],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

async function startProvider(clientId, beforeConsume) {
  const provider = await createMcpProvider({
    adapter: createPostgresAdapter(pool, { beforeConsume }),
    fetch: async (url) => String(url) === clientId
      ? Response.json(metadata(clientId))
      : new Response("not found", { status: 404 }),
  });
  const callback = provider.callback();
  const server = createServer((request, response) => {
    const operation = new URL(request.url, ISSUER).pathname.startsWith("/interaction/")
      ? (async () => {
          const details = await provider.interactionDetails(request, response);
          if (details.prompt.name === "login") {
            await provider.interactionFinished(request, response, { login: { accountId: "postgres-user" } });
            return;
          }
          let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
          grant ??= new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });
          if (details.prompt.details.missingOIDCScope) {
            grant.addOIDCScope(details.prompt.details.missingOIDCScope.join(" "));
          }
          for (const [resource, scopes] of Object.entries(
            details.prompt.details.missingResourceScopes ?? {},
          )) grant.addResourceScope(resource, scopes.join(" "));
          await provider.interactionFinished(request, response, { consent: { grantId: await grant.save() } });
        })()
      : callback(request, response);
    Promise.resolve(operation).catch((error) => {
      response.statusCode = 500;
      response.end(error.stack ?? String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  return {
    async request(target, options = {}) {
      const external = new URL(target, ISSUER);
      const headers = new Headers(options.headers);
      headers.set("host", new URL(ISSUER).host);
      headers.set("x-forwarded-host", new URL(ISSUER).host);
      headers.set("x-forwarded-proto", "https");
      if (cookies.size) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await fetch(new URL(`${external.pathname}${external.search}`, origin), {
        ...options, headers, redirect: "manual",
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";", 1);
        const separator = pair.indexOf("=");
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function tokenRequest(server, parameters) {
  const response = await server.request(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP refresh race uses two PostgreSQL connections, preserves winner, and replay tombstones family", async () => {
  const clientId = `https://postgres-${Date.now()}.example/oauth-client.json`;
  const waiting = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const server = await startProvider(clientId, async ({ model, processId }) => {
    if (model !== "RefreshToken") return;
    waiting.push(processId);
    if (waiting.length === 2) release();
    await barrier;
  });
  let grantId;
  try {
    const authorize = new URL("/authorize", ISSUER);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access mcp",
      prompt: "consent",
      state: "postgres-state",
      resource: RESOURCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) authorize.searchParams.set(key, value);
    let current = authorize;
    let callbackUrl;
    for (let step = 0; step < 10; step += 1) {
      const response = await server.request(current);
      assert.ok([302, 303].includes(response.status));
      const location = new URL(response.headers.get("location"), ISSUER);
      if (location.origin !== ISSUER) { callbackUrl = location; break; }
      current = location;
    }
    assert.ok(callbackUrl);
    const initial = await tokenRequest(server, {
      client_id: clientId,
      code: callbackUrl.searchParams.get("code"),
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      resource: RESOURCE,
    });
    assert.equal(initial.status, 200);
    assert.equal(typeof initial.body.refresh_token, "string",
      "the authorization flow must issue a refresh token before racing it");
    grantId = decodeJwt(initial.body.access_token).grant_id;
    const persistedRefresh = await pool.query(
      `SELECT 1
         FROM commonswarm_oauth.provider_artifacts
        WHERE model = 'RefreshToken' AND artifact_id_hash = $1`,
      [createHash("sha256").update(initial.body.refresh_token).digest("base64url")],
    );
    assert.equal(persistedRefresh.rowCount, 1,
      "the provider must persist its refresh token through the PostgreSQL adapter");

    const refreshParameters = {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: initial.body.refresh_token,
      resource: RESOURCE,
    };
    const raced = await Promise.all([
      tokenRequest(server, refreshParameters),
      tokenRequest(server, refreshParameters),
    ]);
    assert.equal(new Set(waiting).size, 2, "the race must reach two PostgreSQL backend connections");
    assert.deepEqual(raced.map(({ status }) => status).sort(), [200, 400]);
    assert.equal(raced.find(({ status }) => status === 400).body.error, "invalid_grant");
    const winner = raced.find(({ status }) => status === 200).body;

    const rotated = await tokenRequest(server, {
      ...refreshParameters,
      refresh_token: winner.refresh_token,
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));

    const replay = await tokenRequest(server, refreshParameters);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    const afterReplay = await tokenRequest(server, {
      ...refreshParameters,
      refresh_token: rotated.body.refresh_token,
    });
    assert.equal(afterReplay.status, 400);
    assert.equal(afterReplay.body.error, "invalid_grant");
  } finally {
    await server.close();
    if (grantId) {
      await pool.query("DELETE FROM commonswarm_oauth.provider_artifacts WHERE grant_id = $1", [grantId]);
      await pool.query("DELETE FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1", [grantId]);
    }
    await pool.query("DELETE FROM commonswarm_oauth.provider_artifacts WHERE payload->>'clientId' = $1", [clientId]);
  }
});
