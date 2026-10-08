import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "pg";
import { InteractionStore } from "../src/interaction-store.js";
import { PostgresAdminConsentStore, adminDigest, createAdminConsentService } from "../src/admin-consent.js";
import { hashOpaque } from "../src/browser-security.js";

const OWNER = "10000000-0000-4000-8000-000000000001";
const SESSION = "version-regression-browser-session";
const CLIENT = "https://client.example/metadata";
const params = { client_id: CLIENT, redirect_uri: "https://client.example/callback",
  resource: "https://api.commonswarm.com/admin", scope: "openid offline_access admin:read",
  code_challenge: "a".repeat(43), code_challenge_method: "S256", dpop_jkt: "b".repeat(43), state: "state" };
const rows = row => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });

test("PostgreSQL consent counters keep selection, reload and confirmation on the same numeric summary", async t => {
  // Exercise pg's actual default int8 parser without changing the global registry.
  for (const [name, parse] of [["pg int8 text", types.getTypeParser(types.builtins.INT8)], ["numeric driver", Number]]) {
    await t.test(name, async () => {
      const metadata = { client_id: CLIENT, application_type: "web", redirect_uris: [params.redirect_uri], dpop_signing_alg: "ES256" };
      const verification = { client_id: CLIENT, verification_version: 1, active: true, application_type: "web",
        registration_source: "static", metadata_digest: adminDigest(metadata), redirect_uris: metadata.redirect_uris,
        scope_ceiling: ["admin:read"], publisher_identity: "Publisher", publisher_contact: "Contact", review_evidence_ref: "Review",
        pkce_s256_tested: true, dpop_tested: true, redirect_tested: true, origin_control_verified: true,
        delegation_eligible: false, native_loopback_eligible: false };
      let parent = { user_id: OWNER, oauth_state: params.state, selection_version: parse("0"), expires_at: new Date(Date.now() + 600000) };
      let receipt, cutoverReads = 0;
      const tx = { release() {}, async query(sql, values) {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return rows();
        if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM commonswarm_oauth.browser_sessions")) return rows({ user_id: OWNER, authenticated_at: new Date() });
        if (sql.includes("FROM commonswarm_oauth.admin_verified_clients")) return rows(verification);
        if (sql.includes("FROM commonswarm_oauth.admin_client_owner_approvals")) return rows({ owner_user_id: OWNER,
          client_id: CLIENT, verification_version: 1, approval_event_id: "event", approval_command_id: "command" });
        if (sql.includes("FROM commonswarm_oauth.registered_clients")) return rows();
        if (sql.includes("FROM commonswarm_oauth.admin_cutover_state")) { ++cutoverReads; return rows({ admin_issuance_enabled: false }); }
        if (sql.includes("FROM commonswarm_oauth.admin_interactions")) return rows(receipt);
        if (sql.includes("FROM commonswarm_oauth.interactions")) return rows(parent);
        if (sql.includes("UPDATE commonswarm_oauth.interactions")) {
          if (sql.includes("selection_version=selection_version+1")) parent = { ...parent, selection_version: parse("1") };
          return rows(parent);
        }
        if (sql.includes("INSERT INTO commonswarm_oauth.admin_interactions")) {
          receipt = { owner_user_id: OWNER, client_id: CLIENT, resource: params.resource, redirect_uri: params.redirect_uri,
            registry_version: values[5], verification_version: values[6], manifest: JSON.parse(values[7]),
            manifest_digest: values[8], availability_digest: values[9], requested_scopes: values[10],
            session_binding: values[11], csrf_binding: values[12], second_confirmation_binding: values[13],
            full_account: values[14], pkce_challenge: values[15], pkce_method: "S256", jkt: values[16], consumed_at: null };
          return rows(receipt);
        }
        throw new Error("unexpected consent fixture query");
      } };
      const base = new InteractionStore(tx);
      const csrf = await base.issueConsentToken("uid", SESSION, OWNER);
      assert.equal(csrf.selectionVersion, 0);
      const store = new PostgresAdminConsentStore({ connect: async () => tx });
      const service = createAdminConsentService({ store, staticClientIds: new Set([CLIENT]),
        provider: { Client: { find: async () => ({ metadata: () => metadata }) } } });
      const input = { uid: "uid", sessionId: SESSION, ownerUserId: OWNER, params, csrfToken: csrf.token, version: csrf.selectionVersion };
      const selected = await service.select(input, { mode: "granular", scope_names: ["admin:read"], workspace_ids: [] });
      assert.equal(selected.parent.selection_version, 1);
      assert.equal(parent.selection_version, parse("1"), "normalization must not mutate driver rows");
      const reloaded = await service.view(input);
      assert.equal(reloaded.parent.selection_version, 1);
      assert.deepEqual(reloaded.summary, selected.summary);
      await assert.rejects(service.confirm({ ...input, version: 1, csrfToken: selected.summary.token },
        { summary_digest: selected.summary.digest }), { code: "admin_issuance_disabled" });
      assert.equal(cutoverReads, 1, "valid receipt reaches the closed issuance gate");
    });
  }
});

test("all interaction row APIs return a safe numeric CAS counter without depending on pg parser state", async () => {
  const raw = { selection_version: types.getTypeParser(types.builtins.INT8)("7"), signin_state_hash: hashOpaque("google:signin-state") };
  const tx = { query: async () => rows(raw), release() {} };
  const store = new InteractionStore({ query: tx.query, connect: async () => tx });
  const binding = { interactionUid: "uid", sessionId: SESSION, userId: OWNER, clientId: CLIENT,
    redirectUri: params.redirect_uri, resource: params.resource, scopes: ["openid"], pkceChallenge: params.code_challenge };
  const choice = { ...binding, token: "consent-token", selectionVersion: 7, workspaceIds: [OWNER] };
  for (const row of [await store.bindInteraction(binding), await store.consumeSignIn("uid", SESSION, "signin-state", "google"),
    await store.attachUser("uid", SESSION, { id: OWNER }), (await store.selectWithToken(choice)).interaction,
    await store.bindProviderGrant("uid", "family", OWNER), await store.consumeConsent(choice), await store.selectAndConsumeConsent(choice)]) {
    assert.equal(row.selection_version, 7);
  }
  assert.equal(raw.selection_version, "7");
});

test("stored interaction counters refuse unsafe or malformed values rather than round a CAS version", async () => {
  for (const raw of ["9007199254740992", "9223372036854775807", "-1", "1.5", "", "01", null, undefined, NaN]) {
    const store = new InteractionStore({ query: async () => rows({ selection_version: raw }) });
    await assert.rejects(store.issueConsentToken("uid", SESSION, OWNER), { code: "interaction_binding_mismatch" });
  }
  const store = new InteractionStore({ query: async () => rows({ selection_version: "9007199254740991" }) });
  assert.equal((await store.issueConsentToken("uid", SESSION, OWNER)).selectionVersion, Number.MAX_SAFE_INTEGER);
});
