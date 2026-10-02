import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, exportJWK,
  generateKeyPair, SignJWT } from "jose";
import { createPostgresAdapter } from "../src/postgres-adapter.js";
import { InteractionStore } from "../src/interaction-store.js";
import { hashOpaque } from "../src/browser-security.js";
import { createSpikeProvider, holdResponse, requestDatabase,
  SPIKE_ISSUER as ISSUER, SPIKE_ADMIN_RESOURCE as ADMIN } from "../test/fixtures/atomic-provider-harness.js";

const redirectUri = "https://client.example/callback";
const verifier = "atomic-provider-verifier-0123456789abcdef0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const digest = value => createHash("sha256").update(value).digest();

// Force ONLY the imported test copy of lane 3a's gate. No source/file/env change,
// no new production switch. Its policy, receipt checks and completion hook run.
async function testConsentModule() {
  const url = new URL("../src/admin-consent.js", import.meta.url);
  let source = await readFile(url, "utf8");
  const gate = "export const ADMIN_AS_ISSUANCE_ENABLED = false;";
  assert.equal(source.split(gate).length, 2);
  source = source.replace(gate, "export const ADMIN_AS_ISSUANCE_ENABLED = true;")
    .replace(/from "(\.\/[^"]+)"/gu, (_match, path) => `from "${new URL(path, url).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function fixture() {
  assert.equal(process.env.CI, "true", "PostgreSQL spike is CI-only (Docker); do not run locally");
  const target = new URL(process.env.MCP_OAUTH_TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "isolated local CI database required");
  // Same cluster-admin fixture identity as tests/support/admin-schema-db.ts.
  // No production credentials; runtime ACL/bridge design is NOT this spike.
  target.username = "supabase_admin";
  const pool = new Pool({ connectionString: target.href, max: 3 });
  try { await pool.query("SELECT 1"); }
  catch (error) { await pool.end(); throw error; }
  const db = requestDatabase(), traces = new Map(), controls = new Map();
  const { adminDigest, createAdminManifest, createAdminConsentService, PostgresAdminConsentStore } = await testConsentModule();
  const owner = randomUUID(), clientId = `https://client.example/${randomUUID()}`;
  const key = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(key.publicKey), jkt = await calculateJwkThumbprint(publicJwk);
  const signing = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...await exportJWK(signing.privateKey), alg: "ES256", use: "sig", kid: "atomic-spike-key" };
  const metadata = { client_id: clientId, application_type: "web", client_name: "Atomic CI fixture",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    redirect_uris: [redirectUri], token_endpoint_auth_method: "none", id_token_signed_response_alg: "ES256",
    dpop_bound_access_tokens: true, dpop_signing_alg: "ES256" };
  const base = new InteractionStore(db.pool);
  let sessionId, pendingConsent, family;
  const provider = createSpikeProvider({
    adapter: createPostgresAdapter(db.pool), metadata, jwk,
    extraTokenClaims: async (_ctx, token) => {
      const row = (await db.pool.query(`SELECT * FROM commonswarm_oauth.resolve_admin_grant_status($1,$2,$3)`,
        [token.grantId, owner, jwk.kid])).rows[0];
      assert.equal(row?.active, true, "claims must read live authority on the request client");
      return { grant_id: token.grantId, admin_grant_id: row.admin_grant_id, grant_class: "delegated_admin" };
    },
    jwtCustomizer: async () => {
      if (db.current().fault === "signing") throw new Error("spike signing failure");
    },
  });
  const store = new PostgresAdminConsentStore(db.pool);
  async function accountEvent(tx, type, grantId, payload) {
    const event = randomUUID();
    const seq = (await tx.query(`UPDATE swarm.admin_accounts SET seq=seq+1 WHERE owner_user_id=$1 RETURNING seq`, [owner])).rows[0].seq;
    await tx.query(`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES($1,$2,$3,$4,$5)`,
      [owner, seq, event, randomUUID(), { stream_kind: "account", owner_user_id: owner, seq: Number(seq),
        type, grant_id: grantId, payload }]);
    return event;
  }
  const service = createAdminConsentService({ store, provider, staticClientIds: new Set([clientId]),
    completeInTransaction: async (tx, { receipt, createFreshGrant }) => {
      assert.equal(tx.query, db.pool.query, "lane-3a hook joins the scoped client");
      const consumed = await tx.query(`UPDATE commonswarm_oauth.admin_interactions
        SET consumed_at=statement_timestamp() WHERE interaction_uid=$1 AND consumed_at IS NULL RETURNING *`, [receipt.interaction_uid]);
      assert.equal(consumed.rowCount, 1);
      const grant = createFreshGrant();
      // Reserve the provider's real ID BEFORE save: M1 refuses unbound admin artifacts.
      grant.jti = grant.generateTokenId();
      const m = receipt.manifest, adminGrant = randomUUID(), consentId = randomUUID();
      await tx.query(`INSERT INTO swarm.admin_consents(consent_receipt_id,owner_user_id,session_binding,
        manifest_digest,manifest,full_account_selected,expires_at,consumed_at)
        VALUES($1,$2,$3,$4,$5,false,$6,statement_timestamp())`,
      [consentId, owner, receipt.session_binding.toString("hex"), receipt.manifest_digest, m, receipt.expires_at]);
      await tx.query(`INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,
        client_id,resource,registry_version,scope_names,workspace_ids,created_workspace_policy,target_rules,
        worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,expires_at,refresh_deadline,state,
        consent_receipt_id,manifest_digest,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18,$19,date_trunc('second',$20::timestamptz))`,
      [adminGrant, owner, m.admin_identity_id, m.connection_id, clientId, ADMIN, m.registry_version,
        m.scope_names, m.workspace_ids, m.created_workspace_policy, m.target_rules, m.worker_scope_ceiling,
        m.role_ceiling, m.renewal_limits, m.issuance_limits, new Date(m.expires_at), new Date(m.refresh_deadline),
        consentId, receipt.manifest_digest, new Date(m.expires_at - 86400000)]);
      await tx.query(`INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,
        owner_user_id,client_id,connection_id,admin_grant_id) VALUES($1,$2,'delegated_admin',$3,$4,$5,$6)`,
      [grant.jti, ADMIN, owner, clientId, m.connection_id, adminGrant]);
      await tx.query(`INSERT INTO commonswarm_oauth.admin_grant_bindings(provider_grant_id,admin_grant_id,owner_user_id,
        admin_identity_id,connection_id,client_id,resource,registry_version,capabilities,scope_names,availability_digest,
        manifest_digest,verification_version,jkt,consented_at,expires_at,refresh_deadline,state)
        SELECT $1,grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,$3,scope_names,$4,
          manifest_digest,1,$5,created_at,expires_at,refresh_deadline,'active' FROM swarm.admin_grants WHERE grant_id=$2`,
      [grant.jti, adminGrant, m.capability_names, m.availability_digest, jkt]);
      await grant.save();
      await accountEvent(tx, "AdminDelegationGranted", adminGrant,
        { manifest: m, provider_grant_id: grant.jti, version: 2 });
      await tx.query(`UPDATE commonswarm_oauth.interactions SET completed_at=statement_timestamp() WHERE interaction_uid=$1`,
        [receipt.interaction_uid]);
      family = grant.jti;
      return grant.jti;
    } });

  provider.use(async (ctx, next) => {
    await next();
    // Provider catches grant errors internally. An HTTP error MUST cause the
    // coordinator to roll back, even if callback() resolves normally.
    if (ctx.path === "/token" && ctx.status < 400) {
      const token = ctx.body.access_token, jwt = decodeJwt(token);
      const generation = ctx.oidc.params.grant_type === "refresh_token" ? 1 : 0;
      const row = (await db.pool.query(`UPDATE commonswarm_oauth.admin_grant_bindings
        SET generation=$2,initial_issued_at=coalesce(initial_issued_at,to_timestamp($3))
        WHERE provider_grant_id=$1 RETURNING *`, [jwt.grant_id, generation, jwt.iat])).rows[0];
      const audit = randomUUID();
      const event = await accountEvent(db.pool, generation === 0 ? "AdminCredentialIssued" : "AdminCredentialRotated",
        row.admin_grant_id, { provider_grant_id: jwt.grant_id, generation, version: 2 });
      await db.pool.query(`INSERT INTO commonswarm_oauth.admin_oauth_audit(audit_id,owner_user_id,admin_identity_id,
        admin_grant_id,connection_id,provider_grant_id,manifest_digest,event_kind,outcome,related_event_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'committed',$9)`,
      [audit, owner, row.admin_identity_id, row.admin_grant_id, row.connection_id, jwt.grant_id, row.manifest_digest,
        generation === 0 ? "issued" : "rotated", [event]]);
      await db.pool.query(`INSERT INTO commonswarm_oauth.admin_access_issuances(access_jti,access_token_digest,
        provider_grant_id,admin_grant_id,generation,client_id,resource,jkt,manifest_digest,scope_names,issuer,kid,
        issued_at,expires_at,event_id,audit_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13),to_timestamp($14),$15,$16)`,
      [jwt.jti, digest(token), jwt.grant_id, row.admin_grant_id, generation, clientId, ADMIN, jkt,
        row.manifest_digest, ["admin:read"], ISSUER, decodeProtectedHeader(token).kid, jwt.iat, jwt.exp, event, audit]);
    }
  });

  // Superuser CI fixture only. Gate changes are transaction-local and RESTORED
  // BEFORE physical COMMIT. Suppress only the cutover update's permanence trigger;
  // every application/provider/ledger/audit write runs with real triggers enabled.
  // CHECK constraints remain active. Never commits an enabled database gate.
  async function gate(client, original) {
    await client.query("SET LOCAL session_replication_role=replica");
    if (original) {
      const columns = Object.keys(original);
      assert.ok(columns.every(name => /^[a-z_]+$/u.test(name)));
      await client.query(`UPDATE commonswarm_oauth.admin_cutover_state SET ${columns.map((name, i) => `${name}=$${i + 1}`).join(",")}`,
        columns.map(name => original[name]));
    } else {
      await client.query(`UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true,
        legacy_closed=true,legacy_closed_at=statement_timestamp(),legacy_fence_evidence_ref='CI SPIKE ONLY',
        approved_edge_release_sha=repeat('a',40),auth_contract_version=2,
        required_migrations=jsonb_build_object('20261003000001',repeat('a',64),'20261003000002',repeat('b',64),'20261003000003',repeat('c',64)),
        lane8_evidence_digest=repeat('d',64),measured_edge_release_sha=repeat('a',40),
        measured_edge_target='/home/commonswarm/edge/releases/'||repeat('a',40),
        measured_mount='/home/commonswarm/edge/releases/'||repeat('a',40),measured_artifact_digest=repeat('e',64),
        measured_image_digest='sha256:'||repeat('f',64),measured_generation=release_generation,
        measured_at=statement_timestamp(),measurement_evidence_ref='CI SPIKE ONLY',invalidated_at=NULL`);
    }
    await client.query("SET LOCAL session_replication_role=origin");
  }

  const callback = provider.callback();
  const server = createServer(async (request, response) => {
    const id = request.headers["x-spike-id"], fault = request.headers["x-spike-fault"];
    const held = holdResponse(response), client = await pool.connect();
    const scope = { client, calls: [], writes: [], joined: [], pending: new Set(), fault,
      failAfterWrite: Number(request.headers["x-spike-after"]), closed: false, committed: false,
      beforeCommit: controls.get(id) };
    traces.set(id, scope);
    try {
      await client.query("BEGIN");
      const original = (await client.query(`SELECT * FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE`)).rows[0];
      assert.equal(original.admin_issuance_enabled, false);
      await gate(client);
      await db.context.run(scope, async () => {
        if (request.url.startsWith("/interaction/")) {
          const details = await provider.interactionDetails(request, response);
          if (details.prompt.name === "login") {
            await provider.interactionFinished(request, response, { login: { accountId: owner } });
          } else if (request.method === "GET") {
            await base.bindInteraction({ interactionUid: details.uid, sessionId, userId: owner, clientId,
              redirectUri, resource: ADMIN, scopes: details.params.scope.split(" "), pkceChallenge: challenge,
              oauthState: details.params.state });
            const csrf = await base.issueConsentToken(details.uid, sessionId, owner);
            const input = { uid: details.uid, sessionId, ownerUserId: owner, params: details.params,
              csrfToken: csrf.token, version: csrf.selectionVersion };
            const selected = await service.select(input, { mode: "granular", scope_names: ["admin:read"],
              workspace_ids: [], expires_at: new Date(Date.now() + 86400000).toISOString() });
            pendingConsent = { input: { ...input, version: 1, csrfToken: selected.summary.token },
              completion: { summary_digest: selected.summary.digest } };
            response.statusCode = 204; response.end();
          } else {
            const grantId = await service.confirm(pendingConsent.input, pendingConsent.completion);
            await provider.interactionFinished(request, response, { consent: { grantId } });
          }
        } else await callback(request, response);
        await db.drain(scope);
        if (response.statusCode >= 400) throw new Error("provider error response rolls back issuance");
      });
      assert.equal(held.staged, true, "provider completed its response before commit");
      assert.equal(response.headersSent, false);
      await gate(client, original);
      if (fault === "commit") {
        // Real aborted PostgreSQL transaction: COMMIT returns ROLLBACK, rather
        // than the successful command tag. Do not assume a deferrable FK exists.
        await client.query("SELECT 1/0").catch(() => {});
      }
      if (scope.beforeCommit) await scope.beforeCommit();
      const result = await client.query("COMMIT");
      assert.equal(result.command, "COMMIT", "failed transaction must not masquerade as commit");
      scope.committed = true; scope.closed = true;
      held.release();
    } catch {
      await db.drain(scope).catch(() => {});
      await client.query("ROLLBACK");
      scope.closed = true; held.discard();
      response.statusCode = 503; response.setHeader("content-type", "application/json");
      response.end('{"error":"temporarily_unavailable"}');
    } finally { client.release(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, cookies = new Map();
  async function request(url, { method = "GET", body, after, fault, beforeCommit } = {}) {
    const external = new URL(url, ISSUER), id = randomUUID();
    controls.set(id, beforeCommit);
    const headers = { host: new URL(ISSUER).host, "x-forwarded-host": new URL(ISSUER).host,
      "x-forwarded-proto": "https", accept: "application/json", "x-spike-id": id,
      "x-spike-after": String(after ?? 0), "x-spike-fault": fault ?? "" };
    if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (external.pathname === "/token") headers.dpop = await new SignJWT({ htm: "POST", htu: `${ISSUER}/token` })
        .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
        .setJti(randomUUID()).setIssuedAt().sign(key.privateKey);
    }
    const response = await fetch(new URL(external.pathname + external.search, origin),
      { method, headers, body: body ? new URLSearchParams(body) : undefined, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0], at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return { response, trace: traces.get(id) };
  }
  const setup = await pool.connect();
  let setupError;
  try {
    await setup.query("BEGIN");
    await setup.query(`INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)`, [owner, `${owner}@example.test`]);
    await setup.query(`INSERT INTO swarm.users(user_id,display_name) VALUES($1,'Atomic spike owner')`, [owner]);
    await setup.query(`INSERT INTO swarm.admin_accounts(owner_user_id,stream_id,seq) VALUES($1,$2,1)`, [owner, randomUUID()]);
    // Provider metadata normalization is included in the lane-3a verification pin.
    const runtimeMetadata = (await provider.Client.find(clientId)).metadata();
    await setup.query(`INSERT INTO commonswarm_oauth.admin_verified_clients(client_id,verification_version,
      application_type,registration_source,publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,
      pkce_s256_tested,dpop_tested,redirect_tested,origin_control_verified,review_evidence_ref,reviewed_by,active)
      VALUES($1,1,'web','static','CI publisher','ci@example.test',$2,$3,ARRAY['admin:read'],true,true,true,true,'CI ONLY','CI ONLY',true)`,
    [clientId, adminDigest(runtimeMetadata), [redirectUri]]);
    const approvalEvent = randomUUID();
    await setup.query(`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
      VALUES($1,1,$2,'approval',jsonb_build_object('stream_kind','account','owner_user_id',$1::text,'seq',1,
        'type','AdminClientApproved','actor_user',$1::text,'payload',jsonb_build_object('client_id',$3::text,'verification_version',1)))`,
    [owner, approvalEvent, clientId]);
    await setup.query(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,
      approval_event_id,approval_command_id) VALUES($1,$2,1,$3,'approval')`, [owner, clientId, approvalEvent]);
    // Exercise the shared manifest builder here too, not copied capability names.
    assert.ok(createAdminManifest({ mode: "granular", scope_names: ["admin:read"], workspace_ids: [] },
      { resourceScopes: ["admin:read"], verification: { client_id: clientId } }));
    await db.context.run({ client: setup, calls: [], writes: [], joined: [], pending: new Set() }, async () => {
      sessionId = await base.createSession();
      await db.pool.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,authenticated_at=statement_timestamp()
        WHERE session_hash=$2`, [owner, hashOpaque(sessionId)]);
    });
    await setup.query("COMMIT");
  } catch (error) { await setup.query("ROLLBACK"); setupError = error; }
  finally { setup.release(); }
  if (setupError) {
    await new Promise(resolve => server.close(resolve)); await pool.end(); throw setupError;
  }

  async function snapshot() {
    const tables = ["swarm.admin_accounts", "swarm.admin_grants", "swarm.admin_consents", "swarm.admin_events",
      "commonswarm_oauth.admin_grant_bindings", "commonswarm_oauth.provider_grant_resources",
      "commonswarm_oauth.admin_oauth_audit",
      "commonswarm_oauth.admin_interactions", "commonswarm_oauth.interactions"];
    const result = [];
    for (const table of tables) result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows
      FROM ${table} t WHERE ${table.endsWith(".interactions") ? "user_id" : "owner_user_id"}=$1`, [owner])).rows[0].rows);
    result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY access_jti),'[]') AS rows
      FROM commonswarm_oauth.admin_access_issuances t WHERE provider_grant_id IN
      (SELECT provider_grant_id FROM commonswarm_oauth.admin_grant_bindings WHERE owner_user_id=$1)`, [owner])).rows[0].rows);
    result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY artifact_id_hash),'[]') AS rows
      FROM commonswarm_oauth.provider_artifacts t WHERE payload->>'clientId'=$1 OR payload->>'accountId'=$2
        OR payload->>'iss'=$1`, [clientId, owner])).rows[0].rows);
    result.push((await pool.query(`SELECT to_jsonb(t) AS gate FROM commonswarm_oauth.admin_cutover_state t WHERE singleton`)).rows[0].gate);
    // A failing assertion must not dump provider/session artifact payloads.
    return digest(JSON.stringify(result)).toString("hex");
  }
  return { pool, owner, clientId, jkt, request, snapshot, traces, family: () => family,
    consent: () => pendingConsent,
    async close() { await new Promise(resolve => server.close(resolve)); await pool.end(); } };
}

function atomic(trace) {
  assert.equal(trace.committed, true);
  assert.ok(trace.writes.length > 0);
  assert.equal(new Set(trace.calls.map(call => `${call.pid}:${call.xid}`)).size, 1,
    "ALL actual provider/status/authority calls must share a backend transaction");
  assert.equal(trace.pending.size, 0);
}

test("admin-atomic-provider-transaction: pinned real HTTP consent, continuation, code and refresh; each write rolls back and response follows COMMIT",
  { timeout: 120000 }, async t => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
    const installed = JSON.parse(await readFile(new URL("../node_modules/oidc-provider/package.json", import.meta.url)));
    assert.equal(installed.version, pkg.dependencies["oidc-provider"], "test the exact installed pin");
    const f = await fixture();
    try {
      const authorize = new URL("/authorize", ISSUER);
      for (const [name, value] of Object.entries({ client_id: f.clientId, redirect_uri: redirectUri,
        response_type: "code", scope: "openid offline_access admin:read", prompt: "consent", resource: ADMIN,
        code_challenge: challenge, code_challenge_method: "S256", dpop_jkt: f.jkt,
        state: randomUUID() })) authorize.searchParams.set(name, value);
      let current = authorize, consentUrl;
      for (let step = 0; step < 8; step++) {
        const result = await f.request(current);
        atomic(result.trace);
        if (result.response.status === 204) { consentUrl = current; break; }
        assert.ok([302, 303].includes(result.response.status), "authorization/login redirect expected");
        current = new URL(result.response.headers.get("location"), ISSUER);
      }
      assert.ok(consentUrl, "real provider must reach lane-3a selection");

      async function proveUnit(name, url, options, expected) {
        const baseline = await f.snapshot();
        // First explore the real write count in a forced-rollback control.
        const probe = await f.request(url, { ...options, fault: "commit" });
        assert.equal(probe.response.status, 503);
        assert.equal(await f.snapshot(), baseline, "failed COMMIT must restore every owned row");
        assert.ok(probe.trace.writes.length > 0);
        const count = probe.trace.writes.length;
        for (let after = 1; after <= count; after++) await t.test(`${name}: rollback after write ${after}`, async () => {
          const failed = await f.request(url, { ...options, after });
          assert.equal(failed.response.status, 503);
          assert.equal(failed.trace.writes.length, after, "fault must reach the intended write");
          assert.equal(failed.trace.committed, false);
          assert.equal(await f.snapshot(), baseline, "no artifact/consume/authority/audit may survive alone");
          const denied = await failed.response.json();
          assert.ok(!("access_token" in denied) && !("refresh_token" in denied), "error response contains no token fields");
          assert.ok(failed.response.headers.get("location") === null, "no code/continuation redirect leaks");
        });
        if (url === "/token") {
          const failed = await f.request(url, { ...options, fault: "signing" });
          assert.equal(failed.response.status, 503);
          assert.equal(await f.snapshot(), baseline, "signing failure rolls back consumed source and successor writes");
          const body = await failed.response.json();
          assert.ok(!("access_token" in body) && !("refresh_token" in body), "signing failure contains no token fields");
        }
        let entered, unblock;
        const atCommit = new Promise(resolve => { entered = resolve; });
        const blocked = new Promise(resolve => { unblock = resolve; });
        let delivered = false;
        const operation = f.request(url, { ...options, beforeCommit: async () => {
          entered(); await blocked;
        } }).then(result => { delivered = true; return result; });
        // Do not hang if the positive path fails before reaching COMMIT.
        await Promise.race([atCommit, operation.then(() => { throw new Error("positive path missed commit barrier"); })]);
        try {
          assert.equal(delivered, false, "HTTP client receives no headers/body before COMMIT");
          assert.equal(await f.snapshot(), baseline, "independent backend sees no staged changes before COMMIT");
        } finally { unblock(); }
        const good = await operation;
        assert.equal(good.response.status, expected); atomic(good.trace);
        assert.equal(good.trace.writes.length, count);
        return good;
      }
      const finished = await proveUnit("consent finish", consentUrl, { method: "POST", body: {} }, 303);
      const continued = await proveUnit("authorization continuation", finished.response.headers.get("location"), {}, 303);
      const code = new URL(continued.response.headers.get("location")).searchParams.get("code");
      assert.equal(typeof code, "string");
      const exchanged = await proveUnit("code exchange", "/token", { method: "POST", body: {
        client_id: f.clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, resource: ADMIN } }, 200);
      const initial = await exchanged.response.json();
      assert.equal(initial.token_type, "DPoP"); assert.equal(typeof initial.refresh_token, "string");
      const rotated = await proveUnit("refresh", "/token", { method: "POST", body: {
        client_id: f.clientId, grant_type: "refresh_token", refresh_token: initial.refresh_token, resource: ADMIN } }, 200);
      const successor = await rotated.response.json();
      assert.equal(successor.token_type, "DPoP");
      assert.ok(successor.refresh_token !== initial.refresh_token, "refresh must rotate without logging either credential");
      const recorded = await f.pool.query(`SELECT generation,access_token_digest FROM commonswarm_oauth.admin_access_issuances
        WHERE provider_grant_id=$1 ORDER BY generation`, [f.family()]);
      assert.deepEqual(recorded.rows.map(row => row.generation), [0, 1]);
      assert.ok(recorded.rows[0].access_token_digest.equals(digest(initial.access_token)));
      assert.ok(recorded.rows[1].access_token_digest.equals(digest(successor.access_token)));
      // Independent durable row versions, not just ALS traces: authority/event/
      // audit/ledger and adapter mutations must bear the coordinator's real XID.
      const xid32 = trace => String(BigInt(trace.calls[0].xid) % (2n ** 32n));
      const versions = await f.pool.query(`SELECT i.generation,i.xmin::text AS ledger,e.xmin::text AS event,a.xmin::text AS audit
        FROM commonswarm_oauth.admin_access_issuances i JOIN swarm.admin_events e USING(event_id)
        JOIN commonswarm_oauth.admin_oauth_audit a USING(audit_id) WHERE i.provider_grant_id=$1 ORDER BY i.generation`, [f.family()]);
      for (const row of versions.rows) {
        const expected = xid32(row.generation === 0 ? exchanged.trace : rotated.trace);
        assert.deepEqual([row.ledger, row.event, row.audit], [expected, expected, expected]);
      }
      const providerVersions = await f.pool.query(`SELECT model,xmin::text AS xid FROM commonswarm_oauth.provider_artifacts
        WHERE grant_id=$1 OR (model='Grant' AND payload->>'jti'=$1)`, [f.family()]);
      assert.ok(providerVersions.rows.some(row => row.model === "AuthorizationCode"));
      assert.equal(providerVersions.rows.filter(row => row.model === "RefreshToken").length, 2);
      for (const row of providerVersions.rows) assert.equal(row.xid,
        xid32(row.model === "Grant" ? finished.trace : row.model === "AuthorizationCode" ? exchanged.trace : rotated.trace));
      const authorityVersions = await f.pool.query(`SELECT xmin::text AS xid FROM commonswarm_oauth.admin_grant_bindings
        WHERE provider_grant_id=$1 UNION ALL SELECT xmin::text FROM swarm.admin_accounts WHERE owner_user_id=$2`, [f.family(), f.owner]);
      assert.ok(authorityVersions.rows.every(row => row.xid === xid32(rotated.trace)));
      assert.equal((await f.pool.query(`SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state`)).rows[0].admin_issuance_enabled, false);
    } finally { await f.close(); }
  });
