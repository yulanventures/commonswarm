import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AdminTransactionCoordinator } from "../src/admin-transaction.js";
import { requireMeasuredAdminRelease, adminTokenLifetime } from "../src/admin-lifecycle.js";
import { createAdminManifest } from "../src/admin-consent.js";
import { decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount } from "../src/admin-authority.generated.js";
import { AdminAuthorityBridge } from "../src/admin-authority.js";

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
async function probe(t, record, missing = []) {
  let code, ledgerReads = 0;
  const pool = { connect: async () => ({
    async query(sql) {
      if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (sql.includes("admin_cutover_state")) return { rows: record ? [record] : [] };
      if (sql.includes("migration_checksum_failures")) { ++ledgerReads; return { rows: missing, rowCount: missing.length }; }
      return { rows: [], command: sql.split(" ")[0] };
    }, release() {},
  }) };
  const coordinator = new AdminTransactionCoordinator(pool);
  const server = createServer((_request, response) => coordinator.run(response, async () => {
    try { await requireMeasuredAdminRelease(); } catch (error) { code = error.code; }
    response.statusCode = 204; response.end();
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fetch(`http://127.0.0.1:${server.address().port}`);
  return { code, ledgerReads };
}

test("admin-activation-measured-release: operator measurement succeeds; readiness lies, targets, digests, generations and invalidation refuse", async t => {
  assert.deepEqual(await probe(t, measurement()), { code: undefined, ledgerReads: 1 });
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
