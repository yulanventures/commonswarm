import { effectiveAdminGate } from "./admin-gate.js";
import { createHash, randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { ADMIN_RESOURCE, adminScopes } from "./admin-policy.generated.js";
import { AdminConsentError } from "./admin-consent.js";
import { AdminAuthorityBridge } from "./admin-authority.js";
import { adminTransactionContext, adminQuery, withAdminRole } from "./admin-transaction.js";

const ISSUER = "https://mcp.commonswarm.com";
const sha = value => createHash("sha256").update(value).digest();
const fail = code => { throw new AdminConsentError(code, 400); };

export async function requireMeasuredAdminRelease() {
  const record = (await adminQuery(`SELECT * FROM commonswarm_oauth.admin_cutover_state
    WHERE singleton FOR SHARE`)).rows[0];
  if (record?.admin_issuance_enabled !== true || record.legacy_closed !== true || record.auth_contract_version !== 2 ||
      !record.lane8_evidence_digest || record.invalidated_at || !record.measurement_evidence_ref || !record.measured_at ||
      record.approved_edge_release_sha !== record.measured_edge_release_sha ||
      record.measured_edge_target !== `/home/commonswarm/edge/releases/${record.approved_edge_release_sha}` ||
      record.measured_mount !== record.measured_edge_target || record.measured_generation !== record.release_generation ||
      !/^[0-9a-f]{64}$/u.test(record.measured_artifact_digest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(record.measured_image_digest ?? "")) {
    throw new AdminConsentError("admin_issuance_disabled", 503);
  }
  if ((await adminQuery("SELECT * FROM commonswarm_ops.migration_checksum_failures()")).rowCount !== 0) {
    throw new AdminConsentError("admin_migration_evidence_incomplete", 503);
  }
  return record;
}

export function adminTokenLifetime(binding, nowSeconds) {
  const deadline = Math.min(new Date(binding.expires_at).getTime(), new Date(binding.refresh_deadline).getTime());
  const ttl = Math.min(300, Math.floor(deadline / 1000) - nowSeconds);
  if (!Number.isSafeInteger(nowSeconds) || !Number.isFinite(ttl) || ttl <= 0) fail("invalid_grant");
  return ttl;
}

export class AdminTokenLifecycle {
  constructor({ activeKid, bridge = new AdminAuthorityBridge() }) {
    this.activeKid = activeKid; this.bridge = bridge;
  }
  async lockPolicy(candidate) {
    if (!(await adminQuery("SELECT commonswarm_oauth.issuer_key_allowed($1,$2) AS allowed", [ISSUER, this.activeKid])).rows[0]?.allowed) {
      fail("invalid_grant");
    }
    const policy = (await adminQuery("SELECT * FROM commonswarm_oauth.lock_admin_consent_policy($1,$2,$3)",
      [candidate.client_id, candidate.verification_version, candidate.owner_user_id])).rows[0];
    if (!policy?.active || !policy.owner_approved) fail("unauthorized_client");
  }
  async prepareContinuation(candidate, uid) {
    await requireMeasuredAdminRelease();
    await this.lockPolicy(candidate);
    const scope = adminTransactionContext(), account = await this.bridge.account(candidate.owner_user_id);
    const binding = (await adminQuery(`SELECT * FROM commonswarm_oauth.admin_grant_bindings
      WHERE provider_grant_id=$1 FOR UPDATE`, [candidate.provider_grant_id])).rows[0];
    const receipt = (await withAdminRole("swarm_command", () => adminQuery(`SELECT c.* FROM swarm.admin_consents c
      WHERE c.consent_receipt_id=$1 AND c.owner_user_id=$2`,
      [account.projection.grants[binding.admin_grant_id]?.consent_receipt_id, candidate.owner_user_id]))).rows[0];
    const progress = (await adminQuery(`SELECT * FROM commonswarm_oauth.admin_consent_orchestration
      WHERE interaction_uid=$1 AND step_kind='consent' AND completed_at IS NOT NULL FOR UPDATE`, [uid])).rows[0];
    if (!receipt || receipt.consumed_at == null || !progress || progress.receipt_id !== receipt.consent_receipt_id ||
        scope.capability.owner !== candidate.owner_user_id ||
        scope.capability.sessionHash?.toString("hex") !== receipt.session_binding ||
        !await this.bridge.rights(candidate.owner_user_id, account.projection.grants[binding.admin_grant_id]) ||
        !(await adminQuery(`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status($1,$2,$3)`,
          [binding.provider_grant_id, candidate.owner_user_id, this.activeKid])).rows[0]?.active) fail("invalid_grant");
    const inserted = await adminQuery(`INSERT INTO commonswarm_oauth.admin_consent_orchestration
      (interaction_uid,owner_user_id,step_kind,command_id,receipt_id)
      VALUES($1,$2,'continuation',$3,$4) ON CONFLICT DO NOTHING RETURNING command_id`,
      [uid, candidate.owner_user_id, scope.requestId, receipt.consent_receipt_id]);
    if (inserted.rowCount !== 1) fail("invalid_grant");
    const actor = { kind: "human", user_id: candidate.owner_user_id, session_binding: receipt.session_binding };
    const decision = await this.bridge.decide(account, { kind: "admin_read_metadata", grant_id: binding.admin_grant_id,
      resource_kind: "grant", workspace_id: null }, actor, { oauthStep: "authorization_code" });
    if (!decision.ok) fail("invalid_grant");
    scope.continuation = { binding, uid, receiptId: receipt.consent_receipt_id };
  }
  async finishContinuation() {
    const unit = adminTransactionContext().continuation;
    if (!unit) return;
    await adminQuery(`UPDATE commonswarm_oauth.admin_consent_orchestration SET completed_at=statement_timestamp()
      WHERE interaction_uid=$1 AND step_kind='continuation' AND completed_at IS NULL`, [unit.uid]);
  }
  async prepareToken(ingress, params) {
    const scope = adminTransactionContext();
    await requireMeasuredAdminRelease();
    const candidate = ingress.binding;
    await this.lockPolicy(candidate);
    const account = await this.bridge.account(candidate.owner_user_id);
    const binding = (await adminQuery(`SELECT * FROM commonswarm_oauth.admin_grant_bindings
      WHERE provider_grant_id=$1 FOR UPDATE`, [candidate.provider_grant_id])).rows[0];
    const artifact = (await adminQuery(`SELECT * FROM commonswarm_oauth.provider_artifacts
      WHERE model=$1 AND artifact_id_hash=$2`, [ingress.model, ingress.hash])).rows[0];
    const grant = account.projection.grants[binding?.admin_grant_id];
    if (!binding || !artifact || !grant || params.resource !== ADMIN_RESOURCE || params.client_id !== binding.client_id ||
        artifact.payload.clientId !== binding.client_id || artifact.grant_id !== binding.provider_grant_id ||
        binding.jkt !== scope.capability.proof.jkt || (artifact.payload.jkt ?? artifact.payload.dpopJkt) !== binding.jkt ||
        !(await adminQuery(`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status($1,$2,$3)`,
          [binding.provider_grant_id, binding.owner_user_id, this.activeKid])).rows[0]?.active ||
        !await this.bridge.rights(binding.owner_user_id, grant)) fail("invalid_grant");
    const lineage = Object.values(account.projection.lineages).find(l => l.grant_id === grant.grant_id);
    const actor = { kind: "credential_runtime", connection_id: binding.connection_id,
      client_id: binding.client_id, resource: ADMIN_RESOURCE };
    if (artifact.consumed_at != null) {
      if (ingress.consumed_at == null) fail("invalid_grant"); // overlapping loser never fences winner
      if (ingress.model !== "RefreshToken" || !lineage) fail("invalid_grant");
      const generation = ingress.generation;
      const decision = await this.bridge.decide(account, { kind: "record_admin_credential_replay", grant_id: grant.grant_id,
        credential_lineage_id: lineage.credential_lineage_id, generation, scope_names: lineage.scope_names }, actor,
      { generation, lineageId: lineage.credential_lineage_id, family: binding.provider_grant_id });
      if (decision.reason !== "refresh_replay") fail("invalid_grant");
      await adminQuery("SELECT commonswarm_oauth.fence_admin_family($1,$2,'revoked','refresh_replay')",
        [binding.provider_grant_id, binding.owner_user_id]);
      await this.audit(binding, "replay", decision.events, "refused", "refresh_replay");
      scope.fenceCommittedOnError = true;
      return { replay: true };
    }
    const requested = params.scope == null ? (lineage?.scope_names ?? binding.scope_names)
      : params.scope.split(" ").filter(s => s !== "openid" && s !== "offline_access");
    if (!adminScopes(requested, binding.registry_version) || !requested.includes("admin:read") ||
        !requested.every(s => binding.scope_names.includes(s) && (!lineage || lineage.scope_names.includes(s)))) fail("invalid_scope");
    const generation = ingress.model === "RefreshToken" ? ingress.generation : 0;
    if (ingress.model === "RefreshToken" && (!lineage || generation !== lineage.generation || generation !== binding.generation)) fail("invalid_grant");
    const command = lineage ? { kind: "rotate_admin_credential", grant_id: grant.grant_id,
      credential_lineage_id: lineage.credential_lineage_id, generation, scope_names: requested }
      : { kind: "issue_admin_credential", grant_id: grant.grant_id, credential_lineage_id: randomUUID() };
    if (ingress.model === "AuthorizationCode" && lineage) fail("invalid_grant");
    const decision = await this.bridge.decide(account, command, actor,
      { generation, lineageId: lineage?.credential_lineage_id ?? null, family: binding.provider_grant_id });
    if (!decision.ok) fail("invalid_grant");
    const event = decision.events.find(e => ["AdminCredentialIssued", "AdminCredentialRotated"].includes(e.type));
    const next = account.projection.lineages[command.credential_lineage_id];
    const updated = (await adminQuery(`UPDATE commonswarm_oauth.admin_grant_bindings SET generation=$2,
      scope_names=$3,initial_issued_at=coalesce(initial_issued_at,to_timestamp($4))
      WHERE provider_grant_id=$1 RETURNING *`,
      [binding.provider_grant_id, next.generation, next.scope_names, Math.floor(event.occurred_at_server / 1000)])).rows[0];
    scope.token = { binding: updated, event, decision, lineage: next, account };
    return scope.token;
  }
  async audit(binding, kind, events, outcome = "committed", reason = null) {
    const id = randomUUID();
    await adminQuery(`INSERT INTO commonswarm_oauth.admin_oauth_audit(audit_id,owner_user_id,admin_identity_id,
      admin_grant_id,connection_id,provider_grant_id,manifest_digest,event_kind,request_id,outcome,reason_code,related_event_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, binding.owner_user_id, binding.admin_identity_id, binding.admin_grant_id, binding.connection_id,
        binding.provider_grant_id, binding.manifest_digest, kind, adminTransactionContext().requestId, outcome, reason,
        events.map(e => e.event_id)]);
    return id;
  }
  claims(token) {
    const scope = adminTransactionContext(), binding = scope.token?.binding;
    if (!binding || token.grantId !== binding.provider_grant_id) fail("invalid_grant");
    return { grant_id: binding.provider_grant_id, grant_class: "delegated_admin", admin_grant_id: binding.admin_grant_id,
      admin_identity_id: binding.admin_identity_id, connection_id: binding.connection_id, client_id: binding.client_id,
      registry_version: binding.registry_version, manifest_digest: binding.manifest_digest };
  }
  async recordToken(body) {
    const scope = adminTransactionContext(), unit = scope.token;
    if (!unit || typeof body?.access_token !== "string" || body.token_type !== "DPoP") fail("invalid_grant");
    const jwt = decodeJwt(body.access_token), header = decodeProtectedHeader(body.access_token), b = unit.binding;
    if (header.typ !== "at+jwt" || header.alg !== "ES256" || header.kid !== this.activeKid ||
        jwt.iss !== ISSUER || jwt.aud !== ADMIN_RESOURCE || jwt.sub !== b.owner_user_id || jwt.cnf?.jkt !== b.jkt ||
        jwt.grant_id !== b.provider_grant_id || jwt.admin_grant_id !== b.admin_grant_id ||
        jwt.grant_class !== "delegated_admin" || jwt.manifest_digest !== b.manifest_digest ||
        jwt.admin_identity_id !== b.admin_identity_id || jwt.connection_id !== b.connection_id ||
        jwt.client_id !== b.client_id || jwt.registry_version !== b.registry_version ||
        typeof jwt.jti !== "string" || jwt.jti.length < 1 || jwt.jti.length > 200 ||
        typeof jwt.scope !== "string" || !jwt.scope.split(" ").includes("admin:read") ||
        !Number.isSafeInteger(jwt.iat) || !Number.isSafeInteger(jwt.exp) ||
        jwt.exp > jwt.iat + adminTokenLifetime(b, jwt.iat) || jwt.exp <= jwt.iat ||
        !String(jwt.scope).split(" ").every(s => b.scope_names.includes(s))) fail("invalid_grant");
    const auditId = await this.audit(b, b.generation === 0 ? "issued" : "rotated", unit.decision.events);
    await adminQuery(`INSERT INTO commonswarm_oauth.admin_access_issuances(access_jti,access_token_digest,
      provider_grant_id,admin_grant_id,generation,client_id,resource,jkt,manifest_digest,scope_names,issuer,kid,
      issued_at,expires_at,event_id,audit_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13),to_timestamp($14),$15,$16)`,
      [jwt.jti, sha(body.access_token), b.provider_grant_id, b.admin_grant_id, b.generation, b.client_id, ADMIN_RESOURCE,
        b.jkt, b.manifest_digest, jwt.scope.split(" "), ISSUER, header.kid, jwt.iat, jwt.exp, unit.event.event_id, auditId]);
    await adminQuery(`SELECT commonswarm_oauth.record_admin_request_audit($1,$2,'action',$3,'committed',
      NULL::commonswarm_oauth.admin_security_reason,NULL,NULL,$4)`,
      [jwt.jti, sha(body.access_token), scope.requestId, [unit.event.event_id]]);
  }
  async revokeFamily(candidate, reason = "human_revoke") {
    const scope = adminTransactionContext();
    await adminQuery("SELECT commonswarm_oauth.issuer_key_allowed($1,$2)", [ISSUER,this.activeKid]);
    await adminQuery("SELECT * FROM commonswarm_oauth.lock_admin_consent_policy($1,$2,$3)",
      [candidate.client_id,candidate.verification_version,candidate.owner_user_id]);
    const account = await this.bridge.account(candidate.owner_user_id);
    const binding = (await adminQuery(`SELECT * FROM commonswarm_oauth.admin_grant_bindings
      WHERE provider_grant_id=$1 FOR UPDATE`,[candidate.provider_grant_id])).rows[0];
    const decision = await this.bridge.decide(account,{ kind:"revoke_admin_delegation",grant_id:binding.admin_grant_id,reason_code:reason },
      { kind:"human",user_id:scope.capability.owner,session_binding:scope.capability.sessionHash?.toString("hex") });
    if (!decision.ok) fail("invalid_grant");
    await adminQuery("SELECT commonswarm_oauth.fence_admin_family($1,$2,'revoked',$3)",
      [binding.provider_grant_id,binding.owner_user_id,reason]);
    await this.audit(binding,"revoked",decision.events);
  }
  async completeConsent(_tx, { parent, receipt, policy, createFreshGrant }) {
    if (await effectiveAdminGate() !== "open") throw new AdminConsentError("admin_issuance_disabled", 503);
    await requireMeasuredAdminRelease();
    const scope = adminTransactionContext();
    if (scope.capability?.owner !== receipt.owner_user_id || scope.capability?.kind !== "human") fail("authentication_required");
    await this.lockPolicy(receipt);
    const account = await this.bridge.account(receipt.owner_user_id);
    const actor = { kind: "human", user_id: receipt.owner_user_id, session_binding: receipt.session_binding.toString("hex") };
    const clock = Number((await adminQuery("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint*1000 AS now")).rows[0].now);
    const consent = { consent_receipt_id: randomUUID(), owner_user_id: receipt.owner_user_id,
      session_binding: actor.session_binding, manifest_digest: receipt.manifest_digest, manifest: receipt.manifest,
      full_account_selected: receipt.full_account, expires_at: clock + 300000, consumed_at: null };
    await withAdminRole("swarm_command", () => adminQuery(`INSERT INTO swarm.admin_consents
      (consent_receipt_id,owner_user_id,session_binding,manifest_digest,manifest,full_account_selected,expires_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [consent.consent_receipt_id, consent.owner_user_id, consent.session_binding, consent.manifest_digest,
        JSON.stringify(consent.manifest), consent.full_account_selected, new Date(consent.expires_at)]));
    const prepared = await this.bridge.decide(account, { kind: "prepare_admin_consent", consent }, actor);
    if (!prepared.ok) fail("consent_receipt_invalid");
    const grantId = randomUUID();
    const granted = await this.bridge.decide(account, { kind: "grant_admin_delegation", grant_id: grantId,
      consent_receipt_id: consent.consent_receipt_id, replaces_grant_id: receipt.replacement_grant_id ?? null }, actor);
    if (!granted.ok) fail("consent_receipt_invalid");
    const providerGrant = createFreshGrant(); providerGrant.jti = providerGrant.generateTokenId();
    const g = account.projection.grants[grantId], m = receipt.manifest;
    await adminQuery(`INSERT INTO commonswarm_oauth.provider_grant_resources
      (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
      VALUES($1,$2,'delegated_admin',$3,$4,$5,$6)`,
      [providerGrant.jti, ADMIN_RESOURCE, receipt.owner_user_id, receipt.client_id, g.connection_id, grantId]);
    await adminQuery(`INSERT INTO commonswarm_oauth.admin_grant_bindings(resource,provider_grant_id,admin_grant_id,owner_user_id,
      admin_identity_id,connection_id,client_id,registry_version,capabilities,scope_names,availability_digest,manifest_digest,
      verification_version,jkt,consented_at,expires_at,refresh_deadline,state)
      VALUES('https://api.commonswarm.com/admin',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active')`,
      [providerGrant.jti, grantId, g.owner_user_id, g.admin_identity_id, g.connection_id, g.client_id, g.registry_version,
        m.capability_names, g.scope_names, m.availability_digest, g.manifest_digest, policy.verification.verification_version,
        receipt.jkt, new Date(g.created_at), new Date(g.expires_at), new Date(g.refresh_deadline)]);
    await providerGrant.save();
    const consumed = await adminQuery(`UPDATE commonswarm_oauth.admin_interactions SET consumed_at=statement_timestamp(),
      second_confirmed_at=CASE WHEN full_account THEN statement_timestamp() ELSE second_confirmed_at END
      WHERE interaction_uid=$1 AND consumed_at IS NULL RETURNING interaction_uid`, [receipt.interaction_uid]);
    if (consumed.rowCount !== 1) fail("consent_receipt_invalid");
    await adminQuery(`INSERT INTO commonswarm_oauth.admin_consent_orchestration(interaction_uid,owner_user_id,step_kind,
      command_id,receipt_id,completed_at) VALUES($1,$2,'consent',$3,$4,statement_timestamp())`,
      [receipt.interaction_uid, receipt.owner_user_id, scope.requestId, consent.consent_receipt_id]);
    await adminQuery(`UPDATE commonswarm_oauth.interactions SET completed_at=statement_timestamp()
      WHERE interaction_uid=$1 AND completed_at IS NULL`, [parent.interaction_uid]);
    return providerGrant.jti;
  }
}
