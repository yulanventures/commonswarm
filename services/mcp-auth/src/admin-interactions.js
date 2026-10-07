import { assertAllowedOrigin, consentSecurityHeaders, INTERACTION_SECURITY_HEADERS, randomOpaque } from "./browser-security.js";
import { ClientError, InteractionStateError } from "./client-error.js";
import { bindingFromDetails, ensureSession, identity, readBody, respond } from "./interactions.js";
import { ADMIN_RESOURCE } from "./admin-policy.generated.js";
import { AdminConsentError, requireFreshAdminSession } from "./admin-consent.js";
import { effectiveAdminGate } from "./admin-gate.js";
import { renderAdminConsentPage } from "./admin-interaction-page.js";

export function createResourceInteractionHandler({ mcpHandler, adminHandler }) {
  return async (request, response, url) => {
    // The MCP preflight owns body bounds, browser session and provider lookup.
    // Multi-resource requests reach its permanent refusal, never the admin branch.
    return mcpHandler(request, response, url, async (details, context) =>
      details.params?.resource === ADMIN_RESOURCE
        ? adminHandler(request, response, url, details, context)
        : false);
  };
}

export function createAdminInteractionHandler({ provider, store, service, gotrue, workspaceReader,
  allowedOrigins, callbackUrl, maxBodyBytes = 64 * 1024, bodyReadTimeoutMs = 10_000 }) {
  return async (request, response, url, suppliedDetails, context) => {
    const match = /^\/interaction\/([^/]+)(?:\/(selection|consent))?$/u.exec(url.pathname);
    if (!match) return false;
    let uid;
    try { uid = decodeURIComponent(match[1]); }
    catch { throw new InteractionStateError("interaction_expired"); }
    const operation = match[2] ?? "view";
    const details = suppliedDetails ?? await provider.interactionDetails(request, response);
    if (details.uid !== uid) throw new InteractionStateError("interaction_mismatch");
    if (details.params?.resource !== ADMIN_RESOURCE) throw new AdminConsentError("invalid_target", 400);
    const browser = context?.browser ?? await ensureSession(request, response, store);
    const bound = await store.bindInteraction(bindingFromDetails(uid, browser.id, details, browser.session));
    try {
      requireFreshAdminSession(browser.session);
    } catch (error) {
      if (!(error instanceof AdminConsentError) || request.method !== "GET") throw error;
      const signIn = gotrue.begin({ callbackUrl, interactionUid: uid });
      await store.beginSignIn(uid, browser.id, signIn);
      response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
      response.end();
      return true;
    }
    const input = { uid, sessionId: browser.id, ownerUserId: browser.session.user_id, params: details.params };
    async function html(result) {
      const scriptNonce = randomOpaque(16);
      const security = consentSecurityHeaders(details.params.redirect_uri);
      response.writeHead(200, { ...INTERACTION_SECURITY_HEADERS,
        ...security, "content-security-policy": `${security["content-security-policy"]}; script-src 'nonce-${scriptNonce}'`,
        "content-type": "text/html; charset=utf-8" });
      response.end(renderAdminConsentPage({ uid, params: details.params, user: identity(browser.session),
        workspaces: await workspaceReader(identity(browser.session)), ...result, scriptNonce }));
    }
    if (request.method === "GET" && operation === "view") {
      let result;
      try { result = await service.view(input); }
      catch (error) {
        if (!(error instanceof AdminConsentError) ||
            !["unauthorized_client", "dpop_required"].includes(error.code)) throw error;
        const message = error.code === "dpop_required"
          ? "This client cannot prove possession of its access key. Admin access is unavailable. You can use the ordinary MCP connection."
          : "This client needs active verification and your account-owner approval before admin access is available. You can use the ordinary MCP connection.";
        response.writeHead(403, { ...INTERACTION_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Admin access unavailable</title><p>${message}</p><a href="https://commonswarm.com/app">Return to /app</a></html>`);
        return true;
      }
      if (details.prompt?.name === "login") {
        if (await effectiveAdminGate() !== "open") throw new AdminConsentError("admin_issuance_disabled", 503);
      } else if (details.prompt?.name !== "consent") {
        throw new AdminConsentError("invalid_request", 400);
      }
      if (result.receipt) {
        if (result.receipt.consumed_at != null ||
            result.receipt.verification_version !== result.policy.verification.verification_version) {
          throw new AdminConsentError("consent_receipt_invalid", 400);
        }
        await html({ ...result, version: result.parent.selection_version });
      } else {
        const csrf = await store.issueConsentToken(uid, browser.id, browser.session.user_id);
        await html({ ...result, csrfToken: csrf.token, version: csrf.selectionVersion });
      }
      return true;
    }
    if (request.method !== "POST" || !["selection", "consent"].includes(operation)) {
      respond(response, 405, { error: "method_not_allowed" });
      return true;
    }
    try { assertAllowedOrigin(request.headers.origin, allowedOrigins); }
    catch (error) {
      if (error.code !== "origin_forbidden") throw error;
      throw new AdminConsentError("origin_forbidden");
    }
    if ((details.prompt?.name !== "login" && details.prompt?.name !== "consent")
        || bound.user_id !== input.ownerUserId) {
      throw new AdminConsentError("authentication_required");
    }
    const parsed = context?.parsed ?? await readBody(request, maxBodyBytes, bodyReadTimeoutMs);
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientError(400);
    input.csrfToken = parsed.format === "form" ? body.csrf_token : request.headers["x-cswarm-csrf"];
    input.version = body.selection_version;
    if (!Number.isSafeInteger(input.version) || typeof input.csrfToken !== "string" || input.csrfToken.length < 20) {
      throw new AdminConsentError("consent_receipt_invalid", 400);
    }
    if (operation === "selection") {
      if (!Array.isArray(body.workspace_ids) || !Array.isArray(body.scope_names)) throw new ClientError(400);
      const available = await workspaceReader(identity(browser.session));
      if (body.workspace_ids.some(id => !available.some(w => w.id === id))) throw new AdminConsentError("workspace_forbidden");
      if (parsed.format === "form" && typeof body.expires_at === "string") body.expires_at += "Z";
      const result = await service.select(input, body);
      await html({ ...result, version: result.parent.selection_version });
      return true;
    }
    const grantId = await service.confirm(input, body);
    const finished = details.prompt?.name === "login"
      ? { login: { accountId: browser.session.user_id }, consent: { grantId } }
      : { consent: { grantId } };
    await provider.interactionFinished(request, response, finished);
    return true;
  };
}
