import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { decodeJwt } from "jose";
import { Pool } from "pg";

import { createAdminHttpHandler } from "../src/admin-http.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
import { createLogger } from "../src/logger.js";
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

async function startProvider(clientId, beforeConsume, database = pool, { permanent = false, refreshTokenTtlSeconds } = {}) {
  const owner = randomUUID(), workspace = randomUUID(), hosted = randomUUID(), stream = randomUUID();
  await database.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)",
    [owner, `${owner}@example.test`]);
  await database.query("INSERT INTO swarm.users(user_id,display_name) VALUES($1,'MCP HTTP owner')", [owner]);
  await database.query("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'MCP HTTP control',$2)",
    [workspace, owner]);
  await database.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspace, owner]);
  await database.query("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')",
    [stream, workspace]);
  const adapter = createPostgresAdapter(database, { beforeConsume });
  const provider = await createMcpProvider({
    adapter,
    ...(refreshTokenTtlSeconds ? { refreshTokenTtlSeconds } : {}),
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
          await database.query(`INSERT INTO swarm.hosted_mcp_grant_workspaces
            (grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
            VALUES($1,$2,$3,decode(repeat('ab',32),'hex'),$4,statement_timestamp())
            ON CONFLICT(grant_id,workspace_id) DO NOTHING`,
          [hosted, workspace, owner, randomUUID()]);
          if (permanent) {
            await adapter('Grant').promoteHostedGrant?.(grantId,{ hostedGrantId: hosted,accountId: owner,clientId });
            grant = await provider.Grant.find(grantId);
            assert.ok(grant,'active provider Grant reload before continuation');
          }
          await provider.interactionFinished(request, response, { consent: { grantId } });
        })()
      : callback(request, response);
    Promise.resolve(operation).catch((error) => {
      response.statusCode = 500;
      response.end(error.stack ?? String(error));
    });
  };
  const logs = [];
  const logger = createLogger(line => logs.push(JSON.parse(line)));
  const server = createServer(createAdminHttpHandler({ handler, runtimePool: database, issuerPool: null, logger }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  return {
    logs, hosted, provider,
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
      // Permanent test bindings are append-only and retain their canonical
      // rows until the migrated disposable database is destroyed.
      if (permanent) return;
      await database.query("DELETE FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=$1", [hosted]);
      await database.query("DELETE FROM swarm.hosted_mcp_grants WHERE grant_id=$1", [hosted]);
      await database.query("DELETE FROM swarm.streams WHERE stream_id=$1", [stream]);
      await database.query("DELETE FROM swarm.memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, owner]);
      await database.query("DELETE FROM swarm.workspaces WHERE workspace_id=$1", [workspace]);
      await database.query("DELETE FROM swarm.org_memberships WHERE principal_id=$1", [owner]);
      await database.query("DELETE FROM swarm.organizations WHERE created_by=$1", [owner]);
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
  },pool,{ permanent: true });
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
          assert.equal(escalation.body.error, "temporarily_unavailable");
          assert.equal(server.logs.at(-1).event, "admin.ingress_error");
          assert.equal(server.logs.at(-1).error_code, "admin_issuance_disabled");
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

test('HTTP hosted refresh rotates unbounded families twice and preserves owner dates across technical expiry, early extension/clear and elapsed policy', { timeout: 45000 }, async () => {
  const clientId = `https://s2-deadline-${randomUUID()}.example/oauth.json`;
  const server = await startProvider(clientId,undefined,pool,{ permanent: true,refreshTokenTtlSeconds: 2 });
  try {
    const code = await authorizeCode(server,clientId);
    const initial = await tokenRequest(server,{ client_id: clientId,code,code_verifier: verifier,
      grant_type: 'authorization_code',redirect_uri: redirectUri,resource: RESOURCE });
    assert.equal(initial.status,200);
    const family = decodeJwt(initial.body.access_token).grant_id;
    let token = initial.body.refresh_token; assert.equal(typeof token,'string');
    const savedGrant = (await pool.query("SELECT payload,expires_at FROM commonswarm_oauth.provider_artifacts WHERE model='Grant' AND payload->>'jti'=$1",[family])).rows[0];
    assert.equal(savedGrant.expires_at,null,'initial active Grant was promoted before successful issuance');
    assert.equal(Object.hasOwn(savedGrant.payload,'exp'),false);
    const rotate = async () => {
      const response = await tokenRequest(server,{ client_id: clientId,grant_type: 'refresh_token',refresh_token: token,resource: RESOURCE });
      if (response.status === 200) { assert.notEqual(response.body.refresh_token,token); token=response.body.refresh_token; }
      return response;
    };
    const assertStoredDeadline = async deadline => {
      const rows = (await pool.query(`SELECT model,payload,expires_at
        FROM commonswarm_oauth.provider_artifacts
        WHERE (model='Grant' AND payload->>'jti'=$1)
           OR (model='RefreshToken' AND artifact_id_hash=$2)`,
      [family,createHash('sha256').update(token).digest('base64url')])).rows;
      assert.deepEqual(rows.map(row => row.model).sort(),['Grant','RefreshToken']);
      for (const row of rows) {
        assert.equal(row.expires_at?.getTime() ?? null,deadline?.getTime() ?? null,row.model);
        assert.equal(Object.hasOwn(row.payload,'exp'),deadline !== null,row.model);
        if (deadline !== null) assert.equal(row.payload.exp,Math.ceil(deadline.getTime()/1000),row.model);
      }
    };
    await assertStoredDeadline(null);
    for (let rotation=0; rotation<2; rotation+=1) {
      const result = await rotate();
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(Object.hasOwn(result.body,'refresh_expires_in'),false);
      await assertStoredDeadline(null);
    }
    const future = (await pool.query("SELECT clock_timestamp()+interval '180 days' AS deadline")).rows[0].deadline;
    await pool.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[server.hosted,future]);
    await pool.query('SELECT pg_sleep(2.1)');
    assert.equal((await rotate()).status,200,'future owner policy survives a shorter configured Grant/RT TTL');
    let row = (await pool.query("SELECT payload,expires_at FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1",
      [createHash('sha256').update(token).digest('base64url')])).rows[0];
    assert.equal(row.expires_at.getTime(),future.getTime());
    assert.equal(row.payload.exp,Math.ceil(future.getTime()/1000));
    await assertStoredDeadline(future);
    assert.equal((await rotate()).status,200,'finite rotation must preserve the chosen future bound');
    await assertStoredDeadline(future);
    for (const nextPolicy of [new Date(future.getTime()+86400000),null]) {
      await pool.query("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds' WHERE grant_id=$1",[server.hosted]);
      assert.equal((await rotate()).status,200,'persist a short owner deadline before the owner edits it');
      await pool.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[server.hosted,nextPolicy]);
      await pool.query('SELECT pg_sleep(3.1)');
      const result = await rotate(); assert.equal(result.status,200,'pre-expiry owner edit is honored after the old stored deadline');
      assert.equal(result.body.expires_in,300); assert.equal(Object.hasOwn(result.body,'refresh_expires_in'),false);
      row = (await pool.query("SELECT payload,expires_at FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1",
        [createHash('sha256').update(token).digest('base64url')])).rows[0];
      assert.equal(row.expires_at?.getTime() ?? null,nextPolicy?.getTime() ?? null);
      assert.equal(Object.hasOwn(row.payload,'exp'),nextPolicy !== null);
    }
    // Persist a chosen future bound, then model its elapsed canonical state
    // without a wall-clock race or an additional sleep.
    await pool.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[server.hosted,future]);
    assert.equal((await rotate()).status,200);
    await assertStoredDeadline(future);
    await pool.query("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1",[server.hosted]);
    const refused = await rotate(); assert.equal(refused.status,400); assert.equal(refused.body.error,'invalid_grant');
    const stillRefused = await rotate(); assert.equal(stillRefused.status,400); assert.equal(stillRefused.body.error,'invalid_grant');
  } finally { await server.close(); await server.cleanup(); }
});

for (const edit of ['extend', 'clear']) {
  test(`HTTP owner ${edit} before deadline survives crossing inside refresh consume/save`, { timeout: 20000 }, async () => {
    const clientId = `https://s2-crossing-${randomUUID()}.example/oauth.json`;
    let armed = false, barrierEntered = false, oldExp, nextPolicy;
    const server = await startProvider(clientId, async ({ model }) => {
      if (model !== 'RefreshToken' || !armed) return;
      armed = false;
      barrierEntered = true;
      const edited = await pool.query(`UPDATE swarm.hosted_mcp_grants
        SET connection_expires_at=$2 WHERE grant_id=$1 AND connection_expires_at>clock_timestamp()
        RETURNING clock_timestamp() AS edited_at`, [server.hosted,nextPolicy]);
      assert.equal(edited.rowCount,1,'owner edit commits while old chosen date is still future');
      assert.ok(edited.rows[0].edited_at.getTime()<oldExp*1000);
      // Release only after BOTH clocks cross the predecessor's actual payload
      // exp. Poll a bounded predicate rather than guessing a sleep duration.
      const stop = performance.now()+8000;
      while (true) {
        const crossed = (await pool.query('SELECT extract(epoch FROM clock_timestamp()) >= $1 AS crossed',[oldExp])).rows[0].crossed;
        if (crossed && Math.floor(Date.now()/1000)>=oldExp) break;
        assert.ok(performance.now()<stop,'DB and Node must cross stored exp within the clock barrier');
        await new Promise(resolve => setTimeout(resolve,20));
      }
    },pool,{ permanent: true });
    try {
      const code = await authorizeCode(server,clientId);
      const initial = await tokenRequest(server,{ client_id: clientId,code,code_verifier: verifier,
        grant_type: 'authorization_code',redirect_uri: redirectUri,resource: RESOURCE });
      assert.equal(initial.status,200);
      const family = decodeJwt(initial.body.access_token).grant_id;
      const rotate = token => tokenRequest(server,{ client_id: clientId,grant_type: 'refresh_token',refresh_token: token,resource: RESOURCE });
      const chosen = (await pool.query("SELECT date_trunc('second',clock_timestamp())+interval '4 seconds' AS deadline")).rows[0].deadline;
      nextPolicy = edit === 'clear' ? null : new Date(chosen.getTime()+86400000);
      await pool.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[server.hosted,chosen]);
      const finite = await rotate(initial.body.refresh_token);
      assert.equal(finite.status,200);
      const predecessor = finite.body.refresh_token;
      const hash = token => createHash('sha256').update(token).digest('base64url');
      const stored = (await pool.query("SELECT payload,expires_at FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1",[hash(predecessor)])).rows[0];
      oldExp = stored.payload.exp;
      assert.equal(oldExp,chosen.getTime()/1000);
      assert.equal(stored.expires_at.getTime(),chosen.getTime());
      armed = true;
      const rotated = await rotate(predecessor);
      assert.equal(barrierEntered,true,'refresh reached the beforeConsume race boundary');
      assert.equal(rotated.status,200,JSON.stringify(rotated.body));
      assert.notEqual(rotated.body.refresh_token,predecessor);
      const assertPersisted = async token => {
        const rows = (await pool.query(`SELECT model,payload,expires_at,consumed_at FROM commonswarm_oauth.provider_artifacts
          WHERE (model='Grant' AND payload->>'jti'=$1) OR (model='RefreshToken' AND artifact_id_hash=$2)`,[family,hash(token)])).rows;
        assert.deepEqual(rows.map(row => row.model).sort(),['Grant','RefreshToken']);
        for (const row of rows) {
          assert.equal(row.expires_at?.getTime() ?? null,nextPolicy?.getTime() ?? null,row.model);
          assert.equal(Object.hasOwn(row.payload,'exp'),nextPolicy !== null,row.model);
          if (nextPolicy) assert.equal(row.payload.exp,nextPolicy.getTime()/1000,row.model);
          assert.equal(row.consumed_at,null,row.model);
        }
      };
      await assertPersisted(rotated.body.refresh_token);
      const again = await rotate(rotated.body.refresh_token);
      assert.equal(again.status,200,JSON.stringify(again.body));
      assert.notEqual(again.body.refresh_token,rotated.body.refresh_token);
      await assertPersisted(again.body.refresh_token);
      const replay = await rotate(predecessor);
      assert.equal(replay.status,400); assert.equal(replay.body.error,'invalid_grant');
      assert.equal((await pool.query('SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=$1',[family])).rowCount,1);
      const revoked = await rotate(again.body.refresh_token);
      assert.equal(revoked.status,400); assert.equal(revoked.body.error,'invalid_grant');
    } finally { await server.close(); await server.cleanup(); }
  });
}

test('HTTP finite nonhosted refresh crossing its deadline at consumed event saves no successor', async t => {
  const clientId = `https://s2-finite-crossing-${randomUUID()}.example/oauth.json`;
  const server = await startProvider(clientId,undefined,pool,{ refreshTokenTtlSeconds: 60 });
  let clockMocked = false, consumed = false;
  const crossDeadline = predecessor => {
    consumed = true;
    assert.ok(Number.isSafeInteger(predecessor.exp));
    t.mock.timers.enable({ apis: ['Date'],now: (predecessor.exp+1)*1000 });
    clockMocked = true;
  };
  try {
    const code = await authorizeCode(server,clientId);
    const initial = await tokenRequest(server,{ client_id: clientId,code,code_verifier: verifier,
      grant_type: 'authorization_code',redirect_uri: redirectUri,resource: RESOURCE });
    assert.equal(initial.status,200);
    const family = decodeJwt(initial.body.access_token).grant_id;
    assert.equal((await pool.query('SELECT 1 FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=$1',[family])).rowCount,0);
    server.provider.once('refresh_token.consumed',crossDeadline);
    let result;
    try {
      result = await tokenRequest(server,{ client_id: clientId,grant_type: 'refresh_token',refresh_token: initial.body.refresh_token,resource: RESOURCE });
    } finally {
      if (clockMocked) { t.mock.timers.reset(); clockMocked = false; }
    }
    assert.equal(consumed,true,'provider validated and consumed before crossing the finite deadline');
    assert.equal(result.status,400); assert.equal(result.body.error,'invalid_grant');
    const rows = (await pool.query("SELECT artifact_id_hash,consumed_at FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND grant_id=$1",[family])).rows;
    assert.equal(rows.length,1,'no successor was saved');
    assert.equal(rows[0].artifact_id_hash,createHash('sha256').update(initial.body.refresh_token).digest('base64url'));
    assert.ok(rows[0].consumed_at,'original consumption evidence remains');
  } finally {
    if (clockMocked) t.mock.timers.reset();
    server.provider.removeListener('refresh_token.consumed',crossDeadline);
    await server.close(); await server.cleanup();
  }
});
