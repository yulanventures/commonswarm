import { randomUUID } from "node:crypto";

import {
  assertAllowedOrigin,
  INTERACTION_SECURITY_HEADERS,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from "./browser-security.js";

function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...INTERACTION_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maximumBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function identity(session) {
  return {
    userId: session.user_id,
    email: session.user_email,
    displayName: session.user_display_name,
    identityVerified: session.authenticated_at !== null,
    interactiveAuthAtSeconds: session.authenticated_at === null
      ? null
      : Math.floor(new Date(session.authenticated_at).getTime() / 1000),
  };
}

async function ensureSession(request, response, store) {
  const supplied = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (supplied) {
    const session = await store.requireSession(supplied);
    if (session) return { id: supplied, session };
  }
  const id = await store.createSession();
  response.setHeader("set-cookie", sessionCookie(id));
  return { id, session: await store.requireSession(id) };
}

function bindingFromDetails(uid, sessionId, details) {
  const params = details.params;
  if (Array.isArray(params.resource) || typeof params.resource !== "string" ||
      typeof params.client_id !== "string" || typeof params.redirect_uri !== "string" ||
      typeof params.code_challenge !== "string") {
    throw Object.assign(new Error("OAuth interaction binding is incomplete"), { status: 400 });
  }
  return {
    interactionUid: uid,
    sessionId,
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    resource: params.resource,
    scopes: String(params.scope ?? "").split(" ").filter(Boolean),
    pkceChallenge: params.code_challenge,
    oauthState: params.state,
  };
}

export function createInteractionHandler({
  provider,
  store,
  gotrue,
  consentOrchestrator,
  allowedOrigins,
  callbackUrl,
  maxBodyBytes = 64 * 1024,
}) {
  return async function handleInteraction(request, response, url) {
    if (url.pathname === "/oauth/callback/gotrue") {
      const interactionUid = url.searchParams.get("interaction");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      if (!interactionUid || !state || !code || !sessionId) {
        respond(response, 400, { error: "invalid_callback" });
        return true;
      }
      const pending = await store.consumeSignIn(interactionUid, sessionId, state);
      const result = await gotrue.exchange({ code, verifier: pending.signin_pkce_verifier });
      await store.attachUser(interactionUid, sessionId, {
        id: result.identity.userId,
        email: result.identity.email,
        displayName: result.identity.displayName,
      });
      const rotated = await store.rotateSession(sessionId);
      response.writeHead(303, {
        ...INTERACTION_SECURITY_HEADERS,
        "set-cookie": sessionCookie(rotated),
        location: `/interaction/${encodeURIComponent(interactionUid)}`,
      });
      response.end();
      return true;
    }

    const match = /^\/interaction\/([^/]+)(?:\/(selection|consent))?$/u.exec(url.pathname);
    if (!match) return false;
    const interactionUid = decodeURIComponent(match[1]);
    const operation = match[2] ?? "view";
    const browser = await ensureSession(request, response, store);
    const details = await provider.interactionDetails(request, response);
    if (details.uid !== interactionUid) {
      respond(response, 403, { error: "interaction_mismatch" });
      return true;
    }
    const bound = await store.bindInteraction(bindingFromDetails(interactionUid, browser.id, details));
    const session = await store.requireSession(browser.id);

    if (request.method === "GET" && operation === "view") {
      if (!session?.user_id) {
        const signIn = gotrue.begin({ callbackUrl, interactionUid });
        await store.beginSignIn(interactionUid, browser.id, signIn);
        response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
        response.end();
        return true;
      }
      if (details.prompt.name === "login") {
        await provider.interactionFinished(request, response, {
          login: { accountId: session.user_id },
        }, { mergeWithLastSubmission: false });
        return true;
      }
      if (details.prompt.name !== "consent") throw new Error("unsupported interaction prompt");
      const csrf = await store.issueConsentToken(interactionUid, browser.id, session.user_id);
      respond(response, 200, {
        interaction: interactionUid,
        client_host: new URL(details.params.client_id).host,
        selection_version: csrf.selectionVersion,
        csrf_token: csrf.token,
      });
      return true;
    }

    if (request.method !== "POST" || !["selection", "consent"].includes(operation)) {
      respond(response, 405, { error: "method_not_allowed" }, { allow: operation === "view" ? "GET" : "POST" });
      return true;
    }
    try {
      assertAllowedOrigin(request.headers.origin, allowedOrigins);
    } catch (error) {
      if (error?.code !== "origin_forbidden") throw error;
      respond(response, 403, { error: "origin_forbidden" });
      return true;
    }
    if (!session?.user_id || bound.user_id !== session.user_id) {
      respond(response, 403, { error: "authentication_required" });
      return true;
    }
    const csrfToken = request.headers["x-cswarm-csrf"];
    if (typeof csrfToken !== "string") {
      respond(response, 403, { error: "csrf_required" });
      return true;
    }
    const body = await readJson(request, maxBodyBytes);
    if (!Number.isSafeInteger(body.selection_version)) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }

    if (operation === "selection") {
      if (!Array.isArray(body.workspace_ids) ||
          body.workspace_ids.some((id) => typeof id !== "string")) {
        respond(response, 400, { error: "invalid_request" });
        return true;
      }
      const selected = await store.selectWithToken({
        interactionUid,
        sessionId: browser.id,
        userId: session.user_id,
        token: csrfToken,
        selectionVersion: body.selection_version,
        workspaceIds: body.workspace_ids,
      });
      respond(response, 200, {
        selection_version: selected.interaction.selection_version,
        csrf_token: selected.token,
      });
      return true;
    }

    if (typeof body.home_workspace_id !== "string") {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }
    const consent = await store.consumeConsent({
      interactionUid,
      sessionId: browser.id,
      userId: session.user_id,
      token: csrfToken,
      selectionVersion: body.selection_version,
    });
    let grant = consent.provider_grant_id
      ? await provider.Grant.find(consent.provider_grant_id)
      : undefined;
    if (!grant) {
      grant = new provider.Grant({ accountId: session.user_id, clientId: consent.client_id });
      if (details.prompt.details.missingOIDCScope) {
        grant.addOIDCScope(details.prompt.details.missingOIDCScope.join(" "));
      }
      if (details.prompt.details.missingOIDCClaims) {
        grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
      }
      for (const [resource, scopes] of Object.entries(
        details.prompt.details.missingResourceScopes ?? {},
      )) {
        grant.addResourceScope(resource, scopes.join(" "));
      }
      const providerGrantId = await grant.save();
      const persisted = await store.bindProviderGrant(interactionUid, providerGrantId,
        consent.commonswarm_grant_id ?? randomUUID());
      consent.provider_grant_id = persisted.provider_grant_id;
      consent.commonswarm_grant_id = persisted.commonswarm_grant_id;
    }
    await consentOrchestrator.activate({
      interactionRef: interactionUid,
      providerGrantId: consent.provider_grant_id,
      clientId: consent.client_id,
      identity: identity(session),
      workspaceIds: consent.selected_workspace_ids,
      homeWorkspaceId: body.home_workspace_id,
      grantId: consent.commonswarm_grant_id,
    });
    await store.complete(interactionUid);
    await provider.interactionFinished(request, response, {
      consent: { grantId: consent.provider_grant_id },
    });
    return true;
  };
}
