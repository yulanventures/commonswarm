import { AUTH_PROVIDER_CATALOG } from "./auth-provider-catalog.js";

import { randomUUID } from "node:crypto";
import { errors } from "oidc-provider";

import {
  assertAllowedOrigin,
  consentSecurityHeaders,
  INTERACTION_SECURITY_HEADERS,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from "./browser-security.js";
import { ClientError, InteractionStateError } from "./client-error.js";
import { renderConsentPage, renderSignInPage, renderDifferentAccountPage } from "./interaction-page.js";
import { metadataUrlAllowed } from "./metadata-fetch.js";
import { RESOURCE, RESOURCE_SCOPES } from "./provider.js";

export function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...INTERACTION_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function respondHtml(response, status, body, headers) {
  response.writeHead(status, {
    ...INTERACTION_SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

export async function readBody(request, maximumBytes, timeoutMs) {
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
        ...Object.fromEntries(parameters),
        selection_version: Number(parameters.get("selection_version")),
        csrf_token: parameters.get("csrf_token"),
        workspace_ids: parameters.getAll("workspace_ids"),
        home_workspace_id: parameters.get("home_workspace_id"),
        scope_names: parameters.getAll("scope_names"),
      },
    };
  }
  try {
    return { format: "json", value: JSON.parse(source) };
  } catch {
    throw new ClientError(400);
  }
}

export function identity(session, oidcSession, lastLogin) {
  const login = lastLogin?.accountId === session.user_id ? lastLogin : oidcSession;
  const provider = login?.accountId === session.user_id && Array.isArray(login.amr)
    ? AUTH_PROVIDER_CATALOG.find(({ id }) => login.amr.includes(id))?.id ?? null
    : null;
  return {
    userId: session.user_id,
    email: session.user_email,
    provider,
    displayName: session.user_display_name,
    identityVerified: session.authenticated_at !== null,
    interactiveAuthAtSeconds: session.authenticated_at === null
      ? null
      : Math.floor(new Date(session.authenticated_at).getTime() / 1000),
  };
}

export function oidcLogin(session, details) {
  const { provider } = identity(session, details.session, details.lastSubmission?.login);
  return { accountId: session.user_id, ...(provider ? { amr: [provider] } : {}) };
}

async function findClient(provider, clientId) {
  if (!provider?.Client?.find) return undefined;
  try {
    return await provider.Client.find(clientId);
  } catch {
    return undefined;
  }
}

async function clientConsentDisplay(provider, clientId, redirectUri) {
  const client = await findClient(provider, clientId);
  if (metadataUrlAllowed(clientId)) {
    return { verified: true, primary: new URL(clientId).host,
      metadataHost: new URL(clientId).hostname, declaredName: client?.clientName ?? null };
  }
  const redirect = new URL(redirectUri);
  return {
    verified: false,
    primary: redirect.hostname.toLowerCase(),
    declaredName: client?.clientName ?? null,
  };
}

export async function ensureSession(request, response, store) {
  const supplied = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (supplied) {
    const session = await store.requireSession(supplied);
    if (session) return { id: supplied, session };
  }
  const id = await store.createSession();
  response.setHeader("set-cookie", sessionCookie(id));
  return { id, session: await store.requireSession(id) };
}

export function bindingFromDetails(uid, sessionId, details, session) {
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
  return async function handleInteraction(request, response, url, routeResource) {
    if (url.pathname === "/oauth/callback/gotrue") {
      const interactionUid = url.searchParams.get("interaction");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const selectedProvider = url.searchParams.get("provider");
      const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      if (request.method !== "GET" || !interactionUid || !state || !code || !sessionId ||
          !gotrue.providers?.includes(selectedProvider)) {
        throw new InteractionStateError("invalid_callback");
      }
      const pending = await store.consumeSignIn(interactionUid, sessionId, state, selectedProvider);
      const result = await gotrue.exchange({ code, verifier: pending.signin_pkce_verifier, provider: selectedProvider });
      await store.attachUser(interactionUid, sessionId, {
        id: result.identity.userId,
        email: result.identity.email,
        displayName: result.identity.displayName,
      });
      // Only hosted MCP uses this callback write. Admin artifacts retain their
      // existing transaction boundary. The provider/state pair was checked above.
      if (pending.resource === RESOURCE) {
        const interaction = await provider.Interaction.find(interactionUid);
        if (!interaction) throw new InteractionStateError("interaction_expired");
        interaction.lastSubmission = { ...interaction.lastSubmission,
          login: { accountId: result.identity.userId, amr: [selectedProvider] } };
        await interaction.persist();
      }
      const rotated = await store.rotateSession(sessionId);
      response.writeHead(303, {
        ...INTERACTION_SECURITY_HEADERS,
        "set-cookie": sessionCookie(rotated),
        location: `/interaction/${encodeURIComponent(interactionUid)}`,
      });
      response.end();
      return true;
    }

    const match = /^\/interaction\/([^/]+)(?:\/(selection|consent|switch-account|sign-in))?$/u.exec(url.pathname);
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
    if (request.method === "POST" && ["selection", "consent", "switch-account"].includes(operation)) {
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
    // Dispatch after the existing body/session checks so ordinary MCP keeps
    // its error precedence, including 413 for oversized completed submissions.
    if (routeResource && await routeResource(details, { browser, parsed })) return true;
    // Permanent defense: this handler can only create hosted MCP authority.
    // Never rely on resource metadata or an issuance flag to enforce this.
    const resources = Array.isArray(details.params?.resource)
      ? details.params.resource : [details.params?.resource];
    if (resources.includes("https://api.commonswarm.com/admin")) {
      respond(response, 400, { error: "invalid_target" });
      return true;
    }
    const bound = await store.bindInteraction(
      bindingFromDetails(interactionUid, browser.id, details, browser.session),
    );
    const session = await store.requireSession(browser.id);
    if (bound.user_id && session?.user_id && bound.user_id !== session.user_id) {
      respondHtml(response, 409, renderDifferentAccountPage());
      return true;
    }
    const switchAccount = { action: `/interaction/${encodeURIComponent(interactionUid)}/switch-account` };

    async function consentHeaders() {
      const redirectUri = details.params.redirect_uri;
      // HTTP is only a native-client loopback exception. Client metadata has
      // already passed the provider's policy before this interaction exists.
      const client = new URL(redirectUri).protocol === "http:"
        ? await findClient(provider, details.params.client_id)
        : null;
      return consentSecurityHeaders(redirectUri, { allowLoopback: client?.applicationType === "native" });
    }

    if (request.method === "GET" && ["view", "sign-in"].includes(operation)) {
      if (!session?.user_id) {
        const choices = gotrue.providers ?? [];
        const selectedProvider = url.searchParams.get("provider");
        if (selectedProvider !== null && !choices.includes(selectedProvider)) {
          respond(response, 400, { error: "invalid_provider" });
          return true;
        }
        const selectAccount = url.searchParams.get("select_account") === "1";
        if (selectedProvider === null && (choices.length > 1 || operation === "sign-in")) {
          respondHtml(response, 200, renderSignInPage({ interactionUid, providers: choices, selectAccount }));
          return true;
        }
        const signIn = gotrue.begin({ callbackUrl, interactionUid,
          provider: selectedProvider ?? choices[0], selectAccount });
        await store.beginSignIn(interactionUid, browser.id, signIn);
        response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
        response.end();
        return true;
      }
      if (details.prompt?.name === "login") {
        await provider.interactionFinished(request, response, {
          login: oidcLogin(session, details),
        }, { mergeWithLastSubmission: false });
        return true;
      }
      if (details.prompt?.name !== "consent") throw new Error("unsupported interaction prompt");
      consentPromptDetails(details);
      const currentIdentity = identity(session, details.session, details.lastSubmission?.login);
      const workspaces = await workspaceReader(currentIdentity);
      const progress = await consentOrchestrator.status?.(interactionUid) ?? [];
      const homeWorkspaceId = progress.find((step) => step.kind === "begin")?.workspaceId ?? null;
      const csrf = await store.issueConsentToken(interactionUid, browser.id, session.user_id);
      respondHtml(response, 200, renderConsentPage({
        interactionUid,
        redirectUri: details.params.redirect_uri,
        clientDisplay: await clientConsentDisplay(provider, details.params.client_id, details.params.redirect_uri),
        identity: currentIdentity,
        switchAccount,
        workspaces,
        selectedWorkspaceIds: bound.selected_workspace_ids ?? [],
        homeWorkspaceId,
        selectionLocked: bound.commonswarm_grant_id != null,
        selectionVersion: csrf.selectionVersion,
        csrfToken: csrf.token,
        progress,
      }), await consentHeaders());
      return true;
    }

    if (request.method !== "POST" || !["selection", "consent", "switch-account"].includes(operation)) {
      respond(response, 405, { error: "method_not_allowed" }, { allow: ["view", "sign-in"].includes(operation) ? "GET" : "POST" });
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
    if (operation === "switch-account") {
      const next = await store.switchAccount({ interactionUid, sessionId: browser.id,
        userId: session.user_id, token: csrfToken });
      response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS,
        "set-cookie": [sessionCookie(browser.id, { clear: true }), sessionCookie(next)],
        location: `/interaction/${encodeURIComponent(interactionUid)}/sign-in?select_account=1` });
      response.end();
      return true;
    }
    async function invalidRequest(message, selectedWorkspaceIds = [], workspaces, refreshToken = false) {
      if (parsed.format !== "form" || operation !== "consent") {
        respond(response, 400, { error: "invalid_request" });
        return;
      }
      const csrf = refreshToken
        ? await store.issueConsentToken(interactionUid, browser.id, session.user_id)
        : { selectionVersion: body.selection_version, token: csrfToken };
      respondHtml(response, 400, renderConsentPage({
        interactionUid,
        redirectUri: details.params.redirect_uri,
        clientDisplay: await clientConsentDisplay(provider, details.params.client_id, details.params.redirect_uri),
        identity: identity(session, details.session, details.lastSubmission?.login),
        switchAccount,
        workspaces: workspaces ?? await workspaceReader(identity(session)),
        selectedWorkspaceIds,
        selectionLocked: bound.commonswarm_grant_id != null,
        homeWorkspaceId: null,
        selectionVersion: csrf.selectionVersion,
        csrfToken: csrf.token,
        validationError: message,
      }), await consentHeaders());
    }
    if (!Number.isSafeInteger(body.selection_version)) {
      await invalidRequest("Reload the workspace selection and try again.", [], undefined, true);
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

    const promptDetails = consentPromptDetails(details);
    const formWorkspaceIds = parsed.format === "form" ? body.workspace_ids : null;
    if (formWorkspaceIds !== null && (!Array.isArray(formWorkspaceIds) ||
        formWorkspaceIds.some((id) => typeof id !== "string"))) {
      await invalidRequest("Select at least one workspace for this connection.");
      return true;
    }
    const available = formWorkspaceIds === null ? null : await workspaceReader(identity(session));
    if (formWorkspaceIds !== null) {
      const availableIds = new Set(available.map((workspace) => workspace.id));
      if (formWorkspaceIds.some((id) => !availableIds.has(id))) {
        respond(response, 403, { error: "workspace_forbidden" });
        return true;
      }
    }
    const selectedWorkspaceIds = [...new Set(formWorkspaceIds ?? bound.selected_workspace_ids ?? [])];
    if (parsed.format === "form" && selectedWorkspaceIds.length === 1 && !body.home_workspace_id) {
      body.home_workspace_id = selectedWorkspaceIds[0];
    }
    if (typeof body.home_workspace_id !== "string" ||
        (parsed.format === "form" && !selectedWorkspaceIds.includes(body.home_workspace_id))) {
      // Validation keeps the form's token and CAS version usable for correction.
      await invalidRequest(selectedWorkspaceIds.length === 0
        ? "Select at least one workspace for this connection."
        : "Choose a home workspace for this connection.", selectedWorkspaceIds, available);
      return true;
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
      await invalidRequest("Choose a home workspace for this connection.", [], undefined, true);
      return true;
    }
    let grant = consent.provider_grant_id
      ? await provider.Grant.find(consent.provider_grant_id)
      : undefined;
    if (!grant) {
      grant = new provider.Grant({ accountId: session.user_id, clientId: consent.client_id });
      // Prompt details are a delta against the provider session's old grant.
      // This connection gets its own manifest-bound grant, so authorize the
      // full validated request, including scopes already met by that old grant.
      const requestedScopes = String(details.params.scope ?? "").split(" ").filter(Boolean);
      grant.addOIDCScope(requestedScopes.join(" "));
      grant.addResourceScope(details.params.resource,
        requestedScopes.filter((scope) => RESOURCE_SCOPES.includes(scope)).join(" "));
      if (promptDetails.missingOIDCClaims) {
        grant.addOIDCClaims(promptDetails.missingOIDCClaims);
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
        identity: identity(session, details.session, details.lastSubmission?.login),
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
        redirectUri: details.params.redirect_uri,
        clientDisplay: await clientConsentDisplay(provider, consent.client_id, details.params.redirect_uri),
        identity: identity(session, details.session, details.lastSubmission?.login),
        switchAccount: null,
        workspaces,
        selectedWorkspaceIds: consent.selected_workspace_ids,
        homeWorkspaceId: body.home_workspace_id,
        selectionLocked: true,
        selectionVersion: retry.selectionVersion,
        csrfToken: retry.token,
        progress,
        failure: "CommonSwarm could not finish every consent step.",
      }), await consentHeaders());
      return true;
    }
    await store.complete(interactionUid);
    await provider.interactionFinished(request, response, {
      ...(details.session?.accountId && details.session.accountId !== session.user_id
        ? { login: oidcLogin(session, details) } : {}),
      consent: { grantId: consent.provider_grant_id },
    });
    return true;
  };
}
