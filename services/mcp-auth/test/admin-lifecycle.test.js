import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AdminTransactionCoordinator, adminQuery, withAdminRole } from "../src/admin-transaction.js";
import { requireMeasuredAdminRelease, adminTokenLifetime } from "../src/admin-lifecycle.js";
import { createAdminManifest } from "../src/admin-consent.js";
import { decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount } from "../src/admin-authority.generated.js";
import { AdminAuthorityBridge } from "../src/admin-authority.js";

test("AS consent confirmation checks the pending receipt's current rights before creating a grant", async t => {
  for (const condition of ["no workspaces", "current membership", "revoked membership", "missing membership", "missing receipt"]) {
    await t.test(condition, async () => {
      const now = Math.floor(Date.now() / 1000) * 1000, owner = randomUUID(), workspace = randomUUID();
      const sessionHash = Buffer.alloc(32, 7), receiptId = randomUUID(), grantId = randomUUID();
      const manifest = createAdminManifest({ mode: "granular", scope_names: ["admin:read"],
        workspace_ids: condition === "no workspaces" ? [] : [workspace] },
      { verification: { client_id: "https://client.example" }, resourceScopes: ["admin:read"] }, now);
      const consent = { consent_receipt_id: receiptId, owner_user_id: owner, session_binding: sessionHash.toString("hex"),
        manifest, manifest_digest: "a".repeat(64), full_account_selected: false, expires_at: now + 300000, consumed_at: null };
      const account = { owner_user_id: owner, stream_id: randomUUID(), seq: 0, projection: emptyAdminAccount() };
      const events = [], rightsReads = [];
      let confirming = false, prepared, granted;
      const pool = { connect: async () => ({ async query(sql, values) {
        if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
        if (sql.includes("FROM commonswarm_oauth.browser_sessions")) return { rowCount: 1, rows: [{}] };
        if (sql.includes(" AS now")) return { rows: [{ now: String(now) }] };
        if (sql.includes("FROM swarm.memberships")) {
          rightsReads.push(values);
          const rows = confirming && condition === "missing membership" ? [] : [{ workspace_id: workspace,
            role: "member", revoked_at: confirming && condition === "revoked membership" ? new Date(now) : null,
            archived_at: null }];
          return { rows };
        }
        if (sql.includes("INSERT INTO swarm.admin_events")) events.push(JSON.parse(values[4]));
        return { rows: [], command: sql.split(" ")[0] };
      }, release() {} }) };
      const coordinator = new AdminTransactionCoordinator(pool), bridge = new AdminAuthorityBridge();
      const actor = { kind: "human", user_id: owner, session_binding: consent.session_binding };
      const server = createServer((_request, response) => coordinator.run(response, async () => {
        prepared = await bridge.decide(account, { kind: "prepare_admin_consent", consent }, actor);
        confirming = true;
        if (condition === "missing receipt") delete account.projection.consents[receiptId];
        granted = await bridge.decide(account, { kind: "grant_admin_delegation", grant_id: grantId,
          consent_receipt_id: receiptId, replaces_grant_id: null }, actor);
        response.statusCode = 204; response.end();
      }, { kind: "human", owner, sessionHash }));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        assert.equal((await fetch(`http://127.0.0.1:${server.address().port}`)).status, 204);
        assert.equal(prepared.ok, true);
        const allowed = ["no workspaces", "current membership"].includes(condition);
        assert.equal(granted.ok, allowed, granted.reason);
        assert.equal(events.filter(event => event.type === "AdminDelegationGranted").length, allowed ? 1 : 0);
        assert.equal(account.projection.grants[grantId] != null, allowed);
        if (allowed) {
          assert.equal(account.projection.consents[receiptId].consumed_at, now);
          assert.deepEqual(account.projection.grants[grantId].workspace_ids, manifest.workspace_ids);
        } else assert.equal(granted.reason, "consent_invalid");
        if (condition === "no workspaces") assert.equal(rightsReads.length, 0);
        else assert.equal(rightsReads.length, condition === "missing receipt" ? 1 : 2,
          "confirmation re-reads membership for the receipt's exact workspace selection");
        for (const values of rightsReads) assert.deepEqual(values, [owner, [workspace]]);
        if (allowed) {
          // The production bridge consumed this receipt while persisting the
          // first grant. A new grant ID cannot reuse it, even with fresh rights.
          let duplicate;
          const retryServer = createServer((_request, response) => coordinator.run(response, async () => {
            duplicate = await bridge.decide(account, { kind: "grant_admin_delegation", grant_id: randomUUID(),
              consent_receipt_id: receiptId, replaces_grant_id: null }, actor);
            response.statusCode = 204; response.end();
          }, { kind: "human", owner, sessionHash }));
          await new Promise(resolve => retryServer.listen(0, "127.0.0.1", resolve));
          try {
            assert.equal((await fetch(`http://127.0.0.1:${retryServer.address().port}`)).status, 204);
            assert.equal(duplicate.ok, false);
            assert.equal(duplicate.reason, "consent_invalid");
            assert.equal(events.filter(event => event.type === "AdminDelegationGranted").length, 1);
            assert.deepEqual(Object.keys(account.projection.grants), [grantId]);
          } finally { await new Promise(resolve => retryServer.close(resolve)); }
        }
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  }
});

test("AS account loading accepts a durable key fence without blocking an independent grant and refuses other drift", async t => {
  const now = Date.now(), owner = randomUUID(), denied = randomUUID(), independent = randomUUID();
  const grant = { ...createAdminManifest({ mode: 'granular', scope_names: ['admin:read'], workspace_ids: [] },
    { verification: { client_id: 'https://client.example' }, resourceScopes: ['admin:read'] }, now),
    grant_id: denied, owner_user_id: owner, manifest_digest: 'a'.repeat(64), consent_receipt_id: randomUUID(),
    created_at: now, state: 'active', revoked_at: null, suspended_at: null, reason_code: null, withdrawn_workspace_ids: [] };
  const projection = { ...emptyAdminAccount(), grants: { [denied]: grant, [independent]: { ...grant, grant_id: independent } } };
  const durable = Object.values(projection.grants).map(g => ({ ...g, expires_at: new Date(g.expires_at),
    refresh_deadline: new Date(g.refresh_deadline), ...(g.grant_id === denied ? { state: 'revoked', revoked_at: new Date(now), reason_code: 'issuer_key_denied' } : {}) }));
  let rows = durable;
  const pool = { connect: async () => ({ async query(sql) {
    if (sql.includes('session_user')) return { rows: [{ principal: 'commonswarm_admin_issuer' }] };
    if (sql.includes('SELECT * FROM swarm.admin_accounts')) return { rows: [{ owner_user_id: owner, projection }] };
    if (sql.includes('FROM swarm.admin_grants')) return { rows };
    return { rows: [], command: sql.split(' ')[0] };
  }, release() {} }) };
  let loaded;
  const coordinator = new AdminTransactionCoordinator(pool);
  const server = createServer((_request, response) => coordinator.run(response, async () => {
    loaded = await new AdminAuthorityBridge().account(owner);
    response.statusCode = 204; response.end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 204);
  assert.equal(loaded.projection.grants[denied].state, 'revoked');
  assert.equal(loaded.projection.grants[independent].state, 'active');
  assert.equal(projection.grants[denied].state, 'active');
  rows = durable.map(g => g.grant_id === independent ? { ...g, refresh_deadline: new Date(g.refresh_deadline.getTime() + 1000) } : g);
  assert.equal((await fetch(url)).status, 503, 'an unrelated deadline mismatch remains fail-closed');
});

function measurement() {
  const sha = "a".repeat(40), target = `/home/commonswarm/edge/releases/${sha}`;
  return { admin_issuance_enabled: true, legacy_closed: true, auth_contract_version: 2,
    lane8_evidence_digest: "b".repeat(64), invalidated_at: null, measurement_evidence_ref: "CI test",
    measured_at: new Date(), approved_edge_release_sha: sha, measured_edge_release_sha: sha,
    measured_edge_target: target, measured_mount: target, measured_generation: "1", release_generation: "1",
    measured_artifact_digest: "c".repeat(64), measured_image_digest: `sha256:${"d".repeat(64)}` };
}
const issuerPrivileges = JSON.parse(readFileSync(new URL("../../../tests/support/admin-issuer-privileges.json", import.meta.url), "utf8"));
async function probe(t, record, missing = [], outerRole = "commonswarm_oauth_runtime") {
  let code, ledgerReads = 0;
  let role = "commonswarm_admin_issuer";
  const allowed = privilege => issuerPrivileges.some(([grantee, kind, target, permission]) =>
    grantee === role && kind === "TABLE" && target === "commonswarm_oauth.admin_cutover_state" && permission === privilege);
  const pool = { connect: async () => ({
    async query(sql) {
      if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (sql.startsWith("SET LOCAL ROLE ")) role = sql.slice("SET LOCAL ROLE ".length);
      if (sql.includes("admin_cutover_state")) {
        // PostgreSQL locking SELECTs also require UPDATE. Enforce the independently
        // reviewed D1 ACL contract here; real catalog/HTTP proof remains in CI.
        if (!allowed("SELECT") || (/\bFOR\s+(?:KEY\s+SHARE|SHARE|NO\s+KEY\s+UPDATE|UPDATE)\b/iu.test(sql) && !allowed("UPDATE"))) {
          throw Object.assign(new Error("read privilege required"), { code: "42501" });
        }
        return { rows: record ? [record] : [] };
      }
      if (sql.includes("migration_checksum_failures")) { ++ledgerReads; return { rows: missing, rowCount: missing.length }; }
      if (sql === "SELECT 1") assert.equal(role, outerRole, "gate read must restore the enclosing authority role");
      return { rows: [], command: sql.split(" ")[0] };
    }, release() {},
  }) };
  const coordinator = new AdminTransactionCoordinator(pool);
  const server = createServer((_request, response) => coordinator.run(response, async () => {
    await withAdminRole(outerRole, async () => {
      try { await requireMeasuredAdminRelease(); } catch (error) { code = error.code; }
      if (!code) await adminQuery("SELECT 1");
    });
    response.statusCode = 204; response.end();
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(response.status, 204, "read-only activation checks must complete without poisoning the issuer transaction");
  return { code, ledgerReads };
}

test("admin-activation-measured-release: operator measurement succeeds; readiness lies, targets, digests, generations and invalidation refuse", async t => {
  assert.deepEqual(await probe(t, measurement()), { code: undefined, ledgerReads: 1 });
  assert.deepEqual(await probe(t, measurement(), [], "swarm_command"), { code: undefined, ledgerReads: 1 });
  for (const change of [
    { legacy_closed: false }, { admin_issuance_enabled: false }, { auth_contract_version: 1 },
    { measured_edge_release_sha: "f".repeat(40), readiness_sha: "a".repeat(40) },
    { measured_edge_target: "/wrong" }, { measured_mount: "/wrong" }, { measured_image_digest: "unknown" },
    { measured_artifact_digest: null }, { measured_generation: "2" }, { invalidated_at: new Date() },
    { lane8_evidence_digest: null }, { measurement_evidence_ref: null },
  ]) assert.equal((await probe(t, { ...measurement(), ...change })).code, "admin_issuance_disabled");
  assert.equal((await probe(t, null)).code, "admin_issuance_disabled");
});

test("admin-activation-migration-ledger: complete independently observed ledger succeeds; missing versions/checksums refuse despite valid measurement", async t => {
  assert.equal((await probe(t, measurement())).code, undefined);
  for (const reason of ["missing_ledger", "missing_checksum", "missing_expected", "checksum_mismatch"]) {
    const result = await probe(t, measurement(), [{ version: "20261003000001", reason }]);
    assert.equal(result.ledgerReads, 1); assert.equal(result.code, "admin_migration_evidence_incomplete");
  }
});

test("admin-refresh-consent-deadline: expiry clips to the original consent; reducer rotates without widening, renewal or spend reset", () => {
  const now = Math.floor(Date.now()/1000)*1000, owner = randomUUID(), grantId = randomUUID(), lineageId = randomUUID();
  const manifest = createAdminManifest({ mode: "granular", scope_names: ["admin:read"], workspace_ids: [],
    expires_at: new Date(now+120000).toISOString() }, { verification: { client_id: "https://client.example" },
    resourceScopes: ["admin:read"], fullAccountEligible: false }, now);
  assert.equal(adminTokenLifetime({ expires_at: new Date(now+120000), refresh_deadline: new Date(now+600000) }, now/1000), 120);
  assert.equal(adminTokenLifetime({ expires_at: new Date(now+600000), refresh_deadline: new Date(now+600000) }, now/1000), 300);
  assert.throws(() => adminTokenLifetime({ expires_at: new Date(now), refresh_deadline: new Date(now) }, now/1000), { code: "invalid_grant" });
  const grant = { ...manifest, grant_id: grantId, owner_user_id: owner, manifest_digest: "a".repeat(64),
    consent_receipt_id: randomUUID(), state: "active", created_at: now, suspended_at: null,
    revoked_at: null, reason_code: null, withdrawn_workspace_ids: [] };
  const state = { ...emptyAdminAccount(), grants: { [grantId]: grant }, lineages: { [lineageId]: {
    grant_id: grantId, credential_lineage_id: lineageId, generation: 2, scope_names: ["admin:read"],
    access_expires_at: now+60000, refresh_deadline: manifest.refresh_deadline, state: "active", delivery_state: "awaiting_delivery",
  } }, routine: { spend: { [grantId]: { workspaces: 1, successors: 2 } } } };
  let seq = 0;
  const context = { actor: { kind: "credential_runtime", connection_id: manifest.connection_id,
    client_id: manifest.client_id, resource: manifest.resource }, owner_user_id: owner, now: now+1000,
    stream_id: randomUUID(), command_id: randomUUID(), request_digest: "b".repeat(64), nextSeq: () => ++seq,
    nextEventId: randomUUID, current_workspace_rights: true, withdrawing_workspace_owner: false,
    target_workspace_owned_by_grantor: false, presenting_refresh_generation: 2, presenting_refresh_lineage_id: lineageId };
  const command = { kind: "rotate_admin_credential", grant_id: grantId, credential_lineage_id: lineageId,
    generation: 2, scope_names: ["admin:read"] };
  const decision = decideAdminAuthority(command, state, context);
  assert.equal(decision.ok, true);
  const next = decision.events.reduce(reduceAdminAuthority, state);
  assert.equal(next.lineages[lineageId].generation, 3);
  assert.equal(next.lineages[lineageId].refresh_deadline, manifest.refresh_deadline);
  assert.equal(next.grants[grantId].expires_at, manifest.expires_at);
  assert.deepEqual(next.routine.spend, state.routine.spend);
  assert.equal(decideAdminAuthority({ ...command, scope_names: ["admin:read", "workspaces:create"] }, state, context).reason, "scope_expansion_forbidden");
  assert.equal(decideAdminAuthority(command, state, { ...context, current_workspace_rights: false }).reason, "current_rights_required");
});
