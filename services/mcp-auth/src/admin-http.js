import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { ADMIN_RESOURCE } from "./admin-policy.generated.js";
import { ADMIN_AS_ISSUANCE_ENABLED, AdminConsentError } from "./admin-consent.js";
import { AdminTransactionCoordinator } from "./admin-transaction.js";
import { admitAdminProof, verifyAdminProof, recordAdminSecurityFailure, AdminDpopError } from "./admin-dpop.js";
import { AdminTokenLifecycle, requireMeasuredAdminRelease } from "./admin-lifecycle.js";
import { hashOpaque, parseCookies, SESSION_COOKIE } from "./browser-security.js";

const hash = value => createHash("sha256").update(value).digest("base64url");
async function tokenBody(request, maxBytes, timeoutMs) {
  if (String(request.headers["content-type"] ?? "").split(";")[0] !== "application/x-www-form-urlencoded") {
    throw new AdminConsentError("invalid_request", 400);
  }
  const chunks = []; let size = 0;
  const timeout = setTimeout(() => request.destroy(), timeoutMs); timeout.unref();
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) throw new AdminConsentError("request_too_large", 413);
      chunks.push(chunk);
    }
  } finally { clearTimeout(timeout); }
  const bytes = Buffer.concat(chunks), form = new URLSearchParams(bytes.toString("utf8"));
  for (const key of ["grant_type", "code", "refresh_token", "client_id", "resource", "scope", "code_verifier"]) {
    if (form.getAll(key).length > 1) throw new AdminConsentError("invalid_request", 400);
  }
  const replay = new PassThrough();
  for (const key of ["method", "url", "headers", "rawHeaders", "httpVersion", "httpVersionMajor", "httpVersionMinor", "socket", "connection"]) {
    replay[key] = request[key];
  }
  replay.end(bytes);
  return { request: replay, params: Object.fromEntries(form) };
}
function json(response, status, body, nonce) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    ...(nonce ? { "DPoP-Nonce": nonce } : {}) });
  response.end(JSON.stringify(body));
}

// The sole public ingress into dormant AS lifecycle code. Candidate/consume
// observations are server reads; a requested resource never relabels a family.
export function createAdminHttpHandler({ handler, runtimePool, issuerPool, activeKid,
  maxBodyBytes = 65536, requestTimeoutMs = 10000 }) {
  const coordinator = issuerPool ? new AdminTransactionCoordinator(issuerPool) : null;
  const lifecycle = new AdminTokenLifecycle({ activeKid });
  return async (original, response) => {
    let request = original, params, candidate, ingress, continuationUid;
    const url = new URL(request.url, "https://mcp.commonswarm.com");
    try {
      if (url.pathname === "/token" && request.method === "POST") {
        ({ request, params } = await tokenBody(request, maxBodyBytes, requestTimeoutMs));
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
      // Literal closure cannot be enabled by config, a provider metadata hook,
      // an injected cutover row, readiness or a caller-selected capability.
      if (!ADMIN_AS_ISSUANCE_ENABLED || !coordinator) throw new AdminConsentError("admin_issuance_disabled", 503);
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
        await handler(request, response);
        await lifecycle.finishContinuation();
      }, capability);
      if (result.outcome !== "committed") await recordAdminSecurityFailure(issuerPool, "transaction_failed");
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        json(response, error.status ?? 503,
          { error: error instanceof AdminConsentError || error instanceof AdminDpopError ? error.code : "temporarily_unavailable" }, error.nonce);
      }
    }
  };
}
