import assert from "node:assert/strict";
import { test } from "node:test";
import instance from "oidc-provider/lib/helpers/weak_cache.js";
import { adminDigest, createAdminConsentService } from "../src/admin-consent.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
import { AdminTransactionCoordinator } from "../src/admin-transaction.js";
import { createMcpProvider, RESOURCE } from "../src/provider.js";

const OWNER = "10000000-0000-4000-8000-000000000001";
const CLIENT = "https://client.example/oauth.json";
const DOCUMENT = {
  client_id: CLIENT, application_type: "web", client_name: "Reviewed client",
  redirect_uris: ["https://client.example/callback"], dpop_signing_alg: "ES256",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "none", review_extension: { purpose: "admin", version: 1 },
};

async function fixture() {
  const state = { document: structuredClone(DOCUMENT), failure: null, freshFetches: 0, cacheFetches: 0 };
  const fetchMetadata = async () => {
    state.freshFetches++;
    if (state.failure) return state.failure();
    return new Response(JSON.stringify(state.document), { headers: { "content-type": "application/json" } });
  };
  const provider = await createMcpProvider({
    // The provider's ordinary CIMD transport can retain an older document.
    metadataFetch: async () => {
      state.cacheFetches++;
      return new Response(JSON.stringify(DOCUMENT), { headers: { "content-type": "application/json" } });
    },
    fetch: fetchMetadata,
  });
  const client = await provider.Client.find(CLIENT);
  assert.equal(client.clientIdMetadataDocument, true);
  assert.equal(client.metadata().scope, "openid offline_access mcp");
  assert.equal(client.metadata().id_token_signed_response_alg, "ES256");
  assert.equal(client.metadata().review_extension, undefined, "provider drops unknown document fields");

  // Operator verification pins the fetched document; owner approval pins its version.
  const verification = {
    client_id: CLIENT, verification_version: 1, application_type: "web", registration_source: "cimd",
    active: true, withdrawn_at: null, metadata_digest: adminDigest(DOCUMENT),
    redirect_uris: DOCUMENT.redirect_uris, scope_ceiling: ["admin:read"],
    publisher_identity: "Reviewed publisher", publisher_contact: "publisher@example.test",
    review_evidence_ref: "reviewed-origin-and-flow", pkce_s256_tested: true, dpop_tested: true,
    redirect_tested: true, origin_control_verified: true, delegation_eligible: false, native_loopback_eligible: false,
  };
  const approval = { owner_user_id: OWNER, client_id: CLIENT, verification_version: 1,
    approval_event_id: "owner-event", approval_command_id: "owner-command", withdrawn_at: null };
  const store = {
    transaction: callback => callback({}),
    session: async () => ({ user_id: OWNER, authenticated_at: new Date() }),
    clientPolicy: async () => ({ verification, approval, registered: false }),
    load: async () => ({ parent: { user_id: OWNER }, receipt: null }),
  };
  const service = createAdminConsentService({ store, provider, fetchMetadata });
  const consent = () => service.view({ uid: "metadata-review", sessionId: "session", ownerUserId: OWNER,
    params: { client_id: CLIENT, redirect_uri: DOCUMENT.redirect_uris[0], resource: ADMIN_RESOURCE,
      scope: "openid offline_access admin:read", code_challenge_method: "S256",
      code_challenge: "a".repeat(43), dpop_jkt: "b".repeat(43) } });

  // Supply durable read rows only. Production gate, transaction coordinator and
  // the actual configured provider resource callback decide whether to authorize.
  const sha = "a".repeat(40), target = `/home/commonswarm/edge/releases/${sha}`;
  const measured = { admin_issuance_enabled: true, legacy_closed: true, auth_contract_version: 2,
    lane8_evidence_digest: "d".repeat(64), measurement_evidence_ref: "reviewed-step", measured_at: new Date(),
    approved_edge_release_sha: sha, measured_edge_release_sha: sha, measured_edge_target: target,
    measured_mount: target, measured_generation: 1, release_generation: 1,
    measured_artifact_digest: "e".repeat(64), measured_image_digest: `sha256:${"f".repeat(64)}` };
  const coordinator = new AdminTransactionCoordinator({ connect: async () => ({
    query: async sql => {
      if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (sql.includes("admin_cutover_state")) return { rows: [measured] };
      if (sql.includes("admin_verified_clients")) return { rows: [verification] };
      if (sql.includes("clock_timestamp")) return { rows: [{ now: Math.floor(Date.now() / 1000) }] };
      return { command: sql, rows: [], rowCount: 0 };
    }, release() {},
  }) }, { adminIssuanceEnabled: true });
  const resourceInfo = instance(provider).configuration.features.resourceIndicators.getResourceServerInfo;
  async function resource(resource = ADMIN_RESOURCE) {
    const headers = new Map();
    const response = { statusCode: 200, headersSent: false, destroyed: false,
      setHeader: (key, value) => headers.set(key, value), getHeaderNames: () => [...headers.keys()],
      removeHeader: key => headers.delete(key), writeHead() {}, write() {}, end() {}, flushHeaders() {} };
    let info, error;
    const outcome = await coordinator.run(response, async () => {
      try { info = await resourceInfo({ path: "/authorize" }, resource, client); }
      catch (caught) { error = caught; throw caught; }
      response.end();
    });
    if (error) throw error;
    assert.equal(outcome.outcome, "committed");
    return info;
  }
  return { state, verification, approval, consent, resource };
}

test("admin metadata digest: the same reviewed document passes consent and resource authorization despite provider defaults", async () => {
  const f = await fixture();
  assert.equal((await f.consent()).policy.verification.metadata_digest, f.verification.metadata_digest);
  assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
  assert.equal(f.state.freshFetches, 2, "each admin checkpoint must fetch the current document");
  assert.equal(f.state.cacheFetches, 1);
});

test("admin metadata digest: reordered document keys remain approved at both checkpoints", async () => {
  const f = await fixture();
  f.state.document = Object.fromEntries(Object.entries(DOCUMENT).reverse());
  f.state.document.review_extension = { version: 1, purpose: "admin" };
  await f.consent();
  assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
});

test("admin metadata digest: a freshly reviewed document cannot authorize different cached redirect behavior", async () => {
  const f = await fixture();
  await f.consent();
  assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
  f.state.document.redirect_uris = ["https://client.example/new-callback"];
  f.verification.redirect_uris = f.state.document.redirect_uris;
  f.verification.metadata_digest = adminDigest(f.state.document);
  await assert.rejects(f.consent(), { code: "unauthorized_client" });
  await assert.rejects(f.resource(), { error: "invalid_target" });
});

test("admin metadata digest: changed fields require new verification and owner reapproval at both checkpoints", async t => {
  for (const [name, change] of [
    ["display name", doc => { doc.client_name = "Changed client"; }],
    ["provider-discarded extension", doc => { doc.review_extension.version = 2; }],
    ["explicit provider default", doc => { doc.scope = "openid offline_access mcp"; }],
  ]) await t.test(name, async () => {
    const f = await fixture();
    await f.consent();
    assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
    change(f.state.document);
    await assert.rejects(f.consent(), { code: "unauthorized_client" });
    await assert.rejects(f.resource(), { error: "invalid_target" });
    // Updating the reviewed pin/version cannot reuse the old account approval.
    f.verification.metadata_digest = adminDigest(f.state.document);
    f.verification.verification_version++;
    await assert.rejects(f.consent(), { code: "unauthorized_client" });
    f.approval.verification_version = f.verification.verification_version;
    await f.consent();
    assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
  });
});

test("admin metadata digest: unavailable or invalid fresh metadata refuses both checkpoints while ordinary MCP stays available", async t => {
  for (const [name, failure] of [
    ["HTTP failure", () => new Response("unavailable", { status: 503 })],
    ["invalid JSON", () => new Response("not JSON")],
    ["transport failure", () => { throw new Error("network unavailable"); }],
  ]) await t.test(name, async () => {
    const f = await fixture();
    await f.consent();
    assert.equal((await f.resource()).audience, ADMIN_RESOURCE);
    f.state.failure = failure;
    await assert.rejects(f.consent(), { code: "unauthorized_client" });
    await assert.rejects(f.resource(), { error: "invalid_target" });
    assert.equal((await f.resource(RESOURCE)).audience, RESOURCE);
  });
});
