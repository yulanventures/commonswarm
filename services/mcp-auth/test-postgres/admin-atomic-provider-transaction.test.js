import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { calculateJwkThumbprint, decodeJwt, exportJWK,
  generateKeyPair, SignJWT } from "jose";
import { createPostgresAdapter } from "../src/postgres-adapter.js";
import { InteractionStore } from "../src/interaction-store.js";
import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { AdminTransactionCoordinator, adminTransactionContext, adminQuery, withAdminRole, scopedAdminPool } from "../src/admin-transaction.js";
import { verifyAdminProof, admitAdminProof } from "../src/admin-dpop.js";
import { bindProviderAdminNonceStore } from "../src/provider-admin-pin.js";
import { effectiveAdminGate } from "../src/admin-gate.js";
import { atomicDiagnostic, eventDiagnostic, failureCode, httpStepDiagnostic, responseDiagnostic, restoreCutoverState, safeRole }
  from "../test/fixtures/admin-atomic-diagnostics.js";
const ISSUER = "https://mcp.commonswarm.com", ADMIN = "https://api.commonswarm.com/admin";
const require = createRequire(import.meta.url);


const redirectUri = "https://client.example/callback";
const verifier = "atomic-provider-verifier-0123456789abcdef0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const digest = value => createHash("sha256").update(value).digest();

// Exercise the production configurable gate; no imported source is patched.
async function testConsentModule() {
  return { ...await import("../src/admin-consent.js"),
    ...await import("../src/admin-lifecycle.js"), ...await import("../src/provider.js") };
}

async function fixture({ consentLifetimeMs=86400000 } = {}) {
  assert.equal(process.env.CI, "true", "PostgreSQL spike is CI-only (Docker); do not run locally");
  const target = new URL(process.env.MCP_OAUTH_TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "isolated local CI database required");
  // Same cluster-admin fixture identity as tests/support/admin-schema-db.ts.
  // No production credentials. Setup needs cluster privileges; application SQL
  // uses the actual D1 session principal and local role permissions.
  target.username = "supabase_admin";
  const pool = new Pool({ connectionString: target.href, max: 3 });
  try { await pool.query("SELECT 1"); }
  catch (error) { await pool.end(); throw error; }
  const db = { current: () => adminTransactionContext(), pool: scopedAdminPool() };
  const traces = new Map(), controls = new Map(), testRequests = new AsyncLocalStorage();
  const { adminDigest, createAdminManifest, createAdminConsentService, PostgresAdminConsentStore, AdminTokenLifecycle,
    requireMeasuredAdminRelease, createMcpProvider } = await testConsentModule();
  // Fixture-local configuration, parsed exactly as loadConfig parses the flag.
  // No process-wide environment or production configuration is changed.
  const activationEnv = { MCP_OAUTH_ADMIN_ISSUANCE_ENABLED: "1" };
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
  const lifecycle = new AdminTokenLifecycle({ activeKid: jwk.kid });
  let sessionId, pendingConsent, family;
  let proofNonce = randomBytes(32).toString("base64url");
  let proofNonceRenewAt=Date.now()+45000,nonceRenewal=Promise.resolve();
  const proofPassword = randomBytes(32).toString("hex");
  await pool.query(`ALTER ROLE commonswarm_admin_issuer PASSWORD '${proofPassword}'`);
  const proofTarget = new URL(target.href); proofTarget.username="commonswarm_admin_issuer"; proofTarget.password=proofPassword;
  const proofPool = new Pool({ connectionString: proofTarget.href, max: 2 });
  let provider = await createMcpProvider({
    adapter: createPostgresAdapter(db.pool), jwks: { keys: [jwk] }, activeSigningKid: jwk.kid,
    registrationEnabled: false,
    registrationStore: { find: async id => id === clientId ? metadata : undefined, markUsed: async () => {} },
    providerGrantResource: async id => (await db.pool.query(`SELECT resource FROM commonswarm_oauth.provider_grant_resources
      WHERE provider_grant_id=$1`,[id])).rows[0]?.resource,
  });
  // Inject only the failure, through the pinned provider's actual signing hook.
  // The production provider middleware owns claims, clipped TTL and ledgering.
  const { default: providerInstance } = await import(pathToFileURL(resolve(dirname(require.resolve("oidc-provider")),"helpers/weak_cache.js")).href);
  providerInstance(provider).configuration.formats.customizers.jwt = async () => {
    if (db.current().fault === "signing") throw new Error("test signing failure");
  };
  function subscribeDiagnostics(provider) {
    for (const event of ["server_error", "authorization.error", "grant.error"]) {
      provider.on(event, (_ctx, error) => {
        const trace = traces.get(testRequests.getStore()?.id);
        if (trace) {
          trace.failure ??= failureCode(error);
          trace.events.push(eventDiagnostic(event, error));
        }
      });
    }
    provider.use(async (ctx, next) => {
      try { await next(); }
      finally {
        const trace = traces.get(testRequests.getStore()?.id);
        if (trace) trace.providerResponse = responseDiagnostic(ctx.status, ctx.body, ctx.response.get("location"));
      }
    });
  }
  subscribeDiagnostics(provider);
  const store = new PostgresAdminConsentStore(db.pool);
  await bindProviderAdminNonceStore(provider);
  const service = createAdminConsentService({ store, provider, staticClientIds: new Set([clientId]),
    completeInTransaction: async (...args) => {
      const id = await lifecycle.completeConsent(...args); family = id; return id;
    } });

  // Superuser CI fixture only. Gate changes are transaction-local and RESTORED
  // BEFORE physical COMMIT. Suppress only the cutover update's permanence trigger;
  // every application/provider/ledger/audit write runs with real triggers enabled.
  // CHECK constraints remain active. Never commits an enabled database gate.
  const versions = ['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005',
    '20260928000003','20261002000001','20261003000001','20261003000002','20261003000003','20261003000004'];
  const { readdir } = await import("node:fs/promises");
  const migrationRoot = new URL("../../../supabase/migrations/", import.meta.url);
  const files = await readdir(migrationRoot), hashes = {};
  for (const version of versions) {
    const file = files.find(name => name.startsWith(`${version}_`));
    assert.ok(file, `required migration ${version} exists`);
    hashes[version] = digest(await readFile(new URL(file, migrationRoot))).toString("hex");
  }
  async function gate(client, original) {
    await client.query("SET LOCAL session_replication_role=replica");
    if (original) {
      await restoreCutoverState(client, original);
    } else {
      await client.query(`UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true,
        legacy_closed=true,legacy_closed_at=statement_timestamp(),legacy_fence_evidence_ref='CI SPIKE ONLY',
        approved_edge_release_sha=repeat('a',40),auth_contract_version=2,
        required_migrations=$1::jsonb,
        lane8_evidence_digest=repeat('d',64),measured_edge_release_sha=repeat('a',40),
        measured_edge_target='/home/commonswarm/edge/releases/'||repeat('a',40),
        measured_mount='/home/commonswarm/edge/releases/'||repeat('a',40),measured_artifact_digest=repeat('e',64),
        measured_image_digest='sha256:'||repeat('f',64),measured_generation=release_generation,
        measured_at=statement_timestamp(),measurement_evidence_ref='CI SPIKE ONLY',invalidated_at=NULL`, [JSON.stringify(hashes)]);
    }
    await client.query("SET LOCAL session_replication_role=origin");
  }

  let callback = provider.callback();
  // Cluster-admin setup stages/restores the gate transaction-locally ONLY.
  // Every application query runs under the D1 issuer session and local subrole;
  // production owns transaction control and never obtains setup privileges.
  const coordinatorPool = { connect: async () => {
    const owned = testRequests.getStore();
    const trace = { calls: [], writes: [], committed: false, phase: owned.phase, events: [],
      gate: { state: "not_reached", cause: null }, gateInputs: {
        envValuePresent: activationEnv.MCP_OAUTH_ADMIN_ISSUANCE_ENABLED != null ? "yes" : "no",
        coordinatorPresent: coordinator != null ? "yes" : "no", cutoverOpen: "no", measuredReleasePass: "no" } };
    traces.set(owned.id,trace);
    const physical = await pool.connect();
    const execute = physical.query.bind(physical);
    let identity;
    const raw = async (sql, values) => {
      // Include fixture BEGIN staging and COMMIT restoration, which previously
      // escaped the application-query catch. Read identity before failure can
      // abort the transaction; never query an aborted transaction for identity.
      if (sql === "BEGIN") identity = (await execute("SELECT current_user, current_setting('role') AS role")).rows[0];
      if (sql !== "ROLLBACK" && identity) trace.lastStatementIdentity = {
        current_user: safeRole(identity.current_user), role: safeRole(identity.role) };
      try {
        const result = await execute(sql, values);
        if (/^(?:SET LOCAL (?:ROLE|SESSION AUTHORIZATION)|RESET (?:ROLE|SESSION AUTHORIZATION))/u.test(sql)) {
          identity = (await execute("SELECT current_user, current_setting('role') AS role")).rows[0];
        }
        return result;
      }
      catch (error) {
        trace.failure ??= failureCode(error);
        trace.failureIdentity ??= trace.lastStatementIdentity;
        trace.failureRole ??= safeRole(identity?.current_user);
        trace.failureStatement ??= sql === "COMMIT" ? "physical_commit"
          : sql.includes("UPDATE commonswarm_oauth.admin_cutover_state") ? "fixture_cutover_write"
          : sql.includes("supabase_migrations.schema_migrations") ? "fixture_migration_ledger"
          : sql.includes("commonswarm_ops.migration_checksums") ? "fixture_checksum_evidence"
          : sql.includes("SESSION AUTHORIZATION") ? "fixture_session_principal"
          : sql.includes("FROM commonswarm_oauth.admin_cutover_state") ? "measured_release_read"
          : sql.includes("migration_checksum_failures()") ? "migration_checksum_read"
          : sql.includes("INSERT INTO commonswarm_oauth.admin_oauth_audit") ? "lifecycle_audit_insert"
          : sql.includes("record_admin_request_audit(") ? "authenticated_request_audit" : "other_statement";
        throw error;
      }
    };
    let original,originalChecksums,stagedLedgerVersions,role = "commonswarm_admin_issuer";
    return { processID: physical.processID, release: bad => physical.release(bad), async query(sql,values) {
      if (sql === "BEGIN") {
        const result = await raw(sql);
        original = (await raw(`SELECT * FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE`)).rows[0];
        assert.equal(original.admin_issuance_enabled,false);
        await gate({ query: raw });
        trace.gateInputs.cutoverOpen = "yes";
        // D2 checks the live ledger independently of checksum evidence. A
        // schema-only fixture has installed functions without ledger rows.
        // Add only absent reviewed versions, and remove only those before COMMIT.
        stagedLedgerVersions = (await raw(`INSERT INTO supabase_migrations.schema_migrations(version)
          SELECT unnest($1::text[]) ON CONFLICT(version) DO NOTHING RETURNING version`, [versions])).rows.map(row => row.version);
        await raw("SET LOCAL ROLE swarm_admin");
        originalChecksums=(await raw("SELECT * FROM commonswarm_ops.migration_checksums WHERE version=ANY($1::text[])",[versions])).rows;
        for (const version of versions) await raw(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha)
          VALUES($1,$2,'backfill',repeat('a',40)) ON CONFLICT(version) DO UPDATE SET sha256=EXCLUDED.sha256`, [version,hashes[version]]);
        await raw("RESET ROLE");
        await raw("SET LOCAL SESSION AUTHORIZATION commonswarm_admin_issuer");
        return result;
      }
      if (sql === "COMMIT") {
        await raw("RESET SESSION AUTHORIZATION");
        trace.commitStage = "fixture_cutover_restore";
        await gate({ query: raw },original);
        trace.commitStage = "fixture_ledger_restore";
        await raw("DELETE FROM supabase_migrations.schema_migrations WHERE version=ANY($1::text[])", [stagedLedgerVersions]);
        trace.commitStage = "fixture_checksum_restore";
        await raw("SET LOCAL ROLE swarm_admin");
        await raw("DELETE FROM commonswarm_ops.migration_checksums WHERE version=ANY($1::text[])",[versions]);
        for (const row of originalChecksums) await raw(`INSERT INTO commonswarm_ops.migration_checksums
          (version,sha256,applied_at,source,released_sha) VALUES($1,$2,$3,$4,$5)`,
          [row.version,row.sha256,row.applied_at,row.source,row.released_sha]);
        await raw("RESET ROLE");
        trace.commitStage = "fixture_commit_fault";
        if (owned.fault === "commit") await raw("SELECT 1/0").catch(() => {});
        trace.commitStage = "fixture_before_commit";
        if (owned.beforeCommit) await owned.beforeCommit();
        trace.commitStage = "physical_commit";
        const result = await raw(sql); trace.committed=result.command === "COMMIT";
        if (owned.fault === "commit-response-lost") throw Object.assign(new Error("test lost COMMIT acknowledgement"),{ code:"ECONNRESET" });
        return result;
      }
      let result;
      try {
        result = await raw(sql,values);
        const selected = /^SET LOCAL ROLE (commonswarm_oauth_runtime|swarm_command)$/u.exec(sql);
        if (selected) role = selected[1];
      } catch (error) {
        // Fixed labels only: never retain PostgreSQL messages, SQL or values.
        trace.failureStatement ??= sql.includes("FROM commonswarm_oauth.admin_cutover_state") ? "measured_release_read"
          : sql.includes("migration_checksum_failures()") ? "migration_checksum_read"
          : sql.includes("INSERT INTO commonswarm_oauth.admin_oauth_audit") ? "lifecycle_audit_insert"
          : sql.includes("record_admin_request_audit(") ? "authenticated_request_audit"
          : "other_statement";
        trace.failureRole ??= role;
        throw error;
      }
      if (!["ROLLBACK"].includes(sql) && !/^\s*(?:SET|SAVEPOINT|RELEASE)/iu.test(sql)) {
        const stamp=(await raw("SELECT txid_current()::text AS xid,pg_backend_pid() AS pid")).rows[0];
        trace.calls.push({ ...stamp,sql:sql.trim().split(/\s+/u).slice(0,3).join(" ") });
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql) || sql.includes("record_admin_request_audit(")) {
          trace.writes.push({ ...stamp });
          if (trace.writes.length === owned.after) throw new Error("test injected write failure");
        }
      }
      return result;
    } };
  } };
  const coordinator = new AdminTransactionCoordinator(coordinatorPool,
    { adminIssuanceEnabled: activationEnv.MCP_OAUTH_ADMIN_ISSUANCE_ENABLED === "1" });
  const server = createServer(async (request,response) => {
    const id=request.headers["x-spike-id"],owned={ id,...controls.get(id) };
    const path = new URL(request.url, ISSUER).pathname;
    owned.phase = path === "/authorize" ? "authorize" : path.startsWith("/authorize/") ? "resume"
      : path.startsWith("/interaction/") ? "interaction" : path === "/token" ? "token" : "revoke";
    try {
      let proof;
      if (owned.body && new URL(request.url,ISSUER).pathname === "/token") {
        const model=owned.body.grant_type === "refresh_token" ? "RefreshToken" : "AuthorizationCode";
        const tokenId=model === "RefreshToken" ? owned.body.refresh_token : owned.body.code;
        const artifact=(await pool.query(`SELECT a.*,to_jsonb(b) AS binding FROM commonswarm_oauth.provider_artifacts a
          JOIN commonswarm_oauth.admin_grant_bindings b ON b.provider_grant_id=a.grant_id
          WHERE model=$1 AND artifact_id_hash=$2`,[model,digest(tokenId).toString("base64url")])).rows[0];
        owned.ingress={ binding:artifact.binding,hash:artifact.artifact_id_hash,model,consumed_at:artifact.consumed_at,
          generation:Number(artifact.payload.rotations ?? 0) };
        controls.set(id,owned);
        if (owned.afterIngress) await owned.afterIngress();
        proof=await admitAdminProof(proofPool,await verifyAdminProof(request,jkt));
      }
      const outcome = await testRequests.run(owned,()=>coordinator.run(response,async scope=>{
        try {
        scope.fault=owned.fault; traces.get(id).pending=scope.pending;
        // Prove the OPEN-path fixture's complete measurement/ledger predicate
        // before provider scope filtering can turn a gate failure into a 4xx.
        const trace = traces.get(id);
        trace.gate.state = await effectiveAdminGate({ onRefusal: code => { trace.gate.cause = code; } });
        const measured = await requireMeasuredAdminRelease();
        trace.gateInputs.cutoverOpen = measured.admin_issuance_enabled && measured.legacy_closed ? "yes" : "no";
        trace.gateInputs.measuredReleasePass = "yes";
        assert.equal(trace.gate.state, "open", "the atomic fixture must exercise the effective OPEN gate");
        if (request.url === "/test-revoke") {
          const binding=(await db.pool.query(`SELECT * FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=$1`,[family])).rows[0];
          await lifecycle.revokeFamily(binding); response.statusCode=204; response.end();
        } else if (request.url.startsWith("/interaction/")) {
          const details = await provider.interactionDetails(request, response);
          if (details.prompt.name === "login") {
            traces.get(id).phase = "login";
            await provider.interactionFinished(request, response, { login: { accountId: owner } });
          } else if (request.method === "GET") {
            traces.get(id).phase = "consent-selection";
            await base.bindInteraction({ interactionUid: details.uid, sessionId, userId: owner, clientId,
              redirectUri, resource: ADMIN, scopes: details.params.scope.split(" "), pkceChallenge: challenge,
              oauthState: details.params.state });
            const csrf = await base.issueConsentToken(details.uid, sessionId, owner);
            const input = { uid: details.uid, sessionId, ownerUserId: owner, params: details.params,
              csrfToken: csrf.token, version: csrf.selectionVersion };
            const selected = await service.select(input, { mode: "granular", scope_names: ["admin:read"],
              workspace_ids: [], expires_at: new Date(Date.now() + consentLifetimeMs).toISOString() });
            pendingConsent = { input: { ...input, version: 1, csrfToken: selected.summary.token },
              completion: { summary_digest: selected.summary.digest } };
            response.statusCode = 204; response.end();
          } else {
            traces.get(id).phase = "consent-confirmation";
            const grantId = await service.confirm(pendingConsent.input, pendingConsent.completion);
            await provider.interactionFinished(request, response, { consent: { grantId } });
          }
        } else {
          const path = new URL(request.url,ISSUER).pathname;
          if (path === "/token") {
            const form = controls.get(id).body;
            const prepared = await lifecycle.prepareToken(controls.get(id).ingress,form);
            if (prepared.replay) { response.statusCode=400; response.end('{"error":"invalid_grant"}'); return; }
          } else if (path.startsWith("/authorize/") && family) {
            const uid = decodeURIComponent(path.split("/")[2]);
            const candidate = (await db.pool.query(`SELECT * FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=$1`, [family])).rows[0];
            await lifecycle.prepareContinuation(candidate,uid);
          }
          await callback(request,response);
          await lifecycle.finishContinuation();
        }
        } catch (error) {
          traces.get(id).failure = failureCode(error);
          traces.get(id).events.push(eventDiagnostic("interaction.error", error));
          throw error;
        } finally {
          traces.get(id).providerResponse ??= responseDiagnostic(response.statusCode, undefined, response.getHeader("location"));
        }
      },{ kind:proof ? "token" : "human",owner,proof,sessionHash:hashOpaque(sessionId) }));
      const trace = traces.get(id);
      trace.outcome = outcome.outcome;
      if (outcome.cause) {
        trace.failure ??= failureCode(outcome.cause);
        trace.failureStatement ??= trace.commitStage ?? "coordinator_refusal";
      }
    } catch (error) {
      const trace = traces.get(id) ?? { phase: owned.phase, events: [] };
      traces.set(id, trace);
      trace.failure ??= failureCode(error);
      trace.events.push(eventDiagnostic("ingress.error", error));
      response.statusCode=503; response.end('{"error":"temporarily_unavailable"}');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, cookies = new Map(), responseHistory = [];
  async function request(url, { method = "GET", body, after, fault, beforeCommit, afterIngress, proofOverride } = {}) {
    const external = new URL(url, ISSUER), id = randomUUID();
    controls.set(id, { beforeCommit, afterIngress, body, fault, after });
    const headers = { host: new URL(ISSUER).host, "x-forwarded-host": new URL(ISSUER).host,
      "x-forwarded-proto": "https", accept: "application/json", "x-spike-id": id,
      "x-spike-after": String(after ?? 0), "x-spike-fault": fault ?? "" };
    if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (external.pathname === "/token") {
        // Nonces have bounded DB lifetime; refresh only test-owned material.
        if (Date.now()>=proofNonceRenewAt) {
          const nextNonce=randomBytes(32).toString("base64url");proofNonceRenewAt=Date.now()+45000;
          nonceRenewal=pool.query(`SELECT commonswarm_oauth.register_dpop_nonce($1,$2,'as') AS accepted`,[digest(nextNonce),jkt])
            .then(result=>{assert.equal(result.rows[0].accepted,true);proofNonce=nextNonce;});
        }
        await nonceRenewal;const requestNonce=proofNonce;
        headers.dpop = proofOverride ?? await new SignJWT({ htm: "POST", htu: `${ISSUER}/token`, nonce: requestNonce })
        .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
        .setJti(randomUUID()).setIssuedAt().sign(key.privateKey);
      }
    }
    const response = await fetch(new URL(external.pathname + external.search, origin),
      { method, headers, body: body ? new URLSearchParams(body) : undefined, redirect: "manual" });
    const trace = traces.get(id);
    if (trace) trace.httpResponse = responseDiagnostic(response.status,
      response.status >= 400 ? await response.clone().text() : undefined, response.headers.get("location"));
    const step = httpStepDiagnostic(responseHistory.length + 1, method, trace);
    responseHistory.push(step);
    trace.httpSteps = responseHistory.slice();
    console.info(`admin atomic HTTP: ${JSON.stringify(step)}`);
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
      VALUES($1::uuid,1,$2,'approval',jsonb_build_object('stream_kind','account','owner_user_id',$1::text,'seq',1,
        'type','AdminClientApproved','actor_user',$1::text,'payload',jsonb_build_object('client_id',$3::text,'verification_version',1)))`,
    [owner, approvalEvent, clientId]);
    await setup.query(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,
      approval_event_id,approval_command_id) VALUES($1,$2,1,$3,'approval')`, [owner, clientId, approvalEvent]);
    // Exercise the shared manifest builder here too, not copied capability names.
    assert.ok(createAdminManifest({ mode: "granular", scope_names: ["admin:read"], workspace_ids: [] },
      { resourceScopes: ["admin:read"], verification: { client_id: clientId } }));
    const setupStore=new InteractionStore({ query:(...args)=>setup.query(...args) });
    sessionId=await setupStore.createSession();
    await setup.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,authenticated_at=statement_timestamp()
      WHERE session_hash=$2`,[owner,hashOpaque(sessionId)]);
    await setup.query(`SELECT commonswarm_oauth.register_dpop_nonce($1,$2,'as')`,[digest(proofNonce),jkt]);
    await setup.query("COMMIT");
    cookies.set(SESSION_COOKIE, sessionId);
  } catch (error) { await setup.query("ROLLBACK"); setupError = error; }
  finally { setup.release(); }
  if (setupError) {
    await new Promise(resolve => server.close(resolve)); await proofPool.end(); await pool.end(); throw setupError;
  }

  async function snapshot() {
    const tables = ["swarm.admin_accounts", "swarm.admin_grants", "swarm.admin_consents", "swarm.admin_events",
      "commonswarm_oauth.admin_grant_bindings", "commonswarm_oauth.provider_grant_resources",
      "commonswarm_oauth.admin_oauth_audit",
      "commonswarm_oauth.admin_interactions", "commonswarm_oauth.interactions", "commonswarm_oauth.browser_sessions"];
    const result = [];
    for (const table of tables) result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows
      FROM ${table} t WHERE ${["commonswarm_oauth.interactions","commonswarm_oauth.browser_sessions"].includes(table) ? "user_id" : "owner_user_id"}=$1`, [owner])).rows[0].rows);
    result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY access_jti),'[]') AS rows
      FROM commonswarm_oauth.admin_access_issuances t WHERE provider_grant_id IN
      (SELECT provider_grant_id FROM commonswarm_oauth.admin_grant_bindings WHERE owner_user_id=$1)`, [owner])).rows[0].rows);
    result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY artifact_id_hash),'[]') AS rows
      FROM commonswarm_oauth.provider_artifacts t WHERE payload->>'clientId'=$1 OR payload->>'accountId'=$2
        OR payload->>'iss'=$1`, [clientId, owner])).rows[0].rows);
    result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY grant_id),'[]') AS rows
      FROM commonswarm_oauth.refresh_family_tombstones t WHERE grant_id IN
      (SELECT provider_grant_id FROM commonswarm_oauth.admin_grant_bindings WHERE owner_user_id=$1)`,[owner])).rows[0].rows);
    result.push((await pool.query(`SELECT to_jsonb(t) AS gate FROM commonswarm_oauth.admin_cutover_state t WHERE singleton`)).rows[0].gate);
    for (const table of ["supabase_migrations.schema_migrations", "commonswarm_ops.migration_checksums"]) {
      result.push((await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]') AS rows
        FROM ${table} t WHERE version=ANY($1::text[])`, [versions])).rows[0].rows);
    }
    // A failing assertion must not dump provider/session artifact payloads.
    return digest(JSON.stringify(result)).toString("hex");
  }
  return { pool, proofPool, owner, clientId, jkt, request, snapshot, traces,
    signProof: async claims => new SignJWT({htm:"POST",htu:`${ISSUER}/token`,...claims})
      .setProtectedHeader({typ:"dpop+jwt",alg:"ES256",jwk:publicJwk}).setIssuedAt(claims.iat ?? Math.floor(Date.now()/1000)).setJti(claims.jti ?? randomUUID()).sign(key.privateKey),
    family: () => family,
    async restartProvider() {
      provider=await createMcpProvider({adapter:createPostgresAdapter(db.pool),jwks:{keys:[jwk]},activeSigningKid:jwk.kid,
        registrationEnabled:false,registrationStore:{find:async id=>id===clientId ? metadata:undefined,markUsed:async()=>{}},
        providerGrantResource:async id=>(await db.pool.query(`SELECT resource FROM commonswarm_oauth.provider_grant_resources
          WHERE provider_grant_id=$1`,[id])).rows[0]?.resource});
      subscribeDiagnostics(provider);callback=provider.callback();
    },
    consent: () => pendingConsent,
    async close() { await new Promise(resolve => server.close(resolve)); await proofPool.end(); await pool.end(); } };
}

function atomic(trace) {
  if (!trace.committed) console.error(`admin atomic refusal: ${atomicDiagnostic(trace)}`);
  assert.equal(trace.committed, true, atomicDiagnostic(trace));
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
        assert.ok([302, 303].includes(result.response.status), atomicDiagnostic(result.trace));
        current = new URL(result.response.headers.get("location"), ISSUER);
      }
      assert.ok(consentUrl, "real provider must reach lane-3a selection");

      async function proveUnit(name, url, options, expected, concurrent = false) {
        const baseline = await f.snapshot();
        // First explore the real write count in a forced-rollback control.
        const probe = await f.request(url, { ...options, fault: "commit" });
        assert.equal(probe.response.status, 503, atomicDiagnostic(probe.trace));
        assert.equal(await f.snapshot(), baseline, "failed COMMIT must restore every owned row");
        assert.ok(probe.trace.writes.length > 0);
        const count = probe.trace.writes.length;
        for (let after = 1; after <= count; after++) await t.test(`${name}: rollback after write ${after}`, async () => {
          const failed = await f.request(url, { ...options, after });
          assert.equal(failed.response.status, 503, atomicDiagnostic(failed.trace));
          assert.equal(failed.trace.writes.length, after, "fault must reach the intended write");
          assert.equal(failed.trace.committed, false);
          assert.equal(await f.snapshot(), baseline, "no artifact/consume/authority/audit may survive alone");
          const denied = await failed.response.json();
          assert.ok(!("access_token" in denied) && !("refresh_token" in denied), "error response contains no token fields");
          assert.ok(failed.response.headers.get("location") === null, "no code/continuation redirect leaks");
        });
        if (url === "/token") {
          const failed = await f.request(url, { ...options, fault: "signing" });
          assert.equal(failed.response.status, 503, atomicDiagnostic(failed.trace));
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
        await Promise.race([atCommit, operation.then(result => {
          throw new Error(`positive path missed commit barrier: ${atomicDiagnostic(result.trace)}`);
        })]);
        let duplicate;
        try {
          if (concurrent) {
            let enteredIngress;
            const atIngress = new Promise(resolve => { enteredIngress=resolve; });
            duplicate=f.request(url,{ ...options,afterIngress:async()=>enteredIngress() });
            if (url === "/token") await atIngress;
          }
          assert.equal(delivered, false, "HTTP client receives no headers/body before COMMIT");
          assert.equal(await f.snapshot(), baseline, "independent backend sees no staged changes before COMMIT");
        } finally { unblock(); }
        const good = await operation;
        assert.equal(good.response.status, expected, atomicDiagnostic(good.trace)); atomic(good.trace);
        assert.equal(good.trace.writes.length, count);
        if (duplicate) {
          const loser=await duplicate;
          assert.ok([400,503].includes(loser.response.status),atomicDiagnostic(loser.trace));
          assert.equal(loser.trace.committed,false,"overlapping loser cannot commit a replay fence");
          const denied=await loser.response.json();
          assert.ok(!("access_token" in denied) && !("refresh_token" in denied));
          assert.equal((await f.pool.query(`SELECT state FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=$1`,[f.family()])).rows[0].state,"active");
        }
        return good;
      }
      const finished = await proveUnit("consent finish", consentUrl, { method: "POST", body: {} }, 303,true);
      const continued = await proveUnit("authorization continuation", finished.response.headers.get("location"), {}, 303);
      const code = new URL(continued.response.headers.get("location")).searchParams.get("code");
      assert.equal(typeof code, "string");
      const exchanged = await proveUnit("code exchange", "/token", { method: "POST", body: {
        client_id: f.clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, resource: ADMIN } }, 200,true);
      const initial = await exchanged.response.json();
      assert.equal(initial.token_type, "DPoP"); assert.equal(typeof initial.refresh_token, "string");
      const rotated = await proveUnit("refresh", "/token", { method: "POST", body: {
        client_id: f.clientId, grant_type: "refresh_token", refresh_token: initial.refresh_token, resource: ADMIN } }, 200,true);
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
      await t.test("admin-refresh-consent-deadline: provider restart rotates the durable family without renewing deadlines or budgets",async()=>{
        const prior=(await f.pool.query(`SELECT b.expires_at,b.refresh_deadline,g.issuance_limits,g.renewal_limits,a.projection->'routine' AS routine
          FROM commonswarm_oauth.admin_grant_bindings b JOIN swarm.admin_grants g ON g.grant_id=b.admin_grant_id
          JOIN swarm.admin_accounts a ON a.owner_user_id=b.owner_user_id WHERE b.provider_grant_id=$1`,[f.family()])).rows[0];
        await f.restartProvider();
        const resumed=await f.request("/token",{method:"POST",body:refreshBody(f,successor.refresh_token)});
        assert.equal(resumed.response.status,200,atomicDiagnostic(resumed.trace));atomic(resumed.trace);
        const fresh=await resumed.response.json(),claims=decodeJwt(fresh.access_token);
        assert.ok(claims.exp*1000<=new Date(prior.expires_at).getTime());
        const after=(await f.pool.query(`SELECT b.expires_at,b.refresh_deadline,g.issuance_limits,g.renewal_limits,a.projection->'routine' AS routine
          FROM commonswarm_oauth.admin_grant_bindings b JOIN swarm.admin_grants g ON g.grant_id=b.admin_grant_id
          JOIN swarm.admin_accounts a ON a.owner_user_id=b.owner_user_id WHERE b.provider_grant_id=$1`,[f.family()])).rows[0];
        assert.deepEqual(after,prior);
      });
      await t.test("admin-revoke-family-atomic: every write rolls back; positive human revoke fences the family",async()=>{
        const revoked=await proveUnit("human revoke","/test-revoke",{},204);
        atomic(revoked.trace);
        const state=(await f.pool.query(`SELECT b.state,g.state AS authority,
          EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones t WHERE t.grant_id=b.provider_grant_id) AS fenced
          FROM commonswarm_oauth.admin_grant_bindings b JOIN swarm.admin_grants g ON g.grant_id=b.admin_grant_id
          WHERE b.provider_grant_id=$1`,[f.family()])).rows[0];
        assert.deepEqual(state,{state:"revoked",authority:"revoked",fenced:true});
        const coordinator=new AdminTransactionCoordinator(f.proofPool);
        const server=createServer((_request,response)=>coordinator.run(response,async()=>{
          await createPostgresAdapter(scopedAdminPool())("RefreshToken").upsert("test-resurrection",{
            grantId:f.family(),accountId:f.owner,clientId:f.clientId,resource:ADMIN,jkt:f.jkt},300);
          response.statusCode=204;response.end();
        }));
        await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
        try {assert.equal((await fetch(`http://127.0.0.1:${server.address().port}`)).status,400);}
        finally {await new Promise(resolve=>server.close(resolve));}
        assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM commonswarm_oauth.provider_artifacts
          WHERE model='RefreshToken' AND artifact_id_hash=$1`,[digest("test-resurrection").toString("base64url")])).rows[0].n,0);

        assert.equal((await f.request("/token",{method:"POST",body:{client_id:f.clientId,grant_type:"refresh_token",
          refresh_token:successor.refresh_token,resource:ADMIN}})).response.status,400);
      });
      assert.equal((await f.pool.query(`SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state`)).rows[0].admin_issuance_enabled, false);
    } finally { await f.close(); }
  });

async function freshCode(f) {
  const authorize=new URL("/authorize",ISSUER);
  for (const [name,value] of Object.entries({client_id:f.clientId,redirect_uri:redirectUri,response_type:"code",
    scope:"openid offline_access admin:read",prompt:"consent",resource:ADMIN,code_challenge:challenge,
    code_challenge_method:"S256",dpop_jkt:f.jkt,state:randomUUID()})) authorize.searchParams.set(name,value);
  let current=authorize;
  for (let step=0;step<10;step++) {
    const {response,trace}=await f.request(current); atomic(trace);
    if (response.status === 204) {
      const finished=await f.request(current,{method:"POST",body:{}}); assert.equal(finished.response.status,303,atomicDiagnostic(finished.trace));atomic(finished.trace);
      const continued=await f.request(finished.response.headers.get("location"));assert.equal(continued.response.status,303,atomicDiagnostic(continued.trace));atomic(continued.trace);
      return new URL(continued.response.headers.get("location")).searchParams.get("code");
    }
    assert.ok([302,303].includes(response.status),atomicDiagnostic(trace)); current=new URL(response.headers.get("location"),ISSUER);
  }
  throw new Error("real provider did not reach consent");
}
const codeBody=(f,code)=>({client_id:f.clientId,grant_type:"authorization_code",code,
  code_verifier:verifier,redirect_uri:redirectUri,resource:ADMIN});
const refreshBody=(f,token)=>({client_id:f.clientId,grant_type:"refresh_token",refresh_token:token,resource:ADMIN});

test("admin-atomic-provider-transaction: genuine D1 login isolates two overlapping real HTTP/pg units; absent ALS refuses",async()=>{
  const f=await fixture();
  const coordinator=new AdminTransactionCoordinator(f.proofPool), seen=[];
  let entered,unblock;
  const bothEntered=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{unblock=resolve;});
  const server=createServer((_request,response)=>coordinator.run(response,async scope=>{
    const stamp=(await adminQuery("SELECT session_user AS principal,current_user AS role,pg_backend_pid() AS pid,txid_current()::text AS xid")).rows[0];
    seen.push({...stamp,id:scope.requestId}); if(seen.length===2) entered();
    await barrier;
    await withAdminRole("swarm_command",()=>adminQuery("SELECT 1 FROM swarm.admin_accounts WHERE owner_user_id=$1",[f.owner]));
    if (_request.url === "/rollback") throw new Error("test rollback after authority role");
    response.statusCode=204;response.end();
  }));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    assert.throws(()=>adminQuery("SELECT 1"),{code:"admin_transaction_required"});
    const operations=[fetch(`http://127.0.0.1:${server.address().port}`),fetch(`http://127.0.0.1:${server.address().port}`)];
    await Promise.race([bothEntered,Promise.all(operations).then(()=>{throw new Error("requests failed before overlap");})]);
    assert.equal(new Set(seen.map(x=>x.pid)).size,2);assert.equal(new Set(seen.map(x=>x.xid)).size,2);
    assert.equal(new Set(seen.map(x=>x.id)).size,2);
    assert.ok(seen.every(x=>x.principal==="commonswarm_admin_issuer" && x.role==="commonswarm_oauth_runtime"));
    unblock(); assert.deepEqual((await Promise.all(operations)).map(x=>x.status),[204,204]);
    async function assertIssuerRestored() {
      const clients=[];
      try {
        // Hold both so the pool cannot hand us the same idle connection twice.
        for (let i=0;i<2;i++) clients.push(await f.proofPool.connect());
        for (const client of clients) {
          const {rows}=await client.query("SELECT session_user AS principal,current_user AS role");
          assert.equal(rows[0].principal,"commonswarm_admin_issuer");
          assert.equal(rows[0].role,"commonswarm_admin_issuer","transaction-local authority role must not leak into the pool");
        }
      } finally {for (const client of clients) client.release();}
    }
    await assertIssuerRestored();
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/rollback`)).status,503);
    await assertIssuerRestored();
  } finally {unblock();await new Promise(resolve=>server.close(resolve));await f.close();}
});

test("admin-atomic-provider-transaction: sequential replay commits its fence on invalid_grant; lost COMMIT acknowledgement never reissues",{timeout:120000},async()=>{
  const f=await fixture({consentLifetimeMs:120000});
  try {
    const code=await freshCode(f);
    const issued=await f.request("/token",{method:"POST",body:codeBody(f,code)});assert.equal(issued.response.status,200,atomicDiagnostic(issued.trace));atomic(issued.trace);
    const initial=await issued.response.json();
    const initialClaims=decodeJwt(initial.access_token);
    assert.ok(initialClaims.exp-initialClaims.iat<=120,"production provider clips a short consent TTL");
    const expanded=await f.request("/token",{method:"POST",body:{...refreshBody(f,initial.refresh_token),scope:"admin:read workspaces:create"}});
    assert.equal(expanded.response.status,400,atomicDiagnostic(expanded.trace));assert.equal((await expanded.response.json()).error,"invalid_scope");
    const rotated=await f.request("/token",{method:"POST",body:refreshBody(f,initial.refresh_token)});assert.equal(rotated.response.status,200,atomicDiagnostic(rotated.trace));atomic(rotated.trace);
    const successor=await rotated.response.json();
    assert.ok(decodeJwt(successor.access_token).exp<=initialClaims.exp,"refresh keeps the absolute consent expiry");
    const replay=await f.request("/token",{method:"POST",body:refreshBody(f,initial.refresh_token)});
    assert.equal(replay.response.status,400,atomicDiagnostic(replay.trace));assert.equal((await replay.response.json()).error,"invalid_grant");atomic(replay.trace);
    assert.equal((await f.pool.query(`SELECT state FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=$1`,[f.family()])).rows[0].state,"revoked");
    assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=$1`,[f.family()])).rows[0].n,1);
    assert.equal((await f.request("/token",{method:"POST",body:refreshBody(f,successor.refresh_token)})).response.status,400);
    const newCode=await freshCode(f);
    const before=(await f.pool.query("SELECT count(*)::int AS n FROM commonswarm_oauth.admin_access_issuances WHERE provider_grant_id=$1",[f.family()])).rows[0].n;
    const lost=await f.request("/token",{method:"POST",body:codeBody(f,newCode),fault:"commit-response-lost"});
    assert.equal(lost.response.status,503,atomicDiagnostic(lost.trace));assert.equal(lost.trace.committed,true);
    const denied=await lost.response.json();assert.equal(denied.error,"issuance_outcome_unknown");
    assert.ok(!("access_token" in denied) && !("refresh_token" in denied));
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM commonswarm_oauth.admin_access_issuances WHERE provider_grant_id=$1",[f.family()])).rows[0].n,before+1);
    const retry=await f.request("/token",{method:"POST",body:codeBody(f,newCode)});assert.equal(retry.response.status,400,atomicDiagnostic(retry.trace));
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM commonswarm_oauth.admin_access_issuances WHERE provider_grant_id=$1",[f.family()])).rows[0].n,before+1);
    // The real adapter cannot read or mutate this admin artifact without ALS.
    const outside=createPostgresAdapter(f.pool)("AuthorizationCode");
    await assert.rejects(()=>outside.find(newCode),{code:"admin_transaction_required"});
    await assert.rejects(()=>outside.consume(newCode),{code:"admin_transaction_required"});
  } finally {await f.close();}
});

test("as-dpop-required: real D1 admission challenges, accepts once, survives issuance rollback and refuses replay/stale",async()=>{
  const f=await fixture();
  try {
    const request=proof=>({method:"POST",headers:{dpop:proof},rawHeaders:["DPoP",proof]});
    const missingNonce=await verifyAdminProof(request(await f.signProof({})),f.jkt);
    let challenge;
    await assert.rejects(()=>admitAdminProof(f.proofPool,missingNonce),error=>{
      challenge=error.nonce;return error.code==="use_dpop_nonce" && typeof challenge==="string";
    });
    const verified=await verifyAdminProof(request(await f.signProof({nonce:challenge})),f.jkt);
    await admitAdminProof(f.proofPool,verified);
    // Issuance rollback on a different physical connection cannot refund admission.
    const coordinator=new AdminTransactionCoordinator(f.proofPool);
    const server=createServer((_request,response)=>coordinator.run(response,async()=>{
      await adminQuery("SELECT 1");throw new Error("test issuance rollback");
    },{kind:"token",owner:f.owner,proof:verified}));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try {assert.equal((await fetch(`http://127.0.0.1:${server.address().port}`)).status,503);}
    finally {await new Promise(resolve=>server.close(resolve));}
    await assert.rejects(()=>admitAdminProof(f.proofPool,verified),{code:"invalid_dpop_proof"});
    const stale=await verifyAdminProof(request(await f.signProof({nonce:challenge,iat:1})),f.jkt);
    await assert.rejects(()=>admitAdminProof(f.proofPool,stale),{code:"invalid_dpop_proof"});
  } finally {await f.close();}
});
