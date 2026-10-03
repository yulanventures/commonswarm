import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { errors } from "oidc-provider";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
import { createAdminHttpHandler } from "../src/admin-http.js";
import { createPostgresAdapter } from "../src/postgres-adapter.js";
import { createLogger } from "../src/logger.js";
import { calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AdminTokenLifecycle } from "../src/admin-lifecycle.js";
import { AdminConsentError, adminDigest, createAdminManifest } from "../src/admin-consent.js";
import { emptyAdminAccount } from "../src/admin-authority.generated.js";
import { AdminTransactionCoordinator, AdminTransactionError } from "../src/admin-transaction.js";
import { admitAdminProof, verifyAdminProof } from "../src/admin-dpop.js";

async function fixture(t, { issuerPool = null } = {}) {
  const clientId = "https://client.example/metadata", redirect = "https://client.example/callback";
  const provider = await createMcpProvider({ fetch: async () => new Response(JSON.stringify({ client_id: clientId,
    redirect_uris: [redirect], grant_types: ["authorization_code","refresh_token"], response_types:["code"],
    token_endpoint_auth_method:"none", application_type:"web" }),{ headers:{"content-type":"application/json"} }) });
  const handler=async (request,response)=>{
    if (request.url.startsWith("/interaction/")) {
      const details=await provider.interactionDetails(request,response);
      if (details.prompt.name === "login") await provider.interactionFinished(request,response,{login:{accountId:"test-owner"}});
      else {
        const grant=details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({accountId:"test-owner",clientId});
        grant.addOIDCScope((details.prompt.details.missingOIDCScope ?? []).join(" ")); grant.addResourceScope(RESOURCE,"mcp");
        if (details.prompt.details.missingOIDCClaims) grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
        await provider.interactionFinished(request,response,{consent:{grantId:await grant.save()}});
      }
    } else await provider.callback()(request,response);
  };
  let lookups = 0;
  const logs = [];
  const server=createServer(createAdminHttpHandler({ handler,runtimePool:{query:async()=>{ ++lookups; return {rows:[]}; }},issuerPool,
    logger: createLogger(line => logs.push(JSON.parse(line))) }));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`,cookies=new Map();
  async function request(path,body) {
    const headers={host:new URL(ISSUER).host,"x-forwarded-host":new URL(ISSUER).host,"x-forwarded-proto":"https"};
    if (body) headers["content-type"]="application/x-www-form-urlencoded";
    headers.cookie=[...cookies].map(([key,value])=>`${key}=${value}`).join("; ");
    const response=await fetch(new URL(path,origin),{method:body ? "POST":"GET",headers,
      body:body ? new URLSearchParams(body):undefined,redirect:"manual"});
    for(const item of response.headers.getSetCookie()) { const pair=item.split(";",1)[0],at=pair.indexOf("=");cookies.set(pair.slice(0,at),pair.slice(at+1)); }
    return response;
  }
  async function tokens() {
    const verifier="boundary-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const query=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:"code",
      scope:"openid offline_access mcp",prompt:"consent",resource:RESOURCE,code_challenge_method:"S256",
      code_challenge:createHash("sha256").update(verifier).digest("base64url"),state:randomUUID()});
    let response=await request(`/authorize?${query}`);
    for(let i=0;i<8 && [302,303].includes(response.status);i++) {
      const location=new URL(response.headers.get("location"),ISSUER);
      if(location.origin === new URL(redirect).origin) {
        response=await request("/token",{client_id:clientId,grant_type:"authorization_code",code:location.searchParams.get("code"),
          code_verifier:verifier,redirect_uri:redirect,resource:RESOURCE});
        assert.equal(response.status,200);return response.json();
      }
      response=await request(location.pathname+location.search);
    }
    throw new Error("ordinary MCP positive did not reach code exchange");
  }
  return { provider,request,tokens,clientId,logs, get lookups() { return lookups; } };
}

for (const { name, grantType, detail, replay } of [
  { name: "invalid authorization code", grantType: "authorization_code", detail: "authorization code not found" },
  { name: "invalid refresh token", grantType: "refresh_token", detail: "refresh token not found" },
  { name: "replayed refresh token", grantType: "refresh_token", detail: "refresh token already used", replay: true },
]) {
  test(`ordinary admin-http composition preserves invalid_grant and grant.error for ${name}`, async t => {
    const f = await fixture(t), failures = [];
    let successes = 0;
    f.provider.on("grant.error", (_ctx, error) => failures.push(error));
    f.provider.on("grant.success", () => ++successes);

    // Issue through the same wrapped HTTP server, not directly through models.
    const issued = await f.tokens();
    assert.equal(typeof issued.access_token, "string");
    assert.equal(typeof issued.refresh_token, "string");
    assert.equal(successes, 1);
    if (replay) {
      const refreshed = await f.request("/token", { client_id: f.clientId, grant_type: "refresh_token",
        refresh_token: issued.refresh_token, resource: RESOURCE });
      assert.equal(refreshed.status, 200);
      const rotated = await refreshed.json();
      assert.equal(typeof rotated.access_token, "string");
      assert.equal(typeof rotated.refresh_token, "string");
      assert.notEqual(rotated.refresh_token, issued.refresh_token);
      assert.equal(successes, 2);
    }

    const lookupsBefore = f.lookups, successesBefore = successes;
    const response = await f.request("/token", { client_id: f.clientId, grant_type: grantType,
      resource: RESOURCE, ...(grantType === "authorization_code"
        ? { code: "not-an-issued-code", code_verifier: "boundary-verifier-0123456789abcdefghijklmnopqrstuvwxyz",
          redirect_uri: "https://client.example/callback" }
        : { refresh_token: replay ? issued.refresh_token : "not-an-issued-refresh" }) });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.error_description, "grant request is invalid");
    assert.equal(failures.length, 1, "the provider must emit grant.error for the failed exchange");
    assert.ok(failures[0] instanceof errors.InvalidGrant);
    assert.equal(failures[0].statusCode, 400);
    assert.equal(failures[0].error_description, "grant request is invalid");
    assert.equal(failures[0].error_detail, detail);
    assert.equal(successes, successesBefore, "a failed exchange must not emit grant.success");
    assert.equal(f.lookups, lookupsBefore, "ordinary token failures must not query admin state");
  });
}

test("mcp-refresh-never-admin: real MCP refresh cannot change resource; the same predecessor still refreshes MCP",async t=>{
  const f=await fixture(t),tokens=await f.tokens();
  const escalated=await f.request("/token",{client_id:f.clientId,grant_type:"refresh_token",refresh_token:tokens.refresh_token,resource:ADMIN_RESOURCE});
  assert.equal(escalated.status,503);
  assert.equal((await escalated.json()).error,"admin_issuance_disabled");
  const good=await f.request("/token",{client_id:f.clientId,grant_type:"refresh_token",refresh_token:tokens.refresh_token,resource:RESOURCE});
  assert.equal(good.status,200); assert.equal(typeof (await good.json()).access_token,"string");
});

test("admin-scopes-resource-only: provider resource scopes are separate from OIDC; MCP and multiresource upserts refuse admin",async t=>{
  const f=await fixture(t),grant=new f.provider.Grant({accountId:"owner",clientId:f.clientId});
  grant.addOIDCScope("openid offline_access"); grant.addResourceScope(ADMIN_RESOURCE,"admin:read");
  assert.equal(grant.getOIDCScope(),"openid offline_access");
  assert.equal(grant.getResourceScope(ADMIN_RESOURCE),"admin:read");
  const denied=await f.request(`/authorize?${new URLSearchParams({client_id:f.clientId,resource:RESOURCE,
    scope:"admin:read",response_type:"code",redirect_uri:"https://client.example/callback"})}`);
  assert.equal(denied.status,400); assert.equal((await denied.json()).error,"invalid_scope");
  const adapter=createPostgresAdapter({query:async()=>({rows:[]}),connect:async()=>({query:async sql=>({rows:[],command:sql}),release(){}})})("Grant");
  await assert.rejects(adapter.upsert("bad",{resources:{[RESOURCE]:"mcp",[ADMIN_RESOURCE]:"admin:read"}},60),{error:"invalid_target"});
  await assert.rejects(adapter.upsert("admin",{resources:{[ADMIN_RESOURCE]:"admin:read"}},60),{code:"admin_transaction_required"});
  await adapter.upsert("mcp",{resources:{[RESOURCE]:"mcp"}},60);
  await adapter.upsert("native-mcp",{resource:[RESOURCE]},60);
  await assert.rejects(adapter.upsert("multi-resource",{resource:[RESOURCE,ADMIN_RESOURCE]},60),{error:"invalid_target"});
  let mutations=0;
  const boundAdapter=createPostgresAdapter({query:async()=>({rows:[{payload:{resource:ADMIN_RESOURCE,grantId:"bound-admin-family"}}]}),
    connect:async()=>{++mutations;throw new Error("unexpected mutation connection");}})("RefreshToken");
  await assert.rejects(boundAdapter.upsert("new-unlabelled-admin-refresh",{grantId:"bound-admin-family"},60),
    {code:"admin_transaction_required"});
  assert.equal(mutations,0,"a new artifact cannot bypass ALS by omitting its resource field");

});

test("admin-issuance-closed-before-cutover: admin authorization/code/refresh refuse and ordinary OAuth still succeeds",async t=>{
  let connections = 0;
  const f=await fixture(t, { issuerPool: { connect: async () => { ++connections; throw new Error("unexpected issuer SQL"); } } });
  const auth=await f.request(`/authorize?${new URLSearchParams({client_id:f.clientId,resource:ADMIN_RESOURCE,
    scope:"openid offline_access admin:read",response_type:"code",redirect_uri:"https://client.example/callback"})}`);
  assert.equal(auth.status,503);
  assert.equal((await auth.json()).error,"admin_issuance_disabled");
  assert.equal(f.logs.at(-1).event, "admin.ingress_error");
  assert.equal(f.logs.at(-1).error_code, "admin_issuance_disabled");
  const lookupsBefore = f.lookups;
  for(const grant_type of ["authorization_code","refresh_token"]) {
    const response=await f.request("/token",{client_id:f.clientId,resource:ADMIN_RESOURCE,grant_type,
      code:"not-an-issued-admin-code",refresh_token:"not-an-issued-admin-refresh"});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,"admin_issuance_disabled");
  }
  assert.equal(f.lookups,lookupsBefore,"closed admin token ingress must refuse before any SQL");
  assert.equal(connections,0,"a configured issuer pool must not bypass default-OFF activation");
  assert.equal(typeof (await f.tokens()).refresh_token,"string");
});

test("ordinary /token delegates the original unread HTTP stream without an admin lookup", async t => {
  const body = "grant_type=refresh_token&resource=https%3A%2F%2Fmcp.commonswarm.com%2Fmcp&refresh_token=transport-control";
  let delegated = false, lookups = 0, originalStream, unread, received = "";
  const server = createServer((original, response) => createAdminHttpHandler({
    runtimePool: { query: async () => { ++lookups; return { rows: [] }; } }, issuerPool: null,
    handler: async request => {
      originalStream = request === original;
      unread = request.readable;
      for await (const chunk of request) received += chunk.toString();
      delegated = true;
      response.writeHead(200);
      response.end("delegated");
    },
  })(original, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${server.address().port}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "delegated");
  assert.equal(originalStream, true, "the provider must receive the IncomingMessage, not a replay stream");
  assert.equal(unread, true, "ingress must leave body parsing to the provider");
  assert.equal(received, body);
  assert.equal(delegated, true);
  assert.equal(lookups, 0, "ordinary token ingress must not query admin state");
});

// SQL fixtures supply committed read rows; the real bridge/reducer, lifecycle,
// provider exchange, signing and ledger validation execute without a service.
async function adminExchange(t, seconds, { badExpiry = false, refusal, missingResourceServer = false } = {}) {
  const now = Math.floor(Date.now() / 1000) * 1000, owner = randomUUID(), grantId = randomUUID();
  const clientId = "https://client.example/metadata", redirectUri = "https://client.example/callback";
  const key = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(key.publicKey), jkt = await calculateJwkThumbprint(jwk);
  const signing = await generateKeyPair("ES256", { extractable: true });
  const signingJwk = { ...await exportJWK(signing.privateKey), alg: "ES256", use: "sig", kid: "boundary-test" };
  const metadata = { client_id: clientId, application_type: "web", redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: "none", id_token_signed_response_alg: "ES256",
    dpop_bound_access_tokens: true, dpop_signing_alg: "ES256" };
  const manifest = createAdminManifest({ mode: "granular", scope_names: ["admin:read"], workspace_ids: [],
    expires_at: new Date(now + seconds * 1000).toISOString() },
  { verification: { client_id: clientId }, resourceScopes: ["admin:read"] }, now);
  const grant = { ...manifest, grant_id: grantId, owner_user_id: owner, consent_receipt_id: randomUUID(),
    manifest_digest: adminDigest(manifest), created_at: now, state: "active", suspended_at: null,
    revoked_at: null, reason_code: null, withdrawn_workspace_ids: [], replaces_grant_id: null };
  const account = { owner_user_id: owner, stream_id: randomUUID(), seq: 0,
    projection: { ...emptyAdminAccount(), grants: { [grantId]: grant } } };
  const verification = { active: true, owner_approved: true, application_type: "web", dpop_tested: true,
    pkce_s256_tested: true, origin_control_verified: true, redirect_tested: true,
    registration_source: "static", metadata_digest: adminDigest(metadata) };
  const sha = "a".repeat(40), target = `/home/commonswarm/edge/releases/${sha}`;
  const measurement = { admin_issuance_enabled: true, legacy_closed: true, auth_contract_version: 2,
    lane8_evidence_digest: "b".repeat(64), measurement_evidence_ref: "service-free test", measured_at: new Date(),
    approved_edge_release_sha: sha, measured_edge_release_sha: sha, measured_edge_target: target,
    measured_mount: target, measured_generation: "1", release_generation: "1",
    measured_artifact_digest: "c".repeat(64), measured_image_digest: `sha256:${"d".repeat(64)}` };
  let binding, artifact;
  const queries = [], events = [], ledger = [], failures = [], serverErrors = [];
  const pool = { connect: async () => ({ async query(sql, values) {
    queries.push(sql);
    if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
    if (sql.includes("admit_dpop_proof")) return { rows: [{ status: "accepted" }] };
    if (sql.includes("admin_cutover_state")) return { rows: [measurement] };
    if (sql.includes("migration_checksum_failures")) return { rows: [], rowCount: 0 };
    if (sql.includes("issuer_key_allowed")) return { rows: [{ allowed: true }] };
    if (sql.includes("lock_admin_consent_policy") || sql.includes("FROM commonswarm_oauth.admin_verified_clients")) return { rows: [verification] };
    if (sql.includes("FROM commonswarm_oauth.registered_clients")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT * FROM swarm.admin_accounts")) return { rows: [structuredClone(account)] };
    if (sql.includes("FROM swarm.admin_grants")) return { rows: [{ ...grant,
      expires_at: new Date(grant.expires_at), refresh_deadline: new Date(grant.refresh_deadline) }] };
    if (sql.includes("FROM commonswarm_oauth.admin_grant_bindings")) return { rows: [binding] };
    if (sql.includes("FROM commonswarm_oauth.provider_artifacts")) return { rows: [artifact] };
    if (sql.includes("resolve_admin_grant_status")) return { rows: [{ active: true }] };
    if (sql.includes(" AS now")) return { rows: [{ now: sql.includes("*1000") ? now : now / 1000 }] };
    if (sql.includes("admin_rate_buckets")) return { rows: [{ attempts: 1 }] };
    if (sql.includes("INSERT INTO swarm.admin_events")) events.push(JSON.parse(values[4]));
    if (sql.includes("UPDATE commonswarm_oauth.admin_grant_bindings")) {
      binding = { ...binding, generation: values[1], scope_names: values[2] }; return { rows: [binding] };
    }
    if (sql.includes("INSERT INTO commonswarm_oauth.admin_access_issuances")) ledger.push(values);
    return { rows: [], rowCount: 0, command: sql.split(" ")[0] };
  }, release() {} }) };
  let refusalReached = false;
  const provider = await createMcpProvider({ jwks: { keys: [signingJwk] }, activeSigningKid: signingJwk.kid,
    registrationEnabled: false, registrationStore: { find: async () => metadata, markUsed: async () => {
      if (refusal) { refusalReached = true; throw refusal; }
    } } });
  if (missingResourceServer) {
    const expiresIn = provider.AccessToken.expiresIn;
    provider.AccessToken.expiresIn = function (ctx, token, ...args) {
      refusalReached = true;
      Object.defineProperty(token, "resourceServer", { value: undefined, configurable: true });
      return expiresIn.call(this, ctx, token, ...args);
    };
  }
  provider.on("grant.error", (_ctx, error) => failures.push(error));
  provider.on("server_error", (_ctx, error) => serverErrors.push(error));
  if (badExpiry) {
    // Corrupt the signed result at the pinned provider's actual signing hook.
    const { createRequire } = await import("node:module");
    const { dirname, resolve } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const require = createRequire(import.meta.url);
    const { default: instance } = await import(pathToFileURL(resolve(dirname(require.resolve("oidc-provider")), "helpers/weak_cache.js")).href);
    instance(provider).configuration.formats.customizers.jwt = async (_ctx, _token, jwt) => { jwt.payload.exp += 600; };
  }
  const client = await provider.Client.find(clientId), family = new provider.Grant({ accountId: owner, clientId });
  verification.metadata_digest = adminDigest(client.metadata());
  family.addOIDCScope("openid offline_access"); family.addResourceScope(ADMIN_RESOURCE, "admin:read");
  const familyId = await family.save();
  binding = { ...grant, admin_grant_id: grantId, provider_grant_id: familyId, verification_version: 1, jkt,
    expires_at: new Date(grant.expires_at), refresh_deadline: new Date(grant.refresh_deadline) };
  const verifier = "boundary-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
  const code = await new provider.AuthorizationCode({ accountId: owner, client, grantId: familyId,
    scope: "openid offline_access admin:read", resource: [ADMIN_RESOURCE], redirectUri,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256", dpopJkt: jkt }).save();
  artifact = { payload: { clientId, dpopJkt: jkt }, grant_id: familyId, consumed_at: null };
  const dpop = await new SignJWT({ htm: "POST", htu: `${ISSUER}/token`, iat: now / 1000,
    jti: randomUUID(), nonce: "boundary-nonce" }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk }).sign(key.privateKey);
  const proof = await admitAdminProof(pool, await verifyAdminProof({ method: "POST", headers: { dpop } }, jkt));
  queries.length = 0; // Observe the issuance unit separately from proof admission.
  const params = { client_id: clientId, grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: redirectUri, resource: ADMIN_RESOURCE };
  const coordinator = new AdminTransactionCoordinator(pool, { adminIssuanceEnabled: true });
  const lifecycle = new AdminTokenLifecycle({ activeKid: signingJwk.kid }), callback = provider.callback();
  let outcome;
  const server = createServer(async (request, response) => { outcome = await coordinator.run(response, async () => {
    await lifecycle.prepareToken({ binding, model: "AuthorizationCode", hash: "fixture-code-digest", consumed_at: null }, params);
    await callback(request, response);
  }, { kind: "token", owner, proof }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/token`, { method: "POST",
    headers: { host: new URL(ISSUER).host, "x-forwarded-host": new URL(ISSUER).host, "x-forwarded-proto": "https", dpop,
      "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  return { status: response.status, body: await response.json(), grant, events, ledger, failures, serverErrors, queries, refusalReached,
    diagnostic: JSON.stringify({ refusal: outcome?.cause?.code,
      grantErrors: failures.map(error => error.error), serverErrors: serverErrors.map(error => error.code) }) };
}

test("admin first exchange uses the committed grant and clips the actual signed JWT to short consent", async t => {
  for (const seconds of [120, 600]) {
    const result = await adminExchange(t, seconds);
    assert.equal(result.status, 200, result.diagnostic);
    assert.equal(result.body.token_type, "DPoP");
    const jwt = decodeJwt(result.body.access_token);
    assert.ok(jwt.exp * 1000 <= result.grant.expires_at);
    assert.ok(jwt.exp - jwt.iat <= Math.min(300, seconds));
    assert.equal(result.events.filter(e => e.type === "AdminCredentialIssued").length, 1);
    assert.equal(result.ledger.length, 1);
    assert.equal(result.failures.length + result.serverErrors.length, 0);
    assert.ok(result.queries.includes("COMMIT"));
  }
});

test("admin token validation refusal maps to OAuth invalid_grant 400 and rolls back without a ledger row", async t => {
  const result = await adminExchange(t, 600, { badExpiry: true });
  assert.equal(result.status, 400, result.diagnostic);
  assert.equal(result.body.error, "invalid_grant");
  assert.ok(!("access_token" in result.body) && !("refresh_token" in result.body));
  assert.equal(result.serverErrors.length, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0] instanceof errors.InvalidGrant);
  assert.equal(result.ledger.length, 0);
  assert.ok(result.queries.includes("ROLLBACK"));
  const control = await adminExchange(t, 600);
  assert.equal(control.status, 200);
  assert.equal(control.ledger.length, 1);
});

test("all admin consent and coordinator refusals remain exposed OAuth errors through the real provider and rollback", async t => {
  const cases = [
    ["invalid_grant", 400, "invalid_grant"],
    ["invalid_scope", 400, "invalid_scope"],
    ["unauthorized_client", 403, "unauthorized_client"],
    ["invalid_target", 400, "invalid_target"],
    ["invalid_request", 400, "invalid_request"],
    ["invalid_manifest", 400, "invalid_request"],
    ["consent_receipt_invalid", 400, "invalid_request"],
    ["authentication_required", 403, "access_denied"],
    ["fresh_authentication_required", 403, "access_denied"],
    ["origin_forbidden", 403, "access_denied"],
    ["workspace_forbidden", 403, "access_denied"],
    ["dpop_required", 403, "invalid_dpop_proof"],
    ["admin_issuance_disabled", 503, "temporarily_unavailable"],
    ["admin_migration_evidence_incomplete", 503, "temporarily_unavailable"],
    ["future_consent_refusal", 400, "invalid_request"],
    ["future_consent_outage", 503, "temporarily_unavailable"],
  ];
  for (const [code, status, oauth] of cases) await t.test(code, async t => {
    const result = await adminExchange(t, 600, { refusal: new AdminConsentError(code, status) });
    assert.equal(result.refusalReached, true);
    assert.equal(result.status, status, result.diagnostic);
    assert.equal(result.body.error, oauth);
    assert.equal(result.serverErrors.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].error, oauth);
    assert.equal(result.failures[0].statusCode, status);
    assert.equal(result.failures[0].expose, true);
    assert.ok(!("access_token" in result.body) && !("refresh_token" in result.body));
    assert.ok(result.queries.includes("ROLLBACK"));
    assert.ok(!result.queries.includes("COMMIT"));
  });
  await t.test("coordinator refusal inside provider", async t => {
    const result = await adminExchange(t, 600, { refusal: new AdminTransactionError("admin_transaction_required") });
    assert.equal(result.refusalReached, true);
    assert.equal(result.status, 503, result.diagnostic);
    assert.equal(result.body.error, "temporarily_unavailable");
    assert.equal(result.serverErrors.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].error, "temporarily_unavailable");
    assert.equal(result.failures[0].statusCode, 503);
    assert.equal(result.failures[0].expose, true);
    assert.ok(!("access_token" in result.body) && !("refresh_token" in result.body));
    assert.ok(result.queries.includes("ROLLBACK"));
    assert.ok(!result.queries.includes("COMMIT"));
  });
  const control = await adminExchange(t, 600);
  assert.equal(control.status, 200, control.diagnostic);
  assert.equal(typeof control.body.access_token, "string");
});

test("admin access token without resourceServer refuses cleanly without issuing a token", async t => {
  const result = await adminExchange(t, 600, { missingResourceServer: true });
  assert.equal(result.refusalReached, true);
  assert.equal(result.status, 400, result.diagnostic);
  assert.equal(result.body.error, "invalid_grant");
  assert.equal(result.serverErrors.length, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0] instanceof errors.InvalidGrant);
  assert.equal(result.ledger.length, 0);
  assert.ok(!("access_token" in result.body) && !("refresh_token" in result.body));
  assert.ok(result.queries.includes("ROLLBACK"));
  assert.ok(!result.queries.includes("COMMIT"));
  const control = await adminExchange(t, 120);
  assert.equal(control.status, 200, control.diagnostic);
  assert.ok(decodeJwt(control.body.access_token).exp * 1000 <= control.grant.expires_at);
});
