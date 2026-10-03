import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { InteractionStore } from "../src/interaction-store.js";
import { PostgresAdminConsentStore, adminDigest, createAdminConsentService } from "../src/admin-consent.js";
import { hashOpaque } from "../src/browser-security.js";
import { localClusterAdminUrl } from "../../../tests/support/admin-schema-db.js";

// All fixture writes and lifecycle history roll back. This suite uses the real
// application migrations/triggers and runtime role, never hand-written DDL.
async function fixture(callback) {
  const pool = new Pool({ connectionString: localClusterAdminUrl(process.env.MCP_OAUTH_TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"), max: 1 });
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const owner = randomUUID(), other = randomUUID(), event = randomUUID();
    const uid = `admin-consent-${randomUUID()}`, clientId = `https://client.example/${randomUUID()}`;
    const metadata = { client_id: clientId, application_type: "web", dpop_signing_alg: "ES256",
      redirect_uris: ["https://client.example/callback"], client_name: "Reviewed fixture" };
    await tx.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2),($3,'authenticated','authenticated',$4)",
      [owner, `${owner}@example.test`, other, `${other}@example.test`]);
    await tx.query("INSERT INTO swarm.users(user_id,display_name) VALUES($1,'Consent owner'),($2,'Other owner')", [owner, other]);
    await tx.query("INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES($1,$2),($3,$4)",
      [owner, randomUUID(), other, randomUUID()]);
    await tx.query("SET LOCAL ROLE commonswarm_admin_release");
    await tx.query(`INSERT INTO commonswarm_oauth.admin_verified_clients
      (client_id,verification_version,application_type,registration_source,publisher_identity,publisher_contact,
       metadata_digest,redirect_uris,scope_ceiling,pkce_s256_tested,dpop_tested,redirect_tested,origin_control_verified,
       review_evidence_ref,reviewed_by,active)
      VALUES($1,1,'web','static','Fixture publisher','Independent contact',$2,$3,ARRAY['admin:read'],
        true,true,true,true,'fixture-reviewed','fixture-reviewer',true)`,
    [clientId, adminDigest(metadata), metadata.redirect_uris]);
    await tx.query("RESET ROLE");
    await tx.query("SET LOCAL ROLE swarm_command");
    await tx.query(`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
      VALUES($1::uuid,1,$2,'approval-fixture',jsonb_build_object('stream_kind','account','owner_user_id',$1::text,
        'seq',1,'type','AdminClientApproved','actor_user',$1::text,
        'payload',jsonb_build_object('client_id',$3::text,'verification_version',1)))`, [owner, event, clientId]);
    await tx.query(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals
      (owner_user_id,client_id,verification_version,approval_event_id,approval_command_id)
      VALUES($1,$2,1,$3,'approval-fixture')`, [owner, clientId, event]);
    await tx.query("RESET ROLE");
    await tx.query("SET LOCAL ROLE commonswarm_oauth_runtime");
    const base = new InteractionStore(tx);
    const sessionId = await base.createSession();
    await tx.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,authenticated_at=statement_timestamp()
      WHERE session_hash=$2`, [owner, hashOpaque(sessionId)]);
    const params = { client_id: clientId, redirect_uri: metadata.redirect_uris[0], resource: "https://api.commonswarm.com/admin",
      scope: "openid offline_access admin:read", code_challenge: "a".repeat(43),
      code_challenge_method: "S256", dpop_jkt: "b".repeat(43), state: "fixture-state" };
    await base.bindInteraction({ interactionUid: uid, sessionId, userId: owner, clientId,
      redirectUri: params.redirect_uri, resource: params.resource, scopes: params.scope.split(" "),
      pkceChallenge: params.code_challenge, oauthState: params.state });
    const csrf = await base.issueConsentToken(uid, sessionId, owner);
    // Keep the service's actual BEGIN/COMMIT/ROLLBACK semantics inside the outer
    // fixture transaction using savepoints, so immutable history never escapes.
    const requestPool = { connect: async () => ({
      query: (sql, values) => tx.query(sql === "BEGIN" ? "SAVEPOINT consent_request" :
        sql === "COMMIT" ? "RELEASE SAVEPOINT consent_request" :
          sql === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT consent_request" : sql, values),
      release() {},
    }) };
    let grants = 0;
    const service = createAdminConsentService({ store: new PostgresAdminConsentStore(requestPool),
      provider: { Client: { find: async () => ({ metadata: () => metadata }) },
        Grant: class { constructor() { grants++; } } }, staticClientIds: new Set([clientId]) });
    const input = { uid, sessionId, ownerUserId: owner, params, csrfToken: csrf.token, version: csrf.selectionVersion };
    await callback({ tx, service, input, other, grants: () => grants });
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
    await pool.end();
  }
}

test("admin-consent-client-policy (PostgreSQL): selection CAS and immutable single receipt", async () => {
  await fixture(async ({ tx, service, input, grants }) => {
    const choice = { mode: "granular", scope_names: ["admin:read"], workspace_ids: [] };
    await assert.rejects(service.select({ ...input, csrfToken: "wrong-token-that-is-long-enough" }, choice),
      { code: "consent_receipt_invalid" });
    await assert.rejects(service.select({ ...input, version: 9 }, choice), { code: "consent_receipt_invalid" });
    const selected = await service.select(input, choice);
    assert.equal(selected.parent.selection_version, 1);
    const row = (await tx.query("SELECT * FROM commonswarm_oauth.admin_interactions WHERE interaction_uid=$1", [input.uid])).rows[0];
    assert.deepEqual(row.manifest.scope_names, ["admin:read"]);
    assert.deepEqual(row.manifest.capability_names, ["admin_read_metadata"]);
    assert.equal(row.manifest_digest, adminDigest(row.manifest));
    assert.equal(row.consumed_at, null);
    await assert.rejects(service.select(input, choice), { code: "consent_receipt_invalid" });
    assert.equal((await tx.query("SELECT count(*)::int AS count FROM commonswarm_oauth.admin_interactions WHERE interaction_uid=$1", [input.uid])).rows[0].count, 1);
    const confirmed = { ...input, version: 1, csrfToken: selected.summary.token };
    await assert.rejects(service.confirm(confirmed, { summary_digest: "0".repeat(64) }), { code: "consent_receipt_invalid" });
    await assert.rejects(service.confirm(confirmed, { summary_digest: selected.summary.digest }), { code: "admin_issuance_disabled" });
    assert.equal(grants(), 0);
    // Simulate the later coordinator's committed consume, then prove this actual
    // service refuses replay of a formerly valid receipt.
    await tx.query("UPDATE commonswarm_oauth.admin_interactions SET consumed_at=statement_timestamp() WHERE interaction_uid=$1", [input.uid]);
    await assert.rejects(service.confirm(confirmed, { summary_digest: selected.summary.digest }), { code: "consent_receipt_invalid" });
  });
});

test("admin-owner-approval-scoped (PostgreSQL AS): foreign owner never borrows approval", async () => {
  await fixture(async ({ tx, service, input, other }) => {
    await tx.query("UPDATE commonswarm_oauth.browser_sessions SET user_id=$1 WHERE session_hash=$2", [other, hashOpaque(input.sessionId)]);
    await assert.rejects(service.select({ ...input, ownerUserId: other },
      { mode: "granular", scope_names: ["admin:read"], workspace_ids: [] }), { code: "unauthorized_client" });
    await tx.query("UPDATE commonswarm_oauth.browser_sessions SET user_id=$1 WHERE session_hash=$2", [input.ownerUserId, hashOpaque(input.sessionId)]);
    assert.equal((await service.select(input, { mode: "granular", scope_names: ["admin:read"], workspace_ids: [] })).receipt.owner_user_id, input.ownerUserId);
  });
});
