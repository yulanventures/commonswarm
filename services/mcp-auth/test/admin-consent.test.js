import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { hashOpaque } from "../src/browser-security.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createAdminInteractionHandler, createResourceInteractionHandler } from "../src/admin-interactions.js";
import { adminDigest, createAdminConsentService } from "../src/admin-consent.js";
import { renderAdminConsentPage } from "../src/admin-interaction-page.js";
import { AdminTransactionCoordinator } from "../src/admin-transaction.js";

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "10000000-0000-4000-8000-000000000002";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ADMIN = "https://api.commonswarm.com/admin";
const MCP = "https://mcp.commonswarm.com/mcp";
const CLIENT = "https://client.example/oauth.json";
const SESSION = "browser-session-that-is-long-enough";
const CSRF = "csrf-token-that-is-long-enough";
const ORIGIN = "https://mcp.commonswarm.com";

function response() {
  return { status: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body = "") { this.body += body; } };
}
function request(method = "GET", body, headers = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.headers = { cookie: `__Host-cswarm-oauth=${SESSION}`, origin: ORIGIN,
    "content-type": "application/json", "x-cswarm-csrf": CSRF, ...headers };
  return req;
}
function url(operation = "") { return new URL(`${ORIGIN}/interaction/admin-test${operation}`); }

const measuredRelease = {
  admin_issuance_enabled: true, legacy_closed: true, auth_contract_version: 2,
  lane8_evidence_digest: "d".repeat(64), measurement_evidence_ref: "reviewed-step", measured_at: new Date(),
  approved_edge_release_sha: "a".repeat(40), measured_edge_release_sha: "a".repeat(40),
  measured_edge_target: `/home/commonswarm/edge/releases/${"a".repeat(40)}`,
  measured_mount: `/home/commonswarm/edge/releases/${"a".repeat(40)}`,
  measured_generation: 1, release_generation: 1, measured_artifact_digest: "e".repeat(64),
  measured_image_digest: `sha256:${"f".repeat(64)}`,
};
function issuanceResponse() {
  const headers = new Map();
  return { status: 0, statusCode: 200, headers: {}, body: "", headersSent: false, destroyed: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); this.headers[name] = value; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    getHeaderNames() { return [...headers.keys()]; },
    removeHeader(name) { headers.delete(name.toLowerCase()); delete this.headers[name]; },
    writeHead(status, extra) { this.status = status; this.statusCode = status;
      for (const [key, value] of Object.entries(extra ?? {})) this.setHeader(key, value); },
    write() { return true; }, end(body = "") { this.body += body; }, flushHeaders() {} };
}
function openIssuanceCoordinator() {
  return new AdminTransactionCoordinator({ connect: async () => ({
    processID: 1,
    async query(sql) {
      if (sql === "SELECT session_user AS principal") return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (typeof sql === "string" && sql.includes("admin_cutover_state")) return { rows: [measuredRelease] };
      if (typeof sql === "string" && sql.includes("migration_checksum_failures")) return { rows: [], rowCount: 0 };
      return { command: String(sql).split(" ")[0], rows: [], rowCount: 0 };
    },
    release() {}, end() {},
  }) }, { adminIssuanceEnabled: true });
}

// Fixture supplies stored rows only; policy, receipt checks, manifest creation,
// summary/CSRF binding and refusal all run through the production service/handler.
function fixture(scope = "openid offline_access admin:read") {
  const session = { user_id: ALICE, user_email: "alice@example.test", user_display_name: "Alice",
    authenticated_at: new Date().toISOString() };
  const metadata = { client_id: CLIENT, application_type: "web", redirect_uris: ["https://client.example/callback"],
    dpop_signing_alg: "ES256", client_name: "Familiar <img src=x> name" };
  const verification = { client_id: CLIENT, verification_version: 1, application_type: "web", registration_source: "cimd",
    active: true, withdrawn_at: null, metadata_digest: adminDigest(metadata), redirect_uris: [...metadata.redirect_uris],
    scope_ceiling: ["admin:read", "workspaces:create", "seats:create", "seats:renew", "seats:revoke",
      "invites:create", "invites:revoke", "onboarding:connect"],
    publisher_identity: "Checked publisher", publisher_contact: "independent-contact.example",
    review_evidence_ref: "review-1", full_account_eligible: true,
    pkce_s256_tested: true, dpop_tested: true, redirect_tested: true, origin_control_verified: true,
    delegation_eligible: false, native_loopback_eligible: false };
  const approval = { owner_user_id: ALICE, client_id: CLIENT, verification_version: 1,
    approval_event_id: "approval-event", approval_command_id: "human-owner-command", withdrawn_at: null };
  const details = { uid: "admin-test", params: { client_id: CLIENT, redirect_uri: metadata.redirect_uris[0],
    resource: ADMIN, scope, code_challenge: "a".repeat(43), code_challenge_method: "S256",
    dpop_jkt: "b".repeat(43), state: "oauth-state" }, prompt: { name: "consent", details: {} },
    session: { grantId: "old-mcp-provider-grant" } };
  const state = { session, metadata, verification, approval, details, registered: false,
    parent: { user_id: ALICE, selection_version: 0, oauth_state: "oauth-state" }, receipt: null,
    stages: 0, grants: 0, grantFinds: 0, finishes: 0, completions: 0, cutoverReads: 0, fetches: 0,
    signIns: 0, gotrueBegins: 0, boundUserId: ALICE,
    cutover: { admin_issuance_enabled: false, legacy_closed: false } };
  const receiptStore = {
    transaction: callback => callback({}),
    session: async () => state.session,
    clientPolicy: async () => ({ verification: state.verification, approval: state.approval, registered: state.registered }),
    load: async () => ({ parent: state.parent, receipt: state.receipt }),
    cutover: async () => { state.cutoverReads++; return state.cutover; },
    stage: async (_tx, input, manifest, policy, summary) => {
      state.stages++;
      state.parent = { ...state.parent, selection_version: input.version + 1 };
      state.receipt = { manifest, manifest_digest: adminDigest(manifest),
        owner_user_id: input.ownerUserId, client_id: input.params.client_id, resource: ADMIN,
        redirect_uri: input.params.redirect_uri, pkce_challenge: input.params.code_challenge,
        pkce_method: input.params.code_challenge_method, registry_version: manifest.registry_version,
        availability_digest: manifest.availability_digest,
        jkt: input.params.dpop_jkt, verification_version: policy.verification.verification_version,
        requested_scopes: policy.requestedScopes, session_binding: hashOpaque(input.sessionId),
        csrf_binding: hashOpaque(summary.token), full_account: manifest.mode === "full_account",
        second_confirmation_binding: manifest.mode === "full_account" ? hashOpaque(summary.secondToken) : null,
        replacement_grant_id: null, consumed_at: null };
      return { parent: state.parent, receipt: state.receipt };
    },
  };
  class Grant {
    constructor() { state.grants++; }
    static async find() { state.grantFinds++; throw new Error("must never reuse an MCP grant"); }
  }
  const provider = { Client: { find: async () => ({ metadata: () => state.metadata }) }, Grant,
    interactionDetails: async () => details,
    interactionFinished: async (_req, _res, result, opts) => {
      state.finishes++;
      state.finishedResult = result;
      state.finishedOpts = opts;
    } };
  const service = createAdminConsentService({ store: receiptStore, provider,
    fetchMetadata: async () => { state.fetches++; return new Response(JSON.stringify(state.metadata)); },
    completeInTransaction: async () => { state.completions++; return "fresh-admin-grant"; } });
  const baseStore = { requireSession: async () => session, bindInteraction: async () => ({ user_id: state.boundUserId }),
    issueConsentToken: async () => ({ token: CSRF, selectionVersion: 0 }),
    beginSignIn: async () => { state.signIns++; } };
  const handler = createAdminInteractionHandler({ provider, store: baseStore, service,
    gotrue: { begin: () => { state.gotrueBegins++; return { url: new URL("https://gotrue.example/authorize") }; } },
    workspaceReader: async () => [{ id: WORKSPACE, name: "Selected space" }],
    allowedOrigins: new Set([ORIGIN]), callbackUrl: `${ORIGIN}/oauth/callback/gotrue` });
  const input = () => ({ uid: details.uid, sessionId: SESSION, ownerUserId: ALICE, params: details.params,
    csrfToken: CSRF, version: state.parent.selection_version });
  async function select(mode = "granular", workspace_ids = []) {
    return service.select(input(), { mode, scope_names: ["admin:read"], workspace_ids });
  }
  async function confirm(result, override = {}) {
    return service.confirm({ ...input(), csrfToken: result.summary.token, ...override.input },
      { summary_digest: result.summary.digest, confirm_full_account: "yes",
        second_token: result.summary.secondToken, ...override.body });
  }
  return { state, handler, service, input, select, confirm, provider };
}

test("admin-consent-client-policy: approved hosted HTTPS granular and zero-workspace selection succeeds", async () => {
  const f = fixture();
  const res = response();
  await f.handler(request("POST", { selection_version: 0, mode: "granular",
    scope_names: ["admin:read"], workspace_ids: [] }), res, url("/selection"));
  assert.equal(res.status, 200);
  assert.equal(f.state.stages, 1);
  assert.deepEqual(f.state.receipt.manifest.capability_names, ["admin_read_metadata"]);
  assert.deepEqual(f.state.receipt.manifest.workspace_ids, []);
  assert.match(res.body, /Read-only|read metadata/u);
  assert.match(res.body, /cannot create admin grants/u);
  assert.equal(f.state.grants + f.state.grantFinds + f.state.finishes, 0);
});

test("admin-consent-client-policy: client refusals are paired with the same approved client", async t => {
  const cases = [
    ["unverified familiar display name", f => { f.state.verification = null; }],
    ["DCR despite forged verification", f => { f.state.registered = true; }],
    ["native despite forged verification/approval", f => { f.state.metadata.application_type = "native";
      f.state.verification.application_type = "native";
      f.state.verification.metadata_digest = adminDigest(f.state.metadata); }],
    ["IPv4 loopback", f => { f.state.metadata.redirect_uris = ["https://127.0.0.1/callback"]; }],
    ["IPv6 loopback", f => { f.state.metadata.redirect_uris = ["https://[::1]/callback"]; }],
    ["localhost", f => { f.state.metadata.redirect_uris = ["https://localhost/callback"]; }],
    ["HTTP", f => { f.state.metadata.redirect_uris = ["http://client.example/callback"]; }],
    ["custom scheme", f => { f.state.metadata.redirect_uris = ["clientapp:/callback"]; }],
    ["changed metadata", f => { f.state.metadata.client_name = "New publisher"; }],
    ["changed redirect", f => { f.state.details.params.redirect_uri = "https://other.example/callback"; }],
    ["withdrawn verification", f => { f.state.verification.withdrawn_at = new Date(); }],
    ["inactive verification", f => { f.state.verification.active = false; }],
    ["missing approval", f => { f.state.approval = null; }],
    ["automatic approval lacks command/event", f => { delete f.state.approval.approval_event_id; }],
    ["withdrawn approval", f => { f.state.approval.withdrawn_at = new Date(); }],
    ["mismatched verification version", f => { f.state.approval.verification_version = 2; }],
    ["missing DPoP algorithm", f => { delete f.state.metadata.dpop_signing_alg;
      f.state.verification.metadata_digest = adminDigest(f.state.metadata); }],
    ["incompatible algorithm", f => { f.state.metadata.dpop_signing_alg = "RS256";
      f.state.verification.metadata_digest = adminDigest(f.state.metadata); }],
    ["DPoP untested", f => { f.state.verification.dpop_tested = false; }],
    ["no authorization proof key", f => { delete f.state.details.params.dpop_jkt; }],
    ["PKCE method changed", f => { f.state.details.params.code_challenge_method = "plain"; }],
    ["unsupported permission", f => { f.state.details.params.scope += " workspaces:archive"; }],
    ["delegation", f => { f.state.details.params.scope += " admin:delegate"; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    if (["IPv4 loopback", "IPv6 loopback", "localhost", "HTTP", "custom scheme"].includes(name)) {
      // Forge matching pins and approval so only the hosted HTTPS rule can refuse.
      f.state.verification.redirect_uris = [...f.state.metadata.redirect_uris];
      f.state.details.params.redirect_uri = f.state.metadata.redirect_uris[0];
      f.state.verification.metadata_digest = adminDigest(f.state.metadata);
    }
    await assert.rejects(f.select(), e => ["unauthorized_client", "dpop_required", "invalid_scope"].includes(e.code));
    assert.equal(f.state.stages + f.state.grants + f.state.finishes, 0);
    const control = fixture();
    assert.equal((await control.select()).receipt.manifest.mode, "granular");
  });
});

test("admin-owner-approval-scoped: Alice consent cannot use Bob's approval", async () => {
  const f = fixture();
  f.state.approval.owner_user_id = BOB;
  await assert.rejects(f.select(), { code: "unauthorized_client" });
  assert.equal(f.state.stages, 0);
  f.state.approval.owner_user_id = ALICE;
  assert.equal((await f.select()).receipt.owner_user_id, ALICE);
});

test("admin consent expiry is positive and bounded by thirty days; a shorter choice succeeds", async () => {
  for (const expires_at of [new Date(Date.now() - 1000).toISOString(),
    new Date(Date.now() + 31 * 86400000).toISOString(), "invalid-date"]) {
    const f = fixture();
    await assert.rejects(f.service.select(f.input(), { mode: "granular", scope_names: ["admin:read"],
      workspace_ids: [], expires_at }), { code: "invalid_manifest" });
    assert.equal(f.state.stages, 0);
  }
  const f = fixture();
  const ends = new Date(Date.now() + 86400000).toISOString();
  const selected = await f.service.select(f.input(), { mode: "granular", scope_names: ["admin:read"],
    workspace_ids: [], expires_at: ends });
  assert.equal(selected.receipt.manifest.expires_at, new Date(ends).getTime());
  assert.equal(selected.receipt.manifest.refresh_deadline, new Date(ends).getTime());
});

const FULL_SCOPES = "openid offline_access admin:read workspaces:create seats:create seats:renew seats:revoke invites:create invites:revoke onboarding:connect";
test("full-account-second-confirmation: no unverified option and first selection never creates a grant", async () => {
  const unknown = fixture(FULL_SCOPES);
  unknown.state.verification = null;
  const unavailable = response();
  await unknown.handler(request(), unavailable, url());
  assert.equal(unavailable.status, 403);
  assert.doesNotMatch(unavailable.body, /value="full_account"|second_token/u);
  const unverified = renderAdminConsentPage({ uid: "test", user: { userId: ALICE },
    params: fixture().state.details.params, policy: null });
  assert.doesNotMatch(unverified, /value="full_account"|second_token/u);
  const f = fixture(FULL_SCOPES);
  const first = response();
  await f.handler(request(), first, url());
  assert.match(first.body, /name="mode" value="full_account"/u);
  assert.match(first.body, /name="mode" value="granular" checked/u);
  assert.match(first.body, /name="scope_names" value="admin:read" checked/u);
  assert.doesNotMatch(first.body, /value="seats:create" checked/u);
  assert.match(first.body, /Familiar &lt;img src=x&gt; name/u);
  const selected = await f.select("full_account", [WORKSPACE]);
  assert.equal(f.state.grants + f.state.grantFinds + f.state.finishes + f.state.completions, 0);
  assert.notEqual(selected.summary.token, selected.summary.secondToken);
  await assert.rejects(f.confirm(selected, { body: { second_token: undefined } }), { code: "consent_receipt_invalid" });
  await assert.rejects(f.confirm(selected, { body: { second_token: selected.summary.token } }), { code: "consent_receipt_invalid" });
  await assert.rejects(f.confirm(selected, { body: { confirm_full_account: undefined } }), { code: "consent_receipt_invalid" });
  // The exact confirmed summary reaches the deliberately closed issuance gate.
  await assert.rejects(f.confirm(selected), { code: "admin_issuance_disabled" });
  assert.equal(f.state.cutoverReads, 1);
  const reload = response();
  await f.handler(request(), reload, url());
  assert.match(reload.body, new RegExp(selected.summary.digest, "u"));
  assert.match(reload.body, /Existing and future workspaces you own/u);
  assert.match(reload.body, /Renew seats limits/u);
  assert.match(reload.body, /Billing — unavailable/u);
  const nonce = /<script nonce="([A-Za-z0-9_-]+)">/u.exec(reload.body)?.[1];
  assert.ok(nonce);
  assert.match(reload.headers["content-security-policy"], new RegExp(`script-src 'nonce-${nonce}'`, "u"));
  assert.doesNotMatch(reload.body, /<img|<script[^>]+src=/u);
  assert.equal(f.state.grants + f.state.grantFinds + f.state.finishes, 0);
});

test("admin-consent-client-policy: stale authentication, CSRF, summary and duplicate receipts refuse", async t => {
  const changes = [
    ["stale authentication", (f) => { f.state.session.authenticated_at = new Date(Date.now() - 301000); }, "fresh_authentication_required"],
    ["future authentication", (f) => { f.state.session.authenticated_at = new Date(Date.now() + 10000); }, "fresh_authentication_required"],
    ["swapped owner session", (f) => { f.state.session.user_id = BOB; }, "authentication_required"],
    ["withdrawn approval after selection", (f) => { f.state.approval.withdrawn_at = new Date(); }, "unauthorized_client"],
    ["metadata changed after selection", (f) => { f.state.metadata.client_name = "Changed"; }, "unauthorized_client"],
    ["summary broadened", (f) => { f.state.receipt.manifest.scope_names.push("seats:create"); }, "consent_receipt_invalid"],
    ["metadata pin edited without a new confirmation", (f) => {
      f.state.metadata.client_name = "Changed publisher";
      f.state.verification.metadata_digest = adminDigest(f.state.metadata);
    }, "consent_receipt_invalid"],
    ["proof key changed", (f) => { f.state.details.params.dpop_jkt = "c".repeat(43); }, "consent_receipt_invalid"],
    ["OAuth state changed", (f) => { f.state.details.params.state = "different"; }, "consent_receipt_invalid"],
    ["duplicate consumed receipt", (f) => { f.state.receipt.consumed_at = new Date(); }, "consent_receipt_invalid"],
    ["re-verification does not resurrect approval", (f) => { f.state.verification.verification_version++; }, "unauthorized_client"],
  ];
  for (const [name, mutate, code] of changes) await t.test(name, async () => {
    const f = fixture(); const selected = await f.select(); mutate(f);
    await assert.rejects(f.confirm(selected), { code, ...(code === "consent_receipt_invalid" ? { status: 400 } : {}) });
    assert.equal(f.state.cutoverReads + f.state.grants + f.state.completions, 0);
    const control = fixture();
    await assert.rejects(control.confirm(await control.select()), { code: "admin_issuance_disabled" });
    assert.equal(control.state.cutoverReads, 1);
  });
  const f = fixture(); const selected = await f.select();
  await assert.rejects(f.confirm(selected, { input: { csrfToken: "wrong-csrf-token-that-is-long" } }), { code: "consent_receipt_invalid" });
  await assert.rejects(f.confirm(selected, { body: { summary_digest: "0".repeat(64) } }), { code: "consent_receipt_invalid" });
  await assert.rejects(f.confirm(selected, { input: { version: 0 } }), { code: "consent_receipt_invalid" });
  await assert.rejects(f.confirm(selected), { code: "admin_issuance_disabled" });
});

test("admin pending GET refuses a changed summary; compatible clients see the review page", async () => {
  const f = fixture(); await f.select();
  const good = response(); await f.handler(request(), good, url());
  assert.equal(good.status, 200);
  f.state.metadata.client_name = "Replaced name";
  f.state.verification.metadata_digest = adminDigest(f.state.metadata);
  await assert.rejects(f.handler(request(), response(), url()), { code: "consent_receipt_invalid" });
  const incompatible = fixture();
  delete incompatible.state.metadata.dpop_signing_alg;
  incompatible.state.verification.metadata_digest = adminDigest(incompatible.state.metadata);
  const denied = response(); await incompatible.handler(request(), denied, url());
  assert.equal(denied.status, 403);
  assert.match(denied.body, /cannot prove possession of its access key/u);
  assert.doesNotMatch(denied.body, /<form|value="full_account"/u);
});

test("admin consent refuses origin/body errors; flags cannot enable completion or codes", async () => {
  const f = fixture(); const selected = await f.select();
  const body = { selection_version: 1, summary_digest: selected.summary.digest };
  await assert.rejects(f.handler(request("POST", body, { origin: "https://attacker.example" }), response(), url("/consent")), { code: "origin_forbidden" });
  const oversized = createAdminInteractionHandler({ provider: f.provider,
    store: { requireSession: async () => f.state.session, bindInteraction: async () => ({ user_id: ALICE }) },
    service: f.service, allowedOrigins: new Set([ORIGIN]), maxBodyBytes: 1 });
  await assert.rejects(oversized(request("POST", body), response(), url("/consent")), { status: 413 });
  for (const cutover of [null, { admin_issuance_enabled: true, legacy_closed: false },
    { admin_issuance_enabled: true, legacy_closed: true }]) {
    f.state.cutover = cutover;
    await assert.rejects(f.confirm(selected), { code: "admin_issuance_disabled" });
  }
  assert.equal(f.state.grants + f.state.grantFinds + f.state.finishes + f.state.completions, 0);
});

async function confirmThroughHandler(f, prompt) {
  f.state.details.prompt.name = prompt;
  const selected = await f.select();
  f.provider.interactionFinished = async (_req, res, result, opts) => {
    f.state.finishes++;
    f.state.finishedResult = result;
    f.state.finishedOpts = opts;
    res.writeHead(303, { location: "/authorize/admin-test" });
    res.end();
  };
  const issued = issuanceResponse();
  const outcome = await openIssuanceCoordinator().run(issued, () => f.handler(
    request("POST", { selection_version: selected.parent.selection_version,
      summary_digest: selected.summary.digest }, { "x-cswarm-csrf": selected.summary.token }),
    issued, url("/consent")));
  return { outcome, issued, selected };
}

test("first-time admin login renders consent and finishes login with consent", async () => {
  const open = fixture();
  open.state.details.prompt.name = "login";
  const openPage = issuanceResponse();
  const opened = await openIssuanceCoordinator().run(openPage, () => open.handler(request(), openPage, url()));
  assert.equal(opened.outcome, "committed");
  assert.equal(openPage.statusCode, 200);
  assert.match(openPage.body, /Review admin access/u);
  assert.match(openPage.body, /action="\/interaction\/admin-test\/selection"/u);
  assert.equal(open.state.finishes, 0);

  const closed = fixture();
  closed.state.details.prompt.name = "login";
  await assert.rejects(closed.handler(request(), response(), url()), { code: "admin_issuance_disabled" });
  assert.equal(closed.state.finishes, 0);

  const stale = fixture();
  stale.state.details.prompt.name = "login";
  stale.state.session.authenticated_at = new Date(Date.now() - 301000).toISOString();
  const staleRes = response();
  await stale.handler(request(), staleRes, url());
  assert.equal(staleRes.status, 303);
  assert.equal(stale.state.gotrueBegins, 1);
  assert.equal(stale.state.signIns, 1);
  assert.equal(stale.state.finishes, 0);

  const absent = fixture();
  absent.state.details.prompt.name = "login";
  const absentRes = response();
  await absent.handler(request(), absentRes, url(), undefined, { browser: { id: SESSION, session: {} } });
  assert.equal(absentRes.status, 303);
  assert.equal(absent.state.gotrueBegins, 1);
  assert.equal(absent.state.signIns, 1);
  assert.equal(absent.state.finishes, 0);

  const loginConfirm = fixture();
  const loginDone = await confirmThroughHandler(loginConfirm, "login");
  assert.equal(loginDone.outcome.outcome, "committed");
  assert.equal(loginConfirm.state.finishes, 1);
  assert.equal(loginConfirm.state.completions, 1);
  assert.deepEqual(loginConfirm.state.finishedResult, {
    login: { accountId: ALICE }, consent: { grantId: "fresh-admin-grant" } });
  assert.equal(loginConfirm.state.finishedOpts, undefined);

  const consentConfirm = fixture();
  const consentDone = await confirmThroughHandler(consentConfirm, "consent");
  assert.equal(consentDone.outcome.outcome, "committed");
  assert.equal(consentConfirm.state.finishes, 1);
  assert.deepEqual(consentConfirm.state.finishedResult, { consent: { grantId: "fresh-admin-grant" } });

  const mismatched = fixture();
  mismatched.state.details.prompt.name = "login";
  mismatched.state.boundUserId = BOB;
  await assert.rejects(mismatched.handler(request("POST", { selection_version: 0, mode: "granular",
    scope_names: ["admin:read"], workspace_ids: [] }), response(), url("/selection")),
    { code: "authentication_required" });
  await assert.rejects(mismatched.handler(request("POST", { selection_version: 0, summary_digest: "0".repeat(64) }),
    response(), url("/consent")), { code: "authentication_required" });
  assert.equal(mismatched.state.finishes, 0);
});

test("resource dispatcher sends only scalar admin to its separate handler", async () => {
  const f = fixture(); let bindings = 0;
  f.provider.interactionFinished = async (_req, res) => {
    f.state.finishes++; res.writeHead(204); res.end();
  };
  const dispatch = createResourceInteractionHandler({
    mcpHandler: createInteractionHandler({ provider: f.provider,
      store: { requireSession: async () => f.state.session,
        bindInteraction: async () => { bindings++; return { user_id: ALICE }; } },
      gotrue: {}, allowedOrigins: new Set([ORIGIN]) }), adminHandler: f.handler });
  const body = new URLSearchParams({ selection_version: "0", csrf_token: CSRF,
    mode: "granular", scope_names: "admin:read" }).toString();
  const selection = Readable.from([Buffer.from(body)]);
  selection.method = "POST";
  selection.headers = { cookie: `__Host-cswarm-oauth=${SESSION}`, origin: ORIGIN,
    "content-type": "application/x-www-form-urlencoded" };
  const admin = response();
  await dispatch(selection, admin, url("/selection"));
  assert.equal(admin.status, 200);
  assert.equal(f.state.stages, 1);
  assert.equal(bindings, 0, "admin never binds through the MCP authority handler");
  assert.equal(f.state.finishes + f.state.grants + f.state.grantFinds, 0);
  f.state.details.params.resource = [MCP, ADMIN];
  const multiple = response();
  await dispatch(request(), multiple, url());
  assert.equal(multiple.status, 400);
  assert.deepEqual(JSON.parse(multiple.body), { error: "invalid_target" });
  assert.equal(bindings, 0);
  f.state.details.params.resource = MCP;
  f.state.details.prompt.name = "login";
  const mcp = response();
  await dispatch(request(), mcp, url());
  assert.equal(mcp.status, 204);
  assert.equal(bindings, 1);
  assert.equal(f.state.finishes, 1);
  assert.equal(f.state.stages, 1);
});

test("mcp-interaction-refuses-admin: refusal precedes grant lookup/mutation and hosted activation; MCP succeeds", async () => {
  for (const enabled of [false, true]) for (const resource of [ADMIN, [ADMIN, MCP], [MCP, ADMIN]]) {
    const f = fixture("openid mcp");
    f.state.details.params.resource = resource;
    let mutations = 0, activations = 0, bindings = 0;
    class Grant {
      constructor() { mutations++; }
      static async find() { mutations++; }
      addResourceScope() { mutations++; }
      addOIDCScope() { mutations++; }
      async save() { return "fresh-mcp-grant"; }
    }
    const provider = { ...f.provider, Grant, admin_issuance_enabled: enabled,
      getResourceServerInfo: () => ({ audience: resource, scope: "mcp admin:read" }),
      interactionFinished: async (_req, res) => { res.writeHead(204); res.end(); } };
    const handler = createInteractionHandler({ provider,
      store: {
        requireSession: async () => f.state.session,
        bindInteraction: async () => { bindings++; return { user_id: ALICE }; },
        consumeConsent: async () => ({ client_id: CLIENT, selected_workspace_ids: [WORKSPACE],
          provider_grant_id: "old-mcp-grant", commonswarm_grant_id: WORKSPACE }),
        bindProviderGrant: async () => ({ provider_grant_id: "fresh-mcp-grant", commonswarm_grant_id: WORKSPACE }),
        complete: async () => {},
      }, consentOrchestrator: { activate: async () => { activations++; } },
      allowedOrigins: new Set([ORIGIN]), workspaceReader: async () => [], gotrue: {} });
    const res = response();
    await handler(request("POST", { selection_version: 0, home_workspace_id: WORKSPACE }), res, url("/consent"));
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "invalid_target" });
    assert.equal(mutations + activations + bindings, 0);
    // Exact same handler and permissive metadata now complete ordinary MCP consent.
    f.state.details.params.resource = MCP;
    const control = response();
    await handler(request("POST", { selection_version: 0, home_workspace_id: WORKSPACE }), control, url("/consent"));
    assert.equal(control.status, 204);
    assert.equal(activations, 1);
    assert.ok(mutations > 0);
  }
});
