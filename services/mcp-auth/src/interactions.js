import { randomUUID } from "node:crypto";
import { errors } from "oidc-provider";

import {
  assertAllowedOrigin,
  INTERACTION_SECURITY_HEADERS,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from "./browser-security.js";
import { ClientError, InteractionStateError } from "./client-error.js";
import { renderConsentPage } from "./interaction-page.js";

function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...INTERACTION_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function respondHtml(response, status, body) {
  response.writeHead(status, {
    ...INTERACTION_SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

async function readBody(request, maximumBytes, timeoutMs) {
  const chunks = [];
  let received = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    request.destroy(new Error("request body read timeout"));
  }, timeoutMs);
  timeout.unref?.();
  try {
    for await (const chunk of request) {
      received += chunk.length;
      if (received > maximumBytes) {
        throw new ClientError(413);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (timedOut) throw new ClientError(400);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
  if (contentType === "application/x-www-form-urlencoded") {
    const parameters = new URLSearchParams(source);
    return {
      format: "form",
      value: {
        selection_version: Number(parameters.get("selection_version")),
        csrf_token: parameters.get("csrf_token"),
        workspace_ids: parameters.getAll("workspace_ids"),
        home_workspace_id: parameters.get("home_workspace_id"),
      },
    };
  }
  try {
    return { format: "json", value: JSON.parse(source) };
  } catch {
    throw new ClientError(400);
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

function bindingFromDetails(uid, sessionId, details, session) {
  const params = details?.params;
  if (!params || typeof params !== "object" || Array.isArray(params) ||
      Array.isArray(params.resource) || typeof params.resource !== "string" ||
      typeof params.client_id !== "string" || typeof params.redirect_uri !== "string" ||
      typeof params.code_challenge !== "string") {
    throw new Error("OAuth interaction binding is incomplete");
  }
  return {
    interactionUid: uid,
    sessionId,
    // Only the validated CommonSwarm session supplies identity. Provider
    // sessions and request parameters cannot authenticate this browser.
    userId: session?.authenticated_at != null ? session.user_id : null,
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    resource: params.resource,
    scopes: String(params.scope ?? "").split(" ").filter(Boolean),
    pkceChallenge: params.code_challenge,
    oauthState: params.state,
  };
}

function consentPromptDetails(details) {
  if (details?.prompt?.name !== "consent" || !details.prompt.details ||
      typeof details.prompt.details !== "object" || Array.isArray(details.prompt.details)) {
    throw new Error("consent interaction prompt details are incomplete");
  }
  const promptDetails = details.prompt.details;
  for (const value of [promptDetails.missingOIDCScope, promptDetails.missingOIDCClaims]) {
    if (value !== undefined && (!Array.isArray(value) ||
        value.some((item) => typeof item !== "string"))) {
      throw new Error("consent interaction prompt details are malformed");
    }
  }
  const resourceScopes = promptDetails.missingResourceScopes;
  if (resourceScopes !== undefined && (!resourceScopes || typeof resourceScopes !== "object" ||
      Array.isArray(resourceScopes) || Object.values(resourceScopes).some((scopes) =>
        !Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")))) {
    throw new Error("consent interaction prompt details are malformed");
  }
  return promptDetails;
}

export function createInteractionHandler({
  provider,
  store,
  gotrue,
  consentOrchestrator,
  workspaceReader,
  allowedOrigins,
  callbackUrl,
  maxBodyBytes = 64 * 1024,
  bodyReadTimeoutMs = 10_000,
}) {
  return async function handleInteraction(request, response, url) {
    if (url.pathname === "/oauth/callback/gotrue") {
      const interactionUid = url.searchParams.get("interaction");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      if (!interactionUid || !state || !code || !sessionId) {
        throw new InteractionStateError("invalid_callback");
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
    let interactionUid;
    try {
      interactionUid = decodeURIComponent(match[1]);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      throw new InteractionStateError("interaction_expired");
    }
    const operation = match[2] ?? "view";
    let parsed;
    let body;
    if (request.method === "POST" && ["selection", "consent"].includes(operation)) {
      parsed = await readBody(request, maxBodyBytes, bodyReadTimeoutMs);
      body = parsed.value;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ClientError(400);
      }
    }
    const browser = await ensureSession(request, response, store);
    let details;
    try {
      details = await provider.interactionDetails(request, response);
    } catch (error) {
      // The pinned provider uses this class for missing/expired interactions,
      // missing interaction cookies, and unavailable/changed provider sessions.
      if (!(error instanceof errors.SessionNotFound)) throw error;
      throw new InteractionStateError("interaction_expired", undefined, { cause: error });
    }
    if (details.uid !== interactionUid) {
      throw new InteractionStateError("interaction_mismatch");
    }
    const bound = await store.bindInteraction(
      bindingFromDetails(interactionUid, browser.id, details, browser.session),
    );
    const session = await store.requireSession(browser.id);

    if (request.method === "GET" && operation === "view") {
      if (!session?.user_id) {
        const signIn = gotrue.begin({ callbackUrl, interactionUid });
        await store.beginSignIn(interactionUid, browser.id, signIn);
        response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
        response.end();
        return true;
      }
      if (details.prompt?.name === "login") {
        await provider.interactionFinished(request, response, {
          login: { accountId: session.user_id },
        }, { mergeWithLastSubmission: false });
        return true;
      }
      if (details.prompt?.name !== "consent") throw new Error("unsupported interaction prompt");
      consentPromptDetails(details);
      const currentIdentity = identity(session);
      const workspaces = await workspaceReader(currentIdentity);
      const progress = await consentOrchestrator.status?.(interactionUid) ?? [];
      const homeWorkspaceId = progress.find((step) => step.kind === "begin")?.workspaceId ?? null;
      const csrf = await store.issueConsentToken(interactionUid, browser.id, session.user_id);
      respondHtml(response, 200, renderConsentPage({
        interactionUid,
        clientHost: new URL(details.params.client_id).host,
        identity: currentIdentity,
        workspaces,
        selectedWorkspaceIds: bound.selected_workspace_ids ?? [],
        homeWorkspaceId,
        selectionLocked: bound.commonswarm_grant_id != null,
        selectionVersion: csrf.selectionVersion,
        csrfToken: csrf.token,
        progress,
      }));
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
    const csrfToken = parsed.format === "form"
      ? body.csrf_token
      : request.headers["x-cswarm-csrf"];
    if (typeof csrfToken !== "string" || csrfToken.length < 20) {
      respond(response, 403, { error: "csrf_required" });
      return true;
    }
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
      const available = await workspaceReader(identity(session));
      const availableIds = new Set(available.map((workspace) => workspace.id));
      if (body.workspace_ids.some((id) => !availableIds.has(id))) {
        respond(response, 403, { error: "workspace_forbidden" });
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
    const promptDetails = consentPromptDetails(details);
    const formWorkspaceIds = parsed.format === "form" ? body.workspace_ids : null;
    if (formWorkspaceIds !== null && (!Array.isArray(formWorkspaceIds) ||
        formWorkspaceIds.some((id) => typeof id !== "string"))) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }
    if (formWorkspaceIds !== null) {
      const available = await workspaceReader(identity(session));
      const availableIds = new Set(available.map((workspace) => workspace.id));
      if (formWorkspaceIds.some((id) => !availableIds.has(id))) {
        respond(response, 403, { error: "workspace_forbidden" });
        return true;
      }
    }
    const consent = formWorkspaceIds === null
      ? await store.consumeConsent({
          interactionUid,
          sessionId: browser.id,
          userId: session.user_id,
          token: csrfToken,
          selectionVersion: body.selection_version,
        })
      : await store.selectAndConsumeConsent({
          interactionUid,
          sessionId: browser.id,
          userId: session.user_id,
          token: csrfToken,
          selectionVersion: body.selection_version,
          workspaceIds: formWorkspaceIds,
        });
    if (!Array.isArray(consent.selected_workspace_ids) ||
        !consent.selected_workspace_ids.includes(body.home_workspace_id)) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }
    let grant = consent.provider_grant_id
      ? await provider.Grant.find(consent.provider_grant_id)
      : undefined;
    if (!grant) {
      grant = new provider.Grant({ accountId: session.user_id, clientId: consent.client_id });
      if (promptDetails.missingOIDCScope) {
        grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
      }
      if (promptDetails.missingOIDCClaims) {
        grant.addOIDCClaims(promptDetails.missingOIDCClaims);
      }
      for (const [resource, scopes] of Object.entries(
        promptDetails.missingResourceScopes ?? {},
      )) {
        grant.addResourceScope(resource, scopes.join(" "));
      }
      const providerGrantId = await grant.save();
      const persisted = await store.bindProviderGrant(interactionUid, providerGrantId,
        consent.commonswarm_grant_id ?? randomUUID());
      consent.provider_grant_id = persisted.provider_grant_id;
      consent.commonswarm_grant_id = persisted.commonswarm_grant_id;
    }
    try {
      await consentOrchestrator.activate({
        interactionRef: interactionUid,
        providerGrantId: consent.provider_grant_id,
        clientId: consent.client_id,
        identity: identity(session),
        workspaceIds: consent.selected_workspace_ids,
        homeWorkspaceId: body.home_workspace_id,
        grantId: consent.commonswarm_grant_id,
      });
    } catch (error) {
      const progress = await consentOrchestrator.status?.(interactionUid) ??
        (error.consentProgress?.succeeded ?? []).map((step) => ({ ...step, complete: true }));
      if (parsed.format !== "form") {
        respond(response, 502, {
          error: "consent_incomplete",
          inactive: true,
          succeeded: progress.filter((step) => step.complete).map((step) => ({
            kind: step.kind,
            workspace_id: step.workspaceId,
          })),
        });
        return true;
      }
      const retry = await store.issueConsentToken(interactionUid, browser.id, session.user_id);
      const workspaces = await workspaceReader(identity(session));
      respondHtml(response, 502, renderConsentPage({
        interactionUid,
        clientHost: new URL(consent.client_id).host,
        identity: identity(session),
        workspaces,
        selectedWorkspaceIds: consent.selected_workspace_ids,
        homeWorkspaceId: body.home_workspace_id,
        selectionLocked: true,
        selectionVersion: retry.selectionVersion,
        csrfToken: retry.token,
        progress,
        failure: "CommonSwarm could not finish every consent step.",
      }));
      return true;
    }
    await store.complete(interactionUid);
    await provider.interactionFinished(request, response, {
      consent: { grantId: consent.provider_grant_id },
    });
    return true;
  };
}
