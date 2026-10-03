import { adminTransactionContext, joinAdminTransaction } from "./admin-transaction.js";
import { interactionRow } from "./interaction-store.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { hashOpaque, opaqueMatches } from "./browser-security.js";
import { metadataUrlAllowed, createPinnedMetadataFetch } from "./metadata-fetch.js";
import {
  ADMIN_RESOURCE, ADMIN_REGISTRY_VERSION, ADMIN_GRANT_TTL_SECONDS,
  ADMIN_ISSUANCE_CEILINGS, ADMIN_RENEWAL_CEILINGS, adminAvailabilityDigest,
  adminAvailableCapabilities, adminConsentOptions, adminManifestValid, canonicalAdminJson,
} from "./admin-policy.generated.js";

// Lane 4 must replace this only after its transaction proof and lane-5 closure.
// Neither configuration nor an injected database row can open lane 3 issuance.
export const ADMIN_AS_ISSUANCE_ENABLED = false;
export const ADMIN_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const OIDC_SCOPES = new Set(["openid", "offline_access"]);
const DPOP_ALGS = new Set(["ES256", "Ed25519", "EdDSA"]);

export class AdminConsentError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = "AdminConsentError";
    this.code = code;
    this.status = status;
  }
}
function refuse(code = "unauthorized_client", status) { throw new AdminConsentError(code, status); }
function requirePendingReceipt(input, current, parent, r) {
  if (!parent || !r || r.consumed_at != null || parent.user_id !== input.ownerUserId ||
      r.owner_user_id !== input.ownerUserId || r.verification_version !== current.verification.verification_version ||
      !opaqueMatches(input.sessionId, r.session_binding) ||
      r.client_id !== input.params.client_id || r.resource !== input.params.resource ||
      r.redirect_uri !== input.params.redirect_uri || r.pkce_challenge !== input.params.code_challenge ||
      r.pkce_method !== input.params.code_challenge_method || r.jkt !== input.params.dpop_jkt ||
      parent.oauth_state !== (input.params.state ?? null) ||
      canonicalAdminJson(r.requested_scopes) !== canonicalAdminJson(current.requestedScopes) ||
      r.manifest_digest !== adminDigest(r.manifest) || !adminManifestValid(r.manifest, Date.now()) ||
      r.registry_version !== r.manifest.registry_version || r.availability_digest !== r.manifest.availability_digest ||
      r.full_account !== (r.manifest.mode === "full_account") ||
      (r.full_account && !current.fullAccountEligible)) refuse("consent_receipt_invalid", 409);
  const summary = adminSummary({ ...input, policy: current, manifest: r.manifest,
    version: parent.selection_version, replacementGrantId: r.replacement_grant_id });
  // This compares the current verification/metadata/request snapshot with the
  // selection's immutable digest binding, also on a pending GET/reload.
  if (!opaqueMatches(summary.token, r.csrf_binding) ||
      (r.full_account && !opaqueMatches(summary.secondToken, r.second_confirmation_binding))) {
    refuse("consent_receipt_invalid", 409);
  }
  return summary;
}
export function adminDigest(value) {
  return createHash("sha256").update(canonicalAdminJson(value)).digest("hex");
}
function hostedHttps(uri) {
  // This also rejects literal/private/loopback hosts, userinfo and fragments.
  return typeof uri === "string" && metadataUrlAllowed(uri);
}
export function requireFreshAdminSession(session, now = Date.now()) {
  const at = new Date(session?.authenticated_at ?? NaN).getTime();
  if (!session?.user_id || !Number.isFinite(at) || at > now || now - at > ADMIN_AUTH_MAX_AGE_MS) {
    refuse("fresh_authentication_required");
  }
}

// Shared by selection, confirmation and the future transaction coordinator.
// Registration provenance is supplied by the AS, never by client metadata/verification.
export function requireAdminClient({ metadata, source, verification: v, approval: a,
  ownerUserId, params }) {
  if (!v || v.active !== true || v.withdrawn_at != null || !a || a.withdrawn_at != null ||
      a.owner_user_id !== ownerUserId || a.client_id !== params.client_id ||
      a.verification_version !== v.verification_version || !a.approval_event_id || !a.approval_command_id ||
      v.client_id !== params.client_id || source === "dcr" || !["cimd", "static"].includes(source) ||
      source !== v.registration_source || metadata?.client_id !== params.client_id ||
      !hostedHttps(params.client_id) || metadata.application_type !== "web" || v.application_type !== "web" ||
      !hostedHttps(params.redirect_uri) || !Array.isArray(metadata.redirect_uris) ||
      !metadata.redirect_uris.every(hostedHttps) || !Array.isArray(v.redirect_uris) ||
      canonicalAdminJson([...metadata.redirect_uris].sort()) !== canonicalAdminJson([...v.redirect_uris].sort()) ||
      !v.redirect_uris.includes(params.redirect_uri) || adminDigest(metadata) !== v.metadata_digest ||
      !v.publisher_identity || !v.publisher_contact || !v.review_evidence_ref ||
      v.pkce_s256_tested !== true || v.dpop_tested !== true || v.redirect_tested !== true ||
      v.origin_control_verified !== true || v.delegation_eligible !== false || v.native_loopback_eligible !== false) {
    refuse();
  }
  if (!DPOP_ALGS.has(metadata.dpop_signing_alg) || params.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(params.code_challenge ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(params.dpop_jkt ?? "")) {
    refuse("dpop_required");
  }
  if (params.resource !== ADMIN_RESOURCE) refuse("invalid_target", 400);
  const scopes = String(params.scope ?? "").split(" ").filter(Boolean);
  const allowed = new Set(adminConsentOptions().filter(o => o.available).map(o => o.scope));
  const requested = scopes.filter(s => !OIDC_SCOPES.has(s));
  if (!requested.includes("admin:read") || new Set(scopes).size !== scopes.length ||
      requested.some(s => !allowed.has(s) || !v.scope_ceiling.includes(s))) refuse("invalid_scope", 400);
  return { verification: v, approval: a, metadata, requestedScopes: scopes,
    resourceScopes: requested,
    fullAccountEligible: v.full_account_eligible === true && [...allowed].every(s => requested.includes(s)) };
}

export function createAdminManifest(selection, policy, now = Date.now()) {
  const full = selection.mode === "full_account";
  if (!["granular", "full_account"].includes(selection.mode)) refuse("invalid_request", 400);
  if (full && !policy.fullAccountEligible) refuse();
  const scopes = full ? [...policy.resourceScopes].sort() : [...new Set(selection.scope_names ?? [])].sort();
  if (scopes.some(s => !policy.resourceScopes.includes(s))) refuse("invalid_scope", 400);
  const expiresAt = selection.expires_at == null
    ? now + ADMIN_GRANT_TTL_SECONDS * 1000 : new Date(selection.expires_at).getTime();
  const manifest = {
    admin_identity_id: randomUUID(), connection_id: randomUUID(), client_id: policy.verification.client_id,
    resource: ADMIN_RESOURCE, mode: selection.mode, registry_version: ADMIN_REGISTRY_VERSION,
    scope_names: scopes, capability_names: adminAvailableCapabilities(scopes),
    availability_digest: adminAvailabilityDigest(ADMIN_REGISTRY_VERSION),
    workspace_selector: full ? "owned_and_selected" : "selected",
    workspace_ids: [...new Set(selection.workspace_ids ?? [])].sort(),
    created_workspace_policy: { scope_names: scopes.includes("workspaces:create") ? scopes : [] },
    target_rules: { seat_ids: [], own_seats: true, grant_created_seats: true,
      recipient_user_ids: [], recipient_connection_ids: [], transports: ["local", "hosted_mcp"] },
    // This initial screen delegates no workspace-content scopes to workers.
    worker_scope_ceiling: [], role_ceiling: "member",
    renewal_limits: { ...ADMIN_RENEWAL_CEILINGS, grant_kinds: ["timeboxed"], principal_ids: [] },
    issuance_limits: { ...ADMIN_ISSUANCE_CEILINGS }, expires_at: expiresAt, refresh_deadline: expiresAt,
  };
  if (!adminManifestValid(manifest, now)) refuse("invalid_manifest", 400);
  return manifest;
}

export function adminSummary({ uid, sessionId, ownerUserId, params, policy, manifest, version, replacementGrantId = null }) {
  const summary = { interaction_uid: uid, session_binding: hashOpaque(sessionId).toString("hex"),
    owner_user_id: ownerUserId, client_id: params.client_id, redirect_uri: params.redirect_uri,
    resource: params.resource, requested_scopes: policy.requestedScopes,
    pkce_challenge: params.code_challenge, pkce_method: params.code_challenge_method,
    jkt: params.dpop_jkt, oauth_state: params.state ?? null,
    metadata_digest: policy.verification.metadata_digest,
    verification_version: policy.verification.verification_version, selection_version: version,
    replacement_grant_id: replacementGrantId, manifest };
  const digest = adminDigest(summary);
  // Recoverable after refresh, bound to the browser's unpredictable secret and exact summary.
  const token = createHmac("sha256", sessionId).update(`admin-consent:${digest}`).digest("base64url");
  const secondToken = createHmac("sha256", sessionId).update(`admin-full-confirm:${digest}`).digest("base64url");
  return { digest, token, secondToken };
}

export class PostgresAdminConsentStore {
  constructor(pool) { this.pool = pool; }
  async transaction(callback) {
    if (adminTransactionContext(false)) return joinAdminTransaction(callback);
    const tx = await this.pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await callback(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { tx.release(); }
  }
  async session(tx, sessionId) {
    return (await tx.query(`SELECT * FROM commonswarm_oauth.browser_sessions
      WHERE session_hash=$1 AND invalidated_at IS NULL AND expires_at>statement_timestamp() FOR SHARE`,
    [hashOpaque(sessionId)])).rows[0];
  }
  async clientPolicy(tx, clientId, ownerUserId) {
    const verification = (await tx.query(`SELECT * FROM commonswarm_oauth.admin_verified_clients
      WHERE client_id=$1 AND active AND withdrawn_at IS NULL`, [clientId])).rows[0];
    const approval = (await tx.query(`SELECT * FROM commonswarm_oauth.admin_client_owner_approvals
      WHERE owner_user_id=$1::uuid AND client_id=$2 AND verification_version=$3
      AND withdrawn_at IS NULL`, [ownerUserId, clientId, verification?.verification_version ?? 0])).rows[0];
    const registered = (await tx.query(`SELECT 1 FROM commonswarm_oauth.registered_clients
      WHERE client_id=$1`, [clientId])).rowCount > 0;
    return { verification, approval, registered };
  }
  async cutover(tx) {
    // Runtime has SELECT only; final activation locking/ledger proof is lane 4.
    return (await tx.query(`SELECT * FROM commonswarm_oauth.admin_cutover_state WHERE singleton`)).rows[0];
  }
  async load(tx, uid) {
    const parent = (await tx.query(`SELECT * FROM commonswarm_oauth.interactions
      WHERE interaction_uid=$1 AND completed_at IS NULL AND expires_at>statement_timestamp() FOR UPDATE`, [uid])).rows[0];
    const receipt = (await tx.query(`SELECT * FROM commonswarm_oauth.admin_interactions
      WHERE interaction_uid=$1 AND expires_at>statement_timestamp() FOR UPDATE`, [uid])).rows[0];
    return { parent: interactionRow(parent), receipt };
  }
  async stage(tx, input, manifest, policy, summary) {
    const { uid, sessionId, ownerUserId, csrfToken, version, params } = input;
    const parent = (await tx.query(`UPDATE commonswarm_oauth.interactions
      SET consent_token_consumed_at=statement_timestamp(), selection_version=selection_version+1
      WHERE interaction_uid=$1 AND session_hash=$2 AND user_id=$3::uuid AND selection_version=$4
      AND consent_token_hash=$5 AND consent_token_consumed_at IS NULL AND completed_at IS NULL
      AND expires_at>statement_timestamp() RETURNING *`,
    [uid, hashOpaque(sessionId), ownerUserId, version, hashOpaque(csrfToken)])).rows[0];
    if (!parent) refuse("consent_receipt_invalid", 409);
    const receipt = (await tx.query(`INSERT INTO commonswarm_oauth.admin_interactions
      (interaction_uid,owner_user_id,client_id,resource,redirect_uri,registry_version,verification_version,
       manifest,manifest_digest,availability_digest,requested_scopes,session_binding,csrf_binding,
       second_confirmation_binding,full_account,pkce_challenge,jkt,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        least($18::timestamptz,statement_timestamp()+interval '10 minutes'))
      ON CONFLICT (interaction_uid) DO NOTHING RETURNING *`,
    [uid, ownerUserId, params.client_id, ADMIN_RESOURCE, params.redirect_uri, ADMIN_REGISTRY_VERSION,
      policy.verification.verification_version, JSON.stringify(manifest), adminDigest(manifest),
      manifest.availability_digest, policy.requestedScopes, hashOpaque(sessionId), hashOpaque(summary.token),
      manifest.mode === "full_account" ? hashOpaque(summary.secondToken) : null,
      manifest.mode === "full_account", params.code_challenge, params.dpop_jkt, parent.expires_at])).rows[0];
    if (!receipt) refuse("consent_receipt_invalid", 409);
    return { parent: interactionRow(parent), receipt };
  }
}

export function createAdminConsentService({ store, provider, fetchMetadata = createPinnedMetadataFetch(),
  staticClientIds = new Set(), completeInTransaction }) {
  async function policy(tx, input) {
    const session = await store.session(tx, input.sessionId);
    requireFreshAdminSession(session);
    if (session.user_id !== input.ownerUserId) refuse("authentication_required");
    const rows = await store.clientPolicy(tx, input.params.client_id, input.ownerUserId);
    if (rows.registered || !rows.verification || !rows.approval) refuse();
    let metadata, source;
    try {
      const client = await provider.Client.find(input.params.client_id);
      if (!client) refuse();
      const runtime = client.metadata();
      if (staticClientIds.has(input.params.client_id)) {
        metadata = runtime;
        source = "static";
      } else {
        const result = await fetchMetadata(input.params.client_id);
        if (!result.ok) refuse();
        metadata = await result.json();
        source = "cimd";
        // Fresh metadata cannot authorize a cached client with different wire behavior.
        for (const key of ["client_id", "application_type", "redirect_uris", "dpop_signing_alg"]) {
          if (canonicalAdminJson(runtime[key]) !== canonicalAdminJson(metadata[key])) refuse();
        }
      }
    } catch (error) {
      if (error instanceof AdminConsentError) throw error;
      refuse();
    }
    return requireAdminClient({ ...rows, metadata, source, ownerUserId: input.ownerUserId, params: input.params });
  }
  return {
    async view(input) {
      return store.transaction(async tx => {
        const current = await policy(tx, input);
        const pending = await store.load(tx, input.uid);
        if (!pending.parent || pending.parent.user_id !== input.ownerUserId) refuse("authentication_required");
        const summary = pending.receipt
          ? requirePendingReceipt(input, current, pending.parent, pending.receipt) : undefined;
        return { policy: current, ...pending, summary };
      });
    },
    async select(input, selection) {
      return store.transaction(async tx => {
        const current = await policy(tx, input);
        const manifest = createAdminManifest(selection, current);
        const summary = adminSummary({ ...input, policy: current, manifest, version: input.version + 1 });
        const pending = await store.stage(tx, input, manifest, current, summary);
        return { ...pending, policy: current, summary };
      });
    },
    async confirm(input, completion) {
      return store.transaction(async tx => {
        const current = await policy(tx, input);
        const { parent, receipt: r } = await store.load(tx, input.uid);
        const summary = requirePendingReceipt(input, current, parent, r);
        if (input.version !== parent.selection_version || completion.summary_digest !== summary.digest ||
            typeof input.csrfToken !== "string" || !opaqueMatches(input.csrfToken, r.csrf_binding) ||
            (r.full_account && (completion.confirm_full_account !== "yes" ||
              typeof completion.second_token !== "string" ||
              !opaqueMatches(completion.second_token, r.second_confirmation_binding)))) {
          refuse("consent_receipt_invalid", 409);
        }
        const cutover = await store.cutover(tx); // Fresh read even though this lane stays closed.
        if (!ADMIN_AS_ISSUANCE_ENABLED || cutover?.admin_issuance_enabled !== true || cutover.legacy_closed !== true) {
          refuse("admin_issuance_disabled", 503);
        }
        // Lane 4 owns the coordinator and commit-before-response. Never finish a
        // provider interaction from this lane, even if configuration is wrong.
        if (typeof completeInTransaction !== "function") refuse("admin_issuance_disabled", 503);
        return completeInTransaction(tx, {
          parent, receipt: r, policy: current,
          createFreshGrant: () => {
            const grant = new provider.Grant({ accountId: input.ownerUserId, clientId: r.client_id });
            grant.addResourceScope(ADMIN_RESOURCE, r.manifest.scope_names.join(" "));
            grant.addOIDCScope(current.requestedScopes.filter(s => OIDC_SCOPES.has(s)).join(" "));
            return grant;
          },
        });
      });
    },
  };
}
