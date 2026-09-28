import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { createConnectionManager } from "../src/connections.js";
import { createConsentOrchestrator } from "../src/consent.js";
import { CONSENT_WARNING, renderConsentPage } from "../src/interaction-page.js";
import { createInteractionHandler } from "../src/interactions.js";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const W1 = "20000000-0000-4000-8000-000000000001";
const W2 = "20000000-0000-4000-8000-000000000002";
const GRANT = "30000000-0000-4000-8000-000000000001";

const identity = {
  userId: USER,
  email: "human@example.test",
  displayName: "Human",
  identityVerified: true,
};

function responseCapture() {
  return {
    headers: {},
    status: 0,
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = "") { this.body += body; },
  };
}

function interactionDetails(uid = "interaction-http") {
  return {
    uid,
    params: {
      client_id: "https://client.example/oauth.json",
      redirect_uri: "https://client.example/callback",
      resource: "https://mcp.commonswarm.com/mcp",
      scope: "openid mcp",
      code_challenge: "a".repeat(43),
      state: "oauth-state-not-rendered",
    },
    prompt: { name: "consent", details: {} },
  };
}

function postRequest(body, contentType = "application/json") {
  const request = Readable.from([Buffer.from(
    contentType === "application/json" ? JSON.stringify(body) : body,
  )]);
  request.method = "POST";
  request.headers = {
    cookie: "__Host-cswarm-oauth=browser-session-long-enough",
    "content-type": contentType,
    origin: "https://mcp.commonswarm.com",
    "x-cswarm-csrf": "csrf-token-long-enough",
  };
  return request;
}

test("consent interaction serves HTML from the bound browser identity and owner workspace reader", async () => {
  let readerIdentity;
  const handler = createInteractionHandler({
    provider: {
      interactionDetails: async () => interactionDetails(),
    },
    store: {
      requireSession: async () => ({
        user_id: USER,
        user_email: identity.email,
        user_display_name: identity.displayName,
        authenticated_at: new Date().toISOString(),
      }),
      bindInteraction: async () => ({ selected_workspace_ids: [] }),
      issueConsentToken: async () => ({ token: "csrf-token-long-enough", selectionVersion: 0 }),
    },
    gotrue: {},
    consentOrchestrator: { status: async () => [] },
    workspaceReader: async (actor) => {
      readerIdentity = actor;
      return [{ id: W1, name: "Workspace One" }];
    },
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
  });
  const request = { method: "GET", headers: { cookie: "__Host-cswarm-oauth=browser-session-long-enough" } };
  const response = responseCapture();
  assert.equal(await handler(request, response, new URL("https://mcp.commonswarm.com/interaction/interaction-http")), true);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/html/u);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/u);
  assert.equal(readerIdentity.userId, USER);
  assert.match(response.body, /Workspace One/u);
  assert.doesNotMatch(response.body, /oauth-state-not-rendered/u);
});

test("consent page escapes every untrusted label and contains the complete disclosure", () => {
  const html = renderConsentPage({
    interactionUid: "interaction-1",
    clientHost: "client.example<script>alert(1)</script>",
    identity: { ...identity, displayName: "Human <img src=x>" },
    workspaces: [{ id: W1, name: "Workspace <script>bad()</script>" }],
    selectionVersion: 0,
    csrfToken: "csrf-value-that-is-long-enough",
  });
  assert.match(html, new RegExp(CONSENT_WARNING.replaceAll(".", "\\."), "u"));
  assert.match(html, /10 hosted seats/u);
  assert.match(html, /\/app → Connected apps/u);
  assert.doesNotMatch(html, /<script>|<img src=x>|client logos?|logo[_.-]?uri/iu);
  assert.match(html, /Human &lt;img src=x&gt;/u);
  assert.match(html, /Workspace &lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /access_token|refresh_token|authorization_code|server-held-token/iu);
});

test("partial consent reports completed steps, stays inactive, and retries stable commands", async () => {
  const completed = new Set();
  const attempts = [];
  let failW2 = true;
  const progress = {
    async isComplete(_interaction, step) { return completed.has(step.commandId); },
    async start() {},
    async complete(_interaction, step) { completed.add(step.commandId); },
    async fail() {},
    async list() { return []; },
  };
  const orchestrator = createConsentOrchestrator({
    progress,
    command: async (body) => {
      attempts.push(body);
      if (body.command.kind === "consent_hosted_mcp_workspace" &&
          body.workspace_id === W2 && failW2) {
        return { status: 409, body: { ok: false } };
      }
      return { status: 200, body: { ok: true } };
    },
  });
  const input = {
    interactionRef: "interaction-partial",
    providerGrantId: "provider-grant",
    clientId: "https://client.example/oauth.json",
    identity,
    workspaceIds: [W2, W1],
    homeWorkspaceId: W1,
    grantId: GRANT,
  };
  await assert.rejects(orchestrator.activate(input), (error) => {
    assert.equal(error.consentProgress.active, false);
    assert.deepEqual(error.consentProgress.succeeded.map((step) => step.kind), ["begin", "consent"]);
    assert.equal(error.consentProgress.failed.workspaceId, W2);
    return true;
  });
  const firstIds = attempts.map((body) => body.command_id);
  failW2 = false;
  await orchestrator.activate(input);
  assert.deepEqual(attempts.slice(firstIds.length).map((body) => body.command.kind), [
    "consent_hosted_mcp_workspace",
    "activate_hosted_mcp_grant",
  ]);
  assert.equal(attempts[firstIds.length].command_id, firstIds.at(-1));

  const partialPage = renderConsentPage({
    interactionUid: input.interactionRef,
    clientHost: "client.example",
    identity,
    workspaces: [{ id: W1, name: "One" }, { id: W2, name: "Two" }],
    selectedWorkspaceIds: [W1, W2],
    homeWorkspaceId: W2,
    selectionLocked: true,
    selectionVersion: 1,
    csrfToken: "replacement-csrf-value-long",
    progress: [{ kind: "begin", workspaceId: W1, complete: true }],
    failure: "A step failed.",
  });
  assert.match(partialPage, /The connection stays inactive/u);
  assert.match(partialPage, /safely resumes the unfinished steps/u);
  assert.match(partialPage, new RegExp(`type="hidden" name="home_workspace_id" value="${W2}"`, "u"));
  assert.match(partialPage, new RegExp(`type="radio" name="home_workspace_id" value="${W2}" checked disabled`, "u"));
  assert.doesNotMatch(partialPage,
    new RegExp(`type="radio" name="home_workspace_id" value="${W1}" checked`, "u"));
});

test("GET reload restores and locks the home workspace from begin progress", async () => {
  const handler = createInteractionHandler({
    provider: { interactionDetails: async () => interactionDetails("interaction-reload") },
    store: {
      requireSession: async () => ({
        user_id: USER,
        user_email: identity.email,
        user_display_name: identity.displayName,
        authenticated_at: new Date().toISOString(),
      }),
      bindInteraction: async () => ({
        selected_workspace_ids: [W1, W2],
        commonswarm_grant_id: GRANT,
      }),
      issueConsentToken: async () => ({ token: "csrf-token-long-enough", selectionVersion: 1 }),
    },
    gotrue: {},
    consentOrchestrator: {
      status: async () => [{ kind: "begin", workspaceId: W2, complete: true }],
    },
    workspaceReader: async () => [{ id: W1, name: "One" }, { id: W2, name: "Two" }],
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
  });
  const request = {
    method: "GET",
    headers: { cookie: "__Host-cswarm-oauth=browser-session-long-enough" },
  };
  const response = responseCapture();
  await handler(request, response,
    new URL("https://mcp.commonswarm.com/interaction/interaction-reload"));
  assert.equal(response.status, 200);
  assert.match(response.body,
    new RegExp(`type="hidden" name="home_workspace_id" value="${W2}"`, "u"));
  assert.match(response.body,
    new RegExp(`type="radio" name="home_workspace_id" value="${W2}" checked disabled`, "u"));
});

test("failed form consent keeps the submitted home workspace on its retry page", async () => {
  const handler = createInteractionHandler({
    provider: {
      interactionDetails: async () => interactionDetails("interaction-failure"),
      Grant: { find: async () => ({}) },
    },
    store: {
      requireSession: async () => ({
        user_id: USER,
        user_email: identity.email,
        user_display_name: identity.displayName,
        authenticated_at: new Date().toISOString(),
      }),
      bindInteraction: async () => ({ user_id: USER }),
      selectAndConsumeConsent: async () => ({
        client_id: "https://client.example/oauth.json",
        selected_workspace_ids: [W1, W2],
        provider_grant_id: "provider-grant",
        commonswarm_grant_id: GRANT,
      }),
      issueConsentToken: async () => ({ token: "replacement-csrf-long-enough", selectionVersion: 2 }),
    },
    gotrue: {},
    consentOrchestrator: {
      activate: async () => { throw Object.assign(new Error("failed"), { code: "failed" }); },
      status: async () => [{ kind: "begin", workspaceId: W2, complete: true }],
    },
    workspaceReader: async () => [{ id: W1, name: "One" }, { id: W2, name: "Two" }],
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
  });
  const form = new URLSearchParams({
    selection_version: "1",
    csrf_token: "csrf-token-long-enough",
    home_workspace_id: W2,
  });
  form.append("workspace_ids", W1);
  form.append("workspace_ids", W2);
  const response = responseCapture();
  await handler(postRequest(form.toString(), "application/x-www-form-urlencoded"), response,
    new URL("https://mcp.commonswarm.com/interaction/interaction-failure/consent"));
  assert.equal(response.status, 502);
  assert.match(response.body,
    new RegExp(`type="hidden" name="home_workspace_id" value="${W2}"`, "u"));
  assert.match(response.body,
    new RegExp(`type="radio" name="home_workspace_id" value="${W2}" checked disabled`, "u"));
});

test("JSON consent without a bound workspace selection returns invalid_request", async () => {
  let selection = null;
  let activations = 0;
  const handler = createInteractionHandler({
    provider: {
      interactionDetails: async () => interactionDetails("interaction-no-selection"),
      Grant: { find: async () => ({}) },
      interactionFinished: async (_request, response) => {
        response.writeHead(204);
        response.end();
      },
    },
    store: {
      requireSession: async () => ({
        user_id: USER,
        user_email: identity.email,
        user_display_name: identity.displayName,
        authenticated_at: new Date().toISOString(),
      }),
      bindInteraction: async () => ({ user_id: USER, selected_workspace_ids: null }),
      consumeConsent: async () => ({
        client_id: "https://client.example/oauth.json",
        selected_workspace_ids: selection,
        provider_grant_id: "provider-grant",
        commonswarm_grant_id: GRANT,
      }),
      complete: async () => {},
    },
    gotrue: {},
    consentOrchestrator: { activate: async () => { activations += 1; } },
    workspaceReader: async () => [{ id: W1, name: "One" }],
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
  });
  const response = responseCapture();
  await handler(postRequest({ selection_version: 0, home_workspace_id: W1 }), response,
    new URL("https://mcp.commonswarm.com/interaction/interaction-no-selection/consent"));
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "invalid_request" });
  assert.equal(activations, 0);

  selection = [W1];
  const control = responseCapture();
  await handler(postRequest({ selection_version: 0, home_workspace_id: W1 }), control,
    new URL("https://mcp.commonswarm.com/interaction/interaction-no-selection/consent"));
  assert.equal(control.status, 204);
  assert.equal(activations, 1);
});

test("connection manager supplies verified identity separately and preserves grant versus seat scope", async () => {
  const calls = [];
  const manager = createConnectionManager({
    readConnections: async (actor) => {
      if (actor.userId !== USER) throw Object.assign(new Error("forbidden"), { code: "forbidden" });
      return [{ grantId: GRANT }];
    },
    consentOrchestrator: {
      async revoke(input) { calls.push(["grant", input]); },
      async revokeSeat(input) { calls.push(["seat", input]); },
    },
  });
  assert.deepEqual(await manager.list(identity), [{ grantId: GRANT }]);
  await assert.rejects(manager.list({ ...identity, userId: OTHER }), { code: "forbidden" });
  await manager.revokeGrant({ grantId: GRANT, homeWorkspaceId: W1 }, identity);
  await manager.revokeSeat({ grantId: GRANT, workspaceId: W2, seatId: OTHER }, identity);
  assert.deepEqual(calls.map(([kind]) => kind), ["grant", "seat"]);
  assert.equal(calls[0][1].identity.userId, USER);
  assert.equal(calls[1][1].workspaceId, W2);
});
