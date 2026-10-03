import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { decodeJwt } from "jose";
import { Pool } from "pg";

import { createAdminHttpHandler } from "../src/admin-http.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
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

async function startProvider(clientId, beforeConsume, database = pool) {
  const owner = randomUUID(), workspace = randomUUID(), hosted = randomUUID();
  await database.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)",
    [owner, `${owner}@example.test`]);
  await database.query("INSERT INTO swarm.users(user_id,display_name) VALUES($1,'MCP HTTP owner')", [owner]);
  await database.query("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'MCP HTTP control',$2)",
    [workspace, owner]);
  const provider = await createMcpProvider({
    adapter: createPostgresAdapter(database, { beforeConsume }),
    // These are the ordinary production hooks, available before M1.
    providerGrantResource: async id => (await database.query(
      "SELECT resource FROM commonswarm_oauth.resolve_hosted_grant_status($1)", [id])).rows[0]?.resource,
    providerGrantActive: async id => (await database.query(
      "SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status($1)", [id])).rows[0]?.active === true,
    fetch: async (url) => String(url) === clientId
      ? Response.json(metadata(clientId))
      : new Response("not found", { status: 404 }),
  });
  const callback = provider.callback();
  const handler = (request, response) => {
    const operation = new URL(request.url, ISSUER).pathname.startsWith("/interaction/")
      ? (async () => {
          const details = await provider.interactionDetails(request, response);
          if (details.prompt.name === "login") {
            await provider.interactionFinished(request, response, { login: { accountId: owner } });
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
          const grantId = await grant.save();
          // Production consent activates the hosted grant before continuation
          // and token claims. A bare provider Grant is not a hosted consent.
          await database.query(`INSERT INTO swarm.hosted_mcp_grants
            (grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
             selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
            VALUES($1,$2,$3,$4,$5,$6,ARRAY[$4]::uuid[],decode(repeat('ab',32),'hex'),$7,
              'active',statement_timestamp(),statement_timestamp())
            ON CONFLICT(provider_grant_id) DO NOTHING`,
          [hosted, grantId, owner, workspace, clientId, RESOURCE, details.uid]);
          await provider.interactionFinished(request, response, { consent: { grantId } });
        })()
      : callback(request, response);
    Promise.resolve(operation).catch((error) => {
      response.statusCode = 500;
      response.end(error.stack ?? String(error));
    });
  };
  const server = createServer(createAdminHttpHandler({ handler, runtimePool: database, issuerPool: null }));
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
    async cleanup() {
      await database.query("DELETE FROM swarm.hosted_mcp_grants WHERE grant_id=$1", [hosted]);
      await database.query("DELETE FROM swarm.workspaces WHERE workspace_id=$1", [workspace]);
      await database.query("DELETE FROM swarm.users WHERE user_id=$1", [owner]);
      await database.query("DELETE FROM auth.users WHERE id=$1", [owner]);
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

async function authorizeCode(server, clientId) {
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
  return callbackUrl.searchParams.get("code");
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
    const code = await authorizeCode(server, clientId);
    const initial = await tokenRequest(server, {
      client_id: clientId,
      code,
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
      // The M3 replay fence is append-only; retain its nonsecret tombstone.
    }
    await pool.query("DELETE FROM commonswarm_oauth.provider_artifacts WHERE payload->>'clientId' = $1", [clientId]);
    await server.cleanup();
  }
});

// The shared fixture copies the actual application DDL into empty schemas;
// reviewed inverse scripts establish the pre-M1 migration set. All DDL/data is
// rolled back, so no durable CI artifacts or other suites are modified.
test("ordinary MCP + admin-http: code exchange, refresh and replay before and after M1-M4", async t => {
  assert.equal(process.env.CI, "true", "migration composition is CI-only (Docker)");
  const { emptyApplicationSchema, repoSql, schemaVersions, schemaMigrationNames } =
    await import("../../../tests/support/admin-schema-db.ts");
  const target = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  target.username = "supabase_admin";
  const admin = new Pool({ connectionString: target.href, max: 1 });
  const physical = await admin.connect();
  let tail = Promise.resolve(), serial = 0;
  // Adapter transactions use real savepoints under the fixture's outer rollback.
  const database = {
    query: (...args) => physical.query(...args),
    async connect() {
      const prior = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await prior;
      const name = `mcp_composition_${++serial}`;
      return {
        async query(sql, values) {
          if (sql === "BEGIN") return physical.query(`SAVEPOINT ${name}`);
          if (sql === "COMMIT") return physical.query(`RELEASE SAVEPOINT ${name}`);
          if (sql === "ROLLBACK") return physical.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return physical.query(sql, values);
        },
        release() { unlock(); },
      };
    },
  };
  try {
    await physical.query("BEGIN");
    await physical.query(emptyApplicationSchema());
    for (const version of [...schemaVersions].reverse()) {
      await physical.query(repoSql(`supabase/admin-delegation-reserve/${version}-rollback.sql`));
    }
    for (const migrated of [false, true]) {
      if (migrated) {
        for (const name of schemaMigrationNames) await physical.query(repoSql(`supabase/migrations/${name}`));
      }
      await t.test(migrated ? "M1-M4 present" : "pre-M1 migration set", async () => {
        const objects = await physical.query(`SELECT
          to_regclass('commonswarm_oauth.provider_grant_resources') AS resources,
          to_regclass('commonswarm_oauth.admin_grant_bindings') AS bindings,
          to_regclass('commonswarm_oauth.admin_verified_clients') AS verification,
          to_regclass('commonswarm_oauth.dpop_proof_replays') AS proof_replays,
          to_regclass('commonswarm_oauth.admin_oauth_audit') AS audit,
          to_regclass('commonswarm_oauth.admin_cutover_state') AS cutover,
          to_regclass('commonswarm_ops.migration_checksums') AS checksums`);
        for (const value of Object.values(objects.rows[0])) assert.equal(value !== null, migrated);
        const clientId = `https://composition-${randomUUID()}.example/oauth-client.json`;
        const server = await startProvider(clientId, undefined, database);
        try {
          const code = await authorizeCode(server, clientId);
          const initial = await tokenRequest(server, { client_id: clientId, code, code_verifier: verifier,
            grant_type: "authorization_code", redirect_uri: redirectUri, resource: RESOURCE });
          assert.equal(initial.status, 200);
          const grantId = decodeJwt(initial.body.access_token).grant_id;
          assert.equal(decodeJwt(initial.body.access_token).aud, RESOURCE);
          assert.equal(typeof initial.body.refresh_token, "string");
          // Simulate a live family with hosted consent predating the M1
          // backfill: ordinary operation must not require an M1 binding row.
          if (migrated) assert.equal((await physical.query(
            "SELECT 1 FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=$1", [grantId])).rowCount, 0);
          const parameters = { client_id: clientId, grant_type: "refresh_token",
            refresh_token: initial.body.refresh_token, resource: RESOURCE };
          // Pre-M1 provider snapshots may store the one MCP resource as an
          // array. Exercise actual adapter persistence and HTTP refresh of it.
          const refreshAdapter = createPostgresAdapter(database)("RefreshToken");
          const payload = await refreshAdapter.find(initial.body.refresh_token);
          await refreshAdapter.upsert(initial.body.refresh_token, { ...payload, resource: [RESOURCE] }, 3600);
          const escalation = await tokenRequest(server, { ...parameters, resource: ADMIN_RESOURCE });
          assert.equal(escalation.status, 503);
          assert.equal(escalation.body.error, "admin_issuance_disabled");
          const rotated = await tokenRequest(server, parameters);
          assert.equal(rotated.status, 200);
          assert.equal(decodeJwt(rotated.body.access_token).aud, RESOURCE);
          assert.notEqual(rotated.body.refresh_token, initial.body.refresh_token);
          assert.equal(decodeJwt(rotated.body.access_token).grant_id, grantId);
          const replay = await tokenRequest(server, parameters);
          assert.equal(replay.status, 400);
          assert.equal(replay.body.error, "invalid_grant");
          const fenced = await tokenRequest(server, { ...parameters, refresh_token: rotated.body.refresh_token });
          assert.equal(fenced.status, 400);
          assert.equal(fenced.body.error, "invalid_grant");
        } finally { await server.close(); }
      });
    }
  } finally {
    await physical.query("ROLLBACK");
    physical.release();
    await admin.end();
  }
});
