import { effectiveAdminGate } from "./admin-gate.js";
import { createHash } from "node:crypto";
import { ADMIN_TOKEN_INGRESS } from "./provider-admin-pin.js";
import { ADMIN_RESOURCE } from "./admin-policy.generated.js";
import { AdminConsentError } from "./admin-consent.js";
import { oauthErrorResponse } from "./admin-oauth-error.js";
import { AdminTransactionCoordinator } from "./admin-transaction.js";
import { admitAdminProof, verifyAdminProof, recordAdminSecurityFailure } from "./admin-dpop.js";
import { AdminTokenLifecycle, requireMeasuredAdminRelease } from "./admin-lifecycle.js";
import { hashOpaque, parseCookies, SESSION_COOKIE } from "./browser-security.js";
import { logProviderError } from "./logger.js";

const hash = value => createHash("sha256").update(value).digest("base64url");
function json(response, status, body, nonce) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    ...(nonce ? { "DPoP-Nonce": nonce } : {}) });
  response.end(JSON.stringify(body));
}

// The sole public ingress into dormant AS lifecycle code. Candidate/consume
// observations are server reads; a requested resource never relabels a family.
export function createAdminHttpHandler({ handler, runtimePool, issuerPool, activeKid, adminIssuanceEnabled = false, logger }) {
  const coordinator = issuerPool ? new AdminTransactionCoordinator(issuerPool, { adminIssuanceEnabled }) : null;
  const lifecycle = new AdminTokenLifecycle({ activeKid });
  const dispatch = async (original, response, tokenContext, tokenOperation) => {
    let request = original, params, candidate, ingress, continuationUid;
    const url = new URL(request.url, "https://mcp.commonswarm.com");
    try {
      if (url.pathname === "/token" && request.method === "POST") {
        if (!tokenContext) {
          request[ADMIN_TOKEN_INGRESS] = (ctx, operation) => dispatch(original, response, ctx, operation);
          return handler(request, response);
        }
        params = tokenContext.oidc.params;
        const resources = Array.isArray(params.resource) ? params.resource : [params.resource];
        if (!resources.includes(ADMIN_RESOURCE)) return tokenOperation();
        tokenContext.respond = false;
        if (await effectiveAdminGate({ coordinator }) !== "open") throw new AdminConsentError("admin_issuance_disabled", 503);
        if (params.resource !== ADMIN_RESOURCE) throw new AdminConsentError("invalid_target", 400);
        const model = params.grant_type === "refresh_token" ? "RefreshToken" : "AuthorizationCode";
        const value = model === "RefreshToken" ? params.refresh_token : params.code;
        if (typeof value === "string") {
          const row = (await runtimePool.query(`SELECT a.*,to_jsonb(b) AS binding
            FROM commonswarm_oauth.provider_artifacts a JOIN commonswarm_oauth.admin_grant_bindings b
              ON b.provider_grant_id=a.grant_id WHERE a.model=$1 AND a.artifact_id_hash=$2`, [model, hash(value)])).rows[0];
          if (row) {
            candidate = row.binding;
            ingress = { binding: candidate, hash: hash(value), model, consumed_at: row.consumed_at,
              generation: Number(row.payload.rotations ?? 0) };
          }
        }
      } else if (/^\/(?:interaction|authorize)\/[^/]+/u.test(url.pathname)) {
        const uid = decodeURIComponent(url.pathname.split("/")[2]);
        const row = (await runtimePool.query(`SELECT payload FROM commonswarm_oauth.provider_artifacts
          WHERE model='Interaction' AND (uid=$1 OR artifact_id_hash=$2) LIMIT 1`, [uid, hash(uid)])).rows[0];
        if (row?.payload.params?.resource === ADMIN_RESOURCE) {
          params = row.payload.params;
          if (url.pathname.startsWith("/authorize/")) {
            const family = row.payload.result?.consent?.grantId ?? row.payload.lastSubmission?.consent?.grantId ?? row.payload.grantId;
            candidate = family ? (await runtimePool.query(`SELECT * FROM commonswarm_oauth.admin_grant_bindings
              WHERE provider_grant_id=$1`, [family])).rows[0] : null;
            continuationUid = uid;
          }
        }
      } else params = Object.fromEntries(url.searchParams);
      const admin = candidate || params?.resource === ADMIN_RESOURCE;
      if (!admin) return handler(request, response);
      // Recheck the shared gate before accepting an admin request.
      if (await effectiveAdminGate({ coordinator }) !== "open") throw new AdminConsentError("admin_issuance_disabled", 503);
      if (url.pathname === "/token" && (!ingress || params.resource !== ADMIN_RESOURCE)) {
        throw new AdminConsentError("invalid_target",400);
      }
      let capability;
      if (ingress) {
        let verified;
        try { verified = await verifyAdminProof(original, candidate.jkt); }
        catch (error) { await recordAdminSecurityFailure(issuerPool, "invalid_dpop"); throw error; }
        const proof = await admitAdminProof(issuerPool, verified);
        capability = { kind: "token", owner: candidate.owner_user_id, proof };
        // Keep the pinned provider's own URI verification on the configured
        // canonical URI, in addition to our independent signature/binding check.
        request.headers = { ...request.headers, host: "mcp.commonswarm.com",
          "x-forwarded-host": "mcp.commonswarm.com", "x-forwarded-proto": "https" };
        delete request.headers.forwarded;
      } else {
        const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
        const session = sessionId ? (await runtimePool.query(`SELECT user_id FROM commonswarm_oauth.browser_sessions
          WHERE session_hash=$1 AND invalidated_at IS NULL AND expires_at>statement_timestamp()
          AND authenticated_at BETWEEN statement_timestamp()-interval '5 minutes' AND statement_timestamp()`,
        [hashOpaque(sessionId)])).rows[0] : null;
        capability = { kind: "human", owner: session?.user_id, sessionHash: sessionId ? hashOpaque(sessionId) : null };
      }
      const result = await coordinator.run(response, async () => {
        await requireMeasuredAdminRelease();
        if (ingress) {
          const prepared = await lifecycle.prepareToken(ingress, params);
          if (prepared.replay) { json(response, 400, { error: "invalid_grant" }); return; }
        }
        if (continuationUid) {
          if (!candidate) throw new AdminConsentError("invalid_grant", 400);
          await lifecycle.prepareContinuation(candidate, continuationUid);
        }
        if (tokenOperation) {
          await tokenOperation();
          json(response, tokenContext.status, tokenContext.body);
        } else await handler(request, response);
        await lifecycle.finishContinuation();
      }, capability);
      if (result.outcome !== "committed") {
        if (logger) logProviderError(logger, "admin.transaction_error", result.requestId, result.cause);
        await recordAdminSecurityFailure(issuerPool, "transaction_failed");
      }
    } catch (error) {
      if (logger) logProviderError(logger, "admin.ingress_error", response.getHeader("x-request-id"), error);
      if (!response.headersSent && !response.destroyed) {
        const refusal = oauthErrorResponse(error);
        json(response, refusal?.status ?? 503, refusal?.body ?? { error: "temporarily_unavailable" }, error.nonce);
      }
    }
  };
  return (request, response) => dispatch(request, response);
}
